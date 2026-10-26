import type { SupabaseClient } from "@supabase/supabase-js";
import { healthySnapshot, operationalHealth } from "./health.ts";

function assert(value: unknown, message = "assertion_failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("health refuses missing, false, stale, future and malformed evidence", () => {
  const now = Date.parse("2026-10-26T23:00:00Z");
  const snapshot = (age: number) => ({
    healthy: true,
    checked_at: new Date(now - age).toISOString(),
  });
  assert(healthySnapshot(snapshot(0), now));
  assert(healthySnapshot(snapshot(180_000), now));
  for (
    const invalid of [
      null,
      {},
      { healthy: "true", checked_at: snapshot(0).checked_at },
      { healthy: false, checked_at: snapshot(0).checked_at },
      { healthy: true, checked_at: "invalid" },
      snapshot(-1),
      snapshot(180_001),
    ]
  ) assert(!healthySnapshot(invalid, now));
});

Deno.test("health rate limits before reading and exposes only a boolean", async () => {
  let limited = false;
  const client = {
    rpc(name: string, parameters: Record<string, unknown>) {
      assert(name === "commerce_consume_rate_limit");
      assert(parameters.p_limit === 12 && parameters.p_window_seconds === 60);
      limited = true;
      return Promise.resolve({ data: [{ allowed: true }], error: null });
    },
    from(name: string) {
      assert(limited && name === "commerce_runtime_health");
      return {
        select(columns: string) {
          assert(columns === "healthy,checked_at");
          return {
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    healthy: true,
                    checked_at: new Date().toISOString(),
                    secret: "never-return",
                  },
                  error: null,
                }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  const result = await operationalHealth(
    client,
    new Request("https://example.test/v1/health", {
      headers: { "x-gf-client-ip-hmac": "a".repeat(64) },
    }),
  );
  assert(JSON.stringify(result) === '{"healthy":true}');
});

Deno.test("health fails closed on database failure without exposing errors", async () => {
  const client = {
    rpc: () => Promise.resolve({ data: [{ allowed: true }], error: null }),
    from: () => {
      throw new Error("private_database_details");
    },
  } as unknown as SupabaseClient;
  const result = await operationalHealth(
    client,
    new Request("https://example.test/v1/health", {
      headers: { "x-gf-client-ip-hmac": "a".repeat(64) },
    }),
  );
  assert(JSON.stringify(result) === '{"healthy":false}');
});
