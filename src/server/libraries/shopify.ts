import { type AdminApiClient, createAdminApiClient } from "@shopify/admin-api-client";
import { base64UrlDecodeToString, base64UrlEncode, hmacSha256, timingSafeEqual } from "./crypto.ts";

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const POLARIS_WEB_COMPONENTS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
const SHOPIFY_CDN = "https://cdn.shopify.com";
export const SHOPIFY_API_VERSION = "2026-04";
const PROXY_SIGNATURE_MAX_AGE_SECONDS = 90;
const SESSION_CLOCK_TOLERANCE_SECONDS = 10;
// Refresh ahead of the access-token expiry to absorb clock skew / RTT.
const ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS = 120;

const ALLOWED_DOMAINS = ["myshopify.com", "myshopify.io", "shop.dev", "shopify.com"];

export type SessionType = "admin" | "storefront";

export interface Session {
  accessToken: string;
  expires?: string;
  id: string;
  refreshToken?: string;
  refreshTokenExpires?: string;
  scope: string;
  shop: string;
}

export interface ShopifyConfig {
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET_KEY: string;
  SHOPIFY_API_VERSION: string;
  SHOPIFY_APP_HANDLE: string;
  SHOPIFY_APP_URL: string;
}

interface ShopifyTokenExchangeResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  errors?: {
    message?: string;
  };
  expires_in?: number;
  message?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope: string;
}

export interface ShopifyClient extends AdminApiClient {
  requestRaw(request: Request): Promise<Response>;
}

export interface AuthenticatedAdmin {
  client: ShopifyClient;
  session: Session;
}

export interface AuthenticatedCustomer {
  customer: {
    id?: string;
  };
  session: Session;
}

export interface AuthenticatedProxy {
  client: ShopifyClient;
  session: Session;
}

export interface ValidatedWebhook {
  apiVersion: string;
  domain: string;
  payload: unknown;
  subTopic?: string | null;
  topic: string;
  webhookId: string;
}

export interface AuthenticatedWebhook {
  client: ShopifyClient;
  session: Session;
  webhook: ValidatedWebhook;
}

interface DecodedSessionToken {
  aud?: string | string[];
  dest: string;
  exp?: number;
  nbf?: number;
  sub?: string;
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

export function config(env: Env): ShopifyConfig {
  if (!env.SHOPIFY_API_KEY) {
    throw new ShopifyError("Missing SHOPIFY_API_KEY", 500);
  }

  if (!env.SHOPIFY_API_SECRET_KEY) {
    throw new ShopifyError("Missing SHOPIFY_API_SECRET_KEY", 500);
  }

  if (!env.SHOPIFY_APP_URL) {
    throw new ShopifyError("Missing SHOPIFY_APP_URL", 500);
  }

  return {
    SHOPIFY_API_KEY: env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET_KEY: env.SHOPIFY_API_SECRET_KEY,
    SHOPIFY_API_VERSION: SHOPIFY_API_VERSION,
    SHOPIFY_APP_HANDLE: env.SHOPIFY_APP_HANDLE,
    SHOPIFY_APP_URL: env.SHOPIFY_APP_URL,
  };
}

export function getInstallUrl(env: Env, request: Request, shop: string) {
  const { SHOPIFY_API_KEY } = config(env);

  const installUrl = new URL(`https://${legacyUrlToShopAdminUrl(shop)}/oauth/install`);
  installUrl.searchParams.set("client_id", SHOPIFY_API_KEY);

  const url = new URL(request.url);
  if (url.searchParams.get("host")) {
    installUrl.searchParams.set("host", url.searchParams.get("host")!);
  }

  return installUrl;
}

export function generateCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/g, "");
}

export function getSessionTokenBounceHtml(env: Env, request: Request, nonce?: string) {
  const { SHOPIFY_API_KEY } = config(env);

  const url = new URL(request.url);
  const shopifyReload = url.searchParams.get("shopify-reload");
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  const reloadScript = shopifyReload
    ? /* html */ `<script${nonceAttr}>window.open(${JSON.stringify(shopifyReload)}, '_top');</script>`
    : "";

  return /* html */ `
  <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <script${nonceAttr} data-api-key="${escapeHtml(SHOPIFY_API_KEY)}" src="${APP_BRIDGE_URL}"></script>
      ${reloadScript}
    </head>
    <body></body>
    </html>
  `;
}

