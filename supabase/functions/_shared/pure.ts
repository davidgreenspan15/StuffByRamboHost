const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bufferSource(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export const LICENSE_ISSUER = "https://licenses.stuffbyrambo.com";
export const LICENSE_AUDIENCE = "stuffbyrambo.GestureControlPython";
export const MAX_PERMIT_SECONDS = 30 * 24 * 60 * 60;
export const TIME_ASSERTION_SECONDS = 5 * 60;

export type JsonObject = Record<string, unknown>;

export interface PermitClaims extends JsonObject {
  v: 1;
  iss: typeof LICENSE_ISSUER;
  aud: typeof LICENSE_AUDIENCE;
  sub: string;
  jti: string;
  activationId: string;
  installationId: string;
  product: "gesture-flow";
  edition: "python-mediapipe";
  majorVersion: 3;
  features: string[];
  entitlementType: "purchase" | "trial";
  entitlementStatus: "active";
  deviceLimit: number;
  entitlementExpiresAt?: number;
  iat: number;
  nbf: number;
  exp: number;
}

export interface RevocationClaims extends JsonObject {
  v: 1;
  iss: typeof LICENSE_ISSUER;
  aud: typeof LICENSE_AUDIENCE;
  jti: string;
  activationId: string;
  installationId: string;
  permitJti: string;
  reason: string;
  iat: number;
  exp: number;
}

export interface TimeClaims extends JsonObject {
  v: 1;
  iss: typeof LICENSE_ISSUER;
  aud: typeof LICENSE_AUDIENCE;
  nonce: string;
  iat: number;
  exp: number;
}

export interface StripeSignatureResult {
  timestamp: number;
  signature: string;
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8String(value: Uint8Array): string {
  return decoder.decode(value);
}

export function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid_base64url");
  const paddingLength = (4 - (value.length % 4)) % 4;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat(paddingLength);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function hexEncode(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function hexDecode(value: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(value) || value.length % 2 !== 0) {
    throw new Error("invalid_hex");
  }
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}

export async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? utf8(value) : value;
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", bufferSource(bytes)),
  );
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  return hexEncode(await sha256(value));
}

export async function hmacSha256Hex(
  secret: string,
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    bufferSource(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hexEncode(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, bufferSource(utf8(value))),
    ),
  );
}

export function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function canonicalDeviceProof(
  method: string,
  path: string,
  unixTimestamp: number,
  nonceBase64Url: string,
  body: string | Uint8Array,
): Promise<string> {
  if (!Number.isInteger(unixTimestamp) || unixTimestamp <= 0) {
    throw new Error("invalid_timestamp");
  }
  if (!path.startsWith("/v1/")) throw new Error("invalid_device_path");
  base64UrlDecode(nonceBase64Url);
  const bodyHash = await sha256Hex(body);
  return `GF1\n${method.toUpperCase()}\n${path}\n${unixTimestamp}\n${nonceBase64Url}\n${bodyHash}`;
}

export function parseStripeSignature(
  header: string,
): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (!timestamp || signatures.length === 0) {
    throw new Error("invalid_stripe_signature_header");
  }
  return { timestamp, signatures };
}

export async function verifyStripeSignature(
  rawPayload: string,
  signatureHeader: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<StripeSignatureResult> {
  const parsed = parseStripeSignature(signatureHeader);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    throw new Error("stripe_signature_timestamp_outside_tolerance");
  }
  const expected = hexDecode(
    await hmacSha256Hex(secret, `${parsed.timestamp}.${rawPayload}`),
  );
  const matched = parsed.signatures.find((candidate) => {
    try {
      return constantTimeEqual(expected, hexDecode(candidate));
    } catch {
      return false;
    }
  });
  if (!matched) throw new Error("stripe_signature_mismatch");
  return { timestamp: parsed.timestamp, signature: matched };
}

function stableJson(value: JsonObject): string {
  return JSON.stringify(value);
}

