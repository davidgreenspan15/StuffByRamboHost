"""Validate policy publication in a new Unix-socket-only PostgreSQL cluster.

No database URL or existing server is accepted. All rejection cases must leave
policy documents, policy sets and offers exactly unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
NEW_SET = "20000000-0000-4000-8026-000000000001"
OLD_SET = "20000000-0000-4000-8000-000000000001"
VERSION = "gesture-flow-us-2026-10-26-v1"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, required=True)
    args = parser.parse_args()
    binaries = {name: args.pg_bin / name for name in ("initdb", "pg_ctl", "psql")}
    for binary in binaries.values():
        if not binary.is_file():
            parser.error(f"PostgreSQL binary missing: {binary}")
    directory = Path(tempfile.mkdtemp(prefix="gesture-policy-", dir="/tmp"))
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    started = False
    start_attempted = False
    policy = (ROOT / "scripts/production-policy.sql").read_text()
    cases = 0

    def command(argv: list[str], query: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(argv, input=query, text=True, capture_output=True,
                              env=env, timeout=40)

    def run(argv: list[str]) -> None:
        result = command(argv)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)

    def sql(query: str, database: str = "postgres", *, expected_error: str | None = None) -> str:
        result = command([str(binaries["psql"]), "-X", "-q", "-A", "-t", "-h",
                          str(directory), "-p", "55443", "-d", database,
                          "-v", "ON_ERROR_STOP=1"], query)
        if expected_error is not None:
            assert result.returncode != 0, "policy application unexpectedly succeeded"
            assert expected_error in result.stderr, result.stderr
        elif result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout.strip()

    def snapshot(database: str) -> str:
        return sql("select jsonb_build_object("
                   "'documents',(select jsonb_agg(to_jsonb(d) order by id) from commerce_policy_documents d),"
                   "'sets',(select jsonb_agg(to_jsonb(s) order by id) from commerce_policy_sets s),"
                   "'offers',(select jsonb_agg(to_jsonb(o) order by id) from commerce_offers o));", database)

    def fresh(name: str) -> str:
        assert name.isidentifier()
        sql(f'create database "{name}" template policy_baseline;')
        return name

    def rejected(database: str, expected_error: str) -> None:
        nonlocal cases
        before = snapshot(database)
        sql(policy, database, expected_error=expected_error)
        assert snapshot(database) == before, "failed policy application did not roll back fully"
        cases += 1
        print(f"PASS: {database} rejects and rolls back ({expected_error})")

    try:
        run([str(binaries["initdb"]), "-D", str(directory / "data"),
             "--auth-local=trust", "--auth-host=reject", "--no-locale"])
        start_attempted = True
        run([str(binaries["pg_ctl"]), "-D", str(directory / "data"),
             "-l", str(directory / "postgres.log"), "-o",
             f"-k {directory} -h '' -p 55443", "start"])
        started = True
        sql("create role anon; create role authenticated; create role service_role bypassrls;"
            "create database policy_baseline;")
        sql("create schema auth; create schema extensions;"
            "create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);",
            "policy_baseline")
        for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            sql(migration.read_text(), "policy_baseline")
        sql((ROOT / "supabase/seed.sql").read_text(), "policy_baseline")

        database = fresh("apply_rerun")
        historical = sql("select jsonb_agg(to_jsonb(d) order by id) from commerce_policy_documents d;", database)
        original_test_offer = sql("select to_jsonb(o) from commerce_offers o where environment='test';", database)
        sql(policy, database)
        after_first = json.loads(snapshot(database))
        sql(policy, database)
        after_second = json.loads(snapshot(database))
        assert after_first["documents"] == after_second["documents"]
        assert after_first["sets"] == after_second["sets"]
        for state in (after_first, after_second):
            offers = {offer["environment"]: offer for offer in state["offers"]}
            assert offers["live"]["current_policy_set_id"] == NEW_SET
            assert offers["live"]["checkout_enabled"] is False
            assert offers["test"]["current_policy_set_id"] == OLD_SET
            assert len(state["documents"]) == 10 and len(state["sets"]) == 2
        assert sql("select to_jsonb(o) from commerce_offers o where environment='test';", database) == original_test_offer
        assert sql("select jsonb_agg(to_jsonb(d) order by id) from commerce_policy_documents d "
                   "where version like '%2026-07-13%';", database) == historical
        manifest = json.loads((ROOT / "docs/commerce/production-policy-manifest.json").read_text())
        seed = (ROOT / "supabase/seed.sql").read_text()
        for kind, expected_hash in manifest["previousHashes"].items():
            archived = ROOT / f"legal/versions/2026-07-13/{kind}.html"
            assert hashlib.sha256(archived.read_bytes()).hexdigest() == expected_hash
            assert expected_hash in seed
        cases += 1
        print("PASS: apply/rerun keeps one policy version, disabled checkout, test offer and historical rows/bytes unchanged")

        database = fresh("zero_target")
        sql("delete from commerce_offers where environment='live';", database)
        rejected(database, "expected_exactly_one_disabled_live_offer")

        database = fresh("enabled_live")
        sql("update commerce_offers set checkout_enabled=true,published_at=clock_timestamp(),"
            "stripe_product_id='prod_fixture',stripe_price_id='price_fixture',unit_amount=1400 "
            "where environment='live';", database)
        rejected(database, "disable_live_checkout_before_policy_switch")

        for suffix, kind, old_id, version in [
            ("terms", "terms_of_sale", 1, "gesture-flow-terms-eula-2026-10-26-v1"),
            ("eula", "eula", 2, "gesture-flow-terms-eula-2026-10-26-v1"),
            ("privacy", "privacy", 3, "gesture-flow-privacy-2026-10-26-v1"),
            ("refund", "refund", 4, "gesture-flow-refunds-2026-10-26-v1"),
            ("compatibility", "compatibility", 5, "gesture-flow-compatibility-2026-10-26-v1"),
        ]:
            database = fresh(f"mismatch_{suffix}")
            sql("insert into commerce_policy_documents "
                "(id,document_type,version,canonical_url,sha256,published_at,effective_at) "
                f"values ('10000000-0000-4000-8026-{old_id:012d}','{kind}','{version}',"
                "'https://example.test/incorrect-policy',repeat('0',64),"
                "'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z');", database)
            rejected(database, "policy_evidence_mismatch")

        for mismatch in ("set_references", "set_id"):
            database = fresh(mismatch)
            target_id = NEW_SET if mismatch == "set_references" else "20000000-0000-4000-8026-000000000099"
            sql("insert into commerce_policy_sets "
                "(id,version,terms_document_id,eula_document_id,privacy_document_id,"
                "refund_document_id,compatibility_document_id,published_at) "
                f"select '{target_id}','{VERSION}',terms_document_id,eula_document_id,"
                "privacy_document_id,refund_document_id,compatibility_document_id,published_at "
                f"from commerce_policy_sets where id='{OLD_SET}';", database)
            rejected(database, "policy_set_evidence_mismatch")

        database = fresh("retired_set")
        sql(policy, database)
        sql(f"update commerce_policy_sets set retired_at=clock_timestamp()-interval '1 second' where id='{NEW_SET}';"
            f"update commerce_offers set current_policy_set_id='{OLD_SET}' where environment='live';", database)
        rejected(database, "production_policy_set_not_active")
        print(f"PASS: {cases} production-policy database scenarios; no hosted database used")
    finally:
        if start_attempted and not started:
            result = command([str(binaries["pg_ctl"]), "-D", str(directory / "data"), "status"])
            started = result.returncode == 0
        if started:
            run([str(binaries["pg_ctl"]), "-D", str(directory / "data"), "stop", "-m", "fast"])
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
