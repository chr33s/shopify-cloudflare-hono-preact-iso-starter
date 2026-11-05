import { Effect, ErrorReporter, Layer, Schema, Scheduler } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/http-api";
import { env } from "cloudflare:workers";
import { renderApp } from "./entry.tsx";
import { type AuthenticatedAdmin, ShopifyError } from "./shopify.ts";
import {
	addHeaders,
	generateCspNonce,
	getShopifyHead,
	proxy,
	admin,
	customer,
	getInstallUrl,
	getSessionTokenBounceHtml,
	handleOptions,
	withCors,
	normalizeShopInput,
	session,
	webhook,
} from "./shopify.ts";
import {
	deleteConfiguration,
	parseConfigurationWrite,
	readConfiguration,
	writeConfiguration,
} from "#/configuration/record.ts";

const Product = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});

const ConfigurationRecord = Schema.Struct({
	title: Schema.String,
	products: Schema.Array(Product),
	revision: Schema.Number,
});

class BadRequest extends Schema.Error<BadRequest>("BadRequest")({
	error: Schema.String,
}) {
	readonly [ErrorReporter.ignore] = true;
}

class Unauthorized extends Schema.Error<Unauthorized>("Unauthorized")({
	error: Schema.String,
}) {
	readonly [ErrorReporter.ignore] = true;
}

class Conflict extends Schema.Error<Conflict>("Conflict")({
	error: Schema.String,
}) {
	readonly [ErrorReporter.ignore] = true;
}

class InternalServerError extends Schema.Error<InternalServerError>("InternalServerError")({
	error: Schema.String,
}) {}

const configurationErrors = [
	BadRequest.pipe(HttpApiSchema.status(400)),
	Unauthorized.pipe(HttpApiSchema.status(401)),
	Conflict.pipe(HttpApiSchema.status(409)),
	InternalServerError.pipe(HttpApiSchema.status(500)),
];

const Api = HttpApi.make("Shopify").add(
	HttpApiGroup.make("api").add(
		HttpApiEndpoint.get("healthz", "/healthz", {
			success: Schema.Struct({ ok: Schema.Literal(true) }),
		}),
		HttpApiEndpoint.get("readConfiguration", "/api/configuration", {
			success: ConfigurationRecord,
			error: configurationErrors,
		}),
		// No payload schema: parseConfigurationWrite owns the caller-facing messages.
		// A schema failure would be an empty 400 before those messages exist.
		HttpApiEndpoint.put("saveConfiguration", "/api/configuration", {
			success: ConfigurationRecord,
			error: configurationErrors,
		}),
	),
);

type ServerRequest = HttpServerRequest.HttpServerRequest;
type ServerResponse = HttpServerResponse.HttpServerResponse;

function asWebRequest(request: ServerRequest): Request {
	if (request.source instanceof Request) return request.source;
	throw new Error("Expected a Web Request");
}

// Keep the worker Response intact. fromWeb re-streams the body and copies
// content-length, which truncates decoded upstream responses.
function passThrough(response: Response): ServerResponse {
	return HttpServerResponse.raw(response, {
		status: response.status,
		statusText: response.statusText,
	});
}

function wrappedWebResponse(response: ServerResponse): Response | undefined {
	const body = response.body;
	if (body._tag === "Raw" && body.body instanceof Response) return body.body;
	return undefined;
}

function wantsData(request: Request) {
	return (
		new URL(request.url).searchParams.has("_data") ||
		(request.headers.get("Accept") ?? "").includes("application/json")
	);
}

