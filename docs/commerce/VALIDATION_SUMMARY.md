# Commerce validation and release status

Verified October 26, 2026. This is source preparation; public sales remain disabled.

## Executed checks

- 66 backend Deno tests and function typechecking passed.
- 8 Cloudflare proxy tests and typechecking passed; deployment tooling audit reports zero advisories.
- Disposable PostgreSQL purchase-code checks passed, including the concurrent redemption race and refund/environment isolation.
- 11 disposable PostgreSQL policy-publication cases passed, including rerun safety and rollback on conflicts.
- Storefront validation passed for 10 primary pages and the scoped commerce/policy surface.
- Security-header validation passed 18 host/path cases and coverage of 16 pages. The route-scoped response headers and immutable-page settings are now deployed; public probes confirm CSP, frame denial and nosniff on the commerce routes, which still return 404 before site publication.
- The separate desktop project passed 171 Python tests, including release-publication guards and bounded outage retries.

The earlier hosted Standard Stripe sandbox exercise verified checkout, signed webhook processing, email delivery, signed native app activation/restart, single-use codes, resend behavior, device limits, deactivation, and exact-order refund/revocation. Original local application state was restored after testing. Detailed provider identifiers and owner-specific operational evidence are retained privately, outside this public source tree.

## Remaining launch requirements

The latest backend functions and key-binding migration are deployed to both isolated projects. A Managed Payments sandbox checkout completed through the real backend; email, current-source activation, reload, bounded offline use and code replay rejection passed. Its test refund succeeded at Stripe; durable signed-revocation evidence must be repeated. This exercise used the existing sandbox credential, so equivalently restricted-key acceptance is still pending.

Supabase Free and Resend Transactional Free were verified with paid overages disabled. Manual encrypted exports and PostgreSQL 17 restore drills passed for both environments, preserving 23 protected commerce tables and zero direct browser table/RPC grants. Unattended backup setup remains blocked by managed Auth ownership restrictions; no workflow or paid backup service was activated. Cloudflare zone Free was verified; account-level Workers billing remains unverified.

Production SMTP passed a real inbox and one-time token verification; replay was rejected and the test session was signed out. The live webhook is configured at the tested API version and remains disabled until routing cutover; its temporary setup key was revoked. Scheduled processing is installed and its first automatic run passed, with no failed or stuck event/email work reported. Independent alerts, public policy publication, production routing, browser portal acceptance, app activation/update acceptance and final checkout enablement remain separate gates. The signed, notarized and stapled 3.2.29 build47 candidate has not been publicly released. Public sales remain disabled.

Source commits on the preparation branch do not deploy Supabase or Cloudflare, update the website's deployment branch, publish an appcast or enable sales. Historical completed tests establish only their stated environment and version.

## Review

Claude Opus supplied implementation and review of licensing environment isolation and release guards. Codex integrated the work and reran the checks above. No production readiness or legal/tax professional review is implied by this source milestone.


## Restricted-key and production routing acceptance — October 26

Both Stripe live/sandbox connectors and both Supabase projects are accessible.
The approved restricted sandbox key completed Managed Payments checkout through
the real backend. Payment, signed webhook fulfillment, owner activation email,
one-Mac activation, reload, bounded offline access, and rejection of code reuse
passed. Full sandbox refund produced a verified signed revocation; reload stayed
locked. Durable sanitized evidence was retained privately. No live payment or
installed application state change occurred.

The test offer and test webhook were disabled before stable API cutover. The
reviewed Cloudflare proxy now uses all three matching live bindings. Public
verification returns the production permit key and an unavailable catalog; live
orders remain zero. The pinned live webhook is enabled with the exact eleven
supported event types. Public sales and purchase-code release gates remain off.

The prepared, previously unpublished October terms now match the approved
personal-use product; canonical/immutable bytes, manifest and SQL assertions were
updated together. Eleven isolated publication/rollback checks passed. Historical
July policy bytes were preserved. Download links are held closed until candidate
release acceptance; the older public installer is not presented as this candidate.

Current checks: 69 backend tests/typechecks, 8 proxy tests/typecheck and dry build,
11 policy database scenarios, scoped storefront validation. Production health
source was independently reviewed; actual schedule/notification evidence follows.
One encrypted live backup was uploaded to existing iCloud storage, downloaded,
hash-verified and restored successfully. Unattended Mac execution is not yet
accepted; Mac availability, Keychain access and cloud quota remain operating limits.

A native browser accessibility read unexpectedly exposed two sandbox API keys.
Owner rotation was requested, with no values retained in this report. Production
keys were not exposed by that read. Credential cleanup remains a readiness gate.
