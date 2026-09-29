-- ============================================================================
-- RUN_ALL_106.sql — Konzorcium fül: hova kell partner, és mit viszünk mi
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
