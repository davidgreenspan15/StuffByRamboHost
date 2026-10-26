# Gesture Flow Commerce and Licensing Production Runbook

Status: **NOT EXECUTED — local planning artifact only**

Last reviewed against the repository: 2026-07-13

Owners: Rami Greenspan (product/engineering), designated operations owner,
independent software/privacy counsel, and a US/New Jersey tax professional.

This runbook covers the Stuff by Rambo static storefront, Stripe Checkout,
Supabase commerce/licensing control plane, Cloudflare license API facade, and
the Gesture Flow Python/MediaPipe macOS release. It is not legal or tax advice.
This documentation subtask did not create or change any external/production
resource, secret, price, webhook, DNS record, deployment, distributed app,
commit, or release. The storefront, service, and app source implemented by the
approved local build plan remains local-only until separately authorized.

## 1. Non-negotiable launch gates

Purchases remain disabled until every row below is signed off. A local build,
test-mode transaction, or deployed API is not launch approval.

| Gate | Required evidence | Owner | Current state |
| --- | --- | --- | --- |
| Merchant model | Written decision: Stripe Managed Payments or Stripe Standard; account eligibility and provider terms captured | Rami + CPA/counsel | **OPEN / NOT EXECUTED** |
| Product tax code | Stripe and CPA confirmation of the correct eligible tax code and product positioning | CPA + Stripe | **BLOCKING / NOT EXECUTED** |
| Sales tax | Written scope for registrations, collection, filing, and unsupported countries | CPA | **BLOCKING / NOT EXECUTED** |
| Legal terms | Counsel approval of Terms/EULA, Refund Policy, Privacy Policy, compatibility disclosures, clickwrap, warranty/liability, and governing law | Counsel | **BLOCKING / NOT EXECUTED** |
| Policy evidence | Exact accepted HTML preserved immutably and production hashes matched to the database | Counsel + engineering | **BLOCKING / NOT EXECUTED** |
| Refund operations | Named owner, response SLA, controlled approval procedure, full-refund reconciliation, and customer communications | Operations + counsel | **OPEN / NOT EXECUTED** |
| Security | Threat review closed; Stripe event allowlist, RLS, CORS, CSRF, portal-session marker, hosted Auth restrictions, proxy trust, rate limits, headers, and alerts verified | Engineering/reviewer | **OPEN / NOT EXECUTED** |
| Test isolation | Separate Stripe, Supabase, signing-key, email, and Worker resources proven not to mix with live | Engineering | **OPEN / NOT EXECUTED** |
| Live readiness | Live configuration and fail-closed checks without a charge; sandbox payment/refund/revocation proof; first genuine customer sale reconciled after launch | Rami + operations | **OPEN / NOT EXECUTED** |
| Signed app | Developer ID signature, profile, Keychain entitlement, notarization, staple, Gatekeeper, arm64, and macOS 15 checks | Release owner | **OPEN / NOT EXECUTED** |
| Production E2E | Purchase, portal, activation, one-Mac paid and two-Mac trial caps, offline permit, deactivation, refund, dispute-state simulation, and recovery matrix | QA + engineering | **OPEN / NOT EXECUTED** |
| Launch approval | Final checklist names, timestamps, deployment IDs, code revision, policy versions, and rollback owner | All owners | **OPEN / NOT EXECUTED** |

Related repository gates remain open: <code>SEC-002</code>,
<code>OPS-001</code>, <code>QA-002</code>, <code>LEGAL-002</code>,
<code>TAX-001</code>, and <code>OPS-002</code>.

### 1.1 Merchant-of-record and tax decision

Prefer Stripe Managed Payments only if Stripe has enabled the account, the
product and selling countries are eligible, its current terms have been
accepted, and the economics and customer-support model are approved. Stripe
describes Managed Payments as its merchant-of-record product for eligible
digital goods, but it also states that the seller remains responsible where its
indirect-tax coverage does not apply:

