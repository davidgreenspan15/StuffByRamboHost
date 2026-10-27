# Product Execution Backlog

This file is the execution source of truth for the Stuff by Rambo storefront and license experience.

## Now

- [x] **LIC-003** — **P0** — **Now** — Restricted test payment/refund and durable revocation, isolated production routing, portal and real native trial verified. Live sales remain disabled. `(cloud-done 2026-10-27; disabled-sales preparation)`
- [ ] **REL-001** — **P0** — **Now** — Production site/policies and corrected signed/notarized build49 verified; private43-to49 update preserves access. Test-key cleanup, Fable review and final publication remain. `(in-progress 2026-10-27; preparation complete, public release pending)`

- [x] **LIC-001** — **P0** — **Now (private tests only)** — Add purchase-triggered short-lived activation email, test-recipient/sending guards, paid-test entitlement checks and native code entry using the existing signed device permit. Prior two-Mac concurrency, denial/retry and local restart tests pass. Review follow-up adds isolated email maintenance, conservative batch completion, neutral shared email copy and a real exchange test; 44 Deno tests pass. Current-sandbox DB rerun is blocked by shared-memory restrictions. See `docs/commerce/PRIVATE_ACTIVATION_CODES.md`; hosted configuration, mail, deployment and signed-app end-to-end verification remain pending. `(local-done 2026-10-26)`
- [x] **LIC-002** - **P0** - **Now (private tests only)** - Single-use purchase codes, one Mac per paid order and two-Mac trials: hosted setup and complete private sandbox E2E passed. Two real hosted sandbox checkouts, Resend delivery, native signed-app activation/restart, replay/resend rules, trial cap/deactivation, exact-order full refunds and signed revocation verified. Three integration fixes deployed; 54 Deno tests/typecheck pass. Original Mac state restored. See `docs/commerce/VALIDATION_SUMMARY.md`. Public policy/copy, live setup, website publication and release remain separate gates. `(cloud-done 2026-10-26; private test only)`

- [x] **WEB-001** — **P0** — **Now** — Build the dependency-free Gesture Flow product, purchase, checkout-result, and customer portal surfaces. `(local-done 2026-07-13)`
- [x] **LEGAL-001** — **P0** — **Now** — Publish versioned Terms/EULA, Refund, Privacy, and Compatibility/Permissions surfaces for counsel review. `(local-done 2026-07-13)`
- [x] **SEC-001** — **P0** — **Now** — Remove third-party runtime/font dependencies from every published HTML page, localize the five visual prototypes, and add restrictive document CSPs. `(local-done 2026-07-13)`
- [x] **QA-001** — **P0** — **Now** — Add and pass dependency-free static storefront validation and local HTTP smoke checks. `(local-done 2026-07-13)`
- [ ] **SEC-002** — **P0** — **Now** — Before live portal or checkout, place the static site behind a reviewed Cloudflare Pages/proxy header policy and verify production HTTP headers, including CSP with `frame-ancestors`, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, and X-Content-Type-Options. GitHub Pages and document-level CSP metadata alone cannot guarantee these response headers. Completion requires `cloud-done`.
- [ ] **OPS-001** — **P0** — **Now** — The local catalog, Stripe checkout/webhook control plane, license API, Cloudflare proxy, and production operations runbook are implemented and verified. Provision test/live provider resources, deploy, and verify the complete purchase/refund/activation lifecycle. Completion requires `cloud-done`.
- [ ] **QA-002** — **P0** — **Now** — Local desktop/mobile visual QA, storefront validation, Edge/Worker tests, disposable-Postgres behavior tests, and app licensing/build checks pass. Complete production catalog, checkout, authentication, device, refund, signed/notarized app, and update-feed end-to-end tests after the live API and published price are available. Completion requires `cloud-done`.

## Next

- [ ] **LEGAL-002** — **P1** — **Next** — Obtain New Jersey/US software counsel review of clickwrap, warranty/liability, governing-law, privacy, and refund language before enabling purchases.
- [ ] **TAX-001** — **P1** — **Next** — Confirm New Jersey sales-tax registration and downloadable-software classification with a tax professional; confirm merchant-of-record availability and launch geography.
- [ ] **OPS-002** — **P1** — **Next** — Verify the distributed DMG is Developer ID signed, notarized, stapled, and accepted by Gatekeeper before the published catalog becomes purchasable.

## Later

- [ ] **BILLING-001** — **P2** — **Later** — Design any future subscription as a separate explicit opt-in without changing existing perpetual v3 entitlements.

