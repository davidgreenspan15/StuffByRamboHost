# Private purchase activation codes (2026-10-26)

Scope: local implementation for private tests on the isolated Supabase test project. Not a public launch. No live Stripe activation, provider configuration, credentials, real mail, production deployment, migration against a hosted database, commit or push is part of this change. Local-done only, not cloud-done.

## Flow

1. The buyer pays through Stripe (test mode). Fulfillment creates the paid entitlement, and a trigger queues a purchase email row in the same transaction.
2. The scheduled worker claims the row under a lease, generates a random code, stores only its keyed digest, and emails the code through the Resend HTTP API.
3. The buyer types only the code into Gesture Flow. No email field. The app creates its usual device activation challenge and posts the code to `POST /v1/device-activation-challenges/{challengeId}/purchase-code`.
4. That one Mac activates and receives the existing signed device permit. The code is consumed and can never activate anything again.

**One Mac per paid purchase.** Paid Gesture Flow v3 entitlements have `device_limit = 1`; trials keep two Macs. Ordinary launches validate the stored permit locally without sign-in. The browser trial/account flow (Supabase Auth magic link) is unchanged.

This replaces the earlier six-digit Supabase Auth OTP purchase path, which required the purchase email and expired after one hour. That route, its authorization RPC and the worker's OTP sending are removed.

## Code format

`GF-XXXX-XXXX-XXXX-XXXX`: 16 Crockford base32 characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 80 bits from `crypto.getRandomValues`.

Normalization (server authoritative, the app mirrors it):

1. Uppercase; remove whitespace and `-`.
2. If the result is 18 characters and starts with `GF`, strip that `GF`. A bare 16-character code that happens to start with `GF` stays intact.
3. Map `O` to `0`, and `I` and `L` to `1`.
4. Require exactly 16 alphabet characters (input over 64 characters is rejected first).

Storage: only `HMAC-SHA-256(ACTIVATION_CODE_HMAC_SECRET, "gf-purchase-code-v1:" + normalized)`. The pepper is the existing activation-code secret, so no new secret is needed; the prefix separates it from browser device-code digests. Rotating that secret invalidates every unused purchase code (recover with resend).

The raw code exists only in worker memory and the outgoing email. It is never logged, stored, put in error metadata or queue rows, or returned by any API.

## Semantics

