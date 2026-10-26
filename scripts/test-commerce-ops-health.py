#!/usr/bin/env python3
"""Exercise operations health only in a new private Unix-socket PG17 cluster."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

PG = Path('/opt/homebrew/opt/postgresql@17/bin')
ROOT = Path(__file__).resolve().parent
directory = Path(tempfile.mkdtemp(prefix='gf-health-', dir='/tmp'))
environment = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
running = False


def command(arguments, stdin=None):
    result = subprocess.run([str(value) for value in arguments], input=stdin,
                            text=True, capture_output=True, env=environment, timeout=30)
    if result.returncode:
        raise RuntimeError('health_test_command_failed')
    return result.stdout.strip()


def sql(statement):
    return command([PG / 'psql', '-X', '-Atq', '-h', directory, '-p', '55448',
                    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], statement)


def capture(label, expected):
    sql("select commerce_ops.capture_health('gesture-flow-live-worker');")
    assert sql('select healthy from public.commerce_runtime_health') == expected, label
    print(label + ': passed')


try:
    command([PG / 'initdb', '-D', directory / 'data', '--auth-local=trust', '--auth-host=reject', '--no-locale'])
    command([PG / 'pg_ctl', '-D', directory / 'data', '-l', directory / 'postgres.log',
             '-o', f"-k {directory} -h '' -p 55448", 'start'])
    running = True
    sql('''create role anon; create role authenticated; create role service_role bypassrls;
      create schema commerce_ops; create schema cron; create schema net;
      create table commerce_ops.worker_requests(request_id bigint primary key,dispatched_at timestamptz);
      create table cron.job(jobname text,active boolean,schedule text);
      create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
      create table net._http_response(id bigint primary key,status_code int,timed_out bool,content text);
      create table public.commerce_stripe_events(status text,locked_at timestamptz,received_at timestamptz);
      create table public.commerce_purchase_code_emails(status text,created_at timestamptz,attempted_at timestamptz);
      insert into cron.job values('gesture-flow-live-worker',true,'* * * * *');
      insert into commerce_ops.worker_requests values(1,now()-interval '1 minute');
      insert into net._http_response values(1,200,false,
        '{"failed":0,"leaseLost":0,"retention":{},"purchaseEmails":{"failed":0,"uncertain":0,"completionFailed":0}}');''')
    script = (ROOT / 'commerce-ops-health-install.sql').read_text()
    command([PG / 'psql', '-X', '-Atq', '-h', directory, '-p', '55448', '-d', 'postgres',
             '-v', 'ON_ERROR_STOP=1', '-v', 'job_name=gesture-flow-live-worker'], script)
    capture('missing backup', 'f')
    sql('insert into commerce_ops.backup_checks values(true,now(),now());')
    capture('healthy', 't')
    sql("update commerce_ops.backup_checks set backup_created_at=now()-interval '27 hours';")
    capture('stale backup', 'f')
    sql("update commerce_ops.backup_checks set backup_created_at=now()+interval '1 hour';")
    capture('future backup', 'f')
    sql('update commerce_ops.backup_checks set backup_created_at=now(),verified_at=now(); update cron.job set active=false;')
    capture('disabled scheduler', 'f')
    sql("update cron.job set active=true; update commerce_ops.worker_requests set dispatched_at=now()-interval '6 minutes';")
    capture('stale worker', 'f')
    sql("update commerce_ops.worker_requests set dispatched_at=now(); insert into commerce_stripe_events values('dead_letter',null,now());")
    capture('dead letter', 'f')
    sql("delete from commerce_stripe_events; insert into commerce_purchase_code_emails values('uncertain',now(),now());")
    capture('uncertain email', 'f')
    sql('delete from commerce_purchase_code_emails;')
    capture('recovered', 't')
    assert sql("""select has_table_privilege('service_role','public.commerce_runtime_health','SELECT')
      and not has_table_privilege('service_role','public.commerce_runtime_health','INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.commerce_runtime_health','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.commerce_runtime_health','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','commerce_ops.backup_checks','SELECT,INSERT,UPDATE,DELETE')
      and not has_function_privilege('service_role','commerce_ops.capture_health(text)','EXECUTE')""") == 't'
    print('least privilege: passed')
finally:
    if running:
        command([PG / 'pg_ctl', '-D', directory / 'data', 'stop', '-m', 'fast'])
    shutil.rmtree(directory)
