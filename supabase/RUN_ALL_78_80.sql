-- ============================================================================
-- RUN_ALL_78_80.sql — naptár + kutatói profil + felderítés (2026-09-24)
-- ============================================================================
-- Ezt kell lefuttatni a Supabase SQL Editorban. Újrafuttatható; ha a 78-at vagy
-- a 79-et már futtattad, azok a részek nem változtatnak semmit.
--
--   78_grants_calendar.sql     — Határidőnaptár (grants_deadlines, …)
--   79_grants_researchers.sql  — kutatói törzs, publikációk, témaprofil,
--        kompetenciák, azonosító-összekötési javaslatok
--   80_grants_discovery.sql    — FELDERÍTÉS: kik vannak az NJE-hez affiliálva
--        az OpenAlex és az MTMT szerint. A talált szerzők külön táblába
--        kerülnek, a törzsbe csak kézi döntés után lépnek be.
--        Ez a fájl egyben szigorítja a 79-es automatikus ORCID-kötését is:
--        név-ellenőrzés nélkül nem köt (mérve: van olyan ORCID, amin a két
--        forrás két MÁS nevet mutat).
--   21_echo_harden_submit.sql  — a szokásos zárás, mindig utolsóként.
--
-- A FUTÁS VÉGÉN EZEKET KELL LÁTNOD:
--   NOTICE: Rendben: 78 — hatarido-naptar (...)
--   NOTICE: Rendben: 79 — kutatoi profil (...)
--   NOTICE: Rendben: 80 — felderites (discovered_author), forrasok: openalex, mtmt.
--
-- MI LESZ UTÁNA: a felderítő Edge Function (grants-discover) már telepítve van,
-- és próbamenetben mérve 727 OpenAlex- és 306 MTMT-szerzőt talál. A futtatás
-- után ezeket be tudom tölteni, és jön a „Kutatók" képernyő.
-- ============================================================================



-- ############################################################################
-- ### 78_grants_calendar.sql
-- ############################################################################

-- ============================================================
-- 78_grants_calendar.sql — határidő-naptár a pályázatfigyelőhöz
-- ============================================================
-- MIT AD:
--   • public.grants_deadlines(tól, ig, …) — a megadott időszak MINDEN
--     határidejét adja, felhívásonként akár többet (kétszakaszos pályázat,
--     fordulók). A katalóguslista ezt nem tudja: az felhívásonként EGY
--     sort ad a legközelebbi határidővel, ami naptárhoz nem elég.
--   • public.grants_deadline_months(tól, ig) — hónaponkénti darabszám a
--     naptár léptetéséhez (hogy látszódjon, melyik hónapban van egyáltalán
--     mit keresni).
--
-- MIÉRT SZERVEROLDALI SZŰRÉS: 2026-09-23-án 689 felhívás és ~1100 határidő
-- van a katalógusban, és ez nőni fog. A teljes lista letöltése és kliensen
-- szűrése ugyanazt a hibát ismételné, amit az EU-betöltőnél már megmértünk:
-- a nagy adathalmazt ott kell szűrni, ahol van.
--
-- JOGOSULTSÁG: ugyanaz, mint a katalógusnál — grants_office (a törzsben
-- ellenőrizve), az ETL-függvényekkel ellentétben authenticated hívhatja.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. A határidők egy időszakra
-- ------------------------------------------------------------
-- Egy sor = EGY határidő. A felhívás adatai ismétlődnek, mert a naptárban a
-- határidő a rendezőelv, nem a felhívás.
create or replace function public.grants_deadlines(
  p_tol      date    default null,
  p_ig       date    default null,
  p_allapot  text    default null,
  p_program  text    default null,
  p_forras   text    default null,
  p_limit    integer default 500
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_tol  date    := coalesce(p_tol, date_trunc('month', now())::date);
  v_ig   date    := coalesce(p_ig, (date_trunc('month', now()) + interval '1 month - 1 day')::date);
  v_lim  integer := least(greatest(coalesce(p_limit, 500), 1), 3000);
  v_out  jsonb;
  v_ossz integer;
begin
  perform grants.require_office();
  if v_ig < v_tol then
    raise exception 'GRANTS_BAD_INPUT: a záró dátum nem lehet a kezdő előtt.';
  end if;
  -- Egy ésszerű felső korlát: a naptár hónapokban lépteti magát, egy év
  -- fölötti időszakra nincs értelme mindent egyszerre lekérni.
  if v_ig - v_tol > 400 then
    raise exception 'GRANTS_BAD_INPUT: legfeljebb 400 napos időszak kérdezhető egyszerre.';
  end if;

  select count(*) into v_ossz
    from grants.call_deadline d
    join grants.call c on c.id = d.call_id
   where c.archivalt = false
     and d.hatarido::date between v_tol and v_ig
     and (p_allapot is null or c.allapot = p_allapot)
     and (p_program is null or c.program = p_program)
     and (p_forras  is null or c.source_kod = p_forras);

  select coalesce(jsonb_agg(x order by hat, cim), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'call_id',    c.id,
             'azonosito',  c.kulso_azonosito,
             'cim',        c.cim,
             'program',    c.program,
             'alprogram',  c.alprogram,
             'allapot',    c.allapot,
             'forras',     c.source_kod,
             'url',        c.url,
             'partnerkereses', c.partnerkereses,
             'sorszam',    d.sorszam,
             -- Hány határidő tartozik ehhez a felhíváshoz összesen: ebből tudja
             -- a felület kiírni, hogy ez a "2. forduló a háromból".
             'hatarido_db', (select count(*) from grants.call_deadline d2 where d2.call_id = c.id),
             'hatarido',   d.hatarido,
             'nap',        d.hatarido::date,
             'hatralevo_nap', d.hatarido::date - current_date,
             'megjegyzes', d.megjegyzes
           ) as x,
           d.hatarido as hat, c.cim as cim
      from grants.call_deadline d
      join grants.call c on c.id = d.call_id
     where c.archivalt = false
       and d.hatarido::date between v_tol and v_ig
       and (p_allapot is null or c.allapot = p_allapot)
       and (p_program is null or c.program = p_program)
       and (p_forras  is null or c.source_kod = p_forras)
     order by d.hatarido, c.cim
     limit v_lim
  ) t;

  return jsonb_build_object(
    'tol', v_tol, 'ig', v_ig, 'ossz', v_ossz,
    'mutatva', jsonb_array_length(v_out), 'hatar', v_lim,
    'sorok', v_out,
    -- Naponkénti darabszám: a naptárrács ebből színez, és nem kell hozzá a
    -- teljes sorlistát végignézni a kliensen.
    'naponta', (select coalesce(jsonb_object_agg(nap::text, db), '{}'::jsonb)
                  from (select d.hatarido::date as nap, count(*) as db
                          from grants.call_deadline d
                          join grants.call c on c.id = d.call_id
                         where c.archivalt = false
                           and d.hatarido::date between v_tol and v_ig
                           and (p_allapot is null or c.allapot = p_allapot)
                           and (p_program is null or c.program = p_program)
                           and (p_forras  is null or c.source_kod = p_forras)
                         group by 1) n));
end $$;


