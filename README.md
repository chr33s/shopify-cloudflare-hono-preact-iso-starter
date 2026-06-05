# Shopify Starter

A minimal embedded Shopify app on Cloudflare Workers: [Hono](https://hono.dev) server,
[Preact](https://preactjs.com) UI with SSR + hydration via
[preact-iso](https://github.com/preactjs/preact-iso), Shopify token-exchange auth, and
[Polaris web components](https://shopify.dev/docs/api/app-home) + App Bridge in the embedded admin.

## Stack

- **Server** — Hono on Workers. Routes defined in `src/server/app.ts`, Shopify auth core in
  `src/server/shopify.ts`.
- **Shopify auth** — [`@shopify/shopify-api`](https://github.com/Shopify/shopify-api-js) (via its
  `cf-worker` adapter) handles the security primitives: session-token decode, webhook HMAC, and
  app-proxy HMAC. Local extensions cover what the library doesn't: token exchange with expiring
  offline tokens + refresh, KV session storage, app-proxy timestamp freshness, and the embedded
  CSP/bounce headers.
- **Client** — Preact SSR'd by the worker, hydrated in the browser. Routes in `src/client/app.tsx`.
- **Storage** — one KV namespace (`SESSION_KV`) for offline sessions.

## Setup

1. Create a Shopify app in the [Partner Dashboard](https://partners.shopify.com) and note its API key + secret.
2. Create a KV namespace:
   ```sh
   npx vp exec wrangler kv namespace create shopify-starter
   npx vp exec wrangler kv namespace create shopify-starter --preview
   ```
3. Fill in the placeholders in `wrangler.json` (`name`, KV ids, `SHOPIFY_API_KEY`,
   `SHOPIFY_APP_HANDLE`, `SHOPIFY_APP_URL`) and `shopify.app.toml` (`client_id`,
   `application_url`, `handle`, scopes, proxy URL, redirect URL).
4. Local secret: `cp .env.example .env` and set `SHOPIFY_API_SECRET_KEY`.
   In production: `npx vp exec wrangler secret put SHOPIFY_API_SECRET_KEY`.
5. Generate binding types: `npx vp run typegen` (writes `cloudflare.d.ts`).
6. IDE setup: [viteplus.dev](https://viteplus.dev/guide/ide-integration)

## Develop

Tooling is unified under [Vite+](https://viteplus.dev) — the `vp` CLI wraps the package
manager, dev/build, tests, and linting.

```sh
npx vp install
npx vp run typegen           # generate cloudflare.d.ts (Env types)
npx vp run shopify:dev       # Shopify CLI: tunnel + install flow (recommended)
# or
npx vp dev                   # dev server on :8080 (needs your own tunnel)
```

`npx vp run codegen` generates typed Admin GraphQL operations into `src/types` from the
queries in `src/**/*.{ts,tsx}`. Run `npx vp check` to format, lint, and type-check, and
`npx vp test` to run tests.

## Build & deploy

```sh
npx vp build                 # client + SSR worker bundle into dist/
npx vp run deploy            # build, then `wrangler deploy`
```

## Routes

- `GET /healthz` — unauthenticated uptime probe.
- `GET /shopify/install` — starts the embedded install flow.
- `GET /shopify/auth/callback` — returns the browser to the embedded shell after Shopify redirects back.
- `GET /shopify/session-token-bounce` — boots App Bridge for session-token reloads.
- `POST /shopify/webhooks` — validates webhook HMACs (`app/uninstalled` + mandatory GDPR topics).
- `ALL /shopify/admin` — session-token-gated Admin GraphQL passthrough (the embedded client POSTs here).
- `ALL /shopify/customer` — verifies the caller's Shopify auth and returns the customer id + shop.
- `ALL /apps/*` — app-proxy catch-all; verifies the proxy signature and echoes the shop.
- `GET *` — SSR of the Preact app (everything else).
