import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig, CommerceEnvironment } from "./config.ts";
import { ApiError } from "./http.ts";
import {
  listRefunds,
  retrieveCharge,
  retrieveCheckoutSession,
  retrieveDispute,
  retrieveRefund,
  type StripeDispute,
  type StripeEvent,
  type StripeRefund,
} from "./stripe.ts";

export interface MinimalStripeEvent {
  eventId: string;
  type: string;
  objectId: string;
  livemode: boolean;
  apiVersion: string | null;
  created: number;
}

interface StoredStripeEvent {
  stripe_event_id: string;
  environment: "test" | "live";
  event_type: string;
  object_id: string;
  payload: MinimalStripeEvent;
  attempts: number;
  lease_token: string;
}

export const ACTIONABLE_STRIPE_EVENT_TYPES = [
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
] as const;

const actionableStripeEvents = new Set<string>(ACTIONABLE_STRIPE_EVENT_TYPES);

export function stripeEventInitialStatus(type: string): "received" | "ignored" {
  return actionableStripeEvents.has(type) ? "received" : "ignored";
}

export function requireStripeEventApiVersion(
  expectedApiVersion: string,
  eventApiVersion: string | null,
): void {
  if (eventApiVersion !== expectedApiVersion) {
    throw new ApiError(
      503,
      "webhook_api_version_mismatch",
      "Webhook endpoint configuration does not match the service.",
      true,
    );
  }
}

export function minimalStripeEvent(event: StripeEvent): MinimalStripeEvent {
  const objectId = event.data?.object?.id;
  if (
    typeof event.id !== "string" || !event.id.startsWith("evt_") ||
    typeof event.type !== "string" || typeof objectId !== "string" ||
    typeof event.livemode !== "boolean" || !Number.isInteger(event.created)
  ) {
    throw new ApiError(
      400,
      "invalid_stripe_event",
      "Webhook event is invalid.",
    );
  }
  return {
    eventId: event.id,
    type: event.type,
    objectId,
    livemode: event.livemode,
    apiVersion: event.api_version ?? null,
    created: event.created,
  };
}

export function requireFulfillmentCountry(
  environment: CommerceEnvironment,
  managedPayments: boolean,
  country: string | null,
): void {
  if (environment === "live" && !managedPayments && country !== "US") {
    throw new Error("standard_checkout_country_not_us");
  }
}

export function requireBaseCheckoutAmount(
  offerCurrency: string,
  offerUnitAmount: number,
  sessionCurrency: string | null,
  sessionSubtotal: number | null,
): void {
  if (
    sessionCurrency?.toLowerCase() !== offerCurrency.toLowerCase() ||
    sessionSubtotal !== offerUnitAmount
  ) {
    throw new Error("checkout_base_amount_mismatch");
  }
}

