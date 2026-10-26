-- Single-use purchase activation codes (private TEST purchases only).
-- Replaces the Supabase Auth email OTP purchase path from 202610260001.
-- One code per paid purchase activates exactly one Mac and is then dead.
-- Browser trial/account sign-in is unchanged.

-- 1. One Mac per paid purchase; trials keep two Macs.
-- Trials previously read the offer device_limit, so they get their own column.
alter table public.commerce_offers
  add column trial_device_limit integer not null default 2
    check (trial_device_limit between 1 and 20);

update public.commerce_offers
  set device_limit = 1,
      description = 'Perpetual access to Gesture Flow 3.x on one Mac.'
  where code = 'gesture-flow-v3' and product_slug = 'gesture-flow';

-- Authoritative rule for every paid Gesture Flow v3 entitlement, including
-- checkouts whose offer snapshot was taken before this migration.
create function public.commerce_enforce_purchase_device_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source = 'purchase' and new.product_slug = 'gesture-flow'
    and new.edition = 'python-mediapipe' and new.licensed_major = 3 then
    new.device_limit := 1;
  end if;
  return new;
end; $$;
create trigger commerce_entitlements_purchase_device_limit
  before insert or update of device_limit, source on public.commerce_entitlements
  for each row execute function public.commerce_enforce_purchase_device_limit();

-- Existing (test-only) purchase entitlements adopt the one-Mac rule. Already
-- active devices are not deactivated; new activations stop at one.
update public.commerce_entitlements
  set device_limit = 1
  where source = 'purchase' and product_slug = 'gesture-flow'
    and edition = 'python-mediapipe' and licensed_major = 3 and device_limit <> 1;

-- 2. Purchase-code activations may exist before the buyer has an Auth account.
-- Code possession proves control of the purchase inbox only; no Auth user,
-- email verification, portal identity or policy acceptance is fabricated.
-- Such rows carry the entitlement's account (null until claimed) and are
-- backfilled when the buyer later signs in to the portal.
alter table public.commerce_device_activations
  alter column account_id drop not null,
  add column purchase_code_activation boolean not null default false,
  add constraint commerce_device_activation_account_or_code
    check (account_id is not null or purchase_code_activation);

