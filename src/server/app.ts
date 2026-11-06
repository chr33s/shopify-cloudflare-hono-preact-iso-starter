import { Effect, ErrorReporter, Layer, Result, Schema, Scheduler } from "effect";
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
import { deleteConfiguration } from "#/configuration/record.ts";
import { ConfigurationRecord } from "#/configuration/contract.ts";
import {
	ConfigurationStore,
	makeConfigurationStore,
	type ConfigurationStoreError,
} from "./configuration-store.ts";

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

function promiseResult<A>(run: (signal: AbortSignal) => Promise<A>) {
	return Effect.result(
		Effect.tryPromise({
			try: run,
			catch: (cause): unknown => cause,
		}),
	);
}

function requireAdmin(request: Request) {
	return promiseResult(() => admin(request, env)).pipe(
		Effect.map((result): AuthenticatedAdmin | ServerResponse => {
			if (Result.isFailure(result)) return publicError(request, result.failure);
			if (result.success instanceof Response) return passThrough(result.success);
			return result.success;
		}),
	);
}

function configurationFailure(request: Request, error: ConfigurationStoreError): ServerResponse {
	if (error._tag === "ConfigurationRejected") {
		return publicError(request, new ShopifyError(error.message, error.status));
	}
	return publicError(request, error.cause);
}

const ConfigurationStoreLive = Layer.sync(ConfigurationStore, () =>
	makeConfigurationStore({
		get: (key, type) => env.SESSION_KV.get(key, type),
		put: (key, value) => env.SESSION_KV.put(key, value),
		delete: (key) => env.SESSION_KV.delete(key),
	}),
);

const readConfigurationRoute = ({ request }: { readonly request: ServerRequest }) => {
	const web = asWebRequest(request);
	return Effect.gen(function* () {
		const authenticated = yield* requireAdmin(web);
		if (HttpServerResponse.isHttpServerResponse(authenticated)) return authenticated;

		const store = yield* ConfigurationStore;
		return yield* store
			.read(authenticated.session.shop)
			.pipe(Effect.catch((error) => Effect.succeed(configurationFailure(web, error))));
	});
};

const saveConfigurationRoute = ({ request }: { readonly request: ServerRequest }) => {
	const web = asWebRequest(request);
	return Effect.gen(function* () {
		const authenticated = yield* requireAdmin(web);
		if (HttpServerResponse.isHttpServerResponse(authenticated)) return authenticated;

		const body = yield* request.json.pipe(
			Effect.match({
				onFailure: () => undefined,
				onSuccess: (value) => value,
			}),
		);
		if (body === undefined) {
			return publicError(web, new ShopifyError("Configuration body must be JSON.", 400));
		}

		const store = yield* ConfigurationStore;
		return yield* store
			.save(authenticated.session.shop, body)
			.pipe(Effect.catch((error) => Effect.succeed(configurationFailure(web, error))));
	});
};

const ApiHandlers = HttpApiBuilder.group(Api, "api", (handlers) =>
	handlers
		.handle("healthz", () => Effect.succeed({ ok: true as const }))
		.handle("readConfiguration", readConfigurationRoute)
		.handle("saveConfiguration", saveConfigurationRoute),
);

