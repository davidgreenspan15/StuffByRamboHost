import type { SupabaseClient } from "@supabase/supabase-js";
import { consumeRateLimit, trustedIpHmac } from "../../_shared/rate-limit.ts";

const MAX_SNAPSHOT_AGE_MS = 180_000;

// The snapshot contains no queue details, customer data, or credentials. Its
// freshness detects a stopped scheduler independently of the cached boolean.
export function healthySnapshot(value: unknown, now = Date.now()): boolean {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (row.healthy !== true || typeof row.checked_at !== "string") return false;
  const checkedAt = Date.parse(row.checked_at);
  const age = now - checkedAt;
  return Number.isFinite(age) && age >= 0 && age <= MAX_SNAPSHOT_AGE_MS;
}

export async function operationalHealth(
  client: SupabaseClient,
  request: Request,
): Promise<{ healthy: boolean }> {
  await consumeRateLimit(client, {
    bucket: "operational-health-ip",
    limit: 12,
    windowSeconds: 60,
  }, trustedIpHmac(request));
  try {
    const { data, error } = await client.from("commerce_runtime_health")
      .select("healthy,checked_at").eq("singleton", true).maybeSingle();
    return { healthy: !error && healthySnapshot(data) };
  } catch {
    return { healthy: false };
  }
}