-- 3. Digest-only code store. One live (issued or consumed) code per purchase.
create table public.commerce_purchase_activation_codes (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.commerce_entitlements(id),
  code_sha256 text not null unique check (code_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'issued' check (status in ('issued', 'consumed', 'revoked')),
  challenge_id uuid references public.commerce_device_activation_challenges(id) on delete set null,
  activation_id uuid references public.commerce_device_activations(id),
  issued_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  constraint commerce_purchase_code_lifecycle check (
    (status = 'issued' and consumed_at is null and activation_id is null and revoked_at is null)
    or (status = 'consumed' and consumed_at is not null and activation_id is not null and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null and consumed_at is null)
  )
);
create unique index commerce_purchase_code_one_live_per_entitlement
  on public.commerce_purchase_activation_codes (entitlement_id)
  where status in ('issued', 'consumed');
alter table public.commerce_purchase_activation_codes enable row level security;
alter table public.commerce_purchase_activation_codes force row level security;
revoke all on public.commerce_purchase_activation_codes from public, anon, authenticated;
grant all on public.commerce_purchase_activation_codes to service_role;

-- 4. Retire OTP-era queue work deliberately. Pending/in-flight rows were
-- queued for a Supabase OTP; they are marked superseded (never auto-sent as
-- an OTP or a code). An explicit resend re-queues them under the new scheme.
alter table public.commerce_purchase_code_emails
  drop constraint commerce_purchase_code_emails_status_check,
  add constraint commerce_purchase_code_emails_status_check
    check (status in ('pending','sending','sent','failed','uncertain','superseded'));
update public.commerce_purchase_code_emails
  set status = 'superseded', lease_token = null, completed_at = clock_timestamp()
  where status in ('pending', 'sending');

-- The OTP authorization RPC has no remaining caller.
drop function public.commerce_authorize_purchase_challenge(uuid, text, uuid, text);

-- 5. Eligibility. Paid TEST Gesture Flow v3 purchase, currently active.
create function public.commerce_purchase_code_entitlement_eligible(
  p_entitlement_id uuid, p_now timestamptz
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.commerce_entitlements e
    join public.commerce_orders o on o.id = e.order_id
    join public.commerce_offers f on f.id = o.offer_id
    where e.id = p_entitlement_id and o.environment = 'test' and f.environment = 'test'
      and f.code = 'gesture-flow-v3' and o.status = 'paid' and e.source = 'purchase'
      and e.status = 'active' and e.product_slug = 'gesture-flow'
      and e.edition = 'python-mediapipe' and e.licensed_major = 3
      and e.valid_from <= p_now and (e.expires_at is null or e.expires_at > p_now));
$$;

-- Replaces the 202610260001 version. Returns EVERY eligible order for the
-- email (one purchase email per order), with no device_limit=2 filter, and
-- never a purchase whose code was already used.
create or replace function public.commerce_private_purchase_email(p_email text)
returns table(order_id uuid, email text)
language sql stable security definer set search_path = '' as $$
  select o.id, coalesce(a.email, e.claimed_email) from public.commerce_entitlements e
  join public.commerce_orders o on o.id = e.order_id
  left join public.commerce_accounts a on a.id = e.account_id
  where public.commerce_purchase_code_entitlement_eligible(e.id, clock_timestamp())
    and coalesce(a.email, e.claimed_email) = lower(btrim(p_email))
    and not exists (
      select 1 from public.commerce_purchase_activation_codes pc
      where pc.entitlement_id = e.id and pc.status = 'consumed')
  order by o.created_at;
$$;

-- Resend re-queues every eligible order of this email whose code is unused;
-- the worker then rotates and emails each one separately.
create or replace function public.commerce_request_purchase_code_email(p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.commerce_purchase_code_emails(order_id)
    select q.order_id from public.commerce_private_purchase_email(p_email) q
    on conflict(order_id) do update set status = 'pending', lease_token = null,
      attempted_at = null, completed_at = null
    where commerce_purchase_code_emails.status in ('sent','failed','uncertain','superseded');
end; $$;

-- Replaces the 202610260001 version: eligibility is checked per order (it
-- previously matched only the newest order for the email).
create or replace function public.commerce_claim_purchase_code_emails(p_allowed_emails text[])
returns table(order_id uuid,email text,lease_token uuid)
language plpgsql security definer set search_path = '' as $$
declare r record; new_lease uuid;
begin
  -- A crashed sender might already have delivered its code. Never auto-resend.
  update public.commerce_purchase_code_emails q set status='uncertain'
    where q.status='sending' and q.attempted_at<clock_timestamp()-interval '2 minutes';
  for r in
    select q.order_id, coalesce(a.email, e.claimed_email) as email
    from public.commerce_purchase_code_emails q
    join public.commerce_entitlements e on e.order_id = q.order_id
    left join public.commerce_accounts a on a.id = e.account_id
    where q.status = 'pending'
      and public.commerce_purchase_code_entitlement_eligible(e.id, clock_timestamp())
      and coalesce(a.email, e.claimed_email) = any(p_allowed_emails)
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

-- 6. Issuance at send time, fenced by the worker's lease. Rotates an unused
-- code (old one revoked) and refuses once a code has been consumed. The raw
-- code never reaches the database; only its keyed digest does.
create function public.commerce_issue_purchase_activation_code(
  p_order_id uuid, p_lease_token uuid, p_code_sha256 text
) returns text language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if p_code_sha256 is null or p_code_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_code_digest';
  end if;
  perform 1 from public.commerce_purchase_code_emails q
    where q.order_id = p_order_id and q.lease_token = p_lease_token and q.status = 'sending'
    for update;
  if not found then return 'lease_lost'; end if;
  select e.id into target from public.commerce_entitlements e where e.order_id = p_order_id;
  if target is null
    or not public.commerce_purchase_code_entitlement_eligible(target, clock_timestamp()) then
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

-- 7. Redemption. One transaction locks challenge, then code, then entitlement,
-- then device activations. Returns the commerce_exchange_activation row shape.
-- Unlike exchange it never rebinds an active installation to a new device key.
create function public.commerce_redeem_purchase_code(
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
    -- non-allowlisted all produce the same generic outcome.
    if e.id is null
      or not public.commerce_purchase_code_entitlement_eligible(e.id, p_now)
      or e.product_slug <> c.product_slug or e.edition <> c.edition
      or e.licensed_major <> c.licensed_major
      or coalesce(owner_email = any(p_allowed_emails), false) = false then
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

-- 8. Account claim later attaches purchase-code activations to the buyer's
-- verified account so the portal lists and can deactivate them.
create or replace function public.commerce_handle_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text;
begin
  normalized_email := lower(btrim(new.email));
  if normalized_email is null or normalized_email = '' then
    raise exception 'commerce_account_requires_email';
  end if;
  if tg_op = 'UPDATE' then
    if lower(btrim(old.email)) is distinct from normalized_email then
      raise exception 'commerce_account_email_is_immutable';
    end if;
  end if;

  insert into public.commerce_accounts (id, email)
  values (new.id, normalized_email)
  on conflict (id) do update set email = excluded.email;

  update public.commerce_orders
    set account_id = new.id
    where account_id is null and lower(claimed_email) = normalized_email;

  update public.commerce_entitlements
    set account_id = new.id
    where account_id is null and lower(claimed_email) = normalized_email;

  update public.commerce_policy_acceptances pa
    set account_id = new.id
    from public.commerce_orders o
    where pa.checkout_intent_id = o.checkout_intent_id
      and o.account_id = new.id
      and pa.account_id is null;

  update public.commerce_device_activations da
    set account_id = new.id
    from public.commerce_entitlements e
    where da.entitlement_id = e.id and e.account_id = new.id and da.account_id is null;

  return new;
end;
$$;

create or replace function public.commerce_claim_account_entitlements(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text;
begin
  select email into normalized_email
  from public.commerce_accounts
  where id = p_account_id;

  if normalized_email is null then
    raise exception 'account_not_found';
  end if;

  update public.commerce_orders
    set account_id = p_account_id
    where account_id is null and lower(claimed_email) = normalized_email;

  update public.commerce_entitlements
    set account_id = p_account_id
    where account_id is null and lower(claimed_email) = normalized_email;

  update public.commerce_policy_acceptances pa
    set account_id = p_account_id
    from public.commerce_orders o
    where pa.checkout_intent_id = o.checkout_intent_id
      and o.account_id = p_account_id
      and pa.account_id is null;

  update public.commerce_device_activations da
    set account_id = p_account_id
    from public.commerce_entitlements e
    where da.entitlement_id = e.id and e.account_id = p_account_id
      and da.account_id is null;
end;
$$;

-- 9. Trials keep their own device limit (unchanged at two). Identical to the
-- 202607130001 definition except the trial insert reads trial_device_limit.
create or replace function public.commerce_approve_activation(
  p_account_id uuid,
  p_code_hmac text,
  p_environment text,
  p_policy_set_id uuid,
  p_terms_accepted boolean,
  p_compatibility_accepted boolean,
  p_ip_hmac text,
  p_user_agent_sha256 text,
  p_now timestamptz default clock_timestamp()
)
returns table (
  outcome text,
  challenge_id uuid,
  entitlement_id uuid,
  entitlement_type text,
  entitlement_expires_at timestamptz,
  trial_started boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  challenge_record public.commerce_device_activation_challenges%rowtype;
  entitlement_record public.commerce_entitlements%rowtype;
  offer_record public.commerce_offers%rowtype;
  trial_was_started boolean := false;
begin
  if not p_terms_accepted or not p_compatibility_accepted then
    return query select 'policy_acceptance_required'::text, null::uuid, null::uuid,
      null::text, null::timestamptz, false;
    return;
  end if;

  if not public.commerce_policy_set_is_active(p_policy_set_id, p_now) then
    return query select 'invalid_policy_set'::text, null::uuid, null::uuid,
      null::text, null::timestamptz, false;
    return;
  end if;

  select * into offer_record
  from public.commerce_offers o
  where o.code = 'gesture-flow-v3'
    and o.environment = p_environment
    and o.product_slug = 'gesture-flow'
    and o.edition = 'python-mediapipe'
    and o.licensed_major = 3
    and o.current_policy_set_id = p_policy_set_id
  for share;
  if offer_record.id is null then
    return query select 'invalid_policy_set'::text, null::uuid, null::uuid,
      null::text, null::timestamptz, false;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || ':gesture-flow', 0));
  perform public.commerce_claim_account_entitlements(p_account_id);

  select * into challenge_record
  from public.commerce_device_activation_challenges c
  where c.code_hmac = p_code_hmac
  for update;

  if challenge_record.id is null
    or challenge_record.status <> 'pending'
    or challenge_record.expires_at <= p_now
  then
    return query select 'invalid_or_expired'::text, null::uuid, null::uuid, null::text,
      null::timestamptz, false;
    return;
  end if;

  select * into entitlement_record
  from public.commerce_entitlements e
  where e.account_id = p_account_id
    and e.product_slug = challenge_record.product_slug
    and e.edition = challenge_record.edition
    and e.licensed_major = challenge_record.licensed_major
    and e.source in ('purchase', 'admin')
    and e.status = 'active'
    and e.valid_from <= p_now
    and (e.expires_at is null or e.expires_at > p_now)
    and (
      exists (
        select 1 from public.commerce_device_activations same_device
        where same_device.entitlement_id = e.id
          and same_device.installation_id = challenge_record.installation_id
          and same_device.status = 'active'
      )
      or (
        (select count(*) from public.commerce_device_activations active_device
          where active_device.entitlement_id = e.id and active_device.status = 'active')
        +
        (select count(*) from public.commerce_device_activation_challenges reservation
          where reservation.entitlement_id = e.id
            and reservation.status = 'approved'
            and reservation.expires_at > p_now)
        < e.device_limit
      )
    )
  order by
    case when exists (
      select 1 from public.commerce_device_activations same_device
      where same_device.entitlement_id = e.id
        and same_device.installation_id = challenge_record.installation_id
        and same_device.status = 'active'
    ) then 0 else 1 end,
    (select count(*) from public.commerce_device_activations active_device
      where active_device.entitlement_id = e.id and active_device.status = 'active'),
    case e.source when 'purchase' then 0 else 1 end,
    e.created_at
  limit 1
  for update;

  if entitlement_record.id is null then
    if exists (
      select 1 from public.commerce_entitlements active_purchase
      where active_purchase.account_id = p_account_id
        and active_purchase.product_slug = challenge_record.product_slug
        and active_purchase.edition = challenge_record.edition
        and active_purchase.licensed_major = challenge_record.licensed_major
        and active_purchase.source in ('purchase', 'admin')
        and active_purchase.status = 'active'
        and active_purchase.valid_from <= p_now
        and (active_purchase.expires_at is null or active_purchase.expires_at > p_now)
    ) then
      return query select 'device_limit'::text, challenge_record.id, null::uuid,
        'purchase'::text, null::timestamptz, false;
      return;
    end if;
    if exists (
      select 1 from public.commerce_entitlements purchase_history
      where purchase_history.account_id = p_account_id
        and purchase_history.product_slug = challenge_record.product_slug
        and purchase_history.edition = challenge_record.edition
        and purchase_history.licensed_major = challenge_record.licensed_major
        and purchase_history.source in ('purchase', 'admin')
    ) then
      return query select 'purchase_inactive'::text, challenge_record.id, null::uuid,
        'purchase'::text, null::timestamptz, false;
      return;
    end if;

    select * into entitlement_record
    from public.commerce_entitlements e
    where e.account_id = p_account_id
      and e.product_slug = challenge_record.product_slug
      and e.source = 'trial'
    limit 1
    for update;

    if entitlement_record.id is null then
      insert into public.commerce_entitlements (
        account_id, source, product_slug, edition, licensed_major, status,
        device_limit, features, valid_from, expires_at
      ) values (
        p_account_id, 'trial', challenge_record.product_slug, challenge_record.edition,
        challenge_record.licensed_major, 'active', offer_record.trial_device_limit,
        offer_record.features, p_now,
        p_now + interval '14 days'
      ) returning * into entitlement_record;
      trial_was_started := true;
    elsif entitlement_record.status <> 'active' or entitlement_record.expires_at <= p_now then
      return query select 'trial_expired'::text, challenge_record.id, entitlement_record.id,
        'trial'::text, entitlement_record.expires_at, false;
      return;
    end if;
  end if;

  update public.commerce_device_activation_challenges
    set status = 'approved', account_id = p_account_id,
        entitlement_id = entitlement_record.id, approved_at = p_now
    where id = challenge_record.id;

  insert into public.commerce_policy_acceptances (
    source, activation_challenge_id, account_id, policy_set_id,
    terms_accepted, compatibility_accepted, accepted_at, ip_hmac,
    user_agent_sha256
  ) values (
    'activation', challenge_record.id, p_account_id, p_policy_set_id,
    true, true, p_now, p_ip_hmac, p_user_agent_sha256
  );

  insert into public.commerce_audit_log (
    actor_type, actor_id, action, target_type, target_id, context
  ) values (
    'customer', p_account_id::text, 'activation.approved', 'activation_challenge',
    challenge_record.id::text,
    jsonb_build_object('entitlementId', entitlement_record.id)
  );

  return query select 'approved'::text, challenge_record.id, entitlement_record.id,
    case when entitlement_record.source = 'trial' then 'trial' else 'purchase' end,
    entitlement_record.expires_at, trial_was_started;
end;
$$;

-- 9b. Trial-to-purchase upgrade respects the one-Mac purchase limit.
-- Identical to the 202607130002 definition except the trial upgrade block.
create or replace function public.commerce_fulfill_paid_checkout(
  p_environment text,
  p_checkout_intent_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text,
  p_stripe_customer_id text,
  p_customer_email text,
  p_currency text,
  p_amount_total integer,
  p_amount_subtotal integer,
  p_amount_tax integer,
  p_amount_discount integer,
  p_presentment_currency text,
  p_presentment_amount integer,
  p_paid_at timestamptz
)
returns table (order_id uuid, entitlement_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent_record public.commerce_checkout_intents%rowtype;
  offer_record public.commerce_offers%rowtype;
  account_record public.commerce_accounts%rowtype;
  email_account_record public.commerce_accounts%rowtype;
  customer_account_record public.commerce_accounts%rowtype;
  locked_account record;
  existing_order public.commerce_orders%rowtype;
  created_order public.commerce_orders%rowtype;
  created_entitlement public.commerce_entitlements%rowtype;
  normalized_email text;
  policy_evidence jsonb;
begin
  normalized_email := lower(btrim(p_customer_email));
  if normalized_email is null
    or normalized_email = ''
    or (p_stripe_customer_id is not null and btrim(p_stripe_customer_id) = '')
    or p_currency is null
    or p_currency !~ '^[a-z]{3}$'
  then
    raise exception 'invalid_fulfillment_identity';
  end if;

  select * into intent_record
  from public.commerce_checkout_intents ci
  where ci.id = p_checkout_intent_id
  for update;
  if intent_record.id is null
    or intent_record.environment <> p_environment
    or intent_record.stripe_checkout_session_id <> p_stripe_checkout_session_id
  then
    raise exception 'checkout_intent_mismatch';
  end if;

  select * into offer_record
  from public.commerce_offers o
  where o.id = intent_record.offer_id
  for share;
  if intent_record.offer_snapshot->>'billingModel' <> 'one_time'
    or intent_record.offer_snapshot->>'currency' <> p_currency
    or (intent_record.offer_snapshot->>'unitAmount')::integer <> p_amount_subtotal
    or p_amount_total < p_amount_subtotal
    or p_amount_discount <> 0
    or ((p_presentment_currency is null) <> (p_presentment_amount is null))
  then
    raise exception 'offer_amount_mismatch';
  end if;

  select * into existing_order
  from public.commerce_orders o
  where o.stripe_checkout_session_id = p_stripe_checkout_session_id;
  if existing_order.id is not null then
    select * into created_entitlement
    from public.commerce_entitlements e where e.order_id = existing_order.id;
    return query select existing_order.id, created_entitlement.id, 'already_fulfilled'::text;
    return;
  end if;

  -- Lock every possible identity match in UUID order so concurrent webhook
  -- workers cannot choose different accounts or deadlock by locking them in a
  -- different email/customer order.
  for locked_account in
    select a.id
    from public.commerce_accounts a
    where lower(a.email) = normalized_email
      or (p_stripe_customer_id is not null and a.stripe_customer_id = p_stripe_customer_id)
    order by a.id
    for update
  loop
    null;
  end loop;

  select * into email_account_record
  from public.commerce_accounts a
  where lower(a.email) = normalized_email;

  if p_stripe_customer_id is not null then
    select * into customer_account_record
    from public.commerce_accounts a
    where a.stripe_customer_id = p_stripe_customer_id;
  end if;

  if email_account_record.id is not null
    and customer_account_record.id is not null
    and email_account_record.id <> customer_account_record.id
  then
    raise exception 'fulfillment_identity_conflict';
  end if;

  -- An existing Stripe customer is already a durable account identity. Never
  -- attach it to a different checkout email, even when that email has not yet
  -- created its own commerce account.
  if customer_account_record.id is not null
    and lower(customer_account_record.email) <> normalized_email
  then
    raise exception 'fulfillment_identity_conflict';
  end if;

  if customer_account_record.id is not null then
    account_record := customer_account_record;
  else
    account_record := email_account_record;
  end if;

  if account_record.id is not null and account_record.stripe_customer_id is null then
    update public.commerce_accounts
      set stripe_customer_id = p_stripe_customer_id
      where id = account_record.id;
  end if;

  select jsonb_build_object(
    'policySetId', ps.id,
    'policySetVersion', ps.version,
    'documents', coalesce(jsonb_agg(jsonb_build_object(
      'type', pd.document_type,
      'version', pd.version,
      'url', pd.canonical_url,
      'sha256', pd.sha256,
      'effectiveAt', pd.effective_at
    ) order by pd.document_type), '[]'::jsonb)
  ) into policy_evidence
  from public.commerce_policy_sets ps
  join public.commerce_policy_documents pd on pd.id in (
    ps.terms_document_id, ps.eula_document_id, ps.privacy_document_id,
    ps.refund_document_id, ps.compatibility_document_id
  )
  where ps.id = intent_record.policy_set_id
  group by ps.id, ps.version;

  insert into public.commerce_orders (
    environment, account_id, claimed_email, checkout_intent_id, offer_id,
    policy_set_id, stripe_checkout_session_id, stripe_payment_intent_id,
    stripe_customer_id, currency, amount_total, amount_subtotal, amount_tax,
    amount_discount, presentment_currency, presentment_amount, status,
    offer_snapshot, policy_snapshot, paid_at,
    refund_eligible_until
  ) values (
    p_environment, account_record.id, normalized_email, intent_record.id,
    offer_record.id, intent_record.policy_set_id, p_stripe_checkout_session_id,
    p_stripe_payment_intent_id, p_stripe_customer_id, p_currency,
    p_amount_total, p_amount_subtotal, p_amount_tax, p_amount_discount,
    lower(p_presentment_currency), p_presentment_amount, 'paid',
    intent_record.offer_snapshot,
    policy_evidence, p_paid_at, p_paid_at + interval '14 days'
  ) returning * into created_order;

  insert into public.commerce_entitlements (
    account_id, claimed_email, order_id, source, product_slug, edition,
    licensed_major, status, device_limit, features, valid_from
  ) values (
    account_record.id, normalized_email, created_order.id, 'purchase',
    intent_record.offer_snapshot->>'product', intent_record.offer_snapshot->>'edition',
    (intent_record.offer_snapshot->>'licensedMajor')::integer,
    'active', (intent_record.offer_snapshot->>'deviceLimit')::integer,
    intent_record.offer_snapshot->'features', p_paid_at
  ) returning * into created_entitlement;

  -- A purchase immediately upgrades Macs activated during the account trial,
  -- but only up to the purchase's device limit (one Mac): the most recently
  -- seen trial Macs move to the purchase and any others are deactivated, so
  -- the paid limit holds. The new entitlement row is created in this
  -- transaction and is not visible to concurrent activations.
  if account_record.id is not null then
    update public.commerce_device_activations a
      set entitlement_id = created_entitlement.id
      where a.id in (
        select ta.id from public.commerce_device_activations ta
        join public.commerce_entitlements trial_entitlement
          on trial_entitlement.id = ta.entitlement_id
        where ta.account_id = account_record.id
          and ta.status = 'active'
          and trial_entitlement.source = 'trial'
          and trial_entitlement.account_id = account_record.id
          and trial_entitlement.product_slug = created_entitlement.product_slug
          and trial_entitlement.edition = created_entitlement.edition
          and trial_entitlement.licensed_major = created_entitlement.licensed_major
        order by ta.last_seen_at desc, ta.id
        limit created_entitlement.device_limit
        for update of ta
      );

    with over_limit as (
      update public.commerce_device_activations a
        set status = 'deactivated', deactivated_at = clock_timestamp(),
            deactivation_reason = 'trial_upgrade_over_limit'
        from public.commerce_entitlements trial_entitlement
        where a.entitlement_id = trial_entitlement.id
          and a.account_id = account_record.id
          and a.status = 'active'
          and trial_entitlement.source = 'trial'
          and trial_entitlement.account_id = account_record.id
          and trial_entitlement.product_slug = created_entitlement.product_slug
          and trial_entitlement.edition = created_entitlement.edition
          and trial_entitlement.licensed_major = created_entitlement.licensed_major
        returning a.id
    )
    insert into public.commerce_audit_log (
      actor_type, actor_id, action, target_type, target_id, reason
    )
      select 'system', null, 'device.deactivated', 'device_activation',
        o.id::text, 'trial_upgrade_over_limit' from over_limit o;

    update public.commerce_entitlements trial_entitlement
      set status = 'expired',
          expires_at = least(trial_entitlement.expires_at, p_paid_at)
      where trial_entitlement.account_id = account_record.id
        and trial_entitlement.source = 'trial'
        and trial_entitlement.product_slug = created_entitlement.product_slug
        and trial_entitlement.edition = created_entitlement.edition
        and trial_entitlement.licensed_major = created_entitlement.licensed_major
        and trial_entitlement.status = 'active';
  end if;

  update public.commerce_checkout_intents
    set state = 'complete'
    where id = intent_record.id;
  update public.commerce_policy_acceptances
    set account_id = account_record.id
    where checkout_intent_id = intent_record.id and account_record.id is not null;

  insert into public.commerce_audit_log (
    actor_type, actor_id, action, target_type, target_id, context
  ) values (
    'stripe', null, 'order.fulfilled', 'order', created_order.id::text,
    jsonb_build_object('checkoutSessionId', p_stripe_checkout_session_id)
  );

  return query select created_order.id, created_entitlement.id, 'fulfilled'::text;
end;
$$;

-- 10. Least privilege.
revoke all on function public.commerce_enforce_purchase_device_limit() from public, anon, authenticated;
revoke all on function public.commerce_purchase_code_entitlement_eligible(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.commerce_private_purchase_email(text) from public, anon, authenticated;
revoke all on function public.commerce_request_purchase_code_email(text) from public, anon, authenticated;
revoke all on function public.commerce_claim_purchase_code_emails(text[]) from public, anon, authenticated;
revoke all on function public.commerce_fulfill_paid_checkout(
  text, uuid, text, text, text, text, text, integer, integer, integer,
  integer, text, integer, timestamptz
) from public, anon, authenticated;
revoke all on function public.commerce_issue_purchase_activation_code(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.commerce_redeem_purchase_code(uuid, text, text, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.commerce_handle_auth_user() from public, anon, authenticated;
revoke all on function public.commerce_claim_account_entitlements(uuid) from public, anon, authenticated;
revoke all on function public.commerce_approve_activation(
  uuid, text, text, uuid, boolean, boolean, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function
  public.commerce_purchase_code_entitlement_eligible(uuid, timestamptz),
  public.commerce_private_purchase_email(text),
  public.commerce_request_purchase_code_email(text),
  public.commerce_claim_purchase_code_emails(text[]),
  public.commerce_fulfill_paid_checkout(
    text, uuid, text, text, text, text, text, integer, integer, integer,
    integer, text, integer, timestamptz
  ),
  public.commerce_issue_purchase_activation_code(uuid, uuid, text),
  public.commerce_redeem_purchase_code(uuid, text, text, text[], timestamptz),
  public.commerce_claim_account_entitlements(uuid),
  public.commerce_approve_activation(
    uuid, text, text, uuid, boolean, boolean, text, text, timestamptz
  ) to service_role;
