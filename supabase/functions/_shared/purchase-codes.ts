import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "./config.ts";
import { ApiError } from "./http.ts";
import { hmacSha256Hex } from "./pure.ts";
import { purchaseCodeEmail } from "./purchase-code-email.ts";

// Crockford base32: no I, L, O or U. 16 characters carry 80 random bits.
export const PURCHASE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PURCHASE_CODE_LENGTH = 16;
const PURCHASE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const RESEND_TIMEOUT_MS = 10_000;

// Sandbox: test Stripe, private flag and a recipient allowlist (unchanged).
function testPurchaseCodesEnabled(config: CommerceConfig): boolean {
  return config.stripeEnvironment === "test" &&
    config.privatePurchaseCodesEnabled === true &&
    (config.privateActivationRecipients?.length ?? 0) > 0;
}

// Production: live Stripe and the explicit live flag. The database applies
// its own live gate (commerce_purchase_code_settings) on top of this one.
function livePurchaseCodesEnabled(config: CommerceConfig): boolean {
  return config.stripeEnvironment === "live" &&
    config.livePurchaseCodesEnabled === true;
}

export function purchaseCodesEnabled(config: CommerceConfig): boolean {
  return testPurchaseCodesEnabled(config) || livePurchaseCodesEnabled(config);
}

export function requirePurchaseCodes(config: CommerceConfig): void {
  if (!purchaseCodesEnabled(config)) {
    throw new ApiError(404, "not_found", "Endpoint was not found.");
  }
}

// The p_allowed_emails argument for the database. Test always passes its
// allowlist. Live passes the optional canary list, or null for every buyer;
// the database honors null only for live orders.
export function purchaseCodeRecipientFilter(
  config: CommerceConfig,
): string[] | null {
  if (testPurchaseCodesEnabled(config)) {
    return config.privateActivationRecipients!;
  }
  if (livePurchaseCodesEnabled(config)) {
    return config.livePurchaseCodeCanaryRecipients ?? null;
  }
  return [];
}

export function allowedActivationEmail(
  config: CommerceConfig,
  email: string,
): boolean {
  if (!purchaseCodesEnabled(config)) return false;
  const filter = purchaseCodeRecipientFilter(config);
  return filter === null || filter.includes(email);
}

// Server-authoritative normalization; the app mirrors it. Returns the 16
// alphabet characters or null. A leading GF is stripped only from 18
// characters, so a bare 16-character code that begins with GF stays intact.
export function normalizePurchaseCode(value: string): string | null {
  if (value.length > 64) return null;
  let code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length === PURCHASE_CODE_LENGTH + 2 && code.startsWith("GF")) {
    code = code.slice(2);
  }
  code = code.replace(/O/g, "0").replace(/[IL]/g, "1");
  return PURCHASE_CODE_PATTERN.test(code) ? code : null;
}

export function generatePurchaseCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += PURCHASE_CODE_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return output;
}

export function formatPurchaseCode(normalized: string): string {
  return `GF-${normalized.match(/.{4}/g)!.join("-")}`;
}

// Keyed with the existing activation-code pepper and domain-separated from
// browser device codes. Only this digest is ever stored.
export async function purchaseCodeDigest(
  config: CommerceConfig,
  normalized: string,
): Promise<string> {
  return await hmacSha256Hex(
    config.activationCodeHmacSecret,
    `gf-purchase-code-v1:${normalized}`,
  );
}

export interface PurchaseCodeMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export type SendOutcome = "sent" | "failed" | "uncertain";
export type PurchaseCodeSender = (
  config: CommerceConfig,
  message: PurchaseCodeMessage,
) => Promise<SendOutcome>;

export function sendingConfigured(config: CommerceConfig): boolean {
  const flag = testPurchaseCodesEnabled(config)
    ? config.privateActivationEmailSendingEnabled === true
    : livePurchaseCodesEnabled(config) &&
      config.livePurchaseCodeEmailSendingEnabled === true;
  return flag && !!config.resendApiKey && !!config.privateActivationEmailFrom;
}

// Resend HTTP API. A 2xx is "sent" (accepted, not proven delivered). Other
// definite responses are "failed". Timeouts, transport errors and 5xx may
// have delivered mail and stay "uncertain"; they are never retried here.
export const resendSender: PurchaseCodeSender = async (config, message) => {
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch {
    return "uncertain";
  }
  // Provider bodies are discarded so no detail can reach logs or the queue.
  await response.body?.cancel().catch(() => {});
  if (response.ok) return "sent";
  return response.status >= 500 ? "uncertain" : "failed";
};

// The raw code exists only in this function's memory and the outgoing email.
// It is never logged, returned, stored or placed in error metadata.
export async function processPurchaseCodeEmails(
  config: CommerceConfig,
  client: SupabaseClient,
  send: PurchaseCodeSender = resendSender,
): Promise<
  { sent: number; failed: number; uncertain: number; completionFailed: number }
> {
  const counts = { sent: 0, failed: 0, uncertain: 0, completionFailed: 0 };
  // Fail closed: without every gate and the provider key, rows stay pending.
  if (!sendingConfigured(config)) return counts;
  const { data, error } = await client.rpc(
    "commerce_claim_purchase_code_emails",
    {
      p_environment: config.stripeEnvironment,
      p_allowed_emails: purchaseCodeRecipientFilter(config),
    },
  );
  if (error || !Array.isArray(data)) {
    throw new Error("purchase_email_queue_unavailable");
  }
  for (const row of data) {
    let outcome: SendOutcome = "failed";
    if (allowedActivationEmail(config, row.email)) {
      try {
        const code = generatePurchaseCode();
        const { data: issued, error: issueError } = await client.rpc(
          "commerce_issue_purchase_activation_code",
          {
            p_environment: config.stripeEnvironment,
            p_order_id: row.order_id,
            p_lease_token: row.lease_token,
            p_code_sha256: await purchaseCodeDigest(config, code),
          },
        );
        // Only a code durably issued under this lease is ever emailed.
        if (!issueError && issued === "issued") {
          outcome = "uncertain";
          const content = purchaseCodeEmail(formatPurchaseCode(code));
          outcome = await send(config, {
            to: row.email,
            from: config.privateActivationEmailFrom!,
            ...content,
            idempotencyKey: `gf-purchase-code/${row.lease_token}`,
          });
        }
      } catch {
        // Keep outcome: "failed" before issuance, "uncertain" once sending.
      }
    }
    try {
      const { data: completed, error: finishError } = await client.rpc(
        "commerce_complete_purchase_code_email",
        {
          p_order_id: row.order_id,
          p_lease_token: row.lease_token,
          p_status: outcome,
        },
      );
      if (finishError || completed !== true) {
        throw new Error("completion_failed");
      }
    } catch {
      // Keep the unresolved lease conservative and report degraded health, but
      // finish other already-claimed rows. Never send this row a second time.
      counts.uncertain += 1;
      counts.completionFailed += 1;
      continue;
    }
    counts[outcome] += 1;
  }
  return counts;
}
