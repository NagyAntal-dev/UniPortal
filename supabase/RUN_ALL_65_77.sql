-- ============================================================================
-- RUN_ALL_65_77.sql — MINDEN, amit még le kell futtatni (2026-09-23)
-- ============================================================================
-- Egyetlen fájl, a helyes sorrendben. Elég egyszer lefuttatni a Supabase SQL
-- Editorban. Újrafuttatható: minden benne lévő migráció idempotens
-- ("create or replace", "if not exists", "on conflict do nothing").
--
-- MI VAN BENNE, ÉS MIÉRT ÉPP EZ
--   65_echo_results_questions.sql  — az ECHO eredménynézetben csak a
--        tényleges kérdések szerepeljenek (a célmeghatározó és a kihagyás-
--        kérdés kizárása). Kizárólag függvény-újradefiníciók: ha már fent van,
--        a futás nem változtat semmit. Élesben nem volt megállapítható, hogy
--        fut-e már, ezért a biztos út a beletétel.
--   76_echo_exclusion_config.sql   — kampányonkénti kizárási szabályok
--        (alapbeállítás / egyedi / "senkit nem zárunk ki") + a kizárt
--        kurzusok, oktatói párok és az értékelés nélkül maradó oktatók
--        listája. MÉRVE: még nincs fent.
--   77_grants_core.sql             — pályázati modul 1. fázisa: grants séma,
--        forrásregiszter, felhívás-katalógus, változásnapló, ETL-napló,
--        beállítások (ai_provider: gemini | anthropic | nincs).
--        MÉRVE: még nincs fent.
--   21_echo_harden_submit.sql      — a szokásos zárás: a beküldés
--        megszigorítása. MINDIG ez fut utolsóként, mert a korábbi ECHO-fájlok
--        grant-blokkjai visszavonhatják a jogokat.
--
-- AMI SZÁNDÉKOSAN NINCS BENNE (2026-09-23-án élesben mérve, jogosultsági
-- próbával — a próba nem futtat semmit, csak a függvény létezését kérdezi):
--   • 64_letter_pdf_message.sql — MÁR FENT VAN (a letter_log_send négy
--     paraméteres, p_file-t is fogadó változata válaszol)
--   • 66_interview_scoring.sql  — MÁR FENT VAN (az interview_evaluation_list
--     nézet létezik)
--   • 05_features.sql és a többi korai migráció — a táblái élnek (hírfolyam,
--     képzések), újrafuttatásuk értelmetlen zaj lenne
--
-- FUTTATÁS UTÁN, amit érdemes ellenőrizni a felületen:
--   • ECHO kampányok → egy PISZKOZAT kampány → Szerkesztés: megjelenik a
--     "Kizárási szabályok" blokk a három módddal
--   • ECHO kampányok → kiválasztott kampány → "Kizárt kurzusok és oktatók"
--   • A pályázati modulnak még NINCS felülete (a következő körben készül);
--     a 77-es most az adatbázis-oldalt teszi le. Az ellenőrzés itt annyi,
--     hogy a futás végén a "Rendben: 77 ..." üzenetet látod.
--
-- A FUTÁS VÉGÉN EZEKET AZ ÜZENETEKET KELL LÁTNOD:
--   NOTICE: Rendben: 76 — kampanyonkenti kizarasi szabalyok ...
--   NOTICE: Rendben: 77 — grants sema, 6 forras a regiszterben ...
--   (a 65 és a 21 csendes, ha minden rendben)
--
-- JAVÍTÁS (2026-09-23, az első futtatási kísérlet után): a 77-es fájl
-- grant-blokkja eredetileg csak a public és az anon szerepkörtől vonta vissza a
-- jogokat. A Supabase viszont az új public sémás függvényekre az
-- authenticated-nek is ad alapértelmezett jogot, ezért a service_role-nak szánt
-- ETL-függvényeket bejelentkezett felhasználó is hívhatta volna — a 77-es saját
-- önellenőrzése ezt élesben elkapta, és a teljes szkript visszaforgott (mérve:
-- utána sem a 76-os, sem a 77-es függvényei nem léteztek). A javított változat
-- az authenticated-től is visszavon, és ezt egy Supabase-szerű
-- alapjogosultságokkal felállított próbaadatbázison ellenőriztük.
-- ============================================================================


-- ############################################################################
-- ### 65_echo_results_questions.sql
-- ############################################################################

-- ============================================================================
-- 65_echo_results_questions.sql — az eredményben CSAK a ténylegesen feltett
-- kérdések szerepeljenek
--
-- A TÜNET
--   Az Oktatói eredmények felületen sok kérdésnél nem látszott válasz, pedig a
--   kampányt a hallgatók nagy része kitöltötte. Egy részük a k-küszöbök
--   szándékos elrejtése (az oktatói nézetben k_numeric / k_dist / k_text),
--   egy részük viszont HIBA volt: olyan kérdések is megjelentek, amelyekre a
--   névtelen válaszsorban NEM LEHET válasz.
--
-- A HIBÁK (a kódból és helyi replikán mérve)
--   1. A célmeghatározó (part1) kérdései. A 24_echo_form_v3.sql kizárta őket az
--      echo.results_build()-ből, de az 56_admin_results_control.sql a függvényt
--      a 20-as szövegéből generálta újra, így a kizárás visszaveszett. A
--      manifest szerint az 56 fut később, tehát ÉLESBEN a hibás változat áll.
--   2. A kihagyás-kérdés (teacher_skip_p, type 'skip') az oktatói bontásban.
--      Az echo_submit() a kihagyást a skipped / skip_reason mezőpárba írja, a
--      kérdés id-je soha nem kerül az answers-be — a kérdés mindig n=0.
--   3. A nyers (admin) nézet MINDEN szakasz minden kérdését listázta: a
--      kurzusszintű nézetben az oktatói kérdéseket és a part1 kérdéseket is,
--      mind "0 válasz"-szal.
--
-- MIT VÁLTOZTAT
--   • echo.results_build(): az 56-os szöveg + a part1 és a 'skip' kizárása +
--     adminnak az eltérő kérdőívverzióval beküldött sorok száma (eltero_verzio).
--   • public.echo_results_raw(): az 57-es szöveg + csak a hatókör kérdései, a
--     part1 nélkül; a kihagyás-kérdésnél a kihagyások okai; eltero_verzio.
--   A küszöbök, az óralátogatás-szűrés és minden más BETŰRE változatlan.
--
-- FIGYELEM — a 20, a 24 és az 56 EZUTÁN NEM FUTHAT ÚJRA: bármelyik csendben
-- visszavenné ezt a javítást. Ha mégis kell, utána futtasd ezt is.
--
-- FÜGGŐSÉG: 56_admin_results_control.sql, 57_raw_attendance.sql
-- IDEMPOTENS: create or replace. Utána futtasd újra a 21_echo_harden_submit.sql-t.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Az eredményépítő
-- ------------------------------------------------------------
create or replace function echo.results_build(
  p_campaign uuid, p_course uuid, p_teacher uuid, p_scope text, p_admin boolean)