function fetchAsset(request: Request) {
	return promiseResult((signal) => env.ASSETS.fetch(request, { signal })).pipe(
		Effect.map((result) =>
			Result.isFailure(result) ? publicError(request, result.failure) : passThrough(result.success),
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
		const authenticated = yield* promiseResult(() => webhook(request, env));
		if (Result.isFailure(authenticated)) return publicError(request, authenticated.failure);

		const topic = authenticated.success.webhook.topic.toLowerCase();
		switch (topic) {
			case "app/uninstalled": {
				// Drop the offline session so a reinstall mints a fresh one. Keyed off the
				// HMAC-verified domain, which is present even when no session was stored.
				const dropped = yield* promiseResult(() =>
					session(env).set(authenticated.success.webhook.domain, null),
				);
				if (Result.isFailure(dropped)) return publicError(request, dropped.failure);
				const deleted = yield* promiseResult(() =>
					deleteConfiguration(env.SESSION_KV, authenticated.success.webhook.domain),
				);
				if (Result.isFailure(deleted)) return publicError(request, deleted.failure);
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
		const authenticated = yield* promiseResult(() => admin(request, env));
		if (Result.isFailure(authenticated)) return publicError(request, authenticated.failure);
		if (authenticated.success instanceof Response) {
			return passThrough(authenticated.success);
		}

		// Defence in depth: a route pattern that stops matching must fail closed rather
		// than run this handler unauthenticated.
		const authenticatedAdmin = authenticated.success;
		const upstream = yield* promiseResult(() => authenticatedAdmin.client.requestRaw(request));
		if (Result.isFailure(upstream)) return publicError(request, upstream.failure);

		// Cached offline token is stale; drop it and ask App Bridge to retry so
		// token-exchange mints a fresh one. Mirrors @shopify/shopify-app-remix.
		if (upstream.success.status === 401) {
			const dropped = yield* promiseResult(() =>
				session(env).set(authenticatedAdmin.session.shop, null),
			);
			if (Result.isFailure(dropped)) return publicError(request, dropped.failure);
			return passThrough(
				new Response(upstream.success.body, {
					status: 401,
					headers: {
						"Content-Type": upstream.success.headers.get("Content-Type") ?? "application/json",
						"X-Shopify-Retry-Invalid-Session-Request": "1",
					},
				}),
			);
		}

		return passThrough(upstream.success);
	});
};

const customerRoute = (serverRequest: ServerRequest) => {
	const request = asWebRequest(serverRequest);
	return Effect.gen(function* () {
		const authenticated = yield* promiseResult(() => customer(request, env));
		if (Result.isFailure(authenticated)) return publicError(request, authenticated.failure);
		if (authenticated.success instanceof Response) {
			return passThrough(authenticated.success);
		}
		return HttpServerResponse.jsonUnsafe({
			customer: authenticated.success.customer,
			ok: true,
			shop: authenticated.success.session.shop,
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
		const authenticated = yield* promiseResult(() => proxy(request, env));
		if (Result.isFailure(authenticated)) return publicError(request, authenticated.failure);
		return HttpServerResponse.jsonUnsafe({
			ok: true,
			path: new URL(request.url).pathname,
			shop: authenticated.success.session.shop,
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
			const asset = yield* promiseResult((signal) => env.ASSETS.fetch(request, { signal }));
			if (Result.isFailure(asset)) return publicError(request, asset.failure);
			if (asset.success.status !== 404) return passThrough(asset.success);
			void asset.success.body?.cancel();
		}

		const templateRes = yield* promiseResult((signal) =>
			env.ASSETS.fetch(new URL("/index.html", url.origin), { signal }),
		);
		if (Result.isFailure(templateRes)) return publicError(request, templateRes.failure);
		const template = yield* promiseResult(() => templateRes.success.text());
		if (Result.isFailure(template)) return publicError(request, template.failure);
		const appHtml = yield* promiseResult(() => renderApp(`${url.pathname}${url.search}`));
		if (Result.isFailure(appHtml)) return publicError(request, appHtml.failure);

		const nonce = generateCspNonce();
		// CSP nonce on every <script> so script-src can drop 'unsafe-inline'.
		// Function replacers throughout: with a string replacement, `$&`/`$'`/`` $` ``
		// in rendered markup would be interpreted as substitution patterns.
		const html = template.success
			.replace(/<script(\s)/g, (_match, space: string) => `<script nonce="${nonce}"${space}`)
			.replace("<!--head-outlet-->", () => getShopifyHead(request, nonce))
			.replace("<!--ssr-outlet-->", () => appHtml.success);
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
		const authenticated = yield* requireAdmin(request);
		if (HttpServerResponse.isHttpServerResponse(authenticated)) return authenticated;
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

const app = HttpRouter.toWebHandler(
	AppLive.pipe(Layer.provideMerge(SyncScheduler), Layer.provideMerge(ConfigurationStoreLive)),
	{
		routerConfig: {
			caseSensitive: true,
			ignoreDuplicateSlashes: false,
			ignoreTrailingSlash: false,
		},
	},
);

export default {
	fetch: (request: Request) => app.handler(request),
};
