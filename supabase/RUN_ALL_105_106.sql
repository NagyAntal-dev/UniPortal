-- ============================================================================
-- RUN_ALL_105_106.sql — a két hátralévő pályázati migráció egy futásban
-- ============================================================================
-- Ez a szkript a 105-öt és a 106-ot is telepíti, a végén a szokásos
-- 21_echo_harden_submit.sql újrafuttatással. A korábbi RUN_ALL_105.sql és
-- RUN_ALL_106.sql helyett ELÉG EZT LEFUTTATNI — a kettőt külön már nem kell.
--
-- Egy tranzakció, egy másolás-beillesztés a Supabase SQL Editorba. Ha bármi
-- elhasal, a teljes szkript visszaáll (az Editor rollbackel), és semmi nem
-- települ félig.
--
-- A két migráció egymástól függetlenül működik, de a felhasználói felület
-- mindkettőre vár: a felhívás-kártyán a javasolt projektvezető (105) és a
-- Konzorcium fül (106) addig üres/tartalék állapotot mutat.
--
-- ============================================================================
-- MIT TELEPÍT — 105_grants_projektvezeto.sql
-- ============================================================================
-- MIÉRT: a vezetőjelölt eddig is eldőlt — a csapatépítő bizonyított utolsó
-- szerzőség, pályázati előzmény és korábbi vezetői szerep alapján választ —,
-- de csak a Csapatajánló fülön, a felhívás megnyitása után látszott. A
-- főoldali listában, ahol az iroda a napi munkát kezdi, semmi nem utalt rá,
-- hogy van-e egyáltalán emberünk, aki ezt vinni tudná.
--
-- MIT AD: minden felhívás-kártya viszi a javasolt projektvezetőt, a karát, és
-- az INDOKLÁST — mért tényekből:
--     „2 utolsó szerzős publikáció · 1 pályázati előzmény · 81 pont a(z)
--      »szenzoradat-gyűjtés« elváráson · szabad kapacitás"
-- alatta pedig a konkrét mű, amire a találat épül.
--
-- AZ INDOKLÁS SZÁMOKBÓL VAN, NEM MODELLBŐL. Nem azért, mert a modell rosszabb
-- lenne, hanem mert ez a mondat egy DÖNTÉST támaszt alá: ellenőrizhetőnek kell
-- lennie, és nem változhat két megnyitás között.
--
-- ŐSZINTÉN JELEZZÜK, HA NINCS ELŐZMÉNY: ha a legjobb jelöltnek nincs vezetői
-- múltja, a javaslat kiírja („vezetői előzmény nélkül"), és az ikon is halvány
-- marad. Az iroda dolga eldönteni, hogy ez kockázat vagy lehetőség — nem a
-- rendszeré elhallgatni. MÉRVE mindkét eset: előzménnyel a tapasztalt jelölt
-- jön, nélküle a pályakezdő, kiírt figyelmeztetéssel.
--
-- A javaslat forrása, sorrendben: a csapatjavaslat vezetője → ha még nincs
-- csapat, a legjobb olyan találat, akinek van vezetői előzménye → végül a
-- legjobb találat, előzmény nélkül is.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 105 — javasolt projektvezeto a felhivas kartyajan, indoklassal.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
-- ============================================================================

-- ============================================================================
-- MIT TELEPÍT — 106_grants_konzorcium.sql
-- ============================================================================
-- MIT MÉRTEM MEG ELŐSZÖR: az EU partnerkereső HIRDETÉSEIT — hogy melyik
-- külföldi szervezet keres partnert egy témára — nyilvános API-n innen NEM
-- lehet lekérni. A portál kereső-API-ja (search-api, SEDIA) minden szűrt
-- lekérdezésre „internal error"-t ad, a partnerkereső modul pedig a
-- bejelentkezés mögötti felületen él. Ami elérhető: a téma partnerkereső
-- oldala linkelhető (ellenőrizve, HTTP 200).
--
-- EZÉRT a képernyő nem azt ígéri, amit nem tudunk megszerezni, hanem azt adja,
-- amit rajtunk kívül senki nem tud megmondani:
--   * mely nyitott felhívásoknál engedett a partnerkeresés,
--   * MIRE kell nekünk partner — mely elvárásra nincs házon belüli jelöltünk,
--   * kiket vinnénk mi a konzorciumba (a javasolt csapat, vezetővel),
--   * és egy közvetlen link a téma partnerkereső oldalára a kiírónál.
--
-- Így a megkereséshez minden együtt van: mit tudunk, mi hiányzik, hol lehet
-- meghirdetni. Ha a hirdetés-adat később API-n elérhetővé válik, a képernyő a
-- helyén marad — csak egy lista bővül rajta.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 106 — konzorciumkereses; <szám> nyitott felhivasnal engedett a partnerkereses.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
-- ============================================================================
-- ============================================================================


-- ####################################################################
-- ### 105_grants_projektvezeto.sql
-- ####################################################################

-- ============================================================
-- 105_grants_projektvezeto.sql — javasolt projektvezető a felhívás kártyáján
-- ============================================================
-- MIÉRT: a vezetőjelölt eddig is eldőlt (a csapatépítő bizonyított utolsó
-- szerzőség, pályázati előzmény és korábbi vezetői szerep alapján választ), de
-- csak a Csapatajánló fülön, a felhívás megnyitása után látszott. A főoldali
-- listában — ahol az iroda a napi munkát kezdi — semmi nem utalt rá, hogy van-e
-- egyáltalán emberünk, aki ezt vinni tudná.
--
-- MIT AD:
--   grants.vezeto_indok()  — a javaslat INDOKLÁSA mért tényekből: hány utolsó
--        szerzős publikáció, hány korábbi pályázat, vezetett-e már, mekkora a
--        kapacitása, és melyik konkrét műve adta a találatot.
--   grants.call_vezeto()   — felhívásonként a javasolt vezető. Elsődlegesen a
--        csapatjavaslat vezetője; ha még nincs csapat, a legjobb olyan
--        találat, akinek van vezetői előzménye.
--   grants_calls           — minden sor viszi a javaslatot, hogy a kártyán
--        megjelenhessen.
--
-- AZ INDOKLÁS SZÁMOKBÓL VAN, NEM MODELLBŐL. Nem azért, mert a modell rosszabb
-- lenne, hanem mert ez a mondat egy DÖNTÉST támaszt alá: ellenőrizhetőnek kell
-- lennie, és nem változhat két megnyitás között. A modell szerepe az árnyalás
-- marad, nem a tényállítás.
--
-- ŐSZINTÉN JELEZZÜK, HA NINCS ELŐZMÉNY: ha a legjobb jelöltnek nincs vezetői
-- múltja, a javaslat kiírja („vezetői előzmény nélkül"). Az iroda dolga
-- eldönteni, hogy ez kockázat vagy lehetőség — nem a rendszeré elhallgatni.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- Az indoklás: mért tények, egy mondatban is összerakva
-- ------------------------------------------------------------
create or replace function grants.vezeto_indok(p_researcher uuid, p_call uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare
  v_utolso integer; v_palyazat integer; v_vezetett integer; v_mu integer;
  v_kap numeric; v_tek numeric; v_ossz numeric; v_arculat text;
  v_cim text; v_ev integer; v_reszek text[] := '{}'; v_szoveg text;
begin
  select count(*) filter (where w.szerzoi_pozicio = 'utolso'), count(*),
         max(w.ev)
    into v_utolso, v_mu, v_ev
    from grants.researcher_work w where w.researcher_id = p_researcher;

  select count(*) into v_palyazat
    from grants.researcher_grant g where g.researcher_id = p_researcher;

  select count(*) into v_vezetett
    from grants.invite i
   where i.researcher_id = p_researcher and i.szerep = 'vezeto'
     and i.allapot in ('elfogadta','beadva','nyert');

  v_kap := grants.kapacitas_pont(p_researcher);
  v_tek := grants.tekintely_pont(p_researcher);

  -- A találat, amiért erre a felhívásra javasoljuk, és a mű, amire épül.
  select m.ossz, f.nev, m.bizonyitek->0->>'cim', (m.bizonyitek->0->>'ev')::integer
    into v_ossz, v_arculat, v_cim, v_ev
    from grants.call_match m
    join grants.call_facet f on f.id = m.facet_id
   where m.call_id = p_call and m.researcher_id = p_researcher
   order by m.ossz desc limit 1;

  -- A mondat a LEGERŐSEBB tényekből épül, sorrendben. Ami nincs, arról nem
  -- állítunk semmit — és ha egyik sincs, azt is kimondjuk.
  if coalesce(v_vezetett, 0) > 0 then
    v_reszek := v_reszek || format('%s pályázatot vezetett már', v_vezetett);
  end if;
  if coalesce(v_utolso, 0) > 0 then
    v_reszek := v_reszek || format('%s utolsó szerzős publikáció', v_utolso);
  end if;
  if coalesce(v_palyazat, 0) > 0 then
    v_reszek := v_reszek || format('%s pályázati előzmény', v_palyazat);
  end if;
  if v_ossz is not null and v_arculat is not null then
    v_reszek := v_reszek || format('%s pont a(z) „%s" elváráson', round(v_ossz), v_arculat);
  end if;
  if coalesce(v_kap, 0) >= 80 then
    v_reszek := v_reszek || 'szabad kapacitás'::text;
  elsif coalesce(v_kap, 0) < 40 then
    v_reszek := v_reszek || format('szűk kapacitás (%s pont)', round(v_kap));
  end if;

  if array_length(v_reszek, 1) is null then
    v_szoveg := 'Nincs mérhető előzménye — a javaslat kizárólag a téma illeszkedésén alapul.';
  else
    v_szoveg := array_to_string(v_reszek, ' · ');
    if coalesce(v_vezetett, 0) = 0 and coalesce(v_utolso, 0) = 0 and coalesce(v_palyazat, 0) = 0 then
      v_szoveg := v_szoveg || ' — vezetői előzmény nélkül';
    end if;
  end if;

  return jsonb_build_object(
    'szoveg', v_szoveg,
    'utolso_szerzos', coalesce(v_utolso, 0),
    'palyazat', coalesce(v_palyazat, 0),
    'vezetett', coalesce(v_vezetett, 0),
    'mu_db', coalesce(v_mu, 0),
    'kapacitas', round(coalesce(v_kap, 0)),
    'tekintely', round(coalesce(v_tek, 0)),
    'ossz', v_ossz,
    'arculat', v_arculat,
    'mire', v_cim,
    'mire_ev', v_ev,
    -- Az iroda lássa, mennyire megalapozott a javaslat.
    'bizonyitott', (coalesce(v_vezetett, 0) > 0 or coalesce(v_utolso, 0) > 0
                    or coalesce(v_palyazat, 0) > 0));
end $$;

-- ------------------------------------------------------------
-- A javaslat: a csapat vezetője, vagy a legjobb alkalmas jelölt
-- ------------------------------------------------------------
create or replace function grants.call_vezeto(p_call uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_res uuid; v_forras text;
begin
  -- 1. A csapatjavaslat vezetője. Ez a legerősebb: ott a lefedés és a
  --    megszorítások is számítottak.
  select m.researcher_id into v_res
    from grants.call_team t
    join grants.call_team_member m on m.team_id = t.id
   where t.call_id = p_call and m.szerep = 'vezeto'
   order by (t.valtozat = 'lefedes') desc, t.lefedett desc
   limit 1;
  if v_res is not null then v_forras := 'csapat'; end if;

  -- 2. Ha még nincs csapat: a legjobb találat, akinek van vezetői előzménye.
  if v_res is null then
    select m.researcher_id into v_res
      from grants.call_match m
     where m.call_id = p_call and grants.vezeto_alkalmas(m.researcher_id)
     order by m.ossz desc limit 1;
    if v_res is not null then v_forras := 'talalat'; end if;
  end if;

  -- 3. Végső esetben a legjobb találat, előzmény nélkül is — az indoklás
  --    ilyenkor ki is mondja, hogy nincs vezetői múltja.
  if v_res is null then
    select m.researcher_id into v_res
      from grants.call_match m where m.call_id = p_call
     order by m.ossz desc limit 1;
    if v_res is not null then v_forras := 'talalat_elozmeny_nelkul'; end if;
  end if;

  if v_res is null then return null; end if;

  return (select jsonb_build_object(
            'researcher_id', r.id, 'nev', r.nev, 'kar', r.kar, 'intezet', r.intezet,
            'forras', v_forras,
            'felkerve', exists (select 1 from grants.invite i
                                 where i.call_id = p_call and i.researcher_id = r.id
                                   and grants.invite_valodi(i.allapot)))
            || grants.vezeto_indok(r.id, p_call)
            from grants.researcher r where r.id = v_res);
end $$;

-- ------------------------------------------------------------
-- A lista minden sora vigye a javaslatot
-- ------------------------------------------------------------
create or replace function public.grants_calls(
  p_q        text    default null,
  p_allapot  text    default null,
  p_program  text    default null,
  p_source   text    default null,
  p_napon_belul integer default null,
  p_limit    integer default 100,
  p_offset   integer default 0,
  -- Lejárt kiírás csak kérésre (104).
  p_lejart   boolean default false
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
     -- A „nyitott" állapot a KIÍRÓ jelzése; a határidő azóta lejárhatott.
     -- Alapból elhagyjuk őket, mert a lista a legközelebbi határidő szerint
     -- rendez, és különben épp a lejártak állnának elöl. A NULL határidejű
     -- (tervezett) kiírás MARAD: az nem lejárt, csak még nincs dátuma.
     and (p_lejart is true or c.kovetkezo_hatarido is null
          or c.kovetkezo_hatarido::date >= current_date)
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
                                   else (c.kovetkezo_hatarido::date - current_date) end,
             'keret_eur', c.keret_eur, 'keret_huf', c.keret_huf,
             'orszagkor', c.orszagkor, 'kedvezmenyezett', c.kedvezmenyezett,
             'kivonat', left(coalesce(c.kivonat, ''), 400),
             'url', c.url, 'partnerkereses', c.partnerkereses,
             'forras', c.source_kod, 'forras_nev', s.nev,
             'hataridok', (select coalesce(jsonb_agg(d.hatarido order by d.sorszam), '[]'::jsonb)
                             from grants.call_deadline d where d.call_id = c.id),
             'valtozott', (select max(ch.mikor) from grants.call_change ch where ch.call_id = c.id),
             -- Javasolt projektvezető a kártyára, indoklással (105). A
             -- sorok száma korlátos (legfeljebb néhány tucat), ezért soronként
             -- számoljuk — így mindig a friss csapatjavaslatot tükrözi.
             'vezeto', grants.call_vezeto(c.id),
             'first_seen', c.first_seen, 'last_seen', c.last_seen
           ) as x,
           -- Nyitott elöl, azon belül a legközelebbi határidő.
           case c.allapot when 'nyitott' then 0 when 'hamarosan' then 1 else 2 end as rendez,
           coalesce(c.kovetkezo_hatarido, 'infinity'::timestamptz) as hat,
           c.cim as cim
      from grants.call c
      join grants.source s on s.kod = c.source_kod
     where c.archivalt = false
     -- A „nyitott" állapot a KIÍRÓ jelzése; a határidő azóta lejárhatott.
     -- Alapból elhagyjuk őket, mert a lista a legközelebbi határidő szerint
     -- rendez, és különben épp a lejártak állnának elöl. A NULL határidejű
     -- (tervezett) kiírás MARAD: az nem lejárt, csak még nincs dátuma.
     and (p_lejart is true or c.kovetkezo_hatarido is null
          or c.kovetkezo_hatarido::date >= current_date)
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


do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  f text;
begin
  foreach f in array array['grants.vezeto_indok(uuid,uuid)', 'grants.call_vezeto(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  f := 'public.grants_calls(text,text,text,text,integer,integer,integer,boolean)';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon',
         'public.grants_calls(text,text,text,text,integer,integer,integer,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon lekerdezheti a felhivas-listat.';
  end if;
  raise notice 'Rendben: 105 — javasolt projektvezeto a felhivas kartyajan, indoklassal.';
end $chk$;


-- ####################################################################
-- ### 106_grants_konzorcium.sql
-- ####################################################################

-- ============================================================
-- 106_grants_konzorcium.sql — konzorciumkeresés: hova kell partner
-- ============================================================
-- MIT MÉRTEM MEG ELŐSZÖR (2026-09-27): az EU partnerkereső HIRDETÉSEIT — hogy
-- melyik külföldi szervezet keres partnert egy témára — nyilvános API-n innen
-- NEM lehet lekérni. A portál kereső-API-ja (search-api, SEDIA) minden szűrt
-- lekérdezésre „internal error"-t ad, a partnerkereső modul pedig a bejelentkezés
-- mögötti felületen él. Amit el lehet érni: a téma partnerkereső oldala
-- linkelhető (ellenőrizve, HTTP 200).
--
-- EZÉRT EZ A KÉPERNYŐ NEM AZT MUTATJA, AMIT NEM TUDUNK MEGSZEREZNI, hanem azt,
-- amit rajtunk kívül senki nem tud megmondani:
--   * mely nyitott felhívásoknál engedett a partnerkeresés,
--   * MIRE kell nekünk partner — vagyis mely elvárásokra nincs házon belüli
--     jelöltünk (ez a csapatajánló legfontosabb kimenete),
--   * kiket vinnénk mi a konzorciumba (a javasolt csapat),
--   * és egy közvetlen link a téma partnerkereső oldalára a kiírónál.
--
-- Így a megkeresés megírásához minden együtt van: mit tudunk, mi hiányzik, és
-- hol lehet meghirdetni. Ha a partnerkereső adat később API-n elérhetővé válik,
-- ez a képernyő a helyén marad — csak egy lista bővül rajta.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function public.grants_partner_calls(
  p_q          text    default null,
  p_limit      integer default 40,
  p_csak_hiany boolean default false)   -- csak ahol tényleg hiányzik valaki
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_office();
  return (select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object(
                   'call_id', c.id, 'cim', c.cim, 'program', c.program, 'tipus', c.tipus,
                   'hatarido', c.kovetkezo_hatarido, 'url', c.url,
                   'azonosito', coalesce(c.payload->>'identifier', c.kulso_azonosito),
                   -- A kiíró partnerkereső oldala a témához. Ellenőrizve: a
                   -- /partner-search útvonal létező oldal.
                   'partner_url', case
                     when coalesce(c.payload->>'identifier', c.kulso_azonosito) is not null
                       then 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/'
                            || 'opportunities/topic-details/'
                            || lower(coalesce(c.payload->>'identifier', c.kulso_azonosito))
                            || '/partner-search'
                     else null end,
                   'arculat_db', (select count(*) from grants.call_facet f where f.call_id = c.id),
                   -- MIRE KELL PARTNER: azok az elvárások, amelyekre egyetlen
                   -- házon belüli jelölt sincs.
                   'hianyzo', coalesce((
                      select jsonb_agg(jsonb_build_object('arculat', f.nev, 'szoveg', left(coalesce(f.szoveg,''), 200))
                                       order by f.sorszam)
                        from grants.call_facet f
                       where f.call_id = c.id
                         and not exists (select 1 from grants.call_match m
                                          where m.call_id = c.id and m.facet_id = f.id)), '[]'::jsonb),
                   -- AKIKET MI VINNÉNK: a javasolt csapat.
                   'sajat_csapat', coalesce((
                      select jsonb_agg(jsonb_build_object('nev', r.nev, 'kar', r.kar,
                                                          'szerep', cm.szerep, 'arculat', cf.nev)
                                       order by (cm.szerep = 'vezeto') desc, cm.ossz desc)
                        from grants.call_team ct
                        join grants.call_team_member cm on cm.team_id = ct.id
                        join grants.researcher r on r.id = cm.researcher_id
                        left join grants.call_facet cf on cf.id = cm.facet_id
                       where ct.call_id = c.id
                         and ct.id = (select ct2.id from grants.call_team ct2
                                       where ct2.call_id = c.id
                                       order by (ct2.valtozat = 'lefedes') desc, ct2.lefedett desc
                                       limit 1)), '[]'::jsonb),
                   'felkert_db', (select count(*) from grants.invite i
                                   where i.call_id = c.id and grants.invite_valodi(i.allapot))) as sor
            from grants.call c
           where c.archivalt = false
             and c.partnerkereses = true
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido::date >= current_date)
             and (p_q is null or btrim(p_q) = '' or c.cim ilike '%' || btrim(p_q) || '%')
             and (not coalesce(p_csak_hiany, false)
                  or exists (select 1 from grants.call_facet f
                              where f.call_id = c.id
                                and not exists (select 1 from grants.call_match m
                                                 where m.call_id = c.id and m.facet_id = f.id)))
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 40), 1), 100)) t);
end $$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  f text := 'public.grants_partner_calls(text,integer,boolean)';
begin
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
end $grants$;

do $chk$
declare v_db integer;
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.grants_partner_calls(text,integer,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon lekerdezheti a konzorciumkeresest.';
  end if;
  select count(*) into v_db from grants.call c
   where c.archivalt = false and c.partnerkereses = true
     and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido::date >= current_date);
  raise notice 'Rendben: 106 — konzorciumkereses; % nyitott felhivasnal engedett a partnerkereses.', v_db;
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
