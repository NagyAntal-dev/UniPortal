-- ============================================================
-- 77_grants_core.sql — Pályázati modul, 1. fázis: felhívás-katalógus
-- ============================================================
-- MIT AD:
--   • grants séma (a kliens NEM éri el közvetlenül), minden hozzáférés
--     public.grants_* security definer RPC-n, jogosultság-ellenőrzéssel
--   • forrásregiszter (grants.source): melyik csatorna, milyen úton jön,
--     mikor adott utolsó adatot — enélkül egy forrás kiesése láthatatlan
--   • felhívások (grants.call) több határidővel (grants.call_deadline),
--     változásnaplóval (grants.call_change) és a nyers válasz megőrzésével
--   • ETL-napló (grants.etl_run): forrásonkénti futás, hibával együtt
--   • beállítások (grants.setting): modellszolgáltató, napi plafon, ütem
--
-- AMIT SZÁNDÉKOSAN NEM AD: kutatói profilt, illesztést, modellhívást. Azok a
-- 78-as és 79-es migrációban jönnek. Ez a fájl önmagában is használható:
-- a pályázati iroda kézzel is rögzíthet felhívást, és a katalógus működik.
--
-- JOGOSULTSÁG (a 2026-09-23-i döntés szerint): a modult egyelőre CSAK az
-- admin és a pályázati iroda kezeli. A 'grants_office' kulcs a szerepkör-,
-- csoport- és egyéni szinten egyaránt kiosztható (38/39/73 migrációk).
-- A kutatói nézet ('grants') kulcsát is felvesszük, de még semmi nem használja.
--
-- ÜTEMEZÉS: a replikán nincs pg_cron (mérve, lásd 26_dorm.sql), ezért minden
-- gyűjtés IDEMPOTENS RPC, amit Edge Function, felületi gomb és külső cron
-- egyaránt hívhat, és a többszöri lefutás sem okoz kárt.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create schema if not exists grants;

-- A séma NEM exposed: a PostgREST csak a public sémát látja, de a biztonság
-- nem múlhat konfiguráción — a jogokat itt is elvesszük.
revoke all on schema grants from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema grants from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema grants from authenticated';
  end if;
end $$;

comment on schema grants is
  'Pályázati modul. A kliens nem éri el; minden hozzáférés public.grants_* RPC-n megy.';