-- ------------------------------------------------------------
-- 2. Hónaponkénti darabszám a léptetéshez
-- ------------------------------------------------------------
create or replace function public.grants_deadline_months(
  p_tol date default null,
  p_ig  date default null
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_tol date := coalesce(p_tol, (date_trunc('month', now()) - interval '6 months')::date);
  v_ig  date := coalesce(p_ig,  (date_trunc('month', now()) + interval '18 months')::date);
begin
  perform grants.require_office();
  return (
    select coalesce(jsonb_agg(jsonb_build_object('honap', h, 'db', db) order by h), '[]'::jsonb)
      from (select to_char(date_trunc('month', d.hatarido), 'YYYY-MM') as h, count(*) as db
              from grants.call_deadline d
              join grants.call c on c.id = d.call_id
             where c.archivalt = false
               and d.hatarido::date between v_tol and v_ig
             group by 1) t);
end $$;


-- ------------------------------------------------------------
-- 3. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
begin
  foreach f in array array[
    'public.grants_deadlines(date,date,text,text,text,integer)',
    'public.grants_deadline_months(date,date)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

do $chk$
begin
  if has_function_privilege('anon', 'public.grants_deadlines(date,date,text,text,text,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a hatarido-naptarat.';
  end if;
  raise notice 'Rendben: 78 — hatarido-naptar (grants_deadlines, grants_deadline_months).';
end $chk$;


-- ############################################################################
-- ### 79_grants_researchers.sql
-- ############################################################################

-- ============================================================
-- 79_grants_researchers.sql — Pályázati modul, 2. fázis: kutatói profil
-- ============================================================
-- MIT AD:
--   • grants.researcher            — kutatói törzs (oktató, kutató, PhD-s,
--     kutatási asszisztens), azonosítókkal: ORCID, OpenAlex, MTMT
--   • grants.researcher_work       — publikációk két forrásból, DOI-alapú dedup
--   • grants.researcher_topic      — a művekből számolt témaprofil, súlyokkal
--   • grants.researcher_skill      — amit CSAK a kutató tud (módszer, labor,
--     TRL, nyelv, ipari kapcsolat, szerep-preferencia)
--   • grants.identity_candidate    — azonosító-összekötési JAVASLATOK; a
--     véglegesítés kézi döntés, kivéve az ORCID-egyezést
--   • olvasó és író RPC-k az irodai felületnek, plusz service_role-os
--     betöltő RPC-k a grants-fetch-profiles Edge Functionnek
--
-- MIÉRT NEM AUTOMATIKUS AZ ÖSSZEKÖTÉS: két „dr. Kovács János" összekeverése
-- hamis publikációs listát, abból hamis témaprofilt, abból értelmetlen
-- javaslatokat ad. Ezért az OpenAlex szerzői azonosítót SOHA nem rögzítjük
-- magától — kivéve, ha ORCID egyezik, mert az személyhez kötött azonosító.
-- Mérve (2026-09-23): az NJE 771 OpenAlex-szerzőjéből 389-nek van ORCID-je,
-- tehát a maradéknál valóban kell az emberi döntés.
--
-- MIÉRT VAN OPT-OUT: a 2026-09-23-i döntés szerint a profil mindenkire épül,
-- de bárki kikapcsolhatja. A kikapcsolt profil nem frissül és nem kerül be
-- sem a javaslatokba, sem a csapatajánlásba — a meglévő adata megmarad, hogy
-- a visszakapcsolás ne kezdje nulláról.
--
-- AMI IDE SOHA NEM KERÜL: ECHO-eredmény, hallgatói értékelés, HR- vagy
-- béradat. Az ECHO névtelensége és jogalapja más; ha egy pályázati profil
-- oktatási értékelést mutatna, azzal az ECHO-ról tett ígéretet szegnénk meg.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Kutatói törzs
-- ------------------------------------------------------------
create table if not exists grants.researcher (
  id            uuid primary key default gen_random_uuid(),
  -- Kétféle kötés, mindkettő opcionális: UniPortal-fiók (hallgató, PhD-s,
  -- asszisztens is lehet) és oktatói nyilvántartás (echo.teacher).
  profile_id    uuid references public.profiles(id) on delete set null,
  teacher_id    uuid references echo.teacher(id)    on delete set null,
  nev           text not null,
  cim           text,                                  -- 'dr.', 'egyetemi docens'
  tipus         text not null default 'oktato'
                  constraint grants_researcher_tipus_ck
                  check (tipus in ('oktato','kutato','phd','asszisztens','egyeb')),
  kar           text,
  intezet       text,
  email         text,
  -- Azonosítók. Az ORCID az ELSŐDLEGES kulcs: az OpenAlex szerzői azonosító a
  -- saját dokumentációja szerint is újraszámolt érték, és össze tud olvasztani
  -- két embert.
  orcid         text,
  openalex_id   text,
  mtmt_id       text,
  scopus_id     text,
  allapot       text not null default 'aktiv'
                  constraint grants_researcher_allapot_ck check (allapot in ('aktiv','inaktiv')),
  -- Opt-out: false értéknél a gépi profilépítés kihagyja, és a javaslatokból
  -- is kimarad. A meglévő adatot NEM töröljük.
  gepi_epites   boolean not null default true,
  -- Szerepeljen-e a BELSŐ csapatkeresésben. Külön kapcsoló: aki nem kérte, azt
  -- a csapatajánló nem kínálja fel.
  csapatkereses boolean not null default false,
  portre        text,                                  -- egy bekezdés kutatói összefoglaló
  portre_forras text,                                  -- 'modell' | 'kezi'
  portre_allapot text not null default 'nincs'
                  constraint grants_researcher_portre_ck
                  check (portre_allapot in ('nincs','piszkozat','elfogadva')),
  utolso_szinkron timestamptz,
  szinkron_hiba text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists grants_researcher_teacher_uidx  on grants.researcher (teacher_id) where teacher_id is not null;
create unique index if not exists grants_researcher_profile_uidx  on grants.researcher (profile_id) where profile_id is not null;
create unique index if not exists grants_researcher_orcid_uidx    on grants.researcher (lower(orcid)) where orcid is not null;
create unique index if not exists grants_researcher_openalex_uidx on grants.researcher (openalex_id) where openalex_id is not null;
create unique index if not exists grants_researcher_mtmt_uidx     on grants.researcher (mtmt_id) where mtmt_id is not null;
create index        if not exists grants_researcher_nev_idx       on grants.researcher (lower(nev));
create index        if not exists grants_researcher_szinkron_idx  on grants.researcher (utolso_szinkron nulls first)
  where allapot = 'aktiv' and gepi_epites = true;

comment on column grants.researcher.gepi_epites is
  'Opt-out kapcsoló. False értéknél a profil nem frissül és nem kerül javaslatba — a meglévő adat megmarad, hogy a visszakapcsolás ne kezdjen nulláról.';
comment on column grants.researcher.orcid is
  'Az ELSŐDLEGES azonosító. Az OpenAlex szerzői azonosító csak másodlagos: azt a saját dokumentációja szerint is újraszámolják, és összeolvaszthat két személyt.';


-- ------------------------------------------------------------
-- 2. Publikációk
-- ------------------------------------------------------------
create table if not exists grants.researcher_work (
  id            uuid primary key default gen_random_uuid(),
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  forras        text not null
                  constraint grants_work_forras_ck check (forras in ('openalex','mtmt','kezi')),
  kulso_id      text,
  doi           text,
  cim           text not null,
  ev            integer,
  tipus         text,
  forrasnev     text,                                  -- folyóirat, konferencia, kiadó
  idezet        integer,
  szerzoi_pozicio text
                  constraint grants_work_pozicio_ck
                  check (szerzoi_pozicio is null
                         or szerzoi_pozicio in ('elso','utolso','kozepso','ismeretlen')),
  nyelv         text,
  nyilt_hozzaferes boolean,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create unique index if not exists grants_work_kulcs_uidx on grants.researcher_work (researcher_id, forras, kulso_id)
  where kulso_id is not null;
create index if not exists grants_work_researcher_idx on grants.researcher_work (researcher_id, ev desc);
-- A DOI a két forrás közötti join-kulcs: ezen ismerjük fel, hogy az MTMT-ből és
-- az OpenAlexből ugyanaz a mű jött be.
create index if not exists grants_work_doi_idx on grants.researcher_work (lower(doi)) where doi is not null;


-- ------------------------------------------------------------
-- 3. Témaprofil
-- ------------------------------------------------------------
-- A súly SZÁMÍTOTT érték: a friss művek és az első/utolsó szerzőség többet
-- nyomnak. A számítás a betöltőben van, mert ott van a mű teljes adata; ide
-- csak az eredmény kerül, forrásmegjelöléssel — hogy később meg lehessen
-- mondani, egy témacímke honnan származik.
create table if not exists grants.researcher_topic (
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  szint         text not null
                  constraint grants_topic_szint_ck check (szint in ('topic','subfield','field','domain')),
  topic         text not null,
  suly          numeric(10,3) not null default 0,
  mu_db         integer not null default 0,
  forras        text not null default 'openalex',
  primary key (researcher_id, szint, topic)
);
create index if not exists grants_topic_suly_idx on grants.researcher_topic (researcher_id, szint, suly desc);

-- Amit publikációból nem lehet kiolvasni: módszertan, infrastruktúra, TRL-sáv,
-- nyelvtudás, ipari kapcsolat, szerep-preferencia. Ezt a kutató (vagy az iroda)
-- adja meg.
create table if not exists grants.researcher_skill (
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  kulcs         text not null
                  constraint grants_skill_kulcs_ck
                  check (kulcs in ('modszer','infrastruktura','nyelv','trl','ipari','szerep','egyeb')),
  ertek         text not null,
  megjegyzes    text,
  primary key (researcher_id, kulcs, ertek)
);


-- ------------------------------------------------------------
-- 4. Azonosító-összekötési javaslatok
-- ------------------------------------------------------------
create table if not exists grants.identity_candidate (
  id            uuid primary key default gen_random_uuid(),
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  forras        text not null
                  constraint grants_cand_forras_ck check (forras in ('openalex','mtmt')),
  kulso_id      text not null,
  nev           text,
  intezmeny     text,
  orcid         text,
  mu_db         integer,
  idezet        integer,
  -- 0..1 közötti hasonlósági pontszám, és az indoklás: mi alapján javasoljuk.
  -- A felület ezt mutatja, hogy a döntés ne vaktában történjen.
  pontszam      numeric(4,3),
  indok         jsonb not null default '{}'::jsonb,
  allapot       text not null default 'javasolt'
                  constraint grants_cand_allapot_ck
                  check (allapot in ('javasolt','megerositve','elvetve')),
  created_at    timestamptz not null default now(),
  dontes_at     timestamptz,
  dontes_by     uuid
);
create unique index if not exists grants_cand_kulcs_uidx on grants.identity_candidate (researcher_id, forras, kulso_id);
create index if not exists grants_cand_allapot_idx on grants.identity_candidate (allapot, forras);


-- ------------------------------------------------------------
-- 5. Segédfüggvények
-- ------------------------------------------------------------
-- Az ORCID normalizálása: a szám a kulcs, nem a formátum. Elfogadjuk a puszta
-- 16 jegyű alakot, a kötőjeleset és a teljes URL-t is.
create or replace function grants.orcid_norm(p text)
returns text
language sql immutable
as $$
  select case
    when p is null or btrim(p) = '' then null
    else nullif(regexp_replace(upper(btrim(p)), '^.*ORCID\.ORG/', '') , '')
  end
$$;

-- Egy kutató „hiányossága": mi hiányzik ahhoz, hogy a profil használható legyen.
-- A felület ezt írja ki, hogy a kutató lássa, mit veszít vele.
create or replace function grants.researcher_hianyok(p_id uuid)
returns text[]
language plpgsql stable
set search_path = grants, public, pg_temp
as $$
declare
  r grants.researcher%rowtype;
  h text[] := '{}';
  v_mu integer;
  v_topic integer;
  v_skill integer;
begin
  select * into r from grants.researcher where id = p_id;
  if not found then return h; end if;
  select count(*) into v_mu    from grants.researcher_work  where researcher_id = p_id;
  select count(*) into v_topic from grants.researcher_topic where researcher_id = p_id;
  select count(*) into v_skill from grants.researcher_skill where researcher_id = p_id;

  if r.orcid is null then
    h := array_append(h, 'Nincs ORCID: enélkül a publikációk egy része nem található meg, és kevesebb javaslat jön.');
  end if;
  if r.openalex_id is null and r.mtmt_id is null then
    h := array_append(h, 'Nincs összekötött publikációs azonosító (OpenAlex vagy MTMT).');
  end if;
  if v_mu = 0 then
    h := array_append(h, 'Nincs betöltött publikáció.');
  end if;
  if v_topic = 0 then
    h := array_append(h, 'Nincs témaprofil — illesztés csak ennek alapján lehetséges.');
  end if;
  if v_skill = 0 then
    h := array_append(h, 'Nincs megadva módszer, infrastruktúra vagy TRL — ezt publikációból nem lehet kiolvasni.');
  end if;
  if r.portre_allapot = 'piszkozat' then
    h := array_append(h, 'A kutatói portré piszkozat: jóváhagyásra vár.');
  end if;
  return h;
end $$;


-- ------------------------------------------------------------
-- 6. Olvasó RPC-k (iroda)
-- ------------------------------------------------------------
create or replace function public.grants_researchers(
  p_q       text    default null,
  p_tipus   text    default null,
  p_kar     text    default null,
  p_allapot text    default null,
  p_szures  text    default null,     -- 'jelolt' | 'hianyos' | 'kikapcsolt' | null
  p_limit   integer default 100,
  p_offset  integer default 0
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_lim  integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off  integer := greatest(coalesce(p_offset, 0), 0);
  v_q    text    := nullif(btrim(coalesce(p_q, '')), '');
  v_ossz integer;
  v_sorok jsonb;
begin
  perform grants.require_office();

  select count(*) into v_ossz
    from grants.researcher r
   where (p_tipus   is null or r.tipus = p_tipus)
     and (p_kar     is null or r.kar = p_kar)
     and (p_allapot is null or r.allapot = p_allapot)
     and (v_q is null or r.nev ilike '%' || v_q || '%'
          or coalesce(r.orcid,'') ilike '%' || v_q || '%'
          or coalesce(r.email,'') ilike '%' || v_q || '%')
     and (p_szures is null
          or (p_szures = 'kikapcsolt' and r.gepi_epites = false)
          or (p_szures = 'jelolt' and exists (select 1 from grants.identity_candidate c
                                               where c.researcher_id = r.id and c.allapot = 'javasolt'))
          or (p_szures = 'hianyos' and (r.openalex_id is null and r.mtmt_id is null)));

  select coalesce(jsonb_agg(x order by nev), '[]'::jsonb) into v_sorok
  from (
    select jsonb_build_object(
             'id', r.id, 'nev', r.nev, 'cim', r.cim, 'tipus', r.tipus,
             'kar', r.kar, 'intezet', r.intezet, 'email', r.email,
             'orcid', r.orcid, 'openalex_id', r.openalex_id, 'mtmt_id', r.mtmt_id,
             'allapot', r.allapot, 'gepi_epites', r.gepi_epites,
             'csapatkereses', r.csapatkereses,
             'utolso_szinkron', r.utolso_szinkron, 'szinkron_hiba', r.szinkron_hiba,
             'mu_db',    (select count(*) from grants.researcher_work w where w.researcher_id = r.id),
             'topic_db', (select count(*) from grants.researcher_topic t where t.researcher_id = r.id),
             'jelolt_db',(select count(*) from grants.identity_candidate c
                           where c.researcher_id = r.id and c.allapot = 'javasolt'),
             'hianyok',  to_jsonb(grants.researcher_hianyok(r.id))
           ) as x, r.nev as nev
      from grants.researcher r
     where (p_tipus   is null or r.tipus = p_tipus)
       and (p_kar     is null or r.kar = p_kar)
       and (p_allapot is null or r.allapot = p_allapot)
       and (v_q is null or r.nev ilike '%' || v_q || '%'
            or coalesce(r.orcid,'') ilike '%' || v_q || '%'
            or coalesce(r.email,'') ilike '%' || v_q || '%')
       and (p_szures is null
            or (p_szures = 'kikapcsolt' and r.gepi_epites = false)
            or (p_szures = 'jelolt' and exists (select 1 from grants.identity_candidate c
                                                 where c.researcher_id = r.id and c.allapot = 'javasolt'))
            or (p_szures = 'hianyos' and (r.openalex_id is null and r.mtmt_id is null)))
     order by r.nev
     limit v_lim offset v_off
  ) t;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_sorok),
                            'hatar', v_lim, 'eltolas', v_off, 'sorok', v_sorok);
end $$;

create or replace function public.grants_researcher_get(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare r grants.researcher%rowtype; v_out jsonb;
begin
  perform grants.require_office();
  select * into r from grants.researcher where id = p_id;
  if not found then raise exception 'GRANTS_RESEARCHER_NOT_FOUND'; end if;

  select jsonb_build_object(
    'id', r.id, 'nev', r.nev, 'cim', r.cim, 'tipus', r.tipus,
    'kar', r.kar, 'intezet', r.intezet, 'email', r.email,
    'orcid', r.orcid, 'openalex_id', r.openalex_id, 'mtmt_id', r.mtmt_id,
    'scopus_id', r.scopus_id, 'allapot', r.allapot,
    'gepi_epites', r.gepi_epites, 'csapatkereses', r.csapatkereses,
    'portre', r.portre, 'portre_forras', r.portre_forras, 'portre_allapot', r.portre_allapot,
    'utolso_szinkron', r.utolso_szinkron, 'szinkron_hiba', r.szinkron_hiba,
    'teacher_id', r.teacher_id, 'profile_id', r.profile_id,
    'hianyok', to_jsonb(grants.researcher_hianyok(r.id)),
    'szamok', jsonb_build_object(
      'mu',       (select count(*) from grants.researcher_work w where w.researcher_id = r.id),
      'mu_openalex', (select count(*) from grants.researcher_work w where w.researcher_id = r.id and w.forras = 'openalex'),
      'mu_mtmt',  (select count(*) from grants.researcher_work w where w.researcher_id = r.id and w.forras = 'mtmt'),
      'idezet',   (select coalesce(sum(w.idezet), 0) from grants.researcher_work w where w.researcher_id = r.id),
      'elso_ev',  (select min(w.ev) from grants.researcher_work w where w.researcher_id = r.id),
      'utolso_ev',(select max(w.ev) from grants.researcher_work w where w.researcher_id = r.id)),
    'temak', (select coalesce(jsonb_agg(jsonb_build_object(
                  'szint', t.szint, 'topic', t.topic, 'suly', t.suly, 'mu_db', t.mu_db)
                  order by t.suly desc), '[]'::jsonb)
                from (select * from grants.researcher_topic where researcher_id = r.id
                       order by suly desc limit 40) t),
    'kompetenciak', (select coalesce(jsonb_agg(jsonb_build_object(
                  'kulcs', s.kulcs, 'ertek', s.ertek, 'megjegyzes', s.megjegyzes)
                  order by s.kulcs, s.ertek), '[]'::jsonb)
                from grants.researcher_skill s where s.researcher_id = r.id),
    'jeloltek', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', c.id, 'forras', c.forras, 'kulso_id', c.kulso_id, 'nev', c.nev,
                  'intezmeny', c.intezmeny, 'orcid', c.orcid, 'mu_db', c.mu_db,
                  'idezet', c.idezet, 'pontszam', c.pontszam, 'indok', c.indok,
                  'allapot', c.allapot, 'dontes_at', c.dontes_at)
                  order by c.allapot, c.pontszam desc nulls last), '[]'::jsonb)
                from grants.identity_candidate c where c.researcher_id = r.id),
    'muvek', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', w.id, 'cim', w.cim, 'ev', w.ev, 'doi', w.doi, 'tipus', w.tipus,
                  'forrasnev', w.forrasnev, 'idezet', w.idezet, 'forras', w.forras,
                  'szerzoi_pozicio', w.szerzoi_pozicio)
                  order by w.ev desc nulls last, w.cim), '[]'::jsonb)
                from (select * from grants.researcher_work where researcher_id = r.id
                       order by ev desc nulls last limit 30) w)
  ) into v_out;
  return v_out;
