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

  raise notice '--- onellenorzes vege ---';
end $v$;
