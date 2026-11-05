import { Hono, type Context, type Next } from "hono";
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
	parseConfigurationBody,
	readConfiguration,
	writeConfiguration,
} from "#/configuration/record.ts";

export type AppEnv = {
	Bindings: Env;
	// Optional: only set once `requireAdmin` has run for the matched route.
	Variables: { admin?: AuthenticatedAdmin };
};

const app = new Hono<AppEnv>();

app.onError((error, c) => {
	const wantsJson =
		c.req.header("accept")?.includes("application/json") ||
		c.req.header("content-type")?.includes("application/json");

	// ShopifyError messages are written to be caller-facing; anything else is an
	// internal failure whose message must not reach the client.
	const isPublic = error instanceof ShopifyError;
	if (!isPublic) {
		console.error(error);
	}
	const status = isPublic ? error.status : 500;
	const message = isPublic ? error.message : "Internal Server Error";

	const response = wantsJson
		? c.json({ error: message }, status as Parameters<typeof c.json>[1])
		: new Response(message, {
				headers: { "Content-Type": "text/plain; charset=utf-8" },
				status,
			});

	// The `app.use("*")` CORS pass never runs when the chain throws, so error
	// responses would otherwise be unreadable to the embedded (cross-origin) client.
	return withCors(c.req.raw, response);
});

// CORS for embedded data/action fetches: App Bridge issues them cross-origin, so
// they preflight (Authorization/Content-Type) and need ACAO + exposed headers.
// An unanswered OPTIONS falls through to ASSETS → 404 → CORS failure. The
// `wantsData` gate skips documents and assets, whose headers are immutable.
app.use("*", async (c, next) => {
	if (c.req.method === "OPTIONS") {
		return handleOptions(c.req.raw) ?? new Response(null, { status: 204 });
	}
	await next();
	const wantsData =
		new URL(c.req.url).searchParams.has("_data") ||
		(c.req.header("Accept") ?? "").includes("application/json");
	if (wantsData) c.res = withCors(c.req.raw, c.res);
});

// Unauthenticated uptime probe.
app.get("/healthz", (c) => c.json({ ok: true }));

// Shopify app routes
async function requireAdmin(c: Context<AppEnv>, next: Next) {
	const authenticated = await admin(c.req.raw, c.env);
	if (authenticated instanceof Response) return authenticated;
	c.set("admin", authenticated);
	await next();
}

app.get("/shopify/install", (c) => {
	const currentUrl = new URL(c.req.url);
	const shop = normalizeShopInput(currentUrl.searchParams.get("shop"));

	if (!shop) {
		const redirectUrl = new URL("/", currentUrl);
		redirectUrl.searchParams.set("error", "INVALID_SHOP");
		return c.redirect(redirectUrl.toString(), 302);
	}

	return c.redirect(getInstallUrl(c.req.raw, shop).toString(), 302);
});

app.get("/shopify/session-token-bounce", (c) => {
	const nonce = generateCspNonce();
	const response = c.html(getSessionTokenBounceHtml(c.req.raw, nonce));
	addHeaders(c.req.raw, response.headers, nonce);
	return response;
});

app.get("/shopify/auth/callback", (c) => {
	const currentUrl = new URL(c.req.url);
	const redirectUrl = new URL("/", currentUrl);

	for (const param of ["shop", "host", "locale"]) {
		const value = currentUrl.searchParams.get(param);
		if (value) redirectUrl.searchParams.set(param, value);
	}
	redirectUrl.searchParams.set("embedded", "1");

	return c.redirect(redirectUrl.toString(), 302);
});

