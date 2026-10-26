import {
  createStripeCheckout,
  requireStripePriceMatchesOffer,
  type StripePrice,
} from "./stripe.ts";
import type { CommerceConfig } from "./config.ts";

function assertThrows(run: () => unknown): void {
  try {
    run();
  } catch {
    return;
  }
  throw new Error("expected_error");
}

const offer = {
  stripePriceId: "price_test_exact",
  stripeProductId: "prod_test_exact",
  currency: "usd",
  unitAmount: 2900,
  billingModel: "one_time",
  taxCode: "txcd_10000000",
};
const price: StripePrice = {
  id: "price_test_exact",
  object: "price",
  active: true,
  livemode: false,
  type: "one_time",
  billing_scheme: "per_unit",
  currency: "usd",
  unit_amount: 2900,
  custom_unit_amount: null,
  product: {
    id: "prod_test_exact",
    object: "product",
    active: true,
    tax_code: "txcd_10000000",
  },
};
const expandedProduct = price.product as Exclude<
  StripePrice["product"],
  string
>;

Deno.test("custom consent text is limited to standard sandbox checkout", async () => {
  const originalFetch = globalThis.fetch;
  let request: URLSearchParams | undefined;
  globalThis.fetch = (_input, init) => {
    request = new URLSearchParams(String(init?.body));
    return Promise.resolve(Response.json({ object: "checkout.session" }));
  };
  try {
    for (const environment of ["test", "live"] as const) {
      for (const managed of [false, true]) {
        await createStripeCheckout({
          stripeEnvironment: environment,
          stripeSecretKey: "fixture",
          stripeApiVersion: "2025-03-31.basil",
          stripeManagedPayments: managed,
          stripeAutomaticTax: true,
          checkoutSuccessUrl:
            "https://stuffbyrambo.com/gesture-flow/success.html",
          checkoutCancelUrl:
            "https://stuffbyrambo.com/gesture-flow/canceled.html",
        } as CommerceConfig, {
          checkoutIntentId: "fixture-intent",
          offerCode: "gesture-flow-v3",
          priceId: "price_fixture",
          idempotencyKey: "fixture-idempotency",
        });
        if (
          request?.get("consent_collection[terms_of_service]") !== "required"
        ) {
          throw new Error("Explicit terms acceptance must remain required");
        }
        const key = "custom_text[terms_of_service_acceptance][message]";
        const customTextExpected = environment === "test" && !managed;
        if (
          request.has(key) !== customTextExpected ||
          (customTextExpected &&
            !request.get(key)?.includes(
              "https://stuffbyrambo.com/legal/terms.html",
            ))
        ) {
          throw new Error("Custom terms text crossed checkout mode boundary");
        }
        if (
          request.has("managed_payments[enabled]") !== managed ||
          request.has("automatic_tax[enabled]") === managed
        ) {
          throw new Error(
            "Managed Payments and automatic tax must remain exclusive",
          );
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("checkout price preflight rejects paid-but-unfulfillable configurations", () => {
  requireStripePriceMatchesOffer(price, offer, false, false, []);
  requireStripePriceMatchesOffer(price, offer, false, true, ["txcd_10000000"]);

  for (
    const invalid of [
      { ...price, active: false },
      { ...price, unit_amount: 3000 },
      { ...price, currency: "eur" },
      { ...price, type: "recurring" as const },
      { ...price, product: { ...expandedProduct, id: "prod_wrong" } },
    ]
  ) {
    assertThrows(() =>
      requireStripePriceMatchesOffer(
        invalid as StripePrice,
        offer,
        false,
        false,
        [],
      )
    );
  }
  assertThrows(() =>
    requireStripePriceMatchesOffer(
      price,
      { ...offer, taxCode: null },
      false,
      true,
      ["txcd_10000000"],
    )
  );
  assertThrows(() =>
    requireStripePriceMatchesOffer(
      {
        ...price,
        product: { ...expandedProduct, tax_code: "txcd_20000000" },
      } as StripePrice,
      offer,
      false,
      true,
      ["txcd_10000000"],
    )
  );
  assertThrows(() =>
    requireStripePriceMatchesOffer(
      price,
      offer,
      false,
      true,
      ["txcd_10103000"],
    )
  );
});
