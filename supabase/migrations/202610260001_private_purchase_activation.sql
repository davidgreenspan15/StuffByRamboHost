-- Private test purchase activation only. No live entitlement or trial is created.
create table public.commerce_purchase_code_emails (
  order_id uuid primary key references public.commerce_orders(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','uncertain')),
  lease_token uuid,
  attempted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.commerce_purchase_code_emails enable row level security;
alter table public.commerce_purchase_code_emails force row level security;
revoke all on public.commerce_purchase_code_emails from public, anon, authenticated;
grant all on public.commerce_purchase_code_emails to service_role;

create function public.commerce_queue_purchase_code_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source = 'purchase' and new.status = 'active' and new.product_slug = 'gesture-flow'
    and new.edition = 'python-mediapipe' and new.licensed_major = 3
    and exists(select 1 from public.commerce_orders o where o.id = new.order_id
      and o.environment = 'test' and o.status = 'paid') then
    insert into public.commerce_purchase_code_emails(order_id) values(new.order_id)
      on conflict (order_id) do nothing;
  end if;
  return new;
end; $$;
create trigger commerce_purchase_code_after_entitlement
  after insert on public.commerce_entitlements for each row
  execute function public.commerce_queue_purchase_code_email();

-- Eligibility is rechecked at send time, including after refunds or suspensions.
create function public.commerce_private_purchase_email(p_email text)
returns table(order_id uuid, email text)
language sql stable security definer set search_path = '' as $$
  select o.id, coalesce(a.email,e.claimed_email) from public.commerce_entitlements e
  join public.commerce_orders o on o.id=e.order_id
  join public.commerce_offers f on f.id=o.offer_id
  left join public.commerce_accounts a on a.id=e.account_id
  where o.environment='test' and f.environment='test' and f.code='gesture-flow-v3'
    and o.status='paid' and e.source='purchase' and e.status='active'
    and e.product_slug='gesture-flow' and e.edition='python-mediapipe' and e.licensed_major=3
    and e.device_limit=2 and e.valid_from<=clock_timestamp()
    and (e.expires_at is null or e.expires_at>clock_timestamp())
    and coalesce(a.email,e.claimed_email)=lower(btrim(p_email))
  order by o.created_at desc limit 1;
$$;

create function public.commerce_request_purchase_code_email(p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  select q.order_id into target from public.commerce_private_purchase_email(p_email) q;
  if target is null then return; end if;
  insert into public.commerce_purchase_code_emails(order_id) values(target)
    on conflict(order_id) do update set status='pending',lease_token=null,
      attempted_at=null,completed_at=null
    where commerce_purchase_code_emails.status in ('sent','failed','uncertain');
end; $$;

create function public.commerce_claim_purchase_code_emails(p_allowed_emails text[])
returns table(order_id uuid,email text,lease_token uuid)
language plpgsql security definer set search_path = '' as $$
declare r record; new_lease uuid;
begin
  -- A crashed sender might already have delivered its code. Never auto-resend.
  update public.commerce_purchase_code_emails q set status='uncertain'
    where q.status='sending' and q.attempted_at<clock_timestamp()-interval '2 minutes';
  for r in
    select q.order_id, eligible.email from public.commerce_purchase_code_emails q
    join public.commerce_orders o on o.id=q.order_id
    join public.commerce_entitlements e on e.order_id=o.id
    left join public.commerce_accounts a on a.id=e.account_id
    cross join lateral public.commerce_private_purchase_email(coalesce(a.email,e.claimed_email)) eligible
    where q.status='pending' and eligible.order_id=q.order_id and eligible.email=any(p_allowed_emails)
    order by q.created_at limit 5 for update of q skip locked
  loop
    new_lease:=gen_random_uuid();
    update public.commerce_purchase_code_emails q set status='sending',lease_token=new_lease,
      attempted_at=clock_timestamp() where q.order_id=r.order_id;
    return query select r.order_id,r.email,new_lease;
  end loop;
end; $$;

create function public.commerce_complete_purchase_code_email(p_order_id uuid,p_lease_token uuid,p_status text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_status not in ('sent','failed','uncertain') then raise exception 'invalid_email_outcome'; end if;
  update public.commerce_purchase_code_emails set status=p_status,completed_at=clock_timestamp()
    where order_id=p_order_id and lease_token=p_lease_token and status='sending';
  get diagnostics n=row_count;
  return n=1;
end; $$;

create function public.commerce_authorize_purchase_challenge(
  p_challenge_id uuid,p_poll_token_sha256 text,p_account_id uuid,p_email text
) returns text language plpgsql security definer set search_path = '' as $$
declare c public.commerce_device_activation_challenges%rowtype;
        e public.commerce_entitlements%rowtype;
begin
  select * into c from public.commerce_device_activation_challenges where id=p_challenge_id for update;
  if c.id is null or c.poll_token_sha256<>p_poll_token_sha256 or c.expires_at<=clock_timestamp()
    or c.status not in ('pending','approved','consumed')
    or c.product_slug<>'gesture-flow' or c.edition<>'python-mediapipe' or c.licensed_major<>3 then
    return 'invalid';
  end if;
  if not exists(select 1 from public.commerce_accounts a join auth.users u on u.id=a.id
    where a.id=p_account_id and a.email=lower(btrim(p_email))
      and lower(btrim(u.email))=a.email and u.email_confirmed_at is not null) then return 'invalid'; end if;
  -- Lock the purchased entitlement. Email verification alone is insufficient.
  select ent.* into e from public.commerce_entitlements ent
    join public.commerce_orders o on o.id=ent.order_id
    join public.commerce_offers f on f.id=o.offer_id
    where ent.source='purchase' and ent.status='active' and o.status='paid'
      and o.environment='test' and f.environment='test' and f.code='gesture-flow-v3'
      and ent.product_slug=c.product_slug and ent.edition=c.edition and ent.licensed_major=c.licensed_major
      and ent.device_limit=2 and ent.valid_from<=clock_timestamp()
      and (ent.expires_at is null or ent.expires_at>clock_timestamp())
      and (ent.account_id=p_account_id or (ent.account_id is null and ent.claimed_email=lower(btrim(p_email))))
      and (o.account_id is null or o.account_id=p_account_id)
      and (c.status='pending' or (c.entitlement_id=ent.id and c.account_id=p_account_id))
    order by ent.created_at limit 1 for update of ent;
  if e.id is null then return 'purchase_required'; end if;
  if c.status='pending' then
    update public.commerce_entitlements set account_id=p_account_id where id=e.id;
    update public.commerce_orders set account_id=p_account_id where id=e.order_id;
    update public.commerce_device_activation_challenges set status='approved',account_id=p_account_id,
      entitlement_id=e.id,approved_at=clock_timestamp() where id=c.id;
  end if;
  -- The existing exchange RPC locks this same entitlement before counting/inserting
  -- devices, so concurrent redemptions cannot exceed its two-Mac allowance.
  return 'approved';
end; $$;

revoke all on function public.commerce_queue_purchase_code_email() from public,anon,authenticated;
revoke all on function public.commerce_private_purchase_email(text) from public,anon,authenticated;
revoke all on function public.commerce_request_purchase_code_email(text) from public,anon,authenticated;
revoke all on function public.commerce_claim_purchase_code_emails(text[]) from public,anon,authenticated;
revoke all on function public.commerce_complete_purchase_code_email(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.commerce_authorize_purchase_challenge(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.commerce_private_purchase_email(text),
 public.commerce_request_purchase_code_email(text), public.commerce_claim_purchase_code_emails(text[]),
 public.commerce_complete_purchase_code_email(uuid,uuid,text),
 public.commerce_authorize_purchase_challenge(uuid,text,uuid,text) to service_role;
