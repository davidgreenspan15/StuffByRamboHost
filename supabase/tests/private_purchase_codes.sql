-- Synthetic fixtures only. Run by run_private_purchase_tests.py in a new
-- disposable cluster after private_purchase_codes_pre.sql and all migrations.
-- Never run against a hosted/project database.
\set ON_ERROR_STOP on

-- Migration effects on OTP-era state.
select public.test_assert((select count(*) = 2 from public.commerce_purchase_code_emails
  where status = 'superseded' and lease_token is null), 'OTP-era queue rows superseded, not sent');
select public.test_assert((select bool_and(device_limit = 1 and trial_device_limit = 2)
  from public.commerce_offers where code = 'gesture-flow-v3'), 'offer: one paid Mac, two trial Macs');
select public.test_assert((select bool_and(device_limit = 1) from public.commerce_entitlements
  where source = 'purchase'), 'existing purchase entitlements adopt one Mac');
select public.test_assert(to_regprocedure('public.commerce_authorize_purchase_challenge(uuid,text,uuid,text)') is null,
  'OTP authorization RPC removed');
select public.test_assert((select count(*) = 0 from public.commerce_claim_purchase_code_emails('test', array['legacy@example.test','legacy2@example.test'])), 'superseded rows are never claimed');

-- Helpers.
create function public.test_poll(n integer) returns text language sql immutable as $$
  select md5('poll-a'||n) || md5('poll-b'||n);
$$;
create function public.test_challenge(n integer, installation integer, key_char text)
returns void language sql as $$
  insert into public.commerce_device_activation_challenges(id,product_slug,edition,licensed_major,
    installation_id,device_public_key,code_hmac,poll_token_sha256,expires_at)
  values (public.test_id('70000000',n),'gesture-flow','python-mediapipe',3,
    public.test_id('80000000',installation),repeat(key_char,43),md5('code-a'||n)||md5('code-b'||n),
    public.test_poll(n),clock_timestamp()+interval '10 minutes');
$$;
create function public.test_redeem(ch integer, digest text,
  allowed text[] default array['buyer@example.test','second@example.test','third@example.test',
    'refund@example.test','live@example.test','race@example.test','legacy@example.test',
    'lost@example.test','multi@example.test','trialbuyer@example.test','trial@example.test'],
  env text default 'test')
returns text language sql as $$
  select outcome from public.commerce_redeem_purchase_code(env, public.test_id('70000000',ch),
    public.test_poll(ch), digest, allowed);
$$;
-- Simulates the worker: claim under a lease and issue the given digest.
create function public.test_issue(buyer text, digest text, env text default 'test')
returns text language plpgsql as $$
declare r record; result text := 'not_claimed';
begin
  for r in select * from public.commerce_claim_purchase_code_emails(env, array[buyer]) loop
    result := public.commerce_issue_purchase_activation_code(env, r.order_id, r.lease_token, digest);
    perform public.commerce_complete_purchase_code_email(r.order_id, r.lease_token,
      case when result = 'issued' then 'sent' else 'failed' end);
  end loop;
  return result;
end; $$;

-- New purchase: queued, one Mac, no Auth account yet.
select public.test_purchase(10, 'buyer@example.test');
select public.test_assert((select device_limit = 1 and account_id is null from public.commerce_entitlements
  where id = public.test_id('60000000',10)), 'new paid entitlement is one Mac, unclaimed');
