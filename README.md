# Shopify Starter

A minimal embedded Shopify app on Cloudflare Workers: [Hono](https://hono.dev) server,
[Preact](https://preactjs.com) UI with SSR + hydration via
[preact-iso](https://github.com/preactjs/preact-iso), Shopify token-exchange auth, and
[Polaris web components](https://shopify.dev/docs/api/app-home) + App Bridge in the embedded admin.

## Stack

- **Server** — Hono on Workers. Routes under `src/server/routes`, Shopify auth core in
  `src/server/libraries/shopify.ts` (token exchange, session storage in KV, webhook/proxy HMAC).
- **Client** — Preact SSR'd by the worker, hydrated in the browser. Routes in `src/client/routes`.
- **Storage** — one KV namespace (`SESSION_KV`) for offline sessions.

## Setup

1. Create a Shopify app in the [Partner Dashboard](https://partners.shopify.com) and note its API key + secret.
2. Create a KV namespace:
   ```sh
   npx wrangler kv namespace create shopify-starter
   npx wrangler kv namespace create shopify-starter --preview
   ```
3. Fill in the placeholders in `wrangler.json` (`name`, KV ids, `SHOPIFY_API_KEY`,
   `SHOPIFY_APP_HANDLE`, `SHOPIFY_APP_URL`) and `shopify.app.toml` (`client_id`,
   `application_url`, `handle`, scopes, proxy URL, redirect URL).
4. Local secret: `cp .env.example .env` and set `SHOPIFY_API_SECRET_KEY`.
   In production: `npx wrangler secret put SHOPIFY_API_SECRET_KEY`.
5. Generate binding types: `npm run typegen` (writes `cloudflare.d.ts`).

## Develop

```sh
npm install
npm run typegen          # generate cloudflare.d.ts (Env types)
npm run shopify:dev      # Shopify CLI: tunnel + install flow (recommended)
# or
npm run dev              # Vite dev server on :8080 (needs your own tunnel)
```

`npm run codegen` generates typed Admin GraphQL operations into `src/types` from the
queries in `src/**/*.{ts,tsx}`.

## Build & deploy

```sh
npm run build            # client + SSR worker bundle into dist/
npm run deploy           # build, then `wrangler deploy`
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
