import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "./config.ts";
import {
  buildPermitClaims,
  buildRevocationClaims,
  buildTimeClaims,
  sha256Hex,
  signCompactJws,
} from "./pure.ts";
import { ApiError } from "./http.ts";

export interface ActiveLicenseRecord {
  activationId: string;
  installationId: string;
  // Null for a purchase-code activation whose buyer has not signed in yet.
  accountId: string | null;
  entitlementId: string;
  entitlementSource: "purchase" | "trial" | "admin";
  features: string[];
  deviceLimit: number;
  entitlementExpiresAt?: string | null;
}

export async function issuePermit(
  config: CommerceConfig,
  client: SupabaseClient,
  record: ActiveLicenseRecord,
): Promise<{ permit: string; jti: string; expiresAt: number }> {
  const jti = crypto.randomUUID();
  const entitlementExpiresAt = record.entitlementExpiresAt
    ? Math.floor(new Date(record.entitlementExpiresAt).getTime() / 1000)
    : undefined;
  const claims = buildPermitClaims({
    entitlementId: record.entitlementId,
    jti,
    activationId: record.activationId,
    installationId: record.installationId,
    features: [...new Set(record.features)].sort(),
    entitlementType: record.entitlementSource === "trial"
      ? "trial"
      : "purchase",
    deviceLimit: record.deviceLimit,
    entitlementExpiresAt,
  });
  const permit = await signCompactJws(
    "GF-PERMIT",
    config.permitKeyId,
    claims,
    config.permitPrivateJwk,
  );
  const { error } = await client.from("commerce_permit_issuances").insert({
    jti,
    activation_id: record.activationId,
    entitlement_id: record.entitlementId,
    permit_sha256: await sha256Hex(permit),
    key_id: config.permitKeyId,
    issued_at: new Date(claims.iat * 1000).toISOString(),
    expires_at: new Date(claims.exp * 1000).toISOString(),
  });
  if (error) {
    throw new ApiError(
      503,
      "permit_persistence_failed",
      "License permit could not be issued.",
      true,
    );
  }
  return { permit, jti, expiresAt: claims.exp };
}

export async function issueRevocation(
  config: CommerceConfig,
  input: {
    activationId: string;
    installationId: string;
    permitJti: string;
    reason: string;
  },
): Promise<string> {
  const claims = buildRevocationClaims({
    jti: crypto.randomUUID(),
    ...input,
  });
  return await signCompactJws(
    "GF-REVOCATION",
    config.permitKeyId,
    claims,
    config.permitPrivateJwk,
  );
}

export async function issueTimeAssertion(
  config: CommerceConfig,
  nonce: string,
): Promise<string> {
  return await signCompactJws(
    "GF-TIME",
    config.permitKeyId,
    buildTimeClaims(nonce),
    config.permitPrivateJwk,
  );
}

export function publicJwks(config: CommerceConfig): { keys: JsonWebKey[] } {
  return {
    keys: config.permitPublicJwks.keys.map((key) => {
      const source = key as JsonWebKey & {
        kid?: string;
        use?: string;
        alg?: string;
        d?: string;
      };
      return {
        kty: source.kty,
        crv: source.crv,
        x: source.x,
        kid: source.kid,
        use: source.use ?? "sig",
        alg: source.alg ?? "EdDSA",
      } as JsonWebKey;
    }),
  };
}