async function processCheckout(
  config: CommerceConfig,
  client: SupabaseClient,
  event: StoredStripeEvent,
): Promise<void> {
  const session = await retrieveCheckoutSession(config, event.object_id);
  if (
    session.livemode !== (config.stripeEnvironment === "live") ||
    session.mode !== "payment"
  ) {
    throw new Error("checkout_environment_or_mode_mismatch");
  }
  const { data: intent, error: intentError } = await client
    .from("commerce_checkout_intents")
    .select(
      "id,offer_id,offer_snapshot,policy_set_id,stripe_checkout_session_id",
    )
    .eq("stripe_checkout_session_id", session.id)
    .maybeSingle();
  if (intentError || !intent || intent.id !== session.client_reference_id) {
    throw new Error("checkout_intent_mismatch");
  }

  if (event.event_type === "checkout.session.expired") {
    await client.from("commerce_checkout_intents").update({ state: "expired" })
      .eq("id", intent.id);
    return;
  }
  if (event.event_type === "checkout.session.async_payment_failed") {
    await client.from("commerce_checkout_intents").update({
      state: "payment_failed",
    }).eq("id", intent.id);
    return;
  }
  if (session.payment_status !== "paid") return;

  const offer = intent.offer_snapshot as Record<string, unknown>;
  const items = session.line_items?.data ?? [];
  const item = items[0];
  const itemProduct = typeof item?.price?.product === "string"
    ? item.price.product
    : item?.price?.product?.id;
  if (
    items.length !== 1 || session.line_items?.has_more ||
    item?.quantity !== 1 || item.price?.id !== offer.stripePriceId ||
    itemProduct !== offer.stripeProductId || !item.price?.currency ||
    !Number.isInteger(item.price.unit_amount) ||
    Number(item.price.unit_amount) <= 0
  ) {
    throw new Error("checkout_line_item_mismatch");
  }
  requireBaseCheckoutAmount(
    String(offer.currency),
    Number(offer.unitAmount),
    session.currency,
    session.amount_subtotal,
  );
  requireFulfillmentCountry(
    config.stripeEnvironment,
    config.stripeManagedPayments,
    session.customer_details?.address?.country ?? null,
  );
  const email = session.customer_details?.email?.trim().toLowerCase();
  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id;
  if (
    !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !paymentIntentId ||
    !session.currency || session.amount_total === null ||
    session.amount_subtotal === null
  ) {
    throw new Error("checkout_fulfillment_fields_missing");
  }
  const { error: fulfillmentError } = await client.rpc(
    "commerce_fulfill_paid_checkout",
    {
      p_environment: config.stripeEnvironment,
      p_checkout_intent_id: intent.id,
      p_stripe_checkout_session_id: session.id,
      p_stripe_payment_intent_id: paymentIntentId,
      p_stripe_customer_id: session.customer,
      p_customer_email: email,
      p_currency: session.currency.toLowerCase(),
      p_amount_total: session.amount_total,
      p_amount_subtotal: session.amount_subtotal,
      p_amount_tax: session.total_details?.amount_tax ?? 0,
      p_amount_discount: session.total_details?.amount_discount ?? 0,
      p_presentment_currency:
        session.presentment_details?.presentment_currency?.toLowerCase() ??
          null,
      p_presentment_amount: session.presentment_details?.presentment_amount ??
        null,
      p_paid_at: new Date(event.payload.created * 1000).toISOString(),
    },
  );
  if (fulfillmentError) {
    throw new Error("checkout_fulfillment_transaction_failed");
  }
}

async function orderForPaymentIntent(
  client: SupabaseClient,
  paymentIntentId: string,
): Promise<{ id: string; amount_total: number } | null> {
  const { data, error } = await client.from("commerce_orders")
    .select("id,amount_total").eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) throw new Error("order_lookup_failed");
  return data;
}

async function upsertRefund(
  client: SupabaseClient,
  refund: StripeRefund,
): Promise<void> {
  if (!refund.payment_intent) throw new Error("refund_payment_intent_missing");
  const order = await orderForPaymentIntent(client, refund.payment_intent);
  if (!order) throw new Error("refund_order_not_found");
  const status = refund.status &&
      ["pending", "requires_action", "succeeded", "failed", "canceled"]
        .includes(refund.status)
    ? refund.status
    : "pending";
  const { error } = await client.from("commerce_refunds").upsert({
    order_id: order.id,
    stripe_refund_id: refund.id,
    amount: refund.amount,
    currency: refund.currency.toLowerCase(),
    status,
    reason: refund.reason,
    provider_created_at: new Date(refund.created * 1000).toISOString(),
  }, { onConflict: "stripe_refund_id" });
  if (error) throw new Error("refund_upsert_failed");
  const { error: reducerError } = await client.rpc("commerce_recompute_order", {
    p_order_id: order.id,
  });
  if (reducerError) throw new Error("refund_reducer_failed");
}

