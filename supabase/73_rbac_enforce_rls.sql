-- ============================================================================
-- 73_rbac_enforce_rls.sql — modul-akció kapu a TÁBLÁKON (2. réteg)
-- ----------------------------------------------------------------------------
-- EZ AZ A LÉPÉS, AMI A NYERS API-HÍVÁST IS MEGFOGJA.
--   A 72-es adatot és függvényeket hozott, a 74-es az RPC-ket őrzi. Ami
--   kimaradt: a PostgREST-en át közvetlenül a táblára küldött írás
--   (POST/PATCH/DELETE /rest/v1/<tabla>). Azt csak RLS tudja megfogni.
--
-- MIÉRT RESTRIKTÍV POLICY
--   A Postgres a PERMISSZÍV policy-ket VAGY-olja: a 11-es 86 rbac_ policy-je
--   mellé egy újabb permisszív policy csak LAZÍTANI tudna. A restriktív
--   policy-k viszont ÉS-elődnek a permisszív halmazzal, tehát csak SZIGORÍTANI
--   tudnak. Ez nem új ötlet a kódbázisban: a 29_agency.sql már használ
--   `as restrictive for all to authenticated` policy-t ügynökség-izolációra.
--
--   A két réteg munkamegosztása egy mondatban:
--     a permisszív rbac_ réteg dönti el, MELYIK SOROKAT;
--     a restriktív rbacx_ réteg azt, hogy EZ A SZEREPKÖR EGYÁLTALÁN VÉGEZHETI-E
--     EZT A MŰVELETET.
--   A restriktív predikátum ezért szándékosan SOR-FÜGGETLEN — és épp ez teszi
--   biztonságossá: a sor-kaput továbbra is a permisszív réteg tartja.
--
-- MIT NEM CSINÁL — ÉS EZ A LÉNYEG
--
--   • NEM tesz fel EGYETLEN restriktív SELECT policy-t sem. Ez szándékos, és
--     nem óvatoskodás: a restriktív SELECT az UPDATE/DELETE `USING` olvasására
--     ÉS a RETURNING-re is hat, a kódbázis pedig végig
--     `.insert(row).select().single()` alakot használ (app.jsx:246-250,
--     features/data-layer.jsx). Egy szerepkör, amelynek van CREATE joga de
--     nincs VIEW-ja, így nem az olvasást, hanem MAGÁT AZ ÍRÁST veszítené el.
--     Az olvasás szigorítása amúgy sem itt a nyereség: a 11-es permisszív
--     rétege a sorokat már ma is tulajdonlás szerint szűri.
--
--   • NEM nyúl az ÖNKISZOLGÁLÓ műveletekhez. Az 1. fázis kizárólag olyan
--     (tábla, művelet) párt szigorít, amelynek permisszív alapszabálya MA IS
--     ügyintézői (is_staff / is_admin / is_admissions / is_finance).
--     Ebből következik a réteg legfontosabb tulajdonsága:
--
--         A STUDENT és az AGENT viselkedése DEFINÍCIÓ SZERINT nem változhat.
--
--     Ezt nem mérni kell, hanem katalógus-lekérdezéssel bizonyítani — lásd a
--     4. szakaszt, és a 2. szakasz KIMARAD-listáját.
--
--   • NEM nyúl az `admission_processes` és a `process_messages` beszúrásához és
--     módosításához. ITT VAN A LEGÉLESEBB CSAPDA: a rbac_can() JÓVÁHAGYÁST kér
--     (is_approved), a rbac_admission_processes_insert/_update viszont NEM:
--         with check (public.is_staff() or lower(owner_email) = public.my_email())
--     A JÓVÁHAGYÁS ELŐTTI jelentkező itt hozza létre és szerkeszti a saját
--     folyamatát. Bármely restriktív policy ezeken a táblákon eltörné a
--     felvételi intake-et — pont azoknak, akiknek a legfontosabb.
--
--   • NEM nyúl az `auditLogs`-hoz. Ott a beszúrás `is_approved()`: MINDEN
--     szerepkör naplóz, és a tábla a 11-es óta eleve append-only (nincs
--     update/delete policy). Nincs mit szigorítani.
--
-- VÉSZKAPCSOLÓ: select public.rbac_enforce_set(false);
--   Egyetlen sort állít át, és ezzel MINDKÉT kikényszerítési réteg kinyílik,
--   mert mind a policy-k, mind a 74-es kapui a rbac_can()-ra épülnek.
--   Se DDL, se zárolás, se deploy, se PostgREST-újratöltés.
-- VISSZAÁLLÍTÁS (ha a rbac_setting maga a hiba): 75_rbac_actions_rollback.sql
--   — eldobja az összes rbacx_ policy-t. Tartsd nyitva egy külön SQL Editor
--   fülön futtatás előtt, ahogy a 13_rbac_rollback.sql-t is.
--
-- ELŐFELTÉTEL: 72_rbac_actions.sql. A 0. szakasz ELLENŐRZI és MEGTAGADJA a
--   futást, ha a backfill nem teljes — a 12_rbac_flip.sql mintájára.
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================================

