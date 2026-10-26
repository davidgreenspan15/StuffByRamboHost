import {
  ACTIONABLE_STRIPE_EVENT_TYPES,
  minimalStripeEvent,
  requireBaseCheckoutAmount,
  requireFulfillmentCountry,
  requireStripeEventApiVersion,
  stripeEventInitialStatus,
} from "./stripe-events.ts";
import { ApiError } from "./http.ts";
import type { StripeEvent } from "./stripe.ts";

function assert(
  condition: unknown,
  message = "assertion_failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Stripe event persistence envelope excludes customer PII", () => {
  const envelope = minimalStripeEvent({
    id: "evt_test_123",
    object: "event",
    api_version: "2026-03-04.preview",
    created: 1_783_944_000,
    livemode: false,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        customer_details: {
          email: "sensitive@example.com",
          address: { line1: "private" },
        },
        payment_method_details: { card: { fingerprint: "sensitive" } },
      },
    },
  } as StripeEvent);
  const serialized = JSON.stringify(envelope);
  assert(!serialized.includes("sensitive@example.com"));
  assert(!serialized.includes("private"));
  assert(!serialized.includes("fingerprint"));
  assert(
    Object.keys(envelope).sort().join(",") ===
      "apiVersion,created,eventId,livemode,objectId,type",
  );
});

Deno.test("Stripe webhook events must match the pinned API version exactly", () => {
  const expected = "2026-02-25.clover";
  requireStripeEventApiVersion(expected, expected);

  for (const actual of ["2026-05-28.dahlia", null, `${expected} `]) {
    try {
      requireStripeEventApiVersion(expected, actual);
    } catch (error) {
      assert(error instanceof ApiError);
      assert(error.status === 503);
      assert(error.code === "webhook_api_version_mismatch");
      assert(error.retryable);
      continue;
    }
    throw new Error(`Stripe webhook API version should reject ${actual}`);
  }
});

Deno.test("Standard fulfillment country enforcement is live-only", () => {
  for (const country of [null, "CA", "GB", "US"]) {
    requireFulfillmentCountry("test", false, country);
  }

  requireFulfillmentCountry("live", false, "US");
  for (const country of [null, "CA", "GB"]) {
    try {
      requireFulfillmentCountry("live", false, country);
    } catch {
      continue;
    }
    throw new Error(`Standard checkout should reject ${country}`);
  }
  requireFulfillmentCountry("live", true, null);
  requireFulfillmentCountry("live", true, "CA");
});

Deno.test("adaptive presentment does not replace strict base offer amount", () => {
  const convertedSession = {
    currency: "usd",
    amountSubtotal: 2900,
    presentmentDetails: { presentmentCurrency: "eur", presentmentAmount: 2675 },
  };
  requireBaseCheckoutAmount(
    "usd",
    2900,
    convertedSession.currency,
    convertedSession.amountSubtotal,
  );
  try {
    requireBaseCheckoutAmount("usd", 2900, "eur", 2675);
  } catch {
    return;
  }
  throw new Error(
    "Buyer presentment values must not replace the base Stripe amount",
  );
});

Deno.test("only the exact commerce lifecycle webhook events enter the actionable queue", () => {
  const expected = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
    "refund.created",
    "refund.updated",
    "refund.failed",
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.updated",
    "charge.dispute.closed",
  ];
  assert(
    JSON.stringify(ACTIONABLE_STRIPE_EVENT_TYPES) === JSON.stringify(expected),
  );
  for (const eventType of expected) {
    assert(stripeEventInitialStatus(eventType) === "received");
  }
  for (
    const unsupported of [
      "customer.created",
      "checkout.session.completed.attacker_suffix",
      "charge.dispute.funds_withdrawn",
    ]
  ) {
    assert(stripeEventInitialStatus(unsupported) === "ignored");
  }
});