returns jsonb
language plpgsql volatile
set search_path = echo, public, extensions, pg_temp
as $$
declare
  v_c        echo.campaign%rowtype;
  v_compiled jsonb;
  v_fo   uuid[];
  v_lo   uuid[];
  v_kn   int := echo.k('k_numeric');
  v_kt   int := echo.k('k_text');
  v_klow int := echo.k('k_low');
  q      jsonb;
  v_qid  text;
  v_vals jsonb;
  v_one  jsonb;
  v_txt  jsonb;
  v_txtn int;
  v_fo_q   jsonb := '[]'::jsonb;
  v_lo_q   jsonb := '[]'::jsonb;
  v_jog  int;
  v_pend int := 0;
  v_out  jsonb;
  v_elter int := 0;   -- 65: más kérdőívverzióval beküldött válaszsorok (csak adminnak)
begin
  select * into v_c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  select compiled into v_compiled from echo.template_version where id = v_c.template_version_id;
  if v_compiled is null then raise exception 'ECHO_TEMPLATE_MISSING'; end if;

  -- A válaszhalmaz kettéosztása. A NULL attendance_band a FŐ halmazba megy:
  -- a hiányzó adatból nem következtetünk alacsony óralátogatásra.
  if p_scope = 'teacher' then
    select coalesce(array_agg(r.id), '{}') into v_fo
      from echo.response r
     where r.campaign_id = p_campaign and r.course_id = p_course
       and r.scope = 'teacher' and r.teacher_id = p_teacher;
    v_lo := '{}';
  else
    /* A KETTÉOSZTÁST MOSTANTÓL A KAMPÁNY BEÁLLÍTÁSA VEZÉRLI.
       Alapértelmezés (false) = a 28/2023. 3. § (9) szerinti viselkedés: a 33%
       alatti óralátogatást valló hallgató válasza külön, tájékoztató blokkba
       kerül. Ha az adminisztrátor úgy ítéli, hogy ezen a mérésen ezek is
       relevánsak, egy kapcsolóval a fő halmazba teszi őket — a döntés az övé,
       és a kampányon rögzül, tehát utólag látszik, mi alapján készült az
       eredmény. */
    if coalesce(v_c.low_attendance_included, false) then
      select coalesce(array_agg(r.id), '{}'), '{}'::uuid[]
        into v_fo, v_lo
        from echo.response r
       where r.campaign_id = p_campaign and r.course_id = p_course and r.scope = 'course';
    else
      select coalesce(array_agg(r.id) filter (where not echo.attendance_low(r.attendance_band)), '{}'),
             coalesce(array_agg(r.id) filter (where     echo.attendance_low(r.attendance_band)), '{}')
        into v_fo, v_lo
        from echo.response r
       where r.campaign_id = p_campaign and r.course_id = p_course and r.scope = 'course';
    end if;
  end if;

  select count(*) into v_jog
    from echo.participation p
   where p.campaign_id = p_campaign and p.course_id = p_course and p.eligible;

  -- 65: a kérdéslista a kampány MOSTANI kérdőívverziójából jön. Ha a kampány
  -- kérdőívét a válaszok beérkezése után cserélték, a korábbi válaszsorok más
  -- kérdés-azonosítókat hordozhatnak — ezeket a riport nem tudja kérdéshez
  -- kötni. A számukat az adminisztrátor megkapja, hogy ez ne maradjon rejtve.
  select count(*) into v_elter
    from echo.response r
   where r.campaign_id = p_campaign and r.course_id = p_course
     and r.scope = case when p_scope = 'teacher' then 'teacher' else 'course' end
     and (p_scope <> 'teacher' or r.teacher_id = p_teacher)
     and r.template_version_id is distinct from v_c.template_version_id;

  -- GLOBÁLIS KÜSZÖB: ha a teljes halmaz k_numeric alatt van, a riport
  -- egészben elrejtődik. Kérdésenkénti kiértékelésre el sem jutunk — így
  -- még a "mely kérdésre hányan válaszoltak" mintázat sem szivárog ki.
  if coalesce(array_length(v_fo,1),0) < v_kn then
    return jsonb_build_object(
      'campaign_id', p_campaign, 'course_id', p_course, 'teacher_id', p_teacher,
      'scope', p_scope,
      'kuszobok', jsonb_build_object('k_numeric', v_kn, 'k_dist', echo.k('k_dist'),
                                     'k_text', v_kt, 'k_slice', echo.k('k_slice'),
                                     'k_low', v_klow,
                                     'attendance_min_pct', echo.k('attendance_min_pct')),
      'valaszadas', jsonb_build_object('jogosult', v_jog,
                                       'valaszok', coalesce(array_length(v_fo,1),0),
                                       'arany', null),
      'rejtve', true, 'rejtes_oka', 'keves_valasz',
      'uzenet', 'Keves valasz (' || coalesce(array_length(v_fo,1),0) || ' < k_numeric=' || v_kn ||
                '): ez a bontas nem jelenitheto meg.',
      'kerdesek', '[]'::jsonb,
      -- AZ 'n' ITT NULL. Mert ha a blokk rejtve van, akkor a k_low alatti
      -- ELEMSZAM MAGA a kozles: merve, 10 fos fo halmaz mellett 1 alacsony
      -- oralatogatasu valasznal a regi valtozat {"n":1,"rejtve":true}-t adott,
      -- vagyis a megtekinto pontosan megtudta, hogy egy ember vallott be 33%
      -- alatti oralatogatast. Egy k_low alatti, erzekeny attributumra vonatkozo
      -- PONTOS darabszam — pont az, amit a k_low tiltana.
      'alacsony_oralatogatas', jsonb_build_object('n', null, 'k_low', v_klow,
                                                  'rejtve', true, 'kerdesek', '[]'::jsonb))
      || case when p_admin then jsonb_build_object('eltero_verzio', v_elter) else '{}'::jsonb end;
  end if;

  -- Kérdésenkénti kiértékelés
  --
  -- AZ 'attendance' KÉRDÉS KIMARAD — ÉS EZ NEM ADATVESZTÉS, HANEM HIBAJAVÍTÁS.
  -- MÉRT PROBLÉMA (13 valódi beküldésen): az óralátogatás a jegyzőkönyvben
  -- MINDIG n=0-val és "Keves valasz (0 < k_numeric=5)" üzenettel jelent meg,
  -- pedig mind a 13 válaszadó kitöltötte. Az ok szerkezeti: az echo_submit()
  -- az óralátogatást a payload GYÖKERÉBŐL a KÜLÖN echo.response.attendance_band
  -- OSZLOPBA teszi (15_echo_core.sql, 5. lépés), az answers-be soha nem kerül
  -- bele — ez a ciklus viszont az r.answers -> v_qid kifejezéssel keresi.
  -- Vagyis a keresés helye és a tárolás helye sosem esett egybe.
  -- Az adat nem veszett el: az óralátogatás a 3. § (9) szerinti FŐ/ALACSONY
  -- kettéosztást vezérli (lásd fent, echo.attendance_low), és az
  -- 'alacsony_oralatogatas' blokk közli, amennyit a k_low enged. A hamis
  -- "kevés válasz" sor viszont félrevezette a jegyzőkönyv olvasóját, ezért
  -- itt kihagyjuk a kérdéslistából.
  -- MIÉRT ID SZERINT ÉS NEM TÍPUS SZERINT: a 18b seed a prototípus
  -- type:'attendance' mezőjét 'single'-re fordítja (a renderelő öt típust
  -- ismer), tehát típusra szűrni nem lehet — mérve.
  -- HA VALAHA KELL AZ ELOSZLÁS: azt az attendance_band OSZLOPBÓL kell
  -- aggregálni (echo.suppress_cells-lel, k_dist küszöbbel), nem az answers-ből.
  for q in
    select qq.value
      from jsonb_array_elements(echo.jarr(v_compiled->'sections')) s
      cross join jsonb_array_elements(echo.jarr(s.value->'questions')) qq
     where case when p_scope = 'teacher'
                then coalesce(qq.value->>'repeat','') = 'teacher'
                else coalesce(qq.value->>'repeat','') <> 'teacher' end
       and coalesce(qq.value->>'id','') <> 'attendance'
       -- 65: a célmeghatározó (part1) szakasz kérdései a félév elején, azonosítva,
       -- az echo.student_goal sorba válaszolódnak — a névtelen echo.response-ba
       -- SOHA nem kerülnek. A 24_echo_form_v3.sql ezt már kizárta, de az 56-os
       -- migráció a 20-as szövegből generálta újra a függvényt, és a kizárás
       -- elveszett: a két bevezető kérdés n=0-val, "Keves valasz" üzenettel
       -- jelent meg minden kurzus eredményében.
       and coalesce(s.value->>'part', 'part2') <> 'part1'
       -- 65: a kihagyás-kérdés (type 'skip') NEM válasz, hanem a skipped /
       -- skip_reason mezőpár forrása (echo_submit, 6. lépés; ECHO_buildPayload).
       -- A kérdés id-je az answers-be sosem kerül be, ezért az oktatói bontásban
       -- mindig n=0-val, elrejtve jelent meg.
       and coalesce(qq.value->>'type','') <> 'skip'
  loop
    v_qid := q->>'id';

    -- FŐ halmaz
    select coalesce(jsonb_agg(r.answers -> v_qid), '[]'::jsonb) into v_vals
      from echo.response r
     where r.id = any(v_fo)
       and jsonb_exists(r.answers, v_qid)
       and jsonb_typeof(r.answers -> v_qid) <> 'null';
    v_one := echo.agg_one(q, v_vals);

    -- Szöveges kérdés: CSAK moderált ÉS érvényes válaszokból, k_text fölött.
    if coalesce(q->>'type','') in ('longtext','text','long') then
      select count(*), coalesce(jsonb_agg(r.answers ->> v_qid order by md5(r.id::text)), '[]'::jsonb)
        into v_txtn, v_txt
        from echo.response r
        join echo.moderation m on m.response_id = r.id and m.question_id = v_qid
       where r.id = any(v_fo) and m.allapot = 'valid';

      if v_txtn < v_kt then
        v_one := v_one || jsonb_build_object(
          'szovegek', null, 'szoveg_db', v_txtn, 'szoveg_rejtve', true,
          'szoveg_oka', 'keves_ervenyes_szoveg',
          'szoveg_uzenet', 'Moderalt, ervenyes szoveges valasz: ' || v_txtn ||
                           ' < k_text=' || v_kt || '. Egyetlen szoveg sem jelenitheto meg.');
      else
        v_one := v_one || jsonb_build_object(
          'szovegek', v_txt, 'szoveg_db', v_txtn, 'szoveg_rejtve', false, 'szoveg_oka', null);
      end if;

      -- A moderálásra váró darabszám CSAK adminnak megy vissza: az oktatónak
      -- ebbol arra lehetne kovetkeztetni, hany szoveg van meg "fuggoben" rola.
      if p_admin then
        select count(*) into v_pend
          from echo.moderation m
         where m.response_id = any(v_fo) and m.question_id = v_qid and m.allapot = 'pending';
        v_one := v_one || jsonb_build_object('moderalatlan', v_pend);
      end if;
    end if;

    v_fo_q := v_fo_q || jsonb_build_array(v_one);

    -- ALACSONY ÓRALÁTOGATÁSÚ BLOKK — saját küszöbbel (k_low), és a fő
    -- statisztikába NEM számít bele (3. § (9)). Szöveget innen SOHA nem
    -- adunk vissza: a halmaz eleve kicsi, egy szöveg itt azonosítana.
    if coalesce(array_length(v_lo,1),0) >= v_klow then
      select coalesce(jsonb_agg(r.answers -> v_qid), '[]'::jsonb) into v_vals
        from echo.response r
       where r.id = any(v_lo)
         and jsonb_exists(r.answers, v_qid)
         and jsonb_typeof(r.answers -> v_qid) <> 'null';
      v_lo_q := v_lo_q || jsonb_build_array(
        echo.agg_one(q, v_vals) || jsonb_build_object('szovegek', null, 'szoveg_rejtve', true));
    end if;
  end loop;

  v_out := jsonb_build_object(
    'campaign_id',   p_campaign,
    'campaign_code', v_c.code,
    'campaign_state',v_c.state,
    'course_id',     p_course,
    'course_name',   (select name_hu from echo.course where id = p_course),
    'teacher_id',    p_teacher,
    'teacher_name',  (select name from echo.teacher where id = p_teacher),
    'scope',         p_scope,
    'kuszobok', jsonb_build_object('k_numeric', v_kn, 'k_dist', echo.k('k_dist'),
                                   'k_text', v_kt, 'k_slice', echo.k('k_slice'),
                                   'k_low', v_klow,
                                   'attendance_min_pct', echo.k('attendance_min_pct')),
    'valaszadas', jsonb_build_object(
      'jogosult', v_jog,
      'valaszok', coalesce(array_length(v_fo,1),0),
      'arany',    round(coalesce(array_length(v_fo,1),0)::numeric / nullif(v_jog,0) * 100, 1)),
    'rejtve', false,
    'kerdesek', v_fo_q,
    'alacsony_oralatogatas', jsonb_build_object(
      -- Ugyanaz a javitas: az elemszam CSAK akkor megy vissza, ha a blokk
      -- egyaltalan megjelenik (n >= k_low). Alatta null, nem 0 es nem a
      -- valodi szam — kulonben a k_low semmit nem vedene.
      'n', case when coalesce(array_length(v_lo,1),0) >= v_klow
                then coalesce(array_length(v_lo,1),0) else null end,
      'k_low', v_klow,
      'rejtve', coalesce(array_length(v_lo,1),0) < v_klow,
      'kerdesek', v_lo_q,
      'megjegyzes', case
        when p_scope = 'teacher'
          then 'Oktatoi bontasban ez a blokk MINDIG ures: az oralatogatasi sav kizarolag '
               'a kurzusszintu valaszsoron all, es a kurzusszintu meg az oktatoi sor kozott '
               'szandekosan nincs kozos kulcs (15_echo_core.sql, 6.2). Lasd a fajl fejlecet.'
        else '3. § (9): ezek a valaszok NEM szamitanak a jegyzokonyvi statisztikaba. '
             'Szoveges valasz innen soha nem kerul vissza.' end));

  if p_admin then v_out := v_out || jsonb_build_object('eltero_verzio', v_elter); end if;
  return v_out;