select public.test_assert((select status = 'pending' from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',10)), 'purchase queued transactionally');
select public.test_assert((select count(*) = 0 from public.commerce_claim_purchase_code_emails('test', array['outsider@example.test'])), 'recipient allowlist enforced');
select public.test_assert(public.commerce_issue_purchase_activation_code('test', public.test_id('50000000',10), gen_random_uuid(), repeat('0',64)) = 'lease_lost', 'issuance requires lease');
select public.test_assert(public.test_issue('buyer@example.test', repeat('a',64)) = 'issued', 'code A issued');
select public.test_assert(public.test_issue('buyer@example.test', repeat('9',64)) = 'not_claimed', 'no duplicate send');

-- Resend before use rotates: A revoked, B issued.
select public.commerce_request_purchase_code_email('test', 'buyer@example.test');
select public.test_assert(public.test_issue('buyer@example.test', repeat('b',64)) = 'issued', 'code B issued');
select public.test_assert((select string_agg(status, ',' order by issued_at) from public.commerce_purchase_activation_codes
  where entitlement_id = public.test_id('60000000',10)) = 'revoked,issued', 'rotation revoked old code');

select public.test_challenge(1, 1, 'A');
select public.test_challenge(2, 2, 'B');
select public.test_challenge(3, 3, 'C');
update public.commerce_device_activation_challenges set created_at = clock_timestamp() - interval '20 minutes',
  expires_at = clock_timestamp() - interval '10 minutes' where id = public.test_id('70000000',3);
select public.test_assert(public.test_redeem(1, repeat('a',64)) = 'invalid_code', 'revoked code rejected');
select public.test_assert(public.test_redeem(1, repeat('e',64)) = 'invalid_code', 'unknown code rejected');
select public.test_assert(public.test_redeem(1, 'not-a-digest') = 'invalid_code', 'malformed digest rejected');
select public.test_assert(public.test_redeem(1, repeat('b',64), array['someone@example.test']) = 'invalid_code',
  'non-allowlisted purchase rejected');
select public.test_assert((select outcome = 'invalid' from public.commerce_redeem_purchase_code('test', public.test_id('70000000',1), repeat('f',64), repeat('b',64), array['buyer@example.test'])), 'wrong poll bearer');
select public.test_assert(public.test_redeem(3, repeat('b',64)) = 'expired', 'expired challenge');
select public.test_assert((select status = 'issued' from public.commerce_purchase_activation_codes
  where code_sha256 = repeat('b',64)), 'failed attempts do not consume the code');

-- Single use.
select public.test_assert(public.test_redeem(1, repeat('b',64)) = 'active', 'code B activates Mac 1');
select public.test_assert((select account_id is null and purchase_code_activation and status = 'active'
  from public.commerce_device_activations where challenge_id = public.test_id('70000000',1)),
  'activation without fabricated account');
select public.test_assert((select status = 'consumed' and challenge_id = public.test_id('70000000',1)
  and activation_id is not null from public.commerce_purchase_activation_codes where code_sha256 = repeat('b',64)),
  'code consumed and bound to challenge');
select public.test_assert((select status = 'consumed' and entitlement_id = public.test_id('60000000',10)
  from public.commerce_device_activation_challenges where id = public.test_id('70000000',1)), 'challenge consumed');
select public.test_assert((select outcome = 'active' and device_limit = 1 and entitlement_source = 'purchase'
  from public.commerce_redeem_purchase_code('test', public.test_id('70000000',1), public.test_poll(1), repeat('b',64),
  array['buyer@example.test'])), 'same challenge retry idempotent, permit limit 1');
select public.test_assert((select count(*) = 1 from public.commerce_device_activations
  where entitlement_id = public.test_id('60000000',10)), 'retry uses no extra slot');
select public.test_assert((select outcome = 'active' from public.commerce_exchange_activation(
  public.test_id('70000000',1), public.test_poll(1))), 'exchange of consumed code challenge is idempotent');
select public.test_assert(public.test_redeem(2, repeat('b',64)) = 'invalid_code', 'other challenge cannot reuse code');

-- Resend after use sends nothing; issuance refuses even with a forced lease.
select public.commerce_request_purchase_code_email('test', 'buyer@example.test');
select public.test_assert((select status = 'sent' from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',10)), 'used code is not re-queued');
update public.commerce_purchase_code_emails set status = 'sending',
  lease_token = '99999999-0000-4000-8000-000000000001' where order_id = public.test_id('50000000',10);
select public.test_assert(public.commerce_issue_purchase_activation_code('test', public.test_id('50000000',10),
  '99999999-0000-4000-8000-000000000001', repeat('8',64)) = 'already_used', 'no new code after use');
update public.commerce_purchase_code_emails set status = 'sent', lease_token = null
  where order_id = public.test_id('50000000',10);

-- Device limit 1: an already active Mac on the purchase blocks the code
-- without consuming it; explicit deactivation frees the slot.
select public.test_purchase(11, 'second@example.test');
select public.test_issue('second@example.test', repeat('c',64));
insert into public.commerce_device_activations(id,entitlement_id,account_id,challenge_id,installation_id,
  device_public_key,purchase_code_activation)
values (public.test_id('90000000',1),public.test_id('60000000',11),null,public.test_id('70000000',2),
  public.test_id('80000000',9),repeat('Z',43),true);
select public.test_challenge(4, 4, 'D');
select public.test_assert(public.test_redeem(4, repeat('c',64)) = 'device_limit', 'one Mac per purchase');
select public.test_assert((select status = 'issued' from public.commerce_purchase_activation_codes
  where code_sha256 = repeat('c',64)), 'device limit does not consume code');
select public.test_assert(public.commerce_deactivate_activation(public.test_id('90000000',1), null,
  'device', 'test'), 'explicit deactivation preserved');
select public.test_assert(public.test_redeem(4, repeat('c',64)) = 'active', 'freed slot activates');

-- Different public key for an active installation hard-fails; same key binds.
select public.test_purchase(12, 'third@example.test');
select public.test_issue('third@example.test', repeat('d',64));
select public.test_challenge(5, 5, 'E');
select public.test_challenge(6, 6, 'F');
insert into public.commerce_device_activations(entitlement_id,account_id,challenge_id,installation_id,
  device_public_key,purchase_code_activation)
values (public.test_id('60000000',12),null,public.test_id('70000000',6),public.test_id('80000000',5),
  repeat('K',43),true);
select public.test_assert(public.test_redeem(5, repeat('d',64)) = 'device_key_conflict', 'key takeover refused');
select public.test_assert((select device_public_key = repeat('K',43) from public.commerce_device_activations
  where installation_id = public.test_id('80000000',5)), 'active key unchanged');
select public.test_assert((select status = 'issued' from public.commerce_purchase_activation_codes
  where code_sha256 = repeat('d',64)), 'conflict does not consume code');
select public.test_challenge(7, 5, 'K');
select public.test_assert(public.test_redeem(7, repeat('d',64)) = 'active', 'same installation and key binds');
select public.test_assert((select status = 'issued' from public.commerce_purchase_activation_codes
  where code_sha256 = repeat('d',64)), 'Mac already active on this purchase does not consume the code');
select public.test_assert(public.test_redeem(7, repeat('d',64)) = 'active', 'same-key retry on that challenge');
select public.test_assert((select challenge_id = public.test_id('70000000',7) from public.commerce_device_activations
  where installation_id = public.test_id('80000000',5)), 'activation rebound to the new challenge');
select public.test_assert((select count(*) = 1 from public.commerce_device_activations
  where entitlement_id = public.test_id('60000000',12) and status = 'active'), 'no extra slot for same key');

-- Refunded entitlement rejects the code; wrong environment rejects the code.
select public.test_purchase(13, 'refund@example.test');
select public.test_issue('refund@example.test', repeat('1',64));
update public.commerce_entitlements set status = 'refunded' where id = public.test_id('60000000',13);
update public.commerce_orders set status = 'refunded' where id = public.test_id('50000000',13);
select public.test_challenge(8, 8, 'G');
select public.test_assert(public.test_redeem(8, repeat('1',64)) = 'invalid_code', 'refunded purchase rejected');
select public.commerce_request_purchase_code_email('test', 'refund@example.test');
select public.test_assert(public.test_issue('refund@example.test', repeat('2',64)) = 'not_claimed',
  'refunded purchase is not emailed');
select public.test_purchase(14, 'live@example.test', 'live');
select public.test_assert((select count(*) = 0 from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',14)), 'live purchase never queued');
insert into public.commerce_purchase_activation_codes(entitlement_id, code_sha256)
  values (public.test_id('60000000',14), repeat('3',64));
select public.test_assert(public.test_redeem(8, repeat('3',64)) = 'invalid_code', 'live environment rejected');

-- Legacy buyer recovers by explicit resend under the new scheme.
select public.commerce_request_purchase_code_email('test', 'legacy@example.test');
select public.test_assert(public.test_issue('legacy@example.test', repeat('4',64)) = 'issued',
  'superseded row recoverable by resend');

-- Trial path still works and keeps two Macs.
insert into auth.users(id,email,email_confirmed_at)
  values ('10000000-0000-4000-8000-000000000009','trial@example.test',clock_timestamp());
select public.test_challenge(9, 10, 'T');
select public.test_assert((select outcome = 'approved' and trial_started and entitlement_type = 'trial'
  from public.commerce_approve_activation('10000000-0000-4000-8000-000000000009',
    md5('code-a'||9)||md5('code-b'||9), 'test', '20000000-0000-4000-8000-000000000001', true, true, null, null)),
  'trial approval');
select public.test_assert((select device_limit = 2 from public.commerce_entitlements
  where source = 'trial' and account_id = '10000000-0000-4000-8000-000000000009'), 'trial keeps two Macs');
select public.test_assert((select outcome = 'active' and device_limit = 2 and entitlement_source = 'trial'
  from public.commerce_exchange_activation(public.test_id('70000000',9), public.test_poll(9))), 'trial exchange');

-- Later portal sign-in claims the purchase and its code-activated Mac.
insert into auth.users(id,email,email_confirmed_at)
  values ('10000000-0000-4000-8000-000000000001','buyer@example.test',clock_timestamp());
select public.test_assert((select account_id = '10000000-0000-4000-8000-000000000001'
  from public.commerce_device_activations where challenge_id = public.test_id('70000000',1)),
  'claim attaches activation to verified account');
select public.commerce_claim_account_entitlements('10000000-0000-4000-8000-000000000001');

-- P1-2: lost response after the original challenge expired. The same Mac
-- (installation and key) with a NEW valid challenge gets its activation back.
select public.test_purchase(16, 'lost@example.test');
select public.test_issue('lost@example.test', repeat('6',64));
select public.test_challenge(30, 30, 'L');
select public.test_assert(public.test_redeem(30, repeat('6',64)) = 'active', 'lost: first activation');
update public.commerce_device_activation_challenges set created_at = clock_timestamp() - interval '20 minutes',
  expires_at = clock_timestamp() - interval '10 minutes' where id = public.test_id('70000000',30);
select public.test_challenge(31, 30, 'L');
select public.test_assert((select outcome = 'active' and activation_id = (select a.id from public.commerce_device_activations a
  where a.installation_id = public.test_id('80000000',30)) from public.commerce_redeem_purchase_code('test', public.test_id('70000000',31), public.test_poll(31), repeat('6',64), array['lost@example.test'])),
  'lost response recovered with a new challenge');
select public.test_assert((select status = 'consumed' from public.commerce_device_activation_challenges
  where id = public.test_id('70000000',31)), 'new challenge consumed');
select public.test_assert((select count(*) = 1 from public.commerce_device_activations
  where entitlement_id = public.test_id('60000000',16)), 'recovery uses no extra slot');
select public.test_challenge(32, 30, 'M');
select public.test_assert(public.test_redeem(32, repeat('6',64)) = 'invalid_code', 'same installation, other key rejected');
select public.test_challenge(33, 33, 'L');
select public.test_assert(public.test_redeem(33, repeat('6',64)) = 'invalid_code', 'other installation rejected');
select public.test_challenge(34, 30, 'L');
update public.commerce_device_activation_challenges set created_at = clock_timestamp() - interval '20 minutes',
  expires_at = clock_timestamp() - interval '10 minutes' where id = public.test_id('70000000',34);
select public.test_assert(public.test_redeem(34, repeat('6',64)) = 'expired', 'expired new challenge stays expired');

-- P2-2: two purchases by one email each get their own email and code.
create function public.test_digest(order_id uuid, round integer) returns text language sql immutable as $$
  select md5(order_id::text || round) || md5(round || order_id::text);
$$;
create function public.test_issue_all(buyer text, round integer) returns integer language plpgsql as $$
declare r record; n integer := 0;
begin
  for r in select * from public.commerce_claim_purchase_code_emails('test', array[buyer]) loop
    if public.commerce_issue_purchase_activation_code('test', r.order_id, r.lease_token,
      public.test_digest(r.order_id, round)) = 'issued' then n := n + 1; end if;
    perform public.commerce_complete_purchase_code_email(r.order_id, r.lease_token, 'sent');
  end loop;
  return n;
end; $$;
select public.test_purchase(17, 'multi@example.test');
select public.test_purchase(18, 'multi@example.test');
select public.test_assert(public.test_issue_all('multi@example.test', 1) = 2, 'each purchase emailed');
select public.commerce_request_purchase_code_email('test', 'multi@example.test');
select public.test_assert(public.test_issue_all('multi@example.test', 2) = 2, 'resend rotates every unused code');
select public.test_assert((select count(*) = 2 from public.commerce_purchase_activation_codes pc
  join public.commerce_entitlements e on e.id = pc.entitlement_id
  where e.claimed_email = 'multi@example.test' and pc.status = 'revoked'), 'old codes revoked');
select public.test_challenge(40, 40, 'N');
select public.test_assert(public.test_redeem(40, public.test_digest(public.test_id('50000000',17), 2)) = 'active',
  'first purchase activates its Mac');
select public.commerce_request_purchase_code_email('test', 'multi@example.test');
select public.test_assert(public.test_issue_all('multi@example.test', 3) = 1, 'resend skips the used purchase');
-- P3-a: second purchase's code on a Mac already covered by the first.
select public.test_challenge(41, 40, 'N');
select public.test_assert(public.test_redeem(41, public.test_digest(public.test_id('50000000',18), 3)) = 'already_activated',
  'Mac already covered by another purchase');
select public.test_assert((select status = 'issued' from public.commerce_purchase_activation_codes
  where code_sha256 = public.test_digest(public.test_id('50000000',18), 3)), 'already_activated does not consume');
select public.test_assert(public.test_redeem(41, repeat('7',64)) = 'invalid_code', 'unknown code stays generic');

-- P1-1: trial upgrade at fulfillment moves at most one Mac to the purchase.
insert into auth.users(id,email,email_confirmed_at)
  values ('10000000-0000-4000-8000-000000000020','trialbuyer@example.test',clock_timestamp());
select public.test_challenge(50, 50, 'P');
select public.test_challenge(51, 51, 'Q');
select public.test_assert((select bool_and(o.outcome = 'approved') from (
  select (public.commerce_approve_activation('10000000-0000-4000-8000-000000000020',
    md5('code-a'||n)||md5('code-b'||n), 'test', '20000000-0000-4000-8000-000000000001', true, true, null, null)).outcome
  from generate_series(50,51) n) o), 'two trial Macs approved');
select public.test_assert((select count(*) = 2 from generate_series(50,51) n,
  public.commerce_exchange_activation(public.test_id('70000000',n), public.test_poll(n)) x where x.outcome = 'active'),
  'two trial Macs active');
update public.commerce_device_activations set last_seen_at = clock_timestamp() - interval '1 day'
  where installation_id = public.test_id('80000000',50);
insert into public.commerce_checkout_intents(id,environment,offer_id,offer_snapshot,policy_set_id,idempotency_key,
  request_sha256,stripe_checkout_session_id)
values (public.test_id('40000000',19),'test','30000000-0000-4000-8000-000000000001',
  '{"billingModel":"one_time","currency":"usd","unitAmount":1400,"product":"gesture-flow","edition":"python-mediapipe","licensedMajor":3,"deviceLimit":2,"features":["gesture-control"]}',
  '20000000-0000-4000-8000-000000000001','private-test-intent-19',repeat('a',64),'cs_test_trial_upgrade');
select public.test_assert((select outcome = 'fulfilled' from public.commerce_fulfill_paid_checkout('test',
  public.test_id('40000000',19),'cs_test_trial_upgrade','pi_test_trial_upgrade',null,'trialbuyer@example.test',
  'usd',1400,1400,0,0,null,null,clock_timestamp())), 'purchase fulfilled');
select public.test_assert((select e.device_limit = 1 from public.commerce_entitlements e
  join public.commerce_orders o on o.id = e.order_id where o.stripe_checkout_session_id = 'cs_test_trial_upgrade'),
  'stale two-Mac snapshot still yields one paid Mac');
select public.test_assert((select count(*) = 1 from public.commerce_device_activations a
  join public.commerce_entitlements e on e.id = a.entitlement_id
  where e.source = 'purchase' and e.claimed_email = 'trialbuyer@example.test' and a.status = 'active'
    and a.installation_id = public.test_id('80000000',51)), 'most recent trial Mac moved to purchase');
select public.test_assert((select status = 'deactivated' and deactivation_reason = 'trial_upgrade_over_limit'
  from public.commerce_device_activations where installation_id = public.test_id('80000000',50)),
  'other trial Mac deactivated');
select public.test_assert(public.test_issue('trialbuyer@example.test', repeat('c',63)||'d') = 'issued', 'upgrade buyer code');
select public.test_challenge(52, 51, 'Q');
select public.test_assert(public.test_redeem(52, repeat('c',63)||'d') = 'active', 'code on the moved Mac returns it');
select public.test_assert((select status = 'issued' from public.commerce_purchase_activation_codes
  where code_sha256 = repeat('c',63)||'d'), 'moved Mac does not consume the code');
select public.test_challenge(53, 50, 'P');
select public.test_assert(public.test_redeem(53, repeat('c',63)||'d') = 'device_limit', 'second Mac blocked by one-Mac limit');

-- P3-b: a Mac with an active trial redeems a purchase code; its trial row is
-- deactivated in the same transaction.
select public.test_purchase(20, 'trial@example.test');
select public.test_issue('trial@example.test', repeat('d',63)||'e');
select public.test_challenge(60, 10, 'T');
select public.test_assert(public.test_redeem(60, repeat('d',63)||'e') = 'active', 'trial Mac upgraded by code');
select public.test_assert((select a.status = 'deactivated' and a.deactivation_reason = 'upgraded_to_purchase'
  from public.commerce_device_activations a join public.commerce_entitlements e on e.id = a.entitlement_id
  where e.source = 'trial' and a.installation_id = public.test_id('80000000',10)), 'trial activation deactivated');

-- Race fixture for the runner: one issued code, two pending challenges.
select public.test_purchase(15, 'race@example.test');
select public.test_issue('race@example.test', repeat('5',64));
select public.test_challenge(20, 20, 'R');
select public.test_challenge(21, 21, 'S');

-- Production (live) mode and the environment contract, 202610260003.
select public.test_assert((select not live_enabled from public.commerce_purchase_code_settings),
  'live gate defaults off');
create function public.test_raises(statement text) returns boolean language plpgsql as $$
begin execute statement; return false;
exception when others then return sqlerrm = 'invalid_purchase_code_environment'; end; $$;
select public.test_assert(public.test_raises($q$select public.commerce_request_purchase_code_email(null, 'buyer@example.test')$q$),
  'missing environment fails closed (resend)');
select public.test_assert(public.test_raises($q$select * from public.commerce_claim_purchase_code_emails('prod', null)$q$),
  'invalid environment fails closed (claim)');
select public.test_assert(public.test_raises($q$select public.commerce_issue_purchase_activation_code('', gen_random_uuid(), gen_random_uuid(), repeat('0',64))$q$),
  'invalid environment fails closed (issue)');
select public.test_assert(public.test_raises($q$select * from public.commerce_redeem_purchase_code('LIVE', gen_random_uuid(), repeat('0',64), repeat('0',64), null)$q$),
  'invalid environment fails closed (redeem)');
select public.test_assert(to_regprocedure('public.commerce_redeem_purchase_code(uuid,text,text,text[],timestamptz)') is null
  and to_regprocedure('public.commerce_claim_purchase_code_emails(text[])') is null
  and to_regprocedure('public.commerce_issue_purchase_activation_code(uuid,uuid,text)') is null
  and to_regprocedure('public.commerce_request_purchase_code_email(text)') is null
  and to_regprocedure('public.commerce_private_purchase_email(text)') is null
  and to_regprocedure('public.commerce_purchase_code_entitlement_eligible(uuid,timestamptz)') is null,
  'no environment-blind legacy signature remains');

-- Gate off: live purchases are not queued, resent or redeemable.
select public.test_purchase(90, 'golive@example.test', 'live');
select public.test_assert((select count(*) = 0 from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',90)), 'live purchase not queued while gate off');
insert into public.commerce_purchase_activation_codes(entitlement_id, code_sha256)
  values (public.test_id('60000000',90), md5('live-a')||md5('live-b'));
select public.test_challenge(90, 90, 'L');
select public.test_assert(public.test_redeem(90, md5('live-a')||md5('live-b'), null, 'live') = 'invalid_code',
  'live code rejected while gate off');
select public.commerce_request_purchase_code_email('live', 'golive@example.test');
select public.test_assert((select count(*) = 0 from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',90)), 'live resend inert while gate off');

-- Gate on: live caller, any buyer, one Mac, single use, no trial.
update public.commerce_purchase_code_settings set live_enabled = true, updated_at = clock_timestamp();
select public.test_assert(public.test_redeem(90, md5('live-a')||md5('live-b'), null, 'test') = 'invalid_code',
  'test caller cannot redeem a live code (gate on, null filter)');
select public.test_assert(public.test_redeem(90, md5('live-a')||md5('live-b'), array['golive@example.test'], 'test') = 'invalid_code',
  'test caller cannot redeem a live code (gate on, allowlisted email)');
select public.test_assert((select status = 'issued' from public.commerce_purchase_activation_codes
  where code_sha256 = md5('live-a')||md5('live-b')), 'cross-environment attempts leave the live code unused');
select public.test_assert(public.test_redeem(90, md5('live-a')||md5('live-b'), null, 'live') = 'active',
  'live code redeems for any buyer once gated on');
select public.test_assert((select device_limit = 1 from public.commerce_entitlements
  where id = public.test_id('60000000',90)), 'live purchase is one Mac');
select public.test_challenge(91, 91, 'M');
select public.test_assert(public.test_redeem(91, md5('live-a')||md5('live-b'), null, 'live') = 'invalid_code',
  'live code is single use');
select public.test_assert((select count(*) = 0 from public.commerce_entitlements e
  where e.source = 'trial' and e.claimed_email = 'golive@example.test'), 'no trial created for live buyer');

-- Same email owns a test purchase (95) and a live purchase (96), gate on.
select public.test_purchase(95, 'shared@example.test');
select public.test_purchase(96, 'shared@example.test', 'live');
select public.test_assert((select count(*) = 2 and bool_and(status = 'pending') from public.commerce_purchase_code_emails
  where order_id in (public.test_id('50000000',95), public.test_id('50000000',96))), 'both purchases queued');
-- Each caller claims only its own environment's row, even with a matching list.
create temporary table test_claim as
  select * from public.commerce_claim_purchase_code_emails('test', array['shared@example.test']);
select public.test_assert((select count(*) = 1 and bool_and(order_id = public.test_id('50000000',95)) from test_claim),
  'test claim never returns the live order for the same email');
create temporary table live_claim as
  select * from public.commerce_claim_purchase_code_emails('live', null);
select public.test_assert((select count(*) = 1 and bool_and(order_id = public.test_id('50000000',96)) from live_claim),
  'live claim never returns the test order for the same email');
-- Issuing with a valid lease but the wrong environment touches nothing.
select public.test_assert(public.commerce_issue_purchase_activation_code('test',
  (select order_id from live_claim), (select lease_token from live_claim), md5('x-a')||md5('x-b')) = 'not_eligible',
  'test caller cannot issue for a live order');
select public.test_assert(public.commerce_issue_purchase_activation_code('live',
  (select order_id from test_claim), (select lease_token from test_claim), md5('x-c')||md5('x-d')) = 'not_eligible',
  'live caller cannot issue for a test order');
select public.test_assert((select count(*) = 0 from public.commerce_purchase_activation_codes
  where code_sha256 in (md5('x-a')||md5('x-b'), md5('x-c')||md5('x-d'))), 'no cross-environment code row written');
select public.test_assert(public.commerce_issue_purchase_activation_code('test',
  (select order_id from test_claim), (select lease_token from test_claim), md5('s-t')||md5('s-u')) = 'issued',
  'test code issued for test order');
select public.test_assert(public.commerce_issue_purchase_activation_code('live',
  (select order_id from live_claim), (select lease_token from live_claim), md5('s-l')||md5('s-m')) = 'issued',
  'live code issued for live order');
select public.commerce_complete_purchase_code_email(order_id, lease_token, 'sent') from test_claim;
select public.commerce_complete_purchase_code_email(order_id, lease_token, 'sent') from live_claim;
-- Resend re-queues only the caller's environment.
select public.commerce_request_purchase_code_email('test', 'shared@example.test');
select public.test_assert((select status from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',96)) = 'sent', 'test resend does not re-queue the live order');
select public.test_assert((select status from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',95)) = 'pending', 'test resend re-queues the test order');
update public.commerce_purchase_code_emails set status = 'sent' where order_id = public.test_id('50000000',95);
select public.commerce_request_purchase_code_email('live', 'shared@example.test');
select public.test_assert((select status from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',95)) = 'sent', 'live resend does not re-queue the test order');
select public.test_assert((select status from public.commerce_purchase_code_emails
  where order_id = public.test_id('50000000',96)) = 'pending', 'live resend re-queues the live order');
update public.commerce_purchase_code_emails set status = 'sent' where order_id = public.test_id('50000000',96);
-- Cross-environment redemption of the same email's codes fails generically.
select public.test_challenge(95, 95, 'Q');
select public.test_assert(public.test_redeem(95, md5('s-l')||md5('s-m'), array['shared@example.test'], 'test') = 'invalid_code',
  'test caller cannot redeem the same email''s live code');
select public.test_assert(public.test_redeem(95, md5('s-t')||md5('s-u'), null, 'live') = 'invalid_code',
  'live caller cannot redeem the same email''s test code (null filter)');
select public.test_assert(public.test_redeem(95, md5('s-t')||md5('s-u'), array['shared@example.test'], 'live') = 'invalid_code',
  'live caller cannot redeem the same email''s test code (canary list)');
select public.test_assert((select bool_and(status = 'issued') from public.commerce_purchase_activation_codes
  where code_sha256 in (md5('s-l')||md5('s-m'), md5('s-t')||md5('s-u'))), 'both codes still unused');
select public.test_assert(public.test_redeem(95, md5('s-t')||md5('s-u'), null, 'test') = 'invalid_code',
  'test purchase still needs its allowlist');
select public.test_assert(public.test_redeem(95, md5('s-t')||md5('s-u'), array['shared@example.test'], 'test') = 'active',
  'test code redeems in test with its allowlist');

-- Canary limits live claims; refund and gate-off still reject live codes.
select public.test_purchase(94, 'livebuyer@example.test', 'live');
select public.test_assert((select count(*) = 0 from public.commerce_claim_purchase_code_emails('live',
  array['canary@example.test'])), 'live canary excludes other buyers');
select public.test_assert(public.test_issue('livebuyer@example.test', md5('live-e')||md5('live-f'), 'live') = 'issued',
  'live worker issues under lease');
update public.commerce_entitlements set status = 'refunded' where id = public.test_id('60000000',94);
select public.test_challenge(94, 94, 'P');
select public.test_assert(public.test_redeem(94, md5('live-e')||md5('live-f'), null, 'live') = 'invalid_code',
  'refunded live purchase rejected');
update public.commerce_entitlements set status = 'active' where id = public.test_id('60000000',94);
update public.commerce_purchase_code_settings set live_enabled = false;
select public.test_assert(public.test_redeem(94, md5('live-e')||md5('live-f'), null, 'live') = 'invalid_code',
  'gate off stops live redemption');
select public.test_assert(not has_table_privilege('service_role','public.commerce_purchase_code_settings','UPDATE'),
  'edge service role cannot flip the live gate');
select public.test_assert(not has_table_privilege('anon','public.commerce_purchase_code_settings','SELECT'),
  'browser cannot read the live gate');
select public.test_assert(not has_function_privilege('anon',
  'public.commerce_purchase_code_recipient_allowed(text,text,text[])','EXECUTE'), 'anon cannot probe recipients');

-- Least privilege.
select public.test_assert(not has_function_privilege('anon',
  'public.commerce_redeem_purchase_code(text,uuid,text,text,text[],timestamptz)','EXECUTE'), 'anon cannot redeem');
select public.test_assert(not has_function_privilege('authenticated',
  'public.commerce_issue_purchase_activation_code(text,uuid,uuid,text)','EXECUTE'), 'browser cannot issue');
select public.test_assert(not has_function_privilege('public',
  'public.commerce_purchase_code_entitlement_eligible(text,uuid,timestamptz)','EXECUTE'), 'public cannot probe');
select public.test_assert(not has_table_privilege('authenticated','public.commerce_purchase_activation_codes','SELECT'),
  'browser cannot read codes');
select public.test_assert(not has_table_privilege('anon','public.commerce_purchase_code_emails','SELECT'),
  'browser cannot read queue');
select public.test_assert(has_function_privilege('service_role',
  'public.commerce_redeem_purchase_code(text,uuid,text,text,text[],timestamptz)','EXECUTE'), 'service can redeem');
