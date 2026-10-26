import type { CommerceConfig } from "../../_shared/config.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../../_shared/http.ts";
import { redeemPurchaseCode, requestPurchaseCode } from "./purchase-codes.ts";
import {
  formatPurchaseCode,
  generatePurchaseCode,
  normalizePurchaseCode,
  processPurchaseCodeEmails,
  PURCHASE_CODE_ALPHABET,
  purchaseCodeDigest,
  type PurchaseCodeMessage,
} from "../../_shared/purchase-codes.ts";
import { purchaseCodeEmail } from "../../_shared/purchase-code-email.ts";
import {
  base64UrlEncode,
  hexDecode,
  verifyCompactJws,
} from "../../_shared/pure.ts";
import vector from "../../../../docs/commerce/device-proof-golden-vector.json" with {
  type: "json",
};

function assert(v: unknown, message = "assertion_failed"): asserts v {
  if (!v) throw new Error(message);
}
const email = "buyer@example.test";
const id = "00000000-0000-4000-8000-000000000010";
const otherChallenge = "00000000-0000-4000-8000-000000000011";
const rawCode = "7K3MQ9ZT4HVX2NRB";
const publicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: base64UrlEncode(hexDecode(vector.publicKeyRawHex)),
};
const config = {
  stripeEnvironment: "test",
  privatePurchaseCodesEnabled: true,
  privateActivationRecipients: [email],
  contextHmacSecret: "test-context-secret-test-context-secret",
  activationCodeHmacSecret: "test-activation-secret-test-activation",
  privateActivationEmailSendingEnabled: true,
  privateActivationEmailFrom: "Gesture Flow <licenses@example.test>",
  resendApiKey: "test-only-not-a-key",
  permitKeyId: "test-only",
  permitPrivateJwk: {
    ...publicJwk,
    d: base64UrlEncode(hexDecode(vector.privateKeySeedHex)),
  },
} as CommerceConfig;

function request(body: unknown, bearer: string | null = "A".repeat(43)) {
  return new Request("https://licenses.stuffbyrambo.com/v1/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-gf-client-ip-hmac": "f".repeat(64),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "active",
    activation_id: id,
    installation_id: id,
    account_id: null,
    entitlement_id: id,
    entitlement_source: "purchase",
    features: ["gesture-control"],
    device_limit: 1,
    entitlement_expires_at: null,
    ...overrides,
  };
}

