\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(condition boolean, message text)
returns void
language plpgsql
as $$
begin
  if condition is not true then raise exception 'assertion_failed: %', message; end if;
end;
$$;

select pg_temp.assert_true(
  (select count(*) = 20 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'commerce_%'
      and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity),
  'every commerce table must force RLS'
);
select pg_temp.assert_true(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'commerce_%' and c.relkind = 'r'
      and (
        has_table_privilege('anon', c.oid, 'SELECT')
        or has_table_privilege('anon', c.oid, 'INSERT')
        or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE')
        or has_table_privilege('authenticated', c.oid, 'SELECT')
        or has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE')
        or has_table_privilege('authenticated', c.oid, 'DELETE')
      )
  ),
  'browser roles must not read or mutate any commerce table directly'
);
select pg_temp.assert_true(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'commerce_%'
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  ),
  'browser roles must not invoke any commerce function directly'
);

insert into auth.users (id, email) values
  ('40000000-0000-4000-8000-000000000001', 'buyer@example.test'),
  ('40000000-0000-4000-8000-000000000002', 'other@example.test');

do $$
begin
  begin
    update auth.users set email = 'moved@example.test'
      where id = '40000000-0000-4000-8000-000000000001';
    raise exception 'auth email change unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'auth email change unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'commerce_account_email_is_immutable' then raise; end if;
  end;
  begin
    update public.commerce_accounts set email = 'moved@example.test'
      where id = '40000000-0000-4000-8000-000000000001';
    raise exception 'commerce email change unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'commerce email change unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'commerce_account_email_is_immutable' then raise; end if;
  end;
end;
$$;
select pg_temp.assert_true(
  (select email = 'buyer@example.test' from public.commerce_accounts
    where id = '40000000-0000-4000-8000-000000000001'),
  'v1 account email must remain bound to the verified purchase identity'
);

-- The seeded offer is safe-by-default but still supplies trial policy/features.
select pg_temp.assert_true(
  (select not checkout_enabled and stripe_price_id is null and published_at is null
    from public.commerce_offers where code = 'gesture-flow-v3' and environment = 'test'),
  'seeded offer must remain unpublished without a real Stripe price'
);

insert into public.commerce_device_activation_challenges (
  id, product_slug, edition, licensed_major, installation_id, device_public_key,
  code_hmac, poll_token_sha256, expires_at
) values
  ('50000000-0000-4000-8000-000000000001', 'gesture-flow', 'python-mediapipe', 3,
    '60000000-0000-4000-8000-000000000001', repeat('A', 43), repeat('a', 64),
    repeat('1', 64), clock_timestamp() + interval '10 minutes'),
  ('50000000-0000-4000-8000-000000000002', 'gesture-flow', 'python-mediapipe', 3,
    '60000000-0000-4000-8000-000000000002', repeat('B', 43), repeat('b', 64),
    repeat('2', 64), clock_timestamp() + interval '10 minutes'),
  ('50000000-0000-4000-8000-000000000003', 'gesture-flow', 'python-mediapipe', 3,
    '60000000-0000-4000-8000-000000000003', repeat('C', 43), repeat('c', 64),
    repeat('3', 64), clock_timestamp() + interval '10 minutes');

select pg_temp.assert_true(
  (select outcome = 'approved' and trial_started
    from public.commerce_approve_activation(
      '40000000-0000-4000-8000-000000000001', repeat('a', 64), 'test',
      '20000000-0000-4000-8000-000000000001', true, true,
      repeat('d', 64), repeat('e', 64), clock_timestamp()
    )),
  'first approval must start the account trial'
);
select pg_temp.assert_true(
  (select source = 'trial' and features ? 'gesture-control' and device_limit = 2
    from public.commerce_entitlements
    where account_id = '40000000-0000-4000-8000-000000000001' and source = 'trial'),
  'trial must carry core feature and two-device limit'
);
select pg_temp.assert_true(
  (select outcome = 'active' from public.commerce_exchange_activation(
    '50000000-0000-4000-8000-000000000001', repeat('1', 64), clock_timestamp()
  )),
  'first Mac must activate'
);

