-- ============================================================================
-- RUN_ALL_101.sql — a részletek a lejárt felhívásokra is lejönnek
-- ============================================================================
-- MI TÖRTÉNT: a részletek letöltése 634 felhívásra lefutott, hibátlanul, a sor
-- kiürült — a felületen mégis „Még nem töltöttük le a kiíró oldaláról" állt
-- gyakorlatilag minden megnyitott felhívásnál.
--
-- AZ OK, MÉRVE: a sor csak azt adta vissza, aminek a következő határideje a
-- JÖVŐBEN van. A felhívás-lista viszont a legközelebbi határidő szerint
-- rendez — tehát elöl épp azok állnak, amelyeknek a határideje az imént járt
-- le. Ezek kimaradtak, és pont ezeket nyitja meg először a felhasználó. A sor
-- „kiürült" jelzése igaz volt, csak nem arra a halmazra, amit a felület mutat.
--
-- A JAVÍTÁS: minden nem archivált EU-felhívásra lekérjük a részleteket, a
-- határidőtől függetlenül — a közelgők elöl, a lejártak a sor végén. Ez amúgy
-- is helyesebb: a lejárt kiírás szövege a következő évi pályázat
-- előkészítéséhez a legértékesebb olvasmány.
--
-- A felületen a hiányzó részlet üzenete is pontosabb lett: ha egyszer már
-- lekérdeztük és a kiíró oldalán sem volt dokumentumlista, azt mondjuk ki —
-- nem ígérünk olyan gépi kört, ami már lefutott.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 101 — a reszletek a lejart felhivasokra is lejonnek.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
--
-- FUTÁS UTÁN: lefuttatom a letöltést a maradékra.
-- ============================================================================



-- ####################################################################
-- ### 101_grants_details_mind.sql
-- ####################################################################

-- ============================================================
-- 101_grants_details_mind.sql — a részletek a lejárt felhívásokra is
-- ============================================================
-- MI TÖRTÉNT: a részletek letöltése 634 felhívásra lefutott, hibátlanul, és a
-- sor kiürült — a felületen mégis „Még nem töltöttük le a kiíró oldaláról"
-- állt, gyakorlatilag minden megnyitott felhívásnál.
--
-- AZ OK, MÉRVE: a 99-es sor csak azt adta vissza, aminek a következő
-- határideje a JÖVŐBEN van (`kovetkezo_hatarido >= now()`). A felhívás-lista
-- viszont a legközelebbi határidő szerint rendez — tehát elöl épp azok állnak,
-- amelyeknek a határideje az imént járt le. Ezek kimaradtak a letöltésből, és
-- pont ezeket nyitja meg először a felhasználó. A sor „kiürült" jelzése igaz
-- volt, csak a sor nem arra a halmazra vonatkozott, amit a felület mutat.
--
-- A JAVÍTÁS: a részleteket MINDEN nem archivált EU-felhívásra lekérjük, a
-- határidőtől függetlenül. Ez amúgy is helyesebb: a lejárt kiírás szövege a
-- következő évi pályázat előkészítéséhez a legértékesebb olvasmány, és az
-- értékelési küszöbök sem évülnek el egy nap alatt.
--
-- A frissítési rend nem változik: amit egyszer lehoztunk, azt 30 napig nem
-- kérdezzük újra.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function public.grants_call_details_queue(p_limit integer default 20, p_napok integer default 30)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim,
                                    'azonosito', coalesce(c.payload->>'identifier', c.kulso_azonosito),
                                    'hatarido', c.kovetkezo_hatarido) as sor
            from grants.call c
           where c.archivalt = false
             and c.source_kod = 'eu_portal'
             -- HATÁRIDŐ-FÜGGETLEN: a lejárt kiírás szövege a jövő évi
             -- pályázat előkészítéséhez a legfontosabb forrás, és a
             -- felhívás-lista is mutatja őket.
             and coalesce(c.payload->>'identifier', c.kulso_azonosito) is not null
             and (c.reszletek_frissitve is null
                  or c.reszletek_frissitve < now() - (greatest(coalesce(p_napok, 30), 1) * interval '1 day'))
           -- A közelgő határidő megy elöl, a lejártak a sor végén.
           order by (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido < now()),
                    c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 20), 1), 100)) t