- **Single use.** `commerce_redeem_purchase_code` locks the challenge, then the code row, then the entitlement, in one transaction. On success it creates (or reactivates) the device activation, marks the challenge consumed and binds the code to that challenge and activation.
- **Same Mac already active on this purchase.** If this installation is already active on the purchase with the same device key, redemption returns that existing activation (fresh permit, no new slot), marks the new challenge consumed and rebinds the activation to it. An unused code is **not** consumed in that case. This covers:
  - Lost responses, including when the original challenge has since expired: a new, valid, bearer-verified challenge for the same installation and key recovers the activation. An expired new challenge still returns `expired_token`.
  - A Mac moved onto the purchase from the buyer's trial at fulfillment.
  - Same-challenge retries (calling `/exchange` with that challenge's poll bearer is also idempotent).
- **Reuse.** A consumed code presented for a different installation or a different key gets `invalid_purchase_code`.
- **Races.** Two challenges racing one code serialize on the code row lock: exactly one wins, the other gets `invalid_purchase_code`. Verified by the disposable database runner.
- **Device limit.** If the purchase already has an active Mac (for example one approved through the portal or upgraded from a trial), redemption on another Mac returns `device_limit_reached` and the code is **not** consumed. Explicit deactivation (device self-deactivation or portal) frees the slot as before. No transfer or automatic slot reset was added.
- **Mac covered by another purchase.** If this installation is already active on a different active paid (or admin) entitlement, redemption returns `409 already_activated` and the code is not consumed. This is reported only after the code itself validated, so it reveals nothing to someone without a valid code.
- **Trial Mac.** If this installation has an active trial activation, that trial row is deactivated (`upgraded_to_purchase`) in the same transaction that activates the purchase.
- **No key takeover.** Unlike `commerce_exchange_activation`, which rebinds an active installation to a new device public key, the purchase-code path hard-fails with `device_key_conflict` when the installation is already active on that purchase with a different key, and the code stays unused. Trial and refresh paths are unchanged.
- **Refund, dispute, suspension.** The code is accepted only while the entitlement is active, its order is `paid`, and both order and offer are in the `test` environment for `gesture-flow-v3`. Otherwise `invalid_purchase_code`. Existing refresh and signed revocation rules are unchanged.
- **Outcomes that do not consume the code:** unknown/revoked code, wrong bearer, expired challenge, device limit, key conflict, `already_activated`, same Mac already active on this purchase, non-allowlisted recipient.

## Account binding decision

`commerce_device_activations.account_id` was NOT NULL, but a paid purchase can exist with no Auth account (only `claimed_email`). Possessing the emailed code proves control of the purchase inbox, and nothing more. We do **not** create Auth users, mark email verified, mint portal identity, or record policy acceptance (purchase acceptance remains the checkout evidence).

Chosen minimal change (migration `202610260002`):

- `account_id` is now nullable, with a new `purchase_code_activation boolean` and check `account_id is not null or purchase_code_activation`. Only purchase-code activations may lack an account. They take the entitlement's `account_id`, which is null until claimed.
- `commerce_claim_account_entitlements` and the `auth.users` trigger `commerce_handle_auth_user` additionally backfill `account_id` on activations whose entitlement now belongs to the account. When the buyer later signs in to the portal, the existing claim flow attaches the purchase and its Mac, so the portal lists and can deactivate it.
- Permit claims never included the account ID, so permits are unaffected. In code, `ActiveLicenseRecord.accountId` and the verified device's `account_id` are typed `string | null`.

## Device limit sourcing

- `commerce_offers.device_limit` is now 1 for `gesture-flow-v3` (test and live rows, seed updated; offer description now says "on one Mac"). Checkout snapshots and the catalog read it.
- New `commerce_offers.trial_device_limit` (default 2). `commerce_approve_activation` is redefined identically except the trial insert reads `trial_device_limit`.
- `commerce_fulfill_paid_checkout` is redefined (identical to `202607130002` except its trial-upgrade block): when a buyer who had a trial purchases, at most `device_limit` (one) active trial Macs move to the purchase, most recently seen first; any others are deactivated with reason `trial_upgrade_over_limit` and audited. Previously every active trial Mac moved, bypassing the one-Mac limit.
- A `before insert or update` trigger forces `device_limit = 1` on every paid Gesture Flow v3 entitlement (covers checkouts snapshotted before the migration). Existing test purchase entitlements are updated to 1; already active Macs are not deactivated.
- **Permit `deviceLimit` comes from the entitlement row:** the exchange and redeem RPCs return `entitlement.device_limit`, and `/devices/refresh` reads `commerce_entitlements.device_limit`; `issuePermit` copies that value into the claim. Purchase permits carry 1 and trial permits carry 2.

## Delivery, resend and the queue

- The outbox row is created transactionally on a new paid test entitlement, as before.
- At send time `commerce_issue_purchase_activation_code` (fenced by the worker lease) revokes any unused code, inserts the new digest and returns `issued`. If a code was already consumed it returns `already_used`; ineligible purchases return `not_eligible`. Only an `issued` code is ever emailed; anything else completes as `failed` without sending.
- Eligibility is per order: each paid purchase has its own queue row, code and email, even when one email made several purchases.
- Resend: `POST /v1/purchase-activation-codes {email}` always returns 202 `{accepted:true}`. For an allowlisted email it re-queues **every** eligible paid test purchase of that email whose code is unused; the worker rotates each one (old code revoked) and emails each new code separately. Purchases whose code was already used get nothing.
- Resend outcomes: 2xx is `sent` (accepted by Resend, not proven delivered); other 4xx is `failed`; timeout, transport error or 5xx is `uncertain`. Uncertain is never retried automatically; an explicit resend recovers it. Requests carry `Idempotency-Key: gf-purchase-code/{leaseToken}`. Provider bodies are discarded.
- Retention/partial-failure behavior is unchanged: retention always runs, each claimed row is attempted at most once, and completion failures are counted uncertain without blocking later rows.
- Template: `supabase/functions/_shared/purchase-code-email.ts` (HTML and text; it also tells the buyer that moving to a new Mac means signing in at `https://stuffbyrambo.com/license/` and deactivating the old Mac), separate from the Supabase Auth template `supabase/templates/private_activation_code.html`, which now covers only browser account/trial sign-in.

### Queued OTP-era rows

Migration `202610260002` marks every queue row still `pending` or `sending` as `superseded` (lease cleared). Those rows were queued for a Supabase OTP; they are never sent as an OTP or automatically as a code. A buyer recovers with an explicit resend, which re-queues `superseded` (and `sent`, `failed`, `uncertain`) rows under the new scheme. An old worker still holding a `sending` lease cannot complete it. The OTP authorization RPC `commerce_authorize_purchase_challenge` is dropped.

## Private safety gates

- `PRIVATE_PURCHASE_CODES_ENABLED` defaults false; accepted only with `STRIPE_ENVIRONMENT=test` and an explicit `PRIVATE_ACTIVATION_RECIPIENTS` JSON array. Disabled, both endpoints return 404 `not_found`.
- `PRIVATE_ACTIVATION_EMAIL_SENDING_ENABLED` defaults false.
- New: `RESEND_API_KEY` (secret) and `PRIVATE_ACTIVATION_EMAIL_FROM` (sender on the verified Resend domain). With sending disabled, or either value missing, the worker does not even claim rows (fails closed; rows stay pending).
- The recipient allowlist is enforced at claim, at send, and inside the redeem RPC (`p_allowed_emails`).
- New table and RPCs are revoked from `public`, `anon` and `authenticated`, granted to `service_role` only, with RLS forced.

## Production mode (LIC-003, prepared 2026-10-26, not enabled)

Migration `202610260003_live_purchase_codes.sql` and the edge flags below
prepare emailed single-use codes for real (live) purchases. Everything is off
by default, and nothing here enables, deploys or applies anything.

Two independent gates must both be on before a live purchase gets or redeems a code:

1. Edge: `LIVE_PURCHASE_CODES_ENABLED=true` (endpoints) and
   `LIVE_PURCHASE_CODE_EMAIL_SENDING_ENABLED=true` (worker). Startup rejects
   either flag unless `STRIPE_ENVIRONMENT=live`, rejects sending without codes,
   and rejects sending without `PRIVATE_ACTIVATION_EMAIL_FROM` and
   `RESEND_API_KEY` (shared with the test path). The `PRIVATE_*` sandbox flags
   remain rejected in live and never unlock live purchases.
2. Database: `commerce_purchase_code_settings.live_enabled` (singleton, default
   false). `service_role` can read it but not write it, so a compromised or
   misconfigured edge function cannot open it. An operator flips it with
   reviewed SQL after the launch gates clear:
   `update public.commerce_purchase_code_settings set live_enabled = true, updated_at = clock_timestamp();`

Behavior:

- Eligibility: the order and its offer must share one environment. Test
  purchases behave as before. Live purchases are eligible only while the
  database gate is on (paid order, active purchase entitlement, Gesture Flow v3).
- Recipients: the edge passes `p_allowed_emails`. Test passes its allowlist, and
  inside the database a null or empty list matches no test buyer, so the
  sandbox restriction cannot be lifted. Live passes null (every verified live
  buyer) or the optional `LIVE_PURCHASE_CODE_CANARY_RECIPIENTS` JSON array for a
  staged canary. An empty canary is rejected at startup.
- Queueing: fulfillment queues a live purchase only while the database gate is
  on. Live purchases made while it was off are never mailed automatically later;
  those buyers use resend.
- Unchanged: one Mac per paid purchase, single use, digest-only storage,
  issuance only under a worker lease for a verified paid order, no trial
  creation, no device-key rebind, atomic lock order, generic errors, existing
  rate limits and no automatic retry of uncertain sends. The redeem body is
  identical to `202610260002` except the leading `p_environment`, its
  validation, environment-scoped eligibility and the recipient predicate.
- Environment contract: resend, claim, issue and redeem take a required
  `p_environment` (first parameter), and the edge always passes
  `STRIPE_ENVIRONMENT`. A missing or invalid value raises
  `invalid_purchase_code_environment`. Each call acts only on a purchase whose
  order AND offer are in that environment, so in a shared database with the
  live gate on, a test caller cannot queue, claim, issue or redeem a live
  purchase, and a live caller cannot touch a test purchase, even for the same
  email. The environment-blind signatures from `202610260002` are dropped, not
  overloaded. Separate Supabase projects per environment remain the deployment
  plan; this is defense in depth.
- Turning either gate off stops new issuance and redemption immediately. Already
  activated Macs keep working through the existing device-permit path.

Deploy order: apply the migration first, then deploy the edge functions that
pass `p_environment`. In between, the old functions call dropped signatures and
fail closed: resend and redeem return 503 `activation_unavailable`, and the
worker raises before claiming, so queued rows stay pending and nothing is sent.
No compatibility shim exists by design. On the test project this briefly
interrupts private test redemption; on the empty live project nothing is
affected.

Launch order (each step needs its own approval): apply the migration with both
gates off, deploy functions, set the sender and key, set
`LIVE_PURCHASE_CODES_ENABLED`, optionally a canary list, flip the DB gate, then
enable sending.

## Local verification (2026-10-26)

From `supabase/functions`:

- `deno test --no-remote --frozen --allow-env _shared/*_test.ts commerce-api/routes/*_test.ts`: 50 passed, 0 failed (baseline 44).
- `deno check --no-remote --frozen commerce-api/index.ts stripe-worker/index.ts`: passed.

From the repository root, disposable cluster only:

- `python3 supabase/tests/run_private_purchase_tests.py --pg-bin /opt/homebrew/opt/postgresql@14/bin`: all three phases passed. The runner applies the earlier migrations and seed, loads synthetic OTP-era state (`private_purchase_codes_pre.sql`), applies `202610260002`, then runs `private_purchase_codes.sql` and a two-session race. The fixture also covers the review fixes: limited trial upgrade at fulfillment, lost-response recovery after challenge expiry, per-order email and rotation for multiple purchases, `already_activated`, and trial deactivation on upgrade. It creates and removes its own Unix-socket-only cluster and cannot target an existing database. Never run these fixtures against a hosted database.

LIC-003 (production mode) re-run, PostgreSQL 16, disposable cluster: `deno task check` passed; `deno test --allow-env _shared/*_test.ts commerce-api/routes/*_test.ts` 59 passed, 0 failed; `run_private_purchase_tests.py --pg-bin /opt/homebrew/opt/postgresql@16/bin` passed all three phases, including the live and environment-contract block: invalid/missing environment raises on all four RPCs; no legacy signature remains; gate off rejects and does not queue; with the gate on, the same email's test and live purchases cannot be claimed, issued, re-queued or redeemed across environments; live redeems once for any buyer with one Mac and no trial; canary, refund and gate-off still reject; service_role cannot write the gate.

No real email, Resend call, Stripe call, hosted migration or native signed-app test was run.

## External setup still pending

1. Verify the existing Supabase test project and its migration history, then apply `202610260001` (if absent) and `202610260002` only after approval.
2. Store `RESEND_API_KEY` and set `PRIVATE_ACTIVATION_EMAIL_FROM` on the verified Resend domain, after approval. Keep sending disabled until a specific send is approved.
3. Map the sandbox Product/Price (USD 14 once) to the test offer; deploy functions and the worker schedule after approval.
4. Customer-facing copy still says two Macs: `legal/terms.html` (hashed policy evidence; changing it needs a new policy version and set) and `gesture-flow/index.html`. These need a separate approved update before any purchase is offered.
5. Signed native app end-to-end testing with the hosted test environment.

Provider references: [Resend send email API](https://resend.com/docs/api-reference/emails/send-email). It documents the transport; it does not establish that this project has been configured.
