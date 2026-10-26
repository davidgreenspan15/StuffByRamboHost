import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import { authClient } from "../../_shared/db.ts";
import {
  clearSessionCookieHeaders,
  portalAuth,
  requireCsrf,
  sessionCookieHeaders,
} from "../../_shared/auth.ts";
import {
  ApiError,
  preserveResponseHeaders,
  readJson,
  requireSameSiteMutation,
} from "../../_shared/http.ts";
import {
  abortIdempotency,
  beginIdempotency,
  finishIdempotency,
  finishIdempotentError,
  idempotencyKey,
} from "../../_shared/idempotency.ts";
import {
  hmacSha256Hex,
  normalizeActivationCode,
  sha256Hex,
} from "../../_shared/pure.ts";
import {
  consumeRateLimit,
  privateRateLimitKey,
  trustedIpHmac,
} from "../../_shared/rate-limit.ts";
import {
  booleanTrueField,
  exactKeys,
  objectField,
  stringField,
  uuidField,
  uuidPath,
} from "../../_shared/validation.ts";

export interface PortalRouteResult {
  body: Record<string, unknown>;
  status?: number;
  headers: Headers;
}

export interface RefundRequestInput {
  orderId: string;
  reason: "compatibility" | "technical" | "accidental" | "other";
  details: string;
}

export function parseRefundRequestInput(
  body: Record<string, unknown>,
): RefundRequestInput {
  exactKeys(body, [
    "sku",
    "orderId",
    "reason",
    "details",
    "licenseRevocationAcknowledged",
  ]);
  stringField(body, "sku", { pattern: /^gesture-flow-v3$/ });
  const orderId = uuidField(body, "orderId");
  const reason = stringField(body, "reason", {
    pattern: /^(compatibility|technical|accidental|other)$/,
  }) as RefundRequestInput["reason"];
  const details = typeof body.details === "string"
    ? body.details.trim().slice(0, 1000)
    : "";
  booleanTrueField(body, "licenseRevocationAcknowledged");
  return { orderId, reason, details };
}