select pg_temp.assert_true(
  public.commerce_deactivate_activation(
    (select id from public.commerce_device_activations
      where challenge_id = '50000000-0000-4000-8000-000000000001'),
    '40000000-0000-4000-8000-000000000001', 'customer', 'replay-test',
    clock_timestamp()
  ),
  'the first Mac must deactivate'
);
select pg_temp.assert_true(
  (select outcome = 'denied' from public.commerce_exchange_activation(
    '50000000-0000-4000-8000-000000000001', repeat('1', 64), clock_timestamp()
  )),
  'a consumed poll token must never reactivate a deactivated Mac'
);
insert into public.commerce_device_activation_challenges (
  id, product_slug, edition, licensed_major, installation_id, device_public_key,
  code_hmac, poll_token_sha256, expires_at
) values (
  '50000000-0000-4000-8000-000000000010', 'gesture-flow', 'python-mediapipe', 3,
  '60000000-0000-4000-8000-000000000001', repeat('Z', 43), repeat('9', 64),
  repeat('0', 64), clock_timestamp() + interval '10 minutes'
);
select pg_temp.assert_true(
  (select outcome = 'approved' from public.commerce_approve_activation(
    '40000000-0000-4000-8000-000000000001', repeat('9', 64), 'test',
    '20000000-0000-4000-8000-000000000001', true, true,
    repeat('d', 64), repeat('e', 64), clock_timestamp()
  )),
  'a fresh account-approved challenge may reactivate the Mac'
);
select pg_temp.assert_true(
  (select outcome = 'active' from public.commerce_exchange_activation(
    '50000000-0000-4000-8000-000000000010', repeat('0', 64), clock_timestamp()
  )),
  'the fresh challenge must reactivate the Mac'
);

select pg_temp.assert_true(
  (select outcome = 'approved' and not trial_started
    from public.commerce_approve_activation(
      '40000000-0000-4000-8000-000000000001', repeat('b', 64), 'test',
      '20000000-0000-4000-8000-000000000001', true, true,
      repeat('d', 64), repeat('e', 64), clock_timestamp()
    )),
  'second approval must reuse the one account trial'
);
select pg_temp.assert_true(
  (select outcome = 'active' from public.commerce_exchange_activation(
    '50000000-0000-4000-8000-000000000002', repeat('2', 64), clock_timestamp()
  )),
  'second Mac must activate'
);
select pg_temp.assert_true(
  (select outcome = 'approved' from public.commerce_approve_activation(
    '40000000-0000-4000-8000-000000000001', repeat('c', 64), 'test',
    '20000000-0000-4000-8000-000000000001', true, true,
    repeat('d', 64), repeat('e', 64), clock_timestamp()
  )),
  'third challenge may be approved before the transactional device count'
);
select pg_temp.assert_true(
  (select outcome = 'device_limit' from public.commerce_exchange_activation(
    '50000000-0000-4000-8000-000000000003', repeat('3', 64), clock_timestamp()
  )),
  'third Mac must be rejected under the entitlement lock'
);
select pg_temp.assert_true(
  (select outcome = 'expired' from public.commerce_exchange_activation(
    '50000000-0000-4000-8000-000000000001', repeat('1', 64),
    clock_timestamp() + interval '11 minutes'
  )),
  'consumed poll bearer must not mint after challenge expiry'
);

-- Published policy evidence is immutable; policy sets allow only one-way retirement.
do $$
begin
  begin
    update public.commerce_policy_documents set sha256 = repeat('0', 64)
      where id = '10000000-0000-4000-8000-000000000001';
    raise exception 'published policy document mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'published policy document mutation unexpectedly succeeded' then raise; end if;
  end;
end;
$$;
do $$
begin
  begin
    insert into public.commerce_policy_sets (
      id, version, terms_document_id, eula_document_id, privacy_document_id,
      refund_document_id, compatibility_document_id
    ) values (
      '20000000-0000-4000-8000-000000000098', 'wrong-document-slot-v1',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000005'
    );
    raise exception 'wrong policy document slot unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'wrong policy document slot unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'policy_set_document_type_mismatch' then raise; end if;
  end;
