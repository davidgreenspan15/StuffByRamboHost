import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import type { CommerceConfig } from "./config.ts";
import {
  clearSessionCookieHeaders,
  portalAuth,
  sessionCookieHeaders,
} from "./auth.ts";
import { ApiError, errorResponse, preserveResponseHeaders } from "./http.ts";
import { base64UrlEncode, utf8 } from "./pure.ts";

function assert(
  condition: unknown,
  message = "assertion_failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertAuthenticationRequired(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    assert(error instanceof ApiError);
    assert(error.status === 401);
    assert(error.code === "authentication_required");
    return;
  }
  throw new Error("expected_authentication_required");
}

const config = {
  contextHmacSecret: "context-secret-at-least-thirty-two-characters",
  allowedSiteOrigins: ["https://stuffbyrambo.com"],
} as CommerceConfig;

const user = {
  id: "40000000-0000-4000-8000-000000000001",
  email: "buyer@example.test",
} as User;
const otherUser = {
  id: "40000000-0000-4000-8000-000000000002",
  email: "other@example.test",
} as User;
const sessionId = "70000000-0000-4000-8000-000000000001";
const otherSessionId = "70000000-0000-4000-8000-000000000002";

function accessToken(
  subject: string,
  boundSessionId: string,
  methods: string[] | null,
): string {
  const payload: Record<string, unknown> = {
    sub: subject,
    role: "authenticated",
    session_id: boundSessionId,
  };
  if (methods) {
    payload.amr = methods.map((method) => ({
      method,
      timestamp: 1_720_000_000,
    }));
  }
  return [
    base64UrlEncode(utf8(JSON.stringify({ alg: "ES256", typ: "JWT" }))),
    base64UrlEncode(utf8(JSON.stringify(payload))),
    "test-signature",
  ].join(".");
}

function session(
  sessionUser: User,
  token: string,
  refreshToken = "refresh-token",
): Session {
  return {
    access_token: token,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: sessionUser,
  } as Session;
}

function setCookieValue(headers: Headers, name: string): string {
  const raw = headers.getSetCookie().find((value) =>
    value.startsWith(`${name}=`)
  );
  assert(raw, `missing_cookie:${name}`);
  const encoded = raw.slice(name.length + 1).split(";", 1)[0];
  assert(encoded !== undefined, `invalid_cookie:${name}`);
  return decodeURIComponent(encoded);
}

function markedCookieHeader(headers: Headers): string {
  return ["__Host-gf-access", "__Host-gf-refresh", "__Host-gf-portal"]
    .map((name) =>
      `${name}=${encodeURIComponent(setCookieValue(headers, name))}`
    )
    .join("; ");
}

function clientForAccess(sessionUser: User): Pick<SupabaseClient, "auth"> {
  return {
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: sessionUser }, error: null }),
    },
  } as unknown as Pick<SupabaseClient, "auth">;
}

Deno.test("only an email-link session can mint the signed portal marker", async () => {
  for (const method of ["magiclink", "otp"]) {
    const headers = await sessionCookieHeaders(
      config,
      session(user, accessToken(user.id, sessionId, [method])),
    );
    assert(headers.getSetCookie().length === 3);
    const markerCookie = headers.getSetCookie().find((value) =>
      value.startsWith("__Host-gf-portal=")
    );
    assert(markerCookie?.includes("Secure"));
    assert(markerCookie?.includes("HttpOnly"));
    assert(markerCookie?.includes("SameSite=Strict"));
    assert(markerCookie?.includes("Path=/"));
    assert(!markerCookie?.includes("Domain="));
  }

  await assertAuthenticationRequired(() =>
    sessionCookieHeaders(
      config,
      session(user, accessToken(user.id, sessionId, ["password"])),
    )
  );
  await assertAuthenticationRequired(() =>
    sessionCookieHeaders(
      config,
      session(user, accessToken(user.id, sessionId, null)),
    )
  );
});