export function getShopifyHead(env: Env, request: Request, nonce?: string) {
  const url = new URL(request.url);
  const shop = sanitizeShop(url.searchParams.get("shop"));
  const apiKey = env.SHOPIFY_API_KEY;
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";

  const tags = [
    "<title>Shopify App</title>",
    '<meta name="description" content="Embedded Shopify app." />',
    `<link href="${SHOPIFY_CDN}" rel="preconnect" />`,
  ];

  if (shop && apiKey) {
    tags.push(`<meta name="shopify-api-key" content="${escapeHtml(apiKey)}" />`);
    tags.push('<meta name="shopify-experimental-features" content="keepAlive" />');
    tags.push(`<script${nonceAttr} src="${APP_BRIDGE_URL}"></script>`);
  }

  tags.push(`<script${nonceAttr} src="${POLARIS_WEB_COMPONENTS_URL}"></script>`);

  return tags.join("\n  ");
}

export function normalizeShopInput(shop: string | null) {
  if (!shop) {
    return null;
  }

  const trimmed = shop
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!trimmed) {
    return null;
  }

  return sanitizeShop(trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`);
}

export function sanitizeShop(shop: string | null) {
  if (!shop) {
    return null;
  }

  let sanitizedShop = shop
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const adminRegex = new RegExp(
    `^admin\\.(?:${ALLOWED_DOMAINS.map((domain) => domain.replace(/\./g, "\\.")).join("|")})/store/([a-zA-Z0-9][a-zA-Z0-9-_]*)$`,
    "i",
  );
  const adminMatch = adminRegex.exec(sanitizedShop);
  if (adminMatch) {
    sanitizedShop = `${adminMatch[1]}.myshopify.com`;
  }

  const shopRegex = new RegExp(
    `^([a-zA-Z0-9][a-zA-Z0-9-_]*)\\.(${ALLOWED_DOMAINS.map((domain) => domain.replace(/\./g, "\\.")).join("|")})$`,
    "i",
  );
  const shopMatch = shopRegex.exec(sanitizedShop);
  if (!shopMatch) {
    return null;
  }

  return `${shopMatch[1].toLowerCase()}.${shopMatch[2].toLowerCase()}`;
}

export async function validateWebhook(request: Request, env: Env) {
  const { SHOPIFY_API_SECRET_KEY } = config(env);

  const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!hmac) {
    throw new ShopifyError("Webhook header is missing", 400);
  }

  const data = await request.clone().text();
  if (!data) {
    throw new ShopifyError("Webhook body is missing", 400);
  }

  const valid = await validateHmac({
    data,
    encoding: "base64",
    hmac,
    secret: SHOPIFY_API_SECRET_KEY,
  });
  if (!valid) {
    throw new ShopifyError("Invalid hmac", 401);
  }

  const requiredHeaders = {
    apiVersion: "X-Shopify-API-Version",
    domain: "X-Shopify-Shop-Domain",
    topic: "X-Shopify-Topic",
    webhookId: "X-Shopify-Webhook-Id",
  } as const;

  for (const header of Object.values(requiredHeaders)) {
    if (!request.headers.get(header)) {
      throw new ShopifyError("Webhook required header is missing", 400);
    }
  }

  const domain = sanitizeShop(request.headers.get(requiredHeaders.domain));
  if (!domain) {
    throw new ShopifyError("Invalid shop domain", 400);
  }

  return {
    apiVersion: request.headers.get(requiredHeaders.apiVersion)!,
    domain,
    payload: parseJson(data),
    subTopic: request.headers.get("X-Shopify-Sub-Topic"),
    topic: request.headers.get(requiredHeaders.topic)!,
    webhookId: request.headers.get(requiredHeaders.webhookId)!,
  };
}

export function client({
  accessToken,
  apiVersion = SHOPIFY_API_VERSION,
  shop,
}: {
  accessToken: string;
  apiVersion?: string;
  shop: string;
}) {
  function admin(): ShopifyClient {
    const adminApi = createAdminApiClient({ accessToken, apiVersion, storeDomain: shop });

    async function requestRaw(request: Request) {
      if (request.method !== "POST") {
        throw new ShopifyError("Method Not Allowed", 405);
      }

      const response = await fetch(adminApi.getApiUrl(), {
        body: await request.clone().text(),
        headers: {
          ...adminApi.getHeaders(),
          Accept: request.headers.get("Accept") ?? "application/json",
          "Content-Type": request.headers.get("Content-Type") ?? "application/json",
        },
        method: "POST",
        signal: request.signal,
      });

      return new Response(response.body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    return { ...adminApi, requestRaw };
  }

  return { admin };
}

/** Admin API client bound to a stored session. */
export function adminClient(session: Session) {
  return client({ accessToken: session.accessToken, shop: session.shop }).admin();
}

/** Flatten Admin GraphQL `userErrors` into a single "field.path: message" string. */
export function formatUserErrors(
  errors: ReadonlyArray<{ field?: readonly string[] | null; message: string }>,
): string {
  return errors.map((error) => `${error.field?.join(".")}: ${error.message}`).join(", ");
}

/** SESSION_KV binding guard shared across modules. */
export function getKv(env: Env): KVNamespace {
  if (!env.SESSION_KV) {
    throw new ShopifyError("Missing SESSION_KV binding", 500);
  }
  return env.SESSION_KV;
}

export function session(env: Env, type: SessionType = "admin") {
  const kv = getKv(env);

  async function get(id: string) {
    if (!id) {
      return undefined;
    }

    return (await kv.get<Session>(key(id), "json")) ?? undefined;
  }

  async function set(id: string, data: Session | null) {
    if (!id) {
      return;
    }

    if (data === null) {
      await kv.delete(key(id));
      return;
    }

    await kv.put(key(id), JSON.stringify(data));
  }

  return {
    get,
    set,
  };

  function key(id: string) {
    return `${type}:${id}`;
  }
}

export async function admin(request: Request, env: Env): Promise<AuthenticatedAdmin | Response> {
  const preflight = handleOptions(request);
  if (preflight) {
    return preflight;
  }

  const currentConfig = config(env);
  const encodedSessionToken = getToken(request);
  const decodedSessionToken = await verifyToken(encodedSessionToken, {
    key: currentConfig.SHOPIFY_API_KEY,
    secretKey: currentConfig.SHOPIFY_API_SECRET_KEY,
  });

  if (!decodedSessionToken) {
    if (!request.headers.has("Authorization")) {
      return createBounceResponse(request, currentConfig);
    }

    return createUnauthorizedResponse(request, {
      "X-Shopify-Retry-Invalid-Session-Request": "1",
    });
  }

  const shop = sanitizeShop(getShopDomain(decodedSessionToken.dest));
  if (!shop) {
    throw new ShopifyError("Received invalid shop argument", 400);
  }

  const tokenResponse = await exchangeAdminToken({
    encodedSessionToken,
    request,
    shop,
    ...currentConfig,
  });

  const currentSession = sessionFromTokenResponse(shop, tokenResponse);
  await session(env).set(shop, currentSession);

  return {
    client: client({
      accessToken: currentSession.accessToken,
      apiVersion: currentConfig.SHOPIFY_API_VERSION,
      shop,
    }).admin(),
    session: currentSession,
  };
}

export async function customer(
  request: Request,
  env: Env,
): Promise<AuthenticatedCustomer | Response> {
  const preflight = handleOptions(request);
  if (preflight) {
    return preflight;
  }

  const currentConfig = config(env);
  const decodedSessionToken = await verifyToken(getToken(request), {
    key: currentConfig.SHOPIFY_API_KEY,
    secretKey: currentConfig.SHOPIFY_API_SECRET_KEY,
  });

  if (!decodedSessionToken) {
    return createUnauthorizedResponse(request, {
      "X-Shopify-Retry-Invalid-Session-Request": "1",
    });
  }

  const shop = sanitizeShop(getShopDomain(decodedSessionToken.dest));
  if (!shop) {
    throw new ShopifyError("Received invalid shop argument", 400);
  }

  const stored = await session(env).get(shop);
  if (!stored) {
    throw new ShopifyError("No session found", 401);
  }
  const currentSession = await ensureFreshSession(env, stored);

  return {
    customer: { id: decodedSessionToken.sub },
    session: currentSession,
  };
}

export async function proxy(request: Request, env: Env): Promise<AuthenticatedProxy> {
  const currentConfig = config(env);
  const url = new URL(request.url);

  const signature = url.searchParams.get("signature");
  if (!signature) {
    throw new ShopifyError("Proxy signature param is missing", 400);
  }

  const timestamp = url.searchParams.get("timestamp");
  if (!timestamp) {
    throw new ShopifyError("Proxy timestamp param is missing", 400);
  }

  const now = Math.trunc(Date.now() / 1000);
  const requestTimestamp = Number.parseInt(timestamp, 10);
  if (
    !Number.isFinite(requestTimestamp) ||
    now - requestTimestamp > PROXY_SIGNATURE_MAX_AGE_SECONDS
  ) {
    throw new ShopifyError("Proxy timestamp is expired", 401);
  }

  const data = [...url.searchParams.entries()]
    .filter(([key]) => key !== "signature")
    .map(([key, value]) => `${key}=${value}`)
    .sort((left, right) => left.localeCompare(right))
    .join("");

  const valid = await validateHmac({
    data,
    encoding: "hex",
    hmac: signature,
    secret: currentConfig.SHOPIFY_API_SECRET_KEY,
  });
  if (!valid) {
    throw new ShopifyError("Invalid hmac", 401);
  }

  // Replay enforcement runs per-route at the (sig + body-hash) layer.

  const shop = sanitizeShop(url.searchParams.get("shop"));
  if (!shop) {
    throw new ShopifyError("No shop param", 400);
  }

  const stored = await session(env).get(shop);
  if (!stored) {
    throw new ShopifyError("No session found", 401);
  }
  const currentSession = await ensureFreshSession(env, stored);

  return {
    client: client({
      accessToken: currentSession.accessToken,
      apiVersion: currentConfig.SHOPIFY_API_VERSION,
      shop,
    }).admin(),
    session: currentSession,
  };
}

export async function webhook(request: Request, env: Env): Promise<AuthenticatedWebhook> {
  const validatedWebhook = await validateWebhook(request, env);
  const currentConfig = config(env);
  const stored = await session(env).get(validatedWebhook.domain);
  if (!stored) {
    throw new ShopifyError("No session found", 401);
  }
  const currentSession = await ensureFreshSession(env, stored);

  return {
    client: client({
      accessToken: currentSession.accessToken,
      apiVersion: currentConfig.SHOPIFY_API_VERSION,
      shop: validatedWebhook.domain,
    }).admin(),
    session: currentSession,
    webhook: validatedWebhook,
  };
}

export const utils = {
  addCorsHeaders,
  addHeaders,
  getToken,
  handleOptions,
  legacyUrlToShopAdminUrl,
  normalizeShopInput,
  sanitizeShop,
  validateHmac,
  verifyToken,
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function legacyUrlToShopAdminUrl(shop: string) {
  return `admin.shopify.com/store/${shop.split(".").at(0)}`;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function validateHmac({
  data,
  encoding,
  hmac,
  secret,
}: {
  data: string;
  encoding: "base64" | "base64url" | "hex";
  hmac: string;
  secret: string;
}) {
  const signature = await hmacSha256(new TextEncoder().encode(secret), data);
  const expected = encode(signature, encoding);

  return timingSafeEqual(expected, hmac);
}

async function verifyToken(
  encoded: string,
  currentConfig: Record<"key" | "secretKey", string>,
): Promise<DecodedSessionToken | null> {
  const parts = encoded.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, payload, signature] = parts;
  let decodedHeader: { alg?: string };
  let decodedPayload: DecodedSessionToken;

  try {
    decodedHeader = decodeJwtPart(header);
    decodedPayload = decodeJwtPart(payload);
  } catch {
    return null;
  }

  if (decodedHeader.alg !== "HS256") {
    return null;
  }

  const digest = await hmacSha256(
    new TextEncoder().encode(currentConfig.secretKey),
    `${header}.${payload}`,
  );
  const expectedSignature = encode(digest, "base64url");
  if (!timingSafeEqual(expectedSignature, signature)) {
    return null;
  }

  const now = Math.trunc(Date.now() / 1000);
  if (decodedPayload.nbf && decodedPayload.nbf > now + SESSION_CLOCK_TOLERANCE_SECONDS) {
    return null;
  }

  if (decodedPayload.exp && decodedPayload.exp < now - SESSION_CLOCK_TOLERANCE_SECONDS) {
    return null;
  }

  const audience = Array.isArray(decodedPayload.aud)
    ? decodedPayload.aud
    : decodedPayload.aud
      ? [decodedPayload.aud]
      : [];
  if (!audience.includes(currentConfig.key)) {
    return null;
  }

  return decodedPayload;
}

function addCorsHeaders(request: Request, responseHeaders: Headers, allowedShop?: string | null) {
  const origin = request.headers.get("Origin");
  if (origin) {
    // Never echo arbitrary origins. Shop-scoped (verdict path) or
    // admin allow-list (admin/customer paths).
    const allowed = allowedShop
      ? allowedOriginForShop(origin, allowedShop)
      : allowedOriginForAdmin(origin);
    if (allowed) {
      responseHeaders.set("Access-Control-Allow-Origin", allowed);
      responseHeaders.append("Vary", "Origin");
    }
  }

  responseHeaders.set("Access-Control-Allow-Credentials", "true");
  responseHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function allowedOriginForShop(origin: string, shop: string): string | null {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    const target = shop.toLowerCase();
    // Exact match or merchant's custom primary-domain subdomain.
    if (host === target || host.endsWith(`.${target}`)) return origin;
  } catch {
    return null;
  }
  return null;
}

function allowedOriginForAdmin(origin: string): string | null {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === "admin.shopify.com") return origin;
    for (const domain of ALLOWED_DOMAINS) {
      if (host === domain || host.endsWith(`.${domain}`)) return origin;
    }
  } catch {
    return null;
  }
  return null;
}

export function addHeaders(request: Request, responseHeaders: Headers, nonce?: string) {
  const url = new URL(request.url);
  const shop = sanitizeShop(url.searchParams.get("shop"));

  const frameAncestors = shop
    ? `https://${shop} https://admin.shopify.com`
    : `https://*.myshopify.com https://admin.shopify.com`;

  // Nonce when SSR-stamped, else 'unsafe-inline'. style-src stays inline —
  // Polaris injects styles outside the nonce.
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${SHOPIFY_CDN}`
    : `script-src 'self' 'unsafe-inline' ${SHOPIFY_CDN}`;

  // Explicit ws/wss — 'self' is unreliable across browsers for these schemes (HMR).
  const wsSelf = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;

  const csp = [
    `frame-ancestors ${frameAncestors}`,
    `default-src 'self'`,
    scriptSrc,
    `style-src 'self' 'unsafe-inline' ${SHOPIFY_CDN}`,
    `connect-src 'self' ${wsSelf} https://${shop ?? "*.myshopify.com"} https://admin.shopify.com ${SHOPIFY_CDN}`,
    `img-src 'self' data: ${SHOPIFY_CDN}`,
    `font-src 'self' data: ${SHOPIFY_CDN}`,
  ];
  responseHeaders.set("Content-Security-Policy", csp.join("; ") + ";");

  if (shop && !url.pathname.startsWith("/apps")) {
    responseHeaders.set("Link", `<${APP_BRIDGE_URL}>; rel="preload"; as="script";`);
  }
}

