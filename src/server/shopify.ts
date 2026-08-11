import "@shopify/shopify-api/adapters/cf-worker";
import {
	ApiVersion,
	HttpResponseError,
	LogSeverity,
	RequestedTokenType,
	Session as LibrarySession,
	WebhookType,
	WebhookValidationErrorReason,
	shopifyApi,
} from "@shopify/shopify-api";
import { env } from "cloudflare:workers";

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const POLARIS_WEB_COMPONENTS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
const SHOPIFY_CDN = "https://cdn.shopify.com";
export const SHOPIFY_API_VERSION = "2026-04";
const PROXY_SIGNATURE_MAX_AGE_SECONDS = 90;
// Refresh ahead of the access-token expiry to absorb clock skew / RTT.
const ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS = 120;

const ALLOWED_DOMAINS = ["myshopify.com", "myshopify.io", "shop.dev", "shopify.com"];

// Params Shopify only ever sends once on an app-proxy request. A repeat lets the
// value the signature is verified against diverge from the value the app reads
// back, so they are rejected outright.
const APP_PROXY_SINGLE_VALUE_PARAMS = ["hmac", "shop", "signature", "timestamp"] as const;

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

export interface ShopifyClient {
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
	session: Session;
}

export interface ValidatedWebhook {
	apiVersion: string;
	domain: string;
	payload: unknown;
	topic: string;
	webhookId: string;
}

export interface AuthenticatedWebhook {
	/**
	 * Absent when the shop has no stored session — the HMAC is what authenticates a
	 * webhook, and compliance topics legitimately arrive after the session is gone.
	 */
	session?: Session;
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

let shopifyInstance: ReturnType<typeof shopifyApi> | undefined;

function getShopify() {
	if (!shopifyInstance) {
		shopifyInstance = shopifyApi({
			apiKey: env.SHOPIFY_API_KEY,
			apiSecretKey: env.SHOPIFY_API_SECRET_KEY,
			apiVersion: SHOPIFY_API_VERSION as ApiVersion,
			hostName: env.SHOPIFY_APP_URL ? new URL(env.SHOPIFY_APP_URL).host : "",
			isEmbeddedApp: true,
			logger: { level: LogSeverity.Error },
			// Authoritative in shopify.app.toml (managed install); the library requires a
			// non-empty value but never reads it for the primitives used here.
			scopes: ["read_products"],
		});
	}

	return shopifyInstance;
}

export function getInstallUrl(request: Request, shop: string) {
	const adminUrl = getShopify().utils.legacyUrlToShopAdminUrl(shop);
	if (!adminUrl) {
		throw new ShopifyError("Received invalid shop argument", 400);
	}

	const installUrl = new URL(`https://${adminUrl}/oauth/install`);
	installUrl.searchParams.set("client_id", env.SHOPIFY_API_KEY);

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

export function getSessionTokenBounceHtml(request: Request, nonce?: string) {
	const url = new URL(request.url);
	const shopifyReload = sameOriginReloadUrl(url.searchParams.get("shopify-reload"));
	const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
	const reloadScript = shopifyReload
		? /* html */ `<script${nonceAttr}>window.open(${encodeJsonForScript(shopifyReload)}, '_top');</script>`
		: "";

	return /* html */ `
  <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <script${nonceAttr} data-api-key="${escapeHtml(env.SHOPIFY_API_KEY)}" src="${APP_BRIDGE_URL}"></script>
      ${reloadScript}
    </head>
    <body></body>
    </html>
  `;
}

export function getShopifyHead(request: Request, nonce?: string) {
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

	return getShopify().utils.sanitizeShop(shop);
}

export async function validateWebhook(request: Request): Promise<ValidatedWebhook> {
	const rawBody = await request.clone().text();
	const result = await getShopify().webhooks.validate({ rawBody, rawRequest: request });

	if (!result.valid) {
		if (result.reason === WebhookValidationErrorReason.MissingHeaders) {
			throw new ShopifyError("Webhook required header is missing", 400);
		}
		throw new ShopifyError("Invalid hmac", 401);
	}

	if (result.webhookType !== WebhookType.Webhooks) {
		throw new ShopifyError("Unsupported webhook type", 400);
	}

	const domain = sanitizeShop(result.domain);
	if (!domain) {
		throw new ShopifyError("Invalid shop domain", 400);
	}

	// result.topic is normalized to UPPER_UNDERSCORE by topicForStorage; the
	// raw X-Shopify-Topic header preserves Shopify's canonical slash form
	// (e.g. "app/uninstalled"), which is what route handlers switch on.
	return {
		apiVersion: result.apiVersion,
		domain,
		payload: parseJson(rawBody),
		topic: request.headers.get("X-Shopify-Topic") ?? result.topic,
		webhookId: result.webhookId,
	};
}

export function client(currentSession: Session): ShopifyClient {
	const shopify = getShopify();
	const graphql = new shopify.clients.Graphql({ session: toLibrarySession(currentSession) });

	async function requestRaw(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			throw new ShopifyError("Method Not Allowed", 405);
		}

		const adminApi = graphql.client;
		const upstream = await fetch(adminApi.getApiUrl(), {
			method: "POST",
			body: request.body,
			// Required by fetch spec when body is a ReadableStream.
			duplex: "half",
			headers: {
				...adminApi.getHeaders(),
				Accept: request.headers.get("Accept") ?? "application/json",
				"Content-Type": request.headers.get("Content-Type") ?? "application/json",
			},
			signal: request.signal,
		} as RequestInit);

		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		});
	}

	return { requestRaw };
}

