# Ticket Completion Log

| Ticket | Qualifier | Completed (UTC) | Commit ref | Validation |
| --- | --- | --- | --- | --- |
| LIC-002 | cloud-done (private test only) | 2026-10-26 | 4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef | 54 Deno tests + typecheck, 6 proxy tests; previous disposable PostgreSQL 3/3; hosted setup, two sandbox purchases/full refunds, real email, signed native activation/relaunch/revocation, trial cap/deactivation, replay/resend, portal regression. See commerce/VALIDATION_SUMMARY.md. No production launch. |
| LIC-001 | local-done | 2026-10-26 | 4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef | 37 Deno tests, 56 Python licensing tests, TypeScript check, disposable PostgreSQL authorization/outbox/concurrent two-Mac/refund checks; no hosted or real email validation |
| WEB-001 | local-done | 2026-07-13 | 4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef | Static validator, JavaScript syntax, local HTTP responses |
| LEGAL-001 | local-done | 2026-07-13 | 4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef | Policy-version and internal-link validation; professional review pending |
| SEC-001 | local-done | 2026-07-13 | 4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef | Local-asset and CSP assertions |
| QA-001 | local-done | 2026-07-13 | 4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef | `node scripts/validate-storefront.mjs` |

## LIC-001 implementation and handoff

- Codex authored and self-reviewed the bounded private activation flow; no independent peer review is claimed. The earlier Team Mode attempt timed out at a terminal approval prompt without modifying its source copy. The user subsequently instructed no further external AI jobs/communications.
- Source remains local and sending is disabled by default. No provider setup, credential changes, customer mail, deployment, commit or push. Existing trial/device/permit/refresh policies and unrelated working-tree changes are preserved. Details, safe test commands and remaining external steps: `commerce/PRIVATE_ACTIVATION_CODES.md`.

### LIC-001 review follow-up — 2026-10-26

Codex applied the recovered static-review findings from Claude Team Mode job `85f703ca-a7a2-403f-b3df-4baad7b5127b`: email-worker isolation, per-row completion handling, shared-template wording, and real exchange tests. Requested alias opus; resolved model unverified in this pass. 44 Deno tests and function typechecking pass. The separate native follow-up review job `750983b2-860d-410c-95a6-874a93bfa4f1` timed out without execution at 15:47:37 UTC and its terminal was closed; earlier terminal inspection was sandbox-denied. No new independent review of these follow-up edits is claimed. No provider configuration, real email, deployment, commit or push.


## LIC-003 / SEC-002 / REL-001 preparation milestone — 2026-10-26

Integrated reviewed production code isolation, prepared immutable one-Mac policies and scoped security headers, provisioned an empty disabled live database, and built/notarized/stapled the separate production-key candidate. 59 backend tests, three database phases, 11 policy SQL cases, 26 release tests and header/static checks passed. Production launch remains pending. Attribution, provider state, caveats and exact continuation: [production preparation](commerce/VALIDATION_SUMMARY.md). No commit/push or public release.


## 2026-10-26 source publication preparation

User authorized commit and push. Source is prepared on `codex/gesture-flow-commerce-preparation`; main, Pages, live checkout and app releases remain unchanged. Covered tickets: WEB-001, LEGAL-001, SEC-001, QA-001, LIC-001, LIC-002 and local preparation under LIC-003, SEC-002, REL-001, OPS-001, QA-002. Design-only work and private provider evidence are excluded from the public commit. Public validation: [summary](commerce/VALIDATION_SUMMARY.md). Commit ref: `4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef`.

Codex independently reran 59 backend tests/typecheck, 6 proxy tests/typecheck, 11 policy database cases, three purchase database phases, and storefront/header validation. Desktop counterpart passed 159 Python tests. Opus final source-publication review is tracked in the local handoff; this is not production launch approval.

Source checkpoint 2026-10-26T20:45:47+00:00: Opus final review cleared source publication after private-evidence and local-settings exclusions; Codex verified the exact staged tree. Source commit `4aefb2bbdd3b0bedc8fd089f1e8c7b280c6663ef`; branch push does not merge main or deploy.

## SEC-003 / OPS-003 / LIC-003 follow-up — 2026-10-26

Codex integrated native reviewer fixes for device-key binding, request streaming, desktop clock/HUD safety and outage retries. Native payment reviewer supplied backup/restore and operations scripts; lead independently inspected restore isolation and Keychain handling. User reserved final Fable review, so no new Opus assignment was started. Current policy revision2026-10-13 was reread. Native delegation covered two of three initial audit slices; this is not an engineering-effort percentage.

66 backend tests/typecheck, 7 proxy tests/typecheck, prior SQL security/race/environment and11 policy cases, scoped storefront/header validation pass. App counterpart has171 passing tests and signed/notarized build47. Both hosted logical backup restores passed; managed Auth ownership blocks the unattended role. Source/backend deployment is distinct from final production routing, webhook, inbox, monitoring and app acceptance. No live transaction or public app release. Source commit: `030a1187ef0b7fbaf4a0f3c8ee0598ace868de76`.

## OPS-003 / SEC-002 / LIC-003 integration checkpoint — 2026-10-26

Codex verified production inbox/token use and replay rejection, configured the disabled live webhook then revoked the temporary setup credential, and installed/verified minutely worker processing. Native payment reviewer corrected the Vault lookup after a rollback-only diagnostic; native e2e reviewer prepared production proxy allowlisting with eight passing tests/typecheck. Codex reviewed both changes. Team policy revision2026-10-13 reread; user reserves final Fable review. No new Opus assignment, live transaction or public app release. Independent monitoring, unattended off-site backup, restricted-key sandbox acceptance and production cutover remain pending. Source commit: `8bbed6c3e5fc7395ebfdd723eb1889ab7c6d4369`.

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