function createBounceResponse(request: Request, currentConfig: ShopifyConfig) {
  const url = new URL(request.url);
  url.searchParams.delete("id_token");

  const withParams = (target: URL) => {
    for (const [key, value] of url.searchParams.entries()) target.searchParams.set(key, value);
    return target;
  };

  const reloadUrl = withParams(new URL(url.pathname, currentConfig.SHOPIFY_APP_URL));
  const bounceUrl = withParams(
    new URL("/shopify/session-token-bounce", currentConfig.SHOPIFY_APP_URL),
  );
  bounceUrl.searchParams.set("shopify-reload", reloadUrl.toString());

  const response = new Response(null, {
    status: 302,
    headers: { Location: bounceUrl.toString() },
  });
  addHeaders(request, response.headers);
  return response;
}

function createUnauthorizedResponse(request: Request, headers?: HeadersInit) {
  const response = new Response(undefined, {
    headers: new Headers(headers),
    status: 401,
    statusText: "Unauthorized",
  });
  addCorsHeaders(request, response.headers);
  return response;
}

function decodeJwtPart<T>(value: string) {
  return JSON.parse(base64UrlDecodeToString(value)) as T;
}

function encode(value: ArrayBuffer, encoding: "base64" | "base64url" | "hex") {
  const bytes = new Uint8Array(value);

  if (encoding === "base64") {
    return btoa(String.fromCharCode(...bytes));
  }

  if (encoding === "base64url") {
    return base64UrlEncode(bytes);
  }

  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exchangeAdminToken({
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET_KEY,
  encodedSessionToken,
  request,
  shop,
}: {
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET_KEY: string;
  encodedSessionToken: string;
  request: Request;
  shop: string;
}) {
  // Admin API rejects non-expiring offline tokens with 403 (2026-04+).
  // https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#expiring-vs-non-expiring-offline-tokens
  const body = {
    client_id: SHOPIFY_API_KEY,
    client_secret: SHOPIFY_API_SECRET_KEY,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    subject_token: encodedSessionToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    expiring: "1",
  };

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    body: JSON.stringify(body),
    headers: new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
    method: "POST",
    signal: request.signal,
  });
  const payload = (await response.json().catch(() => ({}))) as ShopifyTokenExchangeResponse;

  if (!response.ok) {
    const message =
      payload.error_description ??
      payload.error ??
      payload.errors?.message ??
      payload.message ??
      response.statusText;
    throw new ShopifyError(
      `Received an error response (${response.status} ${response.statusText}) from Shopify: ${message}`,
      response.status,
    );
  }

  if (!payload.access_token) {
    throw new ShopifyError("Shopify access token missing from response", 502);
  }

  return payload as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope: string;
  };
}

