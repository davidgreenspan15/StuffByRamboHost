import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./http.ts";
import {
  base64UrlDecode,
  bufferSource,
  canonicalDeviceProof,
  sha256Hex,
  utf8,
} from "./pure.ts";
import { uuidPath } from "./validation.ts";

export interface VerifiedDevice {
  activation: {
    id: string;
    account_id: string | null;
    entitlement_id: string;
    installation_id: string;
    device_public_key: string;
    status: string;
  };
  entitlement: {
    id: string;
    source: "purchase" | "trial" | "admin";
    status: string;
    product_slug: string;
    edition: string;
    licensed_major: number;
    device_limit: number;
    features: string[];
    valid_from: string;
    expires_at: string | null;
  };
}

function activationIdFromAuthorization(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = /^GestureFlow-Device ([0-9a-f-]{36})$/i.exec(value);
  if (!match?.[1]) {
    throw new ApiError(
      401,
      "device_authentication_required",
      "Device authentication is required.",
    );
  }
  return uuidPath(match[1]);
}

export async function verifyDeviceRequest(
  client: SupabaseClient,
  request: Request,
  publicPath: string,
  rawBody: string,
): Promise<VerifiedDevice> {
  const activationId = activationIdFromAuthorization(request);
  const timestampValue = request.headers.get("x-gf-timestamp") ?? "";
  const nonce = request.headers.get("x-gf-nonce") ?? "";
  const signatureValue = request.headers.get("x-gf-signature") ?? "";
  if (!/^\d{10}$/.test(timestampValue)) {
    throw new ApiError(
      401,
      "invalid_device_signature",
      "Device signature is invalid.",
    );
  }
  const timestamp = Number(timestampValue);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    throw new ApiError(
      401,
      "device_clock_out_of_range",
      "Device time could not be verified.",
    );
  }
  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = base64UrlDecode(signatureValue);
    if (signature.length !== 64) throw new Error();
    const nonceBytes = base64UrlDecode(nonce);
    if (nonceBytes.length < 16 || nonceBytes.length > 64) throw new Error();
  } catch {
    throw new ApiError(
      401,
      "invalid_device_signature",
      "Device signature is invalid.",
    );
  }

  const { data: activation, error: activationError } = await client
    .from("commerce_device_activations")
    .select(
      "id,account_id,entitlement_id,installation_id,device_public_key,status",
    )
    .eq("id", activationId)
    .maybeSingle();
  if (activationError || !activation) {
    throw new ApiError(
      401,
      "invalid_device_signature",
      "Device signature is invalid.",
    );
  }
  try {
    publicKey = base64UrlDecode(String(activation.device_public_key));
    if (publicKey.length !== 32) throw new Error();
  } catch {
    throw new ApiError(
      401,
      "invalid_device_signature",
      "Device signature is invalid.",
    );
  }
  const canonical = await canonicalDeviceProof(
    request.method,
    publicPath,
    timestamp,
    nonce,
    rawBody,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bufferSource(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    bufferSource(signature),
    bufferSource(utf8(canonical)),
  );
  if (!valid) {
    throw new ApiError(
      401,
      "invalid_device_signature",
      "Device signature is invalid.",
    );
  }

  const nonceHash = await sha256Hex(nonce);
  const { error: nonceError } = await client.from(
    "commerce_device_request_nonces",
  ).insert({
    activation_id: activation.id,
    nonce_sha256: nonceHash,
    request_timestamp: new Date(timestamp * 1000).toISOString(),
    expires_at: new Date((timestamp + 600) * 1000).toISOString(),
  });
  if (nonceError) {
    throw new ApiError(
      409,
      "device_request_replayed",
      "This device request was already used.",
    );
  }

  const { data: entitlement, error: entitlementError } = await client
    .from("commerce_entitlements")
    .select(
      "id,source,status,product_slug,edition,licensed_major,device_limit,features,valid_from,expires_at",
    )
    .eq("id", activation.entitlement_id)
    .maybeSingle();
  if (entitlementError || !entitlement) {
    throw new ApiError(
      403,
      "license_revoked",
      "This license is no longer active.",
    );
  }

  await client.from("commerce_device_activations").update({
    last_seen_at: new Date().toISOString(),
  }).eq("id", activation.id);

  return {
    activation: activation as VerifiedDevice["activation"],
    entitlement: entitlement as VerifiedDevice["entitlement"],
  };
}