Deno.test("portal authentication requires a valid marker bound to the user and session", async () => {
  const token = accessToken(user.id, sessionId, ["magiclink"]);
  const issued = await sessionCookieHeaders(config, session(user, token));
  const validCookies = markedCookieHeader(issued);
  const validRequest = new Request(
    "https://licenses.stuffbyrambo.com/v1/portal/me",
    { headers: { Cookie: validCookies } },
  );
  const authenticated = await portalAuth(
    config,
    validRequest,
    clientForAccess(user),
  );
  assert(authenticated.user.id === user.id);

  const withoutMarker = new Request(validRequest.url, {
    headers: {
      Cookie: `__Host-gf-access=${
        encodeURIComponent(token)
      }; __Host-gf-refresh=refresh-token`,
    },
  });
  await assertAuthenticationRequired(() =>
    portalAuth(config, withoutMarker, clientForAccess(user))
  );

  const validMarker = setCookieValue(issued, "__Host-gf-portal");
  const tamperedMarker = `${validMarker.slice(0, -1)}${
    validMarker.endsWith("0") ? "1" : "0"
  }`;
  const tampered = new Request(validRequest.url, {
    headers: {
      Cookie: validCookies.replace(
        /__Host-gf-portal=[^;]+/,
        `__Host-gf-portal=${encodeURIComponent(tamperedMarker)}`,
      ),
    },
  });
  await assertAuthenticationRequired(() =>
    portalAuth(config, tampered, clientForAccess(user))
  );

  const otherSessionToken = accessToken(user.id, otherSessionId, ["password"]);
  const crossSession = new Request(validRequest.url, {
    headers: {
      Cookie: validCookies.replace(
        /__Host-gf-access=[^;]+/,
        `__Host-gf-access=${encodeURIComponent(otherSessionToken)}`,
      ),
    },
  });
  await assertAuthenticationRequired(() =>
    portalAuth(config, crossSession, clientForAccess(user))
  );

  const otherUserToken = accessToken(otherUser.id, otherSessionId, [
    "password",
  ]);
  const crossUser = new Request(validRequest.url, {
    headers: {
      Cookie: validCookies.replace(
        /__Host-gf-access=[^;]+/,
        `__Host-gf-access=${encodeURIComponent(otherUserToken)}`,
      ),
    },
  });
  await assertAuthenticationRequired(() =>
    portalAuth(config, crossUser, clientForAccess(otherUser))
  );
});

Deno.test("password-only access and refresh sessions cannot enter or upgrade into the portal", async () => {
  const passwordToken = accessToken(user.id, sessionId, ["password"]);
  let refreshCalls = 0;
  const client = {
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      refreshSession: () => {
        refreshCalls += 1;
        return Promise.resolve({
          data: { session: null, user: null },
          error: null,
        });
      },
    },
  } as unknown as Pick<SupabaseClient, "auth">;
  const request = new Request(
    "https://licenses.stuffbyrambo.com/v1/portal/me",
    {
      headers: {
        Cookie: `__Host-gf-access=${
          encodeURIComponent(passwordToken)
        }; __Host-gf-refresh=password-refresh`,
      },
    },
  );
  await assertAuthenticationRequired(() => portalAuth(config, request, client));
  assert(
    refreshCalls === 0,
    "an unmarked password refresh token must not be exchanged",
  );
});

Deno.test("invalid portal markers are rejected before refresh-token rotation", async () => {
  const initial = await sessionCookieHeaders(
    config,
    session(
      user,
      accessToken(user.id, sessionId, ["magiclink"]),
      "bound-refresh-token",
    ),
  );
  const validCookies = markedCookieHeader(initial);
  const validMarker = setCookieValue(initial, "__Host-gf-portal");
  const tamperedMarker = `${validMarker.slice(0, -1)}${
    validMarker.endsWith("0") ? "1" : "0"
  }`;
  const invalidCookies = [
    validCookies.replace(
      /__Host-gf-portal=[^;]+/,
      `__Host-gf-portal=${encodeURIComponent(tamperedMarker)}`,
    ),
    validCookies.replace(
      /__Host-gf-refresh=[^;]+/,
      "__Host-gf-refresh=another-session-refresh-token",
    ),
  ];

  for (const cookieHeader of invalidCookies) {
    let refreshCalls = 0;
    const client = {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: null },
            error: new Error("expired"),
          }),
        refreshSession: () => {
          refreshCalls += 1;
          return Promise.resolve({
            data: { session: null, user: null },
            error: null,
          });
        },
      },
    } as unknown as Pick<SupabaseClient, "auth">;
    const request = new Request(
      "https://licenses.stuffbyrambo.com/v1/portal/me",
      { headers: { Cookie: cookieHeader } },
    );
    await assertAuthenticationRequired(() =>
      portalAuth(config, request, client)
    );
    assert(
      refreshCalls === 0,
      "invalid marker state must not rotate a refresh token",
    );
  }
});

