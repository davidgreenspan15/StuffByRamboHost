import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "./config.ts";
import { processPurchaseCodeEmails } from "./purchase-codes.ts";

export async function runWorkerMaintenance(
  config: CommerceConfig,
  client: SupabaseClient,
  sendEmails = processPurchaseCodeEmails,
) {
  let purchaseEmails:
    | Awaited<ReturnType<typeof processPurchaseCodeEmails>>
    | null = null;
  let emailFailed = false;
  try {
    purchaseEmails = await sendEmails(config, client);
    emailFailed = purchaseEmails.failed > 0 || purchaseEmails.uncertain > 0 ||
      purchaseEmails.completionFailed > 0;
  } catch {
    emailFailed = true;
  }
  // Retention must still run when the independently gated email step fails.
  try {
    const { data: retention, error } = await client.rpc(
      "commerce_run_retention",
    );
    return {
      purchaseEmails,
      retention: error ? null : retention,
      failure: error
        ? "retention_failed"
        : emailFailed
        ? "purchase_email_queue_failed"
        : null,
    };
  } catch {
    return { purchaseEmails, retention: null, failure: "retention_failed" };
  }
}
