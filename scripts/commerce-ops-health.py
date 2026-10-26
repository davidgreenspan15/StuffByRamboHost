#!/usr/bin/env python3
"""Read-only aggregate health check. Connection uses standard libpq environment.

Outputs no customer fields or credentials. Exit 0 healthy, 2 degraded/error.
Connect using the exact reviewed project/session-pooler host and TLS verification.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--psql',default='psql')
    parser.add_argument('--job-name',choices=('gesture-flow-test-worker','gesture-flow-live-worker'),required=True)
    args=parser.parse_args()
    if not os.environ.get('PGHOST'):
        raise RuntimeError('explicit_connection_required')
    env=dict(os.environ,PGSSLMODE='verify-full',PGCONNECT_TIMEOUT='10',
             PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000')
    query=Path(__file__).with_suffix('.sql').read_text()
    result=subprocess.run([args.psql,'-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-v',f'job_name={args.job_name}'],
                          input=query,text=True,capture_output=True,env=env,timeout=20)
    if result.returncode:
        raise RuntimeError('health_query_failed')
    data=json.loads(result.stdout)
    counts=('deadLetters','staleLeases','oldPendingEvents','uncertainEmails','oldPendingEmails','staleEmailLeases')
    healthy=data['schedulerActive'] and isinstance(data['lastSuccessAgeSeconds'],int) and 0<=data['lastSuccessAgeSeconds']<=300
    healthy=healthy and all(data[k]==0 for k in counts)
    print(json.dumps({'healthy':bool(healthy),**data}))
    return 0 if healthy else 2


if __name__=='__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'healthy':False,'error':'health_check_failed'}))
        raise SystemExit(2)
