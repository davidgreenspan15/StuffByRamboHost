-- Production (live) purchase codes behind explicit gates that default OFF,
-- with an explicit environment contract on every purchase-code operation.
-- Additive: published migrations 202610260001/0002 are unchanged.
--
-- Every caller-facing RPC (resend, claim, issue, redeem) now takes
-- p_environment ('test' or 'live'; anything else raises) and acts only on a
-- purchase whose order AND offer are in that environment. The old signatures
-- are dropped, not overloaded, so no legacy call path can bypass the boundary.
-- Test keeps its mandatory recipient allowlist. Live additionally requires the
-- database gate below. One Mac per paid purchase, single-use codes,
-- lease-fenced issuance for verified paid orders, no trial creation and no
-- device-key rebind are unchanged.
--
-- Deploy order: apply this migration, then deploy the edge functions that pass
-- p_environment. In between, old functions call dropped signatures and fail
-- closed (resend/redeem answer 503 activation_unavailable; the worker throws
-- before claiming, so queued rows stay pending). No compatibility shim.

-- 1. Database-side live gate. Singleton, default false. service_role may read
-- but not write it; an operator flips it with reviewed SQL at launch.
create table public.commerce_purchase_code_settings (
  singleton boolean primary key default true check (singleton),
  live_enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.commerce_purchase_code_settings(singleton) values (true);
alter table public.commerce_purchase_code_settings enable row level security;
alter table public.commerce_purchase_code_settings force row level security;
revoke all on public.commerce_purchase_code_settings from public, anon, authenticated, service_role;
grant select on public.commerce_purchase_code_settings to service_role;

-- 2. Environment contract helpers.
create function public.commerce_purchase_code_require_environment(p_environment text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_environment is null or p_environment not in ('test', 'live') then
    raise exception 'invalid_purchase_code_environment';
  end if;
end; $$;

create function public.commerce_purchase_codes_environment_open(p_environment text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_environment
    when 'test' then true
    when 'live' then coalesce((select s.live_enabled
      from public.commerce_purchase_code_settings s where s.singleton), false)
    else false end;
$$;

-- 3. Retire the environment-blind signatures (no overloads remain).
drop function public.commerce_request_purchase_code_email(text);
drop function public.commerce_private_purchase_email(text);
drop function public.commerce_claim_purchase_code_emails(text[]);
drop function public.commerce_issue_purchase_activation_code(uuid, uuid, text);
drop function public.commerce_redeem_purchase_code(uuid, text, text, text[], timestamptz);
drop function public.commerce_purchase_code_entitlement_eligible(uuid, timestamptz);

-- 4. Eligibility for the caller's environment: order and offer both match it,
-- that environment is open (live needs the gate), paid, active, v3.
create function public.commerce_purchase_code_entitlement_eligible(
  p_environment text, p_entitlement_id uuid, p_now timestamptz
) returns boolean language sql stable security definer set search_path = '' as $$
  select p_environment in ('test', 'live') and exists(
    select 1 from public.commerce_entitlements e
    join public.commerce_orders o on o.id = e.order_id
    join public.commerce_offers f on f.id = o.offer_id
    where e.id = p_entitlement_id
      and o.environment = p_environment and f.environment = p_environment
      and public.commerce_purchase_codes_environment_open(p_environment)
      and f.code = 'gesture-flow-v3' and o.status = 'paid' and e.source = 'purchase'
      and e.status = 'active' and e.product_slug = 'gesture-flow'
      and e.edition = 'python-mediapipe' and e.licensed_major = 3
      and e.valid_from <= p_now and (e.expires_at is null or e.expires_at > p_now));
$$;

-- 5. Recipient gate. Test: a non-empty allowlist must contain the buyer (a
-- null/empty list matches nobody). Live: null means every buyer; a list is an
-- optional canary.
create function public.commerce_purchase_code_recipient_allowed(
  p_environment text, p_email text, p_allowed_emails text[]
) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case p_environment
    when 'test' then p_email = any(p_allowed_emails)
    when 'live' then p_allowed_emails is null or p_email = any(p_allowed_emails)
    else false end, false);
$$;

-- 6. Fulfillment queues the code email for a paid purchase whose own
-- environment is open (test as before; live only while the gate is on). Live
-- purchases made while it was off are never auto-emailed later.
create or replace function public.commerce_queue_purchase_code_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source = 'purchase' and new.status = 'active' and new.product_slug = 'gesture-flow'
    and new.edition = 'python-mediapipe' and new.licensed_major = 3
    and exists(select 1 from public.commerce_orders o
      join public.commerce_offers f on f.id = o.offer_id
      where o.id = new.order_id and o.status = 'paid' and f.environment = o.environment
        and public.commerce_purchase_codes_environment_open(o.environment)) then
    insert into public.commerce_purchase_code_emails(order_id) values(new.order_id)
      on conflict (order_id) do nothing;
  end if;
  return new;
end; $$;

-- 7. Resend: re-queues every eligible order of this email IN THIS ENVIRONMENT
-- whose code is unused. The edge applies the recipient gate before calling.
create function public.commerce_request_purchase_code_email(p_environment text, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.commerce_purchase_code_require_environment(p_environment);
  insert into public.commerce_purchase_code_emails(order_id)
    select o.id from public.commerce_entitlements e
    join public.commerce_orders o on o.id = e.order_id
    left join public.commerce_accounts a on a.id = e.account_id
    where public.commerce_purchase_code_entitlement_eligible(p_environment, e.id, clock_timestamp())
      and coalesce(a.email, e.claimed_email) = lower(btrim(p_email))
      and not exists (
        select 1 from public.commerce_purchase_activation_codes pc
        where pc.entitlement_id = e.id and pc.status = 'consumed')
    on conflict(order_id) do update set status = 'pending', lease_token = null,
      attempted_at = null, completed_at = null
    where commerce_purchase_code_emails.status in ('sent','failed','uncertain','superseded');
end; $$;

-- 8. Claim: only pending rows of this environment and allowed recipients.
create function public.commerce_claim_purchase_code_emails(
  p_environment text, p_allowed_emails text[]
) returns table(order_id uuid,email text,lease_token uuid)
language plpgsql security definer set search_path = '' as $$
declare r record; new_lease uuid;
begin
  perform public.commerce_purchase_code_require_environment(p_environment);
  -- A crashed sender might already have delivered its code. Never auto-resend.
  -- Only this environment's stale leases are touched.
  update public.commerce_purchase_code_emails q set status='uncertain'
    from public.commerce_orders o
    where o.id = q.order_id and o.environment = p_environment
      and q.status='sending' and q.attempted_at<clock_timestamp()-interval '2 minutes';
  for r in
    select q.order_id, coalesce(a.email, e.claimed_email) as email
    from public.commerce_purchase_code_emails q
    join public.commerce_entitlements e on e.order_id = q.order_id
    left join public.commerce_accounts a on a.id = e.account_id
    where q.status = 'pending'
      and public.commerce_purchase_code_entitlement_eligible(p_environment, e.id, clock_timestamp())
      and public.commerce_purchase_code_recipient_allowed(
        p_environment, coalesce(a.email, e.claimed_email), p_allowed_emails)
      and not exists (
        select 1 from public.commerce_purchase_activation_codes pc
        where pc.entitlement_id = e.id and pc.status = 'consumed')
    order by q.created_at limit 5 for update of q skip locked
  loop
    new_lease:=gen_random_uuid();
    update public.commerce_purchase_code_emails q set status='sending',lease_token=new_lease,
      attempted_at=clock_timestamp() where q.order_id=r.order_id;
    return query select r.order_id,r.email,new_lease;
  end loop;
end; $$;

-- 9. Issuance under the worker's lease, for this environment only. Same body
-- as 202610260002 plus the environment check before any code row changes.
create function public.commerce_issue_purchase_activation_code(
  p_environment text, p_order_id uuid, p_lease_token uuid, p_code_sha256 text
) returns text language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  perform public.commerce_purchase_code_require_environment(p_environment);
  if p_code_sha256 is null or p_code_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_code_digest';
  end if;
  perform 1 from public.commerce_purchase_code_emails q
    where q.order_id = p_order_id and q.lease_token = p_lease_token and q.status = 'sending'
    for update;
  if not found then return 'lease_lost'; end if;
  select e.id into target from public.commerce_entitlements e where e.order_id = p_order_id;
  if target is null
    or not public.commerce_purchase_code_entitlement_eligible(p_environment, target, clock_timestamp()) then
    return 'not_eligible';
  end if;
  -- Same lock order as redemption (code rows before entitlement state), so a
  -- racing redemption either finishes first (already_used) or sees revoked.
  perform 1 from public.commerce_purchase_activation_codes pc
    where pc.entitlement_id = target for update;
  if exists (select 1 from public.commerce_purchase_activation_codes pc
    where pc.entitlement_id = target and pc.status = 'consumed') then
    return 'already_used';
  end if;
  update public.commerce_purchase_activation_codes pc
    set status = 'revoked', revoked_at = clock_timestamp()
    where pc.entitlement_id = target and pc.status = 'issued';
  insert into public.commerce_purchase_activation_codes(entitlement_id, code_sha256)
    values (target, p_code_sha256);
  return 'issued';
end; $$;

-- 10. Redemption for this environment. Identical to 202610260002 except the
-- leading p_environment, its validation, the environment-scoped eligibility
-- and the recipient predicate.
create function public.commerce_redeem_purchase_code(
  p_environment text,
  p_challenge_id uuid,
  p_poll_token_sha256 text,
  p_code_sha256 text,
  p_allowed_emails text[],
  p_now timestamptz default clock_timestamp()
)
returns table (
  outcome text,
  activation_id uuid,
  account_id uuid,
  entitlement_id uuid,
  entitlement_source text,
  product_slug text,
  edition text,
  licensed_major integer,
  device_limit integer,
  features jsonb,
  installation_id uuid,
  entitlement_expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  c public.commerce_device_activation_challenges%rowtype;
  k public.commerce_purchase_activation_codes%rowtype;
  e public.commerce_entitlements%rowtype;
  a public.commerce_device_activations%rowtype;
  owner_email text;
  active_count integer;
  failure text;
begin
  perform public.commerce_purchase_code_require_environment(p_environment);
  select * into c from public.commerce_device_activation_challenges ch
    where ch.id = p_challenge_id for update;
  if c.id is null or c.poll_token_sha256 <> p_poll_token_sha256
    or c.product_slug <> 'gesture-flow' or c.edition <> 'python-mediapipe'
    or c.licensed_major <> 3 then
    failure := 'invalid';
  elsif c.expires_at <= p_now then
    -- An expired NEW challenge stays expired, even for an already used code.
    update public.commerce_device_activation_challenges ch set status = 'expired'
      where ch.id = c.id and ch.status in ('pending', 'approved');
    failure := 'expired';
  else
    if p_code_sha256 ~ '^[0-9a-f]{64}$' then
      select * into k from public.commerce_purchase_activation_codes pc
        where pc.code_sha256 = p_code_sha256 for update;
    end if;
    if k.status in ('issued', 'consumed') then
      select * into e from public.commerce_entitlements en
        where en.id = k.entitlement_id for update;
      select ac.email into owner_email from public.commerce_accounts ac where ac.id = e.account_id;
      owner_email := coalesce(owner_email, e.claimed_email);
    end if;
    -- Unknown, revoked, refunded/suspended, wrong product/environment or
    -- recipient/live-gate failures all produce the same generic outcome. A
    -- code from the other environment is unknown to this caller.
    if e.id is null
      or not public.commerce_purchase_code_entitlement_eligible(p_environment, e.id, p_now)
      or e.product_slug <> c.product_slug or e.edition <> c.edition
      or e.licensed_major <> c.licensed_major
      or not public.commerce_purchase_code_recipient_allowed(p_environment, owner_email, p_allowed_emails) then
      failure := 'invalid_code';
    end if;
  end if;
  if failure is not null then
    return query select failure, null::uuid, null::uuid, null::uuid, null::text,
      null::text, null::text, null::integer, null::integer, null::jsonb,
      c.installation_id, null::timestamptz;
    return;
  end if;

  select * into a from public.commerce_device_activations da
    where da.entitlement_id = e.id and da.installation_id = c.installation_id for update;

  -- This exact Mac (installation and device key) is already active on this
  -- purchase. Covers lost responses (including after the original challenge
  -- expired), Macs upgraded from a trial at fulfillment, and same-key retries.
  -- A consumed code must belong to that activation; an unused code is NOT
  -- consumed because no new Mac was activated.
  if a.id is not null and a.status = 'active' and a.device_public_key = c.device_public_key
    and (k.status = 'issued' or a.id = k.activation_id) then
    if c.status = 'pending' then
      update public.commerce_device_activations da
        set challenge_id = c.id, device_metadata = c.device_metadata, last_seen_at = p_now
        where da.id = a.id returning * into a;
      update public.commerce_device_activation_challenges ch
        set status = 'consumed', account_id = e.account_id, entitlement_id = e.id,
            approved_at = p_now, consumed_at = p_now
        where ch.id = c.id;
    elsif not (c.status = 'consumed' and a.challenge_id = c.id) then
      failure := 'challenge_used';
    end if;
  elsif k.status = 'consumed' then
    failure := 'invalid_code';
  elsif c.status <> 'pending' then
    failure := 'challenge_used';
  elsif a.id is not null and a.status = 'active' then
    -- Hard fail: never let a new key take over an active installation.
    failure := 'device_key_conflict';
  elsif exists (
    select 1 from public.commerce_device_activations other
    join public.commerce_entitlements oe on oe.id = other.entitlement_id
    where other.installation_id = c.installation_id and other.status = 'active'
      and other.entitlement_id <> e.id and oe.source in ('purchase', 'admin')
      and oe.status = 'active' and oe.product_slug = e.product_slug
      and oe.edition = e.edition and oe.licensed_major = e.licensed_major
  ) then
    -- Reported only after the code itself validated; the code stays unused.
    failure := 'already_activated';
  else
    select count(*) into active_count from public.commerce_device_activations da
      where da.entitlement_id = e.id and da.status = 'active';
    if active_count >= e.device_limit then
      -- The code stays unused; nothing is consumed.
      return query select 'device_limit'::text, null::uuid, e.account_id, e.id, e.source,
        e.product_slug, e.edition, e.licensed_major, e.device_limit, e.features,
        c.installation_id, e.expires_at;
      return;
    end if;
    -- This Mac's trial activation is superseded by the purchase.
    with upgraded as (
      update public.commerce_device_activations da
        set status = 'deactivated', deactivated_at = p_now,
            deactivation_reason = 'upgraded_to_purchase'
        from public.commerce_entitlements te
        where da.entitlement_id = te.id and te.source = 'trial'
          and da.installation_id = c.installation_id and da.status = 'active'
          and te.product_slug = e.product_slug and te.edition = e.edition
          and te.licensed_major = e.licensed_major
        returning da.id
    )
    insert into public.commerce_audit_log (actor_type, actor_id, action, target_type, target_id, reason)
      select 'system', null, 'device.deactivated', 'device_activation', u.id::text,
        'upgraded_to_purchase' from upgraded u;
    if a.id is null then
      insert into public.commerce_device_activations (
        entitlement_id, account_id, challenge_id, installation_id, device_public_key,
        device_metadata, status, activated_at, last_seen_at, purchase_code_activation
      ) values (
        e.id, e.account_id, c.id, c.installation_id, c.device_public_key,
        c.device_metadata, 'active', p_now, p_now, true
      ) returning * into a;
    else
      update public.commerce_device_activations da
        set challenge_id = c.id, device_public_key = c.device_public_key,
            device_metadata = c.device_metadata, status = 'active', activated_at = p_now,
            last_seen_at = p_now, deactivated_at = null, deactivation_reason = null,
            purchase_code_activation = true
        where da.id = a.id returning * into a;
    end if;
    update public.commerce_device_activation_challenges ch
      set status = 'consumed', account_id = e.account_id, entitlement_id = e.id,
          approved_at = p_now, consumed_at = p_now
      where ch.id = c.id;
    update public.commerce_purchase_activation_codes pc
      set status = 'consumed', consumed_at = p_now, challenge_id = c.id, activation_id = a.id
      where pc.id = k.id;
    insert into public.commerce_audit_log (
      actor_type, actor_id, action, target_type, target_id, context
    ) values (
      'device', null, 'device.activated_by_purchase_code', 'device_activation', a.id::text,
      jsonb_build_object('entitlementId', e.id, 'purchaseCodeId', k.id)
    );
  end if;
  if failure is not null then
    return query select failure, null::uuid, null::uuid, null::uuid, null::text,
      null::text, null::text, null::integer, null::integer, null::jsonb,
      c.installation_id, null::timestamptz;
    return;
  end if;

  return query select 'active'::text, a.id, e.account_id, e.id, e.source, e.product_slug,
    e.edition, e.licensed_major, e.device_limit, e.features, a.installation_id, e.expires_at;
end; $$;

-- 11. Least privilege.
revoke all on function public.commerce_purchase_code_require_environment(text) from public, anon, authenticated;
revoke all on function public.commerce_purchase_codes_environment_open(text) from public, anon, authenticated;
revoke all on function public.commerce_purchase_code_entitlement_eligible(text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.commerce_purchase_code_recipient_allowed(text, text, text[]) from public, anon, authenticated;
revoke all on function public.commerce_request_purchase_code_email(text, text) from public, anon, authenticated;
revoke all on function public.commerce_claim_purchase_code_emails(text, text[]) from public, anon, authenticated;
revoke all on function public.commerce_issue_purchase_activation_code(text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.commerce_redeem_purchase_code(text, uuid, text, text, text[], timestamptz) from public, anon, authenticated;
grant execute on function
  public.commerce_purchase_code_require_environment(text),
  public.commerce_purchase_codes_environment_open(text),
  public.commerce_purchase_code_entitlement_eligible(text, uuid, timestamptz),
  public.commerce_purchase_code_recipient_allowed(text, text, text[]),
  public.commerce_request_purchase_code_email(text, text),
  public.commerce_claim_purchase_code_emails(text, text[]),
  public.commerce_issue_purchase_activation_code(text, uuid, uuid, text),
  public.commerce_redeem_purchase_code(text, uuid, text, text, text[], timestamptz)
  to service_role;
