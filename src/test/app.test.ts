import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { withCors } from "../server/shopify.ts";
import { readConfiguration, writeConfiguration } from "#/configuration/record.ts";

const APP_ORIGIN = "https://app.example.com";
const PROXY_PATH = "/apps/shopify-starter";
const VICTIM = "victim-store.myshopify.com";
const ATTACKER = "attacker-store.myshopify.com";

const encoder = new TextEncoder();

async function hmacKey() {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(env.SHOPIFY_API_SECRET_KEY),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

function toHex(buffer: ArrayBuffer) {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buffer: ArrayBuffer) {
	let binary = "";
	for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Mirrors Shopify's app-proxy signing: params sorted, repeats joined with ",". */
async function signProxy(params: Record<string, string | string[]>) {
	const payload = Object.entries(params)
		.sort(([a], [b]) => a.localeCompare(b))
		.reduce(
			(acc, [key, value]) => `${acc}${key}=${Array.isArray(value) ? value.join(",") : value}`,
			"",
		);
	return toHex(await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(payload)));
}

async function signWebhook(body: string) {
	return toBase64(await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(body)));
}

function nowSeconds() {
	return Math.trunc(Date.now() / 1000);
}

async function storeSession(shop: string) {
	await env.SESSION_KV.put(
		`admin:${shop}`,
		JSON.stringify({
			accessToken: "offline-token",
			id: shop,
			scope: "read_products",
			shop,
		}),
	);
}

function postWebhook(topic: string, shop: string, hmac: string, body: string) {
	return SELF.fetch(`${APP_ORIGIN}/shopify/webhooks`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Shopify-API-Version": "2026-04",
			"X-Shopify-Hmac-Sha256": hmac,
			"X-Shopify-Shop-Domain": shop,
			"X-Shopify-Topic": topic,
			"X-Shopify-Webhook-Id": "test-webhook-id",
		},
		body,
	});
}

beforeEach(async () => {
	for (const shop of [VICTIM, ATTACKER]) {
		await env.SESSION_KV.delete(`admin:${shop}`);
	}
});

describe("app proxy", () => {
	it("rejects a duplicated shop param instead of loading another shop's session", async () => {
		await storeSession(VICTIM);
		const timestamp = String(nowSeconds());

		// A signature the attacker legitimately holds for their own shop.
		const signature = await signProxy({
			path_prefix: PROXY_PATH,
			shop: ATTACKER,
			timestamp,
		});

		// `searchParams.get("shop")` takes the first value, a collapsed query object
		// takes the last: the signature verifies for ATTACKER while the session
		// lookup would resolve VICTIM.
		const response = await SELF.fetch(
			`${APP_ORIGIN}${PROXY_PATH}?shop=${VICTIM}&path_prefix=${encodeURIComponent(PROXY_PATH)}&shop=${ATTACKER}&timestamp=${timestamp}&signature=${signature}`,
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		expect(await response.text()).not.toContain(VICTIM);
	});

	it("rejects a duplicated signature param", async () => {
		await storeSession(VICTIM);
		const timestamp = String(nowSeconds());
		const signature = await signProxy({ path_prefix: PROXY_PATH, shop: VICTIM, timestamp });

		const response = await SELF.fetch(
			`${APP_ORIGIN}${PROXY_PATH}?path_prefix=${encodeURIComponent(PROXY_PATH)}&shop=${VICTIM}&timestamp=${timestamp}&signature=deadbeef&signature=${signature}`,
		);

		expect(response.status).toBe(400);
	});

	it("accepts a correctly signed single-valued request", async () => {
		await storeSession(VICTIM);
		const timestamp = String(nowSeconds());
		const signature = await signProxy({ path_prefix: PROXY_PATH, shop: VICTIM, timestamp });

		const response = await SELF.fetch(
			`${APP_ORIGIN}${PROXY_PATH}?path_prefix=${encodeURIComponent(PROXY_PATH)}&shop=${VICTIM}&timestamp=${timestamp}&signature=${signature}`,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, shop: VICTIM });
	});

	it("rejects a future-dated timestamp with 401 rather than throwing", async () => {
		const timestamp = String(nowSeconds() + 3600);
		const signature = await signProxy({ path_prefix: PROXY_PATH, shop: VICTIM, timestamp });

		const response = await SELF.fetch(
			`${APP_ORIGIN}${PROXY_PATH}?path_prefix=${encodeURIComponent(PROXY_PATH)}&shop=${VICTIM}&timestamp=${timestamp}&signature=${signature}`,
		);

		expect(response.status).toBe(401);
	});

	it("rejects a non-numeric timestamp", async () => {
		const signature = await signProxy({
			path_prefix: PROXY_PATH,
			shop: VICTIM,
			timestamp: "not-a-number",
		});

		const response = await SELF.fetch(
			`${APP_ORIGIN}${PROXY_PATH}?path_prefix=${encodeURIComponent(PROXY_PATH)}&shop=${VICTIM}&timestamp=not-a-number&signature=${signature}`,
		);

		expect(response.status).toBe(401);
	});
});