set search_path = public;

begin;

do $$
begin
  if to_regprocedure('public.rbac_can_any(text[],text)') is null
     or to_regclass('public.role_module_permission') is null then
    raise exception 'Előbb a 72_rbac_actions.sql szükséges.';
  end if;
end $$;

-- Egy sor egy tábla/művelet. A legacy_gate az ellenőrzött permisszív kapu;
-- nem futtatunk adatvezérelt SQL-kifejezést a táblából.
create table if not exists public.rbacx_table_module (
  table_name text not null,
  action text not null check (action in ('CREATE','EDIT','DELETE')),
  module_kod text not null references public.module_definition(kod),
  legacy_gate text not null check (legacy_gate in
    ('is_admin','is_admissions','is_finance','is_staff')),
  primary key (table_name, action)
);
alter table public.rbacx_table_module enable row level security;
revoke all on public.rbacx_table_module from public, anon, authenticated;
grant select on public.rbacx_table_module to authenticated;
drop policy if exists rxtm_select on public.rbacx_table_module;
create policy rxtm_select on public.rbacx_table_module
  for select to authenticated using (public.is_approved());

-- Ideiglenes szándéklista: az első telepítés ellenőrzi a backfillt, az
-- újrafuttatás viszont nem adja vissza a mátrixban szándékosan elvett jogot.
create temporary table _rbacx_expected (
  table_name text, action text, module_kod text, legacy_gate text
) on commit drop;
insert into _rbacx_expected
select t, a, m, case when a = 'DELETE' then d else w end
from (values
  ('users',                   'system_admin',    'is_admin',      'is_admin'),
  ('agencies',                'agent_portal',    'is_admin',      'is_admin'),
  ('campaigns',               'engagement_crm',  'is_admissions', 'is_admin'),
  ('marketingCampaigns',      'marketing_leads', 'is_admissions', 'is_admin'),
  ('scholarships',            'programs',        'is_admissions', 'is_admin'),
  ('videoInterviewQuestions', 'interviews',      'is_admissions', 'is_admin'),
  ('integrations',            'finance',         'is_admin',      'is_admin'),
  ('webhooks',                'system_admin',    'is_admin',      'is_admin'),
  ('invoices',                'finance',         'is_finance',    'is_finance'),
  ('leads',                   'marketing_leads', 'is_admissions', 'is_admissions'),
  ('feed_posts',              'feed',            'is_admissions', 'is_admissions'),
  ('programs',                'programs',        'is_admissions', 'is_admin'),
  ('kb_documents',            'assistant',       'is_admissions', 'is_admin')
) v(t,m,w,d) cross join unnest(array['CREATE','EDIT','DELETE']) a;
insert into _rbacx_expected values
  ('interviewSlots',      'CREATE','interviews',      'is_staff'),
  ('interviewSlots',      'DELETE','interviews',      'is_staff'),
  ('payments',            'EDIT',  'finance',         'is_finance'),
  ('payments',            'DELETE','finance',         'is_finance'),
  ('students',            'CREATE','admissions_core', 'is_staff'),
  ('students',            'DELETE','admissions_core', 'is_admin'),
  ('process_messages',    'DELETE','admissions_core', 'is_staff'),
  ('program_applications','DELETE','admissions_core', 'is_staff'),
  ('event_rsvps',          'EDIT', 'feed',            'is_staff'),
  ('ticket_claims',        'EDIT', 'feed',            'is_staff');

-- Kimarad: minden SELECT; auditLogs teljesen; students UPDATE;
-- admission_processes teljesen (DELETE is tulajdonosi);
-- process_messages/program_applications INSERT/UPDATE;
-- payments INSERT; interviewSlots UPDATE; event_rsvps/ticket_claims INSERT/DELETE.
-- Ezek olvasási, tulajdonosi vagy jóváhagyás előtti önkiszolgáló utak.
-- Az echo és dorm sémákhoz és saját grant-dimenziójukhoz nem nyúlunk.