end $$;

create or replace function public.grants_researcher_options()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_out jsonb;
begin
  perform grants.require_office();
  select jsonb_build_object(
    'kar', (select coalesce(jsonb_agg(jsonb_build_object('ertek', k, 'db', n) order by n desc), '[]'::jsonb)
              from (select kar k, count(*) n from grants.researcher where kar is not null group by 1) t),
    'tipus', (select coalesce(jsonb_agg(jsonb_build_object('ertek', k, 'db', n) order by n desc), '[]'::jsonb)
              from (select tipus k, count(*) n from grants.researcher group by 1) t),
    'szamok', jsonb_build_object(
      'osszes',      (select count(*) from grants.researcher),
      'aktiv',       (select count(*) from grants.researcher where allapot = 'aktiv'),
      'kikapcsolt',  (select count(*) from grants.researcher where gepi_epites = false),
      'osszekotve',  (select count(*) from grants.researcher where openalex_id is not null or mtmt_id is not null),
      'orcid',       (select count(*) from grants.researcher where orcid is not null),
      'jelolt',      (select count(*) from grants.identity_candidate where allapot = 'javasolt'),
      'mu',          (select count(*) from grants.researcher_work),
      'szinkronra_var', (select count(*) from grants.researcher
                          where allapot = 'aktiv' and gepi_epites = true
                            and (utolso_szinkron is null or utolso_szinkron < now() - interval '7 days')))
  ) into v_out;
  return v_out;
