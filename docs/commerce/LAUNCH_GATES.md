# Gesture Flow Commerce Launch Gates

Status: **BLOCKED FOR LIVE SALES**

Snapshot date: 2026-07-13

Business-context reconciliation, 2026-10-08: company records already exist at
`/Users/ramigreenspan/Documents/Stuff By Rambo LLC/README.md`. Read that index and
`Payments and Licensing.md` before requesting entity/account facts or creating
duplicate infrastructure. Later messages in the July 13 “Build Stripe license
service” chat report migrations 001/002 and both test Edge Functions deployed;
the earlier table below is a historical snapshot, not current provider evidence.
Recheck provider state before resuming. Rami's October 8 price instruction is
**$14 once**, superseding the older $14.99 discussion. No live gate was cleared
by this documentation review.

This is an execution checklist, not legal or tax advice. Purchases must remain
disabled until every gate has named approval and retained evidence. Test-mode
success, deployed infrastructure, or a provider recommendation is not live
launch approval.

## Historical test versus live state (July 13; superseded by current validation)

| Area | Isolated test | Live / customer-facing |
| --- | --- | --- |
| Source and site | Commerce source is in an uncommitted working tree. | GitHub Pages still serves the earlier `d1da0f6c4d06` revision; new commerce/legal routes return 404. |
| Stripe | Existing test products, prices, and endpoints are not verified because the local CLI is unauthenticated. Required Stripe runtime configuration is incomplete. | No live Stripe product, price, endpoint, merchant model, tax code, or payment proof is verified. |
| Supabase | The hosted test project is healthy and has the commerce migration and seed-shaped data. No Edge Functions or scheduler are deployed; hosted Auth, SMTP, and exact offer values remain unverified. Backups/PITR are not active. | No dedicated live project, database, Auth configuration, functions, scheduler, keys, backups, or restore proof is verified. |
| Cloudflare | The zone is on Cloudflare, but the license hostname has no DNS record. Remote Worker deployment and bindings are unverified. | There is no working live license API or reviewed static response-header layer. |
| App and E2E | Local tests exist, but stable-host payment, portal, licensing, refund, and recovery E2E is incomplete. | No production Developer ID-signed, notarized, stapled, independently verified build or controlled live-payment proof exists. |

The current system is fail-closed: there is no working public purchase path.
Do not convert this safe state into a partial launch.

Current October 26 evidence is maintained in [validation summary](VALIDATION_SUMMARY.md).
The table above is retained as a historical baseline, not a current provider inventory.
Both isolated databases and functions now exist. Supabase and Resend free plans,
manual encrypted backup restores, current-source sandbox activation, and deployed
route-scoped headers have been verified. Restricted-key Managed Payments and final
production integration/acceptance remain incomplete; live sales are disabled.

## Non-negotiable gates

### 1. Stripe merchant model, product audience, and tax

- [ ] Record a written decision between **Stripe Managed Payments** and
  **Stripe Standard**, including account availability, current provider terms,
  fees, support/refund ownership, countries, and operational consequences.
- [ ] Have Stripe and the CPA approve the exact downloadable-software tax code
  and whether the offer is personal use, internal business use, or must be
  split into separate offers. Storefront, Stripe Product, price, EULA, and tax
  classification must agree.
- [ ] If Standard is selected, keep the initial offer US-only and obtain the
  CPA's written nexus, registration, collection, filing, Stripe Tax, refund,
  and dispute plan before accepting money.

**Recommendation, not assumption:** prefer Managed Payments if Stripe has
enabled the account and confirms that the product, intended audience, customer
countries, tax code, and integration are eligible, and its public-preview
terms/economics are accepted. Until those facts are recorded, the merchant
model is **UNDECIDED**. Do not set runtime acknowledgement flags merely to pass
configuration.

Official Stripe sources:

