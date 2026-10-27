# Changelog

## 2026-10-26

- **LIC-002 cloud-done (private test only):** completed isolated Supabase/Cloudflare/Stripe/Resend setup and end-to-end matrix. Fixed hosted gateway path handling, sandbox Checkout consent-link setup, and portal counts after refund. 54 Deno tests and typecheck pass; both sandbox payments refunded and original Mac state restored. Full evidence in `commerce/VALIDATION_SUMMARY.md`. No live sale, public site or app release, commit or push.


- **LIC-002 (local-done, private testing; backend half of app ticket PY-LIC-008):** Replaced the Supabase OTP purchase path with single-use `GF-XXXX-XXXX-XXXX-XXXX` codes: the worker issues an HMAC digest under its lease and emails the code via the Resend HTTP API (fails closed without `RESEND_API_KEY`/sender or gates). New `POST /v1/device-activation-challenges/{id}/purchase-code` redeems atomically (generic `400 invalid_purchase_code`, same-challenge retry idempotent, no device-key takeover); the `/email-code` route and OTP authorization RPC are removed and OTP-era queued rows are superseded. Paid purchases are one Mac, trials stay two. Purchase-code activations may lack an account until the existing portal claim attaches them. 49 Deno tests, typecheck and the disposable PostgreSQL runner (including a two-challenge race) pass locally. Hosted migration, Resend configuration, real email, legal/marketing "two Macs" copy and signed-app E2E remain pending. Implemented by Claude Opus 5.5. Independent review (no P0) follow-up: trial upgrade at fulfillment moves at most one Mac and deactivates the rest (`trial_upgrade_over_limit`); the same Mac recovers its activation with a new challenge after a lost response and expiry; emails and resend rotation are per order for multi-purchase buyers; a Mac already active on the purchase gets its activation back without consuming the code; a Mac on another paid purchase gets `409 already_activated` (code unused); a trial Mac's trial row is deactivated on upgrade; null account IDs are typed; the email explains moving to a new Mac. 50 Deno tests, typecheck and the extended disposable PostgreSQL runner pass.

- LIC-001 review follow-up: email queue faults no longer skip retention or abandon later claimed rows; unresolved completions remain uncertain with degraded worker status and no resend. Internal exchange strips stale body framing, and tests exercise its actual permit signer and device-limit outcome. Shared private template now distinguishes app purchase activation from browser trial/account sign-in and explains single-use code/link semantics. 44 Deno tests and typechecking pass locally; hosted setup and signed native E2E remain pending.

- **LIC-001 (local-done, private testing):** Added a disabled-by-default purchase email outbox, Supabase OTP redemption tied to an active paid test entitlement, recipient/send guards, and native one-time code entry backed by existing signed device permits. Verified email alone cannot grant access; simultaneous activation requests preserve the two-Mac limit. Preserved the 14-day trial, 30-day permit maximum and 24-hour refresh. Local Deno/Python/disposable-database tests pass. Supabase/Resend configuration, hosted routing, real email and signed-app end-to-end verification remain pending.




## 2026-07-13

- **WEB-001:** Added the Gesture Flow v3 storefront, server-priced hosted-checkout handoff, server-confirmed success/cancel states, passwordless license portal, device approval/deactivation, and refund-request UI.
- **LEGAL-001:** Added versioned Terms of Sale/EULA, Refund Policy, Privacy Policy, and Compatibility/Permissions pages covering the public Python lane, two Macs, the one-time trial, v3 scope, future paid offerings, and the 30-day offline bound.
- **SEC-001:** Removed Tailwind CDN and Google Fonts from every published HTML page. The five design prototypes now use a local utility subset and first-party effects script; commerce and authenticated pages use local assets and restrictive CSP metadata.
- **QA-001:** Added a dependency-free validator for page structure, internal links, policy versions, local-only commerce assets, catalog pricing, portal security controls, and accessible form labeling.
- **SEC-001 / QA-001 hardening:** Magic-link secrets are accepted only from the URL fragment, storefront purchasing requires the backend's exact versioned policy set and document hashes, device limits use the server-provided aggregate entitlement capacity, and compatibility copy now calls out external-display brightness limitations.
- **SEC-002 (open production gate):** Documented the required Cloudflare Pages/proxy response-header configuration and production verification; document-level CSP metadata remains defense in depth, not a substitute for HTTP headers.
- **OPS-001 (local phase):** Implemented the local Supabase/Postgres commerce and entitlement control plane, strict Cloudflare Worker facade, Stripe checkout/webhook validation, passwordless portal, signed device permits, refund/dispute lifecycle, retention jobs, API contract, and production operations runbook. Portal access now requires a backend-signed marker bound to the verified email-link user/session; password-only sessions cannot upgrade through refresh, v1 account emails are immutable, and Supabase `anon`/`authenticated` roles have zero direct commerce-table privileges. No provider resources were created and the offer remains unpublished.
- **QA-002 (partial):** Local desktop/mobile visual QA passed for the purchase and portal surfaces with no horizontal overflow or console errors, and API-unavailable states failed closed. Storefront checks, Edge/Worker suites, disposable-Postgres behavior tests, and app licensing/build checks also pass. Live API, real payment/refund, production signing/notarization, and distributed-app end-to-end verification remain open.

