-- Apply after commerce-ops-install.sql on the explicitly selected project.
-- No new login, credential, public RPC, or commerce_ops grant is created.
\set ON_ERROR_STOP on
\if :{?job_name}
\else
  \set job_name gesture-flow-live-worker
\endif
begin;
create table if not exists public.commerce_runtime_health (
  singleton boolean primary key default true check (singleton),
  healthy boolean not null,
  checked_at timestamptz not null
);
alter table public.commerce_runtime_health enable row level security;
alter table public.commerce_runtime_health force row level security;
revoke all on public.commerce_runtime_health from public, anon, authenticated, service_role;
grant select on public.commerce_runtime_health to service_role;

create table if not exists commerce_ops.backup_checks (
  singleton boolean primary key default true check (singleton),
  backup_created_at timestamptz not null,
  verified_at timestamptz not null
);
alter table commerce_ops.backup_checks enable row level security;
alter table commerce_ops.backup_checks force row level security;
revoke all on commerce_ops.backup_checks from public,anon,authenticated,service_role;

create index if not exists commerce_worker_requests_dispatched_idx
  on commerce_ops.worker_requests (dispatched_at desc);
create index if not exists commerce_purchase_email_health_idx
  on public.commerce_purchase_code_emails(status, created_at);

create or replace function commerce_ops.capture_health(p_worker_job text)
returns void language plpgsql security definer set search_path = ''
set lock_timeout = '1s' as $$
declare
  worker_ok boolean;
  queue_ok boolean;
  backup_ok boolean;
begin
  if p_worker_job not in ('gesture-flow-test-worker','gesture-flow-live-worker') then
    raise exception 'invalid_worker_job';
  end if;
  -- At most six recent minute dispatches are inspected. Bad/malformed responses
  -- fail this statement, leaving the previous snapshot to expire fail-closed.
  with recent as (
    select q.request_id, q.dispatched_at from commerce_ops.worker_requests q
    where q.dispatched_at >= now() - interval '5 minutes'
      and q.dispatched_at <= now()
    order by q.dispatched_at desc limit 6
  ), responses as (
    select r.status_code, r.timed_out,
      case when r.status_code=200 then r.content::jsonb else null end as body
    from recent q join net._http_response r on r.id=q.request_id
  )
  select exists (
    select 1 from responses where status_code=200 and timed_out=false
      and body->>'code' is null
      and body->>'failed'='0' and body->>'leaseLost'='0'
      and jsonb_typeof(body->'retention')='object'
      and body->'purchaseEmails'->>'failed'='0'
      and body->'purchaseEmails'->>'uncertain'='0'
      and body->'purchaseEmails'->>'completionFailed'='0'
  ) and (select count(*)=1 from cron.job
    where jobname=p_worker_job and active and schedule='* * * * *') into worker_ok;

  select not exists (
    select 1 from public.commerce_stripe_events
    where status='dead_letter'
      or (status='processing' and locked_at < now()-interval '5 minutes')
      or (status in ('received','failed') and received_at < now()-interval '5 minutes')
  ) and not exists (
    select 1 from public.commerce_purchase_code_emails
    where status in ('failed','uncertain')
      or (status='pending' and created_at < now()-interval '5 minutes')
      or (status='sending' and attempted_at < now()-interval '5 minutes')
  ) into queue_ok;

  select exists(select 1 from commerce_ops.backup_checks
    where singleton and backup_created_at >= now()-interval '26 hours'
      and backup_created_at <= now() and verified_at >= backup_created_at
      and verified_at <= now()) into backup_ok;

  insert into public.commerce_runtime_health(singleton,healthy,checked_at)
    values(true,coalesce(worker_ok and queue_ok and backup_ok,false),clock_timestamp())
  on conflict(singleton) do update
    set healthy=excluded.healthy,checked_at=excluded.checked_at;
end; $$;
revoke all on function commerce_ops.capture_health(text)
  from public,anon,authenticated,service_role;

-- The timeout belongs to the session command preceding the query, so it bounds
-- the whole capture statement, including future table growth and lock waits.
select cron.schedule(replace(:'job_name','-worker','-health'), '* * * * *',
  format('set statement_timeout = ''3s''; select commerce_ops.capture_health(%L);', :'job_name'));
set local statement_timeout = '3s';
select commerce_ops.capture_health(:'job_name');
commit;