- [Managed Payments overview](https://docs.stripe.com/payments/managed-payments)
- [How Managed Payments works](https://docs.stripe.com/payments/managed-payments/how-it-works)
- [Managed Payments setup and eligibility prerequisites](https://docs.stripe.com/payments/managed-payments/set-up)

The current EULA permits both personal use and internal business use. Stripe
Managed Payments eligibility distinguishes tax/product classifications that can
depend on downloadable-software use. **Do not choose a tax code by intuition.**
Before creating or publishing the live price:

1. Have Stripe confirm that the intended product description and tax code are
   eligible for Managed Payments.
2. Have the CPA confirm the classification, including whether personal and
   internal-business use can share one offer.
3. Align the storefront, Stripe product, EULA license grant, and tax code. If
   required, narrow the permitted use or create separate offers before launch.
4. Record the decision and supporting correspondence in the private launch
   evidence folder without copying secrets or customer data.

If Managed Payments is unavailable, Stripe Standard is a separate launch model:
Stuff by Rambo is the merchant, purchases remain US-only, and the CPA must
approve downloadable-software tax treatment, nexus/registration, Stripe Tax
configuration, refund accounting, and dispute ownership. The application's IP
country and Stripe billing-country checks are defense in depth, not a legal
determination of customer location.

The backend intentionally fails configuration when neither model's
acknowledgements are complete. Never set acknowledgement flags merely to make a
deployment start.

### 1.2 Legal and policy-evidence gate

Counsel must review the current policy pages before purchase is enabled. The
voluntary policy is a 14-day full-refund window subject to mandatory rights; do
not replace it with a blanket “no refunds” statement without counsel.

The database stores immutable document versions and SHA-256 hashes, but the
current canonical URLs are unversioned paths. Before live:

1. Prefer immutable, versioned public URLs for every policy document; otherwise
   preserve the exact accepted HTML bytes in durable, write-protected storage or
   a signed release artifact.
2. Hash the exact production response bytes for Terms/EULA, Refund, Privacy,
   and Compatibility. Compare them to the policy rows and <code>supabase/seed.sql</code>.
3. Save the production response headers, retrieval timestamp, URL, hash, policy
   set version, code revision, and artifact location in the private launch
   record.
4. Never edit a published policy row or silently replace accepted bytes. Create
   new document versions and a new policy set, deploy the new pages, update the
   storefront version, then move the offer only after checkout is disabled.
5. Keep policy acceptance, order, refund, dispute, and tax evidence for the
   period counsel and the CPA specify. The 35-day Stripe-envelope cleanup is not
   the retention policy for purchase or legal evidence.

## 2. Architecture and trust boundaries

Production request flow:

1. <code>https://stuffbyrambo.com</code> serves static first-party storefront,
   legal, checkout-result, and portal pages.
2. Browser and macOS clients call
   <code>https://licenses.stuffbyrambo.com/v1</code>.
3. The Cloudflare Worker accepts the stable public hostname, caps bodies at
   1 MiB, forwards an explicit header allowlist, replaces raw client IP with an
   HMAC plus coarse country, adds the shared proxy credential, disables
   redirects, and applies no-store/security headers.
4. The Supabase <code>commerce-api</code> Edge Function rejects untrusted direct
   traffic, owns browser/device authentication, validates Stripe, and uses the
   service role for transactional RPCs.
5. Postgres is the commerce source of truth. Forced RLS and zero commerce-table
   privileges for <code>anon</code>/<code>authenticated</code> prevent direct
   browser reads and mutation; all customer access crosses the marked portal
   API. Published policies and order evidence are immutable. Each
   independently paid v3 order creates its own entitlement and two-Mac
   allowance; duplicate payments are not collapsed into one license.
6. Stripe Checkout collects payment details. Card data never passes through
   Stuff by Rambo, Cloudflare application code, or Supabase tables.
7. The <code>stripe-worker</code> function leases queued Stripe envelopes,
   re-fetches authoritative Stripe objects, applies idempotent reducers, retries,
   dead-letters repeated failures, and runs retention.
8. The distributed app embeds public Ed25519 permit-verification keys. Private
   device keys and authoritative local state remain in the macOS Data Protection
   Keychain. The app contains no Stripe, Supabase, or signing private key.

Fail-closed behavior is intentional: missing configuration returns unavailable,
direct Supabase calls lack the proxy credential, unpublished offers cannot
checkout, invalid/missing app public keys grant no access, and an unsigned
network denial cannot revoke an otherwise valid offline permit.

## 3. Test/live separation and safest initial test path

Use independent resources, credentials, identifiers, and signing material.
An <code>environment</code> column in one database is not a substitute for
provider-level separation.

| Provider | Test | Live |
| --- | --- | --- |
| Stripe | Sandbox products, prices, endpoint, and signing secret | Live products, prices, endpoint, and signing secret |
| Supabase | Dedicated hosted project and Auth users | Dedicated hosted project and customer data |
| Cloudflare | Isolated Worker/version and upstream bindings | Production Worker/version and custom domain |
| Permit signing | Test-only Ed25519 key pair | Live key pair held only in the production secret store |
| Email | Test sender/mailbox or controlled recipients | Authenticated transactional domain and production SMTP |
| App | Non-distributable ad-hoc build with test public key | Developer ID signed/notarized build with intended live public-key set |
| Evidence | Synthetic identities and test provider IDs | Minimum necessary production IDs; no secret or card data |

The production app currently and correctly fixes its API origin to the stable
production hostname. It must not become runtime-configurable. The safest
available initial-launch path is therefore:

1. Confirm there are no real customers, no distributed licensing build, and no
   published live offer.
2. Point the stable license hostname to the isolated **test** Supabase/Stripe
   stack.
3. Build a non-distributable ad-hoc app that embeds only the test permit public
   key. Mark the bundle and screenshots as test; never upload this DMG.
4. Run the full test E2E matrix through the stable hostname.
5. Disable the test offer and test webhook, preserve test evidence, and verify
   that no test customer data is copied to live.
6. Add the isolated live Supabase function URL to the Worker's source allowlist,
   then replace the Worker upstream and all runtime bindings with the live stack.
   Verify binding names/fingerprints through provider consoles without printing
   values.
7. Run fail-closed live smoke tests while the live offer remains unpublished.
8. Build and verify the separate production-signed app with only the intended
   live/overlap public keys.

Future hardening is a compile-time, non-distributable staging bundle ID/origin
lane. It must use test keys and cannot share the production update feed or be
accepted as a production release. Do not weaken the distributed app's fixed
origin to make staging easier.

## 4. Required configuration names

Only names are documented here. Never put values in this file, tickets, chat,
shell history, logs, screenshots, or source control. Enter values directly in
the provider's secret UI or an approved secret manager. Verify presence and
fingerprints/last-rotated metadata, not contents.

### 4.1 Cloudflare Worker runtime

- <code>SUPABASE_FUNCTION_URL</code>
- <code>UPSTREAM_PROXY_SECRET</code>
- <code>IP_HASH_SECRET</code>

Treat all three as Worker secrets even though the upstream URL is not itself a
credential. The shared proxy secret must match Supabase; the IP HMAC secret is
Worker-only. Test and live use independently generated material.

### 4.2 Supabase Edge Functions

Platform-provided names (do not manually copy between projects):

- <code>SUPABASE_URL</code>
- <code>SUPABASE_ANON_KEY</code>
- <code>SUPABASE_SERVICE_ROLE_KEY</code>

Project configuration names:

- <code>EXPECTED_SUPABASE_PROJECT_REF</code>
- <code>STRIPE_ENVIRONMENT</code>
- <code>STRIPE_SECRET_KEY</code>
- <code>STRIPE_WEBHOOK_SECRET</code>
- <code>STRIPE_API_VERSION</code>
- <code>STRIPE_MANAGED_PAYMENTS_ENABLED</code>
- <code>STRIPE_MANAGED_PAYMENTS_TERMS_ACCEPTED</code>
- <code>STRIPE_MANAGED_PAYMENTS_ELIGIBLE_TAX_CODES</code>
- <code>STRIPE_AUTOMATIC_TAX_ENABLED</code>
- <code>STRIPE_STANDARD_US_ONLY_ACKNOWLEDGED</code>
- <code>STRIPE_STANDARD_TAX_CONFIGURATION_REVIEWED</code>
- <code>SITE_ORIGIN</code>
- <code>ALLOWED_SITE_ORIGINS</code>
- <code>LICENSE_ORIGIN</code>
- <code>CHECKOUT_SUCCESS_URL</code>
- <code>CHECKOUT_CANCEL_URL</code>
- <code>ACTIVATION_CODE_HMAC_SECRET</code>
- <code>CONTEXT_HMAC_SECRET</code>
- <code>COMMERCE_CRON_SECRET</code>
- <code>UPSTREAM_PROXY_SECRET</code>
- <code>ALLOW_LOCAL_DIRECT_REQUESTS</code>
- <code>PERMIT_SIGNING_KEY_ID</code>
- <code>PERMIT_SIGNING_PRIVATE_JWK</code>
- <code>PERMIT_SIGNING_PUBLIC_JWKS</code>

<code>EXPECTED_SUPABASE_PROJECT_REF</code> is a public deployment binding, not a
credential. It must match the project ref in the platform-provided
<code>SUPABASE_URL</code>; test and live must use their own refs. The live project
must reject local direct requests. The permit private key is never placed in
Cloudflare, GitHub, the app, or a test project.

When Managed Payments is enabled,
<code>STRIPE_MANAGED_PAYMENTS_ELIGIBLE_TAX_CODES</code> is a comma-separated,
operator-approved allowlist of currently eligible Stripe digital-product tax
codes. Do not guess or default this list: counsel/CPA review and Stripe's current
eligibility rules must establish it. Checkout requires the immutable offer
snapshot's tax code to be in the allowlist and to match the expanded Stripe
Product exactly.

### 4.3 GitHub Actions macOS release

Repository secrets:

- <code>PYTHON_DEVELOPER_ID_PROVISIONING_PROFILE_BASE64</code>
- <code>APPLE_CERT_P12</code>
- <code>APPLE_CERT_PASSWORD</code>
- <code>KEYCHAIN_PASSWORD</code>
- <code>APPLE_ID</code>
- <code>APPLE_TEAM_ID</code>
- <code>APPLE_APP_SPECIFIC_PASSWORD</code>
- <code>RELEASE_REPO_TOKEN</code>
- <code>SPARKLE_PRIVATE_KEY</code>

Repository variable:

- <code>PYTHON_LICENSE_PUBLIC_KEYS_JSON</code>

Optional deployment automation, if later added, must use least-privilege
provider credentials with separate test/live scopes. Relevant names may include
<code>SUPABASE_ACCESS_TOKEN</code>, <code>SUPABASE_PROJECT_REF</code>, and
<code>CLOUDFLARE_API_TOKEN</code>; none is currently required by a checked-in
StuffByRamboHost deployment workflow.

## 5. Stripe setup and proof

### 5.1 API version and Adaptive Pricing

Pin one exact Stripe API version everywhere: outbound requests, the webhook
endpoint, test evidence, and live evidence. Managed Payments requires
<code>2025-03-31.basil</code> or later. Do not use an unrecorded “latest”
version. Stripe's Basil change keeps Checkout Session
<code>currency</code>/<code>amount_total</code> in the integration's base
currency and exposes buyer conversion under
<code>presentment_details</code>:

- [Basil Adaptive Pricing change](https://docs.stripe.com/changelog/basil/2025-03-31/add_presentment_details)
- [Checkout Session object](https://docs.stripe.com/api/checkout/sessions/object)

For test and the controlled live proof:

1. Confirm the session is <code>mode=payment</code>, its livemode matches the
   target, and it contains exactly one quantity-one line item.
2. Confirm line-item price/product IDs match the persisted offer snapshot.
3. Confirm session currency and base subtotal equal the immutable offer snapshot.
4. For an authorized buyer whose real location produces conversion, capture
   <code>presentment_details</code> currency/amount and compare it to Checkout.
   Never use a fabricated billing address.
5. Confirm fulfillment stores base currency/amount and buyer presentment
   currency/amount separately.
6. Confirm a base-currency checkout legitimately has absent or equivalent
   presentment details.
7. Repeat after any Stripe API-version, price, tax, or Managed Payments change.

Sandbox proof is necessary but not sufficient. A controlled live transaction
requires explicit approval, a real authorized payment method, awareness of fees
and tax effects, and subsequent full-refund reconciliation.

### 5.2 Product and price

Create distinct test and live products/prices. Before publishing either:

- Product name, description, one-time/perpetual v3 scope, two-Mac limit, and
  support contact match the storefront and EULA.
- The price is one-time, active, in the approved base currency and amount.
- The product tax code passed the hard gate in section 1.1.
- Managed Payments is enabled and its terms accepted, or all Standard-mode
  US/tax gates are approved.
- Stripe Checkout business details, support email, privacy URL, terms URL,
  statement descriptor, and branding are reviewed.
- No test ID is present in the live database and no live ID is present in test.

### 5.3 Checkout and webhook event allowlist

Webhook URL: <code>https://licenses.stuffbyrambo.com/v1/stripe/webhook</code>.
Use separate test/live endpoints, signing secrets, and the same pinned API
version as outbound Stripe requests.

**Launch blocker:** the Dashboard subscription list and the code-level
<code>ACTIONABLE_STRIPE_EVENT_TYPES</code> allowlist must be byte-for-byte
identical. Copy the final constant mechanically into the private launch record;
do not infer event names from a prefix. Signed but unsupported events may retain
only the minimal PII-free envelope as <code>ignored</code>; they must never enter
the actionable queue or be processed.

Subscribe the Stripe endpoint to exactly:

- <code>checkout.session.completed</code>
- <code>checkout.session.async_payment_succeeded</code>
- <code>checkout.session.async_payment_failed</code>
- <code>checkout.session.expired</code>
- <code>refund.created</code>
- <code>refund.updated</code>
- <code>refund.failed</code>
- <code>charge.refunded</code>
- <code>charge.dispute.created</code>
- <code>charge.dispute.updated</code>
- <code>charge.dispute.closed</code>

Required behavior tests:

- Invalid signatures, wrong livemode, oversized bodies, and malformed objects
  are rejected. Unsupported types become minimal <code>ignored</code> records.
- Endpoint API-version drift is detected as an operations/configuration error;
  authoritative object retrieval remains pinned to the reviewed outbound
  version.
- Duplicate deliveries are acknowledged without duplicate entitlements.
- Fulfillment occurs from webhook-confirmed paid state, never from the success
  redirect alone.
- Delayed payment success/failure and expired Checkout Sessions converge.
- Refund and dispute events retrieve current provider objects before reducing
  order/entitlement state.
- Webhook processing is safe out of order and after a Worker crash.

## 6. Supabase provisioning and deployment

All commands in this section are examples for an approved operator.
**None was run by this task.** Run first in the isolated test project from a
clean checkout at the recorded revision. Never run
<code>supabase db reset</code> against a linked hosted project.

### 6.1 Preflight

1. Follow the explicitly approved Free-only backup plan in section 6.4 and perform its restore drill. Do not enable Pro, PITR, add-ons or paid overage.
2. Confirm the target project ref and environment aloud with a second reviewer.
3. Run local function formatting, checks, tests, migration behavior tests, RLS
   cross-account tests, and storefront/Worker tests.
4. Review the migration dry run and save it as launch evidence.
5. Confirm <code>supabase/config.toml</code> keeps platform JWT verification
   disabled for these two functions because the application implements the
   trusted proxy, portal session/CSRF, device signatures, cron bearer, and
   Stripe raw-body signature checks itself.
6. Confirm all seed offers remain unpublished, disabled, zero-priced, and
   without provider IDs.

Approved database sequence, with the target placeholder replaced interactively:

~~~text
supabase link --project-ref <TARGET_PROJECT_REF>
supabase db push --linked --dry-run
supabase db push --linked --include-seed
~~~

After the migration/seed verification, enter the configuration names from
section 4.2 directly in the target project's secret UI. Only then deploy:

~~~text
supabase functions deploy commerce-api --project-ref <TARGET_PROJECT_REF>
supabase functions deploy stripe-worker --project-ref <TARGET_PROJECT_REF>
~~~

Use the Supabase Dashboard secret manager for the names in section 4.2. Do not
create an env file in the repository. Hosted Edge Functions supply the three
platform names automatically. Setting secrets takes effect immediately, so
coordinate shared-secret rotations.

### 6.2 Post-migration verification

Verify with read-only queries and API behavior:

- Every commerce table has RLS enabled and forced.
- <code>anon</code> and <code>authenticated</code> have no read or mutation grants
  on any commerce table; a Supabase token alone cannot bypass the portal marker.
- The marked portal API returns only the authenticated account's orders,
  entitlements, devices, and refund requests.
- Service-role RPC grants are limited to the reviewed commerce functions.
- Published policy/order evidence triggers reject mutation.
- One trial per account/product and two active device slots are enforced under
  concurrency.
- Checkout intent creation snapshots offer and policy atomically.
- Stripe event claims use unique leases, reclaim stale processing after five
  minutes, and reject completion by a stale worker.
- Stripe envelopes dead-letter only after the reviewed attempt threshold.
- The seed policy hashes match production evidence and both offers are disabled.

### 6.3 Scheduler and retention

Schedule <code>stripe-worker</code> once per minute using Supabase Cron or an
equivalent provider scheduler that can store
<code>COMMERCE_CRON_SECRET</code> in a managed secret store. Do not hardcode the
bearer in SQL, source control, or a URL. Supabase documents Cron, <code>pg_net</code>,
and Vault for scheduled Edge Functions:

- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [Scheduling Edge Functions securely](https://supabase.com/docs/guides/functions/schedule-functions)

The current worker claims at most 20 events per invocation and also calls
<code>commerce_run_retention</code>. The current retention RPC:

- removes expired device nonces, rate-limit buckets, and API idempotency rows;
- removes expired unlinked challenges after 24 hours;
- scrubs credentials/device metadata from retained policy-evidence challenges;
- deletes only <code>processed</code>/<code>ignored</code> minimal Stripe
  envelopes after their 35-day retention date. Processing, failed, and
  dead-letter records persist until an operator resolves them; retention must
  never erase unresolved payment state.

Alert if no successful scheduled run occurs for five minutes. Counsel/CPA must
set separate retention rules for accounts, orders, policy acceptances,
entitlements, refunds, disputes, audit entries, backups, and deletion requests.

### 6.4 Free-only backups and operational verification (2026-10-26)

Rami explicitly requires **Supabase Free, Resend base/free and no paid add-ons
or overage**. This supersedes any earlier mandatory Pro/PITR assumption in this
runbook. Supabase recommends off-site logical exports for Free projects;
automatic paid-plan backups are not part of this approved setup.

The private `Gesture-Flow` app repository contains
`.github/workflows/commerce-backup.yml` and `scripts/ops/commerce_backup.py`.
The workflow is disabled unless `COMMERCE_BACKUP_ENABLED=true`. It runs daily
at 06:23 UTC only once the workflow exists on the repository default branch.
Before enabling it, verify the account's remaining included Actions minutes
and storage and its **zero paid spending allowance**. Free allowances are
shared across repositories; this workflow does not buy capacity. A missed or
failed run must alert the owner through Actions notifications/an independent
monitor and must never trigger a paid upgrade automatically.

- The prepared `commerce_backup` role is intended to have no role memberships,
  inheritance, permanent create/write/admin privileges or Vault/net/Cron access.
  **Hosted least-privilege setup is blocked:** rollback-only probes against test
  and live on 2026-10-26 failed at Auth-owned `schema_migrations` policy creation
  (`must be owner of table schema_migrations`); `postgres` cannot SET ROLE to
  `supabase_auth_admin`. Neither probe left a backup role behind. Do not enable
  the unattended workflow or grant `service_role`/admin access to work around
  this. `scripts/commerce-backup-grants.sql` remains a prepared script, initially
  creating `NOLOGIN`; effective PUBLIC privileges also require review.
- The backup role receives SELECT and explicit SELECT-only RLS policies on
  `public`, `auth` and `supabase_migrations`. `pg_dump --enable-row-security`
  exports these schemas with ACLs; preflight rejects missing read policies,
  write privileges, accessible SECURITY DEFINER routines, unsafe schema access,
  or excessive role attributes/memberships. New tables require review and
  rerunning the grants script.
- GitHub Actions receives only the dedicated connection credential and the
  **public** age recipient. The private age identity remains in macOS Keychain.
  `pg_dump` streams directly into age; no plaintext database archive is written
  to runner disk, logs or artifacts. Provider/subprocess errors are reduced to
  fixed error codes. TLS verifies the endpoint certificate.
- Each encrypted archive is capped at **20 MiB** and retained for **7 days**.
  One daily successful run uses at most approximately 140 MiB across seven
  retained archives, plus small manifests. Manual reruns/retries also count;
  account-wide usage must remain inside the shared free quota. The ten-minute
  job timeout bounds runtime; actual included usage must be checked.
- Archives contain Auth data, commerce data/schema/security ACLs and migration
  history. They exclude Vault/root encryption keys, provider project settings,
  Edge Function secrets, custom role passwords, scheduler state and Storage
  object bytes. Restore those separately from approved native/provider sources.
  If Auth gains encrypted columns requiring a provider root key, use the
  documented Supabase root-key migration procedure; a logical archive alone
  cannot prove Auth service recovery.
- `scripts/ops/commerce_restore_drill.py` only creates a new private Unix-socket
  PostgreSQL cluster. It accepts no existing destination URL, verifies archive
  integrity, retrieves the age identity from Keychain, restores schema/data,
  and checks commerce RLS/browser table/RPC restrictions. The identity reaches
  age through standard input; it is never written to disk. The private cluster
  is deleted after verification. PostgreSQL binaries must match the archived
  server major (both hosted projects currently use **17**).
  **Actual PG17 manual encrypted exports and local restore drills passed on
  2026-10-26:** test contained two orders, one Auth user, three entitlements and
  four activations (358,616 encrypted bytes); live contained zero rows in those
  four tables (344,328 bytes). Source/restored counts matched. Both restored all
  23 commerce tables with forced RLS and zero browser table/RPC grants.
  Archives and sanitized evidence remain in the private production setup
  directory's `encrypted-backups/`; no customer data was uploaded or printed.
  This used the approved manual admin export fallback, **not the blocked
  unattended role**. A logical drill is distinct from hosted Auth/SMTP/function
  recovery or a verified daily backup schedule.
- The current native age identity is in Keychain service
  `codex.gesture-flow.commerce-backup.age-v2`, account `ramigreenspan`. Its owning
  helper `store-backup-key-v2` and hash/locator record are in the private
  production setup directory. Preserve that exact helper binary: rebuilding
  can change Keychain access identity. Its `read` output is secret and must only
  be captured privately or piped to age. The earlier unused key was preserved;
  it protects no archives. Do not place the identity in GitHub credentials.
- Supabase's pooler requires its provider root CA for `verify-full`; the system
  CA bundle did not validate it. The verified public certificate is saved as
  `supabase-prod-ca-2021.crt` in the private setup directory. The prepared
  workflow must receive the appropriate public CA before activation; do not
  weaken TLS validation to make it connect.
- Daily export has a roughly 24-hour recovery point only while every daily run
  succeeds. GitHub schedules can be delayed and Free Supabase can pause or hit
  resource limits. Provider availability and capacity are not guaranteed by
  this backup. Do not claim zero data loss or paid-plan availability.

Scheduler setup is prepared in `scripts/commerce-ops-install.sql`, using
pg_cron/pg_net and two Vault entries (`gesture_flow_project_url` and
`gesture_flow_cron_secret`). Invoke with `psql -v job_name=gesture-flow-live-worker`
for live or `gesture-flow-test-worker` to adopt the existing test job; the stable
job name updates the schedule rather than creating another job. Inspect the
existing Vault names and migrate/reference them deliberately before applying.
No secret value belongs in SQL source or the cron command. pg_net temporarily
stores the decrypted request header in its queue: verify effective queue/schema
permissions before creating another database login.

`scripts/commerce-ops-health.py --job-name gesture-flow-live-worker` reads only
aggregate queue/scheduler/email health through the supplied libpq connection.
It exits 2 for a missing successful worker response within five minutes, stale
leases, old pending work, dead letters, or failed/uncertain email work. It emits
no customer rows or credentials. **Poll it from outside the same Supabase Cron**
to detect a stopped scheduler; a job cannot prove its own scheduler is alive.
External polling/notification delivery and actual production scheduled success
must be separately verified. No monitoring service or email was enabled by
preparing these files.

Sources checked: [Supabase backups](https://supabase.com/docs/guides/platform/backups),
[logical backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

## 7. Cloudflare facade, domain, WAF, and headers

### 7.1 Worker and custom domain

Current checked-in intent:

- Worker: <code>gesture-flow-license-api</code>
- Custom domain: <code>licenses.stuffbyrambo.com</code>
- <code>workers_dev</code> disabled
- Observability enabled with 10% head sampling
- Strict request/response header allowlists and 1 MiB body cap
- No redirects, no-store, request IDs, IP HMAC, and country normalization

Before any deployment:

1. Confirm the zone/account and custom-domain ownership.
2. Confirm proxied DNS and valid TLS. Do not expose an alternate Worker dev URL.
3. Enter the three Worker secret names interactively.
4. Verify the upstream is the exact target project's
   <code>commerce-api</code> base and uses HTTPS without credentials, query, or
   fragment.
5. Authenticate Wrangler, run the checked-in tests, then dry-run.
6. Deploy only with separate explicit approval and record the Worker
   deployment/version ID.

~~~text
npx wrangler whoami
deno task check
deno task test
npx wrangler deploy --dry-run
~~~

The actual deploy command is intentionally omitted from the automatic sequence.
Cloudflare rollback uses a known-good Worker version; never roll back bindings
to test or compromised material.

### 7.2 WAF and rate limiting

Apply zone WAF rules in log mode first, review false positives, then enforce.
Machine endpoints must receive HTTP responses, not interactive browser
challenges.

- Enable the applicable Cloudflare managed rulesets.
- Block methods outside GET, POST, DELETE, and OPTIONS for the license hostname.
- Block paths outside the exact <code>/v1</code> route set; reject nested or
  encoded aliases.
- Keep the Stripe webhook POST-only. Do not apply a JS/managed challenge to it;
  raw-body signature verification remains authoritative.
- Rate-limit by exact path. Set edge thresholds slightly above application
  thresholds so the database limiter remains canonical.
- Account for shared NATs. Do not use IP alone to revoke accounts or devices.
- Verify plan-specific WAF/rate-limit capabilities before treating a rule as
  active.

Application limits that edge policy must not undercut:

| Operation | Application threshold |
| --- | --- |
| Checkout creation | 10 per IP / 10 minutes |
| Magic-link request | 5 per IP and 3 per email / 15 minutes |
| Portal session exchange | 10 per IP / 15 minutes |
| Activation challenge | 10 per IP / 10 minutes |
| Activation approval | 10 per IP and account / 10 minutes |
| Activation exchange polling | 140 per IP and poll credential / 10 minutes |
| Device refresh | 120 per IP and activation / 10 minutes |
| Signed-time recovery | 60 per IP / 10 minutes |
| Refund request | 5 per account / day |

Use Security Events to prove rules match and do not interfere with Stripe,
portal cookies, app polling, or device signatures.

### 7.3 Response-header gate

GitHub Pages and meta CSP cannot supply every required HTTP header. Before live,
put the static site behind a reviewed Cloudflare response-header policy or move
it to a host that can. Test every public page, including the five legacy
variations.

Required HTTP response controls:

- CSP matching each page's committed meta policy, plus
  <code>frame-ancestors 'none'</code>.
- HSTS after every included subdomain is HTTPS; do not request preload until the
  operational consequences are approved.
- <code>X-Frame-Options: DENY</code>.
- <code>X-Content-Type-Options: nosniff</code>.
- <code>Referrer-Policy: no-referrer</code>.
- A restrictive Permissions Policy disabling unused camera, microphone,
  geolocation, USB, and similar browser capabilities.
- No-store for portal/checkout-result/API responses; reviewed caching for static
  legal pages and un-fingerprinted assets.

The API Worker must continue returning its own:
<code>default-src 'none'; frame-ancestors 'none'</code>, no-store,
no-referrer, nosniff, DENY, and request ID headers. Verify that Cloudflare does
not merge or overwrite CORS, multiple Set-Cookie headers, Retry-After, or the
request ID.

## 8. Supabase Auth magic-link production setup

Set the hosted Auth Site URL and redirect allowlist to the exact canonical
Stuff by Rambo portal URLs. Do not use wildcards in production. The backend
passes the canonical license portal as <code>emailRedirectTo</code>.

### 8.1 Hosted Auth restrictions

The supported customer authentication path is the storefront's emailed magic
link only. Supabase's email provider can also support passwords, so hiding a
password form is not a security boundary. Configure each hosted test/live Auth
project as follows and preserve a sanitized settings readback with the launch
evidence:

- Email provider and the email signups needed by
  <code>signInWithOtp(... shouldCreateUser: true)</code> are enabled.
- **Confirm Email** is enabled. An unconfirmed email cannot establish a
  supported portal session.
- **Secure Email Change** / double-confirm email changes is enabled, requiring
  confirmation at both the old and new addresses. This is defense in depth:
  v1 commerce account emails are database-immutable, so an account transfer or
  correction requires a separately reviewed support migration and identity
  proof rather than the public Auth update API.
- Phone/SMS sign-up and sign-in are disabled.
- Anonymous sign-ins are disabled.
- Every social/OAuth provider and SAML/enterprise SSO path is disabled.
- Manual identity linking is disabled.
- The product exposes no password signup, password login, password recovery,
  email OTP-code, invite, OAuth, SSO, phone, anonymous, or identity-linking UI
  or API route. Enabling any additional method requires a separate threat
  design, implementation review, and regression suite before production use.

Do not assume that an unused password flow is impossible. A password may have
been set through an unexpected client, a pre-registration attempt, or a future
configuration error. A password-authenticated Supabase access/refresh session
must fail closed at the commerce portal unless it separately completed the
approved emailed-link exchange described below.

Supabase's hosted configuration and method behavior are documented here:

- [General Auth configuration](https://supabase.com/docs/guides/auth/general-configuration)
- [Passwordless email login](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Password-based Auth](https://supabase.com/docs/guides/auth/passwords)
- [Anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
- [Auth CLI configuration reference](https://supabase.com/docs/guides/local-development/cli/config)

The CLI reference names the corresponding local controls
<code>auth.email.enable_confirmations</code>,
<code>auth.email.double_confirm_changes</code>,
<code>auth.enable_anonymous_sign_ins</code>,
<code>auth.sms.enable_signup</code>, and
<code>auth.external.&lt;provider&gt;.enabled</code>. Hosted production settings
must be verified in the Supabase dashboard or Management API; a local
<code>config.toml</code> is not proof of hosted configuration.

### 8.2 Email-link exchange and portal marker

Set the Magic Link template's anchor target exactly as follows:

~~~text
https://stuffbyrambo.com/license/#token_hash={{ .TokenHash }}
~~~

The token hash belongs in the URL fragment, never the query string. Fragments
are not sent in the HTTP request; the storefront immediately removes it from
browser history and requires a user click before POST verification. The
front-end intentionally rejects a query-string <code>token_hash</code>.

The portal-session endpoint accepts only the expected email-link token type and
calls Supabase <code>verifyOtp</code> server-side. Only after that verification
succeeds may the backend issue the access cookie, refresh cookie, and a signed
host-only portal marker. The marker must be generated by the backend, bound to
the verified Supabase user and the validated session, and protected as a
<code>__Host-</code>, Secure, HttpOnly, SameSite=Strict, Path=/ cookie with no
Domain attribute. It is never accepted from a request body or minted from an
arbitrary existing Supabase session.

Every authenticated portal route requires both:

1. a Supabase user/session that the backend validates with Supabase; and
2. a valid signed portal marker bound to that same user/session.

A valid access token or refresh token without the marker is insufficient. A
missing, malformed, expired, forged, cross-user, or cross-session marker fails
with authentication required before account lookup or mutation. Refresh may
only reissue a marker after validating the existing bound marker and refreshed
session; refresh must never upgrade an unmarked password-only session. Logout
clears access, refresh, and marker cookies even if upstream revocation fails.
The marker is an authentication-path gate, not evidence of purchase or an
entitlement, and it must never appear in logs, analytics, URLs, or support
artifacts.

### 8.3 Production Auth checklist

- Custom transactional SMTP configured; default test mail is not a production
  delivery service.
- SPF, DKIM, and DMARC pass for the sender.
- Provider click/open tracking is disabled because rewritten auth links can
  break verification.
- Template contains no marketing pixel or third-party asset.
- Redirect allowlist contains only the required canonical HTTPS portal.
- Link lifetime, one-time behavior, scanner/prefetch behavior, generic
  anti-enumeration response, resend throttles, bounce, and spam placement are
  tested.
- Test and live SMTP credentials, users, and suppression lists are isolated.
- Hosted settings readback proves confirmations and secure email change are on,
  and phone, anonymous, OAuth/SSO, and manual identity linking are off.
- No supported endpoint other than the reviewed email-link verification
  exchange can mint the portal marker.
- Password-only, recovery, invite, OTP-code, phone, anonymous, OAuth/SSO, and
  linked-identity sessions cannot enter the portal.

Run and retain sanitized results for these portal-gate regressions:

1. A valid one-time storefront magic link creates a marker bound to the
   verified user/session and allows the expected portal read.
2. Valid Supabase password access/refresh tokens with no marker receive 401;
   refresh does not create a marker and no account, entitlement, device, or
   refund data is disclosed or changed.
3. A missing, truncated, tampered, expired, or forged marker receives 401.
4. User A's marker with user B's access/refresh session, and a marker replayed
   against another session for the same user, receive 401.
5. Normal access-token expiry and refresh rotate/reissue all bound state
   correctly; the refreshed session works, while stale marker/session
   combinations fail.
6. Logout clears access, refresh, and marker cookies. Repeat with Supabase
   sign-out forced to fail and confirm local cookies still clear.
7. Pre-register an address with a password before the expected customer flow.
   Password login for that address cannot enter or claim the portal; a later
   legitimate storefront magic-link verification can establish a marked
   session without exposing another account's commerce data.
8. Confirm password reset/change and attempted email change do not mint a
   marker. The database rejects a commerce-linked email change, hosted Auth
   still requires old- and new-address confirmation as defense in depth, and
   stale session/marker pairs fail closed.

Supabase documents <code>TokenHash</code>, custom templates, redirect allowlists,
prefetching, and the email-tracking warning:

- [Email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

## 9. Safe offer and policy publication

The seed deliberately creates test and live <code>gesture-flow-v3</code> rows
with checkout disabled, no publish time, zero amount, and no Stripe IDs.
Preserve this fail-closed default.

### 9.1 First publication

1. Complete every section 1 gate.
2. Verify immutable policy artifacts and production hashes.
3. Create and validate the target Stripe product/price and tax code.
4. While checkout remains disabled, update only the target environment's offer
   with its reviewed product ID, price ID, base currency, amount, tax code,
   policy set, features, compatibility, and product description.
5. Read the row back and compare it to Stripe and the storefront with a second
   reviewer. Verify the other environment did not change.
6. Confirm catalog is unavailable while disabled.
7. In one reviewed transaction, set publish time and enable checkout for only
   the target row. Save the returned row as evidence.
8. Confirm catalog reports server price/policy and Checkout uses the persisted
   snapshot. Monitor immediately.

### 9.2 Price, terms, compatibility, or entitlement changes

Never mutate accepted evidence or silently redefine a perpetual v3 purchase.

1. Disable checkout first.
2. Allow existing 31-minute Checkout Sessions to expire or explicitly expire
   them through a reviewed Stripe operation.
3. For policy changes, create new immutable document versions and a new policy
   set. Preserve old bytes indefinitely per the approved retention schedule.
4. For price changes, create a new Stripe Price; do not rewrite a Stripe Price.
5. Deploy and verify static pages/storefront version before moving the offer.
6. Update the disabled offer, compare all systems, then re-enable atomically.
7. Future v4, premium features, or a subscription must be a separate explicit
   offer/entitlement. Existing perpetual v3 rights do not silently become a
   subscription.

## 10. Refund request operations

The portal records a request; it does **not** issue a Stripe refund. The database
has staff-role/audit foundations but no reviewed staff operations UI. Until a
staff tool exists, only the named finance operator may use a controlled,
parameterized Supabase transaction plus Stripe Dashboard. This manual path and
its audit write must be rehearsed in test before launch.

### 10.1 Intake and triage

1. Acknowledge the request within the counsel-approved SLA.
2. Locate it by request/order ID. Confirm account ownership, order state,
   environment, paid time, refund eligibility date, base amount/currency,
   presentment amount/currency, and any dispute. If the account has multiple
   paid v3 orders, match the exact Stripe Checkout Session and PaymentIntent;
   never assume the newest order is the requested duplicate.
3. Do not copy free-form customer notes into broad logs or tickets.
4. Move <code>requested</code> to <code>reviewing</code> and append an immutable
   audit entry in one transaction.
5. Approve the voluntary full refund when within the 14-day window unless fraud,
   an active dispute, or provider constraints require escalation.
6. Requests outside the standard window must not be automatically rejected when
   mandatory rights may apply; escalate to counsel/support.
7. If declining, record the policy/legal basis, audit it, and send the reviewed
   customer response. Never imply that statutory rights were waived.

### 10.2 Issue a full refund

1. Set the request to <code>approved</code> with an audit entry.
2. In the correct Stripe mode/account, open the exact PaymentIntent/order and
   choose a **full original refund**. Do not manually convert the amount or
   issue a partial refund under the voluntary policy.
3. Use the provider's customer-requested reason where accurate. Never place
   secrets or sensitive notes in Stripe metadata.
4. Record only provider object IDs, operator, time, and reason category in the
   private operations record.
5. Do not manually mark the entitlement refunded. Wait for the signed Stripe
   event, fresh provider retrieval, refund upsert, and order reducer.

### 10.3 Reconcile

Verify all of the following:

- Stripe refund is successful for the full original amount.
- The Stripe envelope is <code>processed</code>, not failed/dead-letter.
- <code>commerce_refunds</code> matches provider ID, amount, currency, and state.
- Order is <code>refunded</code>.
- Purchase entitlement is <code>refunded</code>.
- Refund request is <code>completed</code>.
- An online app refresh receives a signed revocation for the exact cached permit
  ID on the refunded entitlement, and a new activation cannot fall back to a
  trial.
- Other independently paid v3 entitlements, their two-Mac allowances, and their
  devices remain active.
- Customer receives a refund confirmation and realistic settlement timing.

Offline permits can remain usable until their signed expiry, at most 30 days.
Counsel must approve the customer disclosure and risk. A failed/canceled refund
must reconcile back to the provider state and restore access only through the
event reducer, not an ad hoc entitlement edit.

### 10.4 Duplicate purchases and entitlement scope

Two distinct successful checkouts are two orders and two independently usable
v3 entitlements. Idempotency prevents duplicate fulfillment of the same
checkout/event; it does not erase a second intentional or accidental payment.

- The portal must display aggregate capacity accurately: two Macs per active
  paid entitlement.
- An accidental duplicate remains eligible under the applicable refund policy.
- The operator refunds the exact duplicate order and reconciles its exact Stripe
  objects.
- Refunding one order revokes only the entitlement and devices bound to that
  order. Never promise or implement account-wide v3 revocation for a single
  order refund.
- Test one entitlement/two devices, two entitlements/four devices, capacity
  selection, and a refund of either order while the other remains active.

## 11. Dispute operations

### Managed Payments

Stripe handles evidence and can contact Stuff by Rambo for product input.
Maintain an accurate support address and respond within Stripe's stated
deadline. Monitor the Dashboard even though Stripe is merchant of record.

### Stripe Standard

Stuff by Rambo owns dispute response and evidence. Assign an operator, preserve
policy acceptance, product delivery, activation, support, and refund evidence,
and calendar Stripe's evidence deadline with 72-hour and 24-hour reminders.
Counsel approves evidence strategy and customer communication.

### State reconciliation

- Open dispute: order and entitlement become
  <code>suspended_dispute</code>.
- Won or warning-closed dispute with no overriding refund/admin revocation:
  reducer restores paid/active.
- Lost dispute: order becomes <code>chargeback</code> and entitlement becomes
  <code>revoked_chargeback</code>.
- Created/updated/closed dispute events must converge when delivered out of
  order. Stripe balance-level funds-withdrawn/reinstated notifications remain
  an accounting/Dashboard monitoring concern unless they are later added to
  both the exact code and endpoint allowlists.
- Never reactivate manually before fresh Stripe state and reducer output agree.

## 12. Webhook queue, dead letters, and replay

### 12.1 Monitoring

The queue stores a minimal signed-event envelope, not the full event. Processing
retrieves the current Checkout Session, Refund, Charge, or Dispute from Stripe.
Monitor:

- count by status;
- oldest unprocessed <code>received_at</code>;
- events whose five-minute processing lease is stale;
- attempt count and last stable error code;
- dead-letter count;
- paid Checkout Sessions without an order after five minutes;
- scheduled-worker last success and duration.

Alert immediately on any dead letter, any stale processing lease, queue age over
five minutes, or a paid session without fulfillment. Alert when queue depth
exceeds one worker batch or grows across two scheduled runs.

### 12.2 Replay procedure

1. Disable checkout if fulfillment correctness is uncertain; keep refund and
   dispute ingestion online when safe.
2. Identify root cause from stable error code, request ID, event ID, and provider
   object state. Never log a signature, secret, cookie, auth token, or full
   customer payload.
3. Reproduce and fix in the isolated test stack. Deploy the reviewed fix first.
4. Retrieve the authoritative object in Stripe Dashboard and predict the reducer
   result before replay.
5. Through a reviewed service-role RPC or parameterized finance transaction,
   move only the selected event back to a retryable state, clear stale lease
   ownership, and append an audit entry. Preserve its ID, minimal payload, and
   original receipt time. Do not delete/reinsert it.
6. Invoke one worker run, then verify provider object, event state, order,
   entitlement, refund/dispute state, and audit record.
7. Re-enable checkout only after reconciliation.

Stripe resending the same event is not by itself a replay mechanism because the
primary key deduplicates it. A reviewed replay RPC/staff procedure is a
pre-launch operations requirement.

## 13. Signing-key and credential rotation

### 13.1 Permit-signing key rotation

The app verifies only public keys embedded in its signed Info.plist; the public
license-keys endpoint is not a substitute for an app update.

Planned rotation:

1. Generate a new Ed25519 pair in an approved offline/managed process. Test and
   live keys are always distinct.
2. Add the new public key beside the old key in the GitHub repository variable
   and backend public JWKS, but keep signing with the old private key.
3. Build, notarize, and release an overlap app containing old + new public keys.
4. Wait for the approved adoption threshold. Keep the old signer active so
   pre-overlap clients can refresh.
5. Switch the backend key ID/private key to the new signer and prove new permits
   in test, controlled live, fresh install, update install, and offline refresh.
6. Keep the old public key through at least the 30-day maximum permit lifetime
   and the support window. Then ship a later app without it if approved.
7. Destroy/disable the old private key according to the key-custody policy and
   retain nonsecret fingerprints and audit evidence.

Never switch to a key that no distributed app trusts.

Emergency private-key compromise:

- Disable new sales and online issuance if attacker signing is plausible.
- Switch only to a public key already present in a trusted released build, or
  ship an emergency signed app first.
- Existing forged offline permits can remain valid until expiry (up to 30 days)
  unless the compromised public key is removed by an app update. Record this
  residual risk and notify counsel.
- Do not “roll back” to a compromised signer.

### 13.2 Other credentials

- Stripe secret: rotate in the correct mode, update only that Supabase project,
  run provider-read smoke tests, revoke old.
- Stripe webhook secret: coordinate endpoint and backend; preserve delivery and
  use Stripe's replay window after verification.
- Shared proxy secret: the current single-secret protocol cannot rotate with
  zero mismatch time. Disable checkout and perform a coordinated maintenance
  rotation, or first add reviewed primary/fallback support on both sides.
- IP HMAC secret: rotation resets rate-limit identity continuity; schedule and
  monitor abuse.
- Activation HMAC secret: pending activation codes become invalid. Drain the
  short challenge window or communicate maintenance.
- Context HMAC secret: portal CSRF/rate-key continuity changes; expect users to
  refresh/sign in again and test cookie clearing.
- Cron secret: update Supabase and the scheduler together; alert during the gap.
- Supabase service/legacy keys: rotate per provider procedure and reverify RLS,
  Auth refresh, functions, and scheduler.
- Apple/GitHub/Cloudflare deployment credentials: rotate independently with
  least privilege and verify no old credential remains in runner caches.

Never print a value to “verify” rotation.

## 14. Signed macOS release gate

Production lane: Python/MediaPipe, bundle ID
<code>stuffbyrambo.GestureControlPython</code>, macOS 15+, arm64,
<code>GestureFlow.dmg</code>, and <code>python-v&lt;version&gt;</code>.

The checked-in workflow requires a Developer ID Application certificate,
matching Developer ID provisioning profile, profile-authorized Data Protection
Keychain access group, live public permit keys, hardened runtime, trusted
timestamp, notarization, and staple. It pins the macOS 15 runner, credentialed
actions by commit, Sparkle 2.8.1 archive hash, and runs release tests before
signing.

Before triggering a release:

1. All local Python tests, Ruff, compileall, pip check, shell syntax, workflow
   YAML, unsigned packaging smoke, and dependency-integrity checks pass.
2. Public-key fingerprints match the live backend rotation plan and contain no
   documented/test key.
3. Provisioning profile is unexpired, matches bundle/team, and authorizes the
   exact Keychain access group.
4. Certificate, profile, notarization, release-repo, and Sparkle credentials are
   present by name in GitHub; values are never exposed.
5. The live API, catalog, policies, and signed permit claims match the app's
   fixed issuer/audience/product/edition/major/device limit.

After the workflow, download the exact release artifact and independently
verify:

- DMG checksum matches the release record.
- Notarization submission accepted and staple validates.
- Gatekeeper accepts both DMG and mounted app.
- Deep/strict code signature and hardened runtime pass.
- Embedded provisioning profile matches bundle/team and is unexpired.
- Signed entitlements contain only the expected camera and Keychain access.
- Every Mach-O has an arm64 slice.
- Info.plist has macOS 15 minimum, exact bundle/version, production appcast, and
  intended public-key IDs.
- Clean install can activate; update install retains Keychain identity and can
  verify both pre- and post-rotation permits.
- Camera and Accessibility permission copy matches the compatibility page.

Do not publish the DMG or update appcast until these checks pass. For the public validation summary, see `VALIDATION_SUMMARY.md`; owner-specific operational evidence is retained privately. A signed and notarized local candidate is separate from a published release.

## 15. End-to-end test matrix

Run payment scenarios in Stripe sandbox with test payment methods. Verify live configuration without a charge, then reconcile the first genuine customer sale after launch. Do not use real payment details solely to test live mode; see [Stripe testing rules](https://docs.stripe.com/testing).

| Area | Required cases |
| --- | --- |
| Network/DNS | TLS, canonical/www site, stable license domain, no Worker dev URL, no direct Supabase bypass, request IDs, body cap, no redirects |
| Headers/CORS | Exact allowed origins, hostile/null origin, preflight, credentials, multiple cookies, CSP/frame/HSTS/referrer/permissions/nosniff |
| Catalog | Disabled offer unavailable; enabled offer server price, policy set, compatibility, features, one-Mac paid limit, and two-Mac trial limit |
| Checkout validation | Missing/stale acceptances, invalid SKU, stale policy, idempotent retry, idempotency conflict, wrong country in Standard mode |
| Checkout provider | Hosted Stripe hostname only; one line item; exact snapshot product/price/base amount; success URL not authoritative |
| Adaptive Pricing | Base currency; real converted presentment; absent presentment; base/presentment persistence |
| Webhook | Exact allowlist, bad signature, wrong mode, API-version drift detection, duplicate, unsupported ignored, malformed, expired, async success/failure, crash/reclaim, out of order |
| Fulfillment | Paid order/entitlement exactly once; purchase email claim; no fulfillment on unpaid or line-item mismatch |
| Portal/Auth | Generic magic-link response, fragment-only token, query token rejection, history scrub, one-time/expired link, prefetch, SMTP tracking off, hosted confirmations/secure-email-change on, phone/anonymous/OAuth/SSO/manual-linking off |
| Portal session | Signed host-only marker bound to verified email-link user/session, password-only and password-pre-registration failure, missing/forged/cross-user/cross-session marker rejection, refresh/rotation, CSRF failure/success, hostile origin, logout and stale-session/marker cookie clearing |
| Trial | One no-card 14-day trial per account/product; local reset cannot restart; purchase history/inactive purchase blocks fallback |
| Paid capacity | One paid entitlement allows one Mac; two independently paid entitlements allow two; trial permits two; portal aggregate and capacity-aware selection |
| Device activation | Canonical code, poll expiry, consumed token expiry, per-entitlement cap, concurrency, deactivation frees the correct slot |
| Device proof | Ed25519 signature, body hash, timestamp, nonce replay, wrong key/install/activation, duplicate JSON fields, response caps |
| Permit | Exact issuer/audience/product/edition/major/features/device/account/install claims, canonical JTI, at most 30 days, trial bound |
| Offline/clock | Valid offline permit, expiry fail closed, rollback detection, signed time recovery, network errors do not revoke |
| Revocation | Exact presented JTI for device deactivation, trial expiry, refund pending/success, dispute open/lost, admin revoke |
| Refund | Eligible request, closed voluntary window plus legal escalation, full pending/success/failed, duplicate/out-of-order, exact-order revocation, other paid entitlement preserved, no trial fallback |
| Partial refund defense | Partial provider refund does not masquerade as full policy completion or incorrectly revoke full entitlement |
| Dispute | Open suspension, won restoration, lost revocation, created/updated/closed event order, Stripe balance monitoring, evidence deadline alert |
| Database | Migration from empty DB, rerun behavior, zero anon/authenticated commerce privileges, portal-only account isolation, immutable policies/orders/audit, concurrency and leases |
| Retention | Nonces/rates/idempotency removed, evidence challenge scrubbed, 35-day event deletion, legal records retained |
| Release | Ad-hoc test build never distributed; signed app/profile/Keychain/notary/staple/Gatekeeper/arm64/macOS 15/update path |
| Failure/rollback | Stripe down, Supabase down, Worker down, scheduler down, stale deploy, checkout kill switch, valid offline access |
| Live readiness | Account activation, price/product/currency, webhook mode, disabled offer, environment isolation, signing keys; after launch reconcile the first genuine sale. Payment/refund/revocation testing stays in sandbox. |

Store test evidence without card data, secrets, cookies, raw auth links, full
webhook bodies, or unnecessary personal data.

## 16. Deployment order and launch

Every mutating provider step needs explicit approval. Use a two-person check for
environment, account, project, domain, offer, signing key, and app lane.

1. Freeze the reviewed code revision and record checksums.
2. Complete counsel/CPA/merchant/tax-code gates.
3. Provision isolated test resources and run sections 3 and 15.
4. Rehearse refund, dead-letter replay, retention, credential rotation, and
   rollback in test.
5. Provision live Supabase with disabled seed offers; deploy functions and
   scheduler; verify direct calls fail closed.
6. Create the live Stripe endpoint only after the code event allowlist is final;
   leave the offer disabled.
7. Cut the Cloudflare stable hostname from test to live; verify secrets and
   upstream by metadata, then run fail-closed API smoke.
8. Deploy and verify static site response headers and immutable policy bytes.
9. Build, notarize, staple, and independently verify the production app and
   download artifact. Keep it unpublished.
10. Populate the disabled live offer and run a second-review comparison.
11. Verify live configuration and disabled-offer behavior without a charge.
    Do not temporarily enable checkout to run an artificial real-card purchase.
12. Reconcile sandbox Stripe, order, entitlement, portal, app permit, refund, and
    revocation evidence. Preserve evidence and schedule reconciliation of the first
    genuine customer sale after launch.
13. Obtain final named sign-off.
14. Publish the verified DMG/site and atomically enable the live offer.
15. Start the launch monitoring cadence.

## 17. Rollback and fail-closed controls

Use the narrowest containment:

- Payment or legal incident: disable only checkout in the live offer, then
  deactivate the Stripe Price/expire open sessions if necessary. Keep portal,
  refund/dispute webhook, and safe device refresh online.
- Static policy/header mismatch: disable checkout before rolling the site. Do
  not serve policy bytes that differ from the active policy hash.
- Edge Function regression: redeploy the known-good revision. Database changes
  are forward-only compensating migrations; never reset production or mutate
  immutable evidence.
- Worker regression: roll back to the recorded Cloudflare version while
  preserving correct live bindings. If proxy trust is uncertain, take the API
  offline rather than bypass it.
- Stripe webhook outage: preserve events/provider IDs, restore ingestion, then
  replay through the reviewed queue procedure.
- Signing incident: do not revoke or replace a key without the overlap/emergency
  plan in section 13.

Rollback success requires reconciliation, not merely HTTP 200. Confirm paid
Stripe sessions have one order, refunds/disputes match entitlements, scheduler
is current, and valid offline permits were not unintentionally revoked.

## 18. Incident response

1. Declare severity and incident owner; record UTC start, affected environment,
   revision/deployment IDs, and request/event/order IDs.
2. Contain new sales first when payment, legal, tax, fulfillment, or signing
   correctness is uncertain.
3. Preserve minimal logs and provider evidence. Never paste secrets, signatures,
   cookies, auth links, private keys, card data, or raw customer payloads.
4. Determine whether customers are charged, unfulfilled, incorrectly licensed,
   unable to refresh, refunded, disputed, or exposed.
5. Rotate only affected credentials using section 13; assume a credential shown
   in chat/log/history is compromised.
6. Reconcile Stripe to Postgres before customer communications.
7. Notify counsel immediately for suspected personal-data exposure, policy
   mismatch, tax error, signing-key compromise, or statutory-notice question.
8. Communicate plainly: impact, workaround, refund/access state, and next update.
9. After recovery, complete root cause, timeline, control changes, customer
   remediation, and evidence-retention review.

Severity examples:

- SEV-1: unauthorized charges/refunds, exposed private permit/Stripe/service key,
  cross-account data, widespread paid-without-license, or invalid signed release.
- SEV-2: webhook backlog/dead letter, checkout outage, magic email outage,
  refresh outage with valid offline permits, or incorrect regional gate.
- SEV-3: isolated portal/device/support issue without incorrect payment or data
  exposure.

## 19. Launch and post-launch monitoring

### Launch sign-off record

Capture:

- code revision and clean-worktree verification;
- migration IDs/checksums and Supabase deployment IDs;
- Cloudflare Worker version, custom-domain/TLS/WAF/header evidence;
- Stripe mode, pinned API version, product/price/tax-code approval, endpoint
  event list, and controlled transaction IDs;
- policy set/document versions, hashes, immutable artifact locations, and
  counsel approval;
- app version/tag, DMG checksum, certificate/team/profile identifiers,
  notarization/staple/Gatekeeper evidence, and public key IDs;
- named approvals and UTC timestamps;
- rollback owner and current contact path.

### Cadence

- First two hours: review every 15 minutes.
- Rest of launch day: hourly.
- Days 2–7: daily reconciliation and support review.
- Thereafter: weekly operational review; monthly access/key/retention/restore
  review; immediate review after any provider, API version, tax, price, policy,
  or release change.

### Metrics and alerts

- Worker requests, exceptions, upstream latency/status, WAF blocks/rate limits,
  and custom-domain TLS.
- Supabase function errors/latency, Auth delivery/verification, database
  connections/storage/backups, RLS/security alerts.
- Checkout starts, paid sessions, fulfillment latency, amount/price mismatches,
  and paid-without-order count.
- Webhook queue depth/age, stale leases, attempts, dead letters, scheduler last
  success, and retention result.
- Magic email delivery/bounce/spam, portal session failures, CSRF/rate limits.
- Activation challenge/approval/exchange success, device-cap denials, refresh,
  signed-time recovery, revocations, and permit expiry.
- Refund request age, approval/Stripe/refund completion lag, failed refunds.
- Open disputes and evidence deadlines.
- Stripe daily totals versus Postgres paid/refunded/disputed totals.
- Release download/update errors and support reports by app version.

Immediate paging thresholds:

- any dead-letter event;
- any paid Stripe Session without one order after five minutes;
- any stale processing lease;
- scheduler has no success for five minutes;
- cross-account/RLS alert, amount/price mismatch, invalid signed release, or
  suspected secret/key exposure;
- sustained API 5xx or checkout failure above the launch baseline.

## 20. Current known pre-launch gaps

As of this review:

1. Production counsel and CPA reviews are not complete.
2. The product tax code and personal/internal-business positioning are not
   approved.
3. The live Stripe API version, merchant mode, product, price, and endpoint are
   not configured or proven.
4. The exact webhook allowlist exists in code and this runbook, but no test/live
   Stripe endpoint subscription has been configured or verified by this work.
5. No hosted test/live Supabase projects, production secrets, functions,
   scheduler, or alerting were configured by this work. Hosted email
   confirmations, secure email change, disabled alternate providers/manual
   linking, and the portal-marker/password regressions remain unverified.
6. No Cloudflare Worker/custom domain/WAF/static response-header policy was
   deployed or production-verified by this work.
7. The stable-hostname prelaunch test path has not run; a separate compile-time
   staging bundle/origin lane does not yet exist.
8. No reviewed staff refund/replay tool exists; the controlled manual procedure
   still needs a test rehearsal and audit template.
9. Unversioned canonical policy URLs require immutable archived bytes or
   versioned URLs before live.
10. Production permit keys, Developer ID provisioning profile, signed/notarized
    app, and end-to-end release proof remain pending.

Do not mark <code>OPS-001</code>, <code>SEC-002</code>, <code>QA-002</code>, or
<code>OPS-002</code> cloud-done until the corresponding evidence above exists.
