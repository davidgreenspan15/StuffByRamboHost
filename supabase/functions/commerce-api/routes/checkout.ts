import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import {
  ApiError,
  readJson,
  requireSameSiteMutation,
} from "../../_shared/http.ts";
import { idempotencyKey } from "../../_shared/idempotency.ts";
import { sha256Hex } from "../../_shared/pure.ts";
import { consumeRateLimit, trustedIpHmac } from "../../_shared/rate-limit.ts";
import {
  createStripeCheckout,
  requireStripePriceMatchesOffer,
  retrieveStripePrice,
  StripeApiError,
} from "../../_shared/stripe.ts";
import {
  booleanTrueField,
  exactKeys,
  objectField,
  stringField,
} from "../../_shared/validation.ts";

interface CheckoutResult {
  checkoutSessionId: string;
  checkoutUrl: string;
  expiresAt: string;
}

type CheckoutConfiguration = Pick<
  CommerceConfig,
  | "stripeEnvironment"
  | "stripeManagedPayments"
>;

export function requireCheckoutConfiguration(
  config: CheckoutConfiguration,
): void {
  // Standard mode may exercise end-to-end checkout in Stripe's isolated test
  // environment. Live payment creation remains Managed Payments-only, while
  // Standard live configuration can still service historical webhooks/refunds.
  if (
    config.stripeEnvironment === "live" && !config.stripeManagedPayments
  ) {
    throw new ApiError(
      503,
      "checkout_configuration_incomplete",
      "Secure checkout is not configured yet.",
      true,
    );
  }
}

