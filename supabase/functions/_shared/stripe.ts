import type { CommerceConfig } from "./config.ts";

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  mode: string;
  status: string | null;
  payment_status: string;
  url: string | null;
  expires_at: number;
  client_reference_id: string | null;
  customer: string | null;
  customer_details: {
    email?: string | null;
    address?: { country?: string | null } | null;
  } | null;
  payment_intent: string | { id: string } | null;
  currency: string | null;
  amount_total: number | null;
  amount_subtotal: number | null;
  total_details?: {
    amount_discount?: number;
    amount_tax?: number;
  };
  presentment_details?: {
    presentment_currency?: string | null;
    presentment_amount?: number | null;
  } | null;
  metadata: Record<string, string>;
  livemode: boolean;
  line_items?: {
    data: Array<{
      quantity: number | null;
      price: {
        id: string;
        product: string | { id: string };
        currency: string;
        unit_amount: number | null;
      } | null;
    }>;
    has_more: boolean;
  };
}

export interface StripePrice {
  id: string;
  object: "price";
  active: boolean;
  livemode: boolean;
  type: "one_time" | "recurring";
  billing_scheme: "per_unit" | "tiered";
  currency: string;
  unit_amount: number | null;
  custom_unit_amount?: unknown | null;
  transform_quantity?: unknown | null;
  product: string | {
    id: string;
    object: "product";
    active: boolean;
    tax_code: string | null;
  };
}

export interface ImmutableOfferPrice {
  stripePriceId: string;
  stripeProductId: string;
  currency: string;
  unitAmount: number;
  billingModel: string;
  taxCode?: string | null;
}

export function requireStripePriceMatchesOffer(
  price: StripePrice,
  offer: ImmutableOfferPrice,
  expectedLivemode: boolean,
  managedPayments: boolean,
  managedPaymentsEligibleTaxCodes: readonly string[],
): void {
  const productId = typeof price.product === "string"
    ? price.product
    : price.product.id;
  if (
    price.object !== "price" || price.id !== offer.stripePriceId ||
    !price.active ||
    price.livemode !== expectedLivemode || price.type !== "one_time" ||
    price.billing_scheme !== "per_unit" || price.custom_unit_amount != null ||
    price.transform_quantity != null ||
    (typeof price.product !== "string" && !price.product.active) ||
    offer.billingModel !== "one_time" || productId !== offer.stripeProductId ||
    price.currency.toLowerCase() !== offer.currency.toLowerCase() ||
    !Number.isInteger(price.unit_amount) ||
    price.unit_amount !== offer.unitAmount ||
    offer.unitAmount <= 0
  ) {
    throw new Error("stripe_price_offer_mismatch");
  }
  if (managedPayments) {
    const taxCode = offer.taxCode;
    const productTaxCode = typeof price.product === "string"
      ? null
      : price.product.tax_code;
    if (
      typeof taxCode !== "string" || !/^txcd_[0-9]{8}$/.test(taxCode) ||
      !managedPaymentsEligibleTaxCodes.includes(taxCode) ||
      productTaxCode !== taxCode
    ) {
      throw new Error("managed_payments_tax_code_mismatch");
    }
  }
}

export interface StripeEvent {
  id: string;
  object: "event";
  api_version: string | null;
  created: number;
  livemode: boolean;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: string | null;
  reason: string | null;
  payment_intent: string | null;
  created: number;
}

export interface StripeDispute {
  id: string;
  object: "dispute";
  amount: number;
  currency: string;
  status: string;
  reason: string;
  charge: string;
  created: number;
  evidence_details?: { due_by?: number | null };
}

export interface StripeCharge {
  id: string;
  object: "charge";
  payment_intent: string | null;
}

function formBody(
  values: Record<string, string | number | boolean | undefined>,
): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.set(key, String(value));
  }
  return body;
}

