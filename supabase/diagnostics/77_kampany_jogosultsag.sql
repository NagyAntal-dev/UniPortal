-- ============================================================================
-- 77_kampany_jogosultsag.sql — MIÉRT ÜRES A KAMPÁNY JOGOSULTSÁGI LISTÁJA?
-- ----------------------------------------------------------------------------
-- TÜNET: a kampány megnyitása ECHO_NO_ELIGIBILITY hibával elakad, vagy az
--        "alkalmassági lista újraépítése" 0 párt ad vissza.
--
-- Az echo.eligibility_rebuild (42_campaign_editor.sql) öt feltételt szab. Ez a
-- lekérdezéssor megmutatja, MELYIKEN bukik el a kampány — és hány kurzuson.
-- Csak OLVAS, semmit nem módosít.
--
-- FUTTATÁS a szerveren (a legutóbb létrehozott kampányra):
--   docker compose run --rm --entrypoint psql migrate \
--     -f /uniportal/migrations/diagnostics/77_kampany_jogosultsag.sql
--
-- Egy KONKRÉT kampányra (a -v kapcsoló a psql-é, az -f elé kell):
--   docker compose run --rm --entrypoint psql migrate \
--     -v kampany=6f1d…-… \
--     -f /uniportal/migrations/diagnostics/77_kampany_jogosultsag.sql
--
-- Studio → SQL Editorban a :'kampany' helyére írd be idézőjelben a kampány
-- azonosítóját, a \if blokkot pedig hagyd ki.
-- ============================================================================

-- Kampányazonosító nélkül a legutóbb létrehozott kampányt vizsgáljuk.
\if :{?kampany}
\else
  \set kampany ''
\endif

-- A vizsgált kampány egyetlen helyen dől el; a többi lekérdezés erre hivatkozik.
create temporary view _vizsgalt as
select c.*
  from echo.campaign c
 where c.id = coalesce(nullif(:'kampany', '')::uuid,
                       (select id from echo.campaign order by created_at desc limit 1));

\echo '--- 1. A vizsgált kampány ---'
select id, code, name_hu, term, state, opens_at, closes_at, template_version_id
  from _vizsgalt;

\echo '--- 2. A hatókör: MIT értékelnek? ---'
-- Kurzussor nélkül a kampány FÉLÉVÉNEK minden kurzusa játszik; kurzussorral
-- PONTOSAN a kijelöltek. Ha a kurzus_a_felevben 0, a rebuild eleve üres
-- halmazon dolgozik — ilyenkor a kizárási napló (6.) is üres marad.
select c.term                                                      as kampany_felev,
       (select count(*) from echo.campaign_audience a
         where a.campaign_id = c.id and a.kind = 'course')          as kijelolt_kurzus,
       (select count(*) from echo.campaign_audience a
         where a.campaign_id = c.id and a.kind in ('group','user')) as kijelolt_kozonseg,
       (select count(*) from echo.course k where k.term = c.term)   as kurzus_a_felevben
  from _vizsgalt c;

\echo '--- 2b. A ténylegesen létező félévek (elgépelés-ellenőrzés) ---'
-- A kampány term mezője szabad szöveg (41_campaign_term_free.sql), a kurzusoké
-- szintén: '2025/26/1' és '2025/26/01' két különböző félév.
select term, count(*) as kurzus from echo.course group by term order by term;

\echo '--- 3. A küszöbök ---'
select key, value from echo.setting where key in ('min_headcount','min_share_pct');

