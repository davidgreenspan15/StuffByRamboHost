import { ApiError } from "./http.ts";
import { validateStoredIdempotency } from "./idempotency.ts";

Deno.test("authenticated idempotency replay is bound to the same account", () => {
  const stored = {
    account_id: "10000000-0000-4000-8000-000000000001",
    request_sha256: "a".repeat(64),
    response_status: 200,
    response_body: { approved: true },
  };
  validateStoredIdempotency(
    stored,
    "10000000-0000-4000-8000-000000000001",
    "a".repeat(64),
  );
  try {
    validateStoredIdempotency(
      stored,
      "20000000-0000-4000-8000-000000000002",
      "a".repeat(64),
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "idempotency_conflict") {
      return;
    }
    throw error;
  }
  throw new Error("Cross-account replay should be rejected");
});