// ShopifyError messages are written to be caller-facing; anything else is an
// internal failure whose message must not reach the client.
function publicError(request: Request, cause: unknown): ServerResponse {
	const wantsJson =
		request.headers.get("accept")?.includes("application/json") ||
		request.headers.get("content-type")?.includes("application/json");
	const isPublic = cause instanceof ShopifyError;
	if (!isPublic) console.error(cause);
	const status = isPublic ? cause.status : 500;
	const message = isPublic ? cause.message : "Internal Server Error";
	const response = wantsJson
		? new Response(JSON.stringify({ error: message }), {
				status,
				headers: { "Content-Type": "application/json" },
			})
		: new Response(message, {
				status,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
	return passThrough(withCors(request, response));
}

type Attempt<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly cause: unknown };

function attemptPromise<A>(run: () => Promise<A>) {
	return Effect.tryPromise({
		try: run,
		catch: (cause): unknown => cause,
	}).pipe(
		Effect.match({
			onFailure: (cause): Attempt<A> => ({ ok: false, cause }),
			onSuccess: (value): Attempt<A> => ({ ok: true, value }),
		}),
	);
}

type AdminGate =
	| { readonly _tag: "Respond"; readonly response: ServerResponse }
	| { readonly _tag: "Continue"; readonly admin: AuthenticatedAdmin };

function gateAdmin(request: Request) {
	return attemptPromise(() => admin(request, env)).pipe(
		Effect.map((result): AdminGate => {
			if (!result.ok) return { _tag: "Respond", response: publicError(request, result.cause) };
			if (result.value instanceof Response) {
				return { _tag: "Respond", response: passThrough(result.value) };
			}
			return { _tag: "Continue", admin: result.value };
		}),
	);
}

const readConfigurationRoute = ({ request }: { readonly request: ServerRequest }) => {
	const web = asWebRequest(request);
	return Effect.gen(function* () {
		const gated = yield* gateAdmin(web);
		if (gated._tag === "Respond") return gated.response;

		const loaded = yield* attemptPromise(() =>
			readConfiguration(env.SESSION_KV, gated.admin.session.shop),
		);
		if (!loaded.ok) return publicError(web, loaded.cause);
		return loaded.value;
	});
};

const saveConfigurationRoute = ({ request }: { readonly request: ServerRequest }) => {
	const web = asWebRequest(request);
	return Effect.gen(function* () {
		const gated = yield* gateAdmin(web);
		if (gated._tag === "Respond") return gated.response;

		const body = yield* request.json.pipe(
			Effect.match({
				onFailure: () => undefined,
				onSuccess: (value) => value,
			}),
		);
		if (body === undefined) {
			return publicError(web, new ShopifyError("Configuration body must be JSON.", 400));
		}

		const parsed = parseConfigurationWrite(body);
		if (!parsed.ok) return publicError(web, new ShopifyError(parsed.error, 400));

		const currentResult = yield* attemptPromise(() =>
			readConfiguration(env.SESSION_KV, gated.admin.session.shop),
		);
		if (!currentResult.ok) return publicError(web, currentResult.cause);

		if (currentResult.value.revision !== parsed.value.expectedRevision) {
			return publicError(
				web,
				new ShopifyError(
					"This configuration was updated somewhere else. Reload and try again.",
					409,
				),
			);
		}

		const next = {
			title: parsed.value.title,
			products: parsed.value.products,
			revision: currentResult.value.revision + 1,
		};
		const written = yield* attemptPromise(() =>
			writeConfiguration(env.SESSION_KV, gated.admin.session.shop, next),
		);
		if (!written.ok) return publicError(web, written.cause);
		return next;
	});
};

const ApiHandlers = HttpApiBuilder.group(Api, "api", (handlers) =>
	handlers
		.handle("healthz", () => Effect.succeed({ ok: true as const }))
		.handle("readConfiguration", readConfigurationRoute)
		.handle("saveConfiguration", saveConfigurationRoute),
);

function fetchAsset(request: Request) {
	return attemptPromise(() => env.ASSETS.fetch(request)).pipe(
		Effect.map((result) =>
			result.ok ? passThrough(result.value) : publicError(request, result.cause),
		),
	);
}

function htmlResponse(request: Request, html: string, nonce: string) {
	const headers = new Headers({ "Content-Type": "text/html; charset=UTF-8" });
	addHeaders(request, headers, nonce);
	return passThrough(new Response(html, { status: 200, headers }));
}

const install = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	const currentUrl = new URL(request.url);
	const shop = normalizeShopInput(currentUrl.searchParams.get("shop"));
	if (!shop) {
		const redirectUrl = new URL("/", currentUrl);
		redirectUrl.searchParams.set("error", "INVALID_SHOP");
		return Effect.succeed(HttpServerResponse.redirect(redirectUrl, { status: 302 }));
	}

	return Effect.try({
		try: () => getInstallUrl(request, shop),
		catch: (cause): unknown => cause,
	}).pipe(
		Effect.match({
			onFailure: (cause) => publicError(request, cause),
			onSuccess: (location) => HttpServerResponse.redirect(location, { status: 302 }),
		}),
	);
};

const sessionTokenBounce = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	const nonce = generateCspNonce();
	return Effect.succeed(htmlResponse(request, getSessionTokenBounceHtml(request, nonce), nonce));
};

const authCallback = (serverRequest: ServerRequest) => {
	const currentUrl = new URL(asWebRequest(serverRequest).url);
	const redirectUrl = new URL("/", currentUrl);
	for (const param of ["shop", "host", "locale"]) {
		const value = currentUrl.searchParams.get(param);
		if (value) redirectUrl.searchParams.set(param, value);
	}
	redirectUrl.searchParams.set("embedded", "1");
	return Effect.succeed(HttpServerResponse.redirect(redirectUrl, { status: 302 }));
};

