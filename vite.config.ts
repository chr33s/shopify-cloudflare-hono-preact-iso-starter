import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import { defineConfig, loadEnv } from "vite";
import wrangler from "./wrangler.json" with { type: "json" };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  // HOST overrides the app URL for local tunnel dev (e.g. `shopify app dev`).
  const app = new URL(env.HOST || wrangler.vars.SHOPIFY_APP_URL);
  const port = Number.parseInt(env.PORT || "8080", 10);

  return {
    base: app.href,
    plugins: [
      preact(),
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
  };
});