end $$;


-- ------------------------------------------------------------
-- 2. A nyers, szűretlen admin nézet
-- ------------------------------------------------------------
create or replace function public.echo_results_raw(
  p_campaign uuid,
  p_course   uuid,
  p_scope    text default 'course',
  p_teacher  uuid default null
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $fn$
declare
  v_c        echo.campaign%rowtype;
  v_compiled jsonb;
  v_ids      uuid[];
  v_n_lo     int;
  v_jog      int;
  v_q        jsonb := '[]'::jsonb;
  v_sec      jsonb;
  v_qq       jsonb;
  v_qid      text;
  v_vals     jsonb;
  v_txt      jsonb;
  v_elter    int := 0;   -- 65: más kérdőívverzióval beküldött válaszsorok
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then
    raise exception 'ECHO_FORBIDDEN: a nyers nezet kizarolag rendszergazdanak jar.';
  end if;
  if p_scope not in ('course', 'teacher') then
    raise exception 'ECHO_BAD_INPUT: a hatokor csak "course" vagy "teacher" lehet.';
  end if;

  select * into v_c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  select compiled into v_compiled from echo.template_version where id = v_c.template_version_id;
  if v_compiled is null then raise exception 'ECHO_TEMPLATE_MISSING'; end if;

  -- MINDEN valasz, szures nelkul.
  if p_scope = 'teacher' then
    select coalesce(array_agg(r.id), '{}') into v_ids
      from echo.response r
     where r.campaign_id = p_campaign and r.course_id = p_course
       and r.scope = 'teacher' and (p_teacher is null or r.teacher_id = p_teacher);
  else
    select coalesce(array_agg(r.id), '{}') into v_ids
      from echo.response r
     where r.campaign_id = p_campaign and r.course_id = p_course and r.scope = 'course';
  end if;

  select count(*) into v_n_lo
    from echo.response r
   where r.id = any(v_ids) and echo.attendance_low(r.attendance_band);

  select count(*) into v_jog
    from echo.participation p
   where p.campaign_id = p_campaign and p.course_id = p_course and p.eligible;

  -- 65: a kampány mostani kérdőívverziójától eltérő verzióval beküldött sorok.
  select count(*) into v_elter
    from echo.response r
   where r.id = any(v_ids) and r.template_version_id is distinct from v_c.template_version_id;

  for v_sec in select * from jsonb_array_elements(v_compiled->'sections') loop
    -- 65: a célmeghatározó (part1) kérdéseire a névtelen válaszsorban nincs válasz.
    continue when coalesce(v_sec->>'part', 'part2') = 'part1';
    for v_qq in select * from jsonb_array_elements(coalesce(v_sec->'questions', '[]'::jsonb)) loop
      v_qid := v_qq->>'id';
      -- 65: CSAK A HATÓKÖR KÉRDÉSEI. A kurzusszintű sor oktatói (repeat:'teacher')
      -- kérdést nem tartalmaz, az oktatói sor pedig kurzusszintűt — eddig
      -- mindkettő "0 válasz"-ként szerepelt a másik nézetben.
      continue when (p_scope = 'teacher') <> (coalesce(v_qq->>'repeat','') = 'teacher');

      if v_qid = 'attendance' then
        /* AZ ÓRALÁTOGATÁS KÜLÖN OSZLOPBAN ÁLL, nem az answers-ben: az
           echo_submit() a payload gyökeréből veszi ki, mert ezen áll a
           3. § (9) szerinti kettéosztás. Ha innen olvasnánk az answers-t,
           „0 válasz" jönne ki — pedig mindenki válaszolt rá. */
        select coalesce(jsonb_agg(to_jsonb(r.attendance_band) order by r.attendance_band), '[]'::jsonb)
          into v_vals
          from echo.response r
         where r.id = any(v_ids) and r.attendance_band is not null;
      elsif coalesce(v_qq->>'type','') = 'skip' then
        /* 65: A KIHAGYÁS nem a kérdés id-jén áll az answers-ben, hanem a skipped /
           skip_reason mezőpárban (echo_submit, 6. lépés). Az értékek a kihagyás okai. */
        select coalesce(jsonb_agg(r.answers -> 'skip_reason' order by (r.answers ->> 'skip_reason')), '[]'::jsonb)
          into v_vals
          from echo.response r
         where r.id = any(v_ids) and coalesce(r.answers ->> 'skipped', 'false') = 'true';
      else
        select coalesce(jsonb_agg(x.val order by x.val::text), '[]'::jsonb) into v_vals
          from (select r.answers -> v_qid as val
                  from echo.response r
                 where r.id = any(v_ids) and r.answers ? v_qid) x;
      end if;

      if coalesce(v_qq->>'type','') in ('text', 'longtext') then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'szoveg',  r.answers -> v_qid,
                 'allapot', coalesce(m.allapot, 'nincs_moderalva'),
                 'indok',   m.indok,
                 'alacsony_oralatogatas', echo.attendance_low(r.attendance_band))), '[]'::jsonb)
          into v_txt
          from echo.response r
          left join echo.moderation m
                 on m.response_id = r.id and m.question_id = v_qid
         where r.id = any(v_ids) and r.answers ? v_qid;
      else
        v_txt := '[]'::jsonb;
      end if;

      v_q := v_q || jsonb_build_array(jsonb_build_object(
        'id',       v_qid,
        'hu',       v_qq->>'hu',
        'en',       v_qq->>'en',
        'type',     v_qq->>'type',
        'szakasz',  v_sec->>'hu',
        'ertekek',  v_vals,
        'valasz_db', jsonb_array_length(v_vals),
        'szovegek', v_txt));
    end loop;
  end loop;

  perform echo.log_access('echo_results_raw', p_campaign, p_course, p_teacher, p_scope);

  return jsonb_build_object(
    'nyers',        true,
    'scope',        p_scope,
    'campaign_id',  p_campaign,
    'course_id',    p_course,
    'teacher_id',   p_teacher,
    'campaign_state', v_c.state,
    'low_attendance_included', v_c.low_attendance_included,
    'eltero_verzio', v_elter,
    'valaszadas',   jsonb_build_object(
                      'valaszok',  coalesce(array_length(v_ids, 1), 0),
                      'alacsony',  v_n_lo,
                      'jogosult',  v_jog,
                      'arany',     case when v_jog > 0
                                        then round(100.0 * coalesce(array_length(v_ids,1),0) / v_jog, 1)
                                        else null end),
    'kerdesek',     v_q);
