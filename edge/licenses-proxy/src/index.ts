const PUBLIC_PREFIX = "/v1";
const MAX_BODY_BYTES = 1_048_576;
const BROWSER_ORIGINS = new Set([
  "https://stuffbyrambo.com",
  "https://www.stuffbyrambo.com",
]);
const ALLOWED_SUPABASE_FUNCTION_URLS = new Set([
  "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/",
]);

export interface Env {
  SUPABASE_FUNCTION_URL: string;
  UPSTREAM_PROXY_SECRET: string;
  IP_HASH_SECRET: string;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "idempotency-key",
  "origin",
  "stripe-signature",
  "user-agent",
  "x-csrf-token",
  "x-gf-nonce",
  "x-gf-signature",
  "x-gf-timestamp",
]);

const FORWARDED_RESPONSE_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "cache-control",
  "content-type",
  "retry-after",
  "set-cookie",
  "vary",
  "x-csrf-token",
  "x-request-id",
]);

export default {
  async fetch(
    request: Request,
    env: Env,
    _context: WorkerContext,
  ): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      validateEnvironment(env);
      return await proxyRequest(request, env, requestId);
    } catch (error) {
      const status = error instanceof ProxyError ? error.status : 502;
      const code = error instanceof ProxyError ? error.code : "upstream_unavailable";
      return jsonResponse(
        { code, publicMessage: publicMessageFor(code) },
        status,
        requestId,
        request.headers.get("Origin"),
      );
    }
  },
};

export async function proxyRequest(
  request: Request,
  env: Env,
  requestId: string = crypto.randomUUID(),
): Promise<Response> {
  const publicUrl = new URL(request.url);
  if (
    publicUrl.pathname !== PUBLIC_PREFIX &&
    !publicUrl.pathname.startsWith(`${PUBLIC_PREFIX}/`)
  ) {
    throw new ProxyError(404, "not_found");
  }
  if (!new Set(["GET", "POST", "DELETE", "OPTIONS"]).has(request.method)) {
    throw new ProxyError(405, "method_not_allowed");
  }

  const contentLength = parseContentLength(
    request.headers.get("content-length"),
  );
  if (contentLength !== null && contentLength > MAX_BODY_BYTES) {
    throw new ProxyError(413, "request_too_large");
  }

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "OPTIONS") {
    body = await boundedBody(request);
  }

  const upstreamBase = normalizedUpstreamUrl(env.SUPABASE_FUNCTION_URL);
  const upstreamUrl = buildUpstreamUrl(upstreamBase, publicUrl);
  const headers = filteredHeaders(request.headers, FORWARDED_REQUEST_HEADERS);
  headers.set("X-GF-Proxy-Secret", env.UPSTREAM_PROXY_SECRET);
  headers.set("X-GF-Request-ID", requestId);
  headers.set(
    "X-GF-Client-IP-HMAC",
    await clientIpHmac(request, env.IP_HASH_SECRET),
  );
  headers.set(
    "X-GF-Client-Country",
    normalizedCountry(request.headers.get("CF-IPCountry")),
  );

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  const responseHeaders = filteredHeaders(
    upstreamResponse.headers,
    FORWARDED_RESPONSE_HEADERS,
  );
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  responseHeaders.set("Referrer-Policy", "no-referrer");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("X-Request-ID", requestId);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

async function boundedBody(request: Request): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ProxyError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function validateEnvironment(env: Env): void {
  if (
    !env.UPSTREAM_PROXY_SECRET ||
    env.UPSTREAM_PROXY_SECRET.length < 32 ||
    !env.IP_HASH_SECRET ||
    env.IP_HASH_SECRET.length < 32
  ) {
    throw new ProxyError(503, "service_not_configured");
  }
  normalizedUpstreamUrl(env.SUPABASE_FUNCTION_URL);
}

function normalizedUpstreamUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProxyError(503, "service_not_configured");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search ||
    url.hash || !ALLOWED_SUPABASE_FUNCTION_URLS.has(url.href)
  ) {
    throw new ProxyError(503, "service_not_configured");
  }
  return url;
}

export function buildUpstreamUrl(upstreamBase: URL, publicUrl: URL): URL {
  const relativePath = publicUrl.pathname.replace(/^\/+/, "");
  return new URL(`${relativePath}${publicUrl.search}`, upstreamBase);
}

function filteredHeaders(source: Headers, allowlist: Set<string>): Headers {
  const result = new Headers();
  for (const [name, value] of source) {
    if (
      name.toLowerCase() !== "set-cookie" && allowlist.has(name.toLowerCase())
    ) {
      result.append(name, value);
    }
  }
  if (allowlist.has("set-cookie")) {
    const cookieSource = source as Headers & { getSetCookie?: () => string[] };
    const cookies = cookieSource.getSetCookie?.() ?? [];
    for (const cookie of cookies) {
      result.append("Set-Cookie", cookie);
    }
    if (cookies.length === 0) {
      const cookie = source.get("Set-Cookie");
      if (cookie) {
        result.append("Set-Cookie", cookie);
      }
    }
  }
  return result;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  if (!/^\d{1,10}$/.test(value)) {
    throw new ProxyError(400, "invalid_content_length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProxyError(400, "invalid_content_length");
  }
  return parsed;
}

async function clientIpHmac(request: Request, secret: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(ip),
  );
  return Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join(
    "",
  );
}

function normalizedCountry(value: string | null): string {
  const country = String(value || "").toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : "ZZ";
}

function jsonResponse(
  payload: Record<string, string>,
  status: number,
  requestId: string,
  origin: string | null = null,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Request-ID": requestId,
  });
  if (origin && BROWSER_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function publicMessageFor(code: string): string {
  if (code === "request_too_large") {
    return "The request was too large.";
  }
  if (code === "not_found" || code === "method_not_allowed") {
    return "The requested license-service endpoint is unavailable.";
  }
  return "The license service is temporarily unavailable.";
}
