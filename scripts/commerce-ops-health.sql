-- Read-only aggregate evidence; never return headers, tokens or customer data.
with recent_responses as (
  select q.dispatched_at, r.status_code, r.timed_out,
    case when r.status_code = 200 then r.content::jsonb else null end as result
  from commerce_ops.worker_requests q
  left join net._http_response r on r.id = q.request_id
  where q.dispatched_at > now() - interval '6 hours'
), successful as (
  select max(dispatched_at) as last_success from recent_responses
  where status_code = 200 and not coalesce(timed_out,true)
    and result->>'code' is null
    and (result->>'failed')::integer = 0
    and (result->>'leaseLost')::integer = 0
    and jsonb_typeof(result->'retention') = 'object'
    and coalesce((result->'purchaseEmails'->>'failed')::integer,0) = 0
    and coalesce((result->'purchaseEmails'->>'uncertain')::integer,0) = 0
    and coalesce((result->'purchaseEmails'->>'completionFailed')::integer,0) = 0
)
select jsonb_build_object(
  'checkedAt', clock_timestamp(),
  'schedulerActive', (select count(*) = 1 from cron.job
    where jobname = :'job_name' and active and schedule = '* * * * *'),
  'lastSuccessAgeSeconds', (select extract(epoch from now()-last_success)::integer from successful),
  'lastDispatchAgeSeconds', (select extract(epoch from now()-max(dispatched_at))::integer
    from commerce_ops.worker_requests),
  'deadLetters', (select count(*) from public.commerce_stripe_events where status = 'dead_letter'),
  'staleLeases', (select count(*) from public.commerce_stripe_events
    where status = 'processing' and locked_at < now()-interval '5 minutes'),
  'oldPendingEvents', (select count(*) from public.commerce_stripe_events
    where status in ('received','failed') and received_at < now()-interval '5 minutes'),
  'uncertainEmails', (select count(*) from public.commerce_purchase_code_emails
    where status in ('failed','uncertain')),
  'oldPendingEmails', (select count(*) from public.commerce_purchase_code_emails
    where status = 'pending' and created_at < now()-interval '5 minutes'),
  'staleEmailLeases', (select count(*) from public.commerce_purchase_code_emails
    where status = 'sending' and attempted_at < now()-interval '5 minutes')
);