do $preflight$
declare r record; p record; v_cmd text; role_kod text; v_roles text[];
        expected text; n integer;
begin
  for r in select * from _rbacx_expected loop
    v_cmd := case r.action when 'CREATE' then 'INSERT' when 'EDIT' then 'UPDATE' else 'DELETE' end;
    if not exists (select 1 from pg_class
       where oid = to_regclass(format('public.%I', r.table_name)) and relrowsecurity) then
      raise exception 'Hiányzó tábla vagy kikapcsolt RLS: %', r.table_name;
    end if;
    -- Az összes alkalmazható permisszív policy-t vizsgáljuk. Egy új
    -- tulajdonosi OR-ág vagy approved_all sem kerülhet restriktív kapu alá.
    n := 0;
    expected := r.legacy_gate || '()';
    for p in select * from pg_policies
      where schemaname = 'public' and tablename = r.table_name
        and permissive = 'PERMISSIVE' and pg_policies.cmd in (v_cmd, 'ALL')
        and roles::text[] && array['authenticated','public']
    loop
      n := n + 1;
      if (v_cmd <> 'INSERT' and
          regexp_replace(replace(coalesce(p.qual,''),'public.',''), '[[:space:]]', '', 'g') <> expected)
         or (v_cmd <> 'DELETE' and
          regexp_replace(replace(coalesce(p.with_check,p.qual,''),'public.',''), '[[:space:]]', '', 'g') <> expected) then
        raise exception 'Nem igazolt ügyintézői policy: %.% (%). Önkiszolgáló út nem szigorítható.',
          r.table_name, p.policyname, v_cmd;
      end if;
    end loop;
    if n = 0 then raise exception 'Hiányzó permisszív alap: %/%', r.table_name, v_cmd; end if;
    if not exists (select 1 from public.module_definition
        where kod = r.module_kod and aktiv and r.action = any(actions)) then
      raise exception 'Hiányzó modul/művelet: %/%', r.module_kod, r.action;
    end if;
    if not exists (select 1 from public.rbacx_table_module m
        where m.table_name = r.table_name and m.action = r.action) then
      v_roles := case r.legacy_gate
        when 'is_admin' then array['ADMIN']
        when 'is_admissions' then array['ADMIN','ADMISSIONS']
        when 'is_finance' then array['ADMIN','FINANCE']
        else array['ADMIN','ADMISSIONS','FINANCE'] end;
      foreach role_kod in array v_roles loop
        if not public.rbac_can_role(role_kod, r.module_kod, r.action) then
          raise exception 'Hiányos backfill: %/%/%', role_kod, r.module_kod, r.action;
        end if;
        if r.table_name = 'programs' and
            not public.rbac_can_role(role_kod, 'trainings', r.action) then
          raise exception 'Hiányos backfill: %/trainings/%', role_kod, r.action;
        end if;
      end loop;
    end if;
  end loop;
end $preflight$;

insert into public.rbacx_table_module
select * from _rbacx_expected
on conflict (table_name, action) do update
set module_kod = excluded.module_kod, legacy_gate = excluded.legacy_gate;

do $policies$
declare r record; cmd text; name text; expr text;
begin
  for r in select * from _rbacx_expected loop
    cmd := case r.action when 'CREATE' then 'INSERT' when 'EDIT' then 'UPDATE' else 'DELETE' end;
    name := 'rbacx_' || lower(r.table_name) || '_' || lower(cmd);
    expr := format('(select public.rbac_can_any(array[%L]::text[], %L))', r.module_kod, r.action);
    -- A két katalógus ugyanazt a táblát használja. A PROG_kind() a level
    -- mezőből származtatja a nézetet; a kind csak kliensoldali mező.
    -- UPDATE-nél a régi ÉS az új sor moduljának joga szükséges.
    if r.table_name = 'programs' then
      expr := format('case when level in (''bachelor'',''master'',''doctoral'') then
        (select public.rbac_can_any(array[''trainings'']::text[], %L)) else %s end', r.action, expr);
    end if;
    execute format('drop policy if exists %I on public.%I', name, r.table_name);
    execute format('create policy %I on public.%I as restrictive for %s to authenticated %s',
      name, r.table_name, cmd,
      case cmd when 'INSERT' then 'with check (' || expr || ')'
        when 'DELETE' then 'using (' || expr || ')'
        else 'using (' || expr || ') with check (' || expr || ')' end);
  end loop;
end $policies$;

commit;
