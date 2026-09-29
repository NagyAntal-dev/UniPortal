-- ============================================================================
-- RUN_ALL_99.sql — beadandó dokumentumok és elvárt eredmények (KPI)
-- ============================================================================
-- MIRE VÁLASZ: az irodának a felhívásnál két dolog kell először — mit kell
-- kitölteni, és mit mérnek rajtunk. Egyik sem volt nálunk.
--
-- MÉRVE 2026-09-25: amit ma töltünk (az EU tömeges állománya), felhívásonként
-- 18 mezőt ad, dokumentum és elvárt eredmény NÉLKÜL. A portál téma-részlet
-- végpontja viszont kulcs nélkül elérhető, felhívásonként egy kérés, ~45 kB:
--     https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/<azonosito>.json
-- Egy Horizon-témán ellenőrizve ebből kijön:
--   * „Expected Outcome" és „Scope" — a felhívás elvárt eredményei,
--   * a beadandó dokumentumok NÉVVEL ÉS LINKKEL (application form Part A/B,
--     detailed budget table, standard evaluation form, MGA-k, munkaprogram),
--   * az oldalszám-korlát és az értékelési küszöbök szakasza.
--
-- MIT AD EZ A SZKRIPT:
--   * grants.call_doc tábla + négy új mező a felhíváson (elvárt eredmény,
--     hatókör, értékelés, oldalkorlát),
--   * ETL-sor és -író a részletek letöltéséhez (a betöltő új „reszletek" módja),
--   * grants_call_details() a felületnek: a felhívás ablakában megjelenik a
--     „Beadandó dokumentumok" lista és az „Elvárt eredmények" szakasz.
--
-- EGY KORLÁT, AMIT NEM REJTÜNK EL: a dokumentumok egy része nem a témánál van,
-- hanem a munkaprogram általános mellékleteiben, és a szöveg csak hivatkozik rá
-- („described in Annex D"). Az ilyen sor a felületen „hivatkozás, nem fájl"
-- megjelölést kap — nem ígérünk többet, mint ami van.
--
-- MELLÉKHASZON: az „Expected Outcome" és a „Scope" több ezer karakter, a mai
-- kivonat egy-két mondat. Az arculat-sor mostantól ezeket adja a modellnek,
-- tehát az arculatok — és rajtuk keresztül a csapatajánló — pontosabbak lesznek.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 99 — beadando dokumentumok, elvart eredmenyek, gazdagabb arculat-sor.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
--
-- FUTÁS UTÁN: lefuttatom a részletek letöltését a nyitott felhívásokra.
-- ============================================================================



-- ####################################################################
-- ### 99_grants_call_details.sql
-- ####################################################################

-- ============================================================
-- 99_grants_call_details.sql — beadandó dokumentumok és elvárt eredmények
-- ============================================================
-- MIÉRT: az iroda a felhívásnál két dolgot keres először — mit kell kitölteni,
-- és mit mérnek rajtunk. Egyik sem volt nálunk: a tömeges EU-állomány (amit ma
-- töltünk) felhívásonként 18 mezőt ad, dokumentum és elvárt eredmény nélkül.
--
-- MÉRVE 2026-09-25: a portál téma-részletek végpontja kulcs nélkül elérhető,
-- felhívásonként egy kérés, ~45 kB:
--     https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/<azonosito>.json
-- Ebből jön:
--   description → „Expected Outcome: …" + „Scope: …"  (ezek a felhívás KPI-jai)
--   conditions  → oldalszám-korlát, értékelési küszöbök, és NÉVVEL, LINKKEL a
--                 beadandó dokumentumok (application form Part A/B, detailed
--                 budget table, evaluation form, MGA, work programme mellékletek)
--   supportInfo → kézikönyv- és GYIK-hivatkozások
--
-- EGY KORLÁT, AMIT NEM REJTÜNK EL: a dokumentumok egy része nem a témánál van,
-- hanem a Work Programme általános mellékleteiben, és a szöveg csak hivatkozik
-- rá („described in Annex D"). Ezért a dokumentum-sor `tipus` mezője megmondja,
-- fájl-e vagy hivatkozás — a felületen sem ígérünk többet, mint ami van.
--
-- MELLÉKHASZON: az „Expected Outcome" és a „Scope" sokkal gazdagabb szöveg,
-- mint a mai kivonat — az arculatok (és rajtuk keresztül a csapatajánló) ebből
-- pontosabbak lesznek. Ezért a 89-es arculat-sor is ezeket adja vissza.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

alter table grants.call
  add column if not exists elvart_eredmeny     text,
  add column if not exists hatokor             text,
  add column if not exists ertekeles           text,
  add column if not exists oldalkorlat         text,
  add column if not exists reszletek_frissitve timestamptz,
  add column if not exists reszletek_hiba      text;

comment on column grants.call.elvart_eredmeny is
  'A felhívás „Expected Outcome" szakasza: amit a projekttől eredményként várnak. Ez a pályázat KPI-jainak forrása.';
comment on column grants.call.hatokor is 'A „Scope" szakasz: mire terjedhet ki a munka.';
comment on column grants.call.ertekeles is 'Értékelési szempontok és küszöbök (Award criteria, scoring and thresholds).';

create table if not exists grants.call_doc (
  call_id   uuid not null references grants.call(id) on delete cascade,
  sorszam   integer not null,
  nev       text not null,
  url       text,
  tipus     text not null default 'egyeb'
              constraint grants_call_doc_tipus_ck
              check (tipus in ('urlap','koltsegvetes','ertekelo','szerzodes','munkaprogram','utmutato','egyeb')),
  -- Fájlra mutat, vagy csak egy szakaszra hivatkozik? A kettő mást ér az
  -- irodának, ezért nem mossuk össze.
  fajl      boolean not null default true,
  megjegyzes text,
  primary key (call_id, sorszam)
);
create index if not exists grants_call_doc_idx on grants.call_doc (call_id, tipus);

-- ------------------------------------------------------------
-- ETL: mely felhívásoknak hiányzik a részlete
-- ------------------------------------------------------------
create or replace function public.grants_call_details_queue(p_limit integer default 20, p_napok integer default 30)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim,
                                    -- A lekérés kulcsa a téma azonosítója; ez a
                                    -- betöltött állományból jön.
                                    'azonosito', coalesce(c.payload->>'identifier', c.kulso_azonosito),
                                    'hatarido', c.kovetkezo_hatarido) as sor
            from grants.call c
           where c.archivalt = false
             and c.source_kod = 'eu_portal'
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
             and coalesce(c.payload->>'identifier', c.kulso_azonosito) is not null
             and (c.reszletek_frissitve is null
                  or c.reszletek_frissitve < now() - (greatest(coalesce(p_napok, 30), 1) * interval '1 day'))
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 20), 1), 100)) t
$$;

