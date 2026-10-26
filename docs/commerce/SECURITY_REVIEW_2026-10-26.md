# Commerce security review — October 26, 2026

Status: remediation deployed to isolated test/live backends; final production acceptance and sales approval remain pending.

October 26 follow-up: migration 004 and current functions are deployed to both
projects. The bounded proxy is deployed to the existing test upstream. Route-scoped
website headers are deployed and verified on the still-unpublished commerce paths.
Current checks are 66 backend, 7 proxy and 171 desktop tests; the rebuilt production
candidate is 3.2.29 build47 and has accepted notarization. Managed Payments sandbox
payment/email/current-source activation/reload/offline/replay checks passed; a fresh
restricted-key run and durable refund-revocation evidence remain required. The
original review details below describe the initial local milestone.

## SEC-003 — P1 / Now: local-done, cloud-pending

Reviewed server-controlled checkout prices, verified/idempotent webhook fulfillment,
refund/dispute scope, portal authentication/CSRF, single-use purchase codes, device
proofs and replay handling, RLS/RPC privileges, rate limiting, proxy trust and
website DOM/token handling. No additional confirmed anonymous unpaid-order or
account-takeover path was found in inspected code; this is bounded review evidence,
not a guarantee of absence.

Fixed an authenticated device-slot key replacement path with corrective migration
`202610260004_browser_activation_key_binding.sql`. Active installations reject a
different key; same-key recovery and explicit deactivation/transfers still work.
The API returns409 without issuing a permit. The database regression failed on
the old implementation and passed with the new migration.

Replaced full-upload buffering with bounded streaming/cancellation in the proxy,
JSON parser, webhook and signed device routes. Byte caps apply without trusting
Content-Length, and raw signed text is preserved.

Updated Wrangler4.110.0 to4.153.0 with an exact lockfile. npm audit changed from four
high-severity dependency entries to zero; the advisories concern deployment/dev
tooling rather than packages shipped inside the Worker. No install scripts ran.
Deployment dry-run passed without publishing.

## Validation

- 63 backend tests/typecheck and7 proxy tests/typecheck passed.
- Disposable PostgreSQL purchase/race/refund/environment checks and new key-binding
  regression passed. All11 policy-publication scenarios passed.
- Storefront validation passed for10 primary/scoped pages; header validation passed
  18 host/path cases and16 pages. These are prepared headers, not deployed headers.
- Current tracked-file high-confidence key/token/private-key pattern scan found no
  matches. This did not scan all Git history or every credential pattern.
- Separate desktop project passed167 tests with patched crypto/image dependencies
  and fixed HUD/clock behavior; its previous signed candidate requires rebuilding.

## Remaining gates and limits

The public product and portal routes return404, the existing public license API
serves the test environment, and the homepage lacks the prepared response headers.
Direct unauthenticated Supabase catalog probes returned404. No live checkout or
customer-data testing was performed.

Deploy this migration and functions/proxy into sandbox, complete Managed Payments
restricted-key E2E, finish production webhook/email/worker/alerts and recovery,
publish and verify immutable policies/security headers, isolate production routing,
and complete the rebuilt desktop activation/update checks before enabling sales.
No real charge should be made merely as a test.

Offline permits allow delayed revocation up to their signed lifetime. Trials are
limited per verified account, not per person or physical device; another verified
inbox can receive another trial. These are product limits, not forged payments.
The separate Swift Native testing lock does not enforce this paid licensing system.

Attribution: Codex coordinated/integrated/verified; native payment reviewer audited
commerce and authored the SQL regression/fix; native app reviewer independently
reviewed streaming limits. Final cross-review found no blocking regression. User
reserved a later Fable review; no new Opus job. Commit ref: PENDING.