Deno.test("rotated portal cookies and marker survive a downstream business error", async () => {
  const initialToken = accessToken(user.id, sessionId, ["magiclink"]);
  const initialHeaders = await sessionCookieHeaders(
    config,
    session(user, initialToken, "old-refresh"),
  );
  const refreshedToken = accessToken(user.id, sessionId, ["token_refresh"]);
  const refreshedSession = session(user, refreshedToken, "new-refresh-token");
  let refreshCalls = 0;
  const client = {
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: null }, error: new Error("expired") }),
      refreshSession: () => {
        refreshCalls += 1;
        return Promise.resolve({
          data: { session: refreshedSession, user },
          error: null,
        });
      },
    },
  } as unknown as Pick<SupabaseClient, "auth">;
  const request = new Request(
    "https://licenses.stuffbyrambo.com/v1/portal/me",
    {
      headers: {
        Cookie: markedCookieHeader(initialHeaders),
        Origin: "https://stuffbyrambo.com",
      },
    },
  );

  const auth = await portalAuth(config, request, client);
  preserveResponseHeaders(request, auth.responseHeaders);
  const response = errorResponse(
    config,
    request,
    new ApiError(409, "policy_changed", "Terms changed."),
    "request-id-test",
  );

  assert(response.status === 409);
  const cookies = response.headers.getSetCookie();
  assert(
    cookies.length === 3,
    "all rotated host-only cookies must be returned",
  );
  assert(
    cookies.some((value) => value.includes(encodeURIComponent(refreshedToken))),
  );
  assert(
    cookies.some((value) =>
      value.includes("__Host-gf-refresh=new-refresh-token")
    ),
  );
  assert(cookies.some((value) => value.includes("__Host-gf-portal=")));
  assert((response.headers.get("x-csrf-token") ?? "").length === 64);
  assert(refreshCalls === 1, "a valid bound marker must rotate exactly once");
});

Deno.test("refresh cannot move a portal marker to another session", async () => {
  const initial = await sessionCookieHeaders(
    config,
    session(
      user,
      accessToken(user.id, sessionId, ["magiclink"]),
      "old-refresh",
    ),
  );
  const client = {
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: null }, error: new Error("expired") }),
      refreshSession: () => {
        const refreshed = session(
          user,
          accessToken(user.id, otherSessionId, ["token_refresh"]),
          "new-refresh",
        );
        return Promise.resolve({
          data: { session: refreshed, user },
          error: null,
        });
      },
    },
  } as unknown as Pick<SupabaseClient, "auth">;
  const request = new Request(
    "https://licenses.stuffbyrambo.com/v1/portal/me",
    { headers: { Cookie: markedCookieHeader(initial) } },
  );
  await assertAuthenticationRequired(() => portalAuth(config, request, client));
});

Deno.test("logout clears access, refresh, and portal marker cookies", () => {
  const cookies = clearSessionCookieHeaders().getSetCookie();
  assert(cookies.length === 3);
  for (
    const name of ["__Host-gf-access", "__Host-gf-refresh", "__Host-gf-portal"]
  ) {
    assert(
      cookies.some((value) =>
        value.startsWith(`${name}=`) && value.includes("Max-Age=0")
      ),
    );
  }
});
