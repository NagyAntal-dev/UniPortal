-- ============================================================================
-- RUN_ALL_81_82.sql — MTMT forrássor + rendezhető kutatói lista (2026-09-24)
-- ============================================================================
-- EZT KELL LEFUTTATNI a Supabase SQL Editorban. Két migrációt tartalmaz, a
-- végén a szokásos 21-es megerősítéssel:
--
--   81 — a hiányzó `mtmt` forrássor (e nélkül az MTMT-felderítés
--        GRANTS_SOURCE_NOT_FOUND hibával elhasal), és önellenőrzés, hogy
--        mind a 8 forráskód létezik.
--   82 — a kutatói lista SZŰRHETŐ ÉS RENDEZHETŐ változata, a forrás saját
--        összesítőinek tárolása (MTMT független idézet, SJR-kvartilisek,
--        OpenAlex h-index/i10), a validált törzs jelölése, és a törzs
--        automatikus párosítása a már betöltött felderítéssel.
--   21 — az ECHO beküldés-szigorítás újrafuttatása (ez a megszokott
--        zárólépés minden csomag végén).
--
-- A FUTÁS VÉGÉN EZT A KÉT SORT KELL LÁTNOD:
--   NOTICE: Rendben: 81 — MTMT forrassor megvan, es mind a 8 forraskod letezik.
--   NOTICE: Rendben: 82 — rendezheto kutatoi lista, forras-metrikak, torzs-parositas.
-- Az első futáson e kettő között ez is megjelenik (a régi, rendezés nélküli
-- listafüggvényt cseréljük le), újrafuttatáskor már nem:
--   NOTICE: A regi, rendezes nelkuli grants_researchers() eltavolitva.
--
-- Ha BÁRMELYIK utasítás hibára fut, a SQL Editor az EGÉSZ csomagot visszavonja
-- — tehát félkész állapot nem marad utána. Hiba esetén küldd át a szöveget.
--
-- FUTÁS UTÁN a felületen (Kutatás és pályázatok → Pályázati iroda → Kutatók):
--   1. „Feltöltés az oktatói nyilvántartásból" — ez viszi be a validált
--      oktatókat a törzsbe (a 273 fős, ellenőrzött lista).
--   2. „Párosítás a felderítéssel" — ORCID-egyezésre összeköt, névegyezésre
--      javaslatot tesz.
--   3. „Metaadatok letöltése" — művek, témaprofil és a forrás összesítői.
-- ============================================================================


-- ####################################################################
-- ### 81_grants_mtmt_source.sql
-- ####################################################################

-- ============================================================
-- 81_grants_mtmt_source.sql — a hiányzó MTMT forrássor
-- ============================================================
-- MI VOLT A HIBA: a 77-es forrásregiszterbe `mta` kóddal az Akadémia
-- PÁLYÁZATAI kerültek be, az MTMT publikációs adatbázis pedig kimaradt. A
-- 80-as migráció ezért az `update grants.source ... where kod = 'mtmt'`
-- sorával CSENDBEN nulla sort módosított, a felderítő pedig
-- GRANTS_SOURCE_NOT_FOUND hibával elhasalt — a hiba élesben derült ki, a
-- betöltés első futtatásakor.
--
-- MIÉRT NEM ELÉG EGY UPDATE: az `update` nem hoz létre sort. Ez a fájl beírja a
-- hiányzó forrást, és a végén ELLENŐRZI, hogy minden olyan forráskód létezik-e,
-- amit a betöltő függvények használnak — hogy ez a hiba még egyszer ne
-- élesben jöjjön ki.
-- ============================================================

