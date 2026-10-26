import type { CommerceConfig } from "../../_shared/config.ts";
import { ApiError } from "../../_shared/http.ts";
import { route } from "../router.ts";

function assert(v: unknown, message = "assertion_failed"): asserts v {
  if (!v) throw new Error(message);
}

const config = {
  allowLocalDirectRequests: true,
  allowedSiteOrigins: [],
  supabaseUrl: "http://127.0.0.1:9",
  supabaseServiceRoleKey: "test-only",
  stripeEnvironment: "test",
  privatePurchaseCodesEnabled: true,
  privateActivationRecipients: ["buyer@example.test"],
} as unknown as CommerceConfig;

async function routeError(path: string): Promise<ApiError> {
  try {
    await route(
      new Request(`http://127.0.0.1/functions/v1/commerce-api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "buyer@example.test", code: "123456" }),
      }),
      config,
      "test-request-id",
    );
  } catch (error) {
    assert(error instanceof ApiError);
    return error;
  }
  throw new Error("expected_route_error");
}

Deno.test("the purchase OTP email-code route no longer exists", async () => {
  const error = await routeError(
    "/v1/device-activation-challenges/00000000-0000-4000-8000-000000000010/email-code",
  );
  assert(error.status === 404 && error.code === "not_found", error.code);
});

Deno.test("the purchase-code route is wired and validates before any database call", async () => {
  // No bearer: rejected by the route itself, proving it matched.
  const error = await routeError(
    "/v1/device-activation-challenges/00000000-0000-4000-8000-000000000010/purchase-code",
  );
  assert(error.status === 401 && error.code === "invalid_token", error.code);
});