const webhooks = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	return Effect.gen(function* () {
		const authenticated = yield* attemptPromise(() => webhook(request, env));
		if (!authenticated.ok) return publicError(request, authenticated.cause);

		const topic = authenticated.value.webhook.topic.toLowerCase();
		switch (topic) {
			case "app/uninstalled": {
				// Drop the offline session so a reinstall mints a fresh one. Keyed off the
				// HMAC-verified domain, which is present even when no session was stored.
				const dropped = yield* attemptPromise(() =>
					session(env).set(authenticated.value.webhook.domain, null),
				);
				if (!dropped.ok) return publicError(request, dropped.cause);
				const deleted = yield* attemptPromise(() =>
					deleteConfiguration(env.SESSION_KV, authenticated.value.webhook.domain),
				);
				if (!deleted.ok) return publicError(request, deleted.cause);
				break;
			}
			// Mandatory GDPR compliance webhooks. This starter stores no customer PII,
			// so there is nothing to return or scrub — ack with 204.
			case "customers/data_request":
			case "customers/redact":
			case "shop/redact":
				break;
			default:
				break;
		}

		return HttpServerResponse.empty();
	});
};

const adminProxy = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	return Effect.gen(function* () {
		const authenticated = yield* attemptPromise(() => admin(request, env));
		if (!authenticated.ok) return publicError(request, authenticated.cause);
		if (authenticated.value instanceof Response) {
			return passThrough(authenticated.value);
		}

		// Defence in depth: a route pattern that stops matching must fail closed rather
		// than run this handler unauthenticated.
		const authenticatedAdmin = authenticated.value;
		const upstream = yield* attemptPromise(() => authenticatedAdmin.client.requestRaw(request));
		if (!upstream.ok) return publicError(request, upstream.cause);

		// Cached offline token is stale; drop it and ask App Bridge to retry so
		// token-exchange mints a fresh one. Mirrors @shopify/shopify-app-remix.
		if (upstream.value.status === 401) {
			const dropped = yield* attemptPromise(() =>
				session(env).set(authenticatedAdmin.session.shop, null),
			);
			if (!dropped.ok) return publicError(request, dropped.cause);
			return passThrough(
				new Response(upstream.value.body, {
					status: 401,
					headers: {
						"Content-Type": upstream.value.headers.get("Content-Type") ?? "application/json",
						"X-Shopify-Retry-Invalid-Session-Request": "1",
					},
				}),
			);
		}

		return passThrough(upstream.value);
	});
};

const customerRoute = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	return Effect.gen(function* () {
		const authenticated = yield* attemptPromise(() => customer(request, env));
		if (!authenticated.ok) return publicError(request, authenticated.cause);
		if (authenticated.value instanceof Response) {
			return passThrough(authenticated.value);
		}
		return HttpServerResponse.jsonUnsafe({
			customer: authenticated.value.customer,
			ok: true,
			shop: authenticated.value.session.shop,
		});
	});
};

const appProxy = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	// HttpRouter also registers the path without `/*`. Exact `/apps` is not the proxy.
	if (new URL(request.url).pathname === "/apps") {
		if (request.method === "GET" || request.method === "HEAD") return renderPage(serverRequest);
		return fetchAsset(request);
	}
	return Effect.gen(function* () {
		const authenticated = yield* attemptPromise(() => proxy(request, env));
		if (!authenticated.ok) return publicError(request, authenticated.cause);
		return HttpServerResponse.jsonUnsafe({
			ok: true,
			path: new URL(request.url).pathname,
			shop: authenticated.value.session.shop,
		});
	});
};

const renderPage = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	return Effect.gen(function* () {
		const url = new URL(request.url);
		// ?shop=… = already installed → dashboard.
		if (url.pathname === "/" && url.searchParams.has("shop")) {
			return HttpServerResponse.redirect(`/dashboard${url.search}`, { status: 302 });
		}

		// Skip ASSETS for "/" and "/index.html" to avoid serving the un-SSR'd template.
		// Vite dev URLs (/@vite/*, /@id/*, /src/*) still resolve through ASSETS.
		if (url.pathname !== "/" && url.pathname !== "/index.html") {
			const asset = yield* attemptPromise(() => env.ASSETS.fetch(request));
			if (!asset.ok) return publicError(request, asset.cause);
			if (asset.value.status !== 404) return passThrough(asset.value);
			void asset.value.body?.cancel();
		}

		const templateRes = yield* attemptPromise(() =>
			env.ASSETS.fetch(new URL("/index.html", url.origin)),
		);
		if (!templateRes.ok) return publicError(request, templateRes.cause);
		const template = yield* attemptPromise(() => templateRes.value.text());
		if (!template.ok) return publicError(request, template.cause);
		const appHtml = yield* attemptPromise(() => renderApp(`${url.pathname}${url.search}`));
		if (!appHtml.ok) return publicError(request, appHtml.cause);

		const nonce = generateCspNonce();
		// CSP nonce on every <script> so script-src can drop 'unsafe-inline'.
		// Function replacers throughout: with a string replacement, `$&`/`$'`/`` $` ``
		// in rendered markup would be interpreted as substitution patterns.
		const html = template.value
			.replace(/<script(\s)/g, (_match, space: string) => `<script nonce="${nonce}"${space}`)
			.replace("<!--head-outlet-->", () => getShopifyHead(request, nonce))
			.replace("<!--ssr-outlet-->", () => appHtml.value);
		return htmlResponse(request, html, nonce);
	});
};