insert into grants.source (kod, nev, tipus, url, leiras, gepi_gyujtes, jogi_megjegyzes, utem_ora)
values ('mtmt', 'MTMT (Magyar Tudományos Művek Tára)', 'api', 'https://m2.mtmt.hu/api/',
        'Kutatói és publikációs adat. 2026-09-24-én mérve: az NJE csomópont '
        '(mtid 20201) alatt 11 alegység van, és a szerzőket egységenként kell '
        'kérdezni — így 306 egyedi szerző jön ki, 113 ORCID-del. A felület '
        'Accept fejlécként a saját típusát kéri (application/vnd.mtmt2-1.0+json); '
        'application/json esetén HTTP 406-ot ad.',
        true,
        'Saját intézményi kör (mtid 20201 és alegységei), mérsékelt ütemmel. Az adatra '
        'NINCS nyílt licenc, ezért a rendszeres gyűjtés kereteit az MTA KIK-kel írásban '
        'egyeztetni kell; addig csak az egyetem saját adatszolgáltatói körére kérdezünk.',
        168)
on conflict (kod) do update
   set nev = excluded.nev, tipus = excluded.tipus, url = excluded.url,
       leiras = excluded.leiras, gepi_gyujtes = excluded.gepi_gyujtes,
       jogi_megjegyzes = excluded.jogi_megjegyzes;

-- Az OpenAlex sor a 80-asban már bekerült; ha valamiért kimaradt, itt pótoljuk.
insert into grants.source (kod, nev, tipus, url, leiras, gepi_gyujtes, jogi_megjegyzes, utem_ora)
values ('openalex', 'OpenAlex (kutatói profilok)', 'api', 'https://api.openalex.org',
        'Publikációs metaadat CC0 licenc alatt. 2026-09-24-én mérve: 727 szerző van '
        'az NJE-hez affiliálva, 382-nek van ORCID-je, 421-nél az NJE a legutolsó '
        'affiliáció. 2026 februárja óta API-kulcs kell a produktív használathoz; az '
        'ingyenes szint a mi méretünkben elég.',
        true, 'CC0 licenc, helyben tárolható.', 168)
on conflict (kod) do nothing;

do $chk$
declare
  v_kell text[] := array['eu_portal','nkfih','palyazat_gov','mta','tempus','kezi','openalex','mtmt'];
  v_k    text;
  v_hiany text[] := '{}';
begin
  foreach v_k in array v_kell loop
    if not exists (select 1 from grants.source where kod = v_k) then
      v_hiany := array_append(v_hiany, v_k);
    end if;
  end loop;
  if array_length(v_hiany, 1) is not null then
    raise exception 'HIBA: hianyzo forraskod(ok): %. A betolto fuggvenyek ezekre hivatkoznak.',
                    array_to_string(v_hiany, ', ');
  end if;
  raise notice 'Rendben: 81 — MTMT forrassor megvan, es mind a % forraskod letezik.',
               array_length(v_kell, 1);
end $chk$;

-- ####################################################################
-- ### 82_grants_roster.sql
-- ####################################################################

-- ============================================================
-- 82_grants_roster.sql — informatív kutatói lista + párosítás a felderítéssel
-- ============================================================
-- MIÉRT KELL: a 273 validált oktató felvitele után a lista akkor hasznos, ha
-- szűrni ÉS rendezni lehet benne, és ha látszanak a mérhető metaadatok. Ez a
-- migráció ezt adja meg, és összekapcsolja a törzset a már betöltött
-- felderítéssel (2026-09-24-én 727 OpenAlex- és 306 MTMT-szerző).
--
-- MIT AD:
--   • grants_researchers(): RENDEZÉS (név, mű, idézet, h-index, utolsó szinkron,
--     hiányosság) és bővebb mezőkészlet — idézet, h-index, aktív évek,
--     kurzusszám az oktatói nyilvántartásból, ORCID-jelenlét
--   • grants_researcher_sync_teachers_etl(): ugyanaz, mint az irodai változat,
--     de service_role-nak — így a törzs feltöltése ütemezhető és
--     automatizálható. A @nje-import.invalid helykitöltő e-maileket NEM írja be.
--   • grants_match_roster(): a törzs és a felderített szerzők párosítása
--     ADATBÁZISON BELÜL, API-hívás nélkül. ORCID-egyezésre (névellenőrzéssel)
--     azonnal köt, egyedi névegyezésre javaslatot ad.
--   • grants_roster_stats(): a lista fejléce (lefedettség, hiányosságok).
--
-- A H-INDEX SZÁMÍTVA, NEM ÁTVETT: a betöltött művek idézetszámaiból. Így akkor
-- is van értéke, ha az OpenAlex összegzését nem kérdeztük le — és látszik, hogy
-- a NÁLUNK lévő adatra vonatkozik.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Validált törzs jelölése
-- ------------------------------------------------------------
alter table grants.researcher add column if not exists validalt boolean not null default false;
alter table grants.researcher add column if not exists validalt_at timestamptz;

