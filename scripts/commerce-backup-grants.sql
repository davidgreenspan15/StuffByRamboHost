-- Reviewed, read-only backup role. Run with the project administrator.
-- Set LOGIN + a fresh password separately with bound provider parameters.
-- Never embed that password here or in a console command.
\set ON_ERROR_STOP on
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='commerce_backup') then
    create role commerce_backup nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;
revoke all on database postgres from commerce_backup;
grant connect on database postgres to commerce_backup;
grant usage on schema public, auth, supabase_migrations to commerce_backup;
grant select on all tables in schema public, auth, supabase_migrations to commerce_backup;
grant select on all sequences in schema public, auth, supabase_migrations to commerce_backup;
-- pg_dump runs --enable-row-security; these SELECT-only policies let this
-- non-writing role export complete rows without granting BYPASSRLS/service_role.
do $$ declare t record; begin
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','auth','supabase_migrations') and c.relkind in ('r','p')
      and c.relrowsecurity loop
    execute format('drop policy if exists commerce_backup_read on %I.%I',t.nspname,t.relname);
    execute format('create policy commerce_backup_read on %I.%I as permissive for select to commerce_backup using (true)',t.nspname,t.relname);
  end loop;
end $$;
-- New tables need review and this grant script rerun; do not silently grant
-- future tables in unrelated schemas. Backup preflight rejects missing grants.
commit;