async function upsertDispute(
  config: CommerceConfig,
  client: SupabaseClient,
  dispute: StripeDispute,
): Promise<void> {
  const charge = await retrieveCharge(config, dispute.charge);
  if (!charge.payment_intent) throw new Error("dispute_payment_intent_missing");
  const order = await orderForPaymentIntent(client, charge.payment_intent);
  if (!order) throw new Error("dispute_order_not_found");
  const { error } = await client.from("commerce_disputes").upsert({
    order_id: order.id,
    stripe_dispute_id: dispute.id,
    stripe_charge_id: dispute.charge,
    amount: dispute.amount,
    currency: dispute.currency.toLowerCase(),
    reason: dispute.reason,
    status: dispute.status,
    evidence_due_at: dispute.evidence_details?.due_by
      ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
      : null,
    provider_created_at: new Date(dispute.created * 1000).toISOString(),
  }, { onConflict: "stripe_dispute_id" });
  if (error) throw new Error("dispute_upsert_failed");
  const { error: reducerError } = await client.rpc("commerce_recompute_order", {
    p_order_id: order.id,
  });
  if (reducerError) throw new Error("dispute_reducer_failed");
}

async function processEvent(
  config: CommerceConfig,
  client: SupabaseClient,
  event: StoredStripeEvent,
): Promise<"processed" | "ignored"> {
  if (event.environment !== config.stripeEnvironment) {
    throw new Error("stripe_event_environment_mismatch");
  }
  switch (event.event_type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      await processCheckout(config, client, event);
      return "processed";
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      await upsertRefund(client, await retrieveRefund(config, event.object_id));
      return "processed";
    case "charge.refunded": {
      const charge = await retrieveCharge(config, event.object_id);
      if (!charge.payment_intent) {
        throw new Error("charge_payment_intent_missing");
      }
      for (const refund of await listRefunds(config, charge.payment_intent)) {
        await upsertRefund(client, refund);
      }
      return "processed";
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      await upsertDispute(
        config,
        client,
        await retrieveDispute(config, event.object_id),
      );
      return "processed";
    default:
      // Defense in depth for rows created by older deployments or operators:
      // unsupported events never cause a Stripe object retrieval.
      return "ignored";
  }
}

async function completeEvent(
  client: SupabaseClient,
  event: StoredStripeEvent,
  outcome: "processed" | "ignored" | "failed" | "dead_letter",
  nextAttemptAt: string | null,
  errorCode: string | null,
): Promise<boolean> {
  if (!event.lease_token) throw new Error("stripe_event_lease_missing");
  const { data, error } = await client.rpc("commerce_complete_stripe_event", {
    p_stripe_event_id: event.stripe_event_id,
    p_lease_token: event.lease_token,
    p_outcome: outcome,
    p_next_attempt_at: nextAttemptAt,
    p_error_code: errorCode,
  });
  if (error) throw new Error("event_completion_failed");
  return data === true;
}

async function markFailed(
  client: SupabaseClient,
  event: StoredStripeEvent,
  error: unknown,
): Promise<boolean> {
  const deadLetter = event.attempts >= 10;
  const delaySeconds = Math.min(3600, 2 ** Math.min(event.attempts, 12) * 5);
  const code =
    error instanceof Error && /^[a-z0-9_]{1,100}$/.test(error.message)
      ? error.message
      : "event_processing_failed";
  return await completeEvent(
    client,
    event,
    deadLetter ? "dead_letter" : "failed",
    deadLetter
      ? null
      : new Date(Date.now() + delaySeconds * 1000).toISOString(),
    code,
  );
}

export async function processStripeQueue(
  config: CommerceConfig,
  client: SupabaseClient,
  limit = 20,
): Promise<{ processed: number; failed: number; leaseLost: number }> {
  const { data, error } = await client.rpc("commerce_claim_stripe_events", {
    p_limit: limit,
  });
  if (error || !Array.isArray(data)) {
    throw new Error("stripe_queue_claim_failed");
  }
  let processed = 0;
  let failed = 0;
  let leaseLost = 0;
  for (const rawEvent of data) {
    const event = rawEvent as StoredStripeEvent;
    try {
      const outcome = await processEvent(config, client, event);
      if (await completeEvent(client, event, outcome, null, null)) {
        processed += 1;
      } else leaseLost += 1;
    } catch (processingError) {
      if (await markFailed(client, event, processingError)) failed += 1;
      else leaseLost += 1;
    }
  }
  return { processed, failed, leaseLost };
}

export async function processStripeEventById(
  config: CommerceConfig,
  client: SupabaseClient,
  _eventId: string,
): Promise<void> {
  await processStripeQueue(config, client, 20);
}
