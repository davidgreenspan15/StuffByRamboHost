import { buildUpstreamUrl, type Env, ProxyError, proxyRequest } from "../src/index.ts";

const APPROVED_FUNCTION_URL = "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/";

const env: Env = {
  SUPABASE_FUNCTION_URL: APPROVED_FUNCTION_URL,
  UPSTREAM_PROXY_SECRET: "proxy-secret-that-is-at-least-thirty-two-bytes",
  IP_HASH_SECRET: "ip-hash-secret-that-is-at-least-thirty-two-bytes",
};

Deno.test("rejects paths outside the versioned API", async () => {
  await assertRejects(
    () => proxyRequest(new Request("https://licenses.stuffbyrambo.com/admin"), env),
    404,
    "not_found",
  );
});

Deno.test("rejects oversized declared bodies before proxying", async () => {
  const request = new Request(
    "https://licenses.stuffbyrambo.com/v1/checkout-sessions",
    {
      method: "POST",
      headers: { "Content-Length": "1048577" },
      body: "{}",
    },
  );
  await assertRejects(
    () => proxyRequest(request, env),
    413,
    "request_too_large",
  );
});

Deno.test("rejects oversized actual bodies when content length is unavailable", async () => {
  const request = new Request(
    "https://licenses.stuffbyrambo.com/v1/checkout-sessions",
    {
      method: "POST",
      body: new Uint8Array(1_048_577),
    },
  );
  request.headers.delete("Content-Length");
  await assertRejects(
    () => proxyRequest(request, env),
    413,
    "request_too_large",
  );
});

Deno.test("rejects every upstream except the approved Supabase function URL", async () => {
  const invalidUpstreams = [
    "http://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/",
    "https://attacker.example/functions/v1/commerce-api/",
    "https://rilxmoeezbmpvmcfkyko.supabase.co.attacker.example/functions/v1/commerce-api/",
    "https://another-project-ref.supabase.co/functions/v1/commerce-api/",
    "https://rilxmoeezbmpvmcfkyko.supabase.co:8443/functions/v1/commerce-api/",
    "https://user:password@rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/",
    "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/other-function/",
    "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api",
    "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/?redirect=attacker",
    "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/#attacker",
  ];
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    throw new Error("unexpected_fetch");
  }) as typeof fetch;

  try {
    for (const upstream of invalidUpstreams) {
      await assertRejects(
        () =>
          proxyRequest(
            new Request(
              "https://licenses.stuffbyrambo.com/v1/catalog/gesture-flow",
              {
                headers: {
                  Authorization: "Bearer synthetic-access-token",
                  Cookie: "__Host-gf-access=synthetic-session",
                },
              },
            ),
            {
              ...env,
              SUPABASE_FUNCTION_URL: upstream,
            },
          ),
        503,
        "service_not_configured",
      );
    }
    if (fetchCalled) {
      throw new Error("An invalid upstream was contacted");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("preserves the Edge Function base path", () => {
  const result = buildUpstreamUrl(
    new URL(APPROVED_FUNCTION_URL),
    new URL(
      "https://licenses.stuffbyrambo.com/v1/catalog/gesture-flow?locale=en",
    ),
  );
  if (
    result.toString() !==
      "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/v1/catalog/gesture-flow?locale=en"
  ) {
    throw new Error(`Unexpected upstream URL: ${result}`);
  }
});

Deno.test("forwards only approved metadata and preserves the raw body", async () => {
  const originalFetch = globalThis.fetch;
  let captured: Request | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input, init);
    const responseHeaders = new Headers({ "Content-Type": "application/json" });
    responseHeaders.append(
      "Set-Cookie",
      "__Host-gf-access=access; Secure; HttpOnly; Path=/",
    );
    responseHeaders.append(
      "Set-Cookie",
      "__Host-gf-refresh=refresh; Secure; HttpOnly; Path=/",
    );
    responseHeaders.append(
      "Set-Cookie",
      "__Host-gf-portal=marker; Secure; HttpOnly; Path=/",
    );
    return new Response('{"ok":true}', {
      status: 202,
      headers: responseHeaders,
    });
  }) as typeof fetch;

  try {
    const rawBody = '{"id":"evt_test","exact":"a b"}';
    const response = await proxyRequest(
      new Request("https://licenses.stuffbyrambo.com/v1/stripe/webhook", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.9",
          "CF-IPCountry": "US",
          "Content-Type": "application/json",
          "Stripe-Signature": "t=1,v1=test",
          "X-GF-Proxy-Secret": "attacker-value",
          "X-Untrusted": "drop-me",
        },
        body: rawBody,
      }),
      env,
      "request-test",
    );

    if (!captured) {
      throw new Error("Expected an upstream request");
    }
    const upstream = captured as Request;
    if (
      upstream.url !==
        "https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/v1/stripe/webhook"
    ) {
      throw new Error(`Unexpected upstream URL: ${upstream.url}`);
    }
    if ((await upstream.text()) !== rawBody) {
      throw new Error("The proxy changed the raw body");
    }
    if (
      upstream.headers.get("X-GF-Proxy-Secret") !== env.UPSTREAM_PROXY_SECRET
    ) {
      throw new Error("The trusted proxy secret was not applied");
    }
    if (
      !/^[0-9a-f]{64}$/.test(upstream.headers.get("X-GF-Client-IP-HMAC") || "")
    ) {
      throw new Error("The client IP was not pseudonymized");
    }
    if (
      upstream.headers.has("CF-Connecting-IP") ||
      upstream.headers.has("X-Untrusted")
    ) {
      throw new Error("An untrusted header reached the backend");
    }
    if (response.status !== 202 || (await response.text()) !== '{"ok":true}') {
      throw new Error("The upstream response was not preserved");
    }
    if (response.headers.getSetCookie().length !== 3) {
      throw new Error(
        "The proxy did not preserve all three secure session cookies",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function assertRejects(
  operation: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      error instanceof ProxyError && error.status === status &&
      error.code === code
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected ProxyError ${status}/${code}`);
}

Deno.test("cancels oversized streaming upload before reading its remainder or proxying", async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (reads > 2) throw new Error("read beyond limit");
      controller.enqueue(new Uint8Array(600_000));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const request = new Request(
    "https://licenses.stuffbyrambo.com/v1/checkout-sessions",
    {
      method: "POST",
      body,
    },
  );
  await assertRejects(
    () => proxyRequest(request, env),
    413,
    "request_too_large",
  );
  if (reads !== 2 || !cancelled) {
    throw new Error("stream was not cancelled at limit");
  }
});
