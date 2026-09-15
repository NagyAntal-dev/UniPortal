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