export async function signCompactJws(
  type: "GF-PERMIT" | "GF-REVOCATION" | "GF-TIME",
  keyId: string,
  payload: JsonObject,
  privateJwk: JsonWebKey,
): Promise<string> {
  const header = { alg: "EdDSA", typ: type, kid: keyId };
  const encodedHeader = base64UrlEncode(utf8(stableJson(header)));
  const encodedPayload = base64UrlEncode(utf8(stableJson(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      bufferSource(utf8(signingInput)),
    ),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function verifyCompactJws(
  token: string,
  expectedType: "GF-PERMIT" | "GF-REVOCATION" | "GF-TIME",
  publicJwk: JsonWebKey,
): Promise<{ header: JsonObject; payload: JsonObject }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_jws");
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("invalid_jws");
  }
  const header = JSON.parse(
    utf8String(base64UrlDecode(encodedHeader)),
  ) as JsonObject;
  if (
    header.alg !== "EdDSA" || header.typ !== expectedType ||
    typeof header.kid !== "string"
  ) {
    throw new Error("invalid_jws_header");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    bufferSource(base64UrlDecode(encodedSignature)),
    bufferSource(utf8(`${encodedHeader}.${encodedPayload}`)),
  );
  if (!valid) throw new Error("invalid_jws_signature");
  return {
    header,
    payload: JSON.parse(
      utf8String(base64UrlDecode(encodedPayload)),
    ) as JsonObject,
  };
}

export function buildPermitClaims(input: {
  entitlementId: string;
  jti: string;
  activationId: string;
  installationId: string;
  features: string[];
  entitlementType: "purchase" | "trial";
  deviceLimit: number;
  entitlementExpiresAt?: number;
  nowSeconds?: number;
}): PermitClaims {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const entitlementExpiration = input.entitlementExpiresAt;
  if (input.entitlementType === "trial" && !entitlementExpiration) {
    throw new Error("trial_expiration_required");
  }
  const permitExpiration = Math.min(
    now + MAX_PERMIT_SECONDS,
    entitlementExpiration ?? Number.MAX_SAFE_INTEGER,
  );
  if (permitExpiration <= now) throw new Error("entitlement_expired");

  return {
    v: 1,
    iss: LICENSE_ISSUER,
    aud: LICENSE_AUDIENCE,
    sub: input.entitlementId,
    jti: input.jti,
    activationId: input.activationId,
    installationId: input.installationId,
    product: "gesture-flow",
    edition: "python-mediapipe",
    majorVersion: 3,
    features: input.features,
    entitlementType: input.entitlementType,
    entitlementStatus: "active",
    deviceLimit: input.deviceLimit,
    ...(entitlementExpiration
      ? { entitlementExpiresAt: entitlementExpiration }
      : {}),
    iat: now,
    nbf: now - 30,
    exp: permitExpiration,
  };
}

export function buildRevocationClaims(input: {
  jti: string;
  activationId: string;
  installationId: string;
  permitJti: string;
  reason: string;
  nowSeconds?: number;
}): RevocationClaims {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    v: 1,
    iss: LICENSE_ISSUER,
    aud: LICENSE_AUDIENCE,
    jti: input.jti,
    activationId: input.activationId,
    installationId: input.installationId,
    permitJti: input.permitJti,
    reason: input.reason,
    iat: now,
    exp: now + TIME_ASSERTION_SECONDS,
  };
}

export function buildTimeClaims(
  nonce: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TimeClaims {
  if (base64UrlDecode(nonce).length < 16) {
    throw new Error("time_nonce_too_short");
  }
  return {
    v: 1,
    iss: LICENSE_ISSUER,
    aud: LICENSE_AUDIENCE,
    nonce,
    iat: nowSeconds,
    exp: nowSeconds + TIME_ASSERTION_SECONDS,
  };
}

export function entitlementState(input: {
  adminRevoked: boolean;
  amountTotal: number;
  successfulRefundAmount: number;
  pendingRefundAmount: number;
  hasOpenDispute: boolean;
  hasLostDispute: boolean;
}): { order: string; entitlement: string } {
  if (input.adminRevoked) {
    return { order: "revoked", entitlement: "revoked_admin" };
  }
  if (input.successfulRefundAmount >= input.amountTotal) {
    return { order: "refunded", entitlement: "refunded" };
  }
  if (input.hasLostDispute) {
    return { order: "chargeback", entitlement: "revoked_chargeback" };
  }
  if (input.hasOpenDispute) {
    return { order: "suspended_dispute", entitlement: "suspended_dispute" };
  }
  if (
    input.pendingRefundAmount > 0 &&
    input.successfulRefundAmount + input.pendingRefundAmount >=
      input.amountTotal
  ) {
    return { order: "suspended_refund", entitlement: "suspended_refund" };
  }
  return { order: "paid", entitlement: "active" };
}

export function randomBase64Url(byteLength: number): string {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 1024) {
    throw new Error("invalid_random_length");
  }
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomActivationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.getRandomValues(new Uint8Array(8));
  const characters = Array.from(
    random,
    (byte) => alphabet[byte % alphabet.length],
  );
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

export function normalizeActivationCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalized)) {
    throw new Error("invalid_activation_code");
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}
