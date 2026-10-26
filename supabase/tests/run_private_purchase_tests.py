"""Run synthetic licensing checks in a new, Unix-socket-only temporary database.

Requires installed PostgreSQL binaries; never accepts a database URL or uses an
existing server. Example: --pg-bin /opt/homebrew/opt/postgresql@14/bin
"""
from __future__ import annotations

import argparse
import concurrent.futures
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, required=True)
    args = parser.parse_args()
    binaries = {name: args.pg_bin / name for name in ("initdb", "pg_ctl", "psql")}
    for binary in binaries.values():
        if not binary.is_file():
            parser.error(f"PostgreSQL binary missing: {binary}")
    root = Path(__file__).resolve().parents[1]
    directory = Path(tempfile.mkdtemp(prefix="gesture-activation-", dir="/tmp"))
    # Ignore connection/service settings from the user's environment.
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    started = False
    start_attempted = False

    def run(command: list[str], text: str | None = None) -> str:
        result = subprocess.run(command, input=text, text=True, capture_output=True,
                                env=env, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout.strip()

    def sql(query: str) -> str:
        return run([str(binaries["psql"]), "-X", "-q", "-A", "-t", "-h",
                    str(directory), "-p", "55439", "-d", "postgres", "-v",
                    "ON_ERROR_STOP=1"], query)

    try:
        run([str(binaries["initdb"]), "-D", str(directory / "data"),
             "--auth-local=trust", "--auth-host=reject", "--no-locale"])
        start_attempted = True
        run([str(binaries["pg_ctl"]), "-D", str(directory / "data"),
             "-l", str(directory / "postgres.log"), "-o",
             f"-k {directory} -h '' -p 55439", "start"])
        started = True
        sql("create schema auth; create schema extensions; create role anon; "
            "create role authenticated; create role service_role bypassrls; "
            "create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);")
        migrations = sorted((root / "migrations").glob("*.sql"))
        # The single-use code migration is applied on top of OTP-era state so
        # its handling of already queued work and old limits is exercised.
        split = next(i for i, m in enumerate(migrations)
                     if m.name == "202610260002_single_use_purchase_codes.sql")
        for migration in migrations[:split]:
            sql(migration.read_text())
        sql((root / "seed.sql").read_text())
        sql((root / "tests/private_purchase_codes_pre.sql").read_text())
        for migration in migrations[split:]:
            sql(migration.read_text())
        sql((root / "tests/private_purchase_codes.sql").read_text())
        print("PASS: OTP retirement, issuance/rotation, single use, retry, limits, "
              "key conflict, refund/environment, trial, claim, permissions")

        race = ("select outcome from commerce_redeem_purchase_code('test', "
                "test_id('70000000',{n}),test_poll({n}),repeat('5',64),"
                "array['race@example.test'])")
        queries = [
            "begin; " + race.format(n=20) + "; select pg_sleep(0.3); commit;",
            race.format(n=21) + ";",
        ]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(sql, queries))
        assert sorted(value.strip() for value in results) == ["active", "invalid_code"], results
        assert sql("select count(*) from commerce_device_activations a "
                   "join commerce_entitlements e on e.id=a.entitlement_id "
                   "where e.claimed_email='race@example.test' and a.status='active'") == "1"
        print("PASS: two challenges racing one code yield exactly one activation")

        sql("update commerce_entitlements set status='suspended_refund' "
            "where id=test_id('60000000',10)")
        assert sql("select test_redeem(1, repeat('b',64))") == "invalid_code"
        assert sql("select outcome from commerce_exchange_activation("
                   "test_id('70000000',1),test_poll(1))") == "entitlement_inactive"
        sql("select commerce_request_purchase_code_email('test', 'buyer@example.test')")
        assert sql("select count(*) from commerce_claim_purchase_code_emails('test', "
                   "array['buyer@example.test'])") == "0"
        print("PASS: suspended purchase blocks code retry, exchange and email")
        sql((root / "tests/browser_activation_security.sql").read_text())
        print("PASS: browser activation rejects active key replacement; recovery and explicit transfer remain valid")
    finally:
        # If start timed out, check the exact temporary cluster before cleanup.
        if start_attempted and not started:
            status = subprocess.run([str(binaries["pg_ctl"]), "-D",
                                     str(directory / "data"), "status"],
                                    capture_output=True, env=env, timeout=10)
            started = status.returncode == 0
        if started:
            try:
                run([str(binaries["pg_ctl"]), "-D", str(directory / "data"),
                     "stop", "-m", "fast"])
            except Exception:
                print(f"Temporary database cleanup pending: {directory}")
                raise
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
