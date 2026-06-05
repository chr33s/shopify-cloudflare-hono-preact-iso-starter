import { describe, expect, it } from "vitest";
import {
	ShopifyError,
	generateCspNonce,
	handleOptions,
	normalizeShopInput,
	withCors,
} from "../server/shopify.ts";

describe("ShopifyError", () => {
	it("defaults to status 400", () => {
		const error = new ShopifyError("boom");
		expect(error.message).toBe("boom");
		expect(error.status).toBe(400);
		expect(error.name).toBe("ShopifyError");
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(ShopifyError);
	});

	it("accepts a custom status", () => {
		expect(new ShopifyError("nope", 401).status).toBe(401);
	});
});

describe("generateCspNonce", () => {
	it("returns unpadded base64", () => {
		const nonce = generateCspNonce();
		expect(nonce).toMatch(/^[A-Za-z0-9+/]+$/);
		// 16 random bytes -> 22 base64 chars once the "==" padding is stripped.
		expect(nonce).toHaveLength(22);
	});

	it("is unique per call", () => {
		expect(generateCspNonce()).not.toBe(generateCspNonce());
	});
});

describe("handleOptions", () => {
	it("ignores non-OPTIONS requests", () => {
		expect(
			handleOptions(new Request("https://app.example.com", { method: "GET" })),
		).toBeUndefined();
	});

	it("answers OPTIONS preflight from an allowed admin origin", () => {
		const response = handleOptions(
			new Request("https://app.example.com", {
				method: "OPTIONS",
				headers: { Origin: "https://admin.shopify.com" },
			}),
		);
		expect(response?.status).toBe(204);
		expect(response?.headers.get("Access-Control-Max-Age")).toBe("7200");
		expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.shopify.com");
		expect(response?.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		expect(response?.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
	});

	it("does not echo a disallowed origin", () => {
		const response = handleOptions(
			new Request("https://app.example.com", {
				method: "OPTIONS",
				headers: { Origin: "https://evil.example.com" },
			}),
		);
		expect(response?.status).toBe(204);
		expect(response?.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(response?.headers.get("Access-Control-Allow-Credentials")).toBe("true");
	});
});

describe("withCors", () => {
	it("echoes the request origin and exposes the retry header", () => {
		const request = new Request("https://app.example.com", {
			headers: { Origin: "https://admin.shopify.com" },
		});
		const response = withCors(request, new Response("ok"));
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.shopify.com");
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
			"X-Shopify-Retry-Invalid-Session-Request",
		);
	});

	it("omits the allow-origin header when there is no origin", () => {
		const response = withCors(new Request("https://app.example.com"), new Response("ok"));
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
	});
});

describe("normalizeShopInput", () => {
	it("returns null for empty or whitespace input", () => {
		expect(normalizeShopInput(null)).toBeNull();
		expect(normalizeShopInput("")).toBeNull();
		expect(normalizeShopInput("   ")).toBeNull();
	});

	it("appends .myshopify.com to a bare handle", () => {
		expect(normalizeShopInput("my-shop")).toBe("my-shop.myshopify.com");
	});

	it("strips protocol and trailing slash", () => {
		expect(normalizeShopInput("https://my-shop.myshopify.com/")).toBe("my-shop.myshopify.com");
	});

	it("rejects non-Shopify domains", () => {
		expect(normalizeShopInput("not-a-shop.example.com")).toBeNull();
	});
});