end $fn$;

revoke all on function public.echo_results_raw(uuid,uuid,text,uuid) from public;
revoke all on function public.echo_results_raw(uuid,uuid,text,uuid) from anon;
grant execute on function public.echo_results_raw(uuid,uuid,text,uuid) to authenticated;

do $blk$
declare v_src text;
begin
  if has_function_privilege('anon', 'public.echo_results_raw(uuid,uuid,text,uuid)'::regprocedure, 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon is hivhatja a nyers nezetet.';
  end if;
  select prosrc into v_src from pg_proc
   where oid = 'echo.results_build(uuid,uuid,uuid,text,boolean)'::regprocedure;
  if v_src not like '%<> ''part1''%' or v_src not like '%<> ''skip''%' then
    raise exception '65: az echo.results_build nem tartalmazza a part1 / skip kizarast.';
  end if;
  raise notice '65: rendben — az eredmenyben csak a tenylegesen feltett kerdesek szerepelnek.';
end $blk$;


-- ############################################################################
-- ### 76_echo_exclusion_config.sql
-- ############################################################################

-- ============================================================
-- 76_echo_exclusion_config.sql — kampányonkénti kizárási szabályok
-- ============================================================
-- MIT AD:
--   • echo.campaign.exclusion_config — a kampány saját kizárási beállítása:
--       null                 = alapbeállítás (minden szabály be, globális küszöbök)
--       {"mod":"nincs"}      = senkit nem zárunk ki szabály alapján
--       {"mod":"egyedi", "szabalyok":{"LETSZAM_ALATT":true,...},
--        "min_headcount":5, "min_share_pct":20}
--   • echo.exclusion_effective(kampány) — a ténylegesen érvényes beállítás
--   • echo.eligibility_rebuild() — a 42-es törzs, a beállítást követve
--   • public.echo_exclusion_config(kampány)           — olvasás a szerkesztőnek
--   • public.echo_exclusion_config_set(kampány, cfg)  — mentés + újraépítés
--   • public.echo_campaign_exclusions(kampány)        — a kizárt kurzusok,
--     oktatói párok és az értékelés nélkül maradó oktatók listája
--
-- AMI NEM KAPCSOLHATÓ KI: a NINCS_OKTATO. Oktató nélküli kurzuson nincs kit
-- értékelni — az alkalmassági lista kurzus–OKTATÓ párokból áll. "Nincs
-- kizárás" módban is kimarad, és a napló ezt ki is mondja.
--
-- ANONIMITÁS: a létszámküszöb kikapcsolása után kis kurzus is véleményezhető.
-- Az eredményoldal ettől NEM lesz sebezhetőbb: az echo.setting k_numeric /
-- k_dist / k_text küszöbei (alsó korlátjuk CHECK constrainttel 5/10/10) a
-- riport-RPC-kben külön érvényesülnek, tehát kevés válasznál ott semmi nem
-- jelenik meg. A kitöltő viszont tudja, hogy kicsi a csoport — a felület ezt
-- figyelmeztetésként kiírja.
--
-- MÓDOSÍTHATÓSÁG: csak 'draft' állapotban, mert az újraépítés nyitott
-- kampányban a már kiadott jegyeket érvényteleníthetné.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

alter table echo.campaign add column if not exists exclusion_config jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'echo_campaign_exclusion_config_ck') then
    alter table echo.campaign add constraint echo_campaign_exclusion_config_ck
      check (exclusion_config is null or jsonb_typeof(exclusion_config) = 'object');
  end if;
