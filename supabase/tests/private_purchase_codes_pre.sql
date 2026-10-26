-- Synthetic OTP-era state, applied BEFORE 202610260002 by the disposable
-- runner only. Never run against a hosted/project database.
\set ON_ERROR_STOP on
create function public.test_assert(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'assertion failed: %',message; end if; end; $$;

create function public.test_id(prefix text, n integer) returns uuid language sql immutable as $$
  select (prefix || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
$$;

-- One paid order + purchase entitlement. The queue trigger enqueues test ones.
create function public.test_purchase(n integer, buyer text, env text default 'test')
returns uuid language plpgsql as $$
declare offer uuid := case env when 'test' then '30000000-0000-4000-8000-000000000001'::uuid
                               else '30000000-0000-4000-8000-000000000002'::uuid end;
begin
  insert into public.commerce_checkout_intents(id,environment,offer_id,offer_snapshot,policy_set_id,idempotency_key,request_sha256)
  values (public.test_id('40000000',n),env,offer,'{}','20000000-0000-4000-8000-000000000001',
          'private-test-intent-'||n,repeat('a',64));
  insert into public.commerce_orders(id,environment,claimed_email,checkout_intent_id,offer_id,policy_set_id,stripe_checkout_session_id,currency,amount_total,amount_subtotal,offer_snapshot,policy_snapshot,paid_at,refund_eligible_until)
  values (public.test_id('50000000',n),env,buyer,public.test_id('40000000',n),offer,
          '20000000-0000-4000-8000-000000000001','cs_test_private_synthetic_'||n,'usd',1400,1400,'{}','{}',
          clock_timestamp(),clock_timestamp()+interval '14 days');
  insert into public.commerce_entitlements(id,claimed_email,order_id,source,product_slug,edition,licensed_major,device_limit)
  values (public.test_id('60000000',n),buyer,public.test_id('50000000',n),'purchase','gesture-flow','python-mediapipe',3,2);
  return public.test_id('60000000',n);
end; $$;

-- Simulate the old seed (two Macs) and two queued OTP emails: one pending and
-- one mid-send by an old worker.
update public.commerce_offers set device_limit = 2 where code = 'gesture-flow-v3';
select public.test_purchase(1, 'legacy@example.test');
select public.test_purchase(2, 'legacy2@example.test');
update public.commerce_purchase_code_emails set status = 'sending',
  lease_token = gen_random_uuid(), attempted_at = clock_timestamp()
  where order_id = public.test_id('50000000', 2);
select public.test_assert((select count(*) = 2 from public.commerce_purchase_code_emails
  where status in ('pending', 'sending')), 'OTP-era rows queued before migration');