end;
$$;
insert into public.commerce_policy_sets (
  id, version, terms_document_id, eula_document_id, privacy_document_id,
  refund_document_id, compatibility_document_id, published_at
) select
  '20000000-0000-4000-8000-000000000099', 'retirement-test-v1',
  terms_document_id, eula_document_id, privacy_document_id, refund_document_id,
  compatibility_document_id, greatest(published_at, clock_timestamp() - interval '1 minute')
from public.commerce_policy_sets where id = '20000000-0000-4000-8000-000000000001';
update public.commerce_policy_sets set retired_at = clock_timestamp()
  where id = '20000000-0000-4000-8000-000000000099';
do $$
begin
  begin
    update public.commerce_policy_sets set version = 'mutated'
      where id = '20000000-0000-4000-8000-000000000099';
    raise exception 'published policy set mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'published policy set mutation unexpectedly succeeded' then raise; end if;
  end;
end;
$$;

update public.commerce_offers
  set current_policy_set_id = '20000000-0000-4000-8000-000000000099'
  where code = 'gesture-flow-v3' and environment = 'test';
insert into public.commerce_device_activation_challenges (
  id, product_slug, edition, licensed_major, installation_id, device_public_key,
  code_hmac, poll_token_sha256, expires_at
) values (
  '50000000-0000-4000-8000-000000000011', 'gesture-flow', 'python-mediapipe', 3,
  '60000000-0000-4000-8000-000000000011', repeat('Y', 43), repeat('8', 64),
  repeat('7', 64), clock_timestamp() + interval '10 minutes'
);
select pg_temp.assert_true(
  (select outcome = 'invalid_policy_set' from public.commerce_approve_activation(
    '40000000-0000-4000-8000-000000000001', repeat('8', 64), 'test',
    '20000000-0000-4000-8000-000000000099', true, true,
    repeat('d', 64), repeat('e', 64), clock_timestamp()
  )),
  'retired policy sets must be rejected by the activation transaction'
);
update public.commerce_offers
  set current_policy_set_id = '20000000-0000-4000-8000-000000000001'
  where code = 'gesture-flow-v3' and environment = 'test';

-- Configure only the disposable test offer, then snapshot it atomically.
update public.commerce_offers set
  stripe_product_id = 'prod_test_original', stripe_price_id = 'price_test_original',
  unit_amount = 2900, published_at = clock_timestamp(), checkout_enabled = true
where code = 'gesture-flow-v3' and environment = 'test';

select pg_temp.assert_true(
  (select outcome = 'ready' and offer_snapshot->>'stripePriceId' = 'price_test_original'
    from public.commerce_create_checkout_intent(
      'test', '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 'behavior-test-checkout-key',
      repeat('f', 64), repeat('d', 64), repeat('e', 64)
    )),
  'checkout must atomically persist exact offer evidence'
);
select pg_temp.assert_true(
  (select count(*) = 1 from public.commerce_policy_acceptances pa
    join public.commerce_checkout_intents ci on ci.id = pa.checkout_intent_id
    where ci.idempotency_key = 'behavior-test-checkout-key'
      and pa.source = 'checkout' and pa.terms_accepted
      and pa.refund_policy_accepted and pa.compatibility_accepted),
  'checkout creation and exact policy acceptance must commit atomically'
);
update public.commerce_checkout_intents set
  stripe_checkout_session_id = 'cs_test_behavior', state = 'open',
  stripe_checkout_url = 'https://checkout.stripe.com/c/pay/test',
  expires_at = clock_timestamp() + interval '1 hour'
where idempotency_key = 'behavior-test-checkout-key';
update public.commerce_offers set
  stripe_product_id = 'prod_test_changed', stripe_price_id = 'price_test_changed',
  unit_amount = 3900, features = '["changed-after-checkout"]'::jsonb
where code = 'gesture-flow-v3' and environment = 'test';
select pg_temp.assert_true(
  (select offer_snapshot->>'stripePriceId' = 'price_test_original'
      and (offer_snapshot->>'unitAmount')::integer = 2900
      and offer_snapshot->'features' ? 'gesture-control'
    from public.commerce_checkout_intents where idempotency_key = 'behavior-test-checkout-key'),
  'operator edits must not mutate an open checkout snapshot'
);