-- ------------------------------------------------------------
-- 1. Beállítások
-- ------------------------------------------------------------
-- Küszöbök és kapcsolók ADATKÉNT, nem kódba égetve — ugyanaz az elv, mint az
-- echo.setting-nél. A modellszolgáltató is itt van: a Gemini→Claude váltás
-- így egy UPDATE, nem kódmódosítás.
create table if not exists grants.setting (
  key         text primary key,
  value       text not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

insert into grants.setting (key, value, description) values
  ('ai_provider', 'gemini',
   'Melyik modellszolgáltató adja az indoklásokat: gemini | anthropic | nincs. '
   'A kulcs mindig Supabase secretben van (GEMINI_API_KEY / ANTHROPIC_API_KEY), '
   'sosem itt. A "nincs" érték kikapcsolja a modellhívást: a rendszer ilyenkor '
   'a számított pontszámmal működik tovább.'),
  ('ai_model', '',
   'A használt modell neve. Üresen a grants-ai Edge Function beépített '
   'alapértelmezését használja. Azért adat, mert a modellnevek gyorsabban '
   'változnak, mint ahogy migrációt írunk.'),
  ('ai_daily_cap_usd', '2',
   'Napi költségplafon dollárban a modellhívásokra. Elérése után a modul nem '
   'hív modellt aznap, de MŰKÖDIK: a javaslatok a számított pontszámmal jönnek.'),
  ('fetch_user_agent', 'UniPortal-NJE-grants/1.0 (+https://nje.hu; kecskemet.adatkozpont@gmail.com)',
   'Minden kimenő gyűjtő kérés ezzel azonosítja magát. Illendőség és '
   'üzemeltethetőség: a forrás oldaláról látszik, ki kérdez és hol lehet szólni.'),
  ('eu_reference_url', 'https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/grantsTenders.json',
   'Az EU Funding & Tenders portál referencia-állománya. Kulcs nélkül, sima '
   'GET. 2026-09-23-án tételszinten mérve: 11 162 rekord, ebből 10 163 pályázat '
   '(type=1) és 999 közbeszerzés (type=0). A pályázatok közül 208 nyitott és '
   '278 hamarosan nyíló; a modul ezeket és a 90 napon belül lezártakat tölti be.'),
  ('deadline_warn_days', '30,14,3',
   'Hány nappal a határidő előtt figyelmeztet a rendszer. Vesszővel elválasztva.')
on conflict (key) do nothing;


-- ------------------------------------------------------------
-- 2. Forrásregiszter
-- ------------------------------------------------------------
-- MIÉRT SAJÁT TÁBLA: ha egy forrás elnémul (átalakult a HTML, megszűnt a
-- végpont), annak LÁTSZANIA kell. A felületen ez a tábla adja az
-- "Adatforrások állapota" képernyőt, és ez mondja meg azt is, hogy egy
-- csatornáról egyáltalán szabad-e gépi úton gyűjteni.
create table if not exists grants.source (
  kod            text primary key
                   constraint grants_source_kod_ck check (kod ~ '^[a-z0-9_]{2,40}$'),
  nev            text not null,
  -- api: dokumentált vagy mért gépi végpont; html: szerkezet-értelmező;
  -- kezi: a pályázati iroda rögzíti; rss: hírcsatorna.
  tipus          text not null default 'kezi'
                   constraint grants_source_tipus_ck check (tipus in ('api','html','rss','kezi')),
  url            text,
  leiras         text,
  -- Gépi gyűjtés engedélyezve van-e ezen a forráson. A jogi és az illendőségi
  -- döntés ADAT: egy forrásnál (pl. MTMT) előbb engedély kell, és addig ez false.
  gepi_gyujtes   boolean not null default false,
  jogi_megjegyzes text,
  aktiv          boolean not null default true,
  utem_ora       integer not null default 24
                   constraint grants_source_utem_ck check (utem_ora between 1 and 720),
  utolso_futas   timestamptz,
  utolso_siker   timestamptz,
  utolso_hiba    text,
  created_at     timestamptz not null default now()
);

comment on column grants.source.gepi_gyujtes is
  'Szabad-e gépi úton gyűjteni erről a forrásról. Külön mező, mert a technikai lehetőség és a jogi tisztaság nem ugyanaz: az MTMT API nyitva van, de nyílt licenc nélkül — ott előbb megállapodás kell.';

insert into grants.source (kod, nev, tipus, url, leiras, gepi_gyujtes, jogi_megjegyzes) values
  ('eu_portal', 'EU Funding & Tenders portál', 'api',
   'https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/grantsTenders.json',
   'Az EU teljes felhívás-állománya egyetlen JSON-ban, kulcs nélkül: Horizon, '
   'Erasmus+, Digital Europe, LIFE, Creative Europe, EU4Health, CEF, CERV. '
   '2026-09-23-án tételszinten mérve: 10 163 pályázat, ebből 208 nyitott és 278 '
   'hamarosan nyíló (a 999 közbeszerzést a betöltő kiszűri).',
   true, 'Az Európai Bizottság nyilvános adatállománya, újrahasznosítása engedélyezett.'),
  ('nkfih', 'NKFIH felhívások', 'html', 'https://nkfih.gov.hu/palyazoknak/palyazatok',
   'OTKA/kutatási témapályázatok, Excellence, TÉT, partnerségi konstrukciók. '
   'Nincs API és nincs működő hírcsatorna (a rss.nkfih.gov.hu HTML-t ad), '
   'ezért HTML-értelmező. 2026-09-23-án 252 felhívás-hivatkozás volt a listán.',
   true, 'Nyilvános felhívások. Csak cím, határidő és kivonat jelenik meg, a teljes szöveg nem — mindig az eredetire hivatkozunk.'),
  ('palyazat_gov', 'Széchenyi Terv Plusz (palyazat.gov.hu)', 'html', 'https://www.palyazat.gov.hu/',
   'Next.js alkalmazás: a listázó végpontot még fel kell tárni egy böngészős '
   'munkamenettel. Addig kézi rögzítés.',
   false, 'A gépi végpont feltárása után eldöntendő, hogy a HTML-értelmező vagy a belső JSON a járható út.'),
  ('mta', 'MTA pályázatok és ösztöndíjak', 'html', 'https://mta.hu/palyazatok',
   'Bolyai, Lendület, ifjúsági díjak. 2026-09-23-án 28 hivatkozás a listán.',
   true, 'Nyilvános felhívások.'),
  ('tempus', 'Tempus Közalapítvány (Erasmus+, CEEPUS)', 'html', 'https://tka.hu/palyazatok',
   'A lista valószínűleg JavaScriptből épül: külön vizsgálat kell. Addig kézi rögzítés.',
   false, 'Feltárás alatt.'),
  ('kezi', 'Kézi rögzítés', 'kezi', null,
   'Amit a pályázati iroda e-mailben, hírlevélben vagy NCP-től kap. Nem '
   'másodosztályú út: ugyanaz a mezőkészlet, ugyanaz a katalógus.',
   false, null)
on conflict (kod) do nothing;


-- ------------------------------------------------------------
-- 3. Felhívások
-- ------------------------------------------------------------
create table if not exists grants.call (
  id                 uuid primary key default gen_random_uuid(),
  source_kod         text not null references grants.source(kod) on delete restrict,
  -- A forrás saját azonosítója (EU: identifier, pl. HORIZON-CL4-2026-TWIN-01-02).
  -- Kézi felvitelnél generált, hogy az egyediség itt is tartható legyen.
  kulso_azonosito    text not null,
  cim                text not null,
  cim_en             text,
  -- Program és alprogram a forrás szerint (EU: frameworkProgramme + division).
  program            text,
  alprogram          text,
  -- A felhívás (call) azonosítója, amibe a téma tartozik. Az EU-nál egy
  -- felhíváshoz több téma tartozik, és a hallgatói/kutatói oldalon a TÉMA az
  -- érdekes, de a beadás a felhívásra történik.
  felhivas_azonosito text,
  felhivas_cim       text,
  tipus              text,                                  -- RIA / IA / CSA / ösztöndíj / egyéb
  allapot            text not null default 'ismeretlen'
                       constraint grants_call_allapot_ck
                       check (allapot in ('nyitott','hamarosan','zart','ismeretlen')),
  nyitas             timestamptz,
  kovetkezo_hatarido timestamptz,                            -- a legközelebbi jövőbeli határidő
  utolso_hatarido    timestamptz,
  keret_eur          numeric(14,2),
  keret_huf          numeric(16,2),
  tamogatas_szazalek numeric(5,2),
  orszagkor          text,
  kedvezmenyezett    text,                                   -- kinek szól (egyetem, KKV, konzorcium…)
  kivonat            text,                                   -- RÖVID kivonat, nem a teljes szöveg
  url                text,
  partnerkereses     boolean not null default false,         -- EU: allowPartnerSearch
  -- A nyers válasz megőrzése: enélkül egy későbbi javítás újraszámolása
  -- újbóli letöltést igényelne, és egy forrásátalakulás után nem lehetne
  -- visszamenőleg érteni, mit kaptunk.
  payload            jsonb not null default '{}'::jsonb,
  -- A tartalmi ujjlenyomat: ebből dől el, változott-e a felhívás.
  hash               text not null,
  first_seen         timestamptz not null default now(),
  last_seen          timestamptz not null default now(),
  archivalt          boolean not null default false,
  created_by         uuid,
  constraint grants_call_kulcs_uq unique (source_kod, kulso_azonosito)
);

create index if not exists grants_call_allapot_idx  on grants.call (allapot, kovetkezo_hatarido);
create index if not exists grants_call_hatarido_idx on grants.call (kovetkezo_hatarido) where archivalt = false;
create index if not exists grants_call_program_idx  on grants.call (program);
create index if not exists grants_call_kereso_idx   on grants.call
  using gin (to_tsvector('simple', coalesce(cim,'') || ' ' || coalesce(cim_en,'') || ' ' || coalesce(kivonat,'')));

comment on column grants.call.kivonat is
  'RÖVID kivonat. A felhívás teljes szövege szándékosan nem kerül be: azt nem közöljük újra, hanem az eredeti oldalra hivatkozunk.';

-- Egy felhíváshoz több határidő tartozhat (kétszakaszos pályázat, fordulók).
-- Egyetlen deadline oszlop hazudna.
create table if not exists grants.call_deadline (
  call_id   uuid not null references grants.call(id) on delete cascade,
  sorszam   integer not null,
  hatarido  timestamptz not null,
  megjegyzes text,
  primary key (call_id, sorszam)
);
create index if not exists grants_call_deadline_idx on grants.call_deadline (hatarido);

-- A változásnapló adja a "módosult a határidő" értesítést. Enélkül a
-- rendszer csendben felülírná a régi dátumot, és senki nem tudná meg.
create table if not exists grants.call_change (
  id        bigserial primary key,
  call_id   uuid not null references grants.call(id) on delete cascade,
  mikor     timestamptz not null default now(),
  mi        text not null,                 -- hatarido | allapot | keret | cim | egyeb
  regi      text,
  uj        text
);
create index if not exists grants_call_change_idx on grants.call_change (call_id, mikor desc);


-- ------------------------------------------------------------
-- 4. ETL-napló
-- ------------------------------------------------------------
-- Forrásonként, futásonként egy sor. Egy forrás hibája nem állíthatja meg a
-- többit, és a felületen látszania kell, melyik csatorna mikor adott adatot.
create table if not exists grants.etl_run (
  id          bigserial primary key,
  source_kod  text not null references grants.source(kod) on delete cascade,
  indult      timestamptz not null default now(),
  vegzett     timestamptz,
  allapot     text not null default 'fut'
                constraint grants_etl_allapot_ck check (allapot in ('fut','ok','hiba')),
  uj_db       integer not null default 0,
  modosult_db integer not null default 0,
  valtozatlan_db integer not null default 0,
  hiba        text,
  reszletek   jsonb not null default '{}'::jsonb
);
create index if not exists grants_etl_run_idx on grants.etl_run (source_kod, indult desc);


-- ------------------------------------------------------------
-- 5. Jogosultsági segédfüggvények
-- ------------------------------------------------------------
-- A három szint (szerepkör / csoport / egyéni) union-ja egy helyen. A kliens
-- ugyanezt a hármat fűzi össze a menüszűrőhöz; itt a szerver dönt.
create or replace function grants.has_perm(p_key text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    public.is_superadmin() or public.is_admin()
    or exists (select 1
                 from public.profiles pr
                 join public.role_permission rp on rp.role_kod = pr.role
                where pr.id = auth.uid() and rp.permission = p_key)
    or p_key = any (public.my_group_permissions())
    or p_key = any (public.my_user_permissions()),
  false)
$$;

-- A modul kezelője: admin vagy a pályázati iroda munkatársa.
create or replace function grants.is_office()
returns boolean
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select grants.has_perm('grants_office')
$$;

create or replace function grants.require_office()
returns void
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'GRANTS_NOT_AUTHENTICATED'; end if;
  if not grants.is_office() then
    raise exception 'GRANTS_FORBIDDEN: ehhez a művelethez pályázati irodai (grants_office) jogosultság kell.';
  end if;
end $$;

-- A jogosultsági kulcsok felvétele. Az ADMIN mindent lát (39_role_admin.sql
-- mintája szerint kiírjuk, hogy szerkeszthető legyen); a 'grants' kutatói
-- kulcsot már most rögzítjük, de még semmi nem használja.
insert into public.role_permission (role_kod, permission)
select 'ADMIN', k from (values ('grants_office'), ('grants'), ('grants_reports')) t(k)
where exists (select 1 from public.role_definition where kod = 'ADMIN')
on conflict do nothing;


-- ------------------------------------------------------------
-- 6. Tartalmi ujjlenyomat és határidő-számítás
-- ------------------------------------------------------------
create or replace function grants.call_hash(p jsonb)
returns text
language sql immutable
as $$
  select md5(
    coalesce(p->>'cim','')            || '|' || coalesce(p->>'allapot','')   || '|' ||
    coalesce(p->>'nyitas','')         || '|' || coalesce(p->>'hataridok','') || '|' ||
    coalesce(p->>'keret_eur','')      || '|' || coalesce(p->>'keret_huf','') || '|' ||
    coalesce(p->>'program','')        || '|' || coalesce(p->>'url','')       || '|' ||
    coalesce(p->>'kivonat','')
  )
$$;

-- A határidőkből a legközelebbi JÖVŐBELI és a legutolsó. Külön függvény,
-- hogy a lista ne lateral join-nal számolja minden kérésnél.
create or replace function grants.refresh_deadlines(p_call uuid)
returns void
language plpgsql
set search_path = grants, public, pg_temp
as $$
begin
  update grants.call c
     set kovetkezo_hatarido = (select min(d.hatarido) from grants.call_deadline d
                                where d.call_id = c.id and d.hatarido >= now()),
         utolso_hatarido    = (select max(d.hatarido) from grants.call_deadline d
                                where d.call_id = c.id)
   where c.id = p_call;
end $$;


-- ------------------------------------------------------------
-- 7. Olvasó RPC-k
-- ------------------------------------------------------------
-- A felület ezzel indul: jogosultság, beállítások, forrásállapot, számok.
create or replace function public.grants_context()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then raise exception 'GRANTS_NOT_AUTHENTICATED'; end if;

  select jsonb_build_object(
    'kezelo',    grants.is_office(),
    'kutato',    grants.has_perm('grants'),
    'riport',    grants.has_perm('grants_reports'),
    'beallitas', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                    from grants.setting
                   where key in ('ai_provider','ai_model','ai_daily_cap_usd','deadline_warn_days')),
    'szamok', jsonb_build_object(
      'osszes',    (select count(*) from grants.call where archivalt = false),
      'nyitott',   (select count(*) from grants.call where archivalt = false and allapot = 'nyitott'),
      'hamarosan', (select count(*) from grants.call where archivalt = false and allapot = 'hamarosan'),
      'kozeli',    (select count(*) from grants.call
                     where archivalt = false and allapot = 'nyitott'
                       and kovetkezo_hatarido is not null
                       and kovetkezo_hatarido < now() + interval '30 days'),
      'program_db', (select count(distinct program) from grants.call where program is not null)),
    'forrasok', (select coalesce(jsonb_agg(jsonb_build_object(
                    'kod', s.kod, 'nev', s.nev, 'tipus', s.tipus, 'aktiv', s.aktiv,
                    'gepi_gyujtes', s.gepi_gyujtes, 'utem_ora', s.utem_ora,
                    'utolso_futas', s.utolso_futas, 'utolso_siker', s.utolso_siker,
                    'utolso_hiba', s.utolso_hiba,
                    'felhivas_db', (select count(*) from grants.call c
                                     where c.source_kod = s.kod and c.archivalt = false),
                    -- Elavult-e: az ütemnél régebben futott utolszor.
                    'elavult', (s.aktiv and s.gepi_gyujtes
                                and (s.utolso_siker is null
                                     or s.utolso_siker < now() - (s.utem_ora * interval '1 hour')))
                  ) order by s.nev), '[]'::jsonb) from grants.source s)
  ) into v_out;
  return v_out;