export async function createCheckoutSession(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<CheckoutResult> {
  requireSameSiteMutation(config, request);
  requireCheckoutConfiguration(config);
  const ipHmac = trustedIpHmac(request);
  await consumeRateLimit(client, {
    bucket: "checkout.ip",
    limit: 10,
    windowSeconds: 600,
  }, ipHmac);
  if (
    config.stripeEnvironment === "live" && !config.stripeManagedPayments
  ) {
    const country = request.headers.get("x-gf-client-country") ?? "ZZ";
    if (country !== "US") {
      throw new ApiError(
        403,
        "purchase_region_unavailable",
        "Purchases are currently available only in the United States.",
      );
    }
  }

  const body = await readJson(request);
  exactKeys(body, ["sku", "policySetVersion", "acceptances"]);
  const sku = stringField(body, "sku", { pattern: /^gesture-flow-v3$/ });
  const policySetVersion = stringField(body, "policySetVersion", {
    min: 8,
    max: 100,
  });
  const acceptances = objectField(body, "acceptances");
  exactKeys(acceptances, ["terms", "refunds", "compatibility"]);
  booleanTrueField(acceptances, "terms");
  booleanTrueField(acceptances, "refunds");
  booleanTrueField(acceptances, "compatibility");
  const key = idempotencyKey(request);
  const requestHash = await sha256Hex(
    JSON.stringify({ sku, policySetVersion, acceptances }),
  );

  const { data: offer, error: offerError } = await client
    .from("commerce_offers")
    .select(
      "id,code,environment,stripe_price_id,stripe_product_id,current_policy_set_id,published_at,checkout_enabled",
    )
    .eq("code", sku)
    .eq("environment", config.stripeEnvironment)
    .eq("checkout_enabled", true)
    .not("stripe_price_id", "is", null)
    .lte("published_at", new Date().toISOString())
    .maybeSingle();
  if (offerError || !offer) {
    throw new ApiError(
      409,
      "offer_unavailable",
      "This offer is not currently available.",
    );
  }
  const { data: policySet, error: policyError } = await client
    .from("commerce_policy_sets")
    .select("id,version,published_at,retired_at")
    .eq("id", offer.current_policy_set_id)
    .eq("version", policySetVersion)
    .lte("published_at", new Date().toISOString())
    .maybeSingle();
  if (
    policyError || !policySet ||
    (policySet.retired_at && new Date(policySet.retired_at) <= new Date())
  ) {
    throw new ApiError(
      409,
      "policy_changed",
      "Purchase terms changed. Reload the page and review them again.",
    );
  }

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 1000);
  const { data: intentRows, error: intentError } = await client.rpc(
    "commerce_create_checkout_intent",
    {
      p_environment: config.stripeEnvironment,
      p_offer_id: offer.id,
      p_policy_set_id: policySet.id,
      p_idempotency_key: key,
      p_request_sha256: requestHash,
      p_ip_hmac: ipHmac,
      p_user_agent_sha256: userAgent ? await sha256Hex(userAgent) : null,
    },
  );
  if (intentError || !Array.isArray(intentRows) || intentRows.length !== 1) {
    throw new ApiError(
      503,
      "checkout_persistence_failed",
      "Checkout could not be created safely.",
      true,
    );
  }
  const intent = intentRows[0] as {
    outcome: string;
    intent_id: string;
    offer_snapshot: Record<string, unknown>;
    stripe_checkout_session_id: string | null;
    stripe_checkout_url: string | null;
    expires_at: string | null;
    state: string;
  };
  if (intent.outcome === "conflict") {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was used for another checkout.",
    );
  }
  if (intent.state === "invalid") {
    throw new ApiError(
      409,
      "offer_configuration_invalid",
      "This offer is temporarily unavailable. No payment was taken.",
    );
  }
  if (
    intent.stripe_checkout_session_id && intent.stripe_checkout_url &&
    intent.expires_at &&
    new Date(intent.expires_at) > new Date()
  ) {
    return {
      checkoutSessionId: intent.stripe_checkout_session_id,
      checkoutUrl: intent.stripe_checkout_url,
      expiresAt: intent.expires_at,
    };
  }
  const intentId = intent.intent_id;
  const persistedPriceId = intent.offer_snapshot?.stripePriceId;
  if (
    typeof persistedPriceId !== "string" ||
    !persistedPriceId.startsWith("price_")
  ) {
    await client.from("commerce_checkout_intents").update({ state: "invalid" })
      .eq("id", intentId);
    throw new ApiError(
      503,
      "checkout_persistence_failed",
      "Checkout offer snapshot is invalid.",
      true,
    );
  }

  try {
    const stripePrice = await retrieveStripePrice(config, persistedPriceId);
    try {
      requireStripePriceMatchesOffer(
        stripePrice,
        {
          stripePriceId: persistedPriceId,
          stripeProductId: String(intent.offer_snapshot.stripeProductId ?? ""),
          currency: String(intent.offer_snapshot.currency ?? ""),
          unitAmount: Number(intent.offer_snapshot.unitAmount),
          billingModel: String(intent.offer_snapshot.billingModel ?? ""),
          taxCode: typeof intent.offer_snapshot.taxCode === "string"
            ? intent.offer_snapshot.taxCode
            : null,
        },
        config.stripeEnvironment === "live",
        config.stripeManagedPayments,
        config.stripeManagedPaymentsEligibleTaxCodes,
      );
    } catch {
      await client.from("commerce_checkout_intents").update({
        state: "invalid",
      }).eq(
        "id",
        intentId,
      );
      throw new ApiError(
        409,
        "offer_configuration_invalid",
        "This offer is temporarily unavailable. No payment was taken.",
      );
    }
    const session = await createStripeCheckout(config, {
      checkoutIntentId: intentId,
      offerCode: sku,
      priceId: persistedPriceId,
      idempotencyKey: key,
    });
    const expectedLivemode = config.stripeEnvironment === "live";
    const checkoutUrl = session.url;
    const sessionUrl = checkoutUrl ? new URL(checkoutUrl) : null;
    if (
      session.object !== "checkout.session" || session.mode !== "payment" ||
      session.client_reference_id !== intentId ||
      session.livemode !== expectedLivemode ||
      !sessionUrl || sessionUrl.protocol !== "https:" ||
      sessionUrl.hostname !== "checkout.stripe.com" ||
      sessionUrl.username !== "" || sessionUrl.password !== "" ||
      (sessionUrl.port !== "" && sessionUrl.port !== "443")
    ) {
      throw new ApiError(
        502,
        "invalid_checkout_response",
        "Payment provider returned an invalid checkout.",
        true,
      );
    }
    const expiresAt = new Date(session.expires_at * 1000).toISOString();
    const { error: updateError } = await client.from(
      "commerce_checkout_intents",
    ).update({
      stripe_checkout_session_id: session.id,
      stripe_checkout_url: checkoutUrl,
      expires_at: expiresAt,
      state: "open",
    }).eq("id", intentId);
    if (updateError) {
      throw new ApiError(
        503,
        "checkout_persistence_failed",
        "Checkout could not be recorded safely.",
        true,
      );
    }
    if (!checkoutUrl) throw new Error("checkout_url_missing_after_validation");
    return { checkoutSessionId: session.id, checkoutUrl, expiresAt };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof StripeApiError) {
      if (!error.retryable) {
        await client.from("commerce_checkout_intents").update({
          state: "invalid",
        }).eq(
          "id",
          intentId,
        );
      }
      throw new ApiError(
        error.retryable ? 503 : 409,
        "checkout_provider_error",
        error.retryable
          ? "Secure checkout is temporarily unavailable. Please retry."
          : "This checkout could not be created. Please contact support.",
        error.retryable,
      );
    }
    throw error;
  }
}

export async function checkoutStatus(
  client: SupabaseClient,
  sessionId: string,
): Promise<Record<string, unknown>> {
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]{8,240}$/.test(sessionId)) {
    throw new ApiError(404, "checkout_not_found", "Checkout was not found.");
  }
  const { data: intent, error } = await client
    .from("commerce_checkout_intents")
    .select("id,state")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();
  if (error || !intent) {
    throw new ApiError(404, "checkout_not_found", "Checkout was not found.");
  }
  const { data: order } = await client
    .from("commerce_orders")
    .select("id,status")
    .eq("checkout_intent_id", intent.id)
    .maybeSingle();
  const { data: entitlement } = order
    ? await client.from("commerce_entitlements").select("status").eq(
      "order_id",
      order.id,
    )
      .maybeSingle()
    : { data: null };
  return {
    status: order?.status ?? intent.state,
    ...(entitlement ? { entitlementStatus: entitlement.status } : {}),
  };
}
