-- ============================================================================
-- RUN_ALL_102.sql — „Frissítés a kiíró oldaláról" gomb a felhívásnál
-- ============================================================================
-- MIÉRT: a részletek 30 naponta frissülnek a gépi körben. Az irodának viszont
-- akkor kell a friss állapot, amikor épp azon a felhíváson dolgozik — egy
-- módosított dokumentumsablon vagy egy pontosított elvárás nem várhat hetekig.
--
-- MIT VÁLTOZTAT: a részletek sora kaphat egyetlen felhívás-azonosítót, és
-- ilyenkor a frissesség nem számít. Erre épül a felületen a gomb: letölti a
-- kiíró oldaláról, majd újraolvassa a felhívás ablakát.
--
-- A régi, kétparaméteres alakot el KELL dobni: ha mindkettő megmarad, a
-- nevesített paraméterekkel érkező hívás nem egyértelmű, és a PostgREST
-- hibával áll le. A szkript ezt ellenőrzi is.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 102 — egy felhivas reszletei kuloen is frissithetok.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
-- ============================================================================



-- ####################################################################
-- ### 102_grants_details_frissites.sql
-- ####################################################################

-- ============================================================
-- 102_grants_details_frissites.sql — egy felhívás részletei kérésre
-- ============================================================
-- MIÉRT: a részletek 30 naponta frissülnek a gépi körben. Az irodának viszont
-- akkor kell a friss állapot, amikor épp azon a felhíváson dolgozik — egy
-- módosított dokumentumsablon vagy egy pontosított elvárás nem várhat hetekig.
--
-- MIT VÁLTOZTAT: a részletek sora kaphat egyetlen felhívás-azonosítót. Ilyenkor
-- azt adja vissza, FÜGGETLENÜL attól, mikor frissítettük utoljára. Erre épül a
-- felületen a „Frissítés a kiíró oldaláról" gomb.
--
-- A régi, kétparaméteres alakot EL KELL DOBNI: ha mindkettő megmarad, a
-- két nevesített paraméterrel érkező hívás nem egyértelmű, és a PostgREST
-- hibával áll le. (Ugyanaz a csapda, mint a 82-es migrációban.)
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

drop function if exists public.grants_call_details_queue(integer, integer);

create or replace function public.grants_call_details_queue(
  p_limit integer default 20,
  p_napok integer default 30,
  p_call  uuid    default null)
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
             and coalesce(c.payload->>'identifier', c.kulso_azonosito) is not null
             -- Egyetlen felhívásra kérve a frissesség NEM számít: az iroda
             -- épp azért nyomta meg a gombot, mert most akarja látni.
             and (p_call is not null and c.id = p_call
                  or p_call is null
                     and (c.reszletek_frissitve is null
                          or c.reszletek_frissitve < now() - (greatest(coalesce(p_napok, 30), 1) * interval '1 day')))
           order by (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido < now()),
                    c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 20), 1), 100)) t
$$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text := 'public.grants_call_details_queue(integer,integer,uuid)';
begin
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
end $grants$;

do $chk$
begin
  -- A régi alak tényleg eltűnt-e: ha bent maradna, a nevesített hívás
  -- kétértelmű lenne.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'grants_call_details_queue'
                and p.pronargs = 2) then
    raise exception 'HIBA: a regi ketparameteres grants_call_details_queue bent maradt.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_call_details_queue(integer,integer,uuid)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is olvashatja az ETL-sort.';
  end if;
  raise notice 'Rendben: 102 — egy felhivas reszletei kuloen is frissithetok.';
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
