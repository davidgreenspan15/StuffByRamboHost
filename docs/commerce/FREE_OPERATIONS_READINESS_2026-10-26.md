# Gesture Flow free operations readiness

October 26, 2026. OPS-003 remains in progress. A live encrypted backup has been uploaded to the existing iCloud Drive account and restored after a verified cloud download. The health endpoint and private snapshot SQL are prepared and locally tested; coordinator deployment evidence belongs in the production checkpoint. Independent notification delivery and successful background backup execution remain separate acceptance checks.

## Monitoring implementation

`GET /v1/health` returns only `{"healthy":true}` with HTTP 200 or `{"healthy":false}` with HTTP 503. It uses the existing trusted proxy boundary, a limit of twelve requests per IP per minute, and no-store response headers. Missing, malformed, future-dated, failed or older-than-three-minute snapshots fail closed. Database errors are never returned to the caller.

`scripts/commerce-ops-health-install.sql` creates a forced-RLS singleton health table. Only the existing service role can SELECT it; browser roles have no grants. A private `commerce_ops.capture_health` function is callable only by its administrative owner. The minute schedule runs with a three-second statement timeout and reads at most six recent worker responses, queue/email failure conditions, and the original creation time of the last verified cloud backup. A missing or older-than-26-hour backup makes health false. No new database login, credential, public RPC, Vault access, or commerce_ops schema grant is introduced.

`.github/workflows/commerce-health.yml` checks this endpoint every fifteen minutes, offset from the start of the hour. It requires `COMMERCE_HEALTH_ENABLED=true` and the exact public repository, uses a standard Linux runner, no credentials, no checkout and no stored artifacts. [Standard public-repository runner usage is free](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Actual failure-email delivery must be tested under the owner's [Actions notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).

This is best-effort monitoring. GitHub schedules can be delayed or dropped, and [public-repository schedules are disabled after sixty days without activity](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows). With normal scheduler execution, a stopped worker can take five minutes to become unhealthy plus the next fifteen-minute external check. A stopped capture schedule expires its snapshot after three minutes. Neither monitoring cadence is a production SLA or a substitute for reviewing missed workflow runs.

Local validation: three Deno health tests and both function entrypoint typechecks passed. `scripts/test-commerce-ops-health.py` passed ten isolated PostgreSQL 17 cases: missing backup, healthy state, stale backup, future backup, disabled scheduler, stale worker, dead letter, uncertain email, recovery, and effective privilege isolation. The test creates and removes only its own temporary Unix-socket cluster.

## Encrypted backup and recovery

The trusted Mac runs `scripts/commerce-local-backup.py` using the existing native database and age helpers. Database credentials and the private age identity remain on this Mac. The existing exporter streams PostgreSQL output directly into age encryption. Only the encrypted archive and non-customer manifest enter `iCloud Drive/DatabaseBackups/GestureFlow`.

The live archive created at 22:44:13 UTC contained 344,877 encrypted bytes. Native Apple metadata confirmed that both files were uploaded. Cloud-local copies were evicted while the private originals remained intact, then downloaded again; the archive hash matched and the isolated PostgreSQL 17 restore passed, including original row counts and existing RLS/browser-access assertions. The verification completed at 22:46:26 UTC. Private evidence remains in `local-backup-last-success.json` under the production setup directory. The archive SHA-256 is `570709bcb43490a07624fb0ff8685dba17c3f51e0690851771e57d0b97806fc0`.

Apple distinguishes a file merely targeted for iCloud from an actual upload; the wrapper checks [uploaded resource metadata](https://developer.apple.com/documentation/foundation/urlresourcekey/ubiquitousitemisuploadedkey) before recording success. A completed cloud upload and matching bytes are required before the original backup creation timestamp is recorded privately in the production health table. Rechecking an old archive does not advance its recovery point.

The wrapper rejects plaintext, bad hashes, wrong environments, path escapes, symlinks, unknown target entries and oversized archives. Existing destination bytes are immutable; a retry may confirm an identical prior copy but cannot overwrite it. Individual archives are capped at 20 MiB; the dedicated cloud directory stops accepting new backups before 160 MiB. No prior backup or unrelated file is deleted. Retention review is required when that cap is approached. Nine offline guard tests passed. The Swift helper compiled, and the LaunchAgent plist passed validation.

The LaunchAgent `com.stuffbyrambo.gesture-flow-backup` is installed for 03:23 local time daily plus login/load. Every invocation attempts a new backup: a recent manual/login backup cannot suppress the next daily run. Its first background run stalled in an iCloud directory open; the interactive backup path succeeded. That run was stopped. The wrapper requests graceful termination at ten minutes, allows up to sixty seconds for cleanup, and only then force-stops an unresponsive worker. Individual child timeouts also request graceful termination before escalation. The restore drill handles termination by stopping its own temporary PostgreSQL cluster before removing plaintext data; a failed shutdown preserves the directory and reports failure. macOS background access/consent and a successful unattended run remain unverified. Do not equate the installed schedule with an operating daily backup.

Review follow-up: nine backup guard tests pass, including recent-backup cadence and child timeout cleanup. A disposable PostgreSQL termination drill verifies that interrupting the restore path stops its temporary server and removes its private data directory. No cloud backup was repeated for this local fix.

The Mac must be running, the user session and required Keychain entries available, and iCloud synchronization healthy. No plan upgrade, new credential grant, or paid storage/overage was enabled. Existing iCloud capacity exhaustion stops the backup; this workflow cannot purchase capacity. The private GitHub Actions backup remains disabled: billing readback was unavailable to the existing GitHub token, and the hosted backup role could not meet the required privilege boundary.

Supabase's managed Auth tables are owned by `supabase_auth_admin`; the project `postgres` role cannot assume that role. The hosted `net` queue grants full read/write access through PUBLIC, so introducing a supposedly narrow backup login would inherit unwanted queue access. The current [Supabase backup-role guidance](https://supabase.com/docs/guides/troubleshooting/pg_dump-fails-with-query-would-be-affected-by-row-level-security-policy-1d5783) explicitly describes this limitation. No broad role or administrator credential was placed in CI to bypass it.

## Completion checks

- Verify the deployed health endpoint returns only the expected boolean and fails when its snapshot is stale.
- Publish/enable the public monitoring workflow through the coordinator's authorized source workflow and verify a real failed-run notification followed by recovery.
- Resolve macOS background iCloud access through the normal user consent path and verify a launchd-driven export/upload without relying on this interactive tool session.
- Keep the free-plan, local-machine dependency, storage-cap and missed-schedule risks in final Fable review.

Native worker `operations_readiness` authored this bounded operations slice; policy revision 2026-10-13 was reread. The user reserved final Fable review. The coordinator owns cloud SQL/API deployment, integration, source publication and final acceptance.
