import { expect, test } from "vitest";
import { parseConfigurationBody } from "#/configuration/record.ts";

const product = "gid://shopify/Product/10";

test("accepts a title and product gids", () => {
	expect(parseConfigurationBody({ title: "Summer", productIds: [product] })).toEqual({
		ok: true,
		record: { title: "Summer", productIds: [product] },
	});
});

test("rejects a blank title", () => {
	expect(parseConfigurationBody({ title: "  ", productIds: [] }).ok).toBe(false);
});

test("rejects a non-product gid", () => {
	const parsed = parseConfigurationBody({
		title: "Summer",
		productIds: ["gid://shopify/ProductVariant/1"],
	});
	expect(parsed.ok).toBe(false);
});

test("rejects too many products", () => {
	const productIds = Array.from({ length: 51 }, (_, index) => `gid://shopify/Product/${index + 1}`);
	expect(parseConfigurationBody({ title: "Summer", productIds }).ok).toBe(false);
});