describe("/shopify/admin", () => {
	it("is gated by the admin middleware and fails closed without a session token", async () => {
		const response = await SELF.fetch(`${APP_ORIGIN}/shopify/admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "{ shop { name } }" }),
			redirect: "manual",
		});

		expect(response.status).not.toBe(500);
		expect([302, 401]).toContain(response.status);
		if (response.status === 302) {
			expect(response.headers.get("Location")).toContain("/shopify/session-token-bounce");
		}
	});

	it("does not leak internal error detail to the client", async () => {
		const response = await SELF.fetch(`${APP_ORIGIN}/shopify/admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			redirect: "manual",
		});

		expect(await response.text()).not.toContain("Cannot read properties");
	});

	it("bounces unauthenticated configuration reads", async () => {
		const response = await SELF.fetch(`${APP_ORIGIN}/api/configuration`, {
			headers: { Accept: "application/json" },
			redirect: "manual",
		});

		expect(response.status).not.toBe(500);
		expect([302, 401]).toContain(response.status);
	});
});

describe("webhooks", () => {
	it("acks a compliance topic when no session is stored", async () => {
		const body = JSON.stringify({ shop_domain: VICTIM });
		const response = await postWebhook("shop/redact", VICTIM, await signWebhook(body), body);

		expect(response.status).toBe(204);
	});

	it("still rejects an invalid hmac", async () => {
		const body = JSON.stringify({ shop_domain: VICTIM });
		const response = await postWebhook("shop/redact", VICTIM, "not-a-valid-hmac", body);

		expect(response.status).toBe(401);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		await expect(response.json()).resolves.toEqual({ error: expect.any(String) });
	});

	it("drops the stored session and configuration on app/uninstalled", async () => {
		await storeSession(VICTIM);
		await writeConfiguration(env.SESSION_KV, VICTIM, {
			title: "Summer",
			products: [{ id: "gid://shopify/Product/9", title: "Tee" }],
			revision: 1,
		});
		const body = JSON.stringify({ domain: VICTIM });
		const response = await postWebhook("app/uninstalled", VICTIM, await signWebhook(body), body);

		expect(response.status).toBe(204);
		expect(await env.SESSION_KV.get(`admin:${VICTIM}`)).toBeNull();
		expect(await readConfiguration(env.SESSION_KV, VICTIM)).toEqual({
			title: "",
			products: [],
			revision: 0,
		});
	});
});

