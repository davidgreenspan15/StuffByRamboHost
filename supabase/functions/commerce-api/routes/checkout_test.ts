import { ApiError } from "../../_shared/http.ts";
import { requireCheckoutConfiguration } from "./checkout.ts";

function assert(
  condition: unknown,
  message = "assertion_failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Standard checkout is allowed only in Stripe test mode", () => {
  requireCheckoutConfiguration({
    stripeEnvironment: "test",
    stripeManagedPayments: false,
  });

  let liveStandardDenied = false;
  try {
    requireCheckoutConfiguration({
      stripeEnvironment: "live",
      stripeManagedPayments: false,
    });
  } catch (error) {
    assert(error instanceof ApiError);
    assert(error.status === 503);
    assert(error.code === "checkout_configuration_incomplete");
    assert(error.message === "Secure checkout is not configured yet.");
    assert(error.retryable);
    liveStandardDenied = true;
  }
  assert(liveStandardDenied, "live_standard_checkout_accepted");

  requireCheckoutConfiguration({
    stripeEnvironment: "live",
    stripeManagedPayments: true,
  });
});