comment on column grants.researcher.validalt is
  'Az oktatói nyilvántartásból (validált listából) került be, nem a felderítésből. A felderített, de nem validált személy is lehet kutató — de más a bizonyosság.';


-- ------------------------------------------------------------
-- 1/b. A forrás SAJÁT összesítői
-- ------------------------------------------------------------
-- MIÉRT KELL: amit mi számolunk, az a nálunk tárolt művekre igaz — a betöltés
-- pedig felső korláttal fut. A forrás viszont a TELJES pályaműre ad számot
-- (MTMT: független idézet, SJR-kvartilisek, típusonkénti darabszám; OpenAlex:
-- h-index, i10). Ezeket ezért külön tároljuk, és NEM keverjük a sajátunkkal.
--
-- Hosszú-keskeny tábla, hogy új mutató ne igényeljen új migrációt.
create table if not exists grants.researcher_metric (
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  forras        text not null
                  constraint grants_metric_forras_ck check (forras in ('openalex','mtmt','kezi')),
  kulcs         text not null,
  szam          numeric,
  szoveg        text,
  updated_at    timestamptz not null default now(),
  primary key (researcher_id, forras, kulcs)
);
comment on table grants.researcher_metric is
  'A forrás saját összesítői (kulcs-érték). A "mu_db"/"idezet"/"h_index" kulcs a FORRÁS szerinti teljes pályamű, nem a nálunk tárolt művek összege.';

