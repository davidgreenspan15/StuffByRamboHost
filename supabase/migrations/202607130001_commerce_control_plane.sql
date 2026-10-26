-- Gesture Flow commerce and licensing control plane.
-- All browser and device writes go through Edge Functions. The service role is
-- the only role allowed to mutate these tables directly.

create extension if not exists pgcrypto with schema extensions;

create table public.commerce_accounts (
  id uuid primary key references auth.users(id) on delete restrict,
  email text not null,
  stripe_customer_id text unique,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint commerce_accounts_email_normalized check (email = lower(btrim(email)))
);

create unique index commerce_accounts_email_unique
  on public.commerce_accounts (lower(email));

create table public.commerce_policy_documents (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (
    document_type in ('terms_of_sale', 'eula', 'privacy', 'refund', 'compatibility')
  ),
  version text not null,
  canonical_url text not null check (canonical_url ~ '^https://'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz,
  effective_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (document_type, version),
  constraint commerce_policy_publish_dates check (
    published_at is null
    or (effective_at is not null and (retired_at is null or retired_at > effective_at))
  )
);

create table public.commerce_policy_sets (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  terms_document_id uuid not null references public.commerce_policy_documents(id),
  eula_document_id uuid not null references public.commerce_policy_documents(id),
  privacy_document_id uuid not null references public.commerce_policy_documents(id),
  refund_document_id uuid not null references public.commerce_policy_documents(id),
  compatibility_document_id uuid not null references public.commerce_policy_documents(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint commerce_policy_set_dates check (
    retired_at is null or (published_at is not null and retired_at > published_at)
  )
);

create table public.commerce_offers (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  environment text not null check (environment in ('test', 'live')),
  product_slug text not null,
  edition text not null,
  display_name text not null,
  description text not null,
  billing_model text not null check (billing_model in ('one_time', 'subscription')),
  entitlement_type text not null check (entitlement_type in ('perpetual_major', 'subscription')),
  licensed_major integer not null check (licensed_major > 0),
  device_limit integer not null check (device_limit between 1 and 20),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  unit_amount integer not null check (unit_amount >= 0),
  stripe_product_id text,
  stripe_price_id text,
  tax_code text,
  current_policy_set_id uuid not null references public.commerce_policy_sets(id),
  features jsonb not null default '[]'::jsonb check (jsonb_typeof(features) = 'array'),
  compatibility jsonb not null check (jsonb_typeof(compatibility) = 'object'),
  published_at timestamptz,
  checkout_enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (code, environment),
  constraint commerce_offer_publish_ready check (
    not checkout_enabled
    or (
      published_at is not null
      and stripe_product_id is not null
      and stripe_price_id is not null
      and unit_amount > 0
    )
  )
);

create unique index commerce_offers_stripe_price_unique
  on public.commerce_offers (environment, stripe_price_id)
  where stripe_price_id is not null;

create table public.commerce_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('test', 'live')),
  account_id uuid references public.commerce_accounts(id) on delete set null,
  offer_id uuid not null references public.commerce_offers(id),
  offer_snapshot jsonb not null check (jsonb_typeof(offer_snapshot) = 'object'),
  policy_set_id uuid not null references public.commerce_policy_sets(id),
  idempotency_key text not null check (length(idempotency_key) between 16 and 200),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  ip_hmac text check (ip_hmac is null or ip_hmac ~ '^[0-9a-f]{64}$'),
  user_agent_sha256 text check (
    user_agent_sha256 is null or user_agent_sha256 ~ '^[0-9a-f]{64}$'
  ),
  stripe_checkout_session_id text unique,
  stripe_checkout_url text,
  state text not null default 'creating' check (
    state in ('creating', 'open', 'complete', 'expired', 'payment_failed', 'invalid')
  ),
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (environment, idempotency_key)
);

create table public.commerce_policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('checkout', 'activation')),
  checkout_intent_id uuid references public.commerce_checkout_intents(id),
  activation_challenge_id uuid,
  account_id uuid references public.commerce_accounts(id) on delete set null,
  policy_set_id uuid not null references public.commerce_policy_sets(id),
  terms_accepted boolean not null check (terms_accepted),
  refund_policy_accepted boolean,
  compatibility_accepted boolean not null check (compatibility_accepted),
  accepted_at timestamptz not null default clock_timestamp(),
  ip_hmac text check (ip_hmac is null or ip_hmac ~ '^[0-9a-f]{64}$'),
  user_agent_sha256 text check (
    user_agent_sha256 is null or user_agent_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint commerce_policy_acceptance_one_source check (
    (source = 'checkout' and checkout_intent_id is not null and activation_challenge_id is null)
    or
    (source = 'activation' and checkout_intent_id is null and activation_challenge_id is not null)
  ),
  constraint commerce_refund_acceptance_by_source check (
    (source = 'checkout' and refund_policy_accepted is true)
    or (source = 'activation' and refund_policy_accepted is null)
  )
);

