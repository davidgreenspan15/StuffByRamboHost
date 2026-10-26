export type CommerceEnvironment = "test" | "live";

const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export interface CommerceConfig {
  privatePurchaseCodesEnabled?: boolean;
  privateActivationEmailSendingEnabled?: boolean;
  privateActivationRecipients?: string[];
  privateActivationEmailFrom?: string;
  // Production purchase codes. Both default false and require live Stripe.
  livePurchaseCodesEnabled?: boolean;
  livePurchaseCodeEmailSendingEnabled?: boolean;
  // Optional live canary. Undefined serves every verified live buyer.
  livePurchaseCodeCanaryRecipients?: string[];
  resendApiKey?: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripeApiVersion: string;
  stripeEnvironment: CommerceEnvironment;
  stripeManagedPayments: boolean;
  stripeManagedPaymentsTermsAccepted: boolean;
  stripeManagedPaymentsEligibleTaxCodes: string[];
  stripeAutomaticTax: boolean;
  stripeStandardUsOnlyAcknowledged: boolean;
  stripeStandardTaxConfigurationReviewed: boolean;
  siteOrigin: string;
  allowedSiteOrigins: string[];
  licenseOrigin: string;
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
  activationCodeHmacSecret: string;
  contextHmacSecret: string;
  permitPrivateJwk: JsonWebKey;
  permitPublicJwks: { keys: JsonWebKey[] };
  permitKeyId: string;
  cronSecret: string;
  upstreamProxySecret?: string;
  allowLocalDirectRequests: boolean;
}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value || undefined;
}

function booleanValue(name: string, defaultValue: boolean): boolean {
  const value = optional(name);
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid_boolean_environment:${name}`);
}

// JSON array of exact recipient emails, trimmed, lowercased and deduplicated.
function emailListValue(
  value: string,
  errorCode: string,
): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((v) =>
        typeof v !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
      )
    ) throw new Error();
    return [...new Set(parsed.map((v) => v.trim().toLowerCase()))];
  } catch {
    throw new Error(errorCode);
  }
}

function httpsUrl(name: string, value: string, allowLocalhost = false): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" &&
      !(allowLocalhost && local && url.protocol === "http:")) ||
    url.username || url.password || (!local && url.port && url.port !== "443")
  ) {
    throw new Error(`invalid_https_environment:${name}`);
  }
  return value.replace(/\/$/, "");
}

function originValue(
  name: string,
  value: string,
  allowLocalhost = false,
): string {
  const validated = httpsUrl(name, value, allowLocalhost);
  const url = new URL(validated);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (!local && url.port && url.port !== "443")
  ) {
    throw new Error(`invalid_origin_environment:${name}`);
  }
  return url.origin;
}

function supabaseProjectOrigin(
  name: string,
  value: string,
  expectedProjectRef: string,
): string {
  if (!SUPABASE_PROJECT_REF_PATTERN.test(expectedProjectRef)) {
    throw new Error("invalid_environment:EXPECTED_SUPABASE_PROJECT_REF");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid_supabase_project_environment:${name}`);
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search ||
    url.hash || (url.pathname !== "/" && url.pathname !== "") ||
    url.hostname !== `${expectedProjectRef}.supabase.co`
  ) {
    throw new Error(`invalid_supabase_project_environment:${name}`);
  }
  return url.origin;
}

function jsonValue<T>(name: string): T {
  try {
    return JSON.parse(required(name)) as T;
  } catch {
    throw new Error(`invalid_json_environment:${name}`);
  }
}

