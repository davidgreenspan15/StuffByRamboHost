# Commerce validation and release status

Updated October 27, 2026. Production integration and the focused licensing checks below are verified. Sales and candidate public release remain disabled. Fable's final bypass-security review has not run; corrected build49 and private installed-update acceptance passed. Exposed sandbox-key rotation and restricted replacement configuration are verified complete.

## Executed source and isolated checks

- Latest recorded backend run: 69 Deno tests and function typechecks passed.
- Eight Cloudflare proxy tests, typecheck and dry build passed; the recorded deployment-tooling audit reported zero advisories.
- Disposable PostgreSQL purchase-code checks passed, including concurrent redemption and refund/environment isolation. Eleven policy-publication cases passed, including rerun safety and conflict rollback.
- Scoped storefront validation passed. Security-header validation covered 18 host/path cases and 16 pages; deployed commerce headers include CSP, frame denial and nosniff.
- Ten isolated PostgreSQL health cases and thirteen local backup guard cases passed. Actual temporary-server termination verified restore cleanup. These checks do not replace cloud upload or recovery evidence.
- The separate desktop project previously passed 171 Python tests, including release-publication guards and bounded outage retries. The signing correction passed42 focused release/signing checks, and the dependency preflight passed10 focused build checks. Both received independent review; final artifact/native/update evidence is below.

Historical test counts describe their recorded source milestone. They do not establish a later binary's acceptance.

## Restricted-key and production integration acceptance

Fresh Stripe live/sandbox and Supabase connector access was verified. The approved restricted sandbox backend key completed a real hosted Managed Payments test checkout. Payment, signed webhook fulfillment, owner email, isolated current-source activation/reload, bounded offline use and consumed-code rejection passed. Full test refund produced durable verified signed revocation and a locked reload. This closes the earlier missing-revocation-output and restricted-key gates. No real-money test purchase occurred; test checkout and webhook were disabled afterward.

The stable proxy uses the three matching live bindings and production permit key. The pinned live webhook is enabled with the eleven supported event types. The live offer and purchase-code release gates remain disabled. Reviewed personal-use policies were published and all eight canonical/immutable byte comparisons passed. Candidate download links remain withheld. Earlier references to unpublished policy routes returning 404 or a disabled live webhook describe superseded preparation states.

Actual production owner sign-in passed through the published portal. On October 27 the owner started the real 14-day production trial; signed 3.2.29 build 47 activated and retained access after quit/relaunch. The guarded test restored and verified the original Keychain records, app files and preferences exactly; the installed original app remains unchanged. Portal deactivation of the test device was verified with zero occupied slots. The account's real trial start remains intact.

## Free operations acceptance

Supabase Free and Resend Transactional Free/base allowance were verified with paid overages disabled. Authenticated Chrome account Billing/Subscriptions readback confirmed Workers Free Active and zone Free Plan Active, closing the earlier API billing-visibility gap. No plan or payment setting was changed.

Minutely worker and health snapshot scheduling are verified. Public health exposes only a boolean with no-store. The enabled fifteen-minute GitHub monitor's deliberate failure run `40416568422` delivered an owner inbox notification; normal run `40416708850` passed afterward. Monitored health passed following the latest verified backup. No production outage was injected.

Encrypted test/live exports and PostgreSQL 17 restore drills passed. A live encrypted iCloud archive was additionally downloaded again, hash-verified and restored with expected row counts/security checks. The installed daily LaunchAgent then completed a fresh encrypted export/upload and private health update under launchd: run 4 exited zero at `2026-10-27T15:30:06.721579Z`. Bounded retry resolved temporary iCloud upload errors without permission changes. This closes the earlier unattended-access blocker; the Mac, available Keychain, cloud quota and missed-schedule risks remain operating limits. No broad database backup role or administrator credential was placed in CI. See [free operations evidence](FREE_OPERATIONS_READINESS_2026-10-26.md).

## Corrected candidate and installed update — complete

Corrected Python **3.2.29 build49** is the accepted private candidate. Explicit inside-out signing confines provisioning/Keychain entitlements to the main app and preserves Sparkle Downloader's own rights. A production preflight now rejects stale or missing runtime/packaging pins in the selected interpreter. All209 native files passed the entitlement gate; packaged cryptography50.0.2 and Pillow13.0.0 were independently read from metadata/the Python archive. The existing patched Python3.12 environment satisfied all7 active pins.

Apple notarization accepted submission `117bbbb2-b3d8-4417-a0c1-b19993bb343c`. App/DMG tickets, deep strict signature and both Gatekeeper assessments passed. Final DMG is114313993bytes, SHA-256`505aa95a98d53fbcd5515fba750631aa6984ca5c3bdcf89cc852d20a5527453f`. The original production public-key map matches the embedded map.

On this exact build, production owner trial activation and quit/relaunch passed with the existing November10 expiry. The main app and HUD child ran normally; isolated helper startup/EOF shutdown passed with no injected visual events. The real Sparkle flow updated a private copy of installed build43 to49, validated the signed download, installed/relaunched, and retained trial access. The updated executable matches the candidate; its strict signature passes. The actual `/Applications` build43 remains untouched.

All original native Keychain records, app files and preferences were restored and readback-verified. The temporary local update server stopped; the temporary feed preference was removed. Final test-device deactivation returned zero occupied slots. Server-side trial start intentionally remains; no trial reset or live test payment occurred.

## Remaining review and publication boundaries

- Sandbox credential cleanup completed October27: owner rotated both exposed keys; Dashboard shows both fresh replacements. Old stored restricted key returns401, replacement test-price read returns200, exact native storage readback and isolated test backend replacement passed. Clipboard cleared; no live environment changed. Full-access revocation relies on owner action and Dashboard replacement readback because the superseded value is not retained.
- Fable has not performed the requested final review for licensing/security bypasses. The [final-review handoff](FABLE_FINAL_REVIEW_2026-10-26.md) identifies completed evidence and the accepted corrected candidate.
- Installed Sparkle update acceptance passed on the private43-to49 path. No new broad hardware/permission test campaign was performed or added to the review gate.
- Sales enablement, public candidate appcast/release and final launch approval remain separate. Existing public feed and candidate release state are unchanged. No real-money test transaction, paid upgrade, recurring charge, automatic paid overage or carbon contribution is authorized.

Claude Opus supplied earlier licensing-isolation and release-guard implementation/review. Codex integrated and verified the recorded checks; native peers reviewed bounded operational and candidate work. Team/model policy revision 2026-10-13 was reread for this update; the user reserves Fable's final review and requested no new Opus assignment. This evidence summary is neither final security approval nor legal/tax professional review.
