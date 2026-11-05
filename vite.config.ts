import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import preact from "@preact/preset-vite";
import { defineConfig, loadEnv } from "vite-plus";
import { playwright } from "vite-plus/test/browser/providers/playwright";
import wrangler from "./wrangler.json" with { type: "json" };

// Native Preact only. The preset aliases react → preact/compat unless this is off.
const nativePreact = () => preact({ reactAliasesEnabled: false });

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, ".", "");
	// HOST overrides the app URL for local tunnel dev (e.g. `shopify app dev`).
	const app = new URL(env.HOST || wrangler.vars.SHOPIFY_APP_URL);
	const port = Number.parseInt(env.PORT || "8080", 10);
	const isTest = mode === "test";

	return {
		staged: {
			"*": "vp check --fix",
		},
		base: app.href,
		plugins: isTest
			? []
			: [
					nativePreact(),
					cloudflare({ tunnel: { name: "chris" }, viteEnvironment: { name: "ssr" } }),
				],
		server: {
			allowedHosts: [app.hostname.replace(/^[^.]+(?=\.)/, "")],
			cors: false,
			origin: app.origin,
			port,
			strictPort: true,
			preflightContinue: true,
		},
		lint: {
			ignorePatterns: ["dist/**", ".claude/**", ".shopify/**", ".wrangler/**", "cloudflare.d.ts"],
			options: {
				typeAware: true,
				typeCheck: true,
			},
		},
		fmt: {
			ignorePatterns: ["dist/**", ".claude/**", ".shopify/**", ".wrangler/**", "cloudflare.d.ts"],
			useTabs: true,
		},
		test: {
			passWithNoTests: true,
			projects: [
				{
					plugins: [
						nativePreact(),
						cloudflareTest({ wrangler: { configPath: "./wrangler.json" } }),
					],
					test: {
						name: "server",
						globalSetup: ["./src/test/assets-setup.ts"],
						include: [
							"src/test/app.test.ts",
							"src/test/shopify.test.ts",
							"src/test/server-entry.test.ts",
						],
					},
				},
				{
					// Client code runs in a real browser (Chromium via Playwright) so Polaris
					// web components actually render — jsdom/happy-dom can't.
					plugins: [nativePreact()],
					test: {
						name: "client",
						include: ["src/test/client.test.tsx", "src/test/client-entry.test.ts"],
						browser: {
							enabled: true,
							headless: true,
							provider: playwright(),
							instances: [{ browser: "chromium" }],
						},
					},
				},
				{
					plugins: [nativePreact()],
					test: {
						name: "unit",
						environment: "node",
						include: [
							"src/test/configuration.story.test.ts",
							"src/test/configuration.scene.test.ts",
							"src/test/configuration-record.test.ts",
						],
					},
				},
			],
		},
	};
});
