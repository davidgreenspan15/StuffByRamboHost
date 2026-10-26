-- Synthetic browser activation regression. Disposable runner only.
-- A paid owner must not replace the key of an active installation to reuse
-- one device slot on another client. Explicit deactivation remains supported.
select public.test_purchase(900, 'browser-security@example.test');
insert into auth.users(id,email,email_confirmed_at)
values (public.test_id('10000000',900),'browser-security@example.test',clock_timestamp());
select public.test_challenge(900,900,'A');
select public.test_assert((select outcome='approved' from public.commerce_approve_activation(
  public.test_id('10000000',900),md5('code-a900')||md5('code-b900'),'test',
  '20000000-0000-4000-8000-000000000001',true,true,repeat('a',64),repeat('b',64))),
  'paid owner approves first browser activation');
select public.test_assert((select outcome='active' from public.commerce_exchange_activation(
  public.test_id('70000000',900),public.test_poll(900))), 'first key activates');

select public.test_challenge(901,900,'B');
select public.test_assert((select outcome='approved' from public.commerce_approve_activation(
  public.test_id('10000000',900),md5('code-a901')||md5('code-b901'),'test',
  '20000000-0000-4000-8000-000000000001',true,true,repeat('a',64),repeat('b',64))),
  'copied installation reaches authenticated browser exchange');
select public.test_assert((select outcome='device_key_conflict' from public.commerce_exchange_activation(
  public.test_id('70000000',901),public.test_poll(901))),
  'browser exchange rejects another key for an active installation');
select public.test_assert((select count(*)=1 and bool_and(device_public_key=repeat('A',43)
  and challenge_id=public.test_id('70000000',900)) from public.commerce_device_activations
  where entitlement_id=public.test_id('60000000',900) and status='active'),
  'rejected replacement preserves original key, challenge and slot count');
select public.test_assert((select status='approved' from public.commerce_device_activation_challenges
  where id=public.test_id('70000000',901)), 'rejected replacement never consumes challenge');
select public.test_assert((select outcome='active' from public.commerce_exchange_activation(
  public.test_id('70000000',900),public.test_poll(900))), 'original retry remains valid');

select public.test_challenge(902,900,'A');
select public.test_assert((select outcome='approved' from public.commerce_approve_activation(
  public.test_id('10000000',900),md5('code-a902')||md5('code-b902'),'test',
  '20000000-0000-4000-8000-000000000001',true,true,repeat('a',64),repeat('b',64))),
  'same-key browser recovery may be approved');
select public.test_assert((select outcome='active' from public.commerce_exchange_activation(
  public.test_id('70000000',902),public.test_poll(902))), 'same key recovers without another slot');
select public.test_assert((select outcome='denied' from public.commerce_exchange_activation(
  public.test_id('70000000',900),public.test_poll(900))), 'superseded poll bearer stays denied');
select public.test_assert(public.commerce_deactivate_activation(
  (select id from public.commerce_device_activations where entitlement_id=public.test_id('60000000',900)),
  public.test_id('10000000',900),'customer','synthetic test'), 'owner may explicitly deactivate');
select public.test_assert((select outcome='active' from public.commerce_exchange_activation(
  public.test_id('70000000',901),public.test_poll(901))), 'approved new key works after explicit deactivation');
select public.test_assert((select count(*)=1 and bool_and(device_public_key=repeat('B',43))
  from public.commerce_device_activations where entitlement_id=public.test_id('60000000',900)
  and status='active'), 'explicit transfer retains one active slot');