function toLibrarySession(stored: Session): LibrarySession {
	return new LibrarySession({
		id: stored.id,
		shop: stored.shop,
		state: "",
		isOnline: false,
		accessToken: stored.accessToken,
		scope: stored.scope,
	});
}

export function session(env: Env, type: SessionType = "admin") {
	const kv = env.SESSION_KV;

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

	const encodedSessionToken = getToken(request);
	const decodedSessionToken = await verifyToken(encodedSessionToken);

	if (!decodedSessionToken) {
		if (!request.headers.has("Authorization")) {
			return createBounceResponse(request);
		}

		return createUnauthorizedResponse(request, {
			"X-Shopify-Retry-Invalid-Session-Request": "1",
		});
	}

	const shop = sanitizeShop(getShopDomain(decodedSessionToken.dest));
	if (!shop) {
		throw new ShopifyError("Received invalid shop argument", 400);
	}

	// Reuse the stored offline session when we have one — token exchange is a
	// round-trip to Shopify and is rate limited, so it must not run per request.
	// Routes drop the session on a 401 from the Admin API (stale/revoked token),
	// which sends the next request back through token exchange below.
	const stored = await session(env).get(shop);
	if (stored) {
		try {
			const currentSession = await ensureFreshSession(env, stored);
			return {
				client: client(currentSession),
				session: currentSession,
			};
		} catch {
			// Refresh token expired or revoked — fall through and mint a fresh pair.
		}
	}

	// Admin API rejects non-expiring offline tokens with 403 (2026-04+).
	// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#expiring-vs-non-expiring-offline-tokens
	let librarySession: LibrarySession;
	try {
		({ session: librarySession } = await getShopify().auth.tokenExchange({
			shop,
			sessionToken: encodedSessionToken,
			requestedTokenType: RequestedTokenType.OfflineAccessToken,
			expiring: true,
		}));
	} catch (error) {
		throw mapShopifyApiError(error, "Token exchange failed");
	}

	const currentSession = toStoredSession(librarySession);
	await session(env).set(shop, currentSession);

	return {
		client: client(currentSession),
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

	const decodedSessionToken = await verifyToken(getToken(request));

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
	const url = new URL(request.url);

	// Must run before anything reads the query. `searchParams.get()` returns the
	// FIRST value while a collapsed `Record<string, string>` keeps the LAST, so a
	// duplicated param lets the shop whose signature is verified differ from the
	// shop whose session is loaded — a cross-shop auth bypass.
	for (const param of APP_PROXY_SINGLE_VALUE_PARAMS) {
		if (url.searchParams.getAll(param).length > 1) {
			throw new ShopifyError(`Proxy query param "${param}" must not appear more than once`, 400);
		}
	}

	const signature = url.searchParams.get("signature");
	if (!signature) {
		throw new ShopifyError("Proxy signature param is missing", 400);
	}

	const timestamp = url.searchParams.get("timestamp");
	if (!timestamp) {
		throw new ShopifyError("Proxy timestamp param is missing", 400);
	}

	// Two-sided window: a future-dated timestamp is as invalid as a stale one.
	const now = Math.trunc(Date.now() / 1000);
	const requestTimestamp = Number(timestamp);
	if (
		!Number.isInteger(requestTimestamp) ||
		Math.abs(now - requestTimestamp) > PROXY_SIGNATURE_MAX_AGE_SECONDS
	) {
		throw new ShopifyError("Proxy timestamp is expired", 401);
	}

	// Hand the library the URLSearchParams itself. Passing a pre-collapsed object
	// would hide duplicate params from its own single-value guard.
	let valid: boolean;
	try {
		valid = await getShopify().utils.validateHmac(url.searchParams, { signator: "appProxy" });
	} catch (error) {
		// validateHmac throws (rather than returning false) on a malformed query.
		throw new ShopifyError(error instanceof Error ? error.message : "Invalid hmac", 401);
	}
	if (!valid) {
		throw new ShopifyError("Invalid hmac", 401);
	}

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
		session: currentSession,
	};
}