Historical entries above retain their original scope. LIC-002 has now been deployed and verified only in the private test environment; no production payment or production license launch is complete.


## 2026-10-26 production preparation

Integrated reviewed production code isolation, prepared immutable one-Mac policies and scoped security headers, provisioned an empty disabled live database, and built/notarized/stapled the separate production-key candidate. 59 backend tests, three database phases, 11 policy SQL cases, 26 release tests and header/static checks passed. Production launch remains pending. Attribution, provider state, caveats and exact continuation: [production preparation](commerce/VALIDATION_SUMMARY.md). No commit/push or public release.


## 2026-10-26 source publication preparation

User authorized commit and push. Source is prepared on `codex/gesture-flow-commerce-preparation`; main, Pages, live checkout and app releases remain unchanged. Covered tickets: WEB-001, LEGAL-001, SEC-001, QA-001, LIC-001, LIC-002 and local preparation under LIC-003, SEC-002, REL-001, OPS-001, QA-002. Design-only work and private provider evidence are excluded from the public commit. Public validation: [summary](commerce/VALIDATION_SUMMARY.md). Commit ref: `4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef`.

Codex independently reran 59 backend tests/typecheck, 6 proxy tests/typecheck, 11 policy database cases, three purchase database phases, and storefront/header validation. Desktop counterpart passed 159 Python tests. Opus final source-publication review is tracked in the local handoff; this is not production launch approval.

Source checkpoint 2026-10-26T20:45:47+00:00: Opus final review cleared source publication after private-evidence and local-settings exclusions; Codex verified the exact staged tree. Source commit `4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef`; branch push does not merge main or deploy.

## 2026-10-26 security and free-plan follow-up

- **SEC-003:** Deployed device-key binding and bounded request parsing to the isolated backends and proxy; patched deployment dependencies. 66 backend and 7 proxy tests/typechecks pass. Prepared and deployed route-scoped website headers. Final production acceptance remains pending.
- **OPS-003:** Supabase Free and Resend free/base are the launch constraint. Paid upgrades, add-ons, automatic overages and carbon remain disabled. Manual encrypted exports and PG17 restore drills passed; unattended backups and external monitoring remain incomplete.
- **LIC-003 / REL-001:** Managed Payments sandbox checkout, email, current-source activation, reload, offline expiry and replay checks passed. Restricted-key and durable refund-revocation proof are still pending. Sales remain disabled.

## 2026-10-26 production integration checkpoint

- **OPS-003:** Verified production SMTP delivery, one-time token verification/replay rejection, and the first automatic worker run. Independent monitoring and unattended off-site backups remain incomplete.
- **SEC-002 / LIC-003:** Prepared explicit production proxy routing with eight passing tests/typecheck. Live webhook is configured but disabled until cutover; temporary setup credential revoked. Restricted-key sandbox acceptance and public publication remain pending.

## Restricted-key acceptance and production cutover — 2026-10-26

- LIC-003 / SEC-002: restricted Managed Payments sandbox payment, activation, replay rejection, refund and durable signed revocation passed. Stable API switched to isolated live project after disabling test offer/webhook; production key readback verified. Live checkout remains disabled.
- REL-001: independent review found shared-origin legacy scripts and personal/business audience mismatch. Reviewed localized pages are required for publication; unpublished terms/manifest/SQL now match the personal-use product. Old installer links removed pending candidate release. Eleven policy scenarios passed.
- OPS-003: reviewed minimal health endpoint deployed; scheduler active. Existing-iCloud encrypted upload/download/restore succeeded. Unattended backup and failure-notification acceptance remain pending.
- Security cleanup: native accessibility output unexpectedly exposed two sandbox keys; owner rotation requested. No values copied into evidence. Fable review remains reserved.
- Attribution: coordinator owned connectors, payment/refund, live routing and policy integration. Native operations_readiness owns monitoring/backup; release_review independently reviewed health and site; candidate_acceptance verified signed artifact/source parity. User reserved later Fable review, so no new Claude assignment. Team policy revision2026-10-13 applied; no engineering-effort percentage claimed. Source commit: `8bcc105be2854202cd9b256bda10960bbebe8814`.

## Free operations completion — 2026-10-27

OPS-003 | P1 | Now | cloud-done: authenticated Workers Free status verified; existing free-plan settings unchanged. Installed launchd backup completed fresh encrypted export/upload and health recording. Fixed transient iCloud failure handling with bounded retry;13 focused tests and independent review passed. Existing cloud-download restore and external failure-notification/recovery evidence retained. Mac availability and free quotas remain documented operational limits. Implementer native operations_readiness; reviewer native release_review; coordinator integration. Policy revision2026-10-13; user reserves Fable security review. Source commit pending.
