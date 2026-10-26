# Product Execution Backlog

This file is the execution source of truth for the Stuff by Rambo storefront and license experience.

## Now

- [ ] **LIC-003** — **P0** — **Now** — Production purchase-code support with explicit live gates, unchanged sandbox recipient restrictions, database isolation and regression tests. Opus implementation integrated and independently verified (59 Deno, three PG phases). Migration applied to empty live project with gate off; functions/provider activation remain pending. See production preparation checkpoint. `(local-done; cloud-pending 2026-10-26)`
- [ ] **REL-001** — **P0** — **Now** — Prepare one-Mac versioned policies, production hosting/account configuration, public storefront/portal, and notarized Python release. User approved preparation/launch workflow; financial/provider consent gates and final Git publication remain explicit. `(in-progress 2026-10-26)`

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

- [ ] **SEC-003** — **P1** — **Now** — Device-key binding, bounded uploads and patched tooling deployed to isolated backends/proxy; 66 backend and 7 proxy tests pass. Native hardening has 171 passing tests and a notarized build47 candidate. Final hosted production/app acceptance remains pending. `(in-progress; source and isolated deployment verified)`
- [ ] **OPS-003** — **P1** — **Now** — Supabase Free, Resend base/free and existing free hosting only; no new recurring charge, automatic paid overage or carbon. Manual encrypted backup restores pass; unattended backup and independent monitoring remain open. `(in-progress; owner cost constraint verified)`

## Production integration checkpoint — 2026-10-26

- **OPS-003 | P0 | Now | in-progress | cloud-partial:** Production SMTP/token and automatic scheduler checks pass. Independent monitoring and unattended off-site backups remain open.
- **SEC-002 / LIC-003 | P0 | Now | in-progress | local-done routing preparation:** Live URL allowlisting and eight proxy tests/typecheck pass. Restricted-key sandbox proof, routing cutover and webhook activation remain open; sales remain disabled.
