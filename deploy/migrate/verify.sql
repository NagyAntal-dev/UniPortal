-- ============================================================================
-- UniPortal — Biztonsági önellenőrzés. Minden indításkor lefut, a migrációk és
-- a jogosultság-lezárás UTÁN (deploy/migrate/run.sh).
--
-- CSAK JELENT, NEM ÁLLÍT MEG semmit: a cél az, hogy egy jövőbeli migráció
-- csendes visszaesése (új anon-jog, RLS nélküli tábla, korlátlan tároló)
-- látszódjon az indulási naplóban, ne egy fél év múlva.
--
-- Amit néz:
--   1. Melyik public sémabeli függvényt hívhatja az anon?
--   2. Van-e RLS nélküli tábla a public sémában?
--   3. Van-e SECURITY DEFINER függvény rögzített search_path nélkül?
--   4. Van-e korlát nélküli vagy publikus tároló?
--   5. Maradt-e "auth.uid() is null = megbízható" alakú kapu?
--   6. A helyükön vannak-e a modul-akció kapuk az író RPC-ken?
--   7. Be van-e kapcsolva a jogosultsági kikényszerítés?
-- ============================================================================
set search_path = public;

do $v$
declare
  r      record;
  n      int;
  lista  text;
begin
  raise notice '--- UniPortal biztonsagi onellenorzes ---';

  -- ---------- 1. anon által hívható függvények ----------
  select count(*), coalesce(string_agg(sig, '; ' order by sig), '')
    into n, lista
    from (
      select p.oid::regprocedure::text as sig
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public'
         and p.prokind in ('f', 'p')
         and has_function_privilege('anon', p.oid, 'execute')
    ) t;
  if n = 0 then
    raise notice '1. anon-bol hivhato public fuggveny: nincs.';
  else
    raise notice '1. anon-bol hivhato public fuggveny (%): %', n, lista;
  end if;

  -- ---------- 2. RLS nélküli táblák ----------
  select count(*), coalesce(string_agg(relname, ', ' order by relname), '')
    into n, lista
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if n = 0 then
    raise notice '2. RLS minden public tablan bekapcsolva.';
  else
    raise warning '2. RLS NELKULI public tabla (%): %', n, lista;
  end if;

  -- ---------- 3. SECURITY DEFINER rögzített search_path nélkül ----------
  select count(*), coalesce(string_agg(sig, '; ' order by sig), '')
    into n, lista
    from (
      select p.oid::regprocedure::text as sig
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname in ('public', 'echo', 'dorm')
         and p.prosecdef
         and not exists (
           select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
            where cfg like 'search\_path=%'
         )
    ) t;
  if n = 0 then
    raise notice '3. minden SECURITY DEFINER fuggveny rogzitett search_path-tal fut.';
  else
    raise warning '3. SECURITY DEFINER rogzitett search_path NELKUL (%): %', n, lista;
  end if;

  -- ---------- 4. tárolók ----------
  for r in
    select id, public as nyilvanos, file_size_limit, allowed_mime_types
      from storage.buckets order by id
  loop
    if r.file_size_limit is null then
      raise warning '4. a(z) % tarolonak NINCS meretkorlatja.', r.id;
    end if;
    if r.allowed_mime_types is null or array_length(r.allowed_mime_types, 1) is null then
      raise warning '4. a(z) % tarolonak NINCS tipusszuroje.', r.id;
    end if;
    if r.nyilvanos then
      raise notice '4. a(z) % tarolo NYILVANOS (bejelentkezes nelkul olvashato).', r.id;
    end if;
  end loop;

  -- ---------- 5. "nincs JWT = megbízható" alakú kapuk ----------
  -- SZŰKEN keresünk, hogy ne legyen zaj: csak az a KÉT alak veszélyes, amelyik
  -- a JWT hiányát BIZALOMNAK veszi —
  --     ... or auth.uid() is null        (átengedi, ha nincs JWT)
  --     ... and auth.uid() is not null   (kihagyja az ellenőrzést, ha nincs)
  -- A fordítottja (`if auth.uid() is null then raise`) HELYES, zárt alak, azt
  -- nem jelezzük. Lásd supabase/67_agency_guard_fix.sql.
  --
  -- A profiles_protect_privileges KIVÉTEL, és ez szándékos: az agency_decide
  -- (29_agency.sql) tranzakció-lokálisan KIÜRÍTI a JWT-claimeket, épp azért,
  -- hogy ezen a triggeren át írhassa az ügynöki profilok jóváhagyási mezőit.
  -- Ha ott is is_trusted_caller()-re cserélnénk, az ügynökség jóváhagyása
  -- némán visszaíródna. A trigger anonként nem érhető el (a profiles UPDATE
  -- policy `to authenticated`), ezért a régi alak itt nem kockázat.
  select count(*), coalesce(string_agg(sig, '; ' order by sig), '')
    into n, lista
    from (
      select p.oid::regprocedure::text as sig
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public'
         and p.prosecdef
         and p.proname <> 'profiles_protect_privileges'
         and (p.prosrc like '%or auth.uid() is null%'
           or p.prosrc like '%and auth.uid() is not null%')
    ) t;
  if n = 0 then
    raise notice '5. nincs "auth.uid() is (not) null" alaku kapu.';
  else
    raise warning '5. FIGYELEM: "auth.uid() is (not) null" alaku kapu (%): % — az anon szerepkornek sincs auth.uid()-ja, ezert ez a forma NEM zar. Lasd supabase/67_agency_guard_fix.sql.', n, lista;
  end if;

  -- ---------- 6. a modul-akcio kapuk a helyukon vannak-e? ----------
  -- A 74_rbac_enforce_rpc.sql 26 iro RPC torzsebe beszurt egy
  -- rbac_require(modul, muvelet) kaput. Egy KESOBBI migracio `create or
  -- replace`-e szo nelkul kiveheti onnan: a 74-es fajlja valtozatlan marad,
  -- tehat az ellenorzoosszeg NEM veszi eszre. Ez a lepes eszreveszi.
  if to_regclass('public.rbac_rpc_guard') is null then
    raise notice '6. a modul-akcio kapuk nincsenek telepitve (74_rbac_enforce_rpc.sql nem futott le).';
  else
    select count(*), coalesce(string_agg(g.proc_name, ', ' order by g.proc_name), '')
      into n, lista
      from public.rbac_rpc_guard g
      left join pg_proc p on p.proname = g.proc_name
                         and p.pronamespace = 'public'::regnamespace
     where g.aktiv
       and (p.oid is null
            or position('rbac_require(''' || g.module_kod || ''', ''' || g.action || '''' in p.prosrc) = 0);
    if n = 0 then
      raise notice '6. mind a % iro RPC-n ott van a modul-akcio kapu.',
        (select count(*) from public.rbac_rpc_guard where aktiv);
    else
      raise warning '6. FIGYELEM: % RPC-rol ELTUNT a modul-akcio kapu: % — valoszinuleg egy ujabb migracio ujrairta a torzset. A 74_rbac_enforce_rpc.sql-t frissiteni kell.', n, lista;
    end if;
  end if;

  -- ---------- 7. a jogosultsagi veszkapcsolo allasa ----------
  -- Ha ki van kapcsolva, a restriktiv RLS es az RPC-orok MINDENT atengednek.
  -- Ezt latni kell az indulasi naplobol, nem egy fel ev mulva.
  if to_regclass('public.rbac_setting') is not null then
    select ertek into lista from public.rbac_setting where kulcs = 'rbacx_enforce';
    if coalesce(lista, 'on') = 'on' then
      raise notice '7. a jogosultsagi kikenyszerites BE van kapcsolva.';
    else
      raise warning '7. FIGYELEM: a jogosultsagi kikenyszerites KI VAN KAPCSOLVA (rbac_setting.rbacx_enforce = %). A modul-matrix tiltasai NEM ervenyesulnek. Visszakapcsolas: select public.rbac_enforce_set(true);', lista;
    end if;
  end if;

  -- ---------- 8. restriktiv muveleti policy-k ----------
  if to_regclass('public.rbacx_table_module') is null then
    raise warning '8. FIGYELEM: a 73-as restriktiv RLS nincs telepitve.';
  else
    select count(*) into n from public.rbacx_table_module m
    left join pg_policies p on p.schemaname = 'public'
      and p.tablename = m.table_name
      and p.policyname = 'rbacx_' || lower(m.table_name) || '_' ||
        case m.action when 'CREATE' then 'insert' when 'EDIT' then 'update' else 'delete' end
    where p.policyname is null or p.permissive <> 'RESTRICTIVE'
      or p.roles::text[] <> array['authenticated']
      or p.cmd <> case m.action when 'CREATE' then 'INSERT' when 'EDIT' then 'UPDATE' else 'DELETE' end
      or position('rbac_can_any' in coalesce(p.qual, p.with_check, '')) = 0
      or position(quote_literal(m.module_kod) in coalesce(p.qual, p.with_check, '')) = 0
      or position(quote_literal(m.action) in coalesce(p.qual, p.with_check, '')) = 0
      or (m.table_name = 'programs' and
        position('''trainings''' in coalesce(p.qual, p.with_check, '')) = 0)
      or (m.action = 'EDIT' and p.qual is distinct from p.with_check);
    if n > 0 or (select count(*) from public.rbacx_table_module) <> 49
      or (select count(*) from pg_policies where schemaname = 'public'
           and starts_with(policyname, 'rbacx_')) <> 49 then
      raise warning '8. FIGYELEM: hibas vagy hianyzo rbacx_ policy/lekepzes (% hibas sor).', n;
    else
      raise notice '8. mind a 49 rbacx_ policy RESTRICTIVE, csak authenticated szerepkorre.';
    end if;
  end if;

  raise notice '--- onellenorzes vege ---';
end $v$;