end $$;


-- ------------------------------------------------------------
-- 7. Író RPC-k (iroda)
-- ------------------------------------------------------------
create or replace function public.grants_researcher_save(p_adat jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_id    uuid := nullif(p_adat->>'id', '')::uuid;
  v_nev   text := nullif(btrim(coalesce(p_adat->>'nev', '')), '');
  v_orcid text := grants.orcid_norm(p_adat->>'orcid');
  v_tipus text := coalesce(nullif(p_adat->>'tipus', ''), 'oktato');
begin
  perform grants.require_office();
  if v_id is null and v_nev is null then
    raise exception 'GRANTS_BAD_INPUT: a kutató neve kötelező.';
  end if;
  if v_tipus not in ('oktato','kutato','phd','asszisztens','egyeb') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen típus: "%".', v_tipus;
  end if;
  -- Az ORCID formátuma: 16 karakter, kötőjelekkel vagy anélkül, végén X is lehet.
  if v_orcid is not null and v_orcid !~ '^[0-9]{4}-?[0-9]{4}-?[0-9]{4}-?[0-9]{3}[0-9X]$' then
    raise exception 'GRANTS_BAD_INPUT: az ORCID formátuma nem megfelelő: "%".', v_orcid;
  end if;

  if v_id is null then
    insert into grants.researcher (nev, cim, tipus, kar, intezet, email, orcid, mtmt_id,
                                   allapot, gepi_epites, csapatkereses, teacher_id, profile_id)
    values (v_nev, nullif(p_adat->>'cim',''), v_tipus,
            nullif(p_adat->>'kar',''), nullif(p_adat->>'intezet',''), nullif(p_adat->>'email',''),
            v_orcid, nullif(p_adat->>'mtmt_id',''),
            coalesce(nullif(p_adat->>'allapot',''), 'aktiv'),
            coalesce((p_adat->>'gepi_epites')::boolean, true),
            coalesce((p_adat->>'csapatkereses')::boolean, false),
            nullif(p_adat->>'teacher_id','')::uuid, nullif(p_adat->>'profile_id','')::uuid)
    returning id into v_id;
  else
    update grants.researcher set
      nev           = coalesce(v_nev, nev),
      cim           = coalesce(nullif(p_adat->>'cim',''), cim),
      tipus         = v_tipus,
      kar           = coalesce(nullif(p_adat->>'kar',''), kar),
      intezet       = coalesce(nullif(p_adat->>'intezet',''), intezet),
      email         = coalesce(nullif(p_adat->>'email',''), email),
      orcid         = coalesce(v_orcid, orcid),
      mtmt_id       = coalesce(nullif(p_adat->>'mtmt_id',''), mtmt_id),
      allapot       = coalesce(nullif(p_adat->>'allapot',''), allapot),
      gepi_epites   = coalesce((p_adat->>'gepi_epites')::boolean, gepi_epites),
      csapatkereses = coalesce((p_adat->>'csapatkereses')::boolean, csapatkereses),
      -- A portré a kutató szövege: ha kapunk újat, piszkozatból elfogadottá is
      -- léphet, de ETL SOHA nem írja át (ez az RPC nem a betöltő útja).
      portre        = case when p_adat ? 'portre' then nullif(p_adat->>'portre','') else portre end,
      portre_allapot = coalesce(nullif(p_adat->>'portre_allapot',''), portre_allapot),
      updated_at    = now()
     where id = v_id;
    if not found then raise exception 'GRANTS_RESEARCHER_NOT_FOUND'; end if;
  end if;

  return public.grants_researcher_get(v_id);
end $$;

-- Kompetenciák (módszer, labor, TRL, nyelv, ipari kapcsolat, szerep): teljes
-- csere, mert a felület a teljes listát küldi.
create or replace function public.grants_researcher_skills_set(p_id uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_it jsonb;
begin
  perform grants.require_office();
  if not exists (select 1 from grants.researcher where id = p_id) then
    raise exception 'GRANTS_RESEARCHER_NOT_FOUND';
  end if;
  delete from grants.researcher_skill where researcher_id = p_id;
  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce(nullif(btrim(coalesce(v_it->>'ertek','')), ''), '') <> '' then
      insert into grants.researcher_skill (researcher_id, kulcs, ertek, megjegyzes)
      values (p_id, coalesce(nullif(v_it->>'kulcs',''), 'egyeb'),
              btrim(v_it->>'ertek'), nullif(v_it->>'megjegyzes',''))
      on conflict do nothing;
    end if;
  end loop;
  return public.grants_researcher_get(p_id);
end $$;

-- Azonosító-összekötés eldöntése. Megerősítésnél a kutató rekordjára kerül az
-- azonosító, és a forrás TÖBBI javaslata elvetve — egy emberhez egy azonosító.
create or replace function public.grants_identity_decide(p_candidate uuid, p_dontes text)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare c grants.identity_candidate%rowtype;
begin
  perform grants.require_office();
  if p_dontes not in ('megerositve','elvetve') then
    raise exception 'GRANTS_BAD_INPUT: a döntés csak megerositve vagy elvetve lehet.';
  end if;
  select * into c from grants.identity_candidate where id = p_candidate for update;
  if not found then raise exception 'GRANTS_CANDIDATE_NOT_FOUND'; end if;

  update grants.identity_candidate
     set allapot = p_dontes, dontes_at = now(), dontes_by = auth.uid()
   where id = p_candidate;

  if p_dontes = 'megerositve' then
    if c.forras = 'openalex' then
      update grants.researcher set openalex_id = c.kulso_id,
             orcid = coalesce(orcid, grants.orcid_norm(c.orcid)),
             -- Az új kötés után újra kell szinkronizálni: a régi művek más
             -- emberhez tartozhattak.
             utolso_szinkron = null, updated_at = now()
       where id = c.researcher_id;
    elsif c.forras = 'mtmt' then
      update grants.researcher set mtmt_id = c.kulso_id,
             utolso_szinkron = null, updated_at = now()
       where id = c.researcher_id;
    end if;
    -- Ugyanabból a forrásból a többi javaslat elesik.
    update grants.identity_candidate
       set allapot = 'elvetve', dontes_at = now(), dontes_by = auth.uid()
     where researcher_id = c.researcher_id and forras = c.forras
       and id <> p_candidate and allapot = 'javasolt';
  end if;

  return public.grants_researcher_get(c.researcher_id);
end $$;

-- Az összekötés VISSZAVONÁSA: ha kiderül, hogy más emberhez tartozott az
-- azonosító, a hozzá tartozó művek és témák is mennek — különben a hamis
-- adat ott maradna, és senki nem értené, honnan van.
create or replace function public.grants_identity_clear(p_id uuid, p_forras text)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  perform grants.require_office();
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: a forrás csak openalex vagy mtmt lehet.';
  end if;
  delete from grants.researcher_work where researcher_id = p_id and forras = p_forras;
  delete from grants.researcher_topic where researcher_id = p_id and forras = p_forras;
  update grants.identity_candidate set allapot = 'javasolt', dontes_at = null, dontes_by = null
   where researcher_id = p_id and forras = p_forras and allapot = 'megerositve';
  if p_forras = 'openalex' then
    update grants.researcher set openalex_id = null, utolso_szinkron = null, updated_at = now() where id = p_id;
  else
    update grants.researcher set mtmt_id = null, utolso_szinkron = null, updated_at = now() where id = p_id;
  end if;
  return public.grants_researcher_get(p_id);
end $$;

-- A kutatói törzs feltöltése az oktatói nyilvántartásból. Idempotens: aki már
-- benne van (teacher_id szerint), az nem duplázódik.
create or replace function public.grants_researcher_sync_teachers()
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_uj integer := 0; v_ossz integer;
begin
  perform grants.require_office();
  with be as (
    insert into grants.researcher (teacher_id, profile_id, nev, cim, email, tipus, kar, intezet)
    select t.id, t.profile_id, t.name, t.title, t.email, 'oktato',
           -- A kar és az intézet a szervezeti fából: a legközelebbi 'kar', és
           -- a hozzá tartozó egység neve.
           (select o2.name_hu from echo.org_unit o2
             where o2.id = (with recursive f as (
                              select o.id, o.parent_id, o.kind from echo.org_unit o where o.id = t.org_unit_id
                              union all
                              select p.id, p.parent_id, p.kind from echo.org_unit p join f on f.parent_id = p.id)
                            select id from f where kind = 'kar' limit 1)),
           (select o3.name_hu from echo.org_unit o3 where o3.id = t.org_unit_id)
      from echo.teacher t
     where t.active = true
       and not exists (select 1 from grants.researcher r where r.teacher_id = t.id)
    returning 1)
  select count(*) into v_uj from be;
  select count(*) into v_ossz from grants.researcher;
  return jsonb_build_object('uj', v_uj, 'osszes', v_ossz);
end $$;


-- ------------------------------------------------------------
-- 8. Betöltő RPC-k (service_role — a grants-fetch-profiles Edge Function)
-- ------------------------------------------------------------
-- Kiket kell szinkronizálni: aktív, gépi építést engedő profilok, a legrégebben
-- frissítettek elöl. A kikapcsolt (opt-out) profil SOHA nem kerül ide.
create or replace function public.grants_researchers_to_sync(p_limit integer default 10, p_napok integer default 7)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', r.id, 'nev', r.nev, 'orcid', r.orcid,
             'openalex_id', r.openalex_id, 'mtmt_id', r.mtmt_id,
             'utolso_szinkron', r.utolso_szinkron) order by r.utolso_szinkron nulls first), '[]'::jsonb)
      from (select * from grants.researcher
             where allapot = 'aktiv' and gepi_epites = true
               and (utolso_szinkron is null
                    or utolso_szinkron < now() - (greatest(coalesce(p_napok, 7), 0) * interval '1 day'))
             order by utolso_szinkron nulls first
             limit least(greatest(coalesce(p_limit, 10), 1), 200)) r);