end $$;

-- Felhívás-lista szűrőkkel. A kereső egyszerű: cím és kivonat.
create or replace function public.grants_calls(
  p_q        text    default null,
  p_allapot  text    default null,
  p_program  text    default null,
  p_source   text    default null,
  p_napon_belul integer default null,
  p_limit    integer default 100,
  p_offset   integer default 0
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

  -- A szűrés EGY lekérdezésben, temp tábla nélkül: ez a függvény stable, és
  -- egy stable függvényben a DDL nemcsak illetlen, hanem meg is buktathatja
  -- a hívást read-only tranzakcióban.
  select count(*) into v_ossz
    from grants.call c
   where c.archivalt = false
     and (p_allapot is null or c.allapot = p_allapot)
     and (p_program is null or c.program = p_program)
     and (p_source  is null or c.source_kod = p_source)
     and (p_napon_belul is null
          or (c.kovetkezo_hatarido is not null
              and c.kovetkezo_hatarido < now() + (p_napon_belul * interval '1 day')))
     and (v_q is null
          or c.cim ilike '%' || v_q || '%'
          or coalesce(c.cim_en, '') ilike '%' || v_q || '%'
          or coalesce(c.kivonat, '') ilike '%' || v_q || '%'
          or c.kulso_azonosito ilike '%' || v_q || '%');

  select coalesce(jsonb_agg(x order by rendez, hat, cim), '[]'::jsonb) into v_sorok
  from (
    select jsonb_build_object(
             'id', c.id, 'azonosito', c.kulso_azonosito, 'cim', c.cim, 'cim_en', c.cim_en,
             'program', c.program, 'alprogram', c.alprogram, 'tipus', c.tipus,
             'felhivas_azonosito', c.felhivas_azonosito,
             'allapot', c.allapot, 'nyitas', c.nyitas,
             'hatarido', c.kovetkezo_hatarido, 'utolso_hatarido', c.utolso_hatarido,
             -- Nap-különbség DÁTUMBÓL: az interval nem konvertálható egészre.
             'hatralevo_nap', case when c.kovetkezo_hatarido is null then null
                                   else greatest(0, c.kovetkezo_hatarido::date - current_date) end,
             'keret_eur', c.keret_eur, 'keret_huf', c.keret_huf,
             'orszagkor', c.orszagkor, 'kedvezmenyezett', c.kedvezmenyezett,
             'kivonat', left(coalesce(c.kivonat, ''), 400),
             'url', c.url, 'partnerkereses', c.partnerkereses,
             'forras', c.source_kod, 'forras_nev', s.nev,
             'hataridok', (select coalesce(jsonb_agg(d.hatarido order by d.sorszam), '[]'::jsonb)
                             from grants.call_deadline d where d.call_id = c.id),
             'valtozott', (select max(ch.mikor) from grants.call_change ch where ch.call_id = c.id),
             'first_seen', c.first_seen, 'last_seen', c.last_seen
           ) as x,
           -- Nyitott elöl, azon belül a legközelebbi határidő.
           case c.allapot when 'nyitott' then 0 when 'hamarosan' then 1 else 2 end as rendez,
           coalesce(c.kovetkezo_hatarido, 'infinity'::timestamptz) as hat,
           c.cim as cim
      from grants.call c
      join grants.source s on s.kod = c.source_kod
     where c.archivalt = false
       and (p_allapot is null or c.allapot = p_allapot)
       and (p_program is null or c.program = p_program)
       and (p_source  is null or c.source_kod = p_source)
       and (p_napon_belul is null
            or (c.kovetkezo_hatarido is not null
                and c.kovetkezo_hatarido < now() + (p_napon_belul * interval '1 day')))
       and (v_q is null
            or c.cim ilike '%' || v_q || '%'
            or coalesce(c.cim_en, '') ilike '%' || v_q || '%'
            or coalesce(c.kivonat, '') ilike '%' || v_q || '%'
            or c.kulso_azonosito ilike '%' || v_q || '%')
     order by rendez, hat, c.cim
     limit v_lim offset v_off
  ) t;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_sorok),
                            'hatar', v_lim, 'eltolas', v_off, 'sorok', v_sorok);
