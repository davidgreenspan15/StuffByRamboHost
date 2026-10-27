# Product Execution Backlog

This file is the execution source of truth for the Stuff by Rambo storefront and license experience.

## Now

- [x] **LIC-003** — **P0** — **Now** — Restricted test payment/refund and native acceptance verified; live sales and purchase-code fulfillment enabled. First genuine sale remains an operating verification limit. `(cloud-done 2026-10-27; released)`
- [x] **REL-001** — **P0** — **Now** — Accepted3.2.29/build49 published; public installer checksum, signed feed, storefront and live offer verified. `(cloud-done 2026-10-27; public release)`

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

- [x] **SEC-003** — **P1** — **Now** — Security fixes, native/update acceptance, key rotation and Fable review complete; no launch blocker. Residuals/PY-SEC-002 retained. `(cloud-done 2026-10-27; reviewed release)`
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

SEC-003 | P1 | Now | in-progress: exposed test-key rotation remains unconfirmed; old restricted key still accepted. Fable final bypass/security review has not run. No live key exposure, real-money test payment, paid upgrade, public appcast/tag or sales enablement. Final evidence in commerce/FABLE_FINAL_REVIEW_2026-10-26.md. Native candidate_acceptance implemented, release_review reviewed, coordinator performed artifact/provider/native/update acceptance. Policy revision2026-10-13; Fable remains reserved. App source: `47c57b1e50451d89d5f6542fdd2c3e3cf735ef79`; evidence commit: `ceb3222dab6106184c263ef41d336396b41c0f6f`.

## Exposed test-key cleanup and Fable assignment — 2026-10-27

SEC-003 | P1 | Now | credential-cleanup cloud-done; final-review in-progress. Owner rotated both exposed sandbox keys. Authenticated Dashboard shows two fresh replacements; old restricted key rejects401, replacement reads the known test price, exact native storage readback and isolated backend replacement passed. Clipboard cleared; live environment unchanged. Full-access revocation relies on owner action and Dashboard replacement because the old value is not retained. Fable final read-only bypass review started as job31529244-792f-48d8-959c-ba6218b56e0d in exact GestureControl root; provider metadata verifies claude-fable-5-1. Policy revision2026-10-13 reread; user explicitly selected Fable. No source/build/test repetition, sale or public release. Credential-evidence commit: `81b31b2`.

## Fable final review completed — 2026-10-27

SEC-003 | P1 | Now | review-done: Fable job31529244-792f-48d8-959c-ba6218b56e0d, provider-verified claude-fable-5-1, found no launch blocker conditional on live migration0004. Coordinator read-only provider check closed that condition: exact function body and device-binding guards match reviewed0004, empty search_path, anon/authenticated denied, service_role allowed. Credential cleanup complete. Full report: commerce/FABLE_FINAL_SECURITY_REVIEW_2026-10-27.md. Nonblocking owner-side TLS response replay, device-code phishing and login CSRF remain documented; no claim that they were fixed. Live first-sale and Managed Payments dispute E2E remain unperformed.

REL-001 | P0 | Now | preparation/review complete; public release pending. Candidate49 unchanged; no new build, broad test campaign, sale, public appcast or paid upgrade. App source47c57b1; credential-evidence commit81b31b2. Coordinator owns integration/provider checks; Fable owns independent final review. Policy revision2026-10-13.

Next: PY-SEC-002 | P2 | Next | proposed: consider refresh-response replay hardening that preserves a monotonic signed-time floor, including repeated equal-iat responses and online clock recovery. Requires a separate reviewed change and candidate rebuild; not counted as fixed by the suggested older-iat check alone.

## Public release complete — 2026-10-27

REL-001 / SEC-003 | P0/P1 | Now | cloud-done: owner authorized release. Gesture Flow3.2.29/build49 published at https://github.com/davidgreenspan15/GestureFlowMacApp/releases/tag/python-v3.2.29. Public download matches the accepted signed/notarized installer: SHA-256 `505aa95a98d53fbcd5515fba750631aa6984ca5c3bdcf89cc852d20a5527453f`,114313993 bytes. Signed Python feed commit `fe6d1af2d9fad5b6b03270a16b904f1ebc65da6d`; accepted source `47c57b1e50451d89d5f6542fdd2c3e3cf735ef79`. App preparation pushed to main at `f8b45c6`; storefront commit `aa21f39aa8603bcde99b4330c52dd4b923c0d3c7`, Pages run40549195882 succeeded. Browser verifies download3.2.29 and $14 price at https://stuffbyrambo.com/gesture-flow/.

Live purchase-code and email runtime flags verified true with no canary restriction. Database purchase-code gate and reviewed USD1400 live offer enabled atomically at2026-10-27T17:18:39Z, preserving one paid Mac/two trial Macs and active policy. Public catalog published/available/purchaseAvailable true; health true. Test offer/webhook remain disabled. Free-plan constraints unchanged. No real-money test purchase; first genuine-sale fulfillment and live dispute-event delivery remain operating verification limits. Prior Fable residuals, including PY-SEC-002, remain recorded.

Scoped commerce validator passed10 primary pages. Broad validator reported11 pre-existing CSP omissions in unrelated Android/design/template files, not a release regression. No new app build or repeated acceptance; older feed item retained. Native Swift lane unchanged. Coordinator released; operations_readiness independently checked gates; final Fable review retained. Team policy revision2026-10-13.