end $$;

comment on column echo.campaign.exclusion_config is
  'A kampány kizárási beállítása. NULL = alapbeállítás. Lásd 76_echo_exclusion_config.sql.';


-- ------------------------------------------------------------
-- 1. A ténylegesen érvényes beállítás
-- ------------------------------------------------------------
-- Egyetlen helyen oldjuk fel, hogy a motor, a szerkesztő és a lista
-- PONTOSAN ugyanazt lássa.
create or replace function echo.exclusion_effective(p_campaign uuid)
returns jsonb
language plpgsql stable
set search_path = echo, public, pg_temp
as $$
declare
  v_cfg   jsonb;
  v_mod   text;
  v_gh    integer := coalesce((select value::integer from echo.setting where key = 'min_headcount'), 3);
  v_gs    numeric := coalesce((select value::numeric from echo.setting where key = 'min_share_pct'), 25);
  v_sz    jsonb;
begin
  select exclusion_config into v_cfg from echo.campaign where id = p_campaign;
  v_mod := coalesce(v_cfg->>'mod', 'alap');
  if v_mod not in ('alap','nincs','egyedi') then v_mod := 'alap'; end if;
  v_sz  := coalesce(v_cfg->'szabalyok', '{}'::jsonb);

  return jsonb_build_object(
    'mod', v_mod,
    'szabalyok', jsonb_build_object(
      'LETSZAM_ALATT',       case v_mod when 'nincs' then false when 'egyedi' then coalesce((v_sz->>'LETSZAM_ALATT')::boolean, true) else true end,
      'NINCS_ORARENDI_INFO', case v_mod when 'nincs' then false when 'egyedi' then coalesce((v_sz->>'NINCS_ORARENDI_INFO')::boolean, true) else true end,
      'VIZSGAKURZUS',        case v_mod when 'nincs' then false when 'egyedi' then coalesce((v_sz->>'VIZSGAKURZUS')::boolean, true) else true end,
      'OKTATOI_ARANY_ALATT', case v_mod when 'nincs' then false when 'egyedi' then coalesce((v_sz->>'OKTATOI_ARANY_ALATT')::boolean, true) else true end,
      'NINCS_OKTATO',        true),
    'min_headcount', case when v_mod = 'egyedi' then coalesce((v_cfg->>'min_headcount')::integer, v_gh) else v_gh end,
    'min_share_pct', case when v_mod = 'egyedi' then coalesce((v_cfg->>'min_share_pct')::numeric, v_gs) else v_gs end,
    'globalis', jsonb_build_object('min_headcount', v_gh, 'min_share_pct', v_gs));
