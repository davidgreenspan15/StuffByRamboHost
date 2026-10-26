# Gesture Flow license API façade

This dependency-free Cloudflare Worker maps the stable public API at
`https://licenses.stuffbyrambo.com/v1` to the Supabase `commerce-api` Edge Function. It does not
contain payment or entitlement logic.

The Worker:

- forwards only an explicit request/response header allowlist;
- replaces the raw client IP with an HMAC and a two-letter country code;
- adds a shared proxy secret so the Supabase function can reject direct calls;
- accepts only the explicitly allowlisted test/live Supabase projects and `commerce-api` function path;
- preserves the raw Stripe webhook request body and signature header;
- applies no-store and defensive response headers.

Create `.dev.vars` from `.dev.vars.example` for local testing. Never commit it. The two secrets must
be independently generated. The upstream function must have the same `UPSTREAM_PROXY_SECRET`; the IP
hash secret remains Worker-only. Any future Supabase project must be explicitly added to the upstream
allowlist in `src/index.ts` before its function URL can be configured.

Approved `SUPABASE_FUNCTION_URL` values (including the trailing slash):

- Test: `https://rilxmoeezbmpvmcfkyko.supabase.co/functions/v1/commerce-api/`
- Live: `https://xuhvcnmztnzycifdusfv.supabase.co/functions/v1/commerce-api/`

The configured value selects exactly one upstream; there is no automatic fallback.
Adding the live URL to this source allowlist does not change the deployed Worker.
Keep the stable proxy on test until restricted-key sandbox purchase/refund E2E is
complete. Production cutover requires a separate configuration change and deployment
with the matching live proxy secret, followed by verification.

Local checks:

```bash
deno task check
deno task test
```

Deployment is intentionally not automatic. Before production deployment, authenticate Wrangler,
configure all three values as Worker secrets, confirm the custom-domain route, then run
`npx wrangler deploy --dry-run` followed by a separately approved deployment.
