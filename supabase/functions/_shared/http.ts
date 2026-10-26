import type { CommerceConfig } from "./config.ts";
import type { ApiErrorBody } from "./types.ts";
import { constantTimeEqual, utf8 } from "./pure.ts";

const requestResponseHeaders = new WeakMap<Request, Headers>();

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function preserveResponseHeaders(
  request: Request,
  additions: Headers,
): void {
  const headers = new Headers(requestResponseHeaders.get(request));
  additions.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.set(key, value);
  });
  for (const cookie of additions.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  requestResponseHeaders.set(request, headers);
}

export function requestId(request: Request): string {
  const provided = request.headers.get("x-gf-request-id");
  if (provided && /^[A-Za-z0-9._:-]{8,100}$/.test(provided)) return provided;
  return crypto.randomUUID();
}

export function requireTrustedProxy(
  config: CommerceConfig,
  request: Request,
): void {
  if (config.allowLocalDirectRequests) return;
  const provided = request.headers.get("x-gf-proxy-secret") ?? "";
  const expected = config.upstreamProxySecret ?? "";
  if (!constantTimeEqual(utf8(provided), utf8(expected))) {
    throw new ApiError(404, "not_found", "Resource was not found.");
  }
}

export function responseHeaders(
  config: CommerceConfig,
  request: Request,
): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  const origin = request.headers.get("origin") ?? "";
  if (config.allowedSiteOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Expose-Headers", "X-CSRF-Token, X-Request-ID");
    headers.set("Vary", "Origin");
  }
  return headers;
}

export function jsonResponse(
  config: CommerceConfig,
  request: Request,
  body: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = responseHeaders(config, request);
  if (extraHeaders) {
    const additions = new Headers(extraHeaders);
    additions.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
    });
    for (const cookie of additions.getSetCookie()) {
      headers.append("Set-Cookie", cookie);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function noContentResponse(
  config: CommerceConfig,
  request: Request,
  extraHeaders?: HeadersInit,
): Response {
  const headers = responseHeaders(config, request);
  headers.delete("Content-Type");
  if (extraHeaders) {
    const additions = new Headers(extraHeaders);
    additions.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
    });
    for (const cookie of additions.getSetCookie()) {
      headers.append("Set-Cookie", cookie);
    }
  }
  return new Response(null, { status: 204, headers });
}

export function errorResponse(
  config: CommerceConfig,
  request: Request,
  error: unknown,
  id: string,
): Response {
  const apiError = error instanceof ApiError ? error : new ApiError(
    500,
    "internal_error",
    "The request could not be completed.",
    true,
  );
  const body: ApiErrorBody = {
    code: apiError.code,
    publicMessage: apiError.message,
    requestId: id,
    ...(apiError.retryable ? { retryable: true } : {}),
    ...(typeof apiError.details?.revocation === "string"
      ? { revocation: apiError.details.revocation }
      : {}),
  };
  const headers = new Headers(requestResponseHeaders.get(request));
  if (typeof apiError.details?.retryAfter === "number") {
    headers.set("Retry-After", String(apiError.details.retryAfter));
  }
  return jsonResponse(config, request, body, apiError.status, headers);
}

export function optionsResponse(
  config: CommerceConfig,
  request: Request,
): Response {
  const origin = request.headers.get("origin");
  if (!origin || !config.allowedSiteOrigins.includes(origin)) {
    return new Response(null, { status: 403 });
  }
  const headers = responseHeaders(config, request);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Idempotency-Key, X-CSRF-Token, X-GF-Timestamp, X-GF-Nonce, X-GF-Signature",
  );
  headers.set("Access-Control-Max-Age", "600");
  headers.delete("Content-Type");
  return new Response(null, { status: 204, headers });
}

export async function readBoundedText(
  request: Request,
  maxBytes = 16_384,
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^\d{1,10}$/.test(declared)) {
    throw new ApiError(
      400,
      "invalid_content_length",
      "Content length is invalid.",
    );
  }
  if (declared !== null && Number(declared) > maxBytes) {
    throw new ApiError(413, "request_too_large", "Request is too large.");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "request_too_large", "Request is too large.");
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
  return new TextDecoder().decode(result);
}

export async function readJson(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json") {
    throw new ApiError(
      415,
      "json_required",
      "Content-Type must be application/json.",
    );
  }
  const raw = await readBoundedText(request, maxBytes);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export function requireSameSiteMutation(
  config: CommerceConfig,
  request: Request,
): void {
  if (
    !config.allowedSiteOrigins.includes(request.headers.get("origin") ?? "")
  ) {
    throw new ApiError(403, "origin_denied", "Request origin is not allowed.");
  }
}