/**
 * Build a {@link Session} from a Shopify `/admin/oauth/access_token` response,
 * including refresh-token fields when present (expiring offline tokens).
 */
function sessionFromTokenResponse(
  shop: string,
  payload: {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope: string;
  },
): Session {
  const now = Date.now();
  return {
    accessToken: payload.access_token,
    expires: payload.expires_in
      ? new Date(now + payload.expires_in * 1000).toISOString()
      : undefined,
    id: shop,
    refreshToken: payload.refresh_token,
    refreshTokenExpires: payload.refresh_token_expires_in
      ? new Date(now + payload.refresh_token_expires_in * 1000).toISOString()
      : undefined,
    scope: payload.scope,
    shop,
  };
}

/**
 * Exchange a refresh token for a fresh access + refresh token pair.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#refresh-tokens
 */
async function refreshAccessToken(env: Env, currentSession: Session): Promise<Session> {
  if (!currentSession.refreshToken) {
    throw new ShopifyError("Session has no refresh token", 401);
  }

  const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET_KEY } = config(env);
  const response = await fetch(`https://${currentSession.shop}/admin/oauth/access_token`, {
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET_KEY,
      grant_type: "refresh_token",
      refresh_token: currentSession.refreshToken,
    }),
    headers: new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
    method: "POST",
  });
  const payload = (await response.json().catch(() => ({}))) as ShopifyTokenExchangeResponse;

  if (!response.ok) {
    const message =
      payload.error_description ??
      payload.error ??
      payload.errors?.message ??
      payload.message ??
      response.statusText;
    throw new ShopifyError(
      `Received an error response (${response.status} ${response.statusText}) from Shopify: ${message}`,
      response.status,
    );
  }

  if (!payload.access_token) {
    throw new ShopifyError("Shopify access token missing from response", 502);
  }

  const refreshed = sessionFromTokenResponse(currentSession.shop, {
    access_token: payload.access_token,
    expires_in: payload.expires_in,
    refresh_token: payload.refresh_token,
    refresh_token_expires_in: payload.refresh_token_expires_in,
    scope: payload.scope ?? currentSession.scope,
  });
  await session(env).set(currentSession.shop, refreshed);
  return refreshed;
}

