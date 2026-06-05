import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import preact from "@preact/preset-vite";
import { defineConfig, loadEnv } from "vite-plus";
import { playwright } from "vite-plus/test/browser/providers/playwright";
import wrangler from "./wrangler.json" with { type: "json" };

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
			: [preact(), cloudflare({ tunnel: { name: "chris" }, viteEnvironment: { name: "ssr" } })],
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
		},
		test: {
			passWithNoTests: true,
			projects: [
				{
					// Server code runs in the real Workers runtime (workerd via miniflare).
					plugins: [preact(), cloudflareTest({ wrangler: { configPath: "./wrangler.json" } })],
					// The pool's worker runtime imports `vitest/worker`, which resolves to the
					// top-level `vitest` alias copy. vite-plus otherwise reroutes bare `vitest` to
					// its nested copy, so pin it to the same copy for one shared runner instance.
					resolve: {
						alias: [
							{
								find: /^vitest$/,
								replacement: fileURLToPath(
									new URL("./node_modules/vitest/dist/index.js", import.meta.url),
								),
							},
						],
					},
					test: {
						name: "server",
						include: ["src/test/shopify.test.ts", "src/test/server-entry.test.ts"],
					},
				},
				{
					// Client code runs in a real browser (Chromium via Playwright) so Polaris
					// web components actually render — jsdom/happy-dom can't.
					plugins: [preact()],
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
			],
		},
	};
});