select pg_temp.assert_true(
  (select outcome = 'fulfilled' from public.commerce_fulfill_paid_checkout(
    'test', (select id from public.commerce_checkout_intents
      where idempotency_key = 'behavior-test-checkout-key'),
    'cs_test_behavior', 'pi_test_behavior', 'cus_test_behavior', 'buyer@example.test',
    'usd', 2900, 2900, 0, 0, null, null, clock_timestamp()
  )),
  'payment must fulfill from immutable checkout evidence after offer mutation'
);
select pg_temp.assert_true(
  (select count(*) = 2 from public.commerce_device_activations a
    join public.commerce_entitlements e on e.id = a.entitlement_id
    where a.account_id = '40000000-0000-4000-8000-000000000001'
      and a.status = 'active' and e.source = 'purchase'),
  'trial Macs must rebind atomically to the purchase entitlement'
);
select pg_temp.assert_true(
  (select e.features ? 'gesture-control' from public.commerce_entitlements e
    join public.commerce_orders o on o.id = e.order_id
    where o.stripe_checkout_session_id = 'cs_test_behavior'),
  'the paid entitlement must immediately preserve the purchased core feature'
);
select pg_temp.assert_true(
  (select status = 'expired' from public.commerce_entitlements
    where account_id = '40000000-0000-4000-8000-000000000001' and source = 'trial'),
  'purchase must consume the prior trial'
);
select pg_temp.assert_true(
  (select pa.account_id = '40000000-0000-4000-8000-000000000001'
    from public.commerce_policy_acceptances pa
    join public.commerce_checkout_intents ci on ci.id = pa.checkout_intent_id
    where ci.idempotency_key = 'behavior-test-checkout-key'),
  'fulfillment may perform the sole allowed null-to-account evidence linkage'
);

-- A signed provider event must never choose between conflicting account
-- identities, including an owned Stripe customer paired with an email that has
-- not created a commerce account yet. It also must not persist an unclaimable
-- order with a NULL email or blank Stripe customer identity.
select pg_temp.assert_true(
  (select outcome = 'ready' from public.commerce_create_checkout_intent(
    'test', '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001', 'behavior-identity-guard-key',
    repeat('7', 64), repeat('8', 64), repeat('9', 64)
  )),
  'identity guard checkout must persist independently'
);
update public.commerce_checkout_intents set
  stripe_checkout_session_id = 'cs_test_identity_guard', state = 'open',
  stripe_checkout_url = 'https://checkout.stripe.com/c/pay/test-identity-guard',
  expires_at = clock_timestamp() + interval '1 hour'
where idempotency_key = 'behavior-identity-guard-key';

do $$
begin
  begin
    perform * from public.commerce_fulfill_paid_checkout(
      'test', (select id from public.commerce_checkout_intents
        where idempotency_key = 'behavior-identity-guard-key'),
      'cs_test_identity_guard', 'pi_test_identity_guard', 'cus_test_behavior',
      'unclaimed@example.test', 'usd', 3900, 3900, 0, 0, null, null,
      clock_timestamp()
    );
    raise exception 'owned customer with unclaimed email unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'owned customer with unclaimed email unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'fulfillment_identity_conflict' then raise; end if;
  end;

  begin
    perform * from public.commerce_fulfill_paid_checkout(
      'test', (select id from public.commerce_checkout_intents
        where idempotency_key = 'behavior-identity-guard-key'),
      'cs_test_identity_guard', 'pi_test_identity_guard', 'cus_test_behavior',
      'other@example.test', 'usd', 3900, 3900, 0, 0, null, null,
      clock_timestamp()
    );
    raise exception 'conflicting fulfillment identity unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'conflicting fulfillment identity unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'fulfillment_identity_conflict' then raise; end if;
  end;

  begin
    perform * from public.commerce_fulfill_paid_checkout(
      'test', (select id from public.commerce_checkout_intents
        where idempotency_key = 'behavior-identity-guard-key'),
      'cs_test_identity_guard', 'pi_test_identity_guard', '',
      'buyer@example.test', 'usd', 3900, 3900, 0, 0, null, null,
      clock_timestamp()
    );
    raise exception 'blank Stripe customer identity unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'blank Stripe customer identity unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'invalid_fulfillment_identity' then raise; end if;
  end;

  begin
    perform * from public.commerce_fulfill_paid_checkout(
      'test', (select id from public.commerce_checkout_intents
        where idempotency_key = 'behavior-identity-guard-key'),
      'cs_test_identity_guard', 'pi_test_identity_guard', 'cus_test_identity_guard',
      null::text, 'usd', 3900, 3900, 0, 0, null, null,
      clock_timestamp()
    );
    raise exception 'NULL fulfillment email unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'NULL fulfillment email unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'invalid_fulfillment_identity' then raise; end if;
  end;