export async function stripeRequest<T>(
  config: CommerceConfig,
  path: string,
  options: {
    method?: "GET" | "POST";
    form?: Record<string, string | number | boolean | undefined>;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  if (!path.startsWith("/v1/")) throw new Error("invalid_stripe_path");
  const method = options.method ?? "GET";
  const headers = new Headers({
    Authorization: `Bearer ${config.stripeSecretKey}`,
    "Stripe-Version": config.stripeApiVersion,
  });
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  let body: URLSearchParams | undefined;
  let url = `https://api.stripe.com${path}`;
  if (options.form) {
    const encoded = formBody(options.form);
    if (method === "GET") url += `?${encoded.toString()}`;
    else {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      body = encoded;
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as {
      error?: { code?: string; type?: string };
    };
    if (!response.ok) {
      const code = payload.error?.code ?? payload.error?.type ??
        "stripe_request_failed";
      throw new StripeApiError(
        response.status,
        code,
        response.status === 429 || response.status >= 500,
      );
    }
    return payload as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StripeApiError(504, "stripe_request_timeout", true);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createStripeCheckout(
  config: CommerceConfig,
  input: {
    checkoutIntentId: string;
    offerCode: string;
    priceId: string;
    idempotencyKey: string;
  },
): Promise<StripeCheckoutSession> {
  const form: Record<string, string | number | boolean | undefined> = {
    mode: "payment",
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": 1,
    customer_creation: "always",
    billing_address_collection: "required",
    "consent_collection[terms_of_service]": "required",
    client_reference_id: input.checkoutIntentId,
    success_url: config.checkoutSuccessUrl,
    cancel_url: config.checkoutCancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    "metadata[checkout_intent_id]": input.checkoutIntentId,
    "metadata[offer_code]": input.offerCode,
    "payment_intent_data[metadata][checkout_intent_id]": input.checkoutIntentId,
  };
  // Standalone sandboxes may not expose public business settings before live
  // onboarding. Keep explicit consent and point to the existing terms document.
  if (config.stripeEnvironment === "test") {
    form["custom_text[terms_of_service_acceptance][message]"] =
      "I agree to the [Terms of Sale and End User License Agreement](https://stuffbyrambo.com/legal/terms.html).";
  }
  if (config.stripeManagedPayments) {
    form["managed_payments[enabled]"] = true;
  } else if (config.stripeAutomaticTax) {
    form["automatic_tax[enabled]"] = true;
  }
  return await stripeRequest<StripeCheckoutSession>(
    config,
    "/v1/checkout/sessions",
    {
      method: "POST",
      form,
      idempotencyKey: `checkout-${input.checkoutIntentId}`,
    },
  );
}

export async function retrieveStripePrice(
  config: CommerceConfig,
  priceId: string,
): Promise<StripePrice> {
  return await stripeRequest<StripePrice>(
    config,
    `/v1/prices/${encodeURIComponent(priceId)}`,
    { form: { "expand[]": "product" } },
  );
}

export async function retrieveCheckoutSession(
  config: CommerceConfig,
  sessionId: string,
): Promise<StripeCheckoutSession> {
  return await stripeRequest<StripeCheckoutSession>(
    config,
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { form: { "expand[]": "line_items" } },
  );
}

export async function retrieveRefund(
  config: CommerceConfig,
  refundId: string,
): Promise<StripeRefund> {
  return await stripeRequest<StripeRefund>(
    config,
    `/v1/refunds/${encodeURIComponent(refundId)}`,
  );
}

export async function listRefunds(
  config: CommerceConfig,
  paymentIntentId: string,
): Promise<StripeRefund[]> {
  const response = await stripeRequest<
    { data: StripeRefund[]; has_more: boolean }
  >(
    config,
    "/v1/refunds",
    { form: { payment_intent: paymentIntentId, limit: 100 } },
  );
  if (response.has_more) {
    throw new StripeApiError(500, "refund_list_truncated", true);
  }
  return response.data;
}

export async function retrieveDispute(
  config: CommerceConfig,
  disputeId: string,
): Promise<StripeDispute> {
  return await stripeRequest<StripeDispute>(
    config,
    `/v1/disputes/${encodeURIComponent(disputeId)}`,
  );
}

export async function retrieveCharge(
  config: CommerceConfig,
  chargeId: string,
): Promise<StripeCharge> {
  return await stripeRequest<StripeCharge>(
    config,
    `/v1/charges/${encodeURIComponent(chargeId)}`,
  );
}
