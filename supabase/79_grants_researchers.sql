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
