import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import type { CommerceConfig } from "./config.ts";
import { authClient } from "./db.ts";
import { ApiError, requireSameSiteMutation } from "./http.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hmacSha256Hex,
  utf8,
  utf8String,
} from "./pure.ts";

const ACCESS_COOKIE = "__Host-gf-access";
const REFRESH_COOKIE = "__Host-gf-refresh";
const PORTAL_COOKIE = "__Host-gf-portal";
const PORTAL_MARKER_SECONDS = 30 * 24 * 60 * 60;

interface SessionClaims {
  sub: string;
  sessionId: string;
  methods: string[];
}

interface PortalMarkerClaims {
  v: 2;
  sub: string;
  sid: string;
  rth: string;
  iat: number;
  exp: number;
}

export interface PortalAuth {
  user: User;
  responseHeaders: Headers;
  accessToken: string;
  refreshToken: string;
}

function cookies(request: Request): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    try {
      parsed.set(name, decodeURIComponent(item.slice(separator + 1).trim()));
    } catch {
      // Invalid cookies are ignored and authentication fails closed.
    }
  }
  return parsed;
}

export function portalTokens(request: Request): {
  accessToken?: string;
  refreshToken?: string;
  portalMarker?: string;
} {
  const parsed = cookies(request);
  return {
    accessToken: parsed.get(ACCESS_COOKIE),
    refreshToken: parsed.get(REFRESH_COOKIE),
    portalMarker: parsed.get(PORTAL_COOKIE),
  };
}

function cookie(
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; path: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    "Secure",
    "SameSite=Strict",
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

async function csrfForRefresh(
  config: CommerceConfig,
  refreshToken: string,
): Promise<string> {
  return await hmacSha256Hex(config.contextHmacSecret, `csrf:${refreshToken}`);
}

function authenticationRequired(): ApiError {
  return new ApiError(401, "authentication_required", "Sign in to continue.");
}

function sessionClaims(
  accessToken: string,
  expectedUserId: string,
): SessionClaims {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) throw new Error("invalid_jwt");
    const payload = JSON.parse(
      utf8String(base64UrlDecode(parts[1])),
    ) as Record<string, unknown>;
    if (
      payload.sub !== expectedUserId || payload.role !== "authenticated" ||
      typeof payload.session_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(payload.session_id) ||
      !Array.isArray(payload.amr)
    ) throw new Error("invalid_session_claims");
    const methods = payload.amr.map((entry) => {
      if (
        !entry || typeof entry !== "object" ||
        typeof (entry as Record<string, unknown>).method !== "string" ||
        !Number.isInteger((entry as Record<string, unknown>).timestamp)
      ) throw new Error("invalid_amr");
      return (entry as { method: string }).method;
    });
    return { sub: expectedUserId, sessionId: payload.session_id, methods };
  } catch {
    throw authenticationRequired();
  }
}

async function portalRefreshBinding(
  config: CommerceConfig,
  refreshToken: string,
): Promise<string> {
  if (!refreshToken) throw authenticationRequired();
  return await hmacSha256Hex(
    config.contextHmacSecret,
    `portal-refresh:v2:${refreshToken}`,
  );
}

async function signPortalMarker(
  config: CommerceConfig,
  claims: SessionClaims,
  refreshToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  lifetime?: { issuedAt: number; expiresAt: number },
): Promise<{ value: string; expiresAt: number }> {
  const issuedAt = lifetime?.issuedAt ?? nowSeconds;
  const expiresAt = lifetime?.expiresAt ?? nowSeconds + PORTAL_MARKER_SECONDS;
  const markerClaims: PortalMarkerClaims = {
    v: 2,
    sub: claims.sub,
    sid: claims.sessionId,
    rth: await portalRefreshBinding(config, refreshToken),
    iat: issuedAt,
    exp: expiresAt,
  };
  const encoded = base64UrlEncode(utf8(JSON.stringify(markerClaims)));
  const signature = await hmacSha256Hex(
    config.contextHmacSecret,
    `portal-marker:v2:${encoded}`,
  );
  return { value: `v2.${encoded}.${signature}`, expiresAt };
}

async function createPortalMarker(
  config: CommerceConfig,
  claims: SessionClaims,
  refreshToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ value: string; expiresAt: number }> {
  if (
    !claims.methods.some((method) => method === "magiclink" || method === "otp")
  ) {
    throw authenticationRequired();
  }
  return await signPortalMarker(config, claims, refreshToken, nowSeconds);
}