async function authenticated(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<{ user: User; headers: Headers }> {
  const auth = await portalAuth(config, request);
  preserveResponseHeaders(request, auth.responseHeaders);
  if (!auth.user.email) {
    throw new ApiError(403, "email_required", "A verified email is required.");
  }
  const email = auth.user.email.trim().toLowerCase();
  const { error: accountError } = await client.from("commerce_accounts").upsert(
    {
      id: auth.user.id,
      email,
    },
    { onConflict: "id" },
  );
  if (accountError) {
    throw new ApiError(
      503,
      "account_unavailable",
      "License account is temporarily unavailable.",
      true,
    );
  }
  const { error: claimError } = await client.rpc(
    "commerce_claim_account_entitlements",
    {
      p_account_id: auth.user.id,
    },
  );
  if (claimError) {
    throw new ApiError(
      503,
      "account_claim_failed",
      "Purchases could not be loaded safely.",
      true,
    );
  }
  return { user: auth.user, headers: auth.responseHeaders };
}

export async function requestMagicLink(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<PortalRouteResult> {
  requireSameSiteMutation(config, request);
  const body = await readJson(request, 4096);
  exactKeys(body, ["email"]);
  const email = stringField(body, "email", {
    min: 3,
    max: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  }).trim().toLowerCase();
  const ipHmac = trustedIpHmac(request);
  const emailHmac = await privateRateLimitKey(config, "email", email);
  await Promise.all([
    consumeRateLimit(client, {
      bucket: "magic_link.ip",
      limit: 5,
      windowSeconds: 900,
    }, ipHmac),
    consumeRateLimit(client, {
      bucket: "magic_link.email",
      limit: 3,
      windowSeconds: 900,
    }, emailHmac),
  ]);

  const auth = authClient(config);
  const { error: deliveryError } = await auth.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${config.siteOrigin}/license/`,
    },
  });
  await client.from("commerce_audit_log").insert({
    actor_type: "system",
    actor_id: emailHmac,
    action: deliveryError
      ? "portal.magic_link_delivery_failed"
      : "portal.magic_link_requested",
    target_type: "commerce_account",
    context: { ipHmac, providerAccepted: !deliveryError },
  });
  return { body: { accepted: true }, status: 202, headers: new Headers() };
}

export async function createPortalSession(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<PortalRouteResult> {
  requireSameSiteMutation(config, request);
  await consumeRateLimit(
    client,
    { bucket: "portal_session.ip", limit: 10, windowSeconds: 900 },
    trustedIpHmac(request),
  );
  const body = await readJson(request, 4096);
  exactKeys(body, ["tokenHash", "type"]);
  const tokenHash = stringField(body, "tokenHash", {
    min: 32,
    max: 256,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
  const type = stringField(body, "type", { pattern: /^email$/ });
  const auth = authClient(config);
  const { data, error } = await auth.auth.verifyOtp({
    token_hash: tokenHash,
    type: type as "email",
  });
  if (error || !data.session || !data.user) {
    throw new ApiError(
      401,
      "invalid_or_expired_link",
      "This sign-in link is invalid or expired.",
    );
  }
  if (!data.user.email) {
    throw new ApiError(403, "email_required", "A verified email is required.");
  }
  const { error: accountError } = await client.from("commerce_accounts").upsert(
    {
      id: data.user.id,
      email: data.user.email.trim().toLowerCase(),
    },
    { onConflict: "id" },
  );
  if (accountError) {
    throw new ApiError(
      503,
      "account_unavailable",
      "License account is temporarily unavailable.",
      true,
    );
  }
  return {
    body: { authenticated: true },
    headers: await sessionCookieHeaders(config, data.session),
  };
}

export async function deletePortalSession(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<PortalRouteResult> {
  await requireCsrf(config, request);
  try {
    const auth = await portalAuth(config, request);
    const { error } = await client.auth.admin.signOut(
      auth.accessToken,
      "local",
    );
    if (error) {
      await client.from("commerce_audit_log").insert({
        actor_type: "system",
        actor_id: auth.user.id,
        action: "portal.logout_revocation_failed",
        target_type: "commerce_account",
        target_id: auth.user.id,
      });
    }
  } catch {
    // Stale server sessions must not prevent host-only cookies from clearing.
  }
  return { body: { signedOut: true }, headers: clearSessionCookieHeaders() };
}

export async function portalMe(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<PortalRouteResult> {
  const { user, headers } = await authenticated(config, client, request);
  const { data: offer, error: offerError } = await client.from(
    "commerce_offers",
  )
    .select("id").eq("code", "gesture-flow-v3").eq(
      "environment",
      config.stripeEnvironment,
    )
    .maybeSingle();
  if (offerError || !offer) {
    throw new ApiError(
      503,
      "portal_unavailable",
      "License account is temporarily unavailable.",
      true,
    );
  }
  const [accountResult, ordersResult, entitlementsResult] = await Promise.all([
    client.from("commerce_accounts").select("email").eq("id", user.id).single(),
    client.from("commerce_orders")
      .select("id,status,currency,amount_total,paid_at,refund_eligible_until")
      .eq("account_id", user.id).eq("offer_id", offer.id)
      .order("paid_at", { ascending: false }),
    client.from("commerce_entitlements")
      .select(
        "id,source,product_slug,edition,licensed_major,status,device_limit,features,valid_from,expires_at,created_at",
      )
      .eq("account_id", user.id).eq("product_slug", "gesture-flow")
      .eq("edition", "python-mediapipe").eq("licensed_major", 3)
      .order("created_at", { ascending: false }),
  ]);
  if (
    accountResult.error || ordersResult.error || entitlementsResult.error ||
    !accountResult.data
  ) {
    throw new ApiError(
      503,
      "portal_unavailable",
      "License account is temporarily unavailable.",
      true,
    );
  }
  const entitlements = entitlementsResult.data ?? [];
  const now = new Date();
  const activeEntitlements = entitlements.filter((entitlement) =>
    entitlement.status === "active" &&
    new Date(entitlement.valid_from) <= now &&
    (!entitlement.expires_at || new Date(entitlement.expires_at) > now)
  );
  const entitlementIds = activeEntitlements.map((entitlement) =>
    entitlement.id
  );
  const orderIds = (ordersResult.data ?? []).map((order) => order.id);
  const devicesResult = entitlementIds.length > 0
    ? await client.from("commerce_device_activations")
      .select(
        "id,entitlement_id,installation_id,device_metadata,status,activated_at,last_seen_at",
      )
      .eq("account_id", user.id).eq("status", "active").in(
        "entitlement_id",
        entitlementIds,
      )
      .order("last_seen_at", { ascending: false })
    : { data: [], error: null };
  const refundsResult = orderIds.length > 0
    ? await client.from("commerce_refund_requests")
      .select("id,order_id,reason_category,status,created_at,updated_at")
      .eq("account_id", user.id).in("order_id", orderIds)
      .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (devicesResult.error || refundsResult.error) {
    throw new ApiError(
      503,
      "portal_unavailable",
      "License account is temporarily unavailable.",
      true,
    );
  }
  const activeEntitlement = activeEntitlements[0];
  const activeDeviceCount = devicesResult.data?.length ?? 0;
  const aggregateDeviceLimit = activeEntitlements.reduce(
    (total, entitlement) => total + Number(entitlement.device_limit),
    0,
  );
  const trialEverUsed = entitlements.some((entitlement) =>
    entitlement.source === "trial"
  );
  const purchaseEverOwned = entitlements.some((entitlement) =>
    entitlement.source === "purchase" || entitlement.source === "admin"
  );
  return {
    headers,
    body: {
      account: { email: accountResult.data.email },
      entitlement: activeEntitlement
        ? {
          id: activeEntitlement.id,
          type: activeEntitlement.source === "trial" ? "trial" : "purchase",
          status: activeEntitlement.status,
          displayStatus: activeEntitlement.source === "trial"
            ? `Trial active through ${
              new Date(activeEntitlement.expires_at).toLocaleDateString("en-US")
            }`
            : "Gesture Flow v3 perpetual license",
          licensedMajor: activeEntitlement.licensed_major,
          expiresAt: activeEntitlement.expires_at,
        }
        : null,
      deviceAllowance: {
        active: activeDeviceCount,
        limit: aggregateDeviceLimit,
        remaining: Math.max(0, aggregateDeviceLimit - activeDeviceCount),
      },
      entitlements,
      trialEligible: !trialEverUsed && !purchaseEverOwned && !activeEntitlement,
      orders: ordersResult.data ?? [],
      devices: (devicesResult.data ?? []).map((device) => {
        const metadata = (device.device_metadata ?? {}) as Record<
          string,
          unknown
        >;
        return {
          id: device.id,
          entitlementId: device.entitlement_id,
          name: typeof metadata.deviceName === "string"
            ? metadata.deviceName
            : "Mac",
          appVersion: typeof metadata.appVersion === "string"
            ? metadata.appVersion
            : undefined,
          platform: metadata.platform,
          activatedAt: device.activated_at,
          lastSeenAt: device.last_seen_at,
        };
      }),
      refundRequests: refundsResult.data ?? [],
    },
  };
}

export async function approveActivation(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
  codeValue: string,
): Promise<PortalRouteResult> {
  await requireCsrf(config, request);
  const { user, headers } = await authenticated(config, client, request);
  const ipHmac = trustedIpHmac(request);
  await Promise.all([
    consumeRateLimit(client, {
      bucket: "activation_approval.ip",
      limit: 10,
      windowSeconds: 600,
    }, ipHmac),
    consumeRateLimit(
      client,
      { bucket: "activation_approval.account", limit: 10, windowSeconds: 600 },
      await privateRateLimitKey(config, "account", user.id),
    ),
  ]);
  let code: string;
  try {
    code = normalizeActivationCode(codeValue);
  } catch {
    throw new ApiError(
      404,
      "activation_not_found",
      "Activation request is invalid or expired.",
    );
  }
  const body = await readJson(request, 4096);
  exactKeys(body, ["policySetVersion", "acceptances"]);
  const policySetVersion = stringField(body, "policySetVersion", {
    min: 8,
    max: 100,
  });
  const acceptances = objectField(body, "acceptances");
  exactKeys(acceptances, ["terms", "compatibility"]);
  booleanTrueField(acceptances, "terms");
  booleanTrueField(acceptances, "compatibility");
  const { data: currentOffer, error: offerError } = await client
    .from("commerce_offers")
    .select("current_policy_set_id")
    .eq("code", "gesture-flow-v3")
    .eq("environment", config.stripeEnvironment)
    .maybeSingle();
  if (offerError || !currentOffer) {
    throw new ApiError(
      503,
      "policy_unavailable",
      "Current license terms are unavailable.",
      true,
    );
  }
  const { data: policySet, error: policyError } = await client
    .from("commerce_policy_sets")
    .select("id,published_at,retired_at")
    .eq("id", currentOffer.current_policy_set_id)
    .eq("version", policySetVersion)
    .lte("published_at", new Date().toISOString())
    .maybeSingle();
  if (
    policyError || !policySet ||
    (policySet.retired_at && new Date(policySet.retired_at) <= new Date())
  ) {
    throw new ApiError(
      409,
      "policy_changed",
      "License terms changed. Reload and review them again.",
    );
  }
  const requestHash = await sha256Hex(
    JSON.stringify({ code, policySetVersion, acceptances }),
  );
  const handle = await beginIdempotency(client, {
    operation: "portal.activation_approval",
    key: idempotencyKey(request),
    accountId: user.id,
    requestSha256: requestHash,
  });
  if (handle.replay) {
    return { body: handle.replay.body, status: handle.replay.status, headers };
  }

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 1000);
  const codeHmac = await hmacSha256Hex(config.activationCodeHmacSecret, code);
  const { data, error } = await client.rpc("commerce_approve_activation", {
    p_account_id: user.id,
    p_code_hmac: codeHmac,
    p_environment: config.stripeEnvironment,
    p_policy_set_id: policySet.id,
    p_terms_accepted: true,
    p_compatibility_accepted: true,
    p_ip_hmac: ipHmac,
    p_user_agent_sha256: userAgent ? await sha256Hex(userAgent) : null,
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    const { data: recovered } = await client
      .from("commerce_device_activation_challenges")
      .select("status,account_id,entitlement_id")
      .eq("code_hmac", codeHmac)
      .maybeSingle();
    if (
      recovered && recovered.account_id === user.id &&
      ["approved", "consumed"].includes(recovered.status)
    ) {
      const { data: entitlement } = await client.from("commerce_entitlements")
        .select("source,expires_at").eq("id", recovered.entitlement_id)
        .maybeSingle();
      if (entitlement) {
        const response = {
          approved: true,
          entitlementType: entitlement.source === "trial"
            ? "trial"
            : "purchase",
          entitlementExpiresAt: entitlement.expires_at ?? null,
          trialStarted: false,
        };
        await finishIdempotency(client, handle, 200, response);
        return { body: response, headers };
      }
    }
    if (recovered?.status === "pending") {
      await abortIdempotency(client, handle, user.id);
      throw new ApiError(
        503,
        "activation_unavailable",
        "Activation could not be approved safely.",
        true,
      );
    }
    return await finishIdempotentError(
      client,
      handle,
      new ApiError(
        503,
        "activation_unavailable",
        "Activation could not be approved safely.",
        true,
      ),
    );
  }
  const row = data[0] as {
    outcome: string;
    entitlement_type?: string;
    entitlement_expires_at?: string;
    trial_started?: boolean;
  };
  if (row.outcome !== "approved") {
    const expired = row.outcome === "trial_expired";
    const inactivePurchase = row.outcome === "purchase_inactive";
    const deviceLimit = row.outcome === "device_limit";
    return await finishIdempotentError(
      client,
      handle,
      new ApiError(
        deviceLimit ? 409 : expired || inactivePurchase ? 403 : 404,
        expired
          ? "trial_already_used"
          : inactivePurchase
          ? "license_revoked"
          : deviceLimit
          ? "device_limit_reached"
          : "activation_not_found",
        deviceLimit
          ? "All device slots on this account are in use. Deactivate a Mac in the license portal and try again."
          : inactivePurchase
          ? "This account has a purchase that is no longer active. Contact support if you believe this is an error."
          : expired
          ? "The one-time trial for this account has already ended. Purchase Gesture Flow to continue."
          : "Activation request is invalid or expired.",
      ),
    );
  }
  const response = {
    approved: true,
    entitlementType: row.entitlement_type,
    entitlementExpiresAt: row.entitlement_expires_at ?? null,
    trialStarted: row.trial_started === true,
  };
  await finishIdempotency(client, handle, 200, response);
  return { body: response, headers };
}

export async function requestRefund(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
): Promise<PortalRouteResult> {
  await requireCsrf(config, request);
  const { user, headers } = await authenticated(config, client, request);
  await consumeRateLimit(
    client,
    { bucket: "refund.account", limit: 5, windowSeconds: 86_400 },
    await privateRateLimitKey(config, "account", user.id),
  );
  const body = await readJson(request, 4096);
  const { orderId, reason, details } = parseRefundRequestInput(body);
  const { data: offer, error: offerError } = await client.from(
    "commerce_offers",
  )
    .select("id").eq("code", "gesture-flow-v3").eq(
      "environment",
      config.stripeEnvironment,
    )
    .maybeSingle();
  if (offerError || !offer) {
    throw new ApiError(
      404,
      "refundable_order_not_found",
      "No refundable Gesture Flow order was found.",
    );
  }
  const { data: order, error: orderError } = await client
    .from("commerce_orders")
    .select("id,status,refund_eligible_until")
    .eq("id", orderId)
    .eq("account_id", user.id)
    .eq("offer_id", offer.id)
    .in("status", ["paid", "suspended_refund"])
    .maybeSingle();
  if (orderError || !order) {
    throw new ApiError(
      404,
      "refundable_order_not_found",
      "No refundable Gesture Flow order was found.",
    );
  }
  if (new Date(order.refund_eligible_until) < new Date()) {
    throw new ApiError(
      409,
      "refund_window_closed",
      "The standard refund window has ended. Contact support if mandatory legal rights apply.",
    );
  }
  const requestHash = await sha256Hex(
    JSON.stringify({ orderId, reason, details, acknowledged: true }),
  );
  const handle = await beginIdempotency(client, {
    operation: "portal.refund_request",
    key: idempotencyKey(request),
    accountId: user.id,
    requestSha256: requestHash,
  });
  if (handle.replay) {
    return { body: handle.replay.body, status: handle.replay.status, headers };
  }
  const { data: refundRequest, error: refundError } = await client
    .from("commerce_refund_requests")
    .insert({
      account_id: user.id,
      order_id: order.id,
      reason_category: reason,
      customer_note: details || null,
      status: "requested",
    })
    .select("id,status,created_at")
    .single();
  if (refundError || !refundRequest) {
    const { data: recovered } = await client.from("commerce_refund_requests")
      .select("id,status,created_at").eq("account_id", user.id).eq(
        "order_id",
        order.id,
      )
      .in("status", ["requested", "reviewing", "approved"]).maybeSingle();
    if (recovered) {
      const response = {
        requestId: recovered.id,
        orderId: order.id,
        status: recovered.status,
        createdAt: recovered.created_at,
      };
      await finishIdempotency(client, handle, 202, response);
      return { body: response, status: 202, headers };
    }
    await abortIdempotency(client, handle, user.id);
    throw new ApiError(
      503,
      "refund_request_unavailable",
      "Refund request could not be recorded.",
      true,
    );
  }
  const response = {
    requestId: refundRequest.id,
    orderId: order.id,
    status: refundRequest.status,
    createdAt: refundRequest.created_at,
  };
  await finishIdempotency(client, handle, 202, response);
  return { body: response, status: 202, headers };
}

export async function deactivatePortalDevice(
  config: CommerceConfig,
  client: SupabaseClient,
  request: Request,
  activationIdValue: string,
): Promise<PortalRouteResult> {
  await requireCsrf(config, request);
  const { user, headers } = await authenticated(config, client, request);
  const activationId = uuidPath(activationIdValue);
  const body = await readJson(request, 1024);
  exactKeys(body, []);
  const requestHash = await sha256Hex(JSON.stringify({ activationId }));
  const handle = await beginIdempotency(client, {
    operation: "portal.device_deactivation",
    key: idempotencyKey(request),
    accountId: user.id,
    requestSha256: requestHash,
  });
  if (handle.replay) {
    return { body: handle.replay.body, status: handle.replay.status, headers };
  }
  const { data, error } = await client.rpc("commerce_deactivate_activation", {
    p_activation_id: activationId,
    p_account_id: user.id,
    p_actor_type: "customer",
    p_reason: "customer_portal",
  });
  if (error) {
    const { data: recovered } = await client.from("commerce_device_activations")
      .select("status,account_id").eq("id", activationId).maybeSingle();
    if (recovered?.account_id === user.id && recovered.status !== "active") {
      const response = { deactivated: true, activationId };
      await finishIdempotency(client, handle, 200, response);
      return { body: response, headers };
    }
    await abortIdempotency(client, handle, user.id);
    throw new ApiError(
      503,
      "deactivation_failed",
      "Device could not be deactivated.",
      true,
    );
  }
  if (data !== true) {
    return await finishIdempotentError(
      client,
      handle,
      new ApiError(404, "device_not_found", "Active device was not found."),
    );
  }
  const response = { deactivated: true, activationId };
  await finishIdempotency(client, handle, 200, response);
  return { body: response, headers };
}