// In-memory stand-in for the redeem RPC. The real locking and eligibility
// semantics are covered by supabase/tests/private_purchase_codes.sql.
function fakeDb(
  options: { outcome?: string; limited?: boolean; codes?: string[] } = {},
) {
  const calls: { name: string; args: unknown }[] = [];
  const codes = new Map<string, { challenge: string | null }>();
  for (const digest of options.codes ?? []) {
    codes.set(digest, { challenge: null });
  }
  const builder = {
    insert(args: unknown) {
      calls.push({ name: "insert", args });
      return Promise.resolve({ error: null });
    },
  };
  const client = {
    from() {
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "commerce_consume_rate_limit") {
        return Promise.resolve({
          data: [{ allowed: !options.limited, retry_after_seconds: 30 }],
          error: null,
        });
      }
      if (name === "commerce_redeem_purchase_code") {
        if (options.outcome) {
          return Promise.resolve({
            data: [{ outcome: options.outcome }],
            error: null,
          });
        }
        const code = codes.get(String(args.p_code_sha256));
        let outcome = "invalid_code";
        if (
          code &&
          (code.challenge ?? args.p_challenge_id) === args.p_challenge_id
        ) {
          code.challenge = String(args.p_challenge_id);
          outcome = "active";
        }
        return Promise.resolve({
          data: [outcome === "active" ? activeRow() : { outcome }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

async function rejection(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof ApiError, String(e));
    return e;
  }
  throw new Error("expected_rejection");
}

Deno.test("normalization accepts formatted, prefixed and confusable input", () => {
  const formatted = formatPurchaseCode(rawCode);
  assert(formatted === "GF-7K3M-Q9ZT-4HVX-2NRB");
  for (
    const input of [
      formatted,
      formatted.toLowerCase(),
      " gf 7k3m q9zt\t4hvx-2nrb\n",
      rawCode,
      "7K3M-Q9ZT-4HVX-2NRB",
    ]
  ) assert(normalizePurchaseCode(input) === rawCode, input);
  assert(
    normalizePurchaseCode("GF-0OIL-1111-2222-3333") === "0011111122223333",
  );
  // GF is stripped only from 18 characters: a bare code starting GF is intact.
  assert(normalizePurchaseCode("GF12-3456-7890-ABCD") === "GF1234567890ABCD");
  assert(
    normalizePurchaseCode("GF-GF12-3456-7890-ABCD") === "GF1234567890ABCD",
  );
  for (
    const bad of [
      "",
      "GF-7K3M-Q9ZT-4HVX",
      `${rawCode}0`,
      "UUUU-UUUU-UUUU-UUUU",
      "7K3M_Q9ZT_4HVX_2NRB",
      "7K3M.Q9ZT.4HVX.2NRB",
      "XX-7K3M-Q9ZT-4HVX-2NRB",
      "x".repeat(65),
    ]
  ) assert(normalizePurchaseCode(bad) === null, bad);
});

Deno.test("generated codes are 16 alphabet characters and differ", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = generatePurchaseCode();
    assert(code.length === 16);
    assert([...code].every((c) => PURCHASE_CODE_ALPHABET.includes(c)));
    assert(normalizePurchaseCode(formatPurchaseCode(code)) === code);
    seen.add(code);
  }
  assert(seen.size === 200);
});

Deno.test("digest is keyed, domain separated and formatting independent", async () => {
  const digest = await purchaseCodeDigest(config, rawCode);
  assert(/^[0-9a-f]{64}$/.test(digest));
  assert(!digest.includes(rawCode.toLowerCase()));
  assert(
    digest !== await purchaseCodeDigest(
      { ...config, activationCodeHmacSecret: "another-secret-another-secret" },
      rawCode,
    ),
  );
});

Deno.test("every invalid code reason returns the same generic error", async () => {
  const errors: ApiError[] = [];
  errors.push(
    await rejection(() =>
      redeemPurchaseCode(config, fakeDb().client, request({ code: "nope" }), id)
    ),
  );
  // Unknown, used elsewhere, revoked, refunded, wrong product/environment and
  // non-allowlisted all surface from the RPC as invalid_code.
  errors.push(
    await rejection(() =>
      redeemPurchaseCode(
        config,
        fakeDb({ outcome: "invalid_code" }).client,
        request({ code: formatPurchaseCode(rawCode) }),
        id,
      )
    ),
  );
  for (const e of errors) {
    assert(e.status === 400 && e.code === "invalid_purchase_code");
    assert(e.message === errors[0]!.message && !e.retryable && !e.details);
    assert(!e.message.includes(rawCode));
  }
});

Deno.test("redeem passes only the keyed digest and returns a one-Mac purchase permit", async () => {
  const digest = await purchaseCodeDigest(config, rawCode);
  const db = fakeDb({ codes: [digest] });
  const output = await redeemPurchaseCode(
    config,
    db.client,
    request({ code: "gf-7k3m-q9zt-4hvx-2nrb" }),
    id,
  );
  assert(
    Object.keys(output).sort().join(",") ===
      "activationId,permit,permitExpiresAt",
  );
  const permit = await verifyCompactJws(
    String(output.permit),
    "GF-PERMIT",
    publicJwk,
  );
  assert(permit.payload.entitlementType === "purchase");
  assert(permit.payload.deviceLimit === 1);
  assert(permit.payload.installationId === id);
  const redeem = db.calls.find((c) =>
    c.name === "commerce_redeem_purchase_code"
  )!.args as Record<string, unknown>;
  assert(redeem.p_code_sha256 === digest);
  assert(
    JSON.stringify(redeem.p_allowed_emails) === JSON.stringify([email]),
  );
  assert(!JSON.stringify(db.calls).includes(rawCode));
});

Deno.test("single use: same challenge retry is idempotent, other challenge rejected", async () => {
  const digest = await purchaseCodeDigest(config, rawCode);
  const db = fakeDb({ codes: [digest] });
  const first = await redeemPurchaseCode(
    config,
    db.client,
    request({ code: rawCode }),
    id,
  );
  const retry = await redeemPurchaseCode(
    config,
    db.client,
    request({ code: formatPurchaseCode(rawCode) }),
    id,
  );
  assert(first.activationId === retry.activationId);
  const reuse = await rejection(() =>
    redeemPurchaseCode(
      config,
      db.client,
      request({ code: rawCode }),
      otherChallenge,
    )
  );
  assert(reuse.code === "invalid_purchase_code");
});

Deno.test("redeem maps conflicts, limits and challenge errors to existing codes", async () => {
  const cases: [string, number, string][] = [
    ["device_key_conflict", 409, "device_key_conflict"],
    ["already_activated", 409, "already_activated"],
    ["device_limit", 403, "device_limit_reached"],
    ["expired", 400, "expired_token"],
    ["invalid", 401, "invalid_token"],
    ["challenge_used", 401, "invalid_token"],
  ];
  for (const [outcome, status, code] of cases) {
    const e = await rejection(() =>
      redeemPurchaseCode(
        config,
        fakeDb({ outcome }).client,
        request({ code: rawCode }),
        id,
      )
    );
    assert(e.status === status && e.code === code, `${outcome}:${e.code}`);
  }
  const noBearer = await rejection(() =>
    redeemPurchaseCode(
      config,
      fakeDb().client,
      request({ code: rawCode }, null),
      id,
    )
  );
  assert(noBearer.code === "invalid_token");
  const limited = await rejection(() =>
    redeemPurchaseCode(
      config,
      fakeDb({ limited: true }).client,
      request({ code: rawCode }),
      id,
    )
  );
  assert(limited.code === "rate_limited" && limited.details?.retryAfter === 30);
  const extra = await rejection(() =>
    redeemPurchaseCode(
      config,
      fakeDb().client,
      request({ code: rawCode, email }),
      id,
    )
  );
  assert(extra.code === "unexpected_field");
  const missing = await rejection(() =>
    redeemPurchaseCode(config, fakeDb().client, request({}), id)
  );
  assert(missing.code === "invalid_request");
});

Deno.test("private gate hides redeem and resend endpoints", async () => {
  for (
    const c of [{ ...config, stripeEnvironment: "live" }, {
      ...config,
      privatePurchaseCodesEnabled: false,
    }, { ...config, privateActivationRecipients: [] }]
  ) {
    for (
      const fn of [
        () =>
          requestPurchaseCode(
            c as CommerceConfig,
            fakeDb().client,
            request({ email }),
          ),
        () =>
          redeemPurchaseCode(
            c as CommerceConfig,
            fakeDb().client,
            request({ code: rawCode }),
            id,
          ),
      ]
    ) assert((await rejection(fn)).code === "not_found");
  }
});

Deno.test("resend is generic and queues only for allowlisted emails", async () => {
  const outsider = fakeDb();
  const response = await requestPurchaseCode(
    config,
    outsider.client,
    request({ email: "unknown@example.test" }),
  );
  assert(response.accepted === true);
  assert(
    !outsider.calls.some((c) =>
      c.name === "commerce_request_purchase_code_email"
    ),
  );
  const buyer = fakeDb();
  assert(
    (await requestPurchaseCode(config, buyer.client, request({ email })))
      .accepted,
  );
  assert(
    buyer.calls.some((c) => c.name === "commerce_request_purchase_code_email"),
  );
});

function workerClient(
  issueResult: string | Error,
  rows = [{ email, order_id: id, lease_token: id }],
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "commerce_claim_purchase_code_emails") {
        return Promise.resolve({ data: rows, error: null });
      }
      if (name === "commerce_issue_purchase_activation_code") {
        if (issueResult instanceof Error) return Promise.reject(issueResult);
        return Promise.resolve({ data: issueResult, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

Deno.test("sending fails closed when disabled, unconfigured or not test", async () => {
  for (
    const c of [
      { ...config, privateActivationEmailSendingEnabled: false },
      { ...config, resendApiKey: undefined },
      { ...config, privateActivationEmailFrom: undefined },
      { ...config, stripeEnvironment: "live" },
      { ...config, privateActivationRecipients: [] },
    ]
  ) {
    const db = workerClient("issued");
    let sent = 0;
    const result = await processPurchaseCodeEmails(
      c as CommerceConfig,
      db.client,
      () => {
        sent++;
        return Promise.resolve("sent");
      },
    );
    assert(sent === 0 && db.calls.length === 0);
    assert(result.sent + result.failed + result.uncertain === 0);
  }
});

Deno.test("worker issues digest first, emails the raw code once, never leaks it", async () => {
  const db = workerClient("issued");
  const messages: PurchaseCodeMessage[] = [];
  const logged: string[] = [];
  const originals = { ...console };
  console.log =
    console.info =
    console.warn =
    console.error =
      (
        ...args: unknown[]
      ) => logged.push(args.map(String).join(" "));
  let result;
  try {
    result = await processPurchaseCodeEmails(
      config,
      db.client,
      (_c, message) => {
        messages.push(message);
        return Promise.resolve("sent");
      },
    );
  } finally {
    Object.assign(console, originals);
  }
  assert(result.sent === 1 && messages.length === 1);
  const message = messages[0]!;
  const shown = /GF(-[0-9A-Z]{4}){4}/.exec(message.text)?.[0];
  assert(shown && message.html.includes(shown));
  const code = normalizePurchaseCode(shown)!;
  assert(message.to === email && message.idempotencyKey.endsWith(id));
  const issue = db.calls.find((c) =>
    c.name === "commerce_issue_purchase_activation_code"
  )!;
  assert(issue.args.p_code_sha256 === await purchaseCodeDigest(config, code));
  assert(!JSON.stringify(db.calls).includes(code));
  assert(!JSON.stringify(result).includes(code));
  assert(logged.length === 0);
  const order = db.calls.map((c) => c.name).join(",");
  assert(
    order ===
      "commerce_claim_purchase_code_emails,commerce_issue_purchase_activation_code,commerce_complete_purchase_code_email",
  );
});

Deno.test("used or ineligible purchases are never emailed; issue errors fail without send", async () => {
  for (
    const issue of [
      "already_used",
      "not_eligible",
      "lease_lost",
      new Error("db"),
    ]
  ) {
    const db = workerClient(issue);
    let sent = 0;
    const result = await processPurchaseCodeEmails(config, db.client, () => {
      sent++;
      return Promise.resolve("sent");
    });
    assert(sent === 0 && result.failed === 1);
    const done = db.calls.at(-1)!;
    assert(done.name === "commerce_complete_purchase_code_email");
    assert(done.args.p_status === "failed");
  }
});

Deno.test("send outcomes are recorded once; uncertain and throws are not retried", async () => {
  for (const outcome of ["sent", "failed", "uncertain", "throws"] as const) {
    const db = workerClient("issued");
    let sends = 0;
    const result = await processPurchaseCodeEmails(config, db.client, () => {
      sends++;
      if (outcome === "throws") {
        return Promise.reject(new Error(`provider said ${rawCode}`));
      }
      return Promise.resolve(outcome);
    });
    const expected = outcome === "throws" ? "uncertain" : outcome;
    assert(sends === 1 && result[expected] === 1);
    assert(db.calls.at(-1)!.args.p_status === expected);
    assert(!JSON.stringify(db.calls).includes(rawCode));
  }
});

Deno.test("unexpected recipient is never sent and does not abandon allowed rows", async () => {
  const db = workerClient("issued", [
    { email: "unknown@example.test", order_id: id, lease_token: id },
    { email, order_id: id, lease_token: id },
  ]);
  const sent: string[] = [];
  const result = await processPurchaseCodeEmails(config, db.client, (_c, m) => {
    sent.push(m.to);
    return Promise.resolve("sent");
  });
  assert(sent.join(",") === email);
  assert(
    db.calls.filter((c) => c.name === "commerce_issue_purchase_activation_code")
      .length === 1,
  );
  assert(result.sent === 1 && result.failed === 1);
});

Deno.test("completion failure does not abandon later claimed emails or resend", async () => {
  for (const throws of [false, true]) {
    let completions = 0;
    let sends = 0;
    const client = {
      rpc(name: string) {
        if (name === "commerce_claim_purchase_code_emails") {
          return Promise.resolve({
            data: [1, 2].map(() => ({ email, order_id: id, lease_token: id })),
            error: null,
          });
        }
        if (name === "commerce_issue_purchase_activation_code") {
          return Promise.resolve({ data: "issued", error: null });
        }
        completions++;
        if (completions === 1) {
          if (throws) return Promise.reject(new Error("transport failed"));
          return Promise.resolve({ data: false, error: {} });
        }
        return Promise.resolve({ data: true, error: null });
      },
    } as unknown as SupabaseClient;
    const result = await processPurchaseCodeEmails(config, client, () => {
      sends++;
      return Promise.resolve("sent");
    });
    assert(sends === 2 && completions === 2);
    assert(
      result.sent === 1 && result.uncertain === 1 &&
        result.completionFailed === 1,
    );
  }
});

Deno.test("purchase email explains single use and moving to a new Mac", () => {
  const formatted = formatPurchaseCode(rawCode);
  const email = purchaseCodeEmail(formatted);
  for (const body of [email.html, email.text]) {
    assert(body.includes(formatted));
    assert(body.includes("https://stuffbyrambo.com/license/"));
    assert(body.includes("deactivate the old Mac"));
    assert(body.includes("one Mac"));
  }
  let rejected = false;
  try {
    purchaseCodeEmail("<script>");
  } catch {
    rejected = true;
  }
  assert(rejected);
});

// Production mode: live Stripe plus the explicit live flags, no allowlist.
const liveConfig = {
  ...config,
  stripeEnvironment: "live",
  privatePurchaseCodesEnabled: false,
  privateActivationEmailSendingEnabled: false,
  privateActivationRecipients: [],
  livePurchaseCodesEnabled: true,
  livePurchaseCodeEmailSendingEnabled: true,
} as CommerceConfig;

Deno.test("live mode passes a null recipient filter and serves any buyer", async () => {
  const other = "stranger@example.test";
  const db = fakeDb();
  assert(
    (await requestPurchaseCode(
      liveConfig,
      db.client,
      request({ email: other }),
    ))
      .accepted === true,
  );
  assert(
    db.calls.some((c) => c.name === "commerce_request_purchase_code_email"),
  );
  const digest = await purchaseCodeDigest(liveConfig, rawCode);
  const redeemDb = fakeDb({ codes: [digest] });
  await redeemPurchaseCode(
    liveConfig,
    redeemDb.client,
    request({ code: formatPurchaseCode(rawCode) }),
    id,
  );
  const call = redeemDb.calls.find((c) =>
    c.name === "commerce_redeem_purchase_code"
  );
  assert((call?.args as Record<string, unknown>).p_allowed_emails === null);

  const worker = workerClient("issued", [
    { email: other, order_id: id, lease_token: id },
  ]);
  let sent = 0;
  const result = await processPurchaseCodeEmails(
    liveConfig,
    worker.client,
    () => {
      sent++;
      return Promise.resolve("sent");
    },
  );
  assert(sent === 1 && result.sent === 1);
  assert(worker.calls[0]!.args.p_allowed_emails === null);
});

Deno.test("live canary keeps an allowlist; test mode never sends null", async () => {
  const canary = { ...liveConfig, livePurchaseCodeCanaryRecipients: [email] };
  const db = fakeDb();
  await requestPurchaseCode(
    canary,
    db.client,
    request({ email: "x@example.test" }),
  );
  assert(
    !db.calls.some((c) => c.name === "commerce_request_purchase_code_email"),
  );
  const worker = workerClient("issued");
  await processPurchaseCodeEmails(
    canary,
    worker.client,
    () => Promise.resolve("sent"),
  );
  assert(
    JSON.stringify(worker.calls[0]!.args.p_allowed_emails) ===
      JSON.stringify([email]),
  );
  const testWorker = workerClient("issued");
  await processPurchaseCodeEmails(
    config,
    testWorker.client,
    () => Promise.resolve("sent"),
  );
  assert(
    JSON.stringify(testWorker.calls[0]!.args.p_allowed_emails) ===
      JSON.stringify([email]),
  );
});

Deno.test("live gates fail closed: flags off, wrong environment, or no sender", async () => {
  for (
    const c of [
      { ...liveConfig, livePurchaseCodesEnabled: false },
      { ...liveConfig, stripeEnvironment: "test" },
      // Private sandbox flags never unlock live purchases.
      {
        ...liveConfig,
        livePurchaseCodesEnabled: false,
        privatePurchaseCodesEnabled: true,
        privateActivationRecipients: [email],
      },
    ]
  ) {
    const error = await rejection(() =>
      requestPurchaseCode(
        c as CommerceConfig,
        fakeDb().client,
        request({ email }),
      )
    );
    assert(error.status === 404);
  }
  for (
    const c of [
      { ...liveConfig, livePurchaseCodeEmailSendingEnabled: false },
      { ...liveConfig, resendApiKey: undefined },
      { ...liveConfig, privateActivationEmailFrom: undefined },
      // The sandbox sending flag does not enable live sending.
      {
        ...liveConfig,
        livePurchaseCodeEmailSendingEnabled: false,
        privateActivationEmailSendingEnabled: true,
      },
    ]
  ) {
    const db = workerClient("issued");
    await processPurchaseCodeEmails(
      c as CommerceConfig,
      db.client,
      () => Promise.resolve("sent"),
    );
    assert(db.calls.length === 0);
  }
});

Deno.test("every purchase-code RPC carries the configured environment", async () => {
  for (const c of [config, liveConfig]) {
    const db = fakeDb({ codes: [await purchaseCodeDigest(c, rawCode)] });
    await requestPurchaseCode(c, db.client, request({ email }));
    await redeemPurchaseCode(c, db.client, request({ code: rawCode }), id);
    const worker = workerClient("issued");
    await processPurchaseCodeEmails(
      c,
      worker.client,
      () => Promise.resolve("sent"),
    );
    const purchaseCalls = [...db.calls, ...worker.calls].filter((call) =>
      [
        "commerce_request_purchase_code_email",
        "commerce_redeem_purchase_code",
        "commerce_claim_purchase_code_emails",
        "commerce_issue_purchase_activation_code",
      ].includes(call.name)
    );
    assert(purchaseCalls.length === 4, String(purchaseCalls.length));
    for (const call of purchaseCalls) {
      assert(
        (call.args as Record<string, unknown>).p_environment ===
          c.stripeEnvironment,
        call.name,
      );
    }
  }
});
