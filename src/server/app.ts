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
	normalizeShopInput,
	session,
	webhook,
} from "./shopify.ts";

export type AppEnv = {
	Bindings: Env;
	Variables: { admin: AuthenticatedAdmin };
};

const app = new Hono<AppEnv>();

app.onError((error, c) => {
	const wantsJson =
		c.req.header("accept")?.includes("application/json") ||
		c.req.header("content-type")?.includes("application/json");

	if (error instanceof ShopifyError) {
		if (wantsJson)
			return c.json({ error: error.message }, error.status as Parameters<typeof c.json>[1]);
		return new Response(error.message, {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
			status: error.status,
		});
	}

	console.error(error);
	const message = error instanceof Error ? error.message : "Internal Server Error";
	if (wantsJson) return c.json({ error: message }, 500);
	return c.text("Internal Server Error", 500);
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
			// Drop the offline session so a reinstall mints a fresh one.
			await session(c.env).set(authenticated.session.shop, null);
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

app.use("/shopify/admin{/*}?", requireAdmin);

app.all("/shopify/admin", async (c) => {
	const authenticated = c.get("admin");

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
	const html = template
		.replace(/<script(\s)/g, `<script nonce="${nonce}"$1`)
		.replace("<!--head-outlet-->", getShopifyHead(c.req.raw, nonce))
		.replace("<!--ssr-outlet-->", appHtml);

	const response = c.html(html);
	addHeaders(c.req.raw, response.headers, nonce);
	return response;
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