create unique index commerce_checkout_policy_acceptance_unique
  on public.commerce_policy_acceptances (checkout_intent_id)
  where checkout_intent_id is not null;

create unique index commerce_activation_policy_acceptance_unique
  on public.commerce_policy_acceptances (activation_challenge_id)
  where activation_challenge_id is not null;

create table public.commerce_orders (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('test', 'live')),
  account_id uuid references public.commerce_accounts(id) on delete set null,
  claimed_email text,
  checkout_intent_id uuid not null unique references public.commerce_checkout_intents(id),
  offer_id uuid not null references public.commerce_offers(id),
  policy_set_id uuid not null references public.commerce_policy_sets(id),
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text unique,
  stripe_customer_id text,
  currency text not null check (currency ~ '^[a-z]{3}$'),
  amount_total integer not null check (amount_total >= 0),
  amount_subtotal integer not null check (amount_subtotal >= 0),
  amount_tax integer not null default 0 check (amount_tax >= 0),
  amount_discount integer not null default 0 check (amount_discount >= 0),
  presentment_currency text check (presentment_currency is null or presentment_currency ~ '^[a-z]{3}$'),
  presentment_amount integer check (presentment_amount is null or presentment_amount >= 0),
  status text not null default 'paid' check (
    status in (
      'paid', 'suspended_refund', 'suspended_dispute', 'refunded',
      'chargeback', 'revoked'
    )
  ),
  offer_snapshot jsonb not null check (jsonb_typeof(offer_snapshot) = 'object'),
  policy_snapshot jsonb not null check (jsonb_typeof(policy_snapshot) = 'object'),
  paid_at timestamptz not null,
  refund_eligible_until timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint commerce_orders_claimed_email_normalized check (
    claimed_email is null or claimed_email = lower(btrim(claimed_email))
  ),
  constraint commerce_orders_presentment_pair check (
    (presentment_currency is null and presentment_amount is null)
    or (presentment_currency is not null and presentment_amount is not null)
  )
);

create index commerce_orders_unclaimed_email_idx
  on public.commerce_orders (lower(claimed_email))
  where account_id is null and claimed_email is not null;

create table public.commerce_entitlements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.commerce_accounts(id) on delete set null,
  claimed_email text,
  order_id uuid unique references public.commerce_orders(id),
  source text not null check (source in ('purchase', 'trial', 'admin')),
  product_slug text not null,
  edition text not null,
  licensed_major integer not null check (licensed_major > 0),
  status text not null default 'active' check (
    status in (
      'active', 'suspended_refund', 'suspended_dispute', 'refunded',
      'revoked_chargeback', 'revoked_admin', 'expired'
    )
  ),
  device_limit integer not null check (device_limit between 1 and 20),
  features jsonb not null default '[]'::jsonb check (jsonb_typeof(features) = 'array'),
  valid_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  admin_revoked_at timestamptz,
  admin_revocation_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint commerce_entitlements_email_normalized check (
    claimed_email is null or claimed_email = lower(btrim(claimed_email))
  ),
  constraint commerce_trial_expiration check (
    (source = 'trial' and expires_at is not null)
    or (source <> 'trial')
  ),
  constraint commerce_admin_revocation check (
    status <> 'revoked_admin'
    or (admin_revoked_at is not null and admin_revocation_reason is not null)
  )
);

create unique index commerce_one_trial_per_account_product
  on public.commerce_entitlements (account_id, product_slug)
  where source = 'trial' and account_id is not null;

create index commerce_entitlements_unclaimed_email_idx
  on public.commerce_entitlements (lower(claimed_email))
  where account_id is null and claimed_email is not null;

create table public.commerce_device_activation_challenges (
  id uuid primary key default gen_random_uuid(),
  product_slug text not null,
  edition text not null,
  licensed_major integer not null check (licensed_major > 0),
  installation_id uuid not null,
  device_public_key text not null check (device_public_key ~ '^[A-Za-z0-9_-]{43}$'),
  device_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(device_metadata) = 'object'),
  legacy_migration jsonb check (
    legacy_migration is null or jsonb_typeof(legacy_migration) = 'object'
  ),
  code_hmac text not null unique check (code_hmac ~ '^[0-9a-f]{64}$'),
  poll_token_sha256 text not null unique check (poll_token_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'consumed', 'expired', 'denied')
  ),
  account_id uuid references public.commerce_accounts(id) on delete set null,
  entitlement_id uuid references public.commerce_entitlements(id),
  approved_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint commerce_activation_challenge_lifetime check (expires_at > created_at),
  constraint commerce_activation_challenge_approval check (
    (status = 'pending' and account_id is null and entitlement_id is null and approved_at is null)
    or status <> 'pending'
  )
);

alter table public.commerce_policy_acceptances
  add constraint commerce_policy_acceptance_activation_challenge_fk
  foreign key (activation_challenge_id)
  references public.commerce_device_activation_challenges(id);

create index commerce_activation_challenge_expiry_idx
  on public.commerce_device_activation_challenges (status, expires_at);