function validEd25519Coordinate(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function assertEd25519Metadata(key: JsonWebKey, name: string): void {
  if (
    key.kty !== "OKP" || key.crv !== "Ed25519" ||
    !validEd25519Coordinate(key.x) ||
    (key.alg !== undefined && key.alg !== "EdDSA") ||
    (key.use !== undefined && key.use !== "sig")
  ) {
    throw new Error(`invalid_ed25519_jwk:${name}`);
  }
}

export function validatePermitJwks(
  privateJwk: JsonWebKey,
  publicJwks: { keys: JsonWebKey[] },
  permitKeyId: string,
): void {
  if (!Array.isArray(publicJwks.keys) || publicJwks.keys.length < 1) {
    throw new Error("permit_public_jwks_empty");
  }
  assertEd25519Metadata(privateJwk, "private");
  if (!validEd25519Coordinate(privateJwk.d)) {
    throw new Error("permit_private_jwk_missing_d");
  }
  const privateWithKid = privateJwk as JsonWebKey & { kid?: string };
  if (
    privateWithKid.kid !== permitKeyId ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(permitKeyId)
  ) throw new Error("permit_key_id_mismatch");

  let selectedPublic: JsonWebKey | undefined;
  const seenKeyIds = new Set<string>();
  for (const key of publicJwks.keys) {
    assertEd25519Metadata(key, "public");
    if (key.d !== undefined) {
      throw new Error("permit_public_jwk_contains_private_material");
    }
    const keyId = (key as JsonWebKey & { kid?: string }).kid;
    if (!keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
      throw new Error("permit_public_jwk_invalid_kid");
    }
    if (seenKeyIds.has(keyId)) {
      throw new Error("permit_public_jwk_duplicate_kid");
    }
    seenKeyIds.add(keyId);
    if (keyId === permitKeyId) selectedPublic = key;
  }
  if (!selectedPublic || selectedPublic.x !== privateJwk.x) {
    throw new Error("permit_key_pair_mismatch");
  }
}

export function validateCheckoutRedirectUrl(
  name: string,
  value: string,
  allowedOrigins: string[],
  allowLocalhost: boolean,
  requireSessionPlaceholder: boolean,
): string {
  const validated = httpsUrl(name, value, allowLocalhost);
  const url = new URL(validated);
  if (
    !allowedOrigins.includes(url.origin) || url.hash ||
    (requireSessionPlaceholder &&
      url.searchParams.get("session_id") !== "{CHECKOUT_SESSION_ID}")
  ) {
    throw new Error(`invalid_checkout_redirect_environment:${name}`);
  }
  return validated;
}

export function loadConfig(): CommerceConfig {
  const expectedSupabaseProjectRef = required(
    "EXPECTED_SUPABASE_PROJECT_REF",
  );
  const supabaseUrl = supabaseProjectOrigin(
    "SUPABASE_URL",
    required("SUPABASE_URL"),
    expectedSupabaseProjectRef,
  );
  const stripeEnvironment = required("STRIPE_ENVIRONMENT");
  if (stripeEnvironment !== "test" && stripeEnvironment !== "live") {
    throw new Error("invalid_environment:STRIPE_ENVIRONMENT");
  }
  const licenseOrigin = originValue(
    "LICENSE_ORIGIN",
    optional("LICENSE_ORIGIN") ?? "https://licenses.stuffbyrambo.com",
    stripeEnvironment === "test",
  );
  const siteOrigin = originValue(
    "SITE_ORIGIN",
    optional("SITE_ORIGIN") ?? "https://stuffbyrambo.com",
    stripeEnvironment === "test",
  );
  const allowedSiteOrigins = (optional("ALLOWED_SITE_ORIGINS") ??
    "https://stuffbyrambo.com,https://www.stuffbyrambo.com")
    .split(",")
    .map((value) =>
      originValue(
        "ALLOWED_SITE_ORIGINS",
        value.trim(),
        stripeEnvironment === "test",
      )
    );
  if (!allowedSiteOrigins.includes(siteOrigin)) {
    throw new Error("SITE_ORIGIN_must_be_allowed");
  }
  const privateJwk = jsonValue<JsonWebKey>("PERMIT_SIGNING_PRIVATE_JWK");
  const publicJwks = jsonValue<{ keys: JsonWebKey[] }>(
    "PERMIT_SIGNING_PUBLIC_JWKS",
  );
  const permitKeyId = required("PERMIT_SIGNING_KEY_ID");
  validatePermitJwks(privateJwk, publicJwks, permitKeyId);
  const activationCodeHmacSecret = required("ACTIVATION_CODE_HMAC_SECRET");
  const contextHmacSecret = required("CONTEXT_HMAC_SECRET");
  const cronSecret = required("COMMERCE_CRON_SECRET");
  const upstreamProxySecret = optional("UPSTREAM_PROXY_SECRET");
  const allowLocalDirectRequests = booleanValue(
    "ALLOW_LOCAL_DIRECT_REQUESTS",
    false,
  );
  if (
    activationCodeHmacSecret.length < 32 || contextHmacSecret.length < 32 ||
    cronSecret.length < 32
  ) {
    throw new Error("commerce_secrets_must_be_at_least_32_characters");
  }
  const localLicenseHost = ["localhost", "127.0.0.1"].includes(
    new URL(licenseOrigin).hostname,
  );
  if (
    allowLocalDirectRequests &&
    (stripeEnvironment === "live" || !localLicenseHost)
  ) {
    throw new Error("local_direct_requests_forbidden");
  }
  if (
    !allowLocalDirectRequests &&
    (!upstreamProxySecret || upstreamProxySecret.length < 32)
  ) {
    throw new Error("missing_or_short_environment:UPSTREAM_PROXY_SECRET");
  }

  const stripeManagedPayments = booleanValue(
    "STRIPE_MANAGED_PAYMENTS_ENABLED",
    false,
  );
  const stripeManagedPaymentsTermsAccepted = booleanValue(
    "STRIPE_MANAGED_PAYMENTS_TERMS_ACCEPTED",
    false,
  );
  const stripeManagedPaymentsEligibleTaxCodes = (optional(
    "STRIPE_MANAGED_PAYMENTS_ELIGIBLE_TAX_CODES",
  ) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    stripeManagedPaymentsEligibleTaxCodes.some((value) =>
      !/^txcd_[0-9]{8}$/.test(value)
    ) ||
    new Set(stripeManagedPaymentsEligibleTaxCodes).size !==
      stripeManagedPaymentsEligibleTaxCodes.length
  ) {
    throw new Error("invalid_managed_payments_eligible_tax_codes");
  }
  const stripeApiVersion = required("STRIPE_API_VERSION");
  const stripeVersionDate = /^([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(
    stripeApiVersion,
  )?.[1];
  if (!stripeVersionDate || stripeVersionDate < "2025-03-31") {
    throw new Error("stripe_api_version_must_support_presentment_details");
  }
  if (stripeManagedPayments) {
    if (
      !stripeManagedPaymentsTermsAccepted ||
      stripeManagedPaymentsEligibleTaxCodes.length < 1
    ) {
      throw new Error(
        "managed_payments_requires_terms_and_compatible_api_version",
      );
    }
  }
  const stripeStandardUsOnlyAcknowledged = booleanValue(
    "STRIPE_STANDARD_US_ONLY_ACKNOWLEDGED",
    false,
  );
  const stripeStandardTaxConfigurationReviewed = booleanValue(
    "STRIPE_STANDARD_TAX_CONFIGURATION_REVIEWED",
    false,
  );
  if (
    stripeEnvironment === "live" && !stripeManagedPayments &&
    (!stripeStandardUsOnlyAcknowledged ||
      !stripeStandardTaxConfigurationReviewed)
  ) {
    throw new Error(
      "standard_stripe_requires_us_only_and_tax_review_acknowledgements",
    );
  }

  if (
    stripeEnvironment === "live" &&
    licenseOrigin !== "https://licenses.stuffbyrambo.com"
  ) {
    throw new Error("live_license_origin_must_be_canonical");
  }
  const checkoutSuccessUrl = validateCheckoutRedirectUrl(
    "CHECKOUT_SUCCESS_URL",
    optional("CHECKOUT_SUCCESS_URL") ??
      "https://stuffbyrambo.com/gesture-flow/success.html?session_id={CHECKOUT_SESSION_ID}",
    allowedSiteOrigins,
    stripeEnvironment === "test",
    true,
  );
  const checkoutCancelUrl = validateCheckoutRedirectUrl(
    "CHECKOUT_CANCEL_URL",
    optional("CHECKOUT_CANCEL_URL") ??
      "https://stuffbyrambo.com/gesture-flow/canceled.html",
    allowedSiteOrigins,
    stripeEnvironment === "test",
    false,
  );

  const privatePurchaseCodesEnabled = booleanValue(
    "PRIVATE_PURCHASE_CODES_ENABLED",
    false,
  );
  const privateActivationEmailSendingEnabled = booleanValue(
    "PRIVATE_ACTIVATION_EMAIL_SENDING_ENABLED",
    false,
  );
  const privateActivationRecipients = emailListValue(
    optional("PRIVATE_ACTIVATION_RECIPIENTS") ?? "[]",
    "invalid_private_activation_recipients",
  );
  if (
    (privatePurchaseCodesEnabled || privateActivationEmailSendingEnabled) &&
    (stripeEnvironment !== "test" || !privatePurchaseCodesEnabled ||
      !privateActivationRecipients.length)
  ) {
    throw new Error(
      "private_activation_requires_test_environment_and_recipients",
    );
  }
  const privateActivationEmailFrom = optional("PRIVATE_ACTIVATION_EMAIL_FROM");
  if (
    privateActivationEmailFrom &&
    !/^[^\r\n<>]{0,80}<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(
      privateActivationEmailFrom,
    )
  ) {
    throw new Error("invalid_environment:PRIVATE_ACTIVATION_EMAIL_FROM");
  }
  const livePurchaseCodesEnabled = booleanValue(
    "LIVE_PURCHASE_CODES_ENABLED",
    false,
  );
  const livePurchaseCodeEmailSendingEnabled = booleanValue(
    "LIVE_PURCHASE_CODE_EMAIL_SENDING_ENABLED",
    false,
  );
  const canaryValue = optional("LIVE_PURCHASE_CODE_CANARY_RECIPIENTS");
  const livePurchaseCodeCanaryRecipients = canaryValue === undefined
    ? undefined
    : emailListValue(
      canaryValue,
      "invalid_live_purchase_code_canary_recipients",
    );
  if (livePurchaseCodeCanaryRecipients && !livePurchaseCodesEnabled) {
    // A canary without live codes would be silently ignored.
    throw new Error("live_purchase_code_canary_requires_live_codes");
  }
  if (livePurchaseCodeCanaryRecipients?.length === 0) {
    // An empty canary would silently disable live codes; omit it instead.
    throw new Error("invalid_live_purchase_code_canary_recipients");
  }
  if (
    (livePurchaseCodesEnabled || livePurchaseCodeEmailSendingEnabled) &&
    (stripeEnvironment !== "live" || !livePurchaseCodesEnabled)
  ) {
    throw new Error("live_purchase_codes_require_live_environment");
  }
  if (
    livePurchaseCodeEmailSendingEnabled &&
    (!privateActivationEmailFrom || !optional("RESEND_API_KEY"))
  ) {
    throw new Error("live_purchase_code_sending_requires_sender_and_key");
  }
  return {
    livePurchaseCodesEnabled,
    livePurchaseCodeEmailSendingEnabled,
    livePurchaseCodeCanaryRecipients,
    privatePurchaseCodesEnabled,
    privateActivationEmailFrom,
    // Optional at boot; the purchase-code sender fails closed without it.
    resendApiKey: optional("RESEND_API_KEY"),
    privateActivationEmailSendingEnabled,
    privateActivationRecipients,
    supabaseUrl,
    supabaseAnonKey: required("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    stripeSecretKey: required("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    stripeApiVersion,
    stripeEnvironment,
    stripeManagedPayments,
    stripeManagedPaymentsTermsAccepted,
    stripeManagedPaymentsEligibleTaxCodes,
    stripeAutomaticTax: booleanValue("STRIPE_AUTOMATIC_TAX_ENABLED", false),
    stripeStandardUsOnlyAcknowledged,
    stripeStandardTaxConfigurationReviewed,
    siteOrigin,
    allowedSiteOrigins,
    licenseOrigin,
    checkoutSuccessUrl,
    checkoutCancelUrl,
    activationCodeHmacSecret,
    contextHmacSecret,
    permitPrivateJwk: privateJwk,
    permitPublicJwks: publicJwks,
    permitKeyId,
    cronSecret,
    upstreamProxySecret,
    allowLocalDirectRequests,
  };
}
