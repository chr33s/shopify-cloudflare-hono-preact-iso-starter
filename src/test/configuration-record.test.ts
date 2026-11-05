import { expect, test } from "vitest";
import {
	parseConfigurationWrite,
	parseStoredConfiguration,
	readConfiguration,
	type ConfigurationKv,
} from "#/configuration/record.ts";

const product = "gid://shopify/Product/10";

test("accepts a trimmed title and product records", () => {
	expect(
		parseConfigurationWrite({
			title: "  Summer  ",
			products: [
				{ id: product, title: " Tee " },
				{ id: product, title: "Tee" },
			],
			expectedRevision: 0,
		}),
	).toEqual({
		ok: true,
		value: {
			title: "Summer",
			products: [{ id: product, title: "Tee" }],
			expectedRevision: 0,
		},
	});
});

test("reads a legacy product id list", () => {
	expect(
		parseStoredConfiguration({
			title: "Summer",
			productIds: [product],
		}),
	).toEqual({
		ok: true,
		value: {
			title: "Summer",
			products: [{ id: product, title: product }],
			revision: 0,
		},
	});
});

test("rejects a blank title", () => {
	expect(parseConfigurationWrite({ title: "  ", products: [], expectedRevision: 0 }).ok).toBe(
		false,
	);
});

test("rejects a non-product gid", () => {
	const parsed = parseConfigurationWrite({
		title: "Summer",
		products: [{ id: "gid://shopify/ProductVariant/1", title: "Variant" }],
		expectedRevision: 0,
	});
	expect(parsed.ok).toBe(false);
});

test("rejects too many products", () => {
	const products = Array.from({ length: 51 }, (_, index) => ({
		id: `gid://shopify/Product/${index + 1}`,
		title: `Product ${index + 1}`,
	}));
	expect(parseConfigurationWrite({ title: "Summer", products, expectedRevision: 0 }).ok).toBe(
		false,
	);
});

test("rejects a missing revision", () => {
	expect(parseConfigurationWrite({ title: "Summer", products: [] }).ok).toBe(false);
});

test("treats an unreadable stored value as a failed parse", () => {
	expect(parseStoredConfiguration({ title: 12 }).ok).toBe(false);
});

test("reads an unreadable stored value as an empty configuration", async () => {
	const kv: ConfigurationKv = {
		get: async () => ({ title: 12 }),
		put: async () => {},
		delete: async () => {},
	};
	await expect(readConfiguration(kv, "shop.myshopify.com")).resolves.toEqual({
		title: "",
		products: [],
		revision: 0,
	});
});
