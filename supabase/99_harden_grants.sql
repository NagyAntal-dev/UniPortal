-- ============================================================================
-- UniPortal — Függvény-jogosultságok lezárása. MINDEN indításkor lefut,
-- a migrációk UTÁN (deploy/migrate/run.sh) — nem a manifest része.
--
-- MIÉRT NEM MIGRÁCIÓ:
--   A 21_echo_harden_submit.sql fejléce ezt írja magáról: "ez az UTOLSÓ
--   migráció, futtasd újra minden új ECHO-migráció után". A valóságban a
--   manifestben a 21. helyen áll, a futtató pedig ellenőrzőösszeg alapján
--   kihagyja a már lefutott fájlokat — tehát EGYSZER futott le, a 21. helyen.
--   A 22–69-es migrációk azóta ~150 új public sémabeli függvényt hoztak létre,
--   és mindegyik megkapta az alapértelmezett jogosultságot. Ez a fájl ezért
--   NEM a manifestben van: a run.sh minden indításkor lefuttatja.
--
-- MIT CSINÁL:
--   A PostgreSQL MINDEN új függvényre megadja az EXECUTE jogot a PUBLIC
--   ál-szerepkörnek, a Supabase alapértelmezése pedig külön az anonnak is.
--   Az `anon` tagja a PUBLIC-nak, ezért a puszta "revoke ... from anon" NEM
--   elég: amíg a PUBLIC jog megvan, az anon azon keresztül továbbra is hív.
--
--   Ezért:
--     1. Feljegyezzük, mit tud MA végrehajtani az `authenticated`. A PUBLIC-on
--        át örökölt jog is ide számít — a migrációk SZÁNDÉKOS
--        "revoke ... from public, anon, authenticated" sorai viszont már
--        kiestek belőle, tehát azokat nem adjuk vissza.
--     2. Elvesszük a PUBLIC és az anon jogát minden public sémabeli rutinra.
--     3. Az 1. pont listáját EXPLICIT módon visszaadjuk az authenticated-nek.
--        Így a felület semmit nem veszít, az anon viszont mindent.
--     4. Visszaadjuk az anonnak azt a néhány függvényt, aminek tényleg
--        anonnak hívhatónak kell lennie (lásd a listát lentebb).
--
--   A service_role-t nem bántjuk: az a szerveroldali kulcs.
--
-- Idempotens. A második futáskor a 2. lépés már nem talál PUBLIC-jogot,
-- a 3. pedig ugyanazt az explicit listát írja vissza.
-- ============================================================================
set search_path = public;


-- ---------- 0. sémaszintű zárás ----------
-- A 26-os migráció ezt az `dorm` sémára kimondja (26:169-177), a 15-ös az
-- `echo`-ra viszont csak a PostgreSQL alapértelmezésére hagyatkozik (új sémán
-- nincs USAGE). Itt kimondjuk mindkettőre, hogy ne feltevés védje.
do $sch$
declare s text;
begin
  foreach s in array array['echo', 'dorm'] loop
    if exists (select 1 from pg_namespace where nspname = s) then
      execute format('revoke usage on schema %I from anon', s);
      execute format('alter default privileges in schema %I revoke execute on functions from anon', s);
    end if;
  end loop;
exception when others then
  raise warning 'A semaszintu zaras nem teljes: %', sqlerrm;
end $sch$;