end $$;

-- Javaslatok rögzítése. ORCID-egyezésnél a betöltő 'megerositve' állapotot is
-- kérhet — ez az EGYETLEN automatikus összekötés, mert az ORCID személyhez
-- kötött azonosító.
create or replace function public.grants_candidates_upsert(
  p_researcher uuid, p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_it jsonb; v_uj integer := 0; v_auto integer := 0; v_id uuid;
begin
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;
  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into grants.identity_candidate (researcher_id, forras, kulso_id, nev, intezmeny,
                                            orcid, mu_db, idezet, pontszam, indok, allapot)
    values (p_researcher, p_forras, v_it->>'kulso_id', nullif(v_it->>'nev',''),
            nullif(v_it->>'intezmeny',''), grants.orcid_norm(v_it->>'orcid'),
            nullif(v_it->>'mu_db','')::integer, nullif(v_it->>'idezet','')::integer,
            nullif(v_it->>'pontszam','')::numeric, coalesce(v_it->'indok', '{}'::jsonb),
            case when coalesce(v_it->>'orcid_egyezik','') = 'true' then 'megerositve' else 'javasolt' end)
    on conflict (researcher_id, forras, kulso_id) do update
       set nev = excluded.nev, intezmeny = excluded.intezmeny, orcid = excluded.orcid,
           mu_db = excluded.mu_db, idezet = excluded.idezet,
           pontszam = excluded.pontszam, indok = excluded.indok
    returning id into v_id;
    v_uj := v_uj + 1;

    -- ORCID-egyezés: azonnali kötés, indoklással a naplóban.
    if coalesce(v_it->>'orcid_egyezik','') = 'true' then
      v_auto := v_auto + 1;
      if p_forras = 'openalex' then
        update grants.researcher set openalex_id = v_it->>'kulso_id',
               orcid = coalesce(orcid, grants.orcid_norm(v_it->>'orcid')), updated_at = now()
         where id = p_researcher and openalex_id is null;
      else
        update grants.researcher set mtmt_id = v_it->>'kulso_id', updated_at = now()
         where id = p_researcher and mtmt_id is null;
      end if;
    end if;
  end loop;
  return jsonb_build_object('rogzitve', v_uj, 'orcid_alapjan_kotve', v_auto);
end $$;

-- Publikációk betöltése. Idempotens: (kutató, forrás, külső azonosító) kulcson
-- upsertel, és a más forrásból DOI alapján már bent lévő művet nem duplázza,
-- csak jelzi a válaszban.
create or replace function public.grants_works_upsert(
  p_researcher uuid, p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_it jsonb; v_uj integer := 0; v_mod integer := 0; v_dupla integer := 0;
  v_doi text; v_letezik boolean;
begin
  if p_forras not in ('openalex','mtmt','kezi') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;
  if not exists (select 1 from grants.researcher where id = p_researcher) then
    raise exception 'GRANTS_RESEARCHER_NOT_FOUND';
  end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_doi := lower(nullif(btrim(coalesce(v_it->>'doi','')), ''));
    -- Ugyanaz a mű MÁS forrásból: nem hiba, csak nem duplázzuk a témasúlyokat.
    select exists (select 1 from grants.researcher_work w
                    where w.researcher_id = p_researcher and w.forras <> p_forras
                      and v_doi is not null and lower(w.doi) = v_doi) into v_letezik;
    if v_letezik then v_dupla := v_dupla + 1; end if;

    insert into grants.researcher_work (researcher_id, forras, kulso_id, doi, cim, ev, tipus,
                                         forrasnev, idezet, szerzoi_pozicio, nyelv,
                                         nyilt_hozzaferes, payload)
    values (p_researcher, p_forras, nullif(v_it->>'kulso_id',''), v_doi,
            coalesce(nullif(btrim(coalesce(v_it->>'cim','')), ''), '(cím nélkül)'),
            nullif(v_it->>'ev','')::integer, nullif(v_it->>'tipus',''),
            nullif(v_it->>'forrasnev',''), nullif(v_it->>'idezet','')::integer,
            nullif(v_it->>'szerzoi_pozicio',''), nullif(v_it->>'nyelv',''),
            (v_it->>'nyilt_hozzaferes')::boolean, coalesce(v_it->'payload', '{}'::jsonb))
    on conflict (researcher_id, forras, kulso_id) where kulso_id is not null do update
       set cim = excluded.cim, ev = excluded.ev, tipus = excluded.tipus,
           forrasnev = excluded.forrasnev, idezet = excluded.idezet,
           szerzoi_pozicio = excluded.szerzoi_pozicio, doi = excluded.doi,
           nyelv = excluded.nyelv, nyilt_hozzaferes = excluded.nyilt_hozzaferes,
           payload = excluded.payload;
    if found then v_mod := v_mod + 1; else v_uj := v_uj + 1; end if;
  end loop;

  update grants.researcher set utolso_szinkron = now(), szinkron_hiba = null, updated_at = now()
   where id = p_researcher;

  return jsonb_build_object('feldolgozva', v_uj + v_mod, 'mas_forrasbol_mar_megvolt', v_dupla);
end $$;

-- Témaprofil cseréje egy forrásra. A súlyt a betöltő számolja, mert ott van a
-- mű teljes adata; ide csak az eredmény kerül.
create or replace function public.grants_topics_set(
  p_researcher uuid, p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_it jsonb; v_db integer := 0;
begin
  if not exists (select 1 from grants.researcher where id = p_researcher) then
    raise exception 'GRANTS_RESEARCHER_NOT_FOUND';
  end if;
  delete from grants.researcher_topic where researcher_id = p_researcher and forras = p_forras;
  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into grants.researcher_topic (researcher_id, szint, topic, suly, mu_db, forras)
    values (p_researcher, coalesce(nullif(v_it->>'szint',''), 'topic'),
            btrim(v_it->>'topic'), coalesce(nullif(v_it->>'suly','')::numeric, 0),
            coalesce(nullif(v_it->>'mu_db','')::integer, 0), p_forras)
    on conflict (researcher_id, szint, topic) do update
       set suly = excluded.suly, mu_db = excluded.mu_db, forras = excluded.forras;
    v_db := v_db + 1;
  end loop;
  return jsonb_build_object('temak', v_db);
end $$;

-- Szinkronhiba rögzítése: ha egy kutatónál elhasal a betöltés, az LÁTSZÓDJON a
-- felületen, ne csak a naplóban.
create or replace function public.grants_researcher_sync_error(p_researcher uuid, p_hiba text)
returns void
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  update grants.researcher
     set szinkron_hiba = left(coalesce(p_hiba, 'ismeretlen hiba'), 500),
         utolso_szinkron = now(), updated_at = now()
   where id = p_researcher;
end $$;


-- ------------------------------------------------------------
-- 9. Jogosultságok
-- ------------------------------------------------------------
-- FONTOS (mérve 2026-09-23): a Supabase az új public sémás függvényekre az
-- anon ÉS az authenticated szerepkörnek is ad alapértelmezett jogot, ezért a
-- service_role-nak szánt függvényekről MINDKETTŐT vissza kell vonni.
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  -- Belső segédfüggvények: senkinek.
  foreach f in array array[
    'grants.orcid_norm(text)', 'grants.researcher_hianyok(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  -- Felületi RPC-k: bejelentkezett felhasználónak (a törzs dönt a jogról).
  foreach f in array array[
    'public.grants_researchers(text,text,text,text,text,integer,integer)',
    'public.grants_researcher_get(uuid)',
    'public.grants_researcher_options()',
    'public.grants_researcher_save(jsonb)',
    'public.grants_researcher_skills_set(uuid,jsonb)',
    'public.grants_identity_decide(uuid,text)',
    'public.grants_identity_clear(uuid,text)',
    'public.grants_researcher_sync_teachers()'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- Betöltő RPC-k: CSAK a service_role.
  foreach f in array array[
    'public.grants_researchers_to_sync(integer,integer)',
    'public.grants_candidates_upsert(uuid,text,jsonb)',
    'public.grants_works_upsert(uuid,text,jsonb)',
    'public.grants_topics_set(uuid,text,jsonb)',
    'public.grants_researcher_sync_error(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
    if has_srv then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $grants$;

-- A táblákra a kliens SEMMILYEN jogot nem kap.
do $$
declare t text;
begin
  for t in select format('grants.%I', tablename) from pg_tables where schemaname = 'grants' loop
    execute format('revoke all on table %s from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %s from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %s from authenticated', t);
    end if;
  end loop;
end $$;

do $chk$
begin
  if has_function_privilege('anon', 'public.grants_researchers(text,text,text,text,text,integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a kutatoi listat.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_works_upsert(uuid,text,jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is tolthet be publikaciot.';
  end if;
  raise notice 'Rendben: 79 — kutatoi profil (researcher, work, topic, skill, identity_candidate).';
end $chk$;


-- ############################################################################
-- ### 80_grants_discovery.sql
-- ############################################################################

-- ============================================================
-- 80_grants_discovery.sql — kik vannak hozzánk affiliálva?
-- ============================================================
-- MIT AD: a felderítés adatbázis-oldalát. Az OpenAlex és az MTMT megkérdezése
-- után a talált szerzők NEM a kutatói törzsbe kerülnek, hanem egy külön
-- „felderített szerző" táblába, ahonnan döntés után lépnek be.
--
-- MIÉRT NEM EGYENESEN A TÖRZSBE: a két forrás az NJE-hez affiliált szerzőket
-- adja, ami nem ugyanaz, mint „a mi mai kutatónk". Van köztük, aki évekkel
-- ezelőtt volt itt, van, aki egyetlen társszerzős cikk miatt szerepel, és van
-- névazonosságból eredő hibás találat is. Ha ezek mind a törzsbe kerülnének,
-- a lista használhatatlanná válna, a javaslatok pedig olyan embereknek
-- szólnának, akik nincsenek is itt.
--
-- MÉRVE (2026-09-24, valódi lekérdezéssel):
--   • OpenAlex: 727 szerző NJE-affiliációval, ebből 421-nél ez a LEGUTOLSÓ
--     affiliáció, 382-nek van ORCID-je, 354-nek legalább 10 műve.
--   • MTMT: az NJE csomópont (mtid 20201) alatt 11 alegység; a szerzőket
--     egységenként kell kérdezni, mert az intézményi lekérdezés csak a
--     közvetlenül a felső csomóponthoz rendelteket adja. Így 306 egyedi
--     szerző jön ki (113 ORCID-del): NJE 48, GSZDI 90, GAMFK 58, PK 56,
--     GK 38, KVK 34, GTK 15, MI Tudásközpont 1.
--   • A két halmaz átfedése ORCID-en 70, névegyezésen 142 — vagyis a
--     forrásokat együtt kell kezelni, és 164 név CSAK az MTMT-ben van meg
--     (jellemzően magyar nyelvű termés).
--
-- A PÁROSÍTÁS JAVASLAT, NEM DÖNTÉS: ORCID-egyezésre és névegyezésre javaslunk
-- meglévő kutatót, de az összekötés kézi jóváhagyás.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Névnormalizálás a javaslatokhoz
-- ------------------------------------------------------------
-- Ékezetek összevonása és a tudományos címek elhagyása. NEM tökéletes
-- azonosítás — csak arra jó, hogy két alak összetartozását FELVETHESSE.
create or replace function grants.nev_norm(p text)
returns text
language sql immutable
as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(p, '')),
                       'áéíóöőúüűÁÉÍÓÖŐÚÜŰ', 'aeiooouuuaeiooouuu'),
             '\m(dr|prof|phd|dsc|csc|habil|med|univ)\.?\M', '', 'g'),
           '\s+', ' ', 'g')), '')
$$;


-- Van-e a két névben közös, legalább 3 betűs tag? A magyar és a nyugati
-- névsorrend miatt a sorrendet nem nézzük, csak a halmazt.
--
-- MIÉRT KELL: 2026-09-24-én mérve az MTMT és az OpenAlex a
-- 0009-0001-0257-4812 ORCID-en KÉT MÁS nevet mutat („Varga Erika", illetve
-- „Eugen Varga"). Vagyis egy ORCID-egyezés is lehet hibás adatbevitel
-- eredménye — ezért az ORCID-re épülő automatikus kötés is csak akkor
-- érvényes, ha a nevek is átfedik egymást.
create or replace function grants.nev_atfedes(a text, b text)
returns boolean
language sql immutable
as $$
  select exists (
    select 1
      from unnest(string_to_array(grants.nev_norm(a), ' ')) x
      join unnest(string_to_array(grants.nev_norm(b), ' ')) y on x = y
     where length(x) >= 3)
$$;


-- ------------------------------------------------------------
-- 2. Felderített szerzők
-- ------------------------------------------------------------
create table if not exists grants.discovered_author (
  id            uuid primary key default gen_random_uuid(),
  forras        text not null
                  constraint grants_disc_forras_ck check (forras in ('openalex','mtmt')),
  kulso_id      text not null,
  nev           text,
  nev_valtozatok text[],
  orcid         text,
  intezmeny     text,
  szervezeti_egyseg text,                       -- MTMT: melyik alegység alatt találtuk
  mu_db         integer,
  idezet        integer,
  h_index       integer,
  utolso_affiliacio boolean,                    -- OpenAlex: az NJE a LEGUTOLSÓ affiliációja
  temak         jsonb not null default '[]'::jsonb,
  payload       jsonb not null default '{}'::jsonb,
  allapot       text not null default 'uj'
                  constraint grants_disc_allapot_ck check (allapot in ('uj','osszekotve','kihagyva')),
  researcher_id uuid references grants.researcher(id) on delete set null,
  javasolt_researcher_id uuid references grants.researcher(id) on delete set null,
  javaslat_ok   text,                           -- 'orcid' | 'nev' | null
  kihagyas_oka  text,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  dontes_at     timestamptz,
  dontes_by     uuid,
  constraint grants_disc_kulcs_uq unique (forras, kulso_id)
);
create index if not exists grants_disc_allapot_idx on grants.discovered_author (forras, allapot, mu_db desc);
create index if not exists grants_disc_nev_idx     on grants.discovered_author (grants.nev_norm(nev));

comment on table grants.discovered_author is
  'Az OpenAlex/MTMT szerint az NJE-hez affiliált szerzők. NEM a kutatói törzs: ide a forrás állítása kerül, a törzsbe csak kézi döntés után lép be egy személy.';


-- ------------------------------------------------------------
-- 3. Betöltés (service_role — a felderítő Edge Function)
-- ------------------------------------------------------------
create or replace function public.grants_discovered_upsert(p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_it    jsonb;
  v_uj    integer := 0;
  v_mod   integer := 0;
  v_kot   integer := 0;
  v_id    uuid;
  v_orcid text;
  v_res   uuid;
  v_javas uuid;
  v_ok    text;
  v_letez boolean;
begin
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if nullif(btrim(coalesce(v_it->>'kulso_id','')), '') is null then continue; end if;
    v_orcid := grants.orcid_norm(v_it->>'orcid');
    v_res := null; v_javas := null; v_ok := null;

    -- Már összekötött kutató? Ekkor a felderítés csak megerősíti, amit tudunk.
    if p_forras = 'openalex' then
      select id into v_res from grants.researcher where openalex_id = v_it->>'kulso_id';
    else
      select id into v_res from grants.researcher where mtmt_id = v_it->>'kulso_id';
    end if;

    -- Javaslat: először ORCID (személyhez kötött), utána EGYEDI névegyezés.
    if v_res is null and v_orcid is not null then
      select id into v_javas from grants.researcher where lower(orcid) = lower(v_orcid);
      if v_javas is not null then
        -- ORCID egyezik: általában ez a legerősebb jel. DE ha a nevek egyáltalán
        -- nem fedik egymást, az adathiba (mérve: van ilyen), ezért jelöljük, és
        -- a kötegelt felvétel kihagyja.
        if grants.nev_atfedes(v_it->>'nev', (select nev from grants.researcher where id = v_javas)) then
          v_ok := 'orcid';
        else
          v_ok := 'orcid_nevkonflikt';
        end if;
      end if;
    end if;
    if v_res is null and v_javas is null and v_it->>'nev' is not null then
      select r.id into v_javas
        from grants.researcher r
       where grants.nev_norm(r.nev) = grants.nev_norm(v_it->>'nev')
       limit 2;
      -- Csak akkor javaslunk nevet, ha PONTOSAN EGY találat van: két azonos
      -- nevű kutatónál a gép nem tud dönteni, és nem is szabad.
      if v_javas is not null
         and (select count(*) from grants.researcher r2
               where grants.nev_norm(r2.nev) = grants.nev_norm(v_it->>'nev')) = 1 then
        v_ok := 'nev';
      else
        v_javas := null;
      end if;
    end if;

    select exists (select 1 from grants.discovered_author
                    where forras = p_forras and kulso_id = v_it->>'kulso_id') into v_letez;

    insert into grants.discovered_author (
      forras, kulso_id, nev, nev_valtozatok, orcid, intezmeny, szervezeti_egyseg,
      mu_db, idezet, h_index, utolso_affiliacio, temak, payload,
      allapot, researcher_id, javasolt_researcher_id, javaslat_ok)
    values (
      p_forras, v_it->>'kulso_id', nullif(v_it->>'nev',''),
      case when v_it ? 'nev_valtozatok'
           then (select array_agg(x) from jsonb_array_elements_text(v_it->'nev_valtozatok') x)
           else null end,
      v_orcid, nullif(v_it->>'intezmeny',''), nullif(v_it->>'szervezeti_egyseg',''),
      nullif(v_it->>'mu_db','')::integer, nullif(v_it->>'idezet','')::integer,
      nullif(v_it->>'h_index','')::integer, (v_it->>'utolso_affiliacio')::boolean,
      coalesce(v_it->'temak', '[]'::jsonb), coalesce(v_it->'payload', '{}'::jsonb),
      case when v_res is not null then 'osszekotve' else 'uj' end, v_res, v_javas, v_ok)
    on conflict (forras, kulso_id) do update
       set nev = coalesce(excluded.nev, grants.discovered_author.nev),
           nev_valtozatok = coalesce(excluded.nev_valtozatok, grants.discovered_author.nev_valtozatok),
           orcid = coalesce(excluded.orcid, grants.discovered_author.orcid),
           intezmeny = coalesce(excluded.intezmeny, grants.discovered_author.intezmeny),
           szervezeti_egyseg = coalesce(excluded.szervezeti_egyseg, grants.discovered_author.szervezeti_egyseg),
           mu_db = excluded.mu_db, idezet = excluded.idezet, h_index = excluded.h_index,
           utolso_affiliacio = excluded.utolso_affiliacio,
           temak = excluded.temak, payload = excluded.payload,
           -- A KIHAGYOTT és az ÖSSZEKÖTÖTT döntést a betöltés nem írja vissza:
           -- ami egyszer eldőlt, azt csak ember változtathatja meg.
           researcher_id = coalesce(grants.discovered_author.researcher_id, excluded.researcher_id),
           javasolt_researcher_id = case when grants.discovered_author.allapot = 'uj'
                                         then excluded.javasolt_researcher_id
                                         else grants.discovered_author.javasolt_researcher_id end,
           javaslat_ok = case when grants.discovered_author.allapot = 'uj'
                              then excluded.javaslat_ok else grants.discovered_author.javaslat_ok end,
           allapot = case when grants.discovered_author.allapot = 'uj' and excluded.researcher_id is not null
                          then 'osszekotve' else grants.discovered_author.allapot end,
           last_seen = now()
    returning id into v_id;

    if v_letez then v_mod := v_mod + 1; else v_uj := v_uj + 1; end if;
    if v_res is not null then v_kot := v_kot + 1; end if;
  end loop;

  return jsonb_build_object('uj', v_uj, 'frissitve', v_mod, 'mar_osszekotve', v_kot);
end $$;


-- ------------------------------------------------------------
-- 4. Olvasás (iroda)
-- ------------------------------------------------------------
create or replace function public.grants_discovered(
  p_forras  text    default null,
  p_q       text    default null,
  p_allapot text    default 'uj',
  p_min_mu  integer default null,
  p_limit   integer default 100,
  p_offset  integer default 0
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_q   text    := nullif(btrim(coalesce(p_q, '')), '');
  v_ossz integer;
  v_sorok jsonb;
begin
  perform grants.require_office();

  select count(*) into v_ossz
    from grants.discovered_author d
   where (p_forras  is null or d.forras = p_forras)
     and (p_allapot is null or d.allapot = p_allapot)
     and (p_min_mu  is null or coalesce(d.mu_db, 0) >= p_min_mu)
     and (v_q is null or d.nev ilike '%' || v_q || '%' or coalesce(d.orcid,'') ilike '%' || v_q || '%');

  select coalesce(jsonb_agg(x order by rend, nev), '[]'::jsonb) into v_sorok
  from (
    select jsonb_build_object(
             'id', d.id, 'forras', d.forras, 'kulso_id', d.kulso_id,
             'nev', d.nev, 'nev_valtozatok', to_jsonb(coalesce(d.nev_valtozatok, '{}')),
             'orcid', d.orcid, 'intezmeny', d.intezmeny,
             'szervezeti_egyseg', d.szervezeti_egyseg,
             'mu_db', d.mu_db, 'idezet', d.idezet, 'h_index', d.h_index,
             'utolso_affiliacio', d.utolso_affiliacio,
             'temak', d.temak, 'allapot', d.allapot,
             'javaslat_ok', d.javaslat_ok,
             'javasolt_nev', (select r.nev from grants.researcher r where r.id = d.javasolt_researcher_id),
             'javasolt_id', d.javasolt_researcher_id,
             'kutato_nev', (select r.nev from grants.researcher r where r.id = d.researcher_id),
             'kutato_id', d.researcher_id,
             'kihagyas_oka', d.kihagyas_oka,
             'first_seen', d.first_seen, 'last_seen', d.last_seen
           ) as x,
           -- Előre azok, akiknél van javaslat: ott a döntés egy kattintás.
           case when d.javasolt_researcher_id is not null then 0 else 1 end as rend,
           coalesce(d.nev, '') as nev
      from grants.discovered_author d
     where (p_forras  is null or d.forras = p_forras)
       and (p_allapot is null or d.allapot = p_allapot)
       and (p_min_mu  is null or coalesce(d.mu_db, 0) >= p_min_mu)
       and (v_q is null or d.nev ilike '%' || v_q || '%' or coalesce(d.orcid,'') ilike '%' || v_q || '%')
     order by rend, coalesce(d.mu_db, 0) desc, d.nev
     limit v_lim offset v_off
  ) t;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_sorok),
                            'hatar', v_lim, 'eltolas', v_off, 'sorok', v_sorok);
end $$;

create or replace function public.grants_discovery_stats()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_out jsonb;
begin
  perform grants.require_office();
  select jsonb_build_object(
    'forrasonkent', (select coalesce(jsonb_object_agg(f, x), '{}'::jsonb)
       from (select forras f, jsonb_build_object(
                      'osszes', count(*),
                      'uj', count(*) filter (where allapot = 'uj'),
                      'osszekotve', count(*) filter (where allapot = 'osszekotve'),
                      'kihagyva', count(*) filter (where allapot = 'kihagyva'),
                      'javaslattal', count(*) filter (where allapot = 'uj' and javasolt_researcher_id is not null),
                      'orcid', count(*) filter (where orcid is not null),
                      'tiz_mu_felett', count(*) filter (where coalesce(mu_db,0) >= 10)) x
               from grants.discovered_author group by forras) t),
    'kutato_db', (select count(*) from grants.researcher),
    'osszekotott_kutato', (select count(*) from grants.researcher
                            where openalex_id is not null or mtmt_id is not null)
  ) into v_out;
  return v_out;
end $$;


-- ------------------------------------------------------------
-- 5. Döntések (iroda)
-- ------------------------------------------------------------
-- Összekötés meglévő kutatóval. Ha p_researcher null, a JAVASOLT kutatóval.
create or replace function public.grants_discovered_link(p_id uuid, p_researcher uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare d grants.discovered_author%rowtype; v_res uuid;
begin
  perform grants.require_office();
  select * into d from grants.discovered_author where id = p_id for update;
  if not found then raise exception 'GRANTS_DISCOVERED_NOT_FOUND'; end if;
  v_res := coalesce(p_researcher, d.javasolt_researcher_id);
  if v_res is null then
    raise exception 'GRANTS_BAD_INPUT: nincs megadva és nincs javasolt kutató sem.';
  end if;
  if not exists (select 1 from grants.researcher where id = v_res) then
    raise exception 'GRANTS_RESEARCHER_NOT_FOUND';
  end if;

  if d.forras = 'openalex' then
    update grants.researcher
       set openalex_id = d.kulso_id,
           orcid = coalesce(orcid, d.orcid),
           utolso_szinkron = null, updated_at = now()
     where id = v_res;
  else
    update grants.researcher
       set mtmt_id = d.kulso_id,
           orcid = coalesce(orcid, d.orcid),
           utolso_szinkron = null, updated_at = now()
     where id = v_res;
  end if;

  update grants.discovered_author
     set allapot = 'osszekotve', researcher_id = v_res,
         dontes_at = now(), dontes_by = auth.uid()
   where id = p_id;

  return jsonb_build_object('ok', true, 'kutato_id', v_res,
                            'kutato_nev', (select nev from grants.researcher where id = v_res));
end $$;

-- ÚJ kutató a felderített szerzőből. A típus alapértelmezésben 'kutato',
-- mert a forrás publikációs affiliációt állít, nem munkaviszonyt.
create or replace function public.grants_discovered_create(p_id uuid, p_tipus text default 'kutato')
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare d grants.discovered_author%rowtype; v_res uuid;
begin
  perform grants.require_office();
  select * into d from grants.discovered_author where id = p_id for update;
  if not found then raise exception 'GRANTS_DISCOVERED_NOT_FOUND'; end if;
  if d.allapot = 'osszekotve' then
    raise exception 'GRANTS_ALREADY_LINKED: ez a szerző már egy kutatóhoz tartozik.';
  end if;
  if nullif(btrim(coalesce(d.nev,'')), '') is null then
    raise exception 'GRANTS_BAD_INPUT: a felderített szerzőnek nincs neve, így nem vehető fel.';
  end if;

  insert into grants.researcher (nev, tipus, orcid,
                                 openalex_id, mtmt_id, intezet, gepi_epites)
  values (d.nev, coalesce(nullif(p_tipus,''), 'kutato'), d.orcid,
          case when d.forras = 'openalex' then d.kulso_id end,
          case when d.forras = 'mtmt'     then d.kulso_id end,
          d.szervezeti_egyseg, true)
  returning id into v_res;

  update grants.discovered_author
     set allapot = 'osszekotve', researcher_id = v_res,
         dontes_at = now(), dontes_by = auth.uid()
   where id = p_id;

  -- A MÁSIK forrásban ugyanez a személy ORCID alapján felismerhető: ott is
  -- felajánljuk, hogy ehhez a (most létrejött) kutatóhoz tartozik.
  if d.orcid is not null then
    update grants.discovered_author
       set javasolt_researcher_id = v_res, javaslat_ok = 'orcid'
     where allapot = 'uj' and lower(orcid) = lower(d.orcid) and id <> p_id;
  end if;

  return jsonb_build_object('ok', true, 'kutato_id', v_res, 'kutato_nev', d.nev);
end $$;

create or replace function public.grants_discovered_ignore(p_id uuid, p_ok text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  perform grants.require_office();
  update grants.discovered_author
     set allapot = 'kihagyva', kihagyas_oka = nullif(btrim(coalesce(p_ok,'')), ''),
         dontes_at = now(), dontes_by = auth.uid()
   where id = p_id;
  if not found then raise exception 'GRANTS_DISCOVERED_NOT_FOUND'; end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- Kötegelt felvétel: a forrás szerinti aktív, legalább N művel rendelkező, még
-- nem eldöntött szerzőkből kutatói rekord. AKINÉL VAN JAVASLAT, azt kihagyja —
-- ott előbb az emberi döntés kell, különben kettőzést csinálnánk.
create or replace function public.grants_discovered_bulk_create(
  p_forras text,
  p_min_mu integer default 5,
  p_csak_utolso_affiliacio boolean default true,
  p_limit  integer default 200
) returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare r record; v_db integer := 0; v_res uuid;
begin
  perform grants.require_office();
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;

  for r in select * from grants.discovered_author d
            where d.forras = p_forras
              and d.allapot = 'uj'
              and d.javasolt_researcher_id is null
              and coalesce(d.mu_db, 0) >= greatest(coalesce(p_min_mu, 0), 0)
              and (not coalesce(p_csak_utolso_affiliacio, true)
                   or d.utolso_affiliacio is not false)
              and nullif(btrim(coalesce(d.nev,'')), '') is not null
            order by coalesce(d.mu_db, 0) desc
            limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  loop
    begin
      insert into grants.researcher (nev, tipus, orcid, openalex_id, mtmt_id, intezet, gepi_epites)
      values (r.nev, 'kutato', r.orcid,
              case when r.forras = 'openalex' then r.kulso_id end,
              case when r.forras = 'mtmt'     then r.kulso_id end,
              r.szervezeti_egyseg, true)
      returning id into v_res;
    exception when unique_violation then
      -- Ugyanaz az ORCID már bent van: akkor összekötés, nem új rekord.
      select id into v_res from grants.researcher where lower(orcid) = lower(r.orcid);
      if v_res is null then continue; end if;
      if r.forras = 'openalex' then
        update grants.researcher set openalex_id = coalesce(openalex_id, r.kulso_id) where id = v_res;
      else
        update grants.researcher set mtmt_id = coalesce(mtmt_id, r.kulso_id) where id = v_res;
      end if;
    end;
    update grants.discovered_author
       set allapot = 'osszekotve', researcher_id = v_res, dontes_at = now(), dontes_by = auth.uid()
     where id = r.id;
    v_db := v_db + 1;
  end loop;

  return jsonb_build_object('felvett', v_db,
                            'kutato_db', (select count(*) from grants.researcher));
end $$;


-- ------------------------------------------------------------
-- 6. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  execute 'revoke all on function grants.nev_norm(text) from public';
  if has_anon then execute 'revoke all on function grants.nev_norm(text) from anon'; end if;
  if has_auth then execute 'revoke all on function grants.nev_norm(text) from authenticated'; end if;

  foreach f in array array[
    'public.grants_discovered(text,text,text,integer,integer,integer)',
    'public.grants_discovery_stats()',
    'public.grants_discovered_link(uuid,uuid)',
    'public.grants_discovered_create(uuid,text)',
    'public.grants_discovered_ignore(uuid,text)',
    'public.grants_discovered_bulk_create(text,integer,boolean,integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- A betöltő CSAK a service_role-nak.
  execute 'revoke all on function public.grants_discovered_upsert(text,jsonb) from public';
  if has_anon then execute 'revoke all on function public.grants_discovered_upsert(text,jsonb) from anon'; end if;
  if has_auth then execute 'revoke all on function public.grants_discovered_upsert(text,jsonb) from authenticated'; end if;
  if has_srv  then execute 'grant execute on function public.grants_discovered_upsert(text,jsonb) to service_role'; end if;
end $grants$;

do $$
declare t text;
begin
  for t in select format('grants.%I', tablename) from pg_tables where schemaname = 'grants' loop
    execute format('revoke all on table %s from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %s from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %s from authenticated', t);
    end if;
  end loop;
end $$;

-- Az MTMT-forrás gépi gyűjtését az egyetem döntése nyitja meg: a saját
-- intézményi körünkre kérdezünk (mtid 20201 és alegységei), mérsékelt ütemmel.
update grants.source
   set gepi_gyujtes = true,
       jogi_megjegyzes = 'Saját intézményi kör (mtid 20201 és alegységei), mérsékelt ütemmel. '
                       || 'Az adatra nincs nyílt licenc, ezért a rendszeres gyűjtés kereteit az '
                       || 'MTA KIK-kel írásban egyeztetni kell — a jelenlegi felderítés az egyetem '
                       || 'saját adatszolgáltatói körére szorítkozik.'
 where kod = 'mtmt';

insert into grants.source (kod, nev, tipus, url, leiras, gepi_gyujtes, jogi_megjegyzes) values
  ('openalex', 'OpenAlex (kutatói profilok)', 'api', 'https://api.openalex.org',
   'Publikációs metaadat CC0 licenc alatt. 2026-09-23-án mérve: az NJE-hez 771 szerző '
   'van affiliálva, ebből 389-nek van ORCID-je. 2026 februárja óta API-kulcs kell a '
   'produktív használathoz; az ingyenes szint a mi méretünkben elég.',
   true, 'CC0 licenc, helyben tárolható.')
on conflict (kod) do nothing;

-- A 79-es migráció automatikus ORCID-kötését is szigorítjuk ugyanezzel az
-- ellenőrzéssel: a név egyezése nélkül nem kötünk, csak javaslatot rögzítünk.
create or replace function public.grants_candidates_upsert(
  p_researcher uuid, p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_it jsonb; v_uj integer := 0; v_auto integer := 0; v_konflikt integer := 0; v_nev text;
begin
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;
  select nev into v_nev from grants.researcher where id = p_researcher;
  if v_nev is null then raise exception 'GRANTS_RESEARCHER_NOT_FOUND'; end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into grants.identity_candidate (researcher_id, forras, kulso_id, nev, intezmeny,
                                            orcid, mu_db, idezet, pontszam, indok, allapot)
    values (p_researcher, p_forras, v_it->>'kulso_id', nullif(v_it->>'nev',''),
            nullif(v_it->>'intezmeny',''), grants.orcid_norm(v_it->>'orcid'),
            nullif(v_it->>'mu_db','')::integer, nullif(v_it->>'idezet','')::integer,
            nullif(v_it->>'pontszam','')::numeric, coalesce(v_it->'indok', '{}'::jsonb),
            case when coalesce(v_it->>'orcid_egyezik','') = 'true'
                      and grants.nev_atfedes(v_it->>'nev', v_nev)
                 then 'megerositve' else 'javasolt' end)
    on conflict (researcher_id, forras, kulso_id) do update
       set nev = excluded.nev, intezmeny = excluded.intezmeny, orcid = excluded.orcid,
           mu_db = excluded.mu_db, idezet = excluded.idezet,
           pontszam = excluded.pontszam, indok = excluded.indok;
    v_uj := v_uj + 1;

    if coalesce(v_it->>'orcid_egyezik','') = 'true' then
      if grants.nev_atfedes(v_it->>'nev', v_nev) then
        v_auto := v_auto + 1;
        if p_forras = 'openalex' then
          update grants.researcher set openalex_id = v_it->>'kulso_id',
                 orcid = coalesce(orcid, grants.orcid_norm(v_it->>'orcid')), updated_at = now()
           where id = p_researcher and openalex_id is null;
        else
          update grants.researcher set mtmt_id = v_it->>'kulso_id', updated_at = now()
           where id = p_researcher and mtmt_id is null;
        end if;
      else
        -- ORCID egyezik, a név nem: ez adathiba valahol. Nem kötünk, jelezzük.
        v_konflikt := v_konflikt + 1;
        update grants.identity_candidate
           set indok = indok || jsonb_build_object('figyelmeztetes',
                 'Az ORCID egyezik, de a nevek nem fedik egymást — ellenőrizni kell.')
         where researcher_id = p_researcher and forras = p_forras and kulso_id = v_it->>'kulso_id';
      end if;
    end if;
  end loop;
  return jsonb_build_object('rogzitve', v_uj, 'orcid_alapjan_kotve', v_auto,
                            'orcid_nevkonfliktus', v_konflikt);
end $$;

do $grants2$
declare has_anon boolean := exists (select 1 from pg_roles where rolname='anon');
        has_auth boolean := exists (select 1 from pg_roles where rolname='authenticated');
        has_srv  boolean := exists (select 1 from pg_roles where rolname='service_role');
begin
  execute 'revoke all on function public.grants_candidates_upsert(uuid,text,jsonb) from public';
  if has_anon then execute 'revoke all on function public.grants_candidates_upsert(uuid,text,jsonb) from anon'; end if;
  if has_auth then execute 'revoke all on function public.grants_candidates_upsert(uuid,text,jsonb) from authenticated'; end if;
  if has_srv  then execute 'grant execute on function public.grants_candidates_upsert(uuid,text,jsonb) to service_role'; end if;
  execute 'revoke all on function grants.nev_atfedes(text,text) from public';
  if has_anon then execute 'revoke all on function grants.nev_atfedes(text,text) from anon'; end if;
  if has_auth then execute 'revoke all on function grants.nev_atfedes(text,text) from authenticated'; end if;
end $grants2$;

do $chk$
begin
  if has_function_privilege('anon', 'public.grants_discovered(text,text,text,integer,integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a felderitesi listat.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_discovered_upsert(text,jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is tolthet be felderitett szerzot.';
  end if;
  raise notice 'Rendben: 80 — felderites (discovered_author), forrasok: openalex, mtmt.';
end $chk$;


-- ############################################################################
-- ### 21_echo_harden_submit.sql
-- ############################################################################

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
