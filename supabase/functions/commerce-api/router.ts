import type { CommerceConfig } from "../_shared/config.ts";
import { extractPublicApiPath } from "../_shared/api-path.ts";
import { serviceClient } from "../_shared/db.ts";
import {
  ApiError,
  jsonResponse,
  optionsResponse,
  requireTrustedProxy,
} from "../_shared/http.ts";
import { catalog } from "./routes/catalog.ts";
import { operationalHealth } from "./routes/health.ts";
import { checkoutStatus, createCheckoutSession } from "./routes/checkout.ts";
import {
  createActivationChallenge,
  deactivateCurrentDevice,
  exchangeActivation,
  licenseKeys,
  refreshDevice,
  signedTime,
} from "./routes/device.ts";
import {
  approveActivation,
  createPortalSession,
  deactivatePortalDevice,
  deletePortalSession,
  portalMe,
  type PortalRouteResult,
  requestMagicLink,
  requestRefund,
} from "./routes/portal.ts";
import {
  redeemPurchaseCode,
  requestPurchaseCode,
} from "./routes/purchase-codes.ts";
import { stripeWebhook } from "./routes/webhook.ts";

function publicPath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  try {
    return extractPublicApiPath(pathname);
  } catch {
    throw new ApiError(404, "not_found", "Endpoint was not found.");
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(404, "not_found", "Endpoint was not found.");
  }
}

function headersWithRequestId(headers: Headers, id: string): Headers {
  const result = new Headers(headers);
  result.set("X-Request-ID", id);
  return result;
}

function portalResponse(
  config: CommerceConfig,
  request: Request,
  result: PortalRouteResult,
  id: string,
): Response {
  return jsonResponse(
    config,
    request,
    result.body,
    result.status ?? 200,
    headersWithRequestId(result.headers, id),
  );
}

export async function route(
  request: Request,
  config: CommerceConfig,
  id: string,
): Promise<Response> {
  requireTrustedProxy(config, request);
  if (request.method === "OPTIONS") {
    const response = optionsResponse(config, request);
    response.headers.set("X-Request-ID", id);
    return response;
  }
  const path = publicPath(request);
  const client = serviceClient(config);
  const successHeaders = new Headers({ "X-Request-ID": id });

  if (path === "/v1/health" && request.method === "GET") {
    const result = await operationalHealth(client, request);
    return jsonResponse(
      config,
      request,
      result,
      result.healthy ? 200 : 503,
      successHeaders,
    );
  }

  if (path === "/v1/catalog/gesture-flow" && request.method === "GET") {
    return jsonResponse(
      config,
      request,
      await catalog(config, client),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/checkout-sessions" && request.method === "POST") {
    return jsonResponse(
      config,
      request,
      await createCheckoutSession(config, client, request),
      201,
      successHeaders,
    );
  }
  const checkoutMatch = /^\/v1\/checkout-status\/([^/]+)$/.exec(path);
  if (checkoutMatch?.[1] && request.method === "GET") {
    return jsonResponse(
      config,
      request,
      await checkoutStatus(client, decodeSegment(checkoutMatch[1])),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/purchase-activation-codes" && request.method === "POST") {
    return jsonResponse(
      config,
      request,
      await requestPurchaseCode(config, client, request),
      202,
      successHeaders,
    );
  }
  const purchaseCodeMatch =
    /^\/v1\/device-activation-challenges\/([^/]+)\/purchase-code$/.exec(path);
  if (purchaseCodeMatch?.[1] && request.method === "POST") {
    return jsonResponse(
      config,
      request,
      await redeemPurchaseCode(
        config,
        client,
        request,
        decodeSegment(purchaseCodeMatch[1]),
      ),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/portal/magic-link" && request.method === "POST") {
    return portalResponse(
      config,
      request,
      await requestMagicLink(config, client, request),
      id,
    );
  }
  if (path === "/v1/portal/session" && request.method === "POST") {
    return portalResponse(
      config,
      request,
      await createPortalSession(config, client, request),
      id,
    );
  }
  if (path === "/v1/portal/session" && request.method === "DELETE") {
    return portalResponse(
      config,
      request,
      await deletePortalSession(config, client, request),
      id,
    );
  }
  if (path === "/v1/portal/me" && request.method === "GET") {
    return portalResponse(
      config,
      request,
      await portalMe(config, client, request),
      id,
    );
  }
  if (path === "/v1/portal/refund-requests" && request.method === "POST") {
    return portalResponse(
      config,
      request,
      await requestRefund(config, client, request),
      id,
    );
  }
  const approvalMatch = /^\/v1\/portal\/activations\/([^/]+)\/approve$/.exec(
    path,
  );
  if (approvalMatch?.[1] && request.method === "POST") {
    return portalResponse(
      config,
      request,
      await approveActivation(
        config,
        client,
        request,
        decodeSegment(approvalMatch[1]),
      ),
      id,
    );
  }
  const portalDeviceMatch = /^\/v1\/portal\/devices\/([^/]+)\/deactivate$/.exec(
    path,
  );
  if (portalDeviceMatch?.[1] && request.method === "POST") {
    return portalResponse(
      config,
      request,
      await deactivatePortalDevice(
        config,
        client,
        request,
        decodeSegment(portalDeviceMatch[1]),
      ),
      id,
    );
  }
  if (
    path === "/v1/device-activation-challenges" && request.method === "POST"
  ) {
    return jsonResponse(
      config,
      request,
      await createActivationChallenge(config, client, request),
      201,
      successHeaders,
    );
  }
  const exchangeMatch =
    /^\/v1\/device-activation-challenges\/([^/]+)\/exchange$/.exec(path);
  if (exchangeMatch?.[1] && request.method === "POST") {
    return jsonResponse(
      config,
      request,
      await exchangeActivation(
        config,
        client,
        request,
        decodeSegment(exchangeMatch[1]),
      ),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/devices/refresh" && request.method === "POST") {
    return jsonResponse(
      config,
      request,
      await refreshDevice(config, client, request, path),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/devices/current" && request.method === "DELETE") {
    return jsonResponse(
      config,
      request,
      await deactivateCurrentDevice(config, client, request, path),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/time" && request.method === "GET") {
    const nonce = new URL(request.url).searchParams.get("nonce") ?? "";
    return jsonResponse(
      config,
      request,
      await signedTime(config, client, request, nonce),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/license-keys" && request.method === "GET") {
    return jsonResponse(
      config,
      request,
      licenseKeys(config),
      200,
      successHeaders,
    );
  }
  if (path === "/v1/stripe/webhook" && request.method === "POST") {
    return jsonResponse(
      config,
      request,
      await stripeWebhook(config, client, request),
      202,
      successHeaders,
    );
  }

  const knownPath = [
    "/v1/health",
    "/v1/catalog/gesture-flow",
    "/v1/checkout-sessions",
    "/v1/purchase-activation-codes",
    "/v1/portal/magic-link",
    "/v1/portal/session",
    "/v1/portal/me",
    "/v1/portal/refund-requests",
    "/v1/device-activation-challenges",
    "/v1/devices/refresh",
    "/v1/devices/current",
    "/v1/time",
    "/v1/license-keys",
    "/v1/stripe/webhook",
  ].includes(path) || checkoutMatch || approvalMatch || portalDeviceMatch ||
    exchangeMatch || purchaseCodeMatch;
  throw new ApiError(
    knownPath ? 405 : 404,
    knownPath ? "method_not_allowed" : "not_found",
    knownPath ? "HTTP method is not allowed." : "Endpoint was not found.",
  );
}