end $$;

-- Egy felhívás minden adata, a változásnaplóval együtt.
create or replace function public.grants_call_get(p_call uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare c grants.call%rowtype; v_out jsonb;
begin
  perform grants.require_office();
  select * into c from grants.call where id = p_call;
  if not found then raise exception 'GRANTS_CALL_NOT_FOUND'; end if;

  select jsonb_build_object(
    'id', c.id, 'azonosito', c.kulso_azonosito, 'cim', c.cim, 'cim_en', c.cim_en,
    'program', c.program, 'alprogram', c.alprogram, 'tipus', c.tipus,
    'felhivas_azonosito', c.felhivas_azonosito, 'felhivas_cim', c.felhivas_cim,
    'allapot', c.allapot, 'nyitas', c.nyitas,
    'hatarido', c.kovetkezo_hatarido, 'utolso_hatarido', c.utolso_hatarido,
    'keret_eur', c.keret_eur, 'keret_huf', c.keret_huf,
    'tamogatas_szazalek', c.tamogatas_szazalek,
    'orszagkor', c.orszagkor, 'kedvezmenyezett', c.kedvezmenyezett,
    'kivonat', c.kivonat, 'url', c.url, 'partnerkereses', c.partnerkereses,
    'forras', c.source_kod,
    'forras_nev', (select nev from grants.source where kod = c.source_kod),
    'szerkesztheto', c.source_kod = 'kezi',
    'first_seen', c.first_seen, 'last_seen', c.last_seen,
    'hataridok', (select coalesce(jsonb_agg(jsonb_build_object(
                     'sorszam', d.sorszam, 'hatarido', d.hatarido, 'megjegyzes', d.megjegyzes)
                     order by d.sorszam), '[]'::jsonb)
                    from grants.call_deadline d where d.call_id = c.id),
    'valtozasok', (select coalesce(jsonb_agg(jsonb_build_object(
                      'mikor', ch.mikor, 'mi', ch.mi, 'regi', ch.regi, 'uj', ch.uj)
                      order by ch.mikor desc), '[]'::jsonb)
                     from grants.call_change ch where ch.call_id = c.id)
  ) into v_out;
  return v_out;
end $$;

-- Program- és állapot-szűrők értékkészlete a felülethez.
create or replace function public.grants_call_options()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_out jsonb;
begin
  perform grants.require_office();
  select jsonb_build_object(
    'program', (select coalesce(jsonb_agg(jsonb_build_object('ertek', p, 'db', n) order by n desc), '[]'::jsonb)
                  from (select program p, count(*) n from grants.call
                         where archivalt = false and program is not null
                         group by 1 order by 2 desc limit 40) t),
    'tipus',   (select coalesce(jsonb_agg(jsonb_build_object('ertek', p, 'db', n) order by n desc), '[]'::jsonb)
                  from (select tipus p, count(*) n from grants.call
                         where archivalt = false and tipus is not null group by 1) t),
    'forras',  (select coalesce(jsonb_agg(jsonb_build_object('ertek', s.kod, 'nev', s.nev,
                                  'db', (select count(*) from grants.call c
                                          where c.source_kod = s.kod and c.archivalt = false))
                                order by s.nev), '[]'::jsonb) from grants.source s),
    'allapot', jsonb_build_array('nyitott','hamarosan','zart')
  ) into v_out;
  return v_out;
end $$;

-- ETL-futások: az "Adatforrások állapota" képernyő részletei.
create or replace function public.grants_etl_runs(p_limit integer default 50)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_out jsonb;
begin
  perform grants.require_office();
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'forras', r.source_kod,
           'forras_nev', (select nev from grants.source where kod = r.source_kod),
           'indult', r.indult, 'vegzett', r.vegzett, 'allapot', r.allapot,
           'uj_db', r.uj_db, 'modosult_db', r.modosult_db, 'valtozatlan_db', r.valtozatlan_db,
           'hiba', r.hiba) order by r.indult desc), '[]'::jsonb)
    into v_out
    from (select * from grants.etl_run order by indult desc
           limit least(greatest(coalesce(p_limit, 50), 1), 200)) r;
  return v_out;