create or replace function public.grants_metrics_set(
  p_researcher uuid, p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_it jsonb; v_db integer := 0;
begin
  if p_forras not in ('openalex','mtmt','kezi') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;
  if not exists (select 1 from grants.researcher where id = p_researcher) then
    raise exception 'GRANTS_RESEARCHER_NOT_FOUND';
  end if;
  delete from grants.researcher_metric where researcher_id = p_researcher and forras = p_forras;
  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if nullif(btrim(coalesce(v_it->>'kulcs','')), '') is null then continue; end if;
    insert into grants.researcher_metric (researcher_id, forras, kulcs, szam, szoveg)
    values (p_researcher, p_forras, btrim(v_it->>'kulcs'),
            nullif(v_it->>'szam','')::numeric, nullif(v_it->>'szoveg',''))
    on conflict (researcher_id, forras, kulcs) do update
       set szam = excluded.szam, szoveg = excluded.szoveg, updated_at = now();
    v_db := v_db + 1;
  end loop;
  return jsonb_build_object('metrikak', v_db);
end $$;


-- ------------------------------------------------------------
-- 2. Származtatott mutatók egy helyen
-- ------------------------------------------------------------
-- A h-index a NÁLUNK tárolt művek idézetszámaiból: a legnagyobb h, amire igaz,
-- hogy h darab mű legalább h idézetet kapott.
create or replace function grants.h_index(p_researcher uuid)
returns integer
language sql stable
set search_path = grants, public, pg_temp
as $$
  select coalesce(max(h), 0)
    from (select row_number() over (order by coalesce(w.idezet, 0) desc) as h,
                 coalesce(w.idezet, 0) as c
            from grants.researcher_work w
           where w.researcher_id = p_researcher) t
   where c >= h
$$;

-- Egy sor minden mérhető adata. Külön függvény, hogy a lista és a profil
-- UGYANAZT a számot mutassa — két helyen számolva elcsúsznának.
create or replace function grants.researcher_mutatok(p_researcher uuid)
returns jsonb
language sql stable
set search_path = grants, public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'mu_db',    (select count(*) from grants.researcher_work w where w.researcher_id = p_researcher),
    'idezet',   (select coalesce(sum(w.idezet), 0) from grants.researcher_work w where w.researcher_id = p_researcher),
    'h_index',  grants.h_index(p_researcher),
    'elso_ev',  (select min(w.ev) from grants.researcher_work w where w.researcher_id = p_researcher),
    'utolso_ev',(select max(w.ev) from grants.researcher_work w where w.researcher_id = p_researcher),
    'topic_db', (select count(*) from grants.researcher_topic t where t.researcher_id = p_researcher),
    'jelolt_db',(select count(*) from grants.identity_candidate c
                  where c.researcher_id = p_researcher and c.allapot = 'javasolt'),
    -- Kurzusszám az oktatói nyilvántartásból: ez mondja meg, ki tanít ma.
    'kurzus_db',(select count(*) from echo.course_teacher ct
                  where ct.teacher_id = (select teacher_id from grants.researcher
                                          where id = p_researcher)),
    -- A forrás saját összesítői forrásonként csoportosítva, plusz a két
    -- legbeszédesebb szám kiemelve, hogy rendezni is lehessen rájuk.
    'metrikak', (select coalesce(jsonb_object_agg(f.forras, f.ertekek), '{}'::jsonb)
                   from (select m.forras,
                                jsonb_object_agg(m.kulcs,
                                  coalesce(to_jsonb(m.szam), to_jsonb(m.szoveg))) as ertekek
                           from grants.researcher_metric m
                          where m.researcher_id = p_researcher
                          group by m.forras) f),
    'forras_idezet', (select max(m.szam) from grants.researcher_metric m
                       where m.researcher_id = p_researcher and m.kulcs = 'idezet'),
    'forras_mu_db',  (select max(m.szam) from grants.researcher_metric m
                       where m.researcher_id = p_researcher and m.kulcs = 'mu_db'),
    'forras_h_index',(select max(m.szam) from grants.researcher_metric m
                       where m.researcher_id = p_researcher and m.kulcs = 'h_index'))
$$;


