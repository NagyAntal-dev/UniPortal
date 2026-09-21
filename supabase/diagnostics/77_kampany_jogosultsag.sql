-- ============================================================================
-- 77_kampany_jogosultsag.sql — MIÉRT ÜRES A KAMPÁNY JOGOSULTSÁGI LISTÁJA?
-- ----------------------------------------------------------------------------
-- TÜNET: a kampány megnyitása ECHO_NO_ELIGIBILITY hibával elakad, vagy az
--        "Alkalmassági lista újraépítése" 0 párt ad vissza.
--
-- Az echo.eligibility_rebuild (42_campaign_editor.sql) öt feltételt szab. Ez a
-- lekérdezéssor megmutatja, MELYIKEN bukik el a kampány — és hány kurzuson.
-- Csak OLVAS, semmit nem módosít.
--
-- HASZNÁLAT: Studio → SQL Editor. Írd át a kampány azonosítóját az 1. lépésben
-- (vagy a kódját), és futtasd végig.
-- ============================================================================

-- ---------- 1. A vizsgált kampány ----------
-- Ha nem tudod az id-t, itt látod a kampányokat:
select id, code, name_hu, term, state, opens_at, closes_at, template_version_id
  from echo.campaign
 order by created_at desc
 limit 20;

-- Innentől írd be a kampány id-ját mindenhová, ahol '<KAMPANY_ID>' áll.

-- ---------- 2. A célközönség: MIT értékelnek? ----------
-- Kurzussor nélkül a kampány FÉLÉVÉNEK minden kurzusa játszik; kurzussorral
-- PONTOSAN a kijelöltek. Ha itt 0 kurzus jön ki, a rebuild eleve üres halmazon
-- dolgozik — ilyenkor a kizárási napló is üres marad, nem csak az eligibility.
select c.term                                                     as kampany_felev,
       (select count(*) from echo.campaign_audience a
         where a.campaign_id = c.id and a.kind = 'course')         as kijelolt_kurzus,
       (select count(*) from echo.campaign_audience a
         where a.campaign_id = c.id and a.kind in ('group','user')) as kijelolt_kozonseg,
       (select count(*) from echo.course k where k.term = c.term)  as kurzus_a_felevben
  from echo.campaign c
 where c.id = '<KAMPANY_ID>';

-- FIGYELEM: a 'kurzus_a_felevben' a leggyakoribb buktató. A kampány term
-- mezője szabad szöveg (41_campaign_term_free.sql), a kurzusoké szintén —
-- egyetlen elgépelés ('2025/26/1' vs '2025/26/01') nulla találatot ad.
-- A ténylegesen létező félévek:
select term, count(*) as kurzus from echo.course group by term order by term;

-- ---------- 3. A küszöbök ----------
select key, value from echo.setting where key in ('min_headcount','min_share_pct');

-- ---------- 4. Kurzusonkénti bontás: melyik feltételen bukik? ----------
-- Ugyanaz a hatókör és ugyanazok a feltételek, mint az eligibility_rebuild-ben.
with p as (select '<KAMPANY_ID>'::uuid as cid),
     k as (select c.id as cid, c.term,
                  exists (select 1 from echo.campaign_audience a
                           where a.campaign_id = c.id and a.kind = 'course') as van_kurzussor
             from echo.campaign c join p on p.cid = c.id),
     kuszob as (select (select value::integer from echo.setting where key = 'min_headcount') as fej,
                    (select value::numeric from echo.setting where key = 'min_share_pct') as arany),
     sc as (
       select co.id, co.code, co.name_hu, co.term,
              coalesce(co.letszam, (select count(*) from echo.enrollment e
                                     where e.course_id = co.id and e.status = 'active'), 0) as letszam,
              co.van_orarendi_info, co.vizsgakurzus,
              (select count(*) from echo.course_teacher ct where ct.course_id = co.id) as oktato_db,
              (select count(*) from echo.course_teacher ct, kuszob
                where ct.course_id = co.id and ct.share_pct >= kuszob.arany)              as eleg_aranyu_oktato
         from echo.course co, k
        where (k.van_kurzussor
               and co.id in (select a.course_id from echo.campaign_audience a
                              where a.campaign_id = k.cid and a.kind = 'course'))
           or (not k.van_kurzussor and co.term = k.term))
select sc.code, sc.name_hu, sc.letszam, sc.van_orarendi_info, sc.vizsgakurzus,
       sc.oktato_db, sc.eleg_aranyu_oktato,
       case
         when sc.letszam < kuszob.fej            then 'KIZÁRVA: LETSZAM_ALATT'
         when not sc.van_orarendi_info        then 'KIZÁRVA: NINCS_ORARENDI_INFO'
         when sc.vizsgakurzus                 then 'KIZÁRVA: VIZSGAKURZUS'
         when sc.oktato_db = 0                then 'KIZÁRVA: NINCS_OKTATO'
         when sc.eleg_aranyu_oktato = 0       then 'KIZÁRVA: minden oktató OKTATOI_ARANY_ALATT'
         else                                      'MEGFELEL — ' || sc.eleg_aranyu_oktato || ' oktatóval'
       end as eredmeny
  from sc, kuszob
 order by eredmeny, sc.code;

-- ---------- 5. Összesítő: hány kurzus felel meg? ----------
-- Ha ez 0, a kampány nem nyitható meg. A 4. lépés 'eredmeny' oszlopa mondja meg,
-- mit kell javítani: létszámot, órarendi jelzőt, oktatói hozzárendelést vagy
-- óraarányt — vagy a küszöböt (echo.setting).

-- ---------- 6. A legutóbbi újraépítés kizárási naplója ----------
-- Akkor van benne sor, ha a rebuild lefutott. Üres napló + üres eligibility
-- együtt azt jelenti, hogy a 2. lépés hatóköre volt üres.
select rule_code, count(*) as db
  from echo.exclusion_log
 where campaign_id = '<KAMPANY_ID>'
 group by rule_code
 order by db desc;

-- ---------- 7. KI értékel: a célközönség profiljai ----------
-- Csoport/felhasználó sorral szűkített kampánynál a participation csak ezekre
-- a profilokra épül. Ha itt 0 jön ki ÉS van 'group'/'user' sor, akkor a
-- kampányt senki nem kapja meg — az eligibility ettől még felépülhet.
select count(*) as celkozonseg_profil
  from echo.audience_profiles('<KAMPANY_ID>'::uuid) as t(profile_id);
