# Fable final security review — October27, 2026

## Coordinator disposition

Review complete. Fable reported no launch blocker conditional on migration0004 being live. That condition is closed: read-only live Supabase inspection verified the exact reviewed function body, both device-key/challenge-binding guards, empty search_path and service-only execution grants. Local/live function-body MD5 both3c0335d28a77b353c28c36d1735f8c3f. This provider verification arrived while Fable was finalizing its reply, so the original wording below retains the earlier question for provenance. No new migration or code change was needed.

Credential cleanup is complete: owner rotated both exposed test keys; Dashboard shows fresh replacements. Superseded restricted key rejects401, replacement test-price read succeeds200, exact native secure readback and isolated test-backend installation passed; clipboard cleared. Full-access old-key revocation evidence is owner action and Dashboard replacement, not a retained old-value API probe. No live credentials changed.

This is a bounded read-only review, not proof that every attack is impossible. The three nonblocking findings below remain: signed response replay through an attacker-trusted TLS interception setup, device-code phishing, and low-impact login CSRF. In particular the signed-response replay issue was NOT fixed by build49, and no unconditional guarantee of a30-day bound under TLS interception is made. Fable classified it as an owner-control limitation; optional replay hardening is recorded for follow-up. No new build or test campaign was started for these nonblocking findings.

Observed model from provider transcript: claude-fable-5-1. Team Mode job31529244-792f-48d8-959c-ba6218b56e0d completed, consult profile, exact GestureControl root. App code source47c57b1 and accepted candidate3.2.29/build49 unchanged. Shared policy revision2026-10-13; user explicitly selected Fable. Original source inspection had no provider/browser access; live confirmation was performed by the coordinator. Public sales and appcast remain disabled/unchanged pending final publication.

## Original reviewer report

**Verdict: no concrete bypass found that affects the unmodified signed client or the backend records.** There is no launch blocker from this review, on one condition stated first below. Everything else is either owner-side tampering, which the brief accepts as inherent, or a documented operating limit.

Paths below are relative to `StuffByRamboHost/supabase/functions/` for backend code, `StuffByRamboHost/supabase/migrations/` for SQL, and `GestureControl/python/gestureflow_py/` for the app.

## Condition to confirm before publication
**Migration 0004 must be live.** `202610260004_browser_activation_key_binding.sql` is the SEC-B01 fix. The changelog says key binding was deployed to "the isolated backends and proxy" (`docs/CHANGELOG.md:63`), but the preparation record lists live migrations only through 0003, and no later document names 0004 for the live project. Without it, a licensed owner running a custom client can reuse an active installation UUID to rebind the device key and run a second Mac on a one-Mac purchase while the old client keeps its offline permit. That is a backend-records bypass, not a client-patch limit. I sent the coordinator this question; confirming it needs provider state, which I cannot read.

## Findings, ranked
None of these is a blocker.

1. **Trusted clock can be rolled back by a replayed refresh response.** The client accepts any validly signed permit for its installation and activation with no check that the new `iat` is at least the current one, then resets the trusted clock to that `iat` (`access_gate.py:614-642`, `licensing_clock.py:132-151`). Replaying an older refresh response defeats the 30-day offline bound. Precondition: TLS interception of the pinned host, so an owner-installed CA. Owner limit. Hardening is one line: require new `iat` ≥ current `iat` when `expected_session` is set.

2. **Device-code approval is phishable.** An attacker creates a challenge on their Mac and persuades a licensed victim to approve the code in the portal. The approval RPC then binds the attacker's Mac to the victim's purchase slot, or starts the victim's one-time trial (`202610260002…:526-640`). Inherent to device-code flows. The portal copy warns to approve only a Mac you control, and the victim can see and deactivate the device. Accepted limit.

3. **Login CSRF through an attacker's own sign-in link.** The portal exchanges whatever fragment token it receives (`assets/storefront.js:366-379`, `routes/portal.ts:167-220`), so an attacker could sign a victim's browser into the attacker's account. The portal then only shows the attacker's own data, and every mutation needs the CSRF header. Negligible impact.

