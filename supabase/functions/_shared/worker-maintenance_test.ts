import type { CommerceConfig } from "./config.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runWorkerMaintenance } from "./worker-maintenance.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion_failed");
}

Deno.test("email queue outage cannot prevent retention", async () => {
  let retained = false;
  const client = {
    rpc(name: string) {
      assert(name === "commerce_run_retention");
      retained = true;
      return Promise.resolve({ data: { removed: 0 }, error: null });
    },
  } as unknown as SupabaseClient;
  const result = await runWorkerMaintenance(
    {} as CommerceConfig,
    client,
    () => {
      throw new Error("provider details must not escape");
    },
  );
  assert(retained);
  assert(result.failure === "purchase_email_queue_failed");
  assert(result.purchaseEmails === null);
});

Deno.test("uncertain completion reports failure after retention runs", async () => {
  let retained = false;
  const client = {
    rpc() {
      retained = true;
      return Promise.resolve({ data: {}, error: null });
    },
  } as unknown as SupabaseClient;
  const result = await runWorkerMaintenance(
    {} as CommerceConfig,
    client,
    async () => ({
      sent: 1,
      failed: 0,
      uncertain: 1,
      completionFailed: 1,
    }),
  );
  assert(retained && result.failure === "purchase_email_queue_failed");
  assert(result.purchaseEmails?.sent === 1);
});

Deno.test("retention errors remain visible even when email processing succeeds", async () => {
  for (const throws of [false, true]) {
    const client = {
      rpc() {
        if (throws) throw new Error("private database detail");
        return Promise.resolve({ data: null, error: {} });
      },
    } as unknown as SupabaseClient;
    const result = await runWorkerMaintenance(
      {} as CommerceConfig,
      client,
      async () => ({
        sent: 1,
        failed: 0,
        uncertain: 0,
        completionFailed: 0,
      }),
    );
    assert(result.failure === "retention_failed" && result.retention === null);
    assert(result.purchaseEmails?.sent === 1);
  }
});
