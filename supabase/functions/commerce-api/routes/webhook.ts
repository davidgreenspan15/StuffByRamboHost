import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import { ApiError } from "../../_shared/http.ts";
import {
  minimalStripeEvent,
  processStripeEventById,
  requireStripeEventApiVersion,
  stripeEventInitialStatus,
} from "../../_shared/stripe-events.ts";
import type { StripeEvent } from "../../_shared/stripe.ts";
import { verifyStripeSignature } from "../../_shared/pure.ts";

interface EdgeRuntimeGlobal {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function stripeWebhook(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 1_048_576) {
    throw new ApiError(413, "request_too_large", "Webhook is too large.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 1_048_576) {
    throw new ApiError(413, "request_too_large", "Webhook is too large.");
  }
  const signature = request.headers.get("stripe-signature") ?? "";
  try {
    await verifyStripeSignature(raw, signature, config.stripeWebhookSecret);
  } catch {
    throw new ApiError(
      400,
      "invalid_webhook_signature",
      "Webhook signature is invalid.",
    );
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    throw new ApiError(
      400,
      "invalid_stripe_event",
      "Webhook event is invalid.",
    );
  }
  const envelope = minimalStripeEvent(event);
  requireStripeEventApiVersion(config.stripeApiVersion, envelope.apiVersion);
  const expectedLivemode = config.stripeEnvironment === "live";
  if (envelope.livemode !== expectedLivemode) {
    throw new ApiError(
      400,
      "webhook_environment_mismatch",
      "Webhook environment is invalid.",
    );
  }
  const initialStatus = stripeEventInitialStatus(envelope.type);
  const { error } = await client.from("commerce_stripe_events").insert({
    stripe_event_id: envelope.eventId,
    environment: config.stripeEnvironment,
    event_type: envelope.type,
    api_version: envelope.apiVersion,
    object_id: envelope.objectId,
    payload: envelope,
    status: initialStatus,
    ...(initialStatus === "ignored"
      ? { processed_at: new Date().toISOString() }
      : {}),
  });
  if (error) {
    const { data: existing } = await client.from("commerce_stripe_events")
      .select("stripe_event_id").eq("stripe_event_id", envelope.eventId)
      .maybeSingle();
    if (!existing) {
      throw new ApiError(
        503,
        "webhook_persistence_failed",
        "Webhook could not be recorded.",
        true,
      );
    }
    return { accepted: true, duplicate: true };
  }

  if (initialStatus === "received") {
    const edgeRuntime =
      (globalThis as typeof globalThis & { EdgeRuntime?: EdgeRuntimeGlobal })
        .EdgeRuntime;
    edgeRuntime?.waitUntil?.(
      processStripeEventById(config, client, envelope.eventId),
    );
  }
  return {
    accepted: true,
    ...(initialStatus === "ignored" ? { ignored: true } : {}),
  };
}