export async function webhook(request: Request, env: Env): Promise<AuthenticatedWebhook> {
	const validatedWebhook = await validateWebhook(request);

	// The HMAC is what authenticates a webhook — a missing session is not an auth
	// failure. Mandatory compliance topics legitimately arrive with no session:
	// shop/redact lands ~48h after app/uninstalled already dropped it, and failing
	// those deliveries puts the app out of compliance. Handlers that need a session
	// check for one.
	const stored = await session(env).get(validatedWebhook.domain);
	let currentSession: Session | undefined;
	if (stored) {
		try {
			currentSession = await ensureFreshSession(env, stored);
		} catch {
			currentSession = undefined;
		}
	}

	return {
		session: currentSession,
		webhook: validatedWebhook,
	};
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * `JSON.stringify` leaves `</script` intact, which would close the enclosing
 * `<script>` element and let the rest of the value be parsed as markup. Escape the
 * characters that can break out of a script body (and the two line terminators
 * that are newlines to a JS parser but not to JSON).
 */
function encodeJsonForScript(value: unknown) {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/**
 * The bounce page calls `window.open(target, '_top')`, which escapes the admin
 * iframe — an attacker-supplied absolute URL would be an open redirect out of the
 * Shopify admin. Only ever bounce back into this app.
 */
function sameOriginReloadUrl(value: string | null) {
	if (!value || !env.SHOPIFY_APP_URL) {
		return null;
	}

	try {
		const appOrigin = new URL(env.SHOPIFY_APP_URL).origin;
		const target = new URL(value, appOrigin);
		return target.origin === appOrigin ? target.toString() : null;
	} catch {
		return null;
	}
}

function parseJson(value: string) {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

// decodeSessionToken validates HS256 sig, exp/nbf (10s tolerance), and aud === apiKey.
// It throws on failure; we return null so callers can drive the App Bridge bounce flow.
async function verifyToken(encoded: string): Promise<DecodedSessionToken | null> {
	if (!encoded) {
		return null;
	}

	try {
		const payload = await getShopify().session.decodeSessionToken(encoded);
		return payload as DecodedSessionToken;
	} catch {
		return null;
	}
}

function addCorsHeaders(request: Request, responseHeaders: Headers) {
	const origin = request.headers.get("Origin");
	if (origin) {
		// Never echo arbitrary origins — `Allow-Credentials: true` makes an echoed
		// origin a cross-origin read of authenticated responses.
		const allowed = allowedOriginForAdmin(origin);
		if (allowed) {
			responseHeaders.set("Access-Control-Allow-Origin", allowed);
			responseHeaders.append("Vary", "Origin");
		}
	}

	responseHeaders.set("Access-Control-Allow-Credentials", "true");
	responseHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
	responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
		// `base-uri` matters specifically under 'strict-dynamic': an injected <base>
		// would otherwise re-point every relative script URL.
		`base-uri 'self'`,
		`form-action 'self'`,
		`object-src 'none'`,
	];
	responseHeaders.set("Content-Security-Policy", csp.join("; ") + ";");
	responseHeaders.set("X-Content-Type-Options", "nosniff");
	// Session tokens can ride in the query string (`id_token`); never leak a URL.
	responseHeaders.set("Referrer-Policy", "no-referrer");

	if (shop && !url.pathname.startsWith("/apps")) {
		responseHeaders.set("Link", `<${APP_BRIDGE_URL}>; rel="preload"; as="script";`);
	}
}

function createBounceResponse(request: Request) {
	const url = new URL(request.url);
	url.searchParams.delete("id_token");

	const withParams = (target: URL) => {
		for (const [key, value] of url.searchParams.entries()) target.searchParams.set(key, value);
		return target;
	};

	const reloadUrl = withParams(new URL(url.pathname, env.SHOPIFY_APP_URL));
	const bounceUrl = withParams(new URL("/shopify/session-token-bounce", env.SHOPIFY_APP_URL));
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

// Library Session uses Date for expiry fields and is a class with methods that
// don't survive JSON round-trip; flatten to our KV-serializable DTO.
function toStoredSession(librarySession: LibrarySession): Session {
	if (!librarySession.accessToken) {
		throw new ShopifyError("Token exchange returned no access token", 502);
	}
	return {
		accessToken: librarySession.accessToken,
		expires: librarySession.expires?.toISOString(),
		id: librarySession.shop,
		refreshToken: librarySession.refreshToken,
		refreshTokenExpires: librarySession.refreshTokenExpires?.toISOString(),
		scope: librarySession.scope ?? "",
		shop: librarySession.shop,
	};
}

async function refreshAccessToken(env: Env, currentSession: Session): Promise<Session> {
	if (!currentSession.refreshToken) {
		throw new ShopifyError("Session has no refresh token", 401);
	}

	let librarySession: LibrarySession;
	try {
		({ session: librarySession } = await getShopify().auth.refreshToken({
			shop: currentSession.shop,
			refreshToken: currentSession.refreshToken,
		}));
	} catch (error) {
		throw mapShopifyApiError(error, "Token refresh failed");
	}

	const refreshed = toStoredSession(librarySession);
	await session(env).set(currentSession.shop, refreshed);
	return refreshed;
}

function mapShopifyApiError(error: unknown, fallback: string): ShopifyError {
	if (error instanceof HttpResponseError) {
		return new ShopifyError(error.message || fallback, error.response.code);
	}
	if (error instanceof Error) {
		return new ShopifyError(error.message, 500);
	}
	return new ShopifyError(fallback, 500);
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

export function handleOptions(request: Request) {
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

export function withCors(request: Request, response: Response): Response {
	try {
		applyCors(request, response.headers);
		return response;
	} catch {
		// Headers on responses produced by `fetch()` — the ASSETS binding, upstream
		// proxies — are immutable, so mutating them throws. Re-wrap and retry rather
		// than letting that surface as a 500.
		// The Response constructor rejects a body on a null-body status, which the
		// ASSETS binding can legitimately return (304 on a conditional request).
		const nullBodyStatus = [101, 204, 205, 304].includes(response.status);
		const mutable = new Response(nullBodyStatus ? null : response.body, {
			headers: new Headers(response.headers),
			status: response.status,
			statusText: response.statusText,
		});
		applyCors(request, mutable.headers);
		return mutable;
	}
}

function applyCors(request: Request, responseHeaders: Headers) {
	addCorsHeaders(request, responseHeaders);
	// Custom headers are invisible to cross-origin `fetch` readers unless exposed.
	responseHeaders.set("Access-Control-Expose-Headers", "X-Shopify-Retry-Invalid-Session-Request");
}