end $$;


-- ------------------------------------------------------------
-- 2. Az alkalmassági motor — a 42-es törzs, beállítás-tudatosan
-- ------------------------------------------------------------
-- Változás a 42_campaign_editor.sql-hez képest: a négy kapcsolható szabály
-- és a két küszöb az echo.exclusion_effective()-ből jön. Kikapcsolt szabály
-- NEM kerül a naplóba (a napló a tényleges kizárásokat tartalmazza).
create or replace function echo.eligibility_rebuild(p_campaign uuid)
returns table (
  eligible_pairs  integer,
  eligible_courses integer,
  excluded_courses integer,
  excluded_pairs   integer
)
language plpgsql
set search_path = echo, public, pg_temp
as $$
declare
  v_term      text;
  v_state     text;
  v_eff       jsonb := echo.exclusion_effective(p_campaign);
  v_min_head  integer := (v_eff->>'min_headcount')::integer;
  v_min_share numeric := (v_eff->>'min_share_pct')::numeric;
  v_r_head    boolean := (v_eff->'szabalyok'->>'LETSZAM_ALATT')::boolean;
  v_r_info    boolean := (v_eff->'szabalyok'->>'NINCS_ORARENDI_INFO')::boolean;
  v_r_vizsga  boolean := (v_eff->'szabalyok'->>'VIZSGAKURZUS')::boolean;
  v_r_share   boolean := (v_eff->'szabalyok'->>'OKTATOI_ARANY_ALATT')::boolean;
  -- Celkozonseg: kulon a 'MIT' (kurzus) es a 'KI' (csoport/felhasznalo).
  v_has_course boolean;
  v_has_who    boolean;
begin
  select c.term, c.state into v_term, v_state from echo.campaign c where c.id = p_campaign;
  if v_term is null then
    raise exception 'ECHO: nincs ilyen kampany: %', p_campaign;
  end if;
  select exists (select 1 from echo.campaign_audience
                  where campaign_id = p_campaign and kind = 'course'),
         exists (select 1 from echo.campaign_audience
                  where campaign_id = p_campaign and kind in ('group','user'))
    into v_has_course, v_has_who;

  if v_state in ('sealed','published') then
    raise exception 'ECHO: lepecsetelt/kozzetett kampany alkalmassaga nem epitheto ujra (%).', v_state;
  end if;
  if v_state = 'open' then
    raise warning 'ECHO: NYITOTT kampany alkalmassagat epited ujra. A mar kiadott jegyek '
                  'kozul azok, amelyek kikerulo kurzusra szoltak, ervenytelenne valnak.';
  end if;

  delete from echo.eligibility   where campaign_id = p_campaign;
  delete from echo.exclusion_log where campaign_id = p_campaign;

  drop table if exists _echo_c;
  drop table if exists _echo_ok;
  drop table if exists _echo_who;
  create temporary table _echo_c on commit drop as
  select c.id                                   as course_id,
         coalesce(c.letszam, cnt.n, 0)          as headcount,
         c.van_orarendi_info,
         c.vizsgakurzus,
         coalesce(tc.n, 0)                      as teacher_count
    from echo.course c
    left join lateral (
      select count(*)::integer as n from echo.enrollment e
       where e.course_id = c.id and e.status = 'active') cnt on true
    left join lateral (
      select count(*)::integer as n from echo.course_teacher ct
       where ct.course_id = c.id) tc on true
   where (    (v_has_course and c.id in (select a.course_id from echo.campaign_audience a
                                          where a.campaign_id = p_campaign and a.kind = 'course'))
          or (not v_has_course and c.term = v_term));

  -- --- kurzusszintű kizárások (csak a bekapcsolt szabályok) ---
  if v_r_head then
    insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
    select p_campaign, course_id, null, 'LETSZAM_ALATT',
           jsonb_build_object('letszam', headcount, 'kuszob', v_min_head)
      from _echo_c where headcount < v_min_head;
  end if;

  if v_r_info then
    insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
    select p_campaign, course_id, null, 'NINCS_ORARENDI_INFO', '{}'::jsonb
      from _echo_c where van_orarendi_info = false;
  end if;

  if v_r_vizsga then
    insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
    select p_campaign, course_id, null, 'VIZSGAKURZUS', '{}'::jsonb
      from _echo_c where vizsgakurzus = true;
  end if;

  -- Nem kapcsolható: oktató nélkül nincs kurzus–oktató pár.
  insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
  select p_campaign, course_id, null, 'NINCS_OKTATO', '{}'::jsonb
    from _echo_c where teacher_count = 0;

  create temporary table _echo_who on commit drop as
  select profile_id from echo.audience_profiles(p_campaign) as t(profile_id);
  create index on _echo_who (profile_id);

  -- --- a túlélő kurzusok ---
  create temporary table _echo_ok on commit drop as
  select course_id from _echo_c
   where (not v_r_head   or headcount >= v_min_head)
     and (not v_r_info   or van_orarendi_info = true)
     and (not v_r_vizsga or vizsgakurzus = false)
     and teacher_count > 0;

  -- --- pár szintű kizárás: oktatói óraarány ---
  if v_r_share then
    insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
    select p_campaign, ct.course_id, ct.teacher_id, 'OKTATOI_ARANY_ALATT',
           jsonb_build_object('share_pct', ct.share_pct, 'kuszob', v_min_share)
      from echo.course_teacher ct
      join _echo_ok o on o.course_id = ct.course_id
     where ct.share_pct < v_min_share;
  end if;

  -- --- a véleményezhető párok ---
  insert into echo.eligibility (campaign_id, course_id, teacher_id, share_pct)
  select p_campaign, ct.course_id, ct.teacher_id, ct.share_pct
    from echo.course_teacher ct
    join _echo_ok o on o.course_id = ct.course_id
   where (not v_r_share or ct.share_pct >= v_min_share)
  on conflict (campaign_id, course_id, teacher_id) do nothing;

  -- --- a részvételi napló vázának előállítása/frissítése ---
  insert into echo.participation (campaign_id, course_id, student_key, eligible)
  select p_campaign, e.course_id, e.student_key, true
    from echo.enrollment e
    join echo.eligibility el on el.campaign_id = p_campaign and el.course_id = e.course_id
   where e.status = 'active'
     and (not v_has_who
          or exists (select 1 from _echo_who w where w.profile_id = e.student_key))
   group by e.course_id, e.student_key
  on conflict (campaign_id, course_id, student_key) do update set eligible = true;

  update echo.participation p set eligible = false
   where p.campaign_id = p_campaign
     and (    not exists (select 1 from echo.eligibility el
                           where el.campaign_id = p_campaign and el.course_id = p.course_id)
          or (v_has_who and not exists (select 1 from _echo_who w
                                         where w.profile_id = p.student_key)));

  return query
  select (select count(*)::integer from echo.eligibility where campaign_id = p_campaign),
         (select count(distinct course_id)::integer from echo.eligibility where campaign_id = p_campaign),
         (select count(distinct course_id)::integer from echo.exclusion_log
           where campaign_id = p_campaign and teacher_id is null),
         (select count(*)::integer from echo.exclusion_log
           where campaign_id = p_campaign and teacher_id is not null);