/**
 * Return `currentSession` unchanged when its access token is still valid,
 * otherwise transparently refresh and persist a new session. Throws when the
 * refresh token itself has expired — callers should treat this as
 * "needs re-auth" (admin re-launch will mint a new pair via token exchange).
 */
export async function ensureFreshSession(env: Env, currentSession: Session): Promise<Session> {
  if (!needsAccessTokenRefresh(currentSession)) {
    return currentSession;
  }

  // Legacy non-expiring offline tokens have no refresh path; assume still valid.
  if (!currentSession.refreshToken) {
    return currentSession;
  }

  if (currentSession.refreshTokenExpires) {
    const expiresAt = Date.parse(currentSession.refreshTokenExpires);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw new ShopifyError("Refresh token expired; merchant must re-launch the app", 401);
    }
  }

  return refreshAccessToken(env, currentSession);
}

function needsAccessTokenRefresh(currentSession: Session): boolean {
  if (!currentSession.expires) return false;
  const expiresAt = Date.parse(currentSession.expires);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - Date.now() <= ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS * 1000;
}

function getShopDomain(dest: string) {
  try {
    return new URL(dest).hostname;
  } catch {
    return dest;
  }
}

function getToken(request: Request) {
  return (
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
    new URL(request.url).searchParams.get("id_token") ||
    ""
  );
}

function handleOptions(request: Request) {
  if (request.method !== "OPTIONS") {
    return undefined;
  }

  const response = new Response(null, {
    headers: new Headers({
      "Access-Control-Max-Age": "7200",
    }),
    status: 204,
  });
  addCorsHeaders(request, response.headers);
  return response;
}
