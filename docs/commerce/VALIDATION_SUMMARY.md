# Commerce validation and release status

Verified October 26, 2026. This is source preparation; public sales remain disabled.

## Executed checks

- 59 backend Deno tests and function typechecking passed.
- 6 Cloudflare proxy tests and typechecking passed.
- Disposable PostgreSQL purchase-code checks passed, including the concurrent redemption race and refund/environment isolation.
- 11 disposable PostgreSQL policy-publication cases passed, including rerun safety and rollback on conflicts.
- Storefront validation passed for 10 primary pages and the scoped commerce/policy surface.
- Security-header validation passed 18 host/path cases and coverage of 16 pages. Response-header deployment remains pending.
- The separate desktop project passed 159 Python tests, including release-publication guards.

The earlier hosted Standard Stripe sandbox exercise verified checkout, signed webhook processing, email delivery, signed native app activation/restart, single-use codes, resend behavior, device limits, deactivation, and exact-order refund/revocation. Original local application state was restored after testing. Detailed provider identifiers and owner-specific operational evidence are retained privately, outside this public source tree.

## Remaining launch requirements

Managed Payments-specific restricted-key testing is not complete. The production backend, webhook, email, scheduled processing, alerts, backup/recovery verification, public policy publication, response headers, production app activation/update acceptance and final checkout enablement remain separate gates. The signed and notarized desktop candidate has not been publicly released.

Source commits on the preparation branch do not deploy Supabase or Cloudflare, update the website's deployment branch, publish an appcast or enable sales. Historical completed tests establish only their stated environment and version.

## Review

Claude Opus supplied implementation and review of licensing environment isolation and release guards. Codex integrated the work and reran the checks above. No production readiness or legal/tax professional review is implied by this source milestone.
