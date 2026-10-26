import vector from "../../../docs/commerce/device-proof-golden-vector.json" with {
  type: "json",
};
import {
  base64UrlEncode,
  bufferSource,
  buildPermitClaims,
  buildRevocationClaims,
  canonicalDeviceProof,
  entitlementState,
  hexDecode,
  hmacSha256Hex,
  MAX_PERMIT_SECONDS,
  normalizeActivationCode,
  parseStripeSignature,
  sha256Hex,
  signCompactJws,
  utf8,
  verifyCompactJws,
  verifyStripeSignature,
} from "./pure.ts";

function assert(
  condition: unknown,
  message = "assertion_failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const privateJwk = {
  kty: "OKP",
  crv: "Ed25519",
  d: base64UrlEncode(hexDecode(vector.privateKeySeedHex)),
  x: base64UrlEncode(hexDecode(vector.publicKeyRawHex)),
  kid: "gf-test-1",
  alg: "EdDSA",
  use: "sig",
} as JsonWebKey;

const publicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: base64UrlEncode(hexDecode(vector.publicKeyRawHex)),
  kid: "gf-test-1",
  alg: "EdDSA",
  use: "sig",
} as JsonWebKey;

Deno.test("device proof matches the cross-client golden vector", async () => {
  assertEquals(await sha256Hex(vector.bodyUtf8), vector.bodySha256);
  assertEquals(
    await canonicalDeviceProof(
      vector.method,
      vector.path,
      vector.timestamp,
      vector.nonce,
      vector.bodyUtf8,
    ),
    vector.canonicalUtf8,
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      key,
      bufferSource(utf8(vector.canonicalUtf8)),
    ),
  );
  assertEquals(base64UrlEncode(signature), vector.signatureBase64Url);
});

Deno.test("strict EdDSA permit can be verified and detects tampering", async () => {
  const claims = buildPermitClaims({
    entitlementId: "10000000-0000-4000-8000-000000000001",
    jti: "20000000-0000-4000-8000-000000000002",
    activationId: "30000000-0000-4000-8000-000000000003",
    installationId: "40000000-0000-4000-8000-000000000004",
    features: ["gesture-control"],
    entitlementType: "purchase",
    deviceLimit: 2,
    nowSeconds: 1_783_944_000,
  });
  const token = await signCompactJws(
    "GF-PERMIT",
    "gf-test-1",
    claims,
    privateJwk,
  );
  const verified = await verifyCompactJws(token, "GF-PERMIT", publicJwk);
  assertEquals(verified.payload, claims);
  assertEquals(verified.payload.sub, "10000000-0000-4000-8000-000000000001");
  assert(
    Number(verified.payload.exp) - Number(verified.payload.iat) <=
      MAX_PERMIT_SECONDS,
  );

  const segments = token.split(".");
  const signature = segments[2];
  assert(signature);
  const replacement = signature.endsWith("A") ? "B" : "A";
  const tampered = `${segments[0]}.${segments[1]}.${
    signature.slice(0, -1)
  }${replacement}`;
  await assertRejects(() => verifyCompactJws(tampered, "GF-PERMIT", publicJwk));
});

Deno.test("trial permit is clamped to the account trial expiration", () => {
  const now = 1_783_944_000;
  const claims = buildPermitClaims({
    entitlementId: "10000000-0000-4000-8000-000000000001",
    jti: "20000000-0000-4000-8000-000000000002",
    activationId: "30000000-0000-4000-8000-000000000003",
    installationId: "40000000-0000-4000-8000-000000000004",
    features: ["gesture-control"],
    entitlementType: "trial",
    entitlementExpiresAt: now + 60,
    deviceLimit: 2,
    nowSeconds: now,
  });
  assertEquals(claims.exp, now + 60);
  assertEquals(claims.entitlementExpiresAt, now + 60);
  assertEquals(claims.features, ["gesture-control"]);
});

Deno.test("revocation contains an assertion jti and current permit binding", () => {
  const claims = buildRevocationClaims({
    jti: "50000000-0000-4000-8000-000000000005",
    activationId: "30000000-0000-4000-8000-000000000003",
    installationId: "40000000-0000-4000-8000-000000000004",
    permitJti: "20000000-0000-4000-8000-000000000002",
    reason: "refunded",
    nowSeconds: 1_783_944_000,
  });
  assertEquals(claims.jti, "50000000-0000-4000-8000-000000000005");
  assertEquals(claims.permitJti, "20000000-0000-4000-8000-000000000002");
});

Deno.test("Stripe webhook signatures are raw-body exact and time bounded", async () => {
  const payload = '{"id":"evt_123","object":"event"}';
  const secret = "whsec_unit_test_only";
  const timestamp = 1_783_944_000;
  const signature = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  const header = `t=${timestamp},v1=${signature}`;
  assertEquals(parseStripeSignature(header).timestamp, timestamp);
  await verifyStripeSignature(payload, header, secret, timestamp);
  await assertRejects(() =>
    verifyStripeSignature(`${payload} `, header, secret, timestamp)
  );
  await assertRejects(() =>
    verifyStripeSignature(payload, header, secret, timestamp + 301)
  );
});

Deno.test("refund and dispute reducer preserves partial-refund access", () => {
  assertEquals(
    entitlementState({
      adminRevoked: false,
      amountTotal: 2_900,
      successfulRefundAmount: 500,
      pendingRefundAmount: 0,
      hasOpenDispute: false,
      hasLostDispute: false,
    }),
    { order: "paid", entitlement: "active" },
  );
  assertEquals(
    entitlementState({
      adminRevoked: false,
      amountTotal: 2_900,
      successfulRefundAmount: 0,
      pendingRefundAmount: 2_900,
      hasOpenDispute: false,
      hasLostDispute: false,
    }),
    { order: "suspended_refund", entitlement: "suspended_refund" },
  );
  assertEquals(
    entitlementState({
      adminRevoked: false,
      amountTotal: 2_900,
      successfulRefundAmount: 0,
      pendingRefundAmount: 0,
      hasOpenDispute: false,
      hasLostDispute: true,
    }),
    { order: "chargeback", entitlement: "revoked_chargeback" },
  );
});

Deno.test("activation codes normalize without ambiguous characters", () => {
  assertEquals(normalizeActivationCode("abcd-2345"), "ABCD-2345");
  try {
    normalizeActivationCode("ABCI-2345");
    throw new Error("Expected ambiguous code rejection");
  } catch (error) {
    assert(error instanceof Error);
  }
});

async function assertRejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected operation to reject");
}
