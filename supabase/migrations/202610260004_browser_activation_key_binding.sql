-- SEC-003: close the browser activation key-replacement path.
-- Corrective migration; previously deployed migrations stay unchanged.
-- Same-key recovery and explicitly deactivated device transfers remain valid.

create or replace function public.commerce_exchange_activation(
  p_challenge_id uuid,
  p_poll_token_sha256 text,
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  challenge_record public.commerce_device_activation_challenges%rowtype;
  entitlement_record public.commerce_entitlements%rowtype;
  activation_record public.commerce_device_activations%rowtype;
  active_device_count integer;
begin
  select * into challenge_record
  from public.commerce_device_activation_challenges c
  where c.id = p_challenge_id
  for update;

  if challenge_record.id is null
    or challenge_record.poll_token_sha256 <> p_poll_token_sha256
  then
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::integer, null::integer,
      null::jsonb, null::uuid, null::timestamptz;
    return;
  end if;

  if challenge_record.expires_at <= p_now then
    update public.commerce_device_activation_challenges
      set status = 'expired'
      where id = challenge_record.id and status in ('pending', 'approved');
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::integer, null::integer,
      null::jsonb, challenge_record.installation_id, null::timestamptz;
    return;
  end if;

  if challenge_record.status = 'pending' then
    return query select 'pending'::text, null::uuid, null::uuid, null::uuid,
      null::text, challenge_record.product_slug, challenge_record.edition,
      challenge_record.licensed_major, null::integer, null::jsonb,
      challenge_record.installation_id, null::timestamptz;
    return;
  end if;

  if challenge_record.status not in ('approved', 'consumed') then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid,
      null::text, challenge_record.product_slug, challenge_record.edition,
      challenge_record.licensed_major, null::integer, null::jsonb,
      challenge_record.installation_id, null::timestamptz;
    return;
  end if;

  select * into entitlement_record
  from public.commerce_entitlements e
  where e.id = challenge_record.entitlement_id
  for update;

  if entitlement_record.id is null
    or entitlement_record.status <> 'active'
    or entitlement_record.valid_from > p_now
    or (entitlement_record.expires_at is not null and entitlement_record.expires_at <= p_now)
  then
    return query select 'entitlement_inactive'::text, null::uuid,
      challenge_record.account_id, challenge_record.entitlement_id,
      null::text, challenge_record.product_slug, challenge_record.edition,
      challenge_record.licensed_major, null::integer, null::jsonb,
      challenge_record.installation_id, entitlement_record.expires_at;
    return;
  end if;

  select * into activation_record
  from public.commerce_device_activations a
  where a.entitlement_id = entitlement_record.id
    and a.installation_id = challenge_record.installation_id
  for update;

  -- A consumed poll bearer is idempotent only while the exact activation it
  -- created is still active. It must never reactivate a deactivated device or
  -- follow an activation that was rebound to another entitlement.
  if challenge_record.status = 'consumed' then
    if activation_record.id is null
      or activation_record.status <> 'active'
      or activation_record.challenge_id <> challenge_record.id
      or activation_record.device_public_key <> challenge_record.device_public_key
    then
      return query select 'denied'::text, null::uuid,
        entitlement_record.account_id, entitlement_record.id, entitlement_record.source,
        entitlement_record.product_slug, entitlement_record.edition,
        entitlement_record.licensed_major, entitlement_record.device_limit,
        entitlement_record.features, challenge_record.installation_id,
        entitlement_record.expires_at;
      return;
    end if;
    return query select 'active'::text, activation_record.id,
      entitlement_record.account_id, entitlement_record.id, entitlement_record.source,
      entitlement_record.product_slug, entitlement_record.edition,
      entitlement_record.licensed_major, entitlement_record.device_limit,
      entitlement_record.features, activation_record.installation_id,
      entitlement_record.expires_at;
    return;
  end if;

  -- An installation UUID is client-provided, not proof of device identity.
  -- Preserve an active slot's public key even after browser approval. A key
  -- change must follow explicit deactivation, matching purchase-code behavior.
  if activation_record.id is not null and activation_record.status = 'active'
    and activation_record.device_public_key <> challenge_record.device_public_key
  then
    return query select 'device_key_conflict'::text, null::uuid,
      entitlement_record.account_id, entitlement_record.id, entitlement_record.source,
      entitlement_record.product_slug, entitlement_record.edition,
      entitlement_record.licensed_major, entitlement_record.device_limit,
      entitlement_record.features, challenge_record.installation_id,
      entitlement_record.expires_at;
    return;
  end if;

  if activation_record.id is not null and activation_record.status = 'active' then
    update public.commerce_device_activations
      set challenge_id = challenge_record.id,
          device_public_key = challenge_record.device_public_key,
          device_metadata = challenge_record.device_metadata,
          last_seen_at = p_now
      where id = activation_record.id
      returning * into activation_record;
    update public.commerce_device_activation_challenges
      set status = 'consumed', consumed_at = p_now
      where id = challenge_record.id;
  else
    select count(*) into active_device_count
    from public.commerce_device_activations a
    where a.entitlement_id = entitlement_record.id and a.status = 'active';

    if active_device_count >= entitlement_record.device_limit then
      return query select 'device_limit'::text, null::uuid,
        entitlement_record.account_id, entitlement_record.id, entitlement_record.source,
        entitlement_record.product_slug, entitlement_record.edition,
        entitlement_record.licensed_major, entitlement_record.device_limit,
        entitlement_record.features, challenge_record.installation_id,
        entitlement_record.expires_at;
      return;
    end if;

    if activation_record.id is null then
      insert into public.commerce_device_activations (
        entitlement_id, account_id, challenge_id, installation_id,
        device_public_key, device_metadata, status, activated_at, last_seen_at
      ) values (
        entitlement_record.id, entitlement_record.account_id, challenge_record.id,
        challenge_record.installation_id, challenge_record.device_public_key,
        challenge_record.device_metadata, 'active', p_now, p_now
      ) returning * into activation_record;
    else
      update public.commerce_device_activations
        set challenge_id = challenge_record.id,
            device_public_key = challenge_record.device_public_key,
            device_metadata = challenge_record.device_metadata,
            status = 'active', activated_at = p_now, last_seen_at = p_now,
            deactivated_at = null, deactivation_reason = null
        where id = activation_record.id
        returning * into activation_record;
    end if;

    update public.commerce_device_activation_challenges
      set status = 'consumed', consumed_at = p_now
      where id = challenge_record.id;

    insert into public.commerce_audit_log (
      actor_type, actor_id, action, target_type, target_id, context
    ) values (
      'system', null, 'device.activated', 'device_activation', activation_record.id::text,
      jsonb_build_object('entitlementId', entitlement_record.id)
    );
  end if;

  return query select 'active'::text, activation_record.id,
    entitlement_record.account_id, entitlement_record.id, entitlement_record.source,
    entitlement_record.product_slug, entitlement_record.edition,
    entitlement_record.licensed_major, entitlement_record.device_limit,
    entitlement_record.features, activation_record.installation_id,
    entitlement_record.expires_at;
end;
$$;

revoke all on function public.commerce_exchange_activation(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.commerce_exchange_activation(uuid, text, timestamptz) to service_role;
