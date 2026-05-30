// Worker-runtime base64url + HMAC-SHA256 helpers used by the Shopify auth library.
// Uses native Web Crypto / atob / btoa.

const TEXT = new TextEncoder();

/** Base64url-encode bytes without padding. */
export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Decode base64url to a binary (Latin-1) string. */
export function base64UrlDecodeToString(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(`${normalized}${padding}`);
}

/** HMAC-SHA256 over `data` with a raw key. */
export async function hmacSha256(keyBytes: Uint8Array, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer.slice(
      keyBytes.byteOffset,
      keyBytes.byteOffset + keyBytes.byteLength,
    ) as ArrayBuffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, TEXT.encode(data));
}

/** Constant-time comparison of two equal-length strings. */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}