$$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text := 'public.grants_call_details_queue(integer,integer)';
begin
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_call_details_queue(integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is olvashatja az ETL-sort.';
  end if;
  raise notice 'Rendben: 101 — a reszletek a lejart felhivasokra is lejonnek.';
end $chk$;


-- ####################################################################
-- ### 21_echo_harden_submit.sql
-- ####################################################################

-- ============================================================
-- UniPortal Pro — ECHO: az anonim beküldés jogosultságának lezárása
-- ------------------------------------------------------------
-- MIÉRT KELL:
--   Az ECHO anonimitásának egyik tartóoszlopa, hogy a beküldés NEM a hallgató
--   munkamenetével fut: az echo_submit() kizárólag 'anon' joggal hívható, így
--   egy JWT-t hordozó kérés jogosultsági hibával elhasal, és a hallgató
--   azonosítója nem kerül a tranzakciós naplóba és a platform edge-logjába.
--
--   A 15_echo_core.sql ezt CSAK azzal éri el, hogy megadja a jogot az anon-nak
--   (1712. sor) — de SOHA NEM VONJA VISSZA az authenticated-tól. A Supabase
--   alapértelmezett jogosztása (alter default privileges … grant execute on
--   functions to anon, authenticated, service_role) viszont MINDEN új publikus
--   függvényre ad authenticated végrehajtási jogot. Ha ez a projekten él, akkor
--   az echo_submit bejelentkezve is hívható, és a garancia csendben elveszik.
--
--   MÉRVE: egy tiszta adatbázison, ahol a migrációk UTÁN lefutott egy tömeges
--   'grant all on all functions in schema public to anon, authenticated' —
--   ami pontosan azt utánozza, amit a platform tesz —, az echo_submit
--   jogosultsága 'anon=X authenticated=X service_role=X' lett.
--
-- MIT CSINÁL:
--   Visszavonja a végrehajtási jogot mindenkitől, majd kizárólag az anon-nak adja
--   vissza. Beállítja az alapértelmezett jogosztást is, hogy egy jövőbeli
--   platform-művelet ne nyissa vissza. A végén ellenőriz.
--
-- FUTTATÁSI SORREND: ez az UTOLSÓ migráció. Minden alkalommal futtasd újra,
-- amikor bármilyen új ECHO-migráció felment.
--
-- Idempotens — biztonságosan újrafuttatható, és futtatandó MINDEN olyan
-- alkalommal, amikor új ECHO-migráció ment fel.
-- ============================================================

-- ---------- 1. a beküldő függvény lezárása ----------
do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'echo_submit'
  loop
    execute format('revoke all on function %s from public, authenticated, service_role', fn);
    execute format('grant execute on function %s to anon', fn);
    raise notice 'Lezarva es anon-ra szukitve: %', fn;
  end loop;
end $$;

-- ---------- 2. a jegykiadó marad authenticated ----------
-- Ez SZÁNDÉKOSAN azonosított: itt még nincs válasz, tehát nincs mit korrelálni.
do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'echo_issue_ticket'
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ---------- 3. ellenőrzés ----------
with a as (
  select p.proname,
         coalesce(array_to_string(p.proacl, ' '), '(alapertelmezett)') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('echo_submit', 'echo_issue_ticket')
)
select proname as fuggveny, acl,
       case
         when proname = 'echo_submit'
           then case when acl like '%anon=X%' and acl not like '%authenticated=X%'
                     then 'OK — csak anon' else '*** BAJ: bejelentkezve is hivhato ***' end
         when proname = 'echo_issue_ticket'
           then case when acl like '%authenticated=X%' and acl not like '%anon=X%'
                     then 'OK — csak authenticated' else '*** BAJ ***' end
       end as allapot
from a order by proname;