end $$;


-- ------------------------------------------------------------
-- 3. Olvasás a szerkesztőnek
-- ------------------------------------------------------------
create or replace function public.echo_exclusion_config(p_campaign uuid)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare c echo.campaign%rowtype;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;
  select * into c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;

  return jsonb_build_object(
    'campaign_id',  c.id,
    'state',        c.state,
    'szerkesztheto', c.state = 'draft',
    'mentett',      c.exclusion_config,
    'ervenyes',     echo.exclusion_effective(c.id),
    'kizart_kurzus', (select count(distinct course_id) from echo.exclusion_log
                       where campaign_id = c.id and teacher_id is null),
    'kizart_par',    (select count(*) from echo.exclusion_log
                       where campaign_id = c.id and teacher_id is not null),
    'szabalyok', (select coalesce(jsonb_agg(jsonb_build_object(
                     'code', r.code, 'name_hu', r.name_hu, 'name_en', r.name_en,
                     'paragraph_ref', r.paragraph_ref, 'description_hu', r.description_hu,
                     'scope', r.scope, 'kapcsolhato', r.code <> 'NINCS_OKTATO')
                   order by case r.scope when 'course' then 0 else 1 end, r.code), '[]'::jsonb)
                    from echo.exclusion_rule r));
end $$;


