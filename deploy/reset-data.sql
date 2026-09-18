-- Manual maintenance only. Never add this file to the migration manifest.
-- psql -v apply=false previews by performing the reset in a rolled-back transaction.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '15s';

-- Users and access control, including attributes used by rule-based groups.
create temporary table reset_keep (name text primary key) on commit drop;
insert into reset_keep values
  ('public.users'), ('public.profiles'), ('public.student_attributes'),
  ('public.role_definition'), ('public.role_permission'),
  -- Action-level RBAC (72_rbac_actions.sql). Without these lines a data reset
  -- would silently empty the permission matrix and the enforcement kill
  -- switch: this file truncates every public/echo/dorm table NOT listed here,
  -- and role_module_permission would go even though its parent role_definition
  -- stays. Keep this list in step with any new RBAC table.
  ('public.rbac_action'), ('public.module_definition'),
  ('public.role_module_permission'), ('public.rbac_permission_audit'),
  ('public.rbac_setting'), ('public.rbac_rpc_guard'),
  ('public.rbacx_table_module'),
  ('public.user_group'), ('public.user_group_member'), ('public.group_permission'),
  ('echo.role_grant'), ('dorm.role_grant'),
  -- Scoped grants need these referenced records; unused rows are removed below.
  ('echo.org_unit'), ('dorm.building'), ('dorm.site'),
  ('dorm.landlord'), ('dorm.tenure');

do $$
declare
  targets text;
begin
  -- Explicit schemas keep Supabase Auth, Storage and migration history intact.
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
    into targets
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'echo', 'dorm')
     and c.relkind in ('r', 'p') and not c.relispartition
     and not exists (select 1 from reset_keep k where k.name = n.nspname || '.' || c.relname)
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');
  if targets is null then raise exception 'No application tables found'; end if;
  raise notice 'Clearing: %', targets;
  -- Never CASCADE: a new dependency on a protected table must fail safely.
  execute 'truncate table ' || targets || ' restart identity restrict';
end $$;

-- Links to deleted business records must not survive on retained accounts.
update public.profiles set "studentId" = null, "agencyId" = null
 where "studentId" is not null or "agencyId" is not null;
update public.users set "agencyId" = null where "agencyId" is not null;

-- Keep only the scope records required by existing RBAC grants. Never turn a
-- scoped grant into a global grant by setting its scope to NULL.
delete from dorm.building b where not exists
  (select 1 from dorm.role_grant g where g.scope_building = b.id);
delete from dorm.site s where not exists
  (select 1 from dorm.building b where b.site_id = s.id);
delete from dorm.landlord l where not exists
  (select 1 from dorm.building b where b.landlord_id = l.id);
delete from dorm.tenure t where not exists
  (select 1 from dorm.building b where b.tenure = t.code);

-- Prune leaves first because the organization hierarchy uses ON DELETE RESTRICT.
do $$
declare removed integer;
begin
  loop
    delete from echo.org_unit o
     where not exists (select 1 from echo.role_grant g where g.scope_org = o.id)
       and not exists (select 1 from echo.org_unit child where child.parent_id = o.id);
    get diagnostics removed = row_count;
    exit when removed = 0;
  end loop;
end $$;

select 'auth.users' as preserved, count(*) as rows from auth.users
union all select 'public.profiles', count(*) from public.profiles
union all select 'public.role_definition', count(*) from public.role_definition
union all select 'public.role_permission', count(*) from public.role_permission
union all select 'public.role_module_permission', count(*) from public.role_module_permission
union all select 'public.module_definition', count(*) from public.module_definition
union all select 'echo.role_grant', count(*) from echo.role_grant
union all select 'dorm.role_grant', count(*) from dorm.role_grant
union all select 'echo.org_unit (RBAC scopes)', count(*) from echo.org_unit
union all select 'dorm.building (RBAC scopes)', count(*) from dorm.building;

\if :apply
commit;
\echo 'Application data reset committed.'
\else
rollback;
\echo 'Preview complete: all database changes rolled back.'
\endif