\echo '--- 4. Kurzusonkénti bontás: melyik feltételen bukik? ---'
-- Ugyanaz a hatókör és ugyanazok a feltételek, mint az eligibility_rebuild-ben.
with k as (select c.id as cid, c.term,
                  exists (select 1 from echo.campaign_audience a
                           where a.campaign_id = c.id and a.kind = 'course') as van_kurzussor
             from _vizsgalt c),
     kuszob as (select (select value::integer from echo.setting where key = 'min_headcount') as fej,
                       (select value::numeric from echo.setting where key = 'min_share_pct') as arany),
     sc as (
       select co.id, co.code, co.name_hu,
              coalesce(co.letszam, (select count(*) from echo.enrollment e
                                     where e.course_id = co.id and e.status = 'active'), 0) as letszam,
              co.van_orarendi_info, co.vizsgakurzus,
              (select count(*) from echo.course_teacher ct where ct.course_id = co.id) as oktato_db,
              (select count(*) from echo.course_teacher ct, kuszob
                where ct.course_id = co.id and ct.share_pct >= kuszob.arany)           as eleg_aranyu_oktato
         from echo.course co, k
        where (k.van_kurzussor
               and co.id in (select a.course_id from echo.campaign_audience a
                              where a.campaign_id = k.cid and a.kind = 'course'))
           or (not k.van_kurzussor and co.term = k.term))
select sc.code, sc.name_hu, sc.letszam, sc.van_orarendi_info as orarend,
       sc.vizsgakurzus, sc.oktato_db, sc.eleg_aranyu_oktato,
       case
         when sc.letszam < kuszob.fej      then 'KIZARVA: LETSZAM_ALATT'
         when not sc.van_orarendi_info     then 'KIZARVA: NINCS_ORARENDI_INFO'
         when sc.vizsgakurzus              then 'KIZARVA: VIZSGAKURZUS'
         when sc.oktato_db = 0             then 'KIZARVA: NINCS_OKTATO'
         when sc.eleg_aranyu_oktato = 0    then 'KIZARVA: minden oktato OKTATOI_ARANY_ALATT'
         else 'MEGFELEL — ' || sc.eleg_aranyu_oktato || ' oktatoval'
       end as eredmeny
  from sc, kuszob
 order by eredmeny, sc.code;

\echo '--- 5. Osszesito: hany kurzus felel meg? ---'
-- Ha a megfelelo_kurzus 0, a kampany nem nyithato meg. A 4. lepes eredmeny
-- oszlopa mondja meg, mit kell javitani: letszamot, orarendi jelzot, oktatoi
-- hozzarendelest vagy oraaranyt — vagy a kuszobot (echo.setting).
with k as (select c.id as cid, c.term,
                  exists (select 1 from echo.campaign_audience a
                           where a.campaign_id = c.id and a.kind = 'course') as van_kurzussor
             from _vizsgalt c),
     kuszob as (select (select value::integer from echo.setting where key = 'min_headcount') as fej,
                       (select value::numeric from echo.setting where key = 'min_share_pct') as arany)
select count(*) filter (
         where coalesce(co.letszam, (select count(*) from echo.enrollment e
                                      where e.course_id = co.id and e.status = 'active'), 0) >= kuszob.fej
           and co.van_orarendi_info
           and not co.vizsgakurzus
           and exists (select 1 from echo.course_teacher ct
                        where ct.course_id = co.id and ct.share_pct >= kuszob.arany)) as megfelelo_kurzus,
       count(*) as hatokorben_levo_kurzus
  from echo.course co, k, kuszob
 where (k.van_kurzussor
        and co.id in (select a.course_id from echo.campaign_audience a
                       where a.campaign_id = k.cid and a.kind = 'course'))
    or (not k.van_kurzussor and co.term = k.term);

\echo '--- 6. A legutobbi ujraepites kizarasi naploja ---'
-- Akkor van benne sor, ha a rebuild mar lefutott. Ures naplo + ures eligibility
-- egyutt azt jelenti, hogy a 2. lepes hatokore volt ures.
select x.rule_code, count(*) as db
  from echo.exclusion_log x, _vizsgalt c
 where x.campaign_id = c.id
 group by x.rule_code
 order by db desc;

\echo '--- 7. A felepult jogosultsagi lista ---'
select (select count(*) from echo.eligibility e, _vizsgalt c
         where e.campaign_id = c.id)                      as jogosultsagi_par,
       (select count(*) from echo.audience_profiles((select id from _vizsgalt))
          as t(profile_id))                               as celkozonseg_profil;
