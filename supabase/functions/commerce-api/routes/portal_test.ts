import { ApiError } from "../../_shared/http.ts";
import { parseRefundRequestInput, portalMe } from "./portal.ts";
import type { Session, User } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import { sessionCookieHeaders } from "../../_shared/auth.ts";
import { serviceClient } from "../../_shared/db.ts";
import { base64UrlEncode, utf8 } from "../../_shared/pure.ts";

function assert(
  condition: unknown,
  message = "assertion_failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertInvalid(body: Record<string, unknown>): void {
  try {
    parseRefundRequestInput(body);
  } catch (error) {
    assert(error instanceof ApiError);
    assert(error.status === 400);
    return;
  }
  throw new Error("expected_invalid_refund_request");
}

const validRequest = {
  sku: "gesture-flow-v3",
  orderId: "40000000-0000-4000-8000-000000000001",
  reason: "accidental",
  details: "  Duplicate purchase  ",
  licenseRevocationAcknowledged: true,
};

Deno.test("refund requests require and preserve the exact order identifier", () => {
  const parsed = parseRefundRequestInput(validRequest);
  assert(parsed.orderId === validRequest.orderId);
  assert(parsed.reason === "accidental");
  assert(parsed.details === "Duplicate purchase");

  const withoutOrder: Record<string, unknown> = { ...validRequest };
  delete withoutOrder.orderId;
  assertInvalid(withoutOrder);
  assertInvalid({ ...validRequest, orderId: "newest-order" });
  assertInvalid({ ...validRequest, unexpected: true });
});

Deno.test("portal device allowance excludes refunded, expired and future entitlements", async () => {
  const config = {
    supabaseUrl: "https://portal-fixture.example.test",
    supabaseAnonKey: "fixture-anon-key",
    supabaseServiceRoleKey: "fixture-service-key",
    stripeEnvironment: "test",
    contextHmacSecret: "fixture-context-secret-at-least-thirty-two-characters",
  } as CommerceConfig;
  const user = {
    id: "40000000-0000-4000-8000-000000000001",
    email: "buyer@example.test",
  } as User;
  const token = [
    base64UrlEncode(utf8(JSON.stringify({ alg: "ES256", typ: "JWT" }))),
    base64UrlEncode(utf8(JSON.stringify({
      sub: user.id,
      role: "authenticated",
      session_id: "70000000-0000-4000-8000-000000000001",
      amr: [{ method: "magiclink", timestamp: 1_720_000_000 }],
    }))),
    "fixture-signature",
  ].join(".");
  const cookies = await sessionCookieHeaders(config, {
    access_token: token,
    refresh_token: "fixture-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  } as Session);
  const request = () =>
    new Request("https://licenses.stuffbyrambo.com/v1/portal/me", {
      headers: {
        Cookie: cookies.getSetCookie().map((value) => value.split(";")[0]).join(
          "; ",
        ),
      },
    });
  const now = Date.now();
  const before = new Date(now - 86_400_000).toISOString();
  const after = new Date(now + 86_400_000).toISOString();
  const entitlement = (
    id: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    source: "purchase",
    status: "active",
    device_limit: 1,
    licensed_major: 3,
    valid_from: before,
    expires_at: null,
    ...overrides,
  });
  const inactive = [
    entitlement("refunded-purchase", { status: "refunded" }),
    entitlement("expired-trial", {
      source: "trial",
      device_limit: 2,
      expires_at: before,
    }),
    entitlement("future-purchase", { valid_from: after }),
  ];
  let entitlements = [entitlement("current-purchase"), ...inactive];
  // Refunding an entitlement can leave its activation row marked active.
  const devices = entitlements.map((item) => ({
    id: `device-${item.id}`,
    entitlement_id: item.id,
    status: "active",
    device_metadata: { deviceName: item.id },
  }));
  let deviceQueries = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/auth/v1/user") {
      return Promise.resolve(Response.json(user));
    }
    if (url.pathname === "/rest/v1/rpc/commerce_claim_account_entitlements") {
      return Promise.resolve(Response.json(null));
    }
    if (url.pathname === "/rest/v1/commerce_accounts") {
      return Promise.resolve(
        Response.json(method === "POST" ? null : { email: user.email }),
      );
    }
    if (url.pathname === "/rest/v1/commerce_offers") {
      return Promise.resolve(Response.json([{ id: "fixture-offer" }]));
    }
    if (url.pathname === "/rest/v1/commerce_entitlements") {
      return Promise.resolve(Response.json(entitlements));
    }
    if (url.pathname === "/rest/v1/commerce_orders") {
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname === "/rest/v1/commerce_device_activations") {
      deviceQueries++;
      assert(url.searchParams.get("account_id") === `eq.${user.id}`);
      assert(url.searchParams.get("status") === "eq.active");
      const filter = url.searchParams.get("entitlement_id") ?? "";
      const ids = filter.slice(4, -1).split(",").map((id) =>
        id.replaceAll('"', "")
      );
      return Promise.resolve(
        Response.json(
          devices.filter((device) => ids.includes(device.entitlement_id)),
        ),
      );
    }
    throw new Error(`unexpected_fixture_request:${url.pathname}`);
  };
  try {
    const client = serviceClient(config);
    const active = await portalMe(config, client, request());
    assert(
      JSON.stringify(active.body.deviceAllowance) ===
        JSON.stringify({ active: 1, limit: 1, remaining: 0 }),
      "refunded or invalid entitlements inflated the active device allowance",
    );
    const shownDevices = active.body.devices as { entitlementId: string }[];
    assert(shownDevices.length === 1);
    assert(shownDevices[0]?.entitlementId === "current-purchase");
    assert(
      (active.body.entitlements as unknown[]).length === 4,
      "historical entitlements must remain visible",
    );
    assert(deviceQueries === 1);

    entitlements = inactive;
    const inactiveOnly = await portalMe(config, client, request());
    assert(
      JSON.stringify(inactiveOnly.body.deviceAllowance) ===
        JSON.stringify({ active: 0, limit: 0, remaining: 0 }),
    );
    assert((inactiveOnly.body.devices as unknown[]).length === 0);
    assert(inactiveOnly.body.entitlement === null);
    assert(
      deviceQueries === 1,
      "no active entitlements should skip the device query",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
