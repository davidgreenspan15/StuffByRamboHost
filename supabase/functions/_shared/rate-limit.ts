import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./http.ts";
import { hmacSha256Hex } from "./pure.ts";
import type { CommerceConfig } from "./config.ts";

export interface RateLimitRule {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export function trustedIpHmac(request: Request): string {
  const value = request.headers.get("x-gf-client-ip-hmac") ?? "";
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ApiError(
      400,
      "request_context_missing",
      "Request context is invalid.",
    );
  }
  return value;
}

export async function privateRateLimitKey(
  config: CommerceConfig,
  namespace: string,
  value: string,
): Promise<string> {
  return await hmacSha256Hex(config.contextHmacSecret, `${namespace}:${value}`);
}

export async function consumeRateLimit(
  client: SupabaseClient,
  rule: RateLimitRule,
  keyHash: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(keyHash)) {
    throw new Error("invalid_rate_limit_key");
  }
  const { data, error } = await client.rpc("commerce_consume_rate_limit", {
    p_bucket: rule.bucket,
    p_key_hash: keyHash,
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new ApiError(
      503,
      "rate_limit_unavailable",
      "Service is temporarily unavailable.",
      true,
    );
  }
  const row = data[0] as { allowed?: boolean; retry_after_seconds?: number };
  if (!row.allowed) {
    const retryAfter = Math.max(
      1,
      Math.min(300, Number(row.retry_after_seconds) || 60),
    );
    throw new ApiError(
      429,
      "rate_limited",
      "Too many requests. Please wait and try again.",
      true,
      {
        retryAfter,
      },
    );
  }
}