app.post("/shopify/webhooks", async (c) => {
	const authenticated = await webhook(c.req.raw, c.env);
	const topic = authenticated.webhook.topic.toLowerCase();

	switch (topic) {
		case "app/uninstalled": {
			// Drop the offline session so a reinstall mints a fresh one. Keyed off the
			// HMAC-verified domain, which is present even when no session was stored.
			await session(c.env).set(authenticated.webhook.domain, null);
			await deleteConfiguration(c.env.SESSION_KV, authenticated.webhook.domain);
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

	return new Response(null, { status: 204 });
});

app.use("/shopify/admin", requireAdmin);
app.use("/api/configuration", requireAdmin);

app.get("/api/configuration", async (c) => {
	const authenticated = c.get("admin");
	if (!authenticated) throw new ShopifyError("Unauthorized", 401);

	try {
		const record = await readConfiguration(c.env.SESSION_KV, authenticated.session.shop);
		return c.json(record);
	} catch (error) {
		if (error instanceof Error && error.message === "Stored configuration is unreadable") {
			throw new ShopifyError(error.message, 500);
		}
		throw error;
	}
});

app.put("/api/configuration", async (c) => {
	const authenticated = c.get("admin");
	if (!authenticated) throw new ShopifyError("Unauthorized", 401);

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new ShopifyError("Configuration body must be JSON.", 400);
	}

	const parsed = parseConfigurationBody(body);
	if (!parsed.ok) throw new ShopifyError(parsed.error, 400);

	await writeConfiguration(c.env.SESSION_KV, authenticated.session.shop, parsed.record);
	return c.json(parsed.record);
});

app.all("/shopify/admin", async (c) => {
	// Defence in depth: a route pattern that stops matching must fail closed rather
	// than run this handler unauthenticated.
	const authenticated = c.get("admin");
	if (!authenticated) {
		throw new ShopifyError("Unauthorized", 401);
	}

	const upstream = await authenticated.client.requestRaw(c.req.raw);

	// Cached offline token is stale; drop it and ask App Bridge to retry so
	// token-exchange mints a fresh one. Mirrors @shopify/shopify-app-remix.
	if (upstream.status === 401) {
		await session(c.env).set(authenticated.session.shop, null);
		return new Response(upstream.body, {
			status: 401,
			headers: {
				"Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
				"X-Shopify-Retry-Invalid-Session-Request": "1",
			},
		});
	}

	return upstream;
});

app.all("/shopify/customer", async (c) => {
	const authenticated = await customer(c.req.raw, c.env);
	if (authenticated instanceof Response) {
		return authenticated;
	}

	return c.json({
		customer: authenticated.customer,
		ok: true,
		shop: authenticated.session.shop,
	});
});

// Storefront proxy (NB: match [app_proxy][url,subpath,prefix])
app.all("/apps/*", async (c) => {
	const authenticated = await proxy(c.req.raw, c.env);

	return c.json({
		ok: true,
		path: new URL(c.req.url).pathname,
		shop: authenticated.session.shop,
	});
});

// SSR rendering
app.get("*", async (c) => {
	const url = new URL(c.req.url);
	// ?shop=… = already installed → dashboard.
	if (url.pathname === "/" && url.searchParams.has("shop")) {
		return c.redirect(`/dashboard${url.search}`, 302);
	}
	// Skip ASSETS for "/" and "/index.html" to avoid serving the un-SSR'd template.
	// Vite dev URLs (/@vite/*, /@id/*, /src/*) still resolve through ASSETS.
	if (url.pathname !== "/" && url.pathname !== "/index.html") {
		const assetRes = await c.env.ASSETS.fetch(c.req.raw);
		if (assetRes.status !== 404) return assetRes;
	}

	const templateRes = await c.env.ASSETS.fetch(new URL("/index.html", url.origin));
	const template = await templateRes.text();
	const appHtml = await renderApp(`${url.pathname}${url.search}`);
	const nonce = generateCspNonce();
	// CSP nonce on every <script> so script-src can drop 'unsafe-inline'.
	// Function replacers throughout: with a string replacement, `$&`/`$'`/`` $` ``
	// in rendered markup would be interpreted as substitution patterns.
	const html = template
		.replace(/<script(\s)/g, (_match, space: string) => `<script nonce="${nonce}"${space}`)
		.replace("<!--head-outlet-->", () => getShopifyHead(c.req.raw, nonce))
		.replace("<!--ssr-outlet-->", () => appHtml);

	const response = c.html(html);
	addHeaders(c.req.raw, response.headers, nonce);
	return response;
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