-- ------------------------------------------------------------
-- 3. A lista: szűrés ÉS rendezés
-- ------------------------------------------------------------
create or replace function public.grants_researchers(
  p_q       text    default null,
  p_tipus   text    default null,
  p_kar     text    default null,
  p_allapot text    default null,
  p_szures  text    default null,   -- jelolt | hianyos | kikapcsolt | validalt |
                                   -- nincs_mu | nincs_metrika
  p_limit   integer default 100,
  p_offset  integer default 0,
  p_rend    text    default 'nev',  -- nev | mu | idezet | h_index | szinkron |
                                   -- kurzus | forras_idezet | forras_mu | forras_h
  p_irany   text    default 'asc'
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_lim   integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_q     text    := nullif(btrim(coalesce(p_q, '')), '');
  v_rend  text    := coalesce(nullif(p_rend, ''), 'nev');
  v_desc  boolean := lower(coalesce(p_irany, 'asc')) = 'desc';
  v_irany text;
  v_order text;
  v_out   jsonb;
begin
  perform grants.require_office();

  -- A rendezés oszlopa fehérlistás: a paraméter SOHA nem kerül közvetlenül a
  -- lekérdezésbe, csak egy leképezés kulcsaként.
  v_irany := case when v_desc then 'desc' else 'asc' end;
  v_order := case v_rend
    when 'nev'           then format('nev %s', v_irany)
    when 'mu'            then format('mu_db %s nulls last, nev asc', v_irany)
    when 'idezet'        then format('idezet %s nulls last, nev asc', v_irany)
    when 'h_index'       then format('h_index %s nulls last, nev asc', v_irany)
    when 'kurzus'        then format('kurzus_db %s nulls last, nev asc', v_irany)
    when 'szinkron'      then format('utolso_szinkron %s nulls last, nev asc', v_irany)
    -- A forrás saját számai: a teljes pályaműre igazak, nem a betöltött részre.
    when 'forras_idezet' then format('forras_idezet %s nulls last, nev asc', v_irany)
    when 'forras_mu'     then format('forras_mu_db %s nulls last, nev asc', v_irany)
    when 'forras_h'      then format('forras_h_index %s nulls last, nev asc', v_irany)
    else null
  end;
  if v_order is null then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen rendezes: "%".', v_rend;
  end if;

  -- Egyetlen lekérdezés: a szűrt halmazt kétszer olvassuk (darabszám + oldal),
  -- temp tábla nélkül — STABLE függvény nem hozhat létre táblát.
  execute format($q$
    with szurt as (
      select r.id, r.nev, r.utolso_szinkron,
             (m->>'mu_db')::integer     as mu_db,
             (m->>'idezet')::integer    as idezet,
             (m->>'h_index')::integer   as h_index,
             (m->>'kurzus_db')::integer as kurzus_db,
             (m->>'forras_idezet')::numeric  as forras_idezet,
             (m->>'forras_mu_db')::numeric   as forras_mu_db,
             (m->>'forras_h_index')::numeric as forras_h_index,
             jsonb_build_object(
               'id', r.id, 'nev', r.nev, 'cim', r.cim, 'tipus', r.tipus,
               'kar', r.kar, 'intezet', r.intezet,
               'email', case when r.email ilike '%%@nje-import.invalid' then null else r.email end,
               'orcid', r.orcid, 'openalex_id', r.openalex_id, 'mtmt_id', r.mtmt_id,
               'allapot', r.allapot, 'gepi_epites', r.gepi_epites,
               'csapatkereses', r.csapatkereses, 'validalt', r.validalt,
               'utolso_szinkron', r.utolso_szinkron, 'szinkron_hiba', r.szinkron_hiba,
               'mu_db', m->'mu_db', 'idezet', m->'idezet', 'h_index', m->'h_index',
               'elso_ev', m->'elso_ev', 'utolso_ev', m->'utolso_ev',
               'topic_db', m->'topic_db', 'jelolt_db', m->'jelolt_db',
               'kurzus_db', m->'kurzus_db', 'metrikak', m->'metrikak',
               'forras_idezet', m->'forras_idezet', 'forras_mu_db', m->'forras_mu_db',
               'forras_h_index', m->'forras_h_index',
               'fo_temak', (select coalesce(jsonb_agg(t.topic order by t.suly desc), '[]'::jsonb)
                              from (select topic, suly from grants.researcher_topic
                                     where researcher_id = r.id and szint = 'topic'
                                     order by suly desc limit 3) t),
               'hianyok', to_jsonb(grants.researcher_hianyok(r.id))) as adat
        from grants.researcher r
        cross join lateral grants.researcher_mutatok(r.id) m
       where ($2 is null or r.tipus = $2)
         and ($3 is null or r.kar = $3)
         and ($4 is null or r.allapot = $4)
         and ($1 is null or r.nev ilike '%%' || $1 || '%%'
              or coalesce(r.orcid,'') ilike '%%' || $1 || '%%'
              or coalesce(r.email,'') ilike '%%' || $1 || '%%')
         and ($5 is null
              or ($5 = 'kikapcsolt' and r.gepi_epites = false)
              or ($5 = 'validalt'   and r.validalt = true)
              or ($5 = 'jelolt' and exists (select 1 from grants.identity_candidate c
                                             where c.researcher_id = r.id and c.allapot = 'javasolt'))
              or ($5 = 'hianyos' and r.openalex_id is null and r.mtmt_id is null)
              or ($5 = 'nincs_mu' and not exists (select 1 from grants.researcher_work w
                                                   where w.researcher_id = r.id))
              or ($5 = 'nincs_metrika' and not exists (select 1 from grants.researcher_metric mm
                                                        where mm.researcher_id = r.id)))
    ), oldal as (
      select adat from szurt order by %s limit $6 offset $7
    )
    select jsonb_build_object(
      'ossz',    (select count(*) from szurt),
      'sorok',   (select coalesce(jsonb_agg(adat), '[]'::jsonb) from oldal),
      'mutatva', (select count(*) from oldal))
  $q$, v_order)
  into v_out
  using v_q, p_tipus, p_kar, p_allapot, p_szures, v_lim, v_off;

  return coalesce(v_out, '{}'::jsonb)
         || jsonb_build_object('hatar', v_lim, 'eltolas', v_off,
                               'rend', v_rend, 'irany', v_irany);
end $$;



-- ------------------------------------------------------------
-- 3/b. A profil: ugyanaz, mint a 79-ben, a forrás-metrikákkal kiegészítve
-- ------------------------------------------------------------
-- MIÉRT ITT: a profilnak és a listának UGYANAZT a számot kell mutatnia, ezért
-- mindkettő a grants.researcher_mutatok() függvényt kérdezi. A művek soraiban
-- megjelenik az SJR-kvartilis és a nyílt hozzáférés is — ezt a payloadba a
-- profilbetöltő írja be.
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
    'validalt', r.validalt,
    'hianyok', to_jsonb(grants.researcher_hianyok(r.id)),
    -- A forrás saját összesítői forrásonként, dátummal: a profilban látszik,
    -- melyik szám honnan és mikorról van.
    'metrikak', (select coalesce(jsonb_object_agg(f.forras, f.adat), '{}'::jsonb)
                   from (select m.forras,
                                jsonb_build_object(
                                  'frissitve', max(m.updated_at),
                                  'ertekek', jsonb_object_agg(m.kulcs,
                                     coalesce(to_jsonb(m.szam), to_jsonb(m.szoveg)))) as adat
                           from grants.researcher_metric m
                          where m.researcher_id = r.id
                          group by m.forras) f),
    'mutatok', grants.researcher_mutatok(r.id),
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
                  'szerzoi_pozicio', w.szerzoi_pozicio,
                  'nyilt_hozzaferes', w.nyilt_hozzaferes,
                  'sjr', w.payload->>'sjr_kvartilis')
                  order by w.ev desc nulls last, w.cim), '[]'::jsonb)
                from (select * from grants.researcher_work where researcher_id = r.id
                       order by ev desc nulls last limit 30) w)
  ) into v_out;
  return v_out;