-- ---------- Az anon számára SZÁNDÉKOSAN nyitva hagyott függvények ----------
-- Bővítés előtt gondold végig: ezeket bejelentkezés NÉLKÜL bárki hívhatja.
--
--   echo_submit                     — a névtelen kurzusértékelés beküldése.
--                                     Ez az EGYETLEN RPC, amit a felület
--                                     névtelen kliense hív (features/echo.jsx).
--                                     Saját védelme: HMAC-jegy, egyszer
--                                     használható nonce, lejárat, 64 KB-os
--                                     méretkorlát (15/21/23-as migráció).
--   is_superadmin, is_approved      — a bejelentkezési képernyő használja;
--                                     anonként mindkettő hamisat ad (07:86-87).
--   interview_gate_required_status  — egy beállítási szöveget ad vissza (27:104).
--   interview_slot_minutes,
--   interview_tz                    — az interjúnaptár alapbeállításai (28:389-390).
create temporary table if not exists _uniportal_anon_ok (sig text primary key);
truncate _uniportal_anon_ok;
insert into _uniportal_anon_ok (sig) values
  ('public.echo_submit(text,jsonb)'),
  ('public.is_superadmin()'),
  ('public.is_approved()'),
  ('public.interview_gate_required_status()'),
  ('public.interview_slot_minutes()'),
  ('public.interview_tz()');

do $blk$
declare
  r           record;
  keep_auth   oid[];
  n_revoke    int := 0;
  n_grant     int := 0;
  n_anon      int := 0;
  n_maradt    int := 0;
  maradt_lista text := '';
begin
  -- ---------- 1. mit tud ma az authenticated? ----------
  select coalesce(array_agg(p.oid), '{}')
    into keep_auth
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and has_function_privilege('authenticated', p.oid, 'execute');

  -- ---------- 2. PUBLIC és anon jogának elvétele ----------
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
  loop
    execute format('revoke execute on routine %s from public, anon', r.sig);
    n_revoke := n_revoke + 1;
  end loop;

  -- ---------- 3. az authenticated jogainak explicit visszaadása ----------
  for r in
    select oid::regprocedure as sig from unnest(keep_auth) as t(oid)
  loop
    execute format('grant execute on routine %s to authenticated', r.sig);
    n_grant := n_grant + 1;
  end loop;

  -- ---------- 4. a szándékos anon-lista visszaadása ----------
  for r in select sig from _uniportal_anon_ok loop
    begin
      execute format('grant execute on function %s to anon', r.sig);
      n_anon := n_anon + 1;
    exception when undefined_function then
      raise warning 'A szandekosan anon-nak szant fuggveny nem letezik: %', r.sig;
    end;
  end loop;

  -- ---------- 5. jövőbeli függvények: az anon ne kapjon alapból ----------
  -- Csak az anont vesszük ki. A PUBLIC alapértelmezését SZÁNDÉKOSAN nem
  -- bántjuk: akkor egy új migráció függvényét az authenticated sem érné el,
  -- és az csendben törne el egy új funkciót. A PUBLIC-jogot a 2. lépés úgyis
  -- elveszi a következő induláskor.
  begin
    execute 'alter default privileges in schema public revoke execute on functions from anon';
  exception when others then
    raise warning 'Az alapertelmezett jogosultsag nem modosithato: %', sqlerrm;
  end;

  -- ---------- 6. ellenőrzés ----------
  -- A regprocedure szöveges alakja a search_path miatt elhagyja a "public."
  -- előtagot, ezért NEM szöveget hasonlítunk, hanem OID-t: a to_regprocedure()
  -- nem létező aláírásra NULL-t ad, nem hibát.
  for r in
    select p.oid as fnoid, p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and has_function_privilege('anon', p.oid, 'execute')
  loop
    if not exists (
      select 1 from _uniportal_anon_ok a
       where to_regprocedure(a.sig) = r.fnoid
    ) then
      n_maradt := n_maradt + 1;
      if n_maradt <= 10 then
        maradt_lista := maradt_lista || r.sig || '; ';
      end if;
    end if;
  end loop;

  if n_maradt > 0 then
    raise exception 'BIZTONSAGI HIBA: % public fuggvenyt tovabbra is hivhat az anon. Elso nehany: %',
      n_maradt, maradt_lista;
  end if;

  raise notice 'Rendben: % rutinrol levéve a PUBLIC/anon jog, % visszaadva az authenticated-nek, % szandekosan anon-nak hivhato.',
    n_revoke, n_grant, n_anon;
end $blk$;

drop table if exists _uniportal_anon_ok;
