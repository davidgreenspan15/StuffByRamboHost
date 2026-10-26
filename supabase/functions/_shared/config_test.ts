import {
  loadConfig,
  validateCheckoutRedirectUrl,
  validatePermitJwks,
} from "./config.ts";

function assert(
  condition: unknown,
  message = "assertion_failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(run: () => unknown): void {
  try {
    run();
  } catch {
    return;
  }
  throw new Error("expected_error");
}

function assertThrowsMessage(run: () => unknown, expected: string): void {
  try {
    run();
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message === expected, `unexpected_error:${error.message}`);
    return;
  }
  throw new Error("expected_error");
}

function withEnvironment(
  values: Record<string, string>,
  run: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

const privateJwk: JsonWebKey & { kid: string } = {
  kty: "OKP",
  crv: "Ed25519",
  alg: "EdDSA",
  use: "sig",
  kid: "permit-key-2026-01",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
};
const publicJwk: JsonWebKey & { kid: string } = {
  kty: "OKP",
  crv: "Ed25519",
  alg: "EdDSA",
  use: "sig",
  kid: "permit-key-2026-01",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};
const TEST_SUPABASE_PROJECT_REF = "rilxmoeezbmpvmcfkyko";

function completeEnvironment(environment: "test" | "live") {
  return {
    EXPECTED_SUPABASE_PROJECT_REF: TEST_SUPABASE_PROJECT_REF,
    SUPABASE_URL: `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co`,
    SUPABASE_ANON_KEY: "synthetic-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key",
    STRIPE_ENVIRONMENT: environment,
    STRIPE_SECRET_KEY: "synthetic-stripe-key",
    STRIPE_WEBHOOK_SECRET: "synthetic-webhook-secret",
    STRIPE_API_VERSION: "2026-02-25.clover",
    STRIPE_MANAGED_PAYMENTS_ENABLED: "false",
    STRIPE_MANAGED_PAYMENTS_TERMS_ACCEPTED: "false",
    STRIPE_MANAGED_PAYMENTS_ELIGIBLE_TAX_CODES: "",
    STRIPE_AUTOMATIC_TAX_ENABLED: "false",
    STRIPE_STANDARD_US_ONLY_ACKNOWLEDGED: "false",
    STRIPE_STANDARD_TAX_CONFIGURATION_REVIEWED: "false",
    SITE_ORIGIN: "https://stuffbyrambo.com",
    ALLOWED_SITE_ORIGINS:
      "https://stuffbyrambo.com,https://www.stuffbyrambo.com",
    LICENSE_ORIGIN: "https://licenses.stuffbyrambo.com",
    CHECKOUT_SUCCESS_URL:
      "https://stuffbyrambo.com/gesture-flow/success.html?session_id={CHECKOUT_SESSION_ID}",
    CHECKOUT_CANCEL_URL: "https://stuffbyrambo.com/gesture-flow/canceled.html",
    ACTIVATION_CODE_HMAC_SECRET: "a".repeat(32),
    CONTEXT_HMAC_SECRET: "b".repeat(32),
    COMMERCE_CRON_SECRET: "c".repeat(32),
    UPSTREAM_PROXY_SECRET: "d".repeat(32),
    ALLOW_LOCAL_DIRECT_REQUESTS: "false",
    PERMIT_SIGNING_KEY_ID: privateJwk.kid,
    PERMIT_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    PERMIT_SIGNING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
  };
}

Deno.test("Supabase credentials stay pinned to the configured project origin", () => {
  const environment = completeEnvironment("test");
  withEnvironment(environment, () => {
    assert(
      loadConfig().supabaseUrl ===
        `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co`,
    );

    for (
      const invalidUrl of [
        `http://${TEST_SUPABASE_PROJECT_REF}.supabase.co`,
        "https://attacker.example",
        `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co.attacker.example`,
        "https://abcdefghijklmnopqrst.supabase.co",
        `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co:8443`,
        `https://user:password@${TEST_SUPABASE_PROJECT_REF}.supabase.co`,
        `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co/functions/v1/commerce-api`,
        `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co?redirect=attacker`,
        `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co#attacker`,
      ]
    ) {
      Deno.env.set("SUPABASE_URL", invalidUrl);
      assertThrowsMessage(
        () => loadConfig(),
        "invalid_supabase_project_environment:SUPABASE_URL",
      );
    }

    Deno.env.set(
      "SUPABASE_URL",
      `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co`,
    );
    Deno.env.set("EXPECTED_SUPABASE_PROJECT_REF", "project-ref");
    assertThrowsMessage(
      () => loadConfig(),
      "invalid_environment:EXPECTED_SUPABASE_PROJECT_REF",
    );
  });
});

Deno.test("permit configuration requires a matching Ed25519 key pair without public secrets", () => {
  validatePermitJwks(privateJwk, { keys: [publicJwk] }, "permit-key-2026-01");
  const publicWithoutKid = { ...publicJwk } as JsonWebKey & { kid?: string };
  delete publicWithoutKid.kid;

  assertThrows(() =>
    validatePermitJwks(
      { ...privateJwk, crv: "P-256" },
      { keys: [publicJwk] },
      "permit-key-2026-01",
    )
  );
  assertThrows(() =>
    validatePermitJwks(
      privateJwk,
      {
        keys: [{
          ...publicJwk,
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }],
      },
      "permit-key-2026-01",
    )
  );
  assertThrows(() =>
    validatePermitJwks(
      privateJwk,
      { keys: [{ ...publicJwk, d: privateJwk.d }] },
      "permit-key-2026-01",
    )
  );
  assertThrows(() =>
    validatePermitJwks(
      privateJwk,
      { keys: [publicWithoutKid] },
      "permit-key-2026-01",
    )
  );
  assertThrows(() =>
    validatePermitJwks(
      privateJwk,
      { keys: [publicJwk, { ...publicJwk }] },
      "permit-key-2026-01",
    )
  );
});

Deno.test("checkout redirects stay first-party and preserve the Stripe session placeholder", () => {
  const allowed = ["https://stuffbyrambo.com", "https://www.stuffbyrambo.com"];
  assert(
    validateCheckoutRedirectUrl(
      "CHECKOUT_SUCCESS_URL",
      "https://stuffbyrambo.com/gesture-flow/success.html?session_id={CHECKOUT_SESSION_ID}",
      allowed,
      false,
      true,
    ).startsWith("https://stuffbyrambo.com/"),
  );
  for (
    const invalid of [
      "https://evil.example/success?session_id={CHECKOUT_SESSION_ID}",
      "https://user:password@stuffbyrambo.com/success?session_id={CHECKOUT_SESSION_ID}",
      "https://stuffbyrambo.com:8443/success?session_id={CHECKOUT_SESSION_ID}",
      "https://stuffbyrambo.com/success",
    ]
  ) {
    assertThrows(() =>
      validateCheckoutRedirectUrl(
        "CHECKOUT_SUCCESS_URL",
        invalid,
        allowed,
        false,
        true,
      )
    );
  }
});

Deno.test("incomplete Standard acknowledgements allow test boot but block live boot", () => {
  const environment = completeEnvironment("test");
  withEnvironment(environment, () => {
    const testConfig = loadConfig();
    assert(testConfig.stripeEnvironment === "test");
    assert(!testConfig.stripeStandardUsOnlyAcknowledged);
    assert(!testConfig.stripeStandardTaxConfigurationReviewed);

    Deno.env.set("STRIPE_ENVIRONMENT", "live");
    assertThrowsMessage(
      () => loadConfig(),
      "standard_stripe_requires_us_only_and_tax_review_acknowledgements",
    );

    Deno.env.set("STRIPE_STANDARD_US_ONLY_ACKNOWLEDGED", "true");
    Deno.env.set("STRIPE_STANDARD_TAX_CONFIGURATION_REVIEWED", "true");
    assert(loadConfig().stripeEnvironment === "live");
  });
});

Deno.test("live purchase codes default off and require live Stripe and a sender", () => {
  const live = {
    ...completeEnvironment("live"),
    STRIPE_STANDARD_US_ONLY_ACKNOWLEDGED: "true",
    STRIPE_STANDARD_TAX_CONFIGURATION_REVIEWED: "true",
  };
  withEnvironment(live, () => {
    const off = loadConfig();
    assert(off.livePurchaseCodesEnabled === false);
    assert(off.livePurchaseCodeEmailSendingEnabled === false);
    assert(off.livePurchaseCodeCanaryRecipients === undefined);
  });
  withEnvironment(
    { ...live, LIVE_PURCHASE_CODE_EMAIL_SENDING_ENABLED: "true" },
    () =>
      assertThrowsMessage(
        () => loadConfig(),
        "live_purchase_codes_require_live_environment",
      ),
  );
  withEnvironment({
    ...live,
    LIVE_PURCHASE_CODES_ENABLED: "true",
    LIVE_PURCHASE_CODE_EMAIL_SENDING_ENABLED: "true",
  }, () =>
    assertThrowsMessage(
      () => loadConfig(),
      "live_purchase_code_sending_requires_sender_and_key",
    ));
  withEnvironment({
    ...live,
    LIVE_PURCHASE_CODES_ENABLED: "true",
    LIVE_PURCHASE_CODE_EMAIL_SENDING_ENABLED: "true",
    PRIVATE_ACTIVATION_EMAIL_FROM: "Gesture Flow <licenses@example.test>",
    RESEND_API_KEY: "synthetic-resend-key",
    LIVE_PURCHASE_CODE_CANARY_RECIPIENTS: '["Buyer@Example.test"]',
  }, () => {
    const on = loadConfig();
    assert(
      on.livePurchaseCodesEnabled && on.livePurchaseCodeEmailSendingEnabled,
    );
    assert(on.livePurchaseCodeCanaryRecipients?.[0] === "buyer@example.test");
  });
  withEnvironment({
    ...live,
    LIVE_PURCHASE_CODES_ENABLED: "true",
    LIVE_PURCHASE_CODE_CANARY_RECIPIENTS: "[]",
  }, () =>
    assertThrowsMessage(
      () => loadConfig(),
      "invalid_live_purchase_code_canary_recipients",
    ));
  withEnvironment({
    ...live,
    LIVE_PURCHASE_CODE_CANARY_RECIPIENTS: '["buyer@example.test"]',
  }, () =>
    assertThrowsMessage(
      () => loadConfig(),
      "live_purchase_code_canary_requires_live_codes",
    ));
  // Live flags are rejected in test; private sandbox flags stay rejected in live.
  withEnvironment(
    { ...completeEnvironment("test"), LIVE_PURCHASE_CODES_ENABLED: "true" },
    () =>
      assertThrowsMessage(
        () => loadConfig(),
        "live_purchase_codes_require_live_environment",
      ),
  );
  withEnvironment({
    ...live,
    PRIVATE_PURCHASE_CODES_ENABLED: "true",
    PRIVATE_ACTIVATION_RECIPIENTS: '["buyer@example.test"]',
  }, () =>
    assertThrowsMessage(
      () => loadConfig(),
      "private_activation_requires_test_environment_and_recipients",
    ));
});