// Every method FindMyWay's `*` registers, except GET/HEAD (SSR, with HEAD falling
// back to GET) and OPTIONS (answered before routing).
const ASSET_METHODS = [
	"ACL",
	"BIND",
	"CHECKOUT",
	"CONNECT",
	"COPY",
	"DELETE",
	"LINK",
	"LOCK",
	"M-SEARCH",
	"MERGE",
	"MKACTIVITY",
	"MKCALENDAR",
	"MKCOL",
	"MOVE",
	"NOTIFY",
	"PATCH",
	"POST",
	"PROPFIND",
	"PROPPATCH",
	"PURGE",
	"PUT",
	"QUERY",
	"REBIND",
	"REPORT",
	"SEARCH",
	"SOURCE",
	"SUBSCRIBE",
	"TRACE",
	"UNBIND",
	"UNLINK",
	"UNLOCK",
	"UNSUBSCRIBE",
] as const;

// PUT is the HttpApi save. Other methods still require admin, then assets.
const guardedConfigurationMethods = ASSET_METHODS.filter((method) => method !== "PUT");

const guardedConfiguration = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	return Effect.gen(function* () {
		const gated = yield* gateAdmin(request);
		if (gated._tag === "Respond") return gated.response;
		return yield* fetchAsset(request);
	});
};

const ExtraRoutes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		for (const method of guardedConfigurationMethods) {
			yield* router.add(method as "POST", "/api/configuration", guardedConfiguration);
		}
		for (const method of ASSET_METHODS) {
			yield* router.add(method as "POST", "*", (request) => fetchAsset(asWebRequest(request)));
		}
	}),
);

function alreadyCors(response: Response) {
	return response.headers.has("Access-Control-Allow-Credentials");
}

// CORS for embedded data/action fetches: App Bridge issues them cross-origin, so
// they preflight (Authorization/Content-Type) and need ACAO + exposed headers.
// An unanswered OPTIONS falls through to ASSETS → 404 → CORS failure. The
// `wantsData` gate skips documents and assets, whose headers are immutable.
// Error responses already carry CORS from publicError; applying it again appends
// a second Vary. Raw Responses are cloned by withCors, not re-streamed.
const Cors = HttpRouter.middleware(
	(effect) =>
		Effect.flatMap(HttpServerRequest.HttpServerRequest, (serverRequest) => {
			const request = asWebRequest(serverRequest);
			if (request.method === "OPTIONS") {
				return Effect.succeed(
					passThrough(handleOptions(request) ?? new Response(null, { status: 204 })),
				);
			}
			return Effect.map(effect, (response) => {
				if (!wantsData(request)) return response;
				const wrapped = wrappedWebResponse(response);
				if (wrapped !== undefined) {
					return alreadyCors(wrapped) ? response : passThrough(withCors(request, wrapped));
				}
				const web = HttpServerResponse.toWeb(response);
				return alreadyCors(web) ? passThrough(web) : passThrough(withCors(request, web));
			});
		}),
	{ global: true },
);

const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));

const AppLive = Layer.mergeAll(
	HttpApiBuilder.layer(Api).pipe(Layer.provide(ApiHandlers)),
	HttpRouter.add("GET", "/shopify/install", install),
	HttpRouter.add("GET", "/shopify/session-token-bounce", sessionTokenBounce),
	HttpRouter.add("GET", "/shopify/auth/callback", authCallback),
	HttpRouter.add("POST", "/shopify/webhooks", webhooks),
	HttpRouter.add("*", "/shopify/admin", adminProxy),
	HttpRouter.add("*", "/shopify/customer", customerRoute),
	HttpRouter.add("*", "/apps/*", appProxy),
	HttpRouter.add("GET", "*", renderPage),
	ExtraRoutes,
	Cors,
).pipe(Layer.provide(HttpServer.layerServices));

const app = HttpRouter.toWebHandler(AppLive.pipe(Layer.provideMerge(SyncScheduler)), {
	routerConfig: {
		caseSensitive: true,
		ignoreDuplicateSlashes: false,
		ignoreTrailingSlash: false,
	},
});

export default {
	fetch: (request: Request) => app.handler(request),
};