describe("CORS", () => {
	it("does not echo a disallowed origin on data responses", async () => {
		const response = await SELF.fetch(`${APP_ORIGIN}/healthz`, {
			headers: { Accept: "application/json", Origin: "https://evil.example.com" },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("echoes an allowed admin origin on data responses", async () => {
		const response = await SELF.fetch(`${APP_ORIGIN}/healthz`, {
			headers: { Accept: "application/json", Origin: "https://admin.shopify.com" },
		});

		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.shopify.com");
		await expect(response.json()).resolves.toEqual({ ok: true });
	});

	it("attaches CORS to responses whose headers are immutable", async () => {
		// Responses from the ASSETS binding are immutable; mutating them throws,
		// which previously surfaced as a 500 for any asset fetched with `?_data=1`.
		const assetResponse = await env.ASSETS.fetch(`${APP_ORIGIN}/index.html`);
		const request = new Request(`${APP_ORIGIN}/index.html?_data=1`, {
			headers: { Origin: "https://admin.shopify.com" },
		});

		const result = withCors(request, assetResponse);

		expect(result.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.shopify.com");
		expect(result.headers.get("Access-Control-Expose-Headers")).toBe(
			"X-Shopify-Retry-Invalid-Session-Request",
		);
	});

	it("keeps a data response body and applies CORS once", async () => {
		const response = await SELF.fetch(`${APP_ORIGIN}/?_data=1`, {
			headers: { Origin: "https://admin.shopify.com" },
		});
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.shopify.com");
		expect(response.headers.get("Vary")).toBe("Origin");
		expect(html).toContain('heading="Install"');
	});
});

describe("routing", () => {
	it("does not alias /healthz by case or a trailing slash", async () => {
		for (const path of ["/Healthz", "/healthz/"]) {
			const response = await SELF.fetch(`${APP_ORIGIN}${path}`, {
				headers: { Accept: "application/json" },
			});
			expect(await response.text()).not.toContain('"ok":true');
		}
	});

	it("serves exact /apps as the app shell, not the proxy", async () => {
		const response = await SELF.fetch(`${APP_ORIGIN}/apps`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('heading="Not found"');
	});
});

describe("/shopify/session-token-bounce", () => {
	it("cannot be used to break out of the enclosing script element", async () => {
		const payload = "</script><script>globalThis.pwned = 1;</script>";
		const response = await SELF.fetch(
			`${APP_ORIGIN}/shopify/session-token-bounce?shopify-reload=${encodeURIComponent(payload)}`,
		);
		const html = await response.text();

		// Only the two <script> elements this page emits itself; the payload must not
		// have terminated the reload script and opened one of its own.
		expect(html.match(/<script/g) ?? []).toHaveLength(2);
		expect(html).not.toContain("<script>globalThis.pwned");
		expect(html).not.toContain("</script><script>");
		// Whatever survives is inert: a percent-encoded, same-origin path.
		expect(html).toContain(`window.open("${new URL(env.SHOPIFY_APP_URL).origin}/%3C/script%3E`);
	});

	it("never emits a raw < or > inside the reload script body", async () => {
		const response = await SELF.fetch(
			`${APP_ORIGIN}/shopify/session-token-bounce?shopify-reload=${encodeURIComponent("/dashboard?a=<b>")}`,
		);
		const html = await response.text();
		const scriptBody = /window\.open\((.*?), '_top'\)/.exec(html)?.[1] ?? "";

		expect(scriptBody).not.toContain("<");
		expect(scriptBody).not.toContain(">");
	});

	it("drops an off-origin reload target", async () => {
		const response = await SELF.fetch(
			`${APP_ORIGIN}/shopify/session-token-bounce?shopify-reload=${encodeURIComponent("https://evil.example.com/steal")}`,
		);
		const html = await response.text();

		expect(html).not.toContain("evil.example.com");
		expect(html).not.toContain("window.open");
	});

	it("keeps a same-origin reload target", async () => {
		const reload = `${env.SHOPIFY_APP_URL}/dashboard?shop=${VICTIM}`;
		const response = await SELF.fetch(
			`${APP_ORIGIN}/shopify/session-token-bounce?shopify-reload=${encodeURIComponent(reload)}`,
		);
		const html = await response.text();

		expect(html).toContain("window.open");
		expect(html).toContain("/dashboard");
	});
});