end $$;


-- ------------------------------------------------------------
-- 8. Író RPC-k — kézi felvitel és forráskezelés
-- ------------------------------------------------------------
-- Kézi felvitel. A felület ugyanezt a mezőkészletet adja, mint amit a gépi
-- forrás tölt, hogy a katalógus egységes maradjon.
create or replace function public.grants_call_save(p_adat jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_id     uuid := nullif(p_adat->>'id', '')::uuid;
  v_cim    text := nullif(btrim(coalesce(p_adat->>'cim', '')), '');
  v_forras text := coalesce(nullif(p_adat->>'forras', ''), 'kezi');
  v_azon   text;
  v_hat    jsonb := coalesce(p_adat->'hataridok', '[]'::jsonb);
  v_h      jsonb;
  v_i      integer := 0;
  v_allapot text := coalesce(nullif(p_adat->>'allapot', ''), 'nyitott');
begin
  perform grants.require_office();
  if v_cim is null then
    raise exception 'GRANTS_BAD_INPUT: a felhívás címe kötelező.';
  end if;
  if v_allapot not in ('nyitott','hamarosan','zart','ismeretlen') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen állapot: "%".', v_allapot;
  end if;

  if v_id is null then
    -- Kézi felvitelnél a forrás CSAK 'kezi' lehet: gépi forrás sorát nem
    -- hozunk létre kézzel, mert a következő futás felülírná vagy duplázná.
    v_forras := 'kezi';
    v_azon := coalesce(nullif(p_adat->>'azonosito', ''),
                       'KEZI-' || to_char(now(), 'YYYYMMDD') || '-' ||
                       left(replace(gen_random_uuid()::text, '-', ''), 6));
    insert into grants.call (
      source_kod, kulso_azonosito, cim, cim_en, program, alprogram, tipus,
      felhivas_azonosito, felhivas_cim, allapot, nyitas, keret_eur, keret_huf,
      tamogatas_szazalek, orszagkor, kedvezmenyezett, kivonat, url,
      partnerkereses, payload, hash, created_by)
    values (
      v_forras, v_azon, v_cim, nullif(p_adat->>'cim_en',''),
      nullif(p_adat->>'program',''), nullif(p_adat->>'alprogram',''), nullif(p_adat->>'tipus',''),
      nullif(p_adat->>'felhivas_azonosito',''), nullif(p_adat->>'felhivas_cim',''),
      v_allapot, nullif(p_adat->>'nyitas','')::timestamptz,
      nullif(p_adat->>'keret_eur','')::numeric, nullif(p_adat->>'keret_huf','')::numeric,
      nullif(p_adat->>'tamogatas_szazalek','')::numeric,
      nullif(p_adat->>'orszagkor',''), nullif(p_adat->>'kedvezmenyezett',''),
      nullif(p_adat->>'kivonat',''), nullif(p_adat->>'url',''),
      coalesce((p_adat->>'partnerkereses')::boolean, false),
      p_adat, grants.call_hash(p_adat), auth.uid())
    returning id into v_id;
  else
    -- Gépi forrásból származó sort kézzel nem írunk át: a következő futás
    -- visszaírná, és a felhasználó joggal hinné, hogy a javítása megmaradt.
    if (select source_kod from grants.call where id = v_id) <> 'kezi' then
      raise exception 'GRANTS_NOT_EDITABLE: gépi forrásból származó felhívás nem szerkeszthető kézzel.';
    end if;
    update grants.call set
      cim = v_cim, cim_en = nullif(p_adat->>'cim_en',''),
      program = nullif(p_adat->>'program',''), alprogram = nullif(p_adat->>'alprogram',''),
      tipus = nullif(p_adat->>'tipus',''),
      felhivas_azonosito = nullif(p_adat->>'felhivas_azonosito',''),
      felhivas_cim = nullif(p_adat->>'felhivas_cim',''),
      allapot = v_allapot, nyitas = nullif(p_adat->>'nyitas','')::timestamptz,
      keret_eur = nullif(p_adat->>'keret_eur','')::numeric,
      keret_huf = nullif(p_adat->>'keret_huf','')::numeric,
      tamogatas_szazalek = nullif(p_adat->>'tamogatas_szazalek','')::numeric,
      orszagkor = nullif(p_adat->>'orszagkor',''),
      kedvezmenyezett = nullif(p_adat->>'kedvezmenyezett',''),
      kivonat = nullif(p_adat->>'kivonat',''), url = nullif(p_adat->>'url',''),
      partnerkereses = coalesce((p_adat->>'partnerkereses')::boolean, partnerkereses),
      payload = p_adat, hash = grants.call_hash(p_adat), last_seen = now()
     where id = v_id;
  end if;

  -- Határidők: teljes csere, mert a felület a teljes listát küldi.
  delete from grants.call_deadline where call_id = v_id;
  for v_h in select * from jsonb_array_elements(v_hat) loop
    v_i := v_i + 1;
    insert into grants.call_deadline (call_id, sorszam, hatarido, megjegyzes)
    values (v_id, v_i,
            coalesce(nullif(v_h->>'hatarido','')::timestamptz,
                     nullif(trim(both '"' from v_h::text), '')::timestamptz),
            nullif(v_h->>'megjegyzes',''));
  end loop;
  perform grants.refresh_deadlines(v_id);

  return public.grants_call_get(v_id);
end $$;

-- Archiválás: törölni nem törlünk, mert a hivatkozások (későbbi beadások,
-- illesztések) értelmezhetetlenné válnának.
create or replace function public.grants_call_archive(p_call uuid, p_archivalt boolean default true)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  perform grants.require_office();
  update grants.call set archivalt = coalesce(p_archivalt, true) where id = p_call;
  if not found then raise exception 'GRANTS_CALL_NOT_FOUND'; end if;
  return jsonb_build_object('ok', true, 'id', p_call, 'archivalt', coalesce(p_archivalt, true));
end $$;

-- Forrás beállításai: aktív-e, milyen ütemmel, szabad-e gépi úton gyűjteni.
create or replace function public.grants_source_save(p_adat jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_kod text := nullif(p_adat->>'kod', '');
begin
  perform grants.require_office();
  if v_kod is null then raise exception 'GRANTS_BAD_INPUT: a forrás kódja kötelező.'; end if;
  if not exists (select 1 from grants.source where kod = v_kod) then
    raise exception 'GRANTS_SOURCE_NOT_FOUND: nincs ilyen forrás: "%".', v_kod;
  end if;
  update grants.source set
    nev             = coalesce(nullif(btrim(coalesce(p_adat->>'nev','')),''), nev),
    url             = coalesce(nullif(p_adat->>'url',''), url),
    leiras          = coalesce(nullif(p_adat->>'leiras',''), leiras),
    aktiv           = coalesce((p_adat->>'aktiv')::boolean, aktiv),
    gepi_gyujtes    = coalesce((p_adat->>'gepi_gyujtes')::boolean, gepi_gyujtes),
    jogi_megjegyzes = coalesce(nullif(p_adat->>'jogi_megjegyzes',''), jogi_megjegyzes),
    utem_ora        = coalesce((p_adat->>'utem_ora')::integer, utem_ora)
   where kod = v_kod;
  return jsonb_build_object('ok', true, 'kod', v_kod);
end $$;

-- Beállítás mentése. A modellszolgáltató váltása ITT történik, nem kódban.
create or replace function public.grants_setting_save(p_key text, p_value text)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  perform grants.require_office();
  if not exists (select 1 from grants.setting where key = p_key) then
    raise exception 'GRANTS_BAD_SETTING: ismeretlen beállítás: "%".', p_key;
  end if;
  -- A kulcsokat NEM engedjük beállításba: azok Supabase secretben élnek.
  if p_key = 'ai_provider' and coalesce(p_value,'') not in ('gemini','anthropic','nincs') then
    raise exception 'GRANTS_BAD_SETTING: az ai_provider csak gemini, anthropic vagy nincs lehet.';
  end if;
  if p_value ~* '(api[_-]?key|secret|bearer|sk-ant|AIza)' then
    raise exception 'GRANTS_BAD_SETTING: ide nem kerülhet kulcs vagy titok — azok Supabase secretben élnek.';
  end if;
  update grants.setting
     set value = coalesce(p_value, ''), updated_at = now(), updated_by = auth.uid()
   where key = p_key;
  return jsonb_build_object('ok', true, 'key', p_key, 'value', coalesce(p_value, ''));
end $$;


-- ------------------------------------------------------------
-- 9. ETL — a gyűjtő Edge Function felülete
-- ------------------------------------------------------------
-- Ezeket a service_role hívja (Edge Function), mert a gyűjtés nem
-- felhasználói művelet. Idempotens: ugyanazt a csomagot kétszer betöltve a
-- második futás "valtozatlan" sorokat számol, nem duplikál.
create or replace function public.grants_etl_start(p_source text)
returns bigint
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_id bigint;
begin
  if not exists (select 1 from grants.source where kod = p_source) then
    raise exception 'GRANTS_SOURCE_NOT_FOUND: %', p_source;
  end if;
  insert into grants.etl_run (source_kod) values (p_source) returning id into v_id;
  update grants.source set utolso_futas = now(), utolso_hiba = null where kod = p_source;
  return v_id;
end $$;

create or replace function public.grants_etl_finish(
  p_run bigint, p_ok boolean, p_hiba text default null, p_reszletek jsonb default '{}'::jsonb)
returns void
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_src text;
begin
  update grants.etl_run
     set vegzett = now(),
         allapot = case when coalesce(p_ok, false) then 'ok' else 'hiba' end,
         hiba = p_hiba, reszletek = coalesce(p_reszletek, '{}'::jsonb)
   where id = p_run
  returning source_kod into v_src;
  if v_src is null then raise exception 'GRANTS_RUN_NOT_FOUND: %', p_run; end if;

  if coalesce(p_ok, false) then
    update grants.source set utolso_siker = now(), utolso_hiba = null where kod = v_src;
  else
    update grants.source set utolso_hiba = left(coalesce(p_hiba, 'ismeretlen hiba'), 500) where kod = v_src;
  end if;
end $$;

-- A tényleges betöltés. Egy hívásban egy köteg felhívás.
-- Minden tétel: {azonosito, cim, cim_en, program, alprogram, tipus,
--   felhivas_azonosito, felhivas_cim, allapot, nyitas, hataridok:[ts],
--   keret_eur, keret_huf, orszagkor, kedvezmenyezett, kivonat, url,
--   partnerkereses, payload}
create or replace function public.grants_call_upsert(p_source text, p_items jsonb, p_run bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_it     jsonb;
  v_uj     integer := 0;
  v_mod    integer := 0;
  v_valt   integer := 0;
  v_id     uuid;
  v_hash   text;
  v_regi   grants.call%rowtype;
  v_azon   text;
  v_i      integer;
  v_h      jsonb;
  v_hatlista text;
begin
  if not exists (select 1 from grants.source where kod = p_source) then
    raise exception 'GRANTS_SOURCE_NOT_FOUND: %', p_source;
  end if;
  if jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' then
    raise exception 'GRANTS_BAD_INPUT: a tételek tömbben jönnek.';
  end if;

  for v_it in select * from jsonb_array_elements(p_items) loop
    v_azon := nullif(btrim(coalesce(v_it->>'azonosito', '')), '');
    if v_azon is null or nullif(btrim(coalesce(v_it->>'cim','')), '') is null then
      continue;   -- azonosító vagy cím nélkül nincs mit betölteni
    end if;

    -- A határidőlista a hash-be is beszámít, hogy a dátumváltozás látszódjon.
    v_hatlista := coalesce((select string_agg(x, ',' order by x)
                              from jsonb_array_elements_text(coalesce(v_it->'hataridok','[]'::jsonb)) x), '');
    v_hash := grants.call_hash(v_it || jsonb_build_object('hataridok', v_hatlista));

    select * into v_regi from grants.call
     where source_kod = p_source and kulso_azonosito = v_azon;

    if not found then
      insert into grants.call (
        source_kod, kulso_azonosito, cim, cim_en, program, alprogram, tipus,
        felhivas_azonosito, felhivas_cim, allapot, nyitas, keret_eur, keret_huf,
        tamogatas_szazalek, orszagkor, kedvezmenyezett, kivonat, url,
        partnerkereses, payload, hash)
      values (
        p_source, v_azon, v_it->>'cim', nullif(v_it->>'cim_en',''),
        nullif(v_it->>'program',''), nullif(v_it->>'alprogram',''), nullif(v_it->>'tipus',''),
        nullif(v_it->>'felhivas_azonosito',''), nullif(v_it->>'felhivas_cim',''),
        coalesce(nullif(v_it->>'allapot',''), 'ismeretlen'),
        nullif(v_it->>'nyitas','')::timestamptz,
        nullif(v_it->>'keret_eur','')::numeric, nullif(v_it->>'keret_huf','')::numeric,
        nullif(v_it->>'tamogatas_szazalek','')::numeric,
        nullif(v_it->>'orszagkor',''), nullif(v_it->>'kedvezmenyezett',''),
        nullif(v_it->>'kivonat',''), nullif(v_it->>'url',''),
        coalesce((v_it->>'partnerkereses')::boolean, false),
        coalesce(v_it->'payload', v_it), v_hash)
      returning id into v_id;
      v_uj := v_uj + 1;

    elsif v_regi.hash = v_hash then
      update grants.call set last_seen = now() where id = v_regi.id;
      v_valt := v_valt + 1;
      continue;

    else
      v_id := v_regi.id;
      -- Változásnapló: ami a felhasználót érdekli, nem a teljes diff.
      if coalesce(v_regi.allapot,'') <> coalesce(nullif(v_it->>'allapot',''), 'ismeretlen') then
        insert into grants.call_change (call_id, mi, regi, uj)
        values (v_id, 'allapot', v_regi.allapot, coalesce(nullif(v_it->>'allapot',''), 'ismeretlen'));
      end if;
      if coalesce(v_regi.cim,'') <> coalesce(v_it->>'cim','') then
        insert into grants.call_change (call_id, mi, regi, uj)
        values (v_id, 'cim', v_regi.cim, v_it->>'cim');
      end if;
      if coalesce(v_regi.keret_eur, -1) <> coalesce(nullif(v_it->>'keret_eur','')::numeric, -1) then
        insert into grants.call_change (call_id, mi, regi, uj)
        values (v_id, 'keret', v_regi.keret_eur::text, v_it->>'keret_eur');
      end if;

      update grants.call set
        cim = v_it->>'cim', cim_en = nullif(v_it->>'cim_en',''),
        program = nullif(v_it->>'program',''), alprogram = nullif(v_it->>'alprogram',''),
        tipus = nullif(v_it->>'tipus',''),
        felhivas_azonosito = nullif(v_it->>'felhivas_azonosito',''),
        felhivas_cim = nullif(v_it->>'felhivas_cim',''),
        allapot = coalesce(nullif(v_it->>'allapot',''), 'ismeretlen'),
        nyitas = nullif(v_it->>'nyitas','')::timestamptz,
        keret_eur = nullif(v_it->>'keret_eur','')::numeric,
        keret_huf = nullif(v_it->>'keret_huf','')::numeric,
        tamogatas_szazalek = nullif(v_it->>'tamogatas_szazalek','')::numeric,
        orszagkor = nullif(v_it->>'orszagkor',''),
        kedvezmenyezett = nullif(v_it->>'kedvezmenyezett',''),
        kivonat = nullif(v_it->>'kivonat',''), url = nullif(v_it->>'url',''),
        partnerkereses = coalesce((v_it->>'partnerkereses')::boolean, partnerkereses),
        payload = coalesce(v_it->'payload', v_it), hash = v_hash, last_seen = now()
       where id = v_id;
      v_mod := v_mod + 1;
    end if;

    -- Határidők: csere, majd a régi és az új legközelebbi összehasonlítása.
    declare
      v_elozo timestamptz := (select kovetkezo_hatarido from grants.call where id = v_id);
    begin
      delete from grants.call_deadline where call_id = v_id;
      v_i := 0;
      for v_h in select * from jsonb_array_elements(coalesce(v_it->'hataridok','[]'::jsonb)) loop
        v_i := v_i + 1;
        begin
          insert into grants.call_deadline (call_id, sorszam, hatarido)
          values (v_id, v_i, (trim(both '"' from v_h::text))::timestamptz);
        exception when others then
          null;   -- egy értelmezhetetlen dátum ne buktassa el az egész köteget
        end;
      end loop;
      perform grants.refresh_deadlines(v_id);

      if v_elozo is not null
         and v_elozo <> (select kovetkezo_hatarido from grants.call where id = v_id) then
        insert into grants.call_change (call_id, mi, regi, uj)
        values (v_id, 'hatarido', v_elozo::text,
                (select kovetkezo_hatarido::text from grants.call where id = v_id));
      end if;
    end;
  end loop;

  if p_run is not null then
    update grants.etl_run
       set uj_db = uj_db + v_uj, modosult_db = modosult_db + v_mod,
           valtozatlan_db = valtozatlan_db + v_valt
     where id = p_run;
  end if;

  return jsonb_build_object('uj', v_uj, 'modosult', v_mod, 'valtozatlan', v_valt);
end $$;


-- ------------------------------------------------------------
-- 10. Jogosultságok
-- ------------------------------------------------------------
-- Postgresben minden új függvény EXECUTE jogot ad a PUBLIC szerepkörnek,
-- ezért mindegyikről előbb visszavesszük, majd célzottan adjuk oda.
-- FONTOS, ÉLESBEN MÉRVE (2026-09-23): a Supabase alapértelmezett jogokat ad az
-- új public sémás függvényekre az anon ÉS az authenticated szerepkörnek is.
-- Ezért nem elég a "from public, anon" — az authenticated-től is vissza kell
-- vonni, különben a service_role-nak szánt ETL-függvényeket bárki hívhatná, aki
-- be van jelentkezve. A 74_webshop.sql ezt helyesen teszi; ez a fájl első
-- változata nem, és pont az itteni önellenőrzés bukott el rajta élesben.
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  -- Belső (grants séma) függvények: senkinek.
  foreach f in array array[
    'grants.has_perm(text)', 'grants.is_office()', 'grants.require_office()',
    'grants.call_hash(jsonb)', 'grants.refresh_deadlines(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  -- Felületi RPC-k: bejelentkezett felhasználónak (a törzs dönt a jogról).
  foreach f in array array[
    'public.grants_context()',
    'public.grants_calls(text,text,text,text,integer,integer,integer)',
    'public.grants_call_get(uuid)',
    'public.grants_call_options()',
    'public.grants_etl_runs(integer)',
    'public.grants_call_save(jsonb)',
    'public.grants_call_archive(uuid,boolean)',
    'public.grants_source_save(jsonb)',
    'public.grants_setting_save(text,text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- ETL: CSAK a service_role (Edge Function). Bejelentkezett felhasználó nem
  -- tölthet be köteget, mert azzal a katalógust bárki elárasztaná.
  foreach f in array array[
    'public.grants_etl_start(text)',
    'public.grants_etl_finish(bigint,boolean,text,jsonb)',
    'public.grants_call_upsert(text,jsonb,bigint)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
    if has_srv then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $grants$;

-- A táblákra a kliens SEMMILYEN jogot nem kap: a séma nem exposed, és a
-- jogokat is elvesszük. Minden hozzáférés a fenti RPC-ken megy.
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
declare v_n integer;
begin
  if has_function_privilege('anon', 'public.grants_calls(text,text,text,text,integer,integer,integer)', 'execute')
     or has_function_privilege('anon', 'public.grants_call_save(jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a palyazati fuggvenyeket.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_call_upsert(text,jsonb,bigint)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is tolthet be koteget.';
  end if;
  select count(*) into v_n from grants.source;
  raise notice 'Rendben: 77 — grants sema, % forras a regiszterben, felhivas-katalogus es ETL-naplo kesz.', v_n;
end $chk$;