## Controls verified as sound
- **Permit verification:** exact header set, EdDSA only, trusted key set from the bundle, exact claim sets, installation and activation binding, product and version pins, 30-day lifetime cap, trial expiry checks (`licensing_crypto.py:124-315`). Fails closed when no key is configured.
- **Replay:** signed device requests carry a ±300 s timestamp and a nonce. The nonce is inserted after signature verification into a table whose primary key is activation plus nonce hash (`_shared/device-auth.ts:141-156`, `202607130001…:301-308`). Retention deletes nonces only after the timestamp window has closed.
- **Device caps and transfers:** exchange, purchase-code redemption, and portal approval all lock rows, count active devices, refuse key replacement on an active installation, and consume challenges once (`202610260004…`, `202610260003…:200-375`). One trial per account is a partial unique index (`202607130001…:231-233`). Purchases are forced to one Mac by trigger (`202610260002…:19-30`).
- **Revocation:** refresh re-checks activation and entitlement state and returns a signed revocation bound to the current permit `jti` (`routes/device.ts:336-424`). The client locks only on a verified revocation and ignores unsigned denials (`access_gate.py:644-682`). Refund and dispute state flows through a single reducer (`202607130001…:1363-1441`).
- **Clock rollback:** wall-clock rollback beyond 5 minutes forces online recovery; continuous uptime and the boot ID bound trusted time within a boot (`licensing_clock.py:78-127`). Deleting the clock item locks the app until signed server time is recovered.
- **Privilege boundary:** every commerce table has forced RLS, browser roles have no table or function grants, all RPCs are security definer with an empty search path, and the live purchase-code gate is read-only even to the service role (`202607130001…:1854-1875`, `202610260003…:21-30`).
- **Proxy and environment separation:** the Supabase function rejects requests without the proxy secret in constant time, live config refuses local direct requests, the proxy pins its upstream and overwrites all trusted metadata headers (`_shared/http.ts:39-49`, `_shared/config.ts:280-291`, `edge/licenses-proxy/src/index.ts:22-36,104-116`). Test and live are separate projects with separate permit keys.
- **Storefront and portal:** token accepted only from the fragment, stripped from history, query-string tokens rejected; checkout redirect restricted to the Stripe host; host-only cookies with SameSite=Strict plus a CSRF header; portal markers require a magic-link or OTP session, so a password session created directly against Supabase Auth cannot reach the portal (`_shared/auth.ts:163-175`).
- **Packaging:** hardened runtime with timestamp, no debugging entitlement anywhere, host licensing entitlements confined to the main app, Sparkle Downloader rights preserved, deep strict verify, and the only entitlement in the base plist is camera, so library validation stays on (`python/scripts/sign_app.py`, `python/resources/macos.entitlements.plist`). The build gate refuses the documented test keys. No hidden CLI flag or environment variable bypasses the gate; the suppressed flag is the HUD child.

## Accepted limits, stated precisely
- **Local patchability.** A device owner can edit the bundle or attach with SIP disabled. Signed permits protect server-issued authorization, not a modified client.
- **Reboot time freeze is bounded by usage, not indefinite.** Time while powered off is not established across reboots, but the elapsed anchor advances trusted time whenever the app runs. An offline refund-fraud user therefore gets at most 30 days of cumulative use from the last permit, not unlimited use.
- **Revocation lag.** Refund, dispute, and deactivation reach an offline Mac only at its next refresh, within 24 hours when online and no later than the 30-day permit expiry. Explicit transfers can briefly overlap.
- **Trials are per verified email, not per person or Mac.**
- **Availability on free plans.** Magic-link requests are unauthenticated and rate-limited per IP and per email, not globally, so a distributed sender could consume the shared Resend daily quota and delay purchase-code emails. Already recorded in the app security review.
- **Swift Native lane** has a test lock only and is out of scope for the paid product.

## Unverified assertions
- Migration 0004 on the live project, as above.
- Dispute-driven revocation under Managed Payments has no end-to-end evidence; `charge.dispute.*` events reaching this account as merchant of record are untested.
- The live purchase-code path has never run in production: gate flip, issuance, send, and redemption. The documents already say the first genuine sale is that test.
- Parity between the reviewed source refs and the deployed Edge Function and proxy code is not verifiable from here.

## Access and identity
My tool access was Read, Grep, and Glob over both repositories plus the team tools. No shell, browser, provider, or credential access was used, and no secret store, Keychain dump, token, or private key file was read. My model is self-reported from the system prompt as claude-fable-5-1. The coordinator's completion log records provider metadata independently.