end $$;

-- ------------------------------------------------------------
-- 4. A lista fejléce: lefedettség
-- ------------------------------------------------------------
create or replace function public.grants_roster_stats()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_out jsonb;
begin
  perform grants.require_office();
  select jsonb_build_object(
    'kutato',        (select count(*) from grants.researcher),
    'validalt',      (select count(*) from grants.researcher where validalt),
    'aktiv',         (select count(*) from grants.researcher where allapot = 'aktiv'),
    'kikapcsolt',    (select count(*) from grants.researcher where gepi_epites = false),
    'orcid',         (select count(*) from grants.researcher where orcid is not null),
    'openalex',      (select count(*) from grants.researcher where openalex_id is not null),
    'mtmt',          (select count(*) from grants.researcher where mtmt_id is not null),
    'van_mu',        (select count(distinct researcher_id) from grants.researcher_work),
    'van_temaprofil',(select count(distinct researcher_id) from grants.researcher_topic),
    'van_metrika',   (select count(distinct researcher_id) from grants.researcher_metric),
    'jelolt',        (select count(*) from grants.identity_candidate where allapot = 'javasolt'),
    'mu_ossz',       (select count(*) from grants.researcher_work),
    'szinkronra_var',(select count(*) from grants.researcher
                       where allapot = 'aktiv' and gepi_epites = true
                         and (utolso_szinkron is null or utolso_szinkron < now() - interval '7 days')),
    'kar', (select coalesce(jsonb_agg(jsonb_build_object('ertek', k, 'db', n) order by n desc), '[]'::jsonb)
              from (select coalesce(kar, '(nincs megadva)') k, count(*) n
                      from grants.researcher group by 1) t)
  ) into v_out;
  return v_out;
end $$;