end;
$$;
select pg_temp.assert_true(
  not exists (select 1 from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_identity_guard')
  and not exists (select 1 from public.commerce_entitlements
    where claimed_email in ('unclaimed@example.test', 'other@example.test'))
  and (select state = 'open'
      and stripe_checkout_session_id = 'cs_test_identity_guard'
      and stripe_checkout_url = 'https://checkout.stripe.com/c/pay/test-identity-guard'
    from public.commerce_checkout_intents
    where idempotency_key = 'behavior-identity-guard-key')
  and (select pa.account_id is null from public.commerce_policy_acceptances pa
    join public.commerce_checkout_intents ci on ci.id = pa.checkout_intent_id
    where ci.idempotency_key = 'behavior-identity-guard-key'),
  'identity guard failures must leave intent, order, entitlement, and policy evidence unchanged'
);

do $$
begin
  begin
    update public.commerce_policy_acceptances set accepted_at = clock_timestamp()
      where checkout_intent_id = (select id from public.commerce_checkout_intents
        where idempotency_key = 'behavior-test-checkout-key');
    raise exception 'policy acceptance mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'policy acceptance mutation unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'policy_acceptance_evidence_is_immutable' then raise; end if;
  end;
  begin
    delete from public.commerce_policy_acceptances
      where checkout_intent_id = (select id from public.commerce_checkout_intents
        where idempotency_key = 'behavior-test-checkout-key');
    raise exception 'policy acceptance deletion unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'policy acceptance deletion unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'policy_acceptance_evidence_is_immutable' then raise; end if;
  end;
  begin
    update public.commerce_orders set amount_subtotal = amount_subtotal + 1
      where stripe_checkout_session_id = 'cs_test_behavior';
    raise exception 'order evidence mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'order evidence mutation unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'order_evidence_is_immutable' then raise; end if;
  end;
  begin
    delete from public.commerce_orders where stripe_checkout_session_id = 'cs_test_behavior';
    raise exception 'order evidence deletion unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'order evidence deletion unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'order_evidence_is_immutable' then raise; end if;
  end;
end;
$$;

-- A second paid license contributes its own two-device capacity.
select pg_temp.assert_true(
  (select outcome = 'ready' from public.commerce_create_checkout_intent(
    'test', '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001', 'behavior-second-checkout-key',
    repeat('6', 64), repeat('d', 64), repeat('e', 64)
  )),
  'second license checkout must persist independently'
);
update public.commerce_checkout_intents set
  stripe_checkout_session_id = 'cs_test_behavior_second', state = 'open',
  stripe_checkout_url = 'https://checkout.stripe.com/c/pay/test-second',
  expires_at = clock_timestamp() + interval '1 hour'
where idempotency_key = 'behavior-second-checkout-key';
select pg_temp.assert_true(
  (select outcome = 'fulfilled' from public.commerce_fulfill_paid_checkout(
    'test', (select id from public.commerce_checkout_intents
      where idempotency_key = 'behavior-second-checkout-key'),
    'cs_test_behavior_second', 'pi_test_behavior_second', 'cus_test_behavior_repeat',
    'buyer@example.test', 'usd', 3900, 3900, 0, 0, null, null,
    clock_timestamp()
  )),
  'a repeat payment may use a newly created Stripe customer for the same verified email'
);
select pg_temp.assert_true(
  (select stripe_customer_id = 'cus_test_behavior'
    from public.commerce_accounts
    where id = '40000000-0000-4000-8000-000000000001')
  and (select stripe_customer_id = 'cus_test_behavior_repeat'
    from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_behavior_second'),
  'repeat checkout must preserve the account binding and exact order customer evidence'
);
insert into public.commerce_device_activation_challenges (
  id, product_slug, edition, licensed_major, installation_id, device_public_key,
  code_hmac, poll_token_sha256, expires_at
) values (
  '50000000-0000-4000-8000-000000000012', 'gesture-flow', 'python-mediapipe', 3,
  '60000000-0000-4000-8000-000000000012', repeat('X', 43), repeat('6', 64),
  repeat('a', 63) || '0', clock_timestamp() + interval '10 minutes'
);
select pg_temp.assert_true(
  (select outcome = 'approved'
      and entitlement_id = (select e.id from public.commerce_entitlements e
        join public.commerce_orders o on o.id = e.order_id
        where o.stripe_checkout_session_id = 'cs_test_behavior_second')
    from public.commerce_approve_activation(
      '40000000-0000-4000-8000-000000000001', repeat('6', 64), 'test',
      '20000000-0000-4000-8000-000000000001', true, true,
      repeat('d', 64), repeat('e', 64), clock_timestamp()
    )),
  'activation must choose the paid entitlement with available capacity'
);
select pg_temp.assert_true(
  (select outcome = 'active' from public.commerce_exchange_activation(
    '50000000-0000-4000-8000-000000000012', repeat('a', 63) || '0',
    clock_timestamp()
  )),
  'the second paid license must activate an additional Mac'
);
select pg_temp.assert_true(
  (select sum(device_limit) = 4 from public.commerce_entitlements
    where account_id = '40000000-0000-4000-8000-000000000001'
      and source = 'purchase' and status = 'active'),
  'two active purchases must provide four aggregate device slots'
);
update public.commerce_device_activations
  set status = 'revoked', deactivated_at = clock_timestamp(),
      deactivation_reason = 'behavior-test-admin-revocation'
  where entitlement_id = (select e.id from public.commerce_entitlements e
    join public.commerce_orders o on o.id = e.order_id
    where o.stripe_checkout_session_id = 'cs_test_behavior_second');
update public.commerce_entitlements
  set status = 'revoked_admin', admin_revoked_at = clock_timestamp(),
      admin_revocation_reason = 'behavior-test'
  where order_id = (select id from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_behavior_second');
select pg_temp.assert_true(
  public.commerce_recompute_order((select id from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_behavior_second')) = 'revoked',
  'the disposable second entitlement can be administratively revoked'
);

insert into public.commerce_refunds (
  order_id, stripe_refund_id, amount, currency, status, provider_created_at
) values (
  (select id from public.commerce_orders where stripe_checkout_session_id = 'cs_test_behavior'),
  're_test_behavior', 2900, 'usd', 'pending', clock_timestamp()
);
select pg_temp.assert_true(
  public.commerce_recompute_order((select id from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_behavior')) = 'suspended_refund',
  'full pending refund must suspend access'
);
update public.commerce_refunds set status = 'failed' where stripe_refund_id = 're_test_behavior';
select pg_temp.assert_true(
  public.commerce_recompute_order((select id from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_behavior')) = 'paid',
  'failed refund must restore paid access'
);
insert into public.commerce_disputes (
  order_id, stripe_dispute_id, stripe_charge_id, amount, currency, reason,
  status, provider_created_at
) values (
  (select id from public.commerce_orders where stripe_checkout_session_id = 'cs_test_behavior'),
  'dp_test_behavior', 'ch_test_behavior', 2900, 'usd', 'fraudulent',
  'needs_response', clock_timestamp()
);
select pg_temp.assert_true(
  public.commerce_recompute_order((select id from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_behavior')) = 'suspended_dispute',
  'open dispute must suspend access'
);
update public.commerce_disputes set status = 'lost' where stripe_dispute_id = 'dp_test_behavior';
select pg_temp.assert_true(
  public.commerce_recompute_order((select id from public.commerce_orders
    where stripe_checkout_session_id = 'cs_test_behavior')) = 'chargeback',
  'lost dispute must revoke access'
);

insert into public.commerce_refund_requests (
  account_id, order_id, reason_category, status
) values (
  '40000000-0000-4000-8000-000000000001',
  (select id from public.commerce_orders where stripe_checkout_session_id = 'cs_test_behavior'),
  'technical', 'reviewing'
);
insert into public.commerce_refunds (
  order_id, stripe_refund_id, amount, currency, status, provider_created_at
) values (
  (select id from public.commerce_orders where stripe_checkout_session_id = 'cs_test_behavior'),
  're_test_partial_one', 1000, 'usd', 'succeeded', clock_timestamp()
);
select public.commerce_recompute_order((select id from public.commerce_orders
  where stripe_checkout_session_id = 'cs_test_behavior'));
select pg_temp.assert_true(
  (select status = 'reviewing' from public.commerce_refund_requests
    where order_id = (select id from public.commerce_orders
      where stripe_checkout_session_id = 'cs_test_behavior')),
  'a partial refund must not prematurely complete the customer request'
);
insert into public.commerce_refunds (
  order_id, stripe_refund_id, amount, currency, status, provider_created_at
) values (
  (select id from public.commerce_orders where stripe_checkout_session_id = 'cs_test_behavior'),
  're_test_partial_two', 1900, 'usd', 'succeeded', clock_timestamp()
);
select public.commerce_recompute_order((select id from public.commerce_orders
  where stripe_checkout_session_id = 'cs_test_behavior'));
select pg_temp.assert_true(
  (select status = 'completed' from public.commerce_refund_requests
    where order_id = (select id from public.commerce_orders
      where stripe_checkout_session_id = 'cs_test_behavior')),
  'cumulative successful refunds must complete the customer request transactionally'
);

insert into public.commerce_device_activation_challenges (
  id, product_slug, edition, licensed_major, installation_id, device_public_key,
  code_hmac, poll_token_sha256, expires_at
) values (
  '50000000-0000-4000-8000-000000000004', 'gesture-flow', 'python-mediapipe', 3,
  '60000000-0000-4000-8000-000000000004', repeat('D', 43), repeat('4', 64),
  repeat('5', 64), clock_timestamp() + interval '10 minutes'
);
select pg_temp.assert_true(
  (select outcome = 'purchase_inactive' from public.commerce_approve_activation(
    '40000000-0000-4000-8000-000000000001', repeat('4', 64), 'test',
    '20000000-0000-4000-8000-000000000001', true, true,
    repeat('d', 64), repeat('e', 64), clock_timestamp()
  )),
  'refund or chargeback must not reopen a consumed trial'
);

insert into public.commerce_stripe_events (
  stripe_event_id, environment, event_type, object_id, payload, status, attempts,
  next_attempt_at, locked_at, lease_token
) values (
  'evt_test_stale_lease', 'test', 'checkout.session.completed', 'cs_test_stale',
  '{"eventId":"evt_test_stale_lease","type":"checkout.session.completed","objectId":"cs_test_stale","livemode":false,"apiVersion":"test","created":1783944000}'::jsonb,
  'processing', 1, clock_timestamp() - interval '1 second',
  clock_timestamp() - interval '10 minutes', '70000000-0000-4000-8000-000000000001'
);
select pg_temp.assert_true(
  (select stripe_event_id = 'evt_test_stale_lease' and attempts = 2
      and next_attempt_at > clock_timestamp()
      and lease_token <> '70000000-0000-4000-8000-000000000001'
    from public.commerce_claim_stripe_events(1, clock_timestamp())),
  'stale processing lease must be reclaimed'
);
select pg_temp.assert_true(
  not public.commerce_complete_stripe_event(
    'evt_test_stale_lease', '70000000-0000-4000-8000-000000000001',
    'processed', null, null, clock_timestamp()
  ),
  'a stale worker must be fenced from completing a reclaimed event'
);
select pg_temp.assert_true(
  public.commerce_complete_stripe_event(
    'evt_test_stale_lease',
    (select lease_token from public.commerce_stripe_events
      where stripe_event_id = 'evt_test_stale_lease'),
    'processed', null, null, clock_timestamp()
  ),
  'the current lease holder must complete the event'
);

insert into public.commerce_stripe_events (
  stripe_event_id, environment, event_type, object_id, payload, status,
  retention_until
) values
  ('evt_retention_processed', 'test', 'test.processed', 'obj_1', '{}'::jsonb,
    'processed', clock_timestamp() - interval '1 second'),
  ('evt_retention_ignored', 'test', 'test.ignored', 'obj_2', '{}'::jsonb,
    'ignored', clock_timestamp() - interval '1 second'),
  ('evt_retention_failed', 'test', 'test.failed', 'obj_3', '{}'::jsonb,
    'failed', clock_timestamp() - interval '1 second'),
  ('evt_retention_dead_letter', 'test', 'test.dead', 'obj_4', '{}'::jsonb,
    'dead_letter', clock_timestamp() - interval '1 second'),
  ('evt_retention_processing', 'test', 'test.processing', 'obj_5', '{}'::jsonb,
    'processing', clock_timestamp() - interval '1 second');

select public.commerce_run_retention(clock_timestamp() + interval '2 days');
select pg_temp.assert_true(
  (select device_metadata->>'retainedPolicyEvidence' = 'true'
      and legacy_migration is null and status = 'expired'
    from public.commerce_device_activation_challenges
    where id = '50000000-0000-4000-8000-000000000003'),
  'accepted but unexchanged challenge must retain legal link while scrubbing credentials'
);
select pg_temp.assert_true(
  (select status = 'consumed' and code_hmac <> repeat('a', 64)
      and poll_token_sha256 <> repeat('1', 64) and legacy_migration is null
    from public.commerce_device_activation_challenges
    where id = '50000000-0000-4000-8000-000000000001'),
  'consumed challenge credentials must be scrubbed while retaining lifecycle evidence'
);
select pg_temp.assert_true(
  (select status = 'active' and device_public_key = repeat('Z', 43)
    from public.commerce_device_activations
    where installation_id = '60000000-0000-4000-8000-000000000001'),
  'challenge scrubbing must not alter the current activation key'
);
select pg_temp.assert_true(
  (select count(*) = 3 from public.commerce_stripe_events
    where stripe_event_id like 'evt_retention_%'
      and status in ('failed', 'dead_letter', 'processing')),
  'retention must delete resolved envelopes but retain every unresolved financial event'
);

update public.commerce_policy_documents
  set retired_at = clock_timestamp()
  where id = '10000000-0000-4000-8000-000000000005';
select pg_temp.assert_true(
  not public.commerce_policy_set_is_active(
    '20000000-0000-4000-8000-000000000001', clock_timestamp()
  ),
  'retiring any referenced document must immediately deactivate the policy set'
);
do $$
begin
  begin
    perform * from public.commerce_create_checkout_intent(
      'test', '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 'retired-document-checkout-key',
      repeat('1', 64), repeat('2', 64), repeat('3', 64)
    );
    raise exception 'checkout with retired document unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'checkout with retired document unexpectedly succeeded' then raise; end if;
    if sqlerrm <> 'invalid_policy_set' then raise; end if;
  end;
end;
$$;
insert into public.commerce_device_activation_challenges (
  id, product_slug, edition, licensed_major, installation_id, device_public_key,
  code_hmac, poll_token_sha256, expires_at
) values (
  '50000000-0000-4000-8000-000000000013', 'gesture-flow', 'python-mediapipe', 3,
  '60000000-0000-4000-8000-000000000013', repeat('W', 43), repeat('5', 64),
  repeat('b', 64), clock_timestamp() + interval '10 minutes'
);
select pg_temp.assert_true(
  (select outcome = 'invalid_policy_set' from public.commerce_approve_activation(
    '40000000-0000-4000-8000-000000000001', repeat('5', 64), 'test',
    '20000000-0000-4000-8000-000000000001', true, true,
    repeat('d', 64), repeat('e', 64), clock_timestamp()
  )),
  'activation must reject a policy set containing a retired document'
);

rollback;