create or replace function public.grants_call_details_set(p_call uuid, p_adat jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; v_db integer := 0;
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;

  update grants.call c
     set elvart_eredmeny = coalesce(nullif(btrim(coalesce(p_adat->>'elvart_eredmeny','')),''), c.elvart_eredmeny),
         hatokor         = coalesce(nullif(btrim(coalesce(p_adat->>'hatokor','')),''), c.hatokor),
         ertekeles       = coalesce(nullif(btrim(coalesce(p_adat->>'ertekeles','')),''), c.ertekeles),
         oldalkorlat     = coalesce(nullif(btrim(coalesce(p_adat->>'oldalkorlat','')),''), c.oldalkorlat),
         reszletek_hiba  = nullif(btrim(coalesce(p_adat->>'hiba','')),''),
         reszletek_frissitve = now()
   where c.id = p_call;
  if not found then raise exception 'GRANTS_HIBA: nincs ilyen felhívás.'; end if;

  if jsonb_typeof(p_adat->'dokumentumok') = 'array' then
    delete from grants.call_doc where call_id = p_call;
    for it in select jsonb_array_elements(p_adat->'dokumentumok') loop
      continue when coalesce(btrim(it->>'nev'), '') = '';
      v_db := v_db + 1;
      insert into grants.call_doc (call_id, sorszam, nev, url, tipus, fajl, megjegyzes)
      values (p_call, v_db, btrim(it->>'nev'), nullif(it->>'url',''),
              coalesce(nullif(it->>'tipus',''), 'egyeb'),
              coalesce((it->>'fajl')::boolean, true),
              nullif(it->>'megjegyzes',''))
      on conflict (call_id, sorszam) do nothing;
    end loop;
  end if;

  return jsonb_build_object('dokumentum', v_db);
end $$;

-- ------------------------------------------------------------
-- Felület: mit kell kitölteni, és mit mérnek rajtunk
-- ------------------------------------------------------------
create or replace function public.grants_call_details(p_call uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_office();
  return (select jsonb_build_object(
            'call_id', c.id,
            'elvart_eredmeny', c.elvart_eredmeny,
            'hatokor', c.hatokor,
            'ertekeles', c.ertekeles,
            'oldalkorlat', c.oldalkorlat,
            'frissitve', c.reszletek_frissitve,
            'hiba', c.reszletek_hiba,
            'dokumentumok', coalesce((select jsonb_agg(jsonb_build_object(
                                'nev', d.nev, 'url', d.url, 'tipus', d.tipus, 'fajl', d.fajl,
                                'megjegyzes', d.megjegyzes) order by d.sorszam)
                              from grants.call_doc d where d.call_id = c.id), '[]'::jsonb))
            from grants.call c where c.id = p_call);
end $$;

-- ------------------------------------------------------------
-- Az arculat-sor a gazdagabb szöveget adja vissza
-- ------------------------------------------------------------
-- A kivonat egy-két mondat; az elvárt eredmény és a hatókör több ezer karakter.
-- Az arculatok ebből lesznek pontosabbak — és rajtuk keresztül a csapatajánló.
create or replace function public.grants_facet_queue(p_limit integer default 5)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim, 'cim_en', c.cim_en,
                                    'program', c.program, 'tipus', c.tipus,
                                    'kivonat', c.kivonat, 'url', c.url,
                                    'hatarido', c.kovetkezo_hatarido,
                                    'kedvezmenyezett', c.kedvezmenyezett,
                                    'elvart_eredmeny', left(coalesce(c.elvart_eredmeny, ''), 6000),
                                    'hatokor', left(coalesce(c.hatokor, ''), 6000),
                                    'payload', c.payload) as sor
            from grants.call c
           where c.archivalt = false
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
             and not exists (select 1 from grants.call_facet f where f.call_id = c.id)
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 5), 1), 25)) t
$$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text;
begin
  foreach f in array array[
    'public.grants_call_details_queue(integer,integer)',
    'public.grants_call_details_set(uuid,jsonb)',
    'public.grants_facet_queue(integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
    if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
  end loop;

  f := 'public.grants_call_details(uuid)';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('grant execute on function %s to authenticated', f); end if;

  execute 'revoke all on table grants.call_doc from public';
  if has_anon then execute 'revoke all on table grants.call_doc from anon'; end if;
  if has_auth then execute 'revoke all on table grants.call_doc from authenticated'; end if;
end $grants$;

do $chk$
declare f text;
begin
  foreach f in array array['public.grants_call_details_queue(integer,integer)',
                           'public.grants_call_details_set(uuid,jsonb)'] loop
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', f, 'execute') then
      raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is hivhatja az ETL-t: %', f;
    end if;
  end loop;
  raise notice 'Rendben: 99 — beadando dokumentumok, elvart eredmenyek, gazdagabb arculat-sor.';
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