-- ------------------------------------------------------------
-- 5. Törzsfeltöltés ütemezhetően (service_role)
-- ------------------------------------------------------------
-- Ugyanaz, mint az irodai változat, két különbséggel: nem kér irodai jogot
-- (a service_role maga a kapu), és a validált jelölést is beírja.
create or replace function public.grants_researcher_sync_teachers_etl()
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_uj integer := 0; v_frissitve integer := 0;
begin
  with be as (
    insert into grants.researcher (teacher_id, profile_id, nev, cim, email, tipus, kar, intezet,
                                   validalt, validalt_at)
    select t.id, t.profile_id, t.name, t.title,
           -- A @nje-import.invalid helykitöltő nem kapcsolattartási adat.
           case when t.email ilike '%@nje-import.invalid' then null else t.email end,
           'oktato',
           (select o2.name_hu from echo.org_unit o2
             where o2.id = (with recursive f as (
                              select o.id, o.parent_id, o.kind from echo.org_unit o where o.id = t.org_unit_id
                              union all
                              select p.id, p.parent_id, p.kind from echo.org_unit p join f on f.parent_id = p.id)
                            select id from f where kind = 'kar' limit 1)),
           (select o3.name_hu from echo.org_unit o3 where o3.id = t.org_unit_id),
           true, now()
      from echo.teacher t
     where t.active = true
       and not exists (select 1 from grants.researcher r where r.teacher_id = t.id)
    returning 1)
  select count(*) into v_uj from be;

  -- Aki már bent van, de még nem volt validáltként jelölve: most az lesz.
  update grants.researcher r
     set validalt = true, validalt_at = coalesce(validalt_at, now()), updated_at = now()
   where r.teacher_id is not null and r.validalt = false
     and exists (select 1 from echo.teacher t where t.id = r.teacher_id and t.active = true);
  get diagnostics v_frissitve = row_count;

  return jsonb_build_object('uj', v_uj, 'validaltra_allitva', v_frissitve,
                            'osszes', (select count(*) from grants.researcher));
end $$;


-- ------------------------------------------------------------
-- 6. A törzs párosítása a felderített szerzőkkel
-- ------------------------------------------------------------
-- ADATBÁZISON BELÜL, API-hívás nélkül: a felderítés már betöltött 727 OpenAlex-
-- és 306 MTMT-szerzőt, tehát a párosítás egy lekérdezés. ORCID-egyezésre
-- (névellenőrzéssel!) azonnal köt, egyedi névegyezésre javaslatot ad.
create or replace function public.grants_match_roster(p_forras text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  d record;
  v_res uuid;
  v_kotve integer := 0;
  v_javasolt integer := 0;
  v_konflikt integer := 0;
  v_tobbes integer := 0;
begin
  perform grants.require_office();

  for d in select * from grants.discovered_author
            where allapot = 'uj'
              and (p_forras is null or forras = p_forras)
            order by coalesce(mu_db, 0) desc
  loop
    v_res := null;

    -- 1) ORCID: a legerősebb jel, de névellenőrzéssel.
    if d.orcid is not null then
      select id into v_res from grants.researcher
       where lower(orcid) = lower(d.orcid)
         and (case when d.forras = 'openalex' then openalex_id else mtmt_id end) is null
       limit 1;
      if v_res is not null and not grants.nev_atfedes(d.nev, (select nev from grants.researcher where id = v_res)) then
        -- ORCID egyezik, a név nem: adathiba valahol. Javaslat, nem kötés.
        update grants.discovered_author
           set javasolt_researcher_id = v_res, javaslat_ok = 'orcid_nevkonflikt'
         where id = d.id;
        v_konflikt := v_konflikt + 1;
        v_res := null;
        continue;
      end if;
    end if;

    if v_res is not null then
      if d.forras = 'openalex' then
        update grants.researcher set openalex_id = d.kulso_id, orcid = coalesce(orcid, d.orcid),
               utolso_szinkron = null, updated_at = now() where id = v_res;
      else
        update grants.researcher set mtmt_id = d.kulso_id, orcid = coalesce(orcid, d.orcid),
               utolso_szinkron = null, updated_at = now() where id = v_res;
      end if;
      update grants.discovered_author
         set allapot = 'osszekotve', researcher_id = v_res, javaslat_ok = 'orcid',
             dontes_at = now(), dontes_by = auth.uid()
       where id = d.id;
      v_kotve := v_kotve + 1;
      continue;
    end if;

    -- 2) Név: csak EGYETLEN találatra javaslunk, és csak ha annál még nincs
    --    azonosító ebből a forrásból. Több találatnál a gép nem dönthet.
    if d.nev is not null then
      if (select count(*) from grants.researcher r
           where grants.nev_norm(r.nev) = grants.nev_norm(d.nev)) = 1 then
        select id into v_res from grants.researcher r
         where grants.nev_norm(r.nev) = grants.nev_norm(d.nev)
           and (case when d.forras = 'openalex' then r.openalex_id else r.mtmt_id end) is null;
        if v_res is not null then
          update grants.discovered_author
             set javasolt_researcher_id = v_res, javaslat_ok = 'nev'
           where id = d.id;
          v_javasolt := v_javasolt + 1;
        end if;
      elsif (select count(*) from grants.researcher r
              where grants.nev_norm(r.nev) = grants.nev_norm(d.nev)) > 1 then
        v_tobbes := v_tobbes + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'orcid_alapjan_kotve', v_kotve,
    'nev_alapjan_javasolt', v_javasolt,
    'orcid_nevkonfliktus', v_konflikt,
    'tobb_azonos_nevu', v_tobbes,
    'osszekotott_kutato', (select count(*) from grants.researcher
                            where openalex_id is not null or mtmt_id is not null));
