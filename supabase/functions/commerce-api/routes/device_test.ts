import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import { ApiError } from "../../_shared/http.ts";
import { activationResult } from "./device.ts";

Deno.test("browser key conflict returns 409 without issuing a permit", async () => {
  const client = new Proxy({}, {
    get() {
      throw new Error("conflict must not issue a permit or access the DB");
    },
  }) as SupabaseClient;
  try {
    await activationResult({} as CommerceConfig, client, {
      outcome: "device_key_conflict",
    });
    throw new Error("conflict accepted");
  } catch (error) {
    if (
      !(error instanceof ApiError) || error.status !== 409 ||
      error.code !== "device_key_conflict"
    ) {
      throw error;
    }
  }
});