- [Managed Payments overview](https://docs.stripe.com/payments/managed-payments)
- [How Managed Payments works and eligibility](https://docs.stripe.com/payments/managed-payments/how-it-works)
- [Managed Payments setup prerequisites](https://docs.stripe.com/payments/managed-payments/set-up)

### 2. New Jersey registration, tax authority, and business name

- [ ] A New Jersey attorney/CPA confirms the seller's legal form and completes
  the applicable formation and NJ-REG/tax registration steps. Retain the
  accepted filings and Business Registration Certificate where applicable.
- [ ] The CPA obtains or documents why the business does not require New
  Jersey sales-tax collection authority for this model. Managed Payments does
  not, by itself, resolve unrelated entity, income-tax, registration, or filing
  obligations.
- [ ] Register **Stuff by Rambo** using the path applicable to the legal form:
  an entity alternate name through the State, or a sole
  proprietor/partnership trade name through the appropriate county. Counsel
  must decide which path applies; do not guess.
- [ ] The legal seller name and any registered alternate/trade name match the
  website, policies, Stripe account/receipts, support communications, and bank
  records.

Official New Jersey sources:

- [Getting registered](https://www.nj.gov/treasury/revenue/gettingregistered.shtml)
- [Alternate names and trade-name distinction](https://www.nj.gov/treasury/revenue/altname.shtml)
- [New Jersey Sales and Use Tax](https://www.nj.gov/treasury/taxation/businesses/salestax/index.shtml)
- [Sales-tax registration and filing](https://www.nj.gov/treasury/taxation/su_12.shtml)

### 3. Counsel-approved customer terms and operations

- [ ] Independent software/privacy counsel approves the exact Terms/EULA,
  Refund Policy, Privacy Policy, compatibility/permissions disclosures,
  checkout clickwrap, warranty/liability language, governing law/forum, and
  treatment of non-waivable consumer rights.
- [ ] Counsel approves the 14-day voluntary refund process, statutory-rights
  escalation, dispute response, account/email correction process, privacy
  requests, retention, and customer-support language.
- [ ] A named operator, response SLA, audit trail, and tested refund/dispute
  procedure exist. A blanket “no refunds” statement is not acceptable without
  counsel approval.

### 4. Immutable policy and acceptance evidence

- [ ] Publish immutable, versioned policy URLs or preserve the exact accepted
  HTML bytes in durable write-protected storage.
- [ ] Record production response bytes, SHA-256 hashes, headers, retrieval
  times, URLs, policy-set version, and code revision; match them to the database
  before checkout is enabled.
- [ ] Never edit accepted policy rows or silently replace accepted bytes. A
  change requires new document versions and a new policy set while checkout is
  disabled.
- [ ] Counsel and the CPA approve retention periods for policy acceptance,
  orders, tax, refunds, disputes, audit records, and backups.

### 5. Production authentication email

- [ ] Configure isolated production custom SMTP; Supabase's default mailer is
  not a production delivery service.
- [ ] Verify SPF, DKIM, DMARC, bounce handling, resend/rate limits, and inbox
  placement. Disable click rewriting, open tracking, marketing pixels, and
  third-party assets in magic-link email.
- [ ] Verify the reviewed fragment-token template, exact redirect allowlist,
  email confirmations, secure/double-confirm email changes, and disabled
  phone, anonymous, OAuth/SSO, and manual-linking paths.

Official Supabase source:

- [Send emails with custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

### 6. Free-tier capacity, backup, and recovery

- **Owner decision, 2026-10-26:** release on **Supabase Free**, Resend's free/base
  allowance, and existing free hosting allowances. No new recurring charge,
  paid add-on, automatic paid overage, or carbon contribution is authorized.
  Previously approved Stripe transaction and Managed Payments fees are separate.
  This supersedes the earlier blanket requirement for Supabase Pro.
- [ ] Keep a dedicated live Supabase Free project. Test and live must not share
  users, secrets, signing keys, or data.
- [ ] Verify encrypted off-site logical backups within existing free allowances;
  do not claim managed daily backups or point-in-time recovery on Free. Record
  the last successful backup and recovery-point target; a failed or delayed
  daily backup can lose more than a day's changes.
- [ ] Complete and time a restore drill, document downtime/rollback ownership,
  and account separately for provider secrets/configuration and Storage objects
  not contained in database backups.
- [ ] Verify actual plan, quota usage and zero-paid-overage settings before
  enabling scheduled backups or any optional service. Shared account quotas
  include other products and test traffic.
- [ ] Record and monitor free-tier risks: API/function call quotas, database and
  egress growth, Supabase inactivity pauses, Resend daily/monthly limits, delayed
  activation mail, and exhausted backup storage/build minutes. Stop or defer
  affected operations when limits are reached; never silently upgrade.
- [ ] Re-verify forced RLS, zero direct commerce-table access for
  `anon`/`authenticated`, Auth restrictions, production SMTP, alerts, and
  provider capacity before launch.

Official Supabase sources:

- [Production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)
- [Database backups and PITR](https://supabase.com/docs/guides/platform/backups)
- [Supabase pricing](https://supabase.com/pricing)
- [Free-project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Resend pricing](https://resend.com/pricing)

### 7. Cloudflare least privilege and stable edge

- [ ] Use scoped API tokens, never a Global API Key. Restrict each token to the
  single required account/zone and only the Worker, route, DNS, or read
  permissions its job needs. Separate read-only audit and deployment
  credentials; set ownership, expiry, rotation, and revocation procedures.
- [ ] Keep test/live Worker versions and bindings isolated. Verify binding
  names and fingerprints without printing values; keep signing private keys
  out of Cloudflare.
- [ ] Establish the stable license hostname, `workers_dev = false`, TLS,
  restrictive CORS/security headers, body limits, rate controls, request IDs,
  logging redaction, and alerts. Direct Supabase calls must fail closed.
- [ ] Put the static site behind a reviewed Cloudflare Pages/proxy response-
  header policy before publishing checkout or portal links.

Official Cloudflare sources:

- [Create API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [API token permission scopes](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

### 8. Signed/notarized app and complete E2E

- [ ] Build the release with a valid Developer ID Application certificate,
  Hardened Runtime, secure timestamp, reviewed entitlements, and no shipping
  `get-task-allow` entitlement. Keep production permit keys separate from test.
- [ ] Submit with `notarytool`, review the notarization log, staple the ticket,
  and independently verify signatures, staple, Gatekeeper, arm64, macOS 15,
  permissions, clean install, update path, and final DMG hash.
- [ ] Complete isolated test E2E through the stable hostname: checkout,
  webhook fulfillment, email-link portal marker, trial, two-device limit,
  offline permit, deactivation, full refund, dispute states, revocation,
  rotation, outage, retry, rollback, and recovery.
- [ ] Verify live account activation, product/price, webhook mode, disabled-offer
  behavior, and environment isolation without charging a card. Exercise payments,
  refunds and revocation in Stripe sandbox. After launch, reconcile the first
  genuine customer purchase; do not create a real payment solely as a test.
  See [Stripe testing rules](https://docs.stripe.com/testing).

Official Apple sources:

- [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## Final release rule

Launch requires one evidence packet containing professional approvals, the
merchant/tax decision, registrations, immutable policy hashes, provider IDs and
deployment versions, backup/restore proof, signing/notarization evidence, E2E
results, named monitoring and rollback owners, and final dated sign-off.

If any gate is incomplete, unclear, stale, or cannot be reproduced, keep
checkout disabled and the production app unpublished.
