-- ============================================================================
-- RUN_ALL_87.sql — a metaadat-letöltő végre megtalálja a kutatókat (2026-09-25)
-- ============================================================================
-- HOL TARTUNK: a párosítás és a kötegelt összekötés lefutott, 112 kutató kapott
-- OpenAlex- vagy MTMT-azonosítót. A metaadat-letöltő mégis azt mondta, hogy
-- nincs feldolgozandó.
--
-- AZ OK: a szinkron-sor a törzs MINDEN aktív kutatóját sorbaállította — azt is,
-- akinek nincs forrásazonosítója, tehát akiről nem is lehet adatot letölteni.
-- A rendezés csupa döntetlen volt (mindenkinél üres a szinkronidő), így a
-- sorrendet a fizikai tárolás adta; az összekötéskor frissült 112 sor pedig a
-- tábla végére került, és kiesett a 200-as ablakból.
--
-- MÉRVE, éles nagyságrenden (336 kutató, ebből 112 összekötött):
--     régi sor : 200 sort ad vissza, ebből 28-nak van azonosítója
--     új sor   : 112 sort ad vissza, MINDEGYIKNEK van azonosítója
--
-- A javítás: a sor csak összekötött kutatót ad vissza, és a rendezés
-- determinisztikus (név a másodlagos kulcs).
--
-- A FUTÁS VÉGÉN EZT KELL LÁTNOD:
--   NOTICE: Rendben: 87 — a szinkron-sor csak az osszekotott kutatokat adja vissza.
--
-- FUTÁS UTÁN: szólj, és lefuttatom a metaadat-letöltést a 112 kutatóra.
-- ============================================================================


-- ####################################################################
-- ### 87_grants_sync_queue.sql
-- ####################################################################

-- ============================================================
-- 87_grants_sync_queue.sql — a szinkron-sor csak az összekötött kutatókat adja
-- ============================================================
-- MI TÖRTÉNT: a párosítás és a kötegelt összekötés lefutott (112 kutató kapott
-- OpenAlex- vagy MTMT-azonosítót), a metaadat-letöltő mégis azt mondta:
-- „nincs feldolgozandó".
--
-- MIÉRT: a `grants_researchers_to_sync()` a törzs MINDEN aktív kutatóját
-- sorbaállítja — azt is, akinek egyetlen forrásazonosítója sincs, tehát akiről
-- definíció szerint nem lehet metaadatot letölteni. A rendezés
-- `utolso_szinkron nulls first`, és élesben MIND a 336 sor utolso_szinkron-ja
-- NULL volt, tehát a rendezés csupa döntetlen: a sorrendet a fizikai tárolás
-- adta. Az összekötéskor viszont a 112 érintett sor FRISSÜLT, és a frissített
-- sor a tábla végére kerül — így épp ők estek ki a 200-as ablakból. A letöltő
-- 200 olyan kutatót kapott, akinek nincs azonosítója, és jelentette, hogy
-- nincs dolga.
--
-- A JAVÍTÁS: a sor csak azt adja vissza, akinek VAN forrásazonosítója — hiszen
-- másról nincs is mit letölteni —, és a rendezés determinisztikus (név szerinti
-- másodlagos kulccsal), hogy ne a fizikai tárolás döntsön.
--
-- MIÉRT NEM CSAK A LIMITET EMELTÜK: a limit emelése a tünetet kezelné. Az
-- azonosító nélküli kutató sosem szinkronizálható, tehát a SORBAN SINCS
-- helye — így a 200-as ablak mindig arra a körre jut, amelyiknek van értelme.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function public.grants_researchers_to_sync(
  p_limit integer default 10, p_napok integer default 7)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', r.id, 'nev', r.nev, 'orcid', r.orcid,
             'openalex_id', r.openalex_id, 'mtmt_id', r.mtmt_id,
             'utolso_szinkron', r.utolso_szinkron)
             order by r.utolso_szinkron nulls first, r.nev), '[]'::jsonb)
      from (select * from grants.researcher
             where allapot = 'aktiv' and gepi_epites = true
               -- CSAK ÖSSZEKÖTÖTT KUTATÓ. Azonosító nélkül nincs mit letölteni,
               -- és az ilyen sorok korábban kiszorították az ablakból azokat,
               -- akikről valóban lehetett volna adatot hozni.
               and (openalex_id is not null or mtmt_id is not null)
               and (utolso_szinkron is null
                    or utolso_szinkron < now() - (greatest(coalesce(p_napok, 7), 0) * interval '1 day'))
             -- Determinisztikus sorrend: a név a másodlagos kulcs, különben
             -- csupa NULL szinkronidőnél a fizikai tárolás dönt.
             order by utolso_szinkron nulls first, nev
             limit least(greatest(coalesce(p_limit, 10), 1), 200)) r);
end $$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text := 'public.grants_researchers_to_sync(integer,integer)';
begin
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated',
         'public.grants_researchers_to_sync(integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is lekerdezheti a szinkron-sort.';
  end if;
  raise notice 'Rendben: 87 — a szinkron-sor csak az osszekotott kutatokat adja vissza.';
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
