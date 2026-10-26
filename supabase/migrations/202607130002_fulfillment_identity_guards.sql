-- Fail closed when Stripe customer identity and normalized email point at
-- different commerce accounts. This corrective migration intentionally
-- replaces only the fulfillment function from migration 001.

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

  -- A purchase immediately upgrades Macs activated during the account trial.
  -- The entitlement row is locked by this transaction and a trial can have at
  -- most the same two active Macs, so the paid device limit is preserved.
  if account_record.id is not null then
    update public.commerce_device_activations a
      set entitlement_id = created_entitlement.id
      from public.commerce_entitlements trial_entitlement
      where a.entitlement_id = trial_entitlement.id
        and a.account_id = account_record.id
        and a.status = 'active'
        and trial_entitlement.source = 'trial'
        and trial_entitlement.account_id = account_record.id
        and trial_entitlement.product_slug = created_entitlement.product_slug
        and trial_entitlement.edition = created_entitlement.edition
        and trial_entitlement.licensed_major = created_entitlement.licensed_major;

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