end $$;


-- ------------------------------------------------------------
-- 7. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  foreach f in array array['grants.h_index(uuid)', 'grants.researcher_mutatok(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  foreach f in array array[
    'public.grants_researchers(text,text,text,text,text,integer,integer,text,text)',
    'public.grants_roster_stats()',
    'public.grants_match_roster(text)',
    -- Újradefiniált: a create or replace MEGTARTJA a jogosultságokat, de a
    -- Supabase alapértelmezése miatt az anon-t itt is le kell venni.
    'public.grants_researcher_get(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array[
    'public.grants_metrics_set(uuid,text,jsonb)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
    if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
  end loop;

  execute 'revoke all on function public.grants_researcher_sync_teachers_etl() from public';
  if has_anon then execute 'revoke all on function public.grants_researcher_sync_teachers_etl() from anon'; end if;
  if has_auth then execute 'revoke all on function public.grants_researcher_sync_teachers_etl() from authenticated'; end if;
  if has_srv  then execute 'grant execute on function public.grants_researcher_sync_teachers_etl() to service_role'; end if;
end $grants$;

-- A régi, 7 paraméteres változat eltűnik a rendezés miatt: ha mindkettő
-- megmarad, a 7 nevesített paraméterrel érkező hívás nem egyértelmű, és
-- PostgREST hibával áll le.
do $$
begin
  -- pronargs, NEM pg_get_function_identity_arguments: az utóbbi NÉVVEL adja
  -- vissza a paramétereket ("p_q text, ..."), így a szöveges összehasonlítás
  -- csendben mindig hamis lenne, és a régi alak bent maradna.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'grants_researchers'
                and p.pronargs = 7) then
    execute 'drop function public.grants_researchers(text,text,text,text,text,integer,integer)';
    raise notice 'A regi, rendezes nelkuli grants_researchers() eltavolitva.';
  end if;
end $$;

do $chk$
begin
  if has_function_privilege('anon', 'public.grants_researchers(text,text,text,text,text,integer,integer,text,text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a kutatoi listat.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_researcher_sync_teachers_etl()', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is futtathatja a torzsfeltoltest ETL-modban.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_metrics_set(uuid,text,jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is irhat forras-metrikat.';
  end if;
  raise notice 'Rendben: 82 — rendezheto kutatoi lista, forras-metrikak, torzs-parositas.';
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