## October 26 security and free-plan checkpoint

- [ ] **SEC-003** — **P1** — **Now** — Backend security fixes deployed; corrected build49 native/update acceptance passed. Exposed test-key rotation and final Fable bypass review remain. `(in-progress 2026-10-27; remediation verified, final review pending)`
- [x] **OPS-003** — **P1** — **Now** — Supabase Free, Resend free/base and Workers Free confirmed; independent alerts and unattended encrypted iCloud backup plus restore verified. Existing free quotas/Mac availability remain operating limits; no paid upgrade or overages. `(cloud-done 2026-10-27; disabled-sales preparation)`

## Production integration checkpoint — 2026-10-26

- **OPS-003 | P0 | Now | in-progress | cloud-partial:** Production SMTP/token and automatic scheduler checks pass. Independent monitoring and unattended off-site backups remain open.
- **SEC-002 / LIC-003 | P0 | Now | in-progress | local-done routing preparation:** Live URL allowlisting and eight proxy tests/typecheck pass. Restricted-key sandbox proof, routing cutover and webhook activation remain open; sales remain disabled.

## Restricted-key acceptance and production cutover — 2026-10-26

- LIC-003 / SEC-002: restricted Managed Payments sandbox payment, activation, replay rejection, refund and durable signed revocation passed. Stable API switched to isolated live project after disabling test offer/webhook; production key readback verified. Live checkout remains disabled.
- REL-001: independent review found shared-origin legacy scripts and personal/business audience mismatch. Reviewed localized pages are required for publication; unpublished terms/manifest/SQL now match the personal-use product. Old installer links removed pending candidate release. Eleven policy scenarios passed.
- OPS-003: reviewed minimal health endpoint deployed; scheduler active. Existing-iCloud encrypted upload/download/restore succeeded. Unattended backup and failure-notification acceptance remain pending.
- Security cleanup: native accessibility output unexpectedly exposed two sandbox keys; owner rotation requested. No values copied into evidence. Fable review remains reserved.
- Attribution: coordinator owned connectors, payment/refund, live routing and policy integration. Native operations_readiness owns monitoring/backup; release_review independently reviewed health and site; candidate_acceptance verified signed artifact/source parity. User reserved later Fable review, so no new Claude assignment. Team policy revision2026-10-13 applied; no engineering-effort percentage claimed. Source commit: `8bcc105be2854202cd9b256bda10960bbebe8814`.

## Free operations completion — 2026-10-27

OPS-003 | P1 | Now | cloud-done: authenticated Workers Free status verified; existing free-plan settings unchanged. Installed launchd backup completed fresh encrypted export/upload and health recording. Fixed transient iCloud failure handling with bounded retry;13 focused tests and independent review passed. Existing cloud-download restore and external failure-notification/recovery evidence retained. Mac availability and free quotas remain documented operational limits. Implementer native operations_readiness; reviewer native release_review; coordinator integration. Policy revision2026-10-13; user reserves Fable security review. Source commit: `11c378df66cd5bb231cc654dfc0653c7dd9cd8ed`.

## Corrected candidate acceptance — 2026-10-27

REL-001 / PY-SEC-001 | P0 | Now | local-done (private release preparation): corrected3.2.29/build49 is signed/notarized/stapled, patched packaged dependencies verified, real production trial and private Sparkle43-to49 installation/relaunch passed with trial access retained. Original installed app, native Keychain, files and preferences restored/readback-verified; testdevices deactivated. Reject47 for nested-entitlement leakage and48 for stale build interpreter. Explicit inside-out signing and exact dependency preflight prevent recurrence.42 signing/release checks and10 focused dependency/build checks passed, with independent source review.

LIC-003 / SEC-002 | P0 | Now | cloud-done (disabled-sales preparation): restricted test payment/refund/durable signed revocation, live proxy/policies/portal and real production trial verified. OPS-003 | P1 | Now | cloud-done: free-plan readback, independent failure alert/recovery and unattended encrypted backup verified. Final sales/app publication remains pending.

SEC-003 | P1 | Now | in-progress: exposed test-key rotation remains unconfirmed; old restricted key still accepted. Fable final bypass/security review has not run. No live key exposure, real-money test payment, paid upgrade, public appcast/tag or sales enablement. Final evidence in commerce/FABLE_FINAL_REVIEW_2026-10-26.md. Native candidate_acceptance implemented, release_review reviewed, coordinator performed artifact/provider/native/update acceptance. Policy revision2026-10-13; Fable remains reserved. Source commit: pending.
