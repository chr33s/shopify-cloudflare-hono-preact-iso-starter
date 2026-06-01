import { ApiType, shopifyApiProject } from "@shopify/api-codegen-preset";

// Keep in sync with SHOPIFY_API_VERSION in src/server/shopify.ts.
const apiVersion = "2026-04";

export default {
	projects: {
		admin: shopifyApiProject({
			apiType: ApiType.Admin,
			apiVersion,
			documents: ["./src/**/*.{ts,tsx}"],
			enumsAsConst: true,
			outputDir: "./src/types",
		}),
	},
	schema: `https://shopify.dev/admin-graphql-direct-proxy/${apiVersion}`,
};
