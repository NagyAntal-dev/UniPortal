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
