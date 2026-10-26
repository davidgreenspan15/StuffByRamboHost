import { runWorkerMaintenance } from "../_shared/worker-maintenance.ts";
import { loadConfig } from "../_shared/config.ts";
import { serviceClient } from "../_shared/db.ts";
import { constantTimeEqual, utf8 } from "../_shared/pure.ts";
import { processStripeQueue } from "../_shared/stripe-events.ts";

function response(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (request) => {
  let config;
  try {
    config = loadConfig();
  } catch {
    return response({ code: "service_not_configured" }, 503);
  }
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${config.cronSecret}`;
  if (
    request.method !== "POST" ||
    !constantTimeEqual(utf8(authorization), utf8(expected))
  ) {
    return response({ code: "not_found" }, 404);
  }
  try {
    const client = serviceClient(config);
    const result = await processStripeQueue(config, client, 20);
    const { purchaseEmails, retention, failure } = await runWorkerMaintenance(
      config,
      client,
    );
    return response(
      {
        ...result,
        retention,
        purchaseEmails,
        ...(failure ? { code: failure } : {}),
      },
      failure ? 503 : 200,
    );
  } catch {
    return response({ code: "worker_failed" }, 503);
  }
});