create table public.commerce_device_activations (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.commerce_entitlements(id),
  account_id uuid not null references public.commerce_accounts(id) on delete restrict,
  challenge_id uuid not null unique references public.commerce_device_activation_challenges(id),
  installation_id uuid not null,
  device_public_key text not null check (device_public_key ~ '^[A-Za-z0-9_-]{43}$'),
  device_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(device_metadata) = 'object'),
  status text not null default 'active' check (status in ('active', 'deactivated', 'revoked')),
  activated_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  deactivated_at timestamptz,
  deactivation_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (entitlement_id, installation_id),
  constraint commerce_device_deactivation check (
    (status = 'active' and deactivated_at is null)
    or (status <> 'active' and deactivated_at is not null)
  )
);

create index commerce_device_activations_account_idx
  on public.commerce_device_activations (account_id, status);

create table public.commerce_device_request_nonces (
  activation_id uuid not null references public.commerce_device_activations(id) on delete cascade,
  nonce_sha256 text not null check (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  request_timestamp timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (activation_id, nonce_sha256)
);

create index commerce_device_nonce_expiry_idx
  on public.commerce_device_request_nonces (expires_at);

create table public.commerce_permit_issuances (
  jti uuid primary key,
  activation_id uuid not null references public.commerce_device_activations(id),
  entitlement_id uuid not null references public.commerce_entitlements(id),
  permit_sha256 text not null unique check (permit_sha256 ~ '^[0-9a-f]{64}$'),
  key_id text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint commerce_permit_dates check (expires_at > issued_at)
);

create index commerce_permit_activation_idx
  on public.commerce_permit_issuances (activation_id, issued_at desc);

create table public.commerce_refund_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.commerce_accounts(id) on delete restrict,
  order_id uuid not null references public.commerce_orders(id),
  reason_category text not null check (
    reason_category in ('compatibility', 'technical', 'accidental', 'other')
  ),
  customer_note text check (customer_note is null or length(customer_note) <= 2000),
  status text not null default 'requested' check (
    status in ('requested', 'reviewing', 'approved', 'declined', 'completed', 'canceled')
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create unique index commerce_open_refund_request_unique
  on public.commerce_refund_requests (order_id)
  where status in ('requested', 'reviewing', 'approved');

create table public.commerce_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id),
  refund_request_id uuid references public.commerce_refund_requests(id),
  stripe_refund_id text not null unique,
  amount integer not null check (amount > 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  status text not null check (status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  reason text,
  provider_created_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.commerce_disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id),
  stripe_dispute_id text not null unique,
  stripe_charge_id text not null,
  amount integer not null check (amount > 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  reason text,
  status text not null,
  evidence_due_at timestamptz,
  provider_created_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.commerce_stripe_events (
  stripe_event_id text primary key,
  environment text not null check (environment in ('test', 'live')),
  event_type text not null,
  api_version text,
  object_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'received' check (
    status in ('received', 'processing', 'processed', 'ignored', 'failed', 'dead_letter')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text,
  last_error_at timestamptz,
  processed_at timestamptz,
  retention_until timestamptz not null default (clock_timestamp() + interval '35 days'),
  locked_at timestamptz,
  lease_token uuid,
  received_at timestamptz not null default clock_timestamp()
);

create index commerce_stripe_event_queue_idx
  on public.commerce_stripe_events (status, next_attempt_at, received_at);

create table public.commerce_api_idempotency (
  operation text not null,
  idempotency_key text not null,
  account_id uuid references public.commerce_accounts(id) on delete set null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_status integer,
  response_body jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (operation, idempotency_key)
);

create index commerce_api_idempotency_expiry_idx
  on public.commerce_api_idempotency (expires_at);

create table public.commerce_rate_limits (
  bucket text not null check (bucket ~ '^[a-z0-9_.-]{1,80}$'),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  primary key (bucket, key_hash)
);

create index commerce_rate_limits_expiry_idx
  on public.commerce_rate_limits (expires_at);

create table public.commerce_staff_users (
  account_id uuid primary key references public.commerce_accounts(id) on delete restrict,
  role text not null check (role in ('support', 'finance', 'admin')),
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.commerce_audit_log (
  id bigint generated always as identity primary key,
  actor_type text not null check (actor_type in ('customer', 'device', 'staff', 'system', 'stripe')),
  actor_id text,
  action text not null,
  target_type text not null,
  target_id text,
  reason text,
  request_id text,
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index commerce_audit_target_idx
  on public.commerce_audit_log (target_type, target_id, created_at desc);

create or replace function public.commerce_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger commerce_accounts_touch_updated_at
before update on public.commerce_accounts
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_offers_touch_updated_at
before update on public.commerce_offers
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_checkout_intents_touch_updated_at
before update on public.commerce_checkout_intents
for each row execute function public.commerce_touch_updated_at();

create or replace function public.commerce_protect_checkout_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.offer_snapshot <> old.offer_snapshot
    or new.offer_id <> old.offer_id
    or new.policy_set_id <> old.policy_set_id
    or new.request_sha256 <> old.request_sha256
  then
    raise exception 'checkout_evidence_is_immutable';
  end if;
  return new;
end;
$$;

create trigger commerce_checkout_intents_protect_evidence
before update on public.commerce_checkout_intents
for each row execute function public.commerce_protect_checkout_snapshot();
create trigger commerce_orders_touch_updated_at
before update on public.commerce_orders
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_entitlements_touch_updated_at
before update on public.commerce_entitlements
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_device_activations_touch_updated_at
before update on public.commerce_device_activations
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_refund_requests_touch_updated_at
before update on public.commerce_refund_requests
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_refunds_touch_updated_at
before update on public.commerce_refunds
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_disputes_touch_updated_at
before update on public.commerce_disputes
for each row execute function public.commerce_touch_updated_at();
create trigger commerce_staff_users_touch_updated_at
before update on public.commerce_staff_users
for each row execute function public.commerce_touch_updated_at();

create or replace function public.commerce_reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'immutable_record';
end;
$$;

create trigger commerce_audit_log_immutable
before update or delete on public.commerce_audit_log
for each row execute function public.commerce_reject_immutable_mutation();

create or replace function public.commerce_protect_published_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.published_at is not null then raise exception 'published_policy_is_immutable'; end if;
    return old;
  end if;
  if old.published_at is null then return new; end if;
  if to_jsonb(new) - 'retired_at' = to_jsonb(old) - 'retired_at'
    and old.retired_at is null
    and new.retired_at is not null
    and new.retired_at > greatest(old.published_at, old.effective_at)
  then
    return new;
  end if;
  raise exception 'published_policy_is_immutable';
end;
$$;

create trigger commerce_policy_documents_immutable
before update or delete on public.commerce_policy_documents
for each row execute function public.commerce_protect_published_policy();

create or replace function public.commerce_validate_policy_set_documents()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  reference_time timestamptz;
begin
  if not exists (
      select 1 from public.commerce_policy_documents d
      where d.id = new.terms_document_id and d.document_type = 'terms_of_sale'
    ) or not exists (
      select 1 from public.commerce_policy_documents d
      where d.id = new.eula_document_id and d.document_type = 'eula'
    ) or not exists (
      select 1 from public.commerce_policy_documents d
      where d.id = new.privacy_document_id and d.document_type = 'privacy'
    ) or not exists (
      select 1 from public.commerce_policy_documents d
      where d.id = new.refund_document_id and d.document_type = 'refund'
    ) or not exists (
      select 1 from public.commerce_policy_documents d
      where d.id = new.compatibility_document_id and d.document_type = 'compatibility'
    )
  then
    raise exception 'policy_set_document_type_mismatch';
  end if;

  if new.published_at is not null then
    reference_time := new.published_at;
    if exists (
      select 1
      from public.commerce_policy_documents d
      where d.id in (
        new.terms_document_id, new.eula_document_id, new.privacy_document_id,
        new.refund_document_id, new.compatibility_document_id
      ) and (
        d.published_at is null or d.published_at > reference_time
        or d.effective_at is null or d.effective_at > reference_time
        or (d.retired_at is not null and d.retired_at <= reference_time)
      )
    ) then
      raise exception 'policy_set_contains_inactive_document';
    end if;
  end if;
  return new;
end;
$$;

create trigger commerce_policy_sets_validate_documents
before insert or update on public.commerce_policy_sets
for each row execute function public.commerce_validate_policy_set_documents();

create or replace function public.commerce_policy_set_is_active(
  p_policy_set_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.commerce_policy_sets ps
    join public.commerce_policy_documents terms
      on terms.id = ps.terms_document_id and terms.document_type = 'terms_of_sale'
    join public.commerce_policy_documents eula
      on eula.id = ps.eula_document_id and eula.document_type = 'eula'
    join public.commerce_policy_documents privacy
      on privacy.id = ps.privacy_document_id and privacy.document_type = 'privacy'
    join public.commerce_policy_documents refund
      on refund.id = ps.refund_document_id and refund.document_type = 'refund'
    join public.commerce_policy_documents compatibility
      on compatibility.id = ps.compatibility_document_id
      and compatibility.document_type = 'compatibility'
    where ps.id = p_policy_set_id
      and ps.published_at is not null and ps.published_at <= p_now
      and (ps.retired_at is null or ps.retired_at > p_now)
      and terms.published_at is not null and terms.published_at <= p_now
      and terms.effective_at is not null and terms.effective_at <= p_now
      and (terms.retired_at is null or terms.retired_at > p_now)
      and eula.published_at is not null and eula.published_at <= p_now
      and eula.effective_at is not null and eula.effective_at <= p_now
      and (eula.retired_at is null or eula.retired_at > p_now)
      and privacy.published_at is not null and privacy.published_at <= p_now
      and privacy.effective_at is not null and privacy.effective_at <= p_now
      and (privacy.retired_at is null or privacy.retired_at > p_now)
      and refund.published_at is not null and refund.published_at <= p_now
      and refund.effective_at is not null and refund.effective_at <= p_now
      and (refund.retired_at is null or refund.retired_at > p_now)
      and compatibility.published_at is not null and compatibility.published_at <= p_now
      and compatibility.effective_at is not null and compatibility.effective_at <= p_now
      and (compatibility.retired_at is null or compatibility.retired_at > p_now)
  );
$$;

create or replace function public.commerce_protect_published_policy_set()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.published_at is not null then raise exception 'published_policy_is_immutable'; end if;
    return old;
  end if;
  if old.published_at is null then return new; end if;
  if to_jsonb(new) - 'retired_at' = to_jsonb(old) - 'retired_at'
    and old.retired_at is null
    and new.retired_at is not null
    and new.retired_at > old.published_at
  then
    return new;
  end if;
  raise exception 'published_policy_is_immutable';
end;
$$;

create trigger commerce_policy_sets_immutable
before update or delete on public.commerce_policy_sets
for each row execute function public.commerce_protect_published_policy_set();

create or replace function public.commerce_protect_policy_acceptance_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'policy_acceptance_evidence_is_immutable'; end if;
  if old.account_id is null
    and new.account_id is not null
    and to_jsonb(new) - 'account_id' = to_jsonb(old) - 'account_id'
    and (
      (
        old.source = 'checkout'
        and exists (
          select 1 from public.commerce_orders o
          where o.checkout_intent_id = old.checkout_intent_id
            and o.account_id = new.account_id
        )
      ) or (
        old.source = 'activation'
        and exists (
          select 1 from public.commerce_device_activation_challenges c
          where c.id = old.activation_challenge_id
            and c.account_id = new.account_id
        )
      )
    )
  then
    return new;
  end if;
  raise exception 'policy_acceptance_evidence_is_immutable';
end;
$$;

create trigger commerce_policy_acceptances_protect_evidence
before update or delete on public.commerce_policy_acceptances
for each row execute function public.commerce_protect_policy_acceptance_evidence();

create or replace function public.commerce_protect_order_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'order_evidence_is_immutable'; end if;
  if to_jsonb(new) - array['account_id', 'status', 'updated_at']
      <> to_jsonb(old) - array['account_id', 'status', 'updated_at']
  then
    raise exception 'order_evidence_is_immutable';
  end if;
  if new.account_id is distinct from old.account_id then
    if old.account_id is not null or new.account_id is null or not exists (
      select 1
      from public.commerce_accounts a
      where a.id = new.account_id and a.email = old.claimed_email
    ) then
      raise exception 'invalid_order_account_linkage';
    end if;
  end if;
  return new;
end;
$$;

create trigger commerce_orders_protect_evidence
before update or delete on public.commerce_orders
for each row execute function public.commerce_protect_order_evidence();

create or replace function public.commerce_protect_account_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    raise exception 'commerce_account_email_is_immutable';
  end if;
  return new;
end;
$$;

create trigger commerce_accounts_protect_identity
before update of email on public.commerce_accounts
for each row execute function public.commerce_protect_account_identity();

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

  return new;
end;
$$;

create trigger commerce_auth_user_sync
after insert or update of email on auth.users
for each row execute function public.commerce_handle_auth_user();

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
end;
$$;

create or replace function public.commerce_create_checkout_intent(
  p_environment text,
  p_offer_id uuid,
  p_policy_set_id uuid,
  p_idempotency_key text,
  p_request_sha256 text,
  p_ip_hmac text,
  p_user_agent_sha256 text
)
returns table (
  outcome text,
  intent_id uuid,
  offer_snapshot jsonb,
  stripe_checkout_session_id text,
  stripe_checkout_url text,
  expires_at timestamptz,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent_record public.commerce_checkout_intents%rowtype;
  offer_record public.commerce_offers%rowtype;
begin
  select * into offer_record from public.commerce_offers o where o.id = p_offer_id for share;
  if offer_record.id is null
    or offer_record.environment <> p_environment
    or offer_record.checkout_enabled is not true
    or offer_record.published_at is null
    or offer_record.published_at > clock_timestamp()
  then
    raise exception 'offer_not_found';
  end if;
  if offer_record.current_policy_set_id <> p_policy_set_id
    or not public.commerce_policy_set_is_active(p_policy_set_id, clock_timestamp())
  then
    raise exception 'invalid_policy_set';
  end if;
  insert into public.commerce_checkout_intents (
    environment, offer_id, offer_snapshot, policy_set_id, idempotency_key, request_sha256,
    ip_hmac, user_agent_sha256, state
  ) values (
    p_environment, p_offer_id,
    jsonb_build_object(
      'code', offer_record.code,
      'product', offer_record.product_slug,
      'edition', offer_record.edition,
      'billingModel', offer_record.billing_model,
      'entitlementType', offer_record.entitlement_type,
      'licensedMajor', offer_record.licensed_major,
      'deviceLimit', offer_record.device_limit,
      'currency', offer_record.currency,
      'unitAmount', offer_record.unit_amount,
      'stripeProductId', offer_record.stripe_product_id,
      'stripePriceId', offer_record.stripe_price_id,
      'taxCode', offer_record.tax_code,
      'features', offer_record.features,
      'compatibility', offer_record.compatibility
    ),
    p_policy_set_id, p_idempotency_key,
    p_request_sha256, p_ip_hmac, p_user_agent_sha256, 'creating'
  )
  on conflict (environment, idempotency_key) do nothing;

  select * into intent_record
  from public.commerce_checkout_intents ci
  where ci.environment = p_environment and ci.idempotency_key = p_idempotency_key
  for update;

  if intent_record.request_sha256 <> p_request_sha256
    or intent_record.offer_id <> p_offer_id
    or intent_record.policy_set_id <> p_policy_set_id
  then
    return query select 'conflict'::text, intent_record.id, intent_record.offer_snapshot,
      intent_record.stripe_checkout_session_id, intent_record.stripe_checkout_url,
      intent_record.expires_at, intent_record.state;
    return;
  end if;

  insert into public.commerce_policy_acceptances (
    source, checkout_intent_id, policy_set_id, terms_accepted,
    refund_policy_accepted, compatibility_accepted, ip_hmac,
    user_agent_sha256
  ) values (
    'checkout', intent_record.id, p_policy_set_id, true, true, true,
    p_ip_hmac, p_user_agent_sha256
  )
  on conflict (checkout_intent_id) where checkout_intent_id is not null do nothing;

  return query select 'ready'::text, intent_record.id, intent_record.offer_snapshot,
    intent_record.stripe_checkout_session_id, intent_record.stripe_checkout_url,
    intent_record.expires_at, intent_record.state;
end;
$$;

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
        challenge_record.licensed_major, 'active', offer_record.device_limit,
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

create or replace function public.commerce_deactivate_activation(
  p_activation_id uuid,
  p_account_id uuid,
  p_actor_type text,
  p_reason text,
  p_now timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_actor_type not in ('customer', 'device', 'staff', 'system') then
    raise exception 'invalid_actor_type';
  end if;

  update public.commerce_device_activations
    set status = 'deactivated', deactivated_at = p_now,
        deactivation_reason = left(p_reason, 500)
    where id = p_activation_id
      and status = 'active'
      and (p_account_id is null or account_id = p_account_id);
  get diagnostics affected = row_count;

  if affected = 1 then
    insert into public.commerce_audit_log (
      actor_type, actor_id, action, target_type, target_id, reason
    ) values (
      p_actor_type, p_account_id::text, 'device.deactivated',
      'device_activation', p_activation_id::text, left(p_reason, 500)
    );
  end if;

  return affected = 1;
end;
$$;

create or replace function public.commerce_recompute_order(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_record public.commerce_orders%rowtype;
  entitlement_record public.commerce_entitlements%rowtype;
  successful_refunds bigint;
  pending_refunds bigint;
  has_open_dispute boolean;
  has_lost_dispute boolean;
  next_order_status text;
  next_entitlement_status text;
begin
  select * into order_record
  from public.commerce_orders o
  where o.id = p_order_id
  for update;

  if order_record.id is null then
    raise exception 'order_not_found';
  end if;

  select coalesce(sum(amount) filter (where status = 'succeeded'), 0),
         coalesce(sum(amount) filter (where status in ('pending', 'requires_action')), 0)
    into successful_refunds, pending_refunds
  from public.commerce_refunds
  where order_id = p_order_id;

  select coalesce(bool_or(status not in ('won', 'lost', 'warning_closed')), false),
         coalesce(bool_or(status = 'lost'), false)
    into has_open_dispute, has_lost_dispute
  from public.commerce_disputes
  where order_id = p_order_id;

  select * into entitlement_record
  from public.commerce_entitlements e
  where e.order_id = p_order_id
  for update;

  if entitlement_record.status = 'revoked_admin' then
    next_order_status := 'revoked';
    next_entitlement_status := 'revoked_admin';
  elsif successful_refunds >= order_record.amount_total then
    next_order_status := 'refunded';
    next_entitlement_status := 'refunded';
  elsif has_lost_dispute then
    next_order_status := 'chargeback';
    next_entitlement_status := 'revoked_chargeback';
  elsif has_open_dispute then
    next_order_status := 'suspended_dispute';
    next_entitlement_status := 'suspended_dispute';
  elsif successful_refunds + pending_refunds >= order_record.amount_total
    and pending_refunds > 0
  then
    next_order_status := 'suspended_refund';
    next_entitlement_status := 'suspended_refund';
  else
    next_order_status := 'paid';
    next_entitlement_status := 'active';
  end if;

  update public.commerce_orders set status = next_order_status where id = p_order_id;
  update public.commerce_entitlements
    set status = next_entitlement_status
    where order_id = p_order_id;

  if successful_refunds >= order_record.amount_total then
    update public.commerce_refund_requests
      set status = 'completed'
      where order_id = p_order_id
        and status in ('requested', 'reviewing', 'approved');
  end if;

  return next_order_status;
end;
$$;

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
  existing_order public.commerce_orders%rowtype;
  created_order public.commerce_orders%rowtype;
  created_entitlement public.commerce_entitlements%rowtype;
  normalized_email text;
  policy_evidence jsonb;
begin
  normalized_email := lower(btrim(p_customer_email));
  if normalized_email = '' or p_currency !~ '^[a-z]{3}$' then
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

  select * into account_record
  from public.commerce_accounts a
  where lower(a.email) = normalized_email
    or (p_stripe_customer_id is not null and a.stripe_customer_id = p_stripe_customer_id)
  order by case when a.stripe_customer_id = p_stripe_customer_id then 0 else 1 end
  limit 1
  for update;

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

create or replace function public.commerce_claim_stripe_events(
  p_limit integer default 20,
  p_now timestamptz default clock_timestamp()
)
returns setof public.commerce_stripe_events
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'invalid_event_claim_limit'; end if;
  return query
  with claimed as (
    select se.stripe_event_id
    from public.commerce_stripe_events se
    where (
      se.status in ('received', 'failed')
      or (se.status = 'processing' and se.next_attempt_at <= p_now)
    ) and se.next_attempt_at <= p_now
    order by se.received_at
    for update skip locked
    limit p_limit
  )
  update public.commerce_stripe_events se
    set status = 'processing', attempts = se.attempts + 1,
        locked_at = p_now, lease_token = extensions.gen_random_uuid(),
        next_attempt_at = p_now + interval '5 minutes'
    from claimed
    where se.stripe_event_id = claimed.stripe_event_id
    returning se.*;
end;
$$;

create or replace function public.commerce_complete_stripe_event(
  p_stripe_event_id text,
  p_lease_token uuid,
  p_outcome text,
  p_next_attempt_at timestamptz,
  p_error_code text,
  p_now timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if p_outcome not in ('processed', 'ignored', 'failed', 'dead_letter') then
    raise exception 'invalid_stripe_event_outcome';
  end if;
  if p_outcome in ('processed', 'ignored') and p_error_code is not null then
    raise exception 'successful_event_must_not_have_error';
  end if;
  if p_outcome in ('failed', 'dead_letter')
    and (p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,100}$')
  then
    raise exception 'failed_event_requires_safe_error_code';
  end if;
  if p_outcome = 'failed' and (p_next_attempt_at is null or p_next_attempt_at <= p_now) then
    raise exception 'failed_event_requires_future_retry';
  end if;

  update public.commerce_stripe_events
    set status = p_outcome,
        next_attempt_at = case
          when p_outcome = 'failed' then p_next_attempt_at
          else p_now
        end,
        last_error_code = case
          when p_outcome in ('failed', 'dead_letter') then p_error_code
          else null
        end,
        last_error_at = case
          when p_outcome in ('failed', 'dead_letter') then p_now
          else null
        end,
        processed_at = case
          when p_outcome in ('processed', 'ignored') then p_now
          else null
        end,
        locked_at = null,
        lease_token = null
    where stripe_event_id = p_stripe_event_id
      and status = 'processing'
      and lease_token = p_lease_token;
  get diagnostics updated_count = row_count;

  if updated_count = 1 and p_outcome = 'dead_letter' then
    insert into public.commerce_audit_log (
      actor_type, action, target_type, target_id, reason, context
    ) values (
      'system', 'stripe_event.dead_lettered', 'stripe_event', p_stripe_event_id,
      p_error_code, jsonb_build_object('requiresManualResolution', true)
    );
  end if;
  return updated_count = 1;
end;
$$;

create or replace function public.commerce_consume_rate_limit(
  p_bucket text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz default clock_timestamp()
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  rate_record public.commerce_rate_limits%rowtype;
  window_interval interval;
begin
  if p_bucket !~ '^[a-z0-9_.-]{1,80}$'
    or p_key_hash !~ '^[0-9a-f]{64}$'
    or p_limit < 1 or p_limit > 10000
    or p_window_seconds < 1 or p_window_seconds > 604800
  then
    raise exception 'invalid_rate_limit_parameters';
  end if;

  window_interval := make_interval(secs => p_window_seconds);
  insert into public.commerce_rate_limits (
    bucket, key_hash, window_started_at, request_count, expires_at
  ) values (
    p_bucket, p_key_hash, p_now, 1, p_now + window_interval * 2
  )
  on conflict (bucket, key_hash) do update
  set window_started_at = case
        when public.commerce_rate_limits.window_started_at + window_interval <= p_now
          then p_now
        else public.commerce_rate_limits.window_started_at
      end,
      request_count = case
        when public.commerce_rate_limits.window_started_at + window_interval <= p_now
          then 1
        else public.commerce_rate_limits.request_count + 1
      end,
      expires_at = p_now + window_interval * 2
  returning * into rate_record;

  return query select
    rate_record.request_count <= p_limit,
    greatest(0, p_limit - rate_record.request_count),
    case when rate_record.request_count <= p_limit then 0
      else greatest(1, ceil(extract(epoch from (
        rate_record.window_started_at + window_interval - p_now
      )))::integer)
    end;
end;
$$;

create or replace function public.commerce_run_retention(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  nonce_count integer;
  rate_count integer;
  idempotency_count integer;
  challenge_count integer;
  challenge_scrub_count integer;
  stripe_event_count integer;
begin
  delete from public.commerce_device_request_nonces where expires_at <= p_now;
  get diagnostics nonce_count = row_count;
  delete from public.commerce_rate_limits where expires_at <= p_now;
  get diagnostics rate_count = row_count;
  delete from public.commerce_api_idempotency where expires_at <= p_now;
  get diagnostics idempotency_count = row_count;
  delete from public.commerce_device_activation_challenges c
    where c.expires_at <= p_now - interval '24 hours'
      and not exists (
        select 1 from public.commerce_device_activations a where a.challenge_id = c.id
      )
      and not exists (
        select 1 from public.commerce_policy_acceptances pa
        where pa.activation_challenge_id = c.id
      );
  get diagnostics challenge_count = row_count;
  update public.commerce_device_activation_challenges c
    set status = case when c.status in ('pending', 'approved') then 'expired' else c.status end,
        code_hmac = encode(extensions.digest('retained-code:' || c.id::text, 'sha256'), 'hex'),
        poll_token_sha256 = encode(extensions.digest('retained-poll:' || c.id::text, 'sha256'), 'hex'),
        device_public_key = translate(
          rtrim(encode(extensions.digest('retained-key:' || c.id::text, 'sha256'), 'base64'), '='),
          '+/', '-_'
        ),
        device_metadata = '{"retainedPolicyEvidence":true}'::jsonb,
        legacy_migration = null
    where c.expires_at <= p_now - interval '24 hours'
      and (
        exists (
          select 1 from public.commerce_device_activations a where a.challenge_id = c.id
        ) or exists (
          select 1 from public.commerce_policy_acceptances pa
          where pa.activation_challenge_id = c.id
        )
      )
      and (
        c.legacy_migration is not null
        or c.device_metadata <> '{"retainedPolicyEvidence":true}'::jsonb
        or c.code_hmac <> encode(
          extensions.digest('retained-code:' || c.id::text, 'sha256'), 'hex'
        )
      );
  get diagnostics challenge_scrub_count = row_count;
  -- Failed, dead-lettered, and in-flight events are unresolved financial work.
  -- They are retained until an operator safely resolves them; only completed
  -- or explicitly ignored envelopes are eligible for routine deletion.
  delete from public.commerce_stripe_events
    where retention_until <= p_now and status in ('processed', 'ignored');
  get diagnostics stripe_event_count = row_count;
  return jsonb_build_object(
    'deviceNonces', nonce_count,
    'rateLimits', rate_count,
    'idempotencyRecords', idempotency_count,
    'unlinkedChallenges', challenge_count,
    'policyEvidenceChallengesScrubbed', challenge_scrub_count,
    'stripeEvents', stripe_event_count
  );
end;
$$;

-- Row-level security is enabled and forced even on data only reachable through
-- server-side APIs. This makes accidental client grants fail closed.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'commerce_accounts', 'commerce_policy_documents', 'commerce_policy_sets',
    'commerce_offers', 'commerce_checkout_intents', 'commerce_policy_acceptances',
    'commerce_orders', 'commerce_entitlements', 'commerce_device_activation_challenges',
    'commerce_device_activations', 'commerce_device_request_nonces',
    'commerce_permit_issuances', 'commerce_refund_requests', 'commerce_refunds',
    'commerce_disputes', 'commerce_stripe_events', 'commerce_api_idempotency',
    'commerce_rate_limits', 'commerce_staff_users', 'commerce_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
  end loop;
end;
$$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.commerce_claim_account_entitlements(uuid) to service_role;
grant execute on function public.commerce_create_checkout_intent(
  text, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.commerce_approve_activation(
  uuid, text, text, uuid, boolean, boolean, text, text, timestamptz
) to service_role;
grant execute on function public.commerce_exchange_activation(uuid, text, timestamptz) to service_role;
grant execute on function public.commerce_deactivate_activation(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.commerce_recompute_order(uuid) to service_role;
grant execute on function public.commerce_fulfill_paid_checkout(
  text, uuid, text, text, text, text, text, integer, integer, integer,
  integer, text, integer, timestamptz
) to service_role;
grant execute on function public.commerce_claim_stripe_events(integer, timestamptz) to service_role;
grant execute on function public.commerce_complete_stripe_event(
  text, uuid, text, timestamptz, text, timestamptz
) to service_role;
grant execute on function public.commerce_consume_rate_limit(
  text, text, integer, integer, timestamptz
) to service_role;
grant execute on function public.commerce_run_retention(timestamptz) to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
