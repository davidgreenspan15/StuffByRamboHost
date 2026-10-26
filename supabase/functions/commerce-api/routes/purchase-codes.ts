import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import { ApiError, readJson } from "../../_shared/http.ts";
import { exactKeys, stringField, uuidPath } from "../../_shared/validation.ts";
import { sha256Hex } from "../../_shared/pure.ts";
import {
  consumeRateLimit,
  privateRateLimitKey,
  trustedIpHmac,
} from "../../_shared/rate-limit.ts";
import {
  allowedActivationEmail,
  normalizePurchaseCode,
  purchaseCodeDigest,
  purchaseCodeRecipientFilter,
  requirePurchaseCodes,
} from "../../_shared/purchase-codes.ts";
import { activationResult } from "./device.ts";

function emailField(body: Record<string, unknown>): string {
  return stringField(body, "email", {
    min: 3,
    max: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  }).toLowerCase().trim();
}

function unavailable(): ApiError {
  return new ApiError(
    503,
    "activation_unavailable",
    "Activation is temporarily unavailable.",
    true,
  );
}

// One generic answer for unknown, malformed, used, revoked, refunded,
// wrong-product, wrong-environment, live-gated and non-allowlisted codes.
export function invalidPurchaseCode(): ApiError {
  return new ApiError(
    400,
    "invalid_purchase_code",
    "This activation code is not valid. Check the code from your purchase email.",
  );
}

export async function requestPurchaseCode(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
) {
  requirePurchaseCodes(config);
  const body = await readJson(request, 1024);
  exactKeys(body, ["email"]);
  const email = emailField(body);
  const emailKey = await privateRateLimitKey(
    config,
    "purchase_code_request",
    email,
  );
  await Promise.all([
    consumeRateLimit(client, {
      bucket: "purchase_code_request.ip",
      limit: 5,
      windowSeconds: 900,
    }, trustedIpHmac(request)),
    consumeRateLimit(client, {
      bucket: "purchase_code_request.email",
      limit: 3,
      windowSeconds: 900,
    }, emailKey),
  ]);
  if (allowedActivationEmail(config, email)) {
    // Queues a rotation only for an eligible purchase whose code is unused.
    const { error } = await client.rpc("commerce_request_purchase_code_email", {
      p_environment: config.stripeEnvironment,
      p_email: email,
    });
    if (error) throw unavailable();
  }
  // Do not disclose whether this email owns a purchase or is allowed.
  return { accepted: true };
}

export async function redeemPurchaseCode(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
  challengeIdValue: string,
): Promise<Record<string, unknown>> {
  requirePurchaseCodes(config);
  const challengeId = uuidPath(challengeIdValue);
  const bearer = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!bearer?.[1]) {
    throw new ApiError(
      401,
      "invalid_token",
      "Activation credential is invalid.",
    );
  }
  const pollHash = await sha256Hex(bearer[1]);
  await Promise.all([
    consumeRateLimit(client, {
      bucket: "purchase_code_redeem.ip",
      limit: 20,
      windowSeconds: 900,
    }, trustedIpHmac(request)),
    consumeRateLimit(client, {
      bucket: "purchase_code_redeem.challenge",
      limit: 10,
      windowSeconds: 900,
    }, pollHash),
  ]);
  const body = await readJson(request, 1024);
  exactKeys(body, ["code"]);
  if (typeof body.code !== "string") {
    throw new ApiError(400, "invalid_request", "Field code is invalid.");
  }
  const normalized = normalizePurchaseCode(body.code);
  if (!normalized) throw invalidPurchaseCode();
  // Atomic: locks the challenge, the code row and its paid entitlement,
  // enforces the device limit, consumes the code and binds it to this
  // challenge. It never starts a trial or rebinds an active device key.
  const { data, error } = await client.rpc("commerce_redeem_purchase_code", {
    p_environment: config.stripeEnvironment,
    p_challenge_id: challengeId,
    p_poll_token_sha256: pollHash,
    p_code_sha256: await purchaseCodeDigest(config, normalized),
    p_allowed_emails: purchaseCodeRecipientFilter(config),
  });
  if (error || !Array.isArray(data) || data.length !== 1) throw unavailable();
  const row = data[0] as Record<string, unknown>;
  switch (row.outcome) {
    case "invalid_code":
      throw invalidPurchaseCode();
    case "device_key_conflict":
      throw new ApiError(
        409,
        "device_key_conflict",
        "This Mac is already activated with a different device key.",
      );
    case "already_activated":
      throw new ApiError(
        409,
        "already_activated",
        "This Mac is already activated with another Gesture Flow purchase.",
      );
    case "challenge_used":
      throw new ApiError(
        401,
        "invalid_token",
        "Activation credential is invalid.",
      );
  }
  return await activationResult(config, client, row);
}
