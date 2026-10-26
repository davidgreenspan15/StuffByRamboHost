-- Run only on the explicitly approved project after enabling pg_cron, pg_net
-- and Vault. Provision these Vault entries separately through a secret-safe
-- provider client: gesture_flow_project_url, gesture_flow_cron_secret.
-- No credential is embedded in cron.job.command or this source file.
\set ON_ERROR_STOP on
\if :{?job_name}
\else
  \set job_name gesture-flow-live-worker
\endif
begin;
create schema if not exists commerce_ops;
revoke all on schema commerce_ops from public, anon, authenticated, service_role;
create table if not exists commerce_ops.worker_requests (
  request_id bigint primary key,
  dispatched_at timestamptz not null default clock_timestamp()
);
alter table commerce_ops.worker_requests enable row level security;
alter table commerce_ops.worker_requests force row level security;
revoke all on commerce_ops.worker_requests from public, anon, authenticated, service_role;

create or replace function commerce_ops.dispatch_worker()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  project_url text;
  worker_secret text;
  request_id bigint;
begin
  select decrypted_secret into strict project_url from vault.decrypted_secrets
    where name = 'gesture_flow_project_url';
  select decrypted_secret into strict worker_secret from vault.decrypted_secrets
    where name = 'gesture_flow_cron_secret';
  if project_url !~ '^https://[a-z]{20}[.]supabase[.]co$'
    or length(worker_secret) < 32 then
    raise exception 'commerce_scheduler_configuration_invalid';
  end if;
  select net.http_post(
    url := project_url || '/functions/v1/stripe-worker',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || worker_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into request_id;
  insert into commerce_ops.worker_requests(request_id) values(request_id);
  delete from commerce_ops.worker_requests where dispatched_at < now() - interval '7 days';
  return request_id;
end; $$;
revoke all on function commerce_ops.dispatch_worker() from public, anon, authenticated, service_role;
-- Scheduling by a stable name replaces that job instead of adding duplicates.
select cron.schedule(:'job_name','* * * * *',
  'select commerce_ops.dispatch_worker();');
commit;
