import { type CommerceConfig, loadConfig } from "../_shared/config.ts";
import { errorResponse, requestId } from "../_shared/http.ts";
import { route } from "./router.ts";

function unconfiguredResponse(id: string): Response {
  return new Response(
    JSON.stringify({
      code: "service_not_configured",
      publicMessage: "The license service is not configured.",
      requestId: id,
      retryable: true,
    }),
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Request-ID": id,
      },
    },
  );
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let config: CommerceConfig;
  try {
    config = loadConfig();
  } catch {
    return unconfiguredResponse(id);
  }
  try {
    return await route(request, config, id);
  } catch (error) {
    return errorResponse(config, request, error, id);
  }
});