-- ------------------------------------------------------------
-- 4. Mentés + újraépítés
-- ------------------------------------------------------------
create or replace function public.echo_exclusion_config_set(p_campaign uuid, p_config jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c      echo.campaign%rowtype;
  v_mod  text := coalesce(p_config->>'mod', 'alap');
  v_sz   jsonb := coalesce(p_config->'szabalyok', '{}'::jsonb);
  v_cfg  jsonb;
  v_h    integer;
  v_s    numeric;
  k      text;
  r      record;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;

  select * into c from echo.campaign where id = p_campaign for update;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  if c.state <> 'draft' then
    raise exception 'ECHO_CAMPAIGN_RUNNING: a kizarasi szabalyok csak piszkozat allapotban '
                    'modosithatok (most: "%"). Nyitott kampanyban az ujraepites a mar kiadott '
                    'jegyeket ervenytelenitene.', c.state;
  end if;

  if p_config is not null and jsonb_typeof(p_config) <> 'object' then
    raise exception 'ECHO_BAD_CONFIG: a beallitas JSON objektum legyen.';
  end if;
  if v_mod not in ('alap','nincs','egyedi') then
    raise exception 'ECHO_BAD_CONFIG: ismeretlen mod: "%".', v_mod;
  end if;

  if v_mod = 'alap' then
    v_cfg := null;
  elsif v_mod = 'nincs' then
    v_cfg := jsonb_build_object('mod', 'nincs');
  else
    if jsonb_typeof(v_sz) <> 'object' then
      raise exception 'ECHO_BAD_CONFIG: a szabalyok mezo objektum legyen.';
    end if;
    for k in select jsonb_object_keys(v_sz) loop
      if k not in ('LETSZAM_ALATT','NINCS_ORARENDI_INFO','VIZSGAKURZUS','OKTATOI_ARANY_ALATT') then
        raise exception 'ECHO_BAD_CONFIG: a(z) "%" szabaly nem kapcsolhato.', k;
      end if;
      if jsonb_typeof(v_sz->k) <> 'boolean' then
        raise exception 'ECHO_BAD_CONFIG: a(z) "%" erteke true vagy false legyen.', k;
      end if;
    end loop;

    begin
      v_h := nullif(p_config->>'min_headcount', '')::integer;
      v_s := nullif(p_config->>'min_share_pct', '')::numeric;
    exception when others then
      raise exception 'ECHO_BAD_CONFIG: a kuszob szam legyen.';
    end;
    if v_h is not null and (v_h < 1 or v_h > 500) then
      raise exception 'ECHO_BAD_CONFIG: a letszamkuszob 1 es 500 kozott lehet (most: %).', v_h;
    end if;
    if v_s is not null and (v_s < 0 or v_s > 100) then
      raise exception 'ECHO_BAD_CONFIG: az oraarany-kuszob 0 es 100 szazalek kozott lehet (most: %).', v_s;
    end if;

    v_cfg := jsonb_build_object('mod', 'egyedi', 'szabalyok', v_sz);
    if v_h is not null then v_cfg := v_cfg || jsonb_build_object('min_headcount', v_h); end if;
    if v_s is not null then v_cfg := v_cfg || jsonb_build_object('min_share_pct', v_s); end if;
  end if;

  update echo.campaign set exclusion_config = v_cfg where id = p_campaign;

  insert into echo.campaign_log (campaign_id, from_state, to_state, irany, actor_key, actor_email, detail)
  values (p_campaign, c.state, c.state, 'szerkesztes', auth.uid(),
          (select email from public.profiles where id = auth.uid()),
          jsonb_build_object('kizaras_elotte', c.exclusion_config, 'kizaras', v_cfg));

  perform echo.log_access('echo_exclusion_config_set', p_campaign, null, null, 'campaign');

  select * into r from echo.eligibility_rebuild(p_campaign);

  return jsonb_build_object(
    'ok', true,
    'ervenyes', echo.exclusion_effective(p_campaign),
    'eligible_pairs', r.eligible_pairs, 'eligible_courses', r.eligible_courses,
    'excluded_courses', r.excluded_courses, 'excluded_pairs', r.excluded_pairs);
end $$;


-- ------------------------------------------------------------
-- 5. A kizártak listája
-- ------------------------------------------------------------
-- Három rész:
--   kurzusok — kurzusszintű kizárás; egy kurzus több szabályba is ütközhet,
--              ezért kurzusonként EGY sor, a szabályok tömbben
--   parok    — oktató–kurzus pár kizárása (óraarány)
--   oktatok  — akik a kampányban egyetlen értékelhető párt sem kaptak
-- Csak kurzus- és oktatói adat; hallgatóra semmi nem utal.
create or replace function public.echo_campaign_exclusions(p_campaign uuid)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare c echo.campaign%rowtype;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;
  select * into c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;

  return jsonb_build_object(
    'campaign_id', c.id,
    'state',       c.state,
    'ervenyes',    echo.exclusion_effective(c.id),
    'utolso_epites', (select max(logged_at) from echo.exclusion_log where campaign_id = c.id),
    'jogosult_kurzus', (select count(distinct course_id) from echo.eligibility where campaign_id = c.id),
    'jogosult_par',    (select count(*) from echo.eligibility where campaign_id = c.id),

    'osszesito', (select coalesce(jsonb_object_agg(rule_code, n), '{}'::jsonb)
                    from (select rule_code, count(*) n from echo.exclusion_log
                           where campaign_id = c.id group by rule_code) t),

    'kurzusok', (select coalesce(jsonb_agg(x order by x->>'code'), '[]'::jsonb) from (
       select jsonb_build_object(
         'course_id', k.id, 'code', k.code, 'name', k.name_hu, 'name_en', k.name_en, 'term', k.term,
         'szabalyok', jsonb_agg(jsonb_build_object(
                        'code', l.rule_code, 'name', r.name_hu, 'paragraph_ref', r.paragraph_ref,
                        'detail', l.detail) order by l.rule_code),
         'oktatok', (select coalesce(jsonb_agg(jsonb_build_object(
                        'teacher_id', t.id, 'name', t.name, 'title', t.title,
                        'share_pct', ct.share_pct) order by t.name), '[]'::jsonb)
                       from echo.course_teacher ct join echo.teacher t on t.id = ct.teacher_id
                      where ct.course_id = k.id)) as x
         from echo.exclusion_log l
         join echo.course k on k.id = l.course_id
         join echo.exclusion_rule r on r.code = l.rule_code
        where l.campaign_id = c.id and l.teacher_id is null
        group by k.id, k.code, k.name_hu, k.name_en, k.term) s),

    'parok', (select coalesce(jsonb_agg(jsonb_build_object(
         'course_id', k.id, 'course_code', k.code, 'course_name', k.name_hu,
         'teacher_id', t.id, 'name', t.name, 'title', t.title,
         'rule_code', l.rule_code, 'rule_name', r.name_hu, 'paragraph_ref', r.paragraph_ref,
         'detail', l.detail) order by t.name, k.code), '[]'::jsonb)
         from echo.exclusion_log l
         join echo.course k on k.id = l.course_id
         join echo.teacher t on t.id = l.teacher_id
         join echo.exclusion_rule r on r.code = l.rule_code
        where l.campaign_id = c.id and l.teacher_id is not null),

    -- A kampány hatókörében (kizárt vagy jogosult kurzuson) oktató, de
    -- egyetlen jogosult pár nélkül maradt oktatók.
    'oktatok', (select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
       select jsonb_build_object(
         'teacher_id', t.id, 'name', t.name, 'title', t.title,
         'kurzus_db', count(distinct ct.course_id),
         'okok', (select coalesce(jsonb_agg(distinct l2.rule_code), '[]'::jsonb)
                    from echo.exclusion_log l2
                    join echo.course_teacher ct2 on ct2.course_id = l2.course_id
                   where l2.campaign_id = c.id and ct2.teacher_id = t.id
                     and (l2.teacher_id is null or l2.teacher_id = t.id))) as x
         from echo.teacher t
         join echo.course_teacher ct on ct.teacher_id = t.id
        where ct.course_id in (select course_id from echo.exclusion_log where campaign_id = c.id
                               union
                               select course_id from echo.eligibility where campaign_id = c.id)
          and not exists (select 1 from echo.eligibility e
                           where e.campaign_id = c.id and e.teacher_id = t.id)
        group by t.id, t.name, t.title) s));
end $$;


-- ------------------------------------------------------------
-- 6. Jogosultságok
-- ------------------------------------------------------------
revoke all on function echo.exclusion_effective(uuid)                  from public;
revoke all on function public.echo_exclusion_config(uuid)              from public, anon;
revoke all on function public.echo_exclusion_config_set(uuid, jsonb)   from public, anon;
revoke all on function public.echo_campaign_exclusions(uuid)           from public, anon;
grant execute on function public.echo_exclusion_config(uuid)              to authenticated;
grant execute on function public.echo_exclusion_config_set(uuid, jsonb)   to authenticated;
grant execute on function public.echo_campaign_exclusions(uuid)           to authenticated;

do $chk$
begin
  if has_function_privilege('anon', 'public.echo_exclusion_config_set(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.echo_campaign_exclusions(uuid)', 'execute')
     or has_function_privilege('anon', 'public.echo_exclusion_config(uuid)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a kizarasi fuggvenyeket.';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'echo' and p.proname = 'eligibility_rebuild'
                    and p.prosrc like '%exclusion_effective%') then
    raise exception 'HIBA: az eligibility_rebuild nem a kampany beallitasat koveti.';
  end if;
  raise notice 'Rendben: 76 — kampanyonkenti kizarasi szabalyok es a kizartak listaja. Futtasd ujra a 21-est.';
end $chk$;


-- ############################################################################
-- ### 77_grants_core.sql
-- ############################################################################

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
   'GET. 2026-09-23-án mérve: 11 162 tétel, 431 nyitott, 63 program.'),
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
   '2026-09-23-án mérve: 11 162 tétel, 431 nyitott, 559 hamarosan nyíló.',
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
