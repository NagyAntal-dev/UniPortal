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
