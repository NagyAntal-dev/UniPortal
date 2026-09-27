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
