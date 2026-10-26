import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./http.ts";

export interface IdempotencyHandle {
  operation: string;
  key: string;
  replay?: { status: number; body: Record<string, unknown> };
}

export interface StoredIdempotency {
  account_id: string | null;
  request_sha256: string;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
}

export function validateStoredIdempotency(
  stored: StoredIdempotency,
  expectedAccountId: string | undefined,
  expectedRequestSha256: string,
): void {
  if ((stored.account_id ?? undefined) !== expectedAccountId) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Idempotency-Key belongs to another request.",
    );
  }
  if (stored.request_sha256 !== expectedRequestSha256) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was used for another request.",
    );
  }
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) {
    throw new ApiError(
      400,
      "idempotency_key_required",
      "A valid Idempotency-Key is required.",
    );
  }
  return key;
}

export async function beginIdempotency(
  client: SupabaseClient,
  input: {
    operation: string;
    key: string;
    accountId?: string;
    requestSha256: string;
  },
): Promise<IdempotencyHandle> {
  const { error: insertError } = await client.from("commerce_api_idempotency")
    .insert({
      operation: input.operation,
      idempotency_key: input.key,
      account_id: input.accountId ?? null,
      request_sha256: input.requestSha256,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  if (!insertError) return { operation: input.operation, key: input.key };

  const { data, error } = await client
    .from("commerce_api_idempotency")
    .select(
      "account_id,request_sha256,response_status,response_body,expires_at",
    )
    .eq("operation", input.operation)
    .eq("idempotency_key", input.key)
    .maybeSingle();
  if (error || !data) {
    throw new ApiError(
      503,
      "idempotency_unavailable",
      "Request could not be safely recorded.",
      true,
    );
  }
  validateStoredIdempotency(
    data as StoredIdempotency,
    input.accountId,
    input.requestSha256,
  );
  if (
    data.response_status && data.response_body &&
    typeof data.response_body === "object"
  ) {
    return {
      operation: input.operation,
      key: input.key,
      replay: {
        status: Number(data.response_status),
        body: data.response_body as Record<string, unknown>,
      },
    };
  }
  throw new ApiError(
    409,
    "request_in_progress",
    "This request is already being processed.",
    true,
    {
      retryAfter: 3,
    },
  );
}

export async function finishIdempotency(
  client: SupabaseClient,
  handle: IdempotencyHandle,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("commerce_api_idempotency").update({
    response_status: status,
    response_body: body,
  }).eq("operation", handle.operation).eq("idempotency_key", handle.key);
  if (error) {
    throw new ApiError(
      503,
      "idempotency_persistence_failed",
      "Request result could not be safely recorded.",
      true,
    );
  }
}

export async function abortIdempotency(
  client: SupabaseClient,
  handle: IdempotencyHandle,
  accountId?: string,
): Promise<void> {
  let query = client.from("commerce_api_idempotency").delete()
    .eq("operation", handle.operation)
    .eq("idempotency_key", handle.key)
    .is("response_status", null);
  query = accountId
    ? query.eq("account_id", accountId)
    : query.is("account_id", null);
  const { error } = await query;
  if (error) {
    throw new ApiError(
      503,
      "idempotency_persistence_failed",
      "Request could not be safely retried.",
      true,
    );
  }
}

export async function finishIdempotentError(
  client: SupabaseClient,
  handle: IdempotencyHandle,
  error: ApiError,
): Promise<never> {
  await finishIdempotency(client, handle, error.status, {
    code: error.code,
    publicMessage: error.message,
    ...(error.retryable ? { retryable: true } : {}),
  });
  throw error;
}
