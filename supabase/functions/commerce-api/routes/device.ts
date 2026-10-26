import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import {
  type VerifiedDevice,
  verifyDeviceRequest,
} from "../../_shared/device-auth.ts";
import { ApiError, readJson } from "../../_shared/http.ts";
import {
  issuePermit,
  issueRevocation,
  issueTimeAssertion,
  publicJwks,
} from "../../_shared/permits.ts";
import {
  hmacSha256Hex,
  randomActivationCode,
  randomBase64Url,
  sha256Hex,
} from "../../_shared/pure.ts";
import {
  consumeRateLimit,
  privateRateLimitKey,
  trustedIpHmac,
} from "../../_shared/rate-limit.ts";
import {
  exactKeys,
  objectField,
  optionalObjectField,
  stringField,
  uuidField,
  uuidPath,
} from "../../_shared/validation.ts";

const CHALLENGE_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;

function requiredLiteral(
  body: Record<string, unknown>,
  key: string,
  value: string | number,
): void {
  if (body[key] !== value) {
    throw new ApiError(
      400,
      "unsupported_client",
      "This Gesture Flow build is not supported.",
    );
  }
}

export async function createActivationChallenge(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<Record<string, unknown>> {
  await consumeRateLimit(
    client,
    { bucket: "activation_challenge.ip", limit: 10, windowSeconds: 600 },
    trustedIpHmac(request),
  );
  const body = await readJson(request, 8192);
  exactKeys(body, [
    "bundleId",
    "product",
    "edition",
    "majorVersion",
    "installationId",
    "deviceName",
    "devicePublicKey",
    "deviceKeyAlgorithm",
    "appVersion",
    "platform",
    "legacyMigration",
  ]);
  requiredLiteral(body, "bundleId", "stuffbyrambo.GestureControlPython");
  requiredLiteral(body, "product", "gesture-flow");
  requiredLiteral(body, "edition", "python-mediapipe");
  requiredLiteral(body, "majorVersion", 3);
  requiredLiteral(body, "deviceKeyAlgorithm", "Ed25519");
  const installationId = uuidField(body, "installationId");
  const deviceName = stringField(body, "deviceName", { min: 1, max: 80 });
  const devicePublicKey = stringField(body, "devicePublicKey", {
    min: 43,
    max: 43,
    pattern: /^[A-Za-z0-9_-]{43}$/,
  });
  const appVersion = stringField(body, "appVersion", {
    min: 1,
    max: 40,
    pattern: /^[A-Za-z0-9._+-]+$/,
  });
  const platform = objectField(body, "platform");
  exactKeys(platform, ["name", "version", "architecture"]);
  requiredLiteral(platform, "name", "macOS");
  const platformVersion = stringField(platform, "version", { min: 1, max: 50 });
  const architecture = stringField(platform, "architecture", {
    min: 1,
    max: 30,
  });
  const legacy = optionalObjectField(body, "legacyMigration");
  let legacyMigration: Record<string, unknown> | null = null;
  if (legacy) {
    exactKeys(legacy, ["trialStartedAt", "legacyLicenseDetected"]);
    if (typeof legacy.legacyLicenseDetected !== "boolean") {
      throw new ApiError(
        400,
        "invalid_request",
        "Legacy migration metadata is invalid.",
      );
    }
    const trialStartedAt = legacy.trialStartedAt;
    if (
      trialStartedAt !== null && trialStartedAt !== undefined &&
      typeof trialStartedAt !== "string"
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Legacy migration metadata is invalid.",
      );
    }
    // This is retained only as untrusted migration telemetry. The approval RPC
    // never reads it when choosing a purchase or enforcing the one-time trial.
    legacyMigration = {
      legacyLicenseDetected: legacy.legacyLicenseDetected,
      ...(typeof trialStartedAt === "string"
        ? { trialStartedAtHint: trialStartedAt.slice(0, 100) }
        : {}),
    };
  }

  const pollToken = randomBase64Url(32);
  const pollTokenHash = await sha256Hex(pollToken);
  const expiresAt = new Date(Date.now() + CHALLENGE_SECONDS * 1000);
  let userCode = "";
  let challengeId = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    userCode = randomActivationCode();
    const { data, error } = await client
      .from("commerce_device_activation_challenges")
      .insert({
        product_slug: "gesture-flow",
        edition: "python-mediapipe",
        licensed_major: 3,
        installation_id: installationId,
        device_public_key: devicePublicKey,
        device_metadata: {
          deviceName,
          appVersion,
          platform: { name: "macOS", version: platformVersion, architecture },
        },
        legacy_migration: legacyMigration,
        code_hmac: await hmacSha256Hex(
          config.activationCodeHmacSecret,
          userCode,
        ),
        poll_token_sha256: pollTokenHash,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single();
    if (!error && data) {
      challengeId = data.id;
      break;
    }
    if (attempt === 4) {
      throw new ApiError(
        503,
        "activation_unavailable",
        "Activation request could not be created.",
        true,
      );
    }
  }
  const verificationUri = `${config.siteOrigin}/license/`;
  return {
    challengeId,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${
      encodeURIComponent(userCode)
    }`,
    pollToken,
    expiresIn: CHALLENGE_SECONDS,
    interval: POLL_INTERVAL_SECONDS,
  };
}

export async function exchangeActivation(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
  challengeIdValue: string,
): Promise<Record<string, unknown>> {
  const challengeId = uuidPath(challengeIdValue);
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(authorization);
  if (!match?.[1]) {
    throw new ApiError(
      401,
      "invalid_token",
      "Activation credential is invalid.",
    );
  }
  const pollToken = match[1];
  const pollTokenHash = await sha256Hex(pollToken);
  await Promise.all([
    consumeRateLimit(
      client,
      { bucket: "activation_exchange.ip", limit: 140, windowSeconds: 600 },
      trustedIpHmac(request),
    ),
    consumeRateLimit(
      client,
      { bucket: "activation_exchange.token", limit: 140, windowSeconds: 600 },
      pollTokenHash,
    ),
  ]);
  const body = await readJson(request, 1024);
  exactKeys(body, []);
  const { data, error } = await client.rpc("commerce_exchange_activation", {
    p_challenge_id: challengeId,
    p_poll_token_sha256: pollTokenHash,
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new ApiError(
      503,
      "activation_unavailable",
      "Activation could not be completed.",
      true,
    );
  }
  return await activationResult(
    config,
    client,
    data[0] as Record<string, unknown>,
  );
}

// Maps an exchange-shaped RPC row to the public activation contract. Shared by
// the browser-approval exchange and purchase-code redemption.
export async function activationResult(
  config: CommerceConfig,
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (row.outcome) {
    case "pending":
      throw new ApiError(
        400,
        "authorization_pending",
        "Approve this Mac in your browser, then try again.",
        true,
        {
          retryAfter: POLL_INTERVAL_SECONDS,
        },
      );
    case "expired":
      throw new ApiError(
        400,
        "expired_token",
        "This activation request expired. Start again.",
      );
    case "device_limit":
      throw new ApiError(
        403,
        "device_limit_reached",
        "This license is already active on its maximum number of Macs.",
      );
    case "entitlement_inactive":
      throw new ApiError(
        403,
        "license_suspended",
        "This license is not currently active.",
      );
    case "active":
      break;
    default:
      throw new ApiError(
        401,
        "invalid_token",
        "Activation credential is invalid.",
      );
  }
  const activationId = String(row.activation_id);
  const permit = await issuePermit(config, client, {
    activationId,
    installationId: String(row.installation_id),
    accountId: typeof row.account_id === "string" ? row.account_id : null,
    entitlementId: String(row.entitlement_id),
    entitlementSource: String(row.entitlement_source) as
      | "purchase"
      | "trial"
      | "admin",
    features: Array.isArray(row.features)
      ? row.features.filter((item): item is string => typeof item === "string")
      : [],
    deviceLimit: Number(row.device_limit),
    entitlementExpiresAt: typeof row.entitlement_expires_at === "string"
      ? row.entitlement_expires_at
      : null,
  });
  return {
    activationId,
    permit: permit.permit,
    permitExpiresAt: new Date(permit.expiresAt * 1000).toISOString(),
  };
}

function revocationReason(device: VerifiedDevice): string {
  if (device.activation.status !== "active") return "device_deactivated";
  switch (device.entitlement.status) {
    case "suspended_refund":
      return "refund_pending";
    case "suspended_dispute":
      return "dispute_open";
    case "refunded":
      return "refunded";
    case "revoked_chargeback":
      return "chargeback_lost";
    case "revoked_admin":
      return "admin_revoked";
    default:
      return device.entitlement.source === "trial"
        ? "trial_expired"
        : "entitlement_inactive";
  }
}

async function inactiveLicenseError(
  config: CommerceConfig,
  device: VerifiedDevice,
  permitJti: string,
): Promise<ApiError> {
  const reason = revocationReason(device);
  const details = {
    revocation: await issueRevocation(config, {
      activationId: device.activation.id,
      installationId: device.activation.installation_id,
      permitJti,
      reason,
    }),
  };
  const suspended = reason === "refund_pending" || reason === "dispute_open";
  return new ApiError(
    403,
    suspended ? "license_suspended" : "license_revoked",
    suspended
      ? "This license is temporarily suspended."
      : "This license is no longer active.",
    false,
    details,
  );
}

export async function refreshDevice(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
  publicPath: string,
): Promise<Record<string, unknown>> {
  await consumeRateLimit(
    client,
    { bucket: "device_refresh.ip", limit: 120, windowSeconds: 600 },
    trustedIpHmac(request),
  );
  const rawBody = await request.text();
  let permitJti: string;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1
    ) throw new Error();
    permitJti = uuidField(parsed as Record<string, unknown>, "permitJti");
    if (rawBody !== JSON.stringify({ permitJti })) throw new Error();
  } catch {
    throw new ApiError(
      400,
      "invalid_request",
      "Device refresh body is invalid.",
    );
  }
  const device = await verifyDeviceRequest(
    client,
    request,
    publicPath,
    rawBody,
  );
  const { data: presentedPermit, error: permitError } = await client
    .from("commerce_permit_issuances")
    .select("jti")
    .eq("jti", permitJti)
    .eq("activation_id", device.activation.id)
    .maybeSingle();
  if (permitError || !presentedPermit) {
    throw new ApiError(
      401,
      "invalid_device_permit",
      "Current device permit is invalid.",
    );
  }
  await consumeRateLimit(
    client,
    { bucket: "device_refresh.activation", limit: 120, windowSeconds: 600 },
    await privateRateLimitKey(config, "activation", device.activation.id),
  );
  const entitlementExpired = device.entitlement.expires_at &&
    new Date(device.entitlement.expires_at) <= new Date();
  if (
    device.activation.status !== "active" ||
    device.entitlement.status !== "active" ||
    entitlementExpired || device.entitlement.product_slug !== "gesture-flow" ||
    device.entitlement.edition !== "python-mediapipe" ||
    device.entitlement.licensed_major !== 3
  ) {
    throw await inactiveLicenseError(config, device, permitJti);
  }
  const permit = await issuePermit(config, client, {
    activationId: device.activation.id,
    installationId: device.activation.installation_id,
    accountId: device.activation.account_id,
    entitlementId: device.entitlement.id,
    entitlementSource: device.entitlement.source,
    features: device.entitlement.features,
    deviceLimit: device.entitlement.device_limit,
    entitlementExpiresAt: device.entitlement.expires_at,
  });
  return {
    activationId: device.activation.id,
    permit: permit.permit,
    permitExpiresAt: new Date(permit.expiresAt * 1000).toISOString(),
  };
}

export async function deactivateCurrentDevice(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
  publicPath: string,
): Promise<Record<string, unknown>> {
  await consumeRateLimit(
    client,
    { bucket: "device_deactivate.ip", limit: 30, windowSeconds: 600 },
    trustedIpHmac(request),
  );
  const rawBody = await request.text();
  if (rawBody !== "{}") {
    throw new ApiError(
      400,
      "invalid_request",
      "Device request body is invalid.",
    );
  }
  const device = await verifyDeviceRequest(
    client,
    request,
    publicPath,
    rawBody,
  );
  await consumeRateLimit(
    client,
    { bucket: "device_deactivate.activation", limit: 10, windowSeconds: 600 },
    await privateRateLimitKey(config, "activation", device.activation.id),
  );
  const { data, error } = await client.rpc("commerce_deactivate_activation", {
    p_activation_id: device.activation.id,
    p_account_id: null,
    p_actor_type: "device",
    p_reason: "device_self_deactivation",
  });
  if (error || data !== true) {
    throw new ApiError(
      409,
      "device_deactivated",
      "This Mac is already deactivated.",
    );
  }
  return { deactivated: true };
}

export async function signedTime(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
  nonce: string,
): Promise<Record<string, unknown>> {
  await consumeRateLimit(
    client,
    { bucket: "signed_time.ip", limit: 60, windowSeconds: 600 },
    trustedIpHmac(request),
  );
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) {
    throw new ApiError(400, "invalid_nonce", "Signed-time nonce is invalid.");
  }
  try {
    return { assertion: await issueTimeAssertion(config, nonce) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_nonce", "Signed-time nonce is invalid.");
  }
}

export function licenseKeys(config: CommerceConfig): Record<string, unknown> {
  return publicJwks(config);
}