async function verifyPortalMarker(
  config: CommerceConfig,
  value: string | undefined,
  refreshToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{
  value: string;
  claims: PortalMarkerClaims;
}> {
  try {
    const parts = value?.split(".") ?? [];
    if (
      parts.length !== 3 || parts[0] !== "v2" || !parts[1] ||
      parts[1].length > 512 || !parts[2] || !/^[0-9a-f]{64}$/.test(parts[2])
    ) throw new Error("invalid_marker");
    const expected = await hmacSha256Hex(
      config.contextHmacSecret,
      `portal-marker:v2:${parts[1]}`,
    );
    if (!constantTimeEqual(utf8(expected), utf8(parts[2]))) {
      throw new Error("invalid_marker_signature");
    }
    const marker = JSON.parse(
      utf8String(base64UrlDecode(parts[1])),
    ) as Record<string, unknown>;
    const expectedRefreshBinding = await portalRefreshBinding(
      config,
      refreshToken,
    );
    if (
      Object.keys(marker).sort().join(",") !== "exp,iat,rth,sid,sub,v" ||
      marker.v !== 2 || typeof marker.sub !== "string" ||
      typeof marker.sid !== "string" || typeof marker.rth !== "string" ||
      !/^[0-9a-f]{64}$/.test(marker.rth) ||
      !constantTimeEqual(utf8(expectedRefreshBinding), utf8(marker.rth)) ||
      !Number.isInteger(marker.iat) ||
      !Number.isInteger(marker.exp) || Number(marker.iat) > nowSeconds + 60 ||
      Number(marker.exp) <= nowSeconds ||
      Number(marker.exp) - Number(marker.iat) !== PORTAL_MARKER_SECONDS
    ) throw new Error("invalid_marker_claims");
    return {
      value: value as string,
      claims: marker as unknown as PortalMarkerClaims,
    };
  } catch {
    throw authenticationRequired();
  }
}

async function validatePortalMarker(
  config: CommerceConfig,
  value: string | undefined,
  claims: SessionClaims,
  refreshToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ value: string; claims: PortalMarkerClaims }> {
  const marker = await verifyPortalMarker(
    config,
    value,
    refreshToken,
    nowSeconds,
  );
  if (
    marker.claims.sub !== claims.sub || marker.claims.sid !== claims.sessionId
  ) {
    throw authenticationRequired();
  }
  return marker;
}

export async function sessionCookieHeaders(
  config: CommerceConfig,
  session: Session,
  existingPortalMarker?: string,
  existingRefreshToken?: string,
): Promise<Headers> {
  const claims = sessionClaims(session.access_token, session.user.id);
  let marker: { value: string; expiresAt: number };
  if (existingPortalMarker) {
    const existing = await validatePortalMarker(
      config,
      existingPortalMarker,
      claims,
      existingRefreshToken ?? "",
    );
    marker = await signPortalMarker(
      config,
      claims,
      session.refresh_token,
      Math.floor(Date.now() / 1000),
      {
        issuedAt: existing.claims.iat,
        expiresAt: existing.claims.exp,
      },
    );
  } else {
    marker = await createPortalMarker(
      config,
      claims,
      session.refresh_token,
    );
  }
  const headers = new Headers();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const accessMaxAge = Math.max(
    60,
    (session.expires_at ?? nowSeconds + 3600) - nowSeconds,
  );
  headers.append(
    "Set-Cookie",
    cookie(ACCESS_COOKIE, session.access_token, {
      maxAge: accessMaxAge,
      httpOnly: true,
      path: "/",
    }),
  );
  headers.append(
    "Set-Cookie",
    cookie(REFRESH_COOKIE, session.refresh_token, {
      maxAge: 30 * 24 * 60 * 60,
      httpOnly: true,
      path: "/",
    }),
  );
  headers.append(
    "Set-Cookie",
    cookie(PORTAL_COOKIE, marker.value, {
      maxAge: Math.max(0, marker.expiresAt - nowSeconds),
      httpOnly: true,
      path: "/",
    }),
  );
  headers.set(
    "X-CSRF-Token",
    await csrfForRefresh(config, session.refresh_token),
  );
  return headers;
}

export function clearSessionCookieHeaders(): Headers {
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    cookie(ACCESS_COOKIE, "", {
      maxAge: 0,
      httpOnly: true,
      path: "/",
    }),
  );
  headers.append(
    "Set-Cookie",
    cookie(REFRESH_COOKIE, "", {
      maxAge: 0,
      httpOnly: true,
      path: "/",
    }),
  );
  headers.append(
    "Set-Cookie",
    cookie(PORTAL_COOKIE, "", {
      maxAge: 0,
      httpOnly: true,
      path: "/",
    }),
  );
  return headers;
}

export async function requireCsrf(
  config: CommerceConfig,
  request: Request,
): Promise<void> {
  requireSameSiteMutation(config, request);
  const refreshToken = portalTokens(request).refreshToken ?? "";
  const headerToken = request.headers.get("x-csrf-token") ?? "";
  const expectedToken = refreshToken
    ? await csrfForRefresh(config, refreshToken)
    : "";
  if (
    expectedToken.length < 20 ||
    !constantTimeEqual(utf8(expectedToken), utf8(headerToken))
  ) {
    throw new ApiError(
      403,
      "csrf_failed",
      "Security token is missing or invalid.",
    );
  }
}

export async function portalAuth(
  config: CommerceConfig,
  request: Request,
  client: Pick<SupabaseClient, "auth"> = authClient(config),
): Promise<PortalAuth> {
  const tokens = portalTokens(request);
  const accessToken = tokens.accessToken;
  const refreshToken = tokens.refreshToken;
  if (accessToken) {
    const { data, error } = await client.auth.getUser(accessToken);
    if (!error && data.user) {
      const responseHeaders = new Headers();
      if (!refreshToken) {
        throw authenticationRequired();
      }
      const claims = sessionClaims(accessToken, data.user.id);
      await validatePortalMarker(
        config,
        tokens.portalMarker,
        claims,
        refreshToken,
      );
      responseHeaders.set(
        "X-CSRF-Token",
        await csrfForRefresh(config, refreshToken),
      );
      return { user: data.user, responseHeaders, accessToken, refreshToken };
    }
  }

  if (refreshToken && tokens.portalMarker) {
    await verifyPortalMarker(config, tokens.portalMarker, refreshToken);
    const { data, error } = await client.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (!error && data.session && data.user) {
      return {
        user: data.user,
        responseHeaders: await sessionCookieHeaders(
          config,
          data.session,
          tokens.portalMarker,
          refreshToken,
        ),
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      };
    }
  }

  throw authenticationRequired();
}
