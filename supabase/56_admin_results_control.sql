-- ============================================================================
-- 56_admin_results_control.sql — az adminisztrátor lát mindent, és ő dönt
--
-- MIÉRT
--   Eddig a küszöbök (k_numeric, k_text, k_dist, k_low) és a 33% alatti
--   óralátogatás szűrése MINDENKIRE egyformán vonatkozott — az adminisztrátorra
--   is. Emiatt előfordult, hogy egy kampányt mind az öt jogosult hallgató
--   kitöltött, az adminisztrátor mégsem látott semmit: egy hallgató 33% alatti
--   óralátogatást vallott, a maradék négy pedig a k_numeric=5 alá esett.
--
--   Az intézmény döntése: az ADMINISZTRÁTOR LÁSSON MINDENT, és utólag ő
--   határozza meg, milyen szűréssel válik az eredmény relevánssá, majd ezzel a
--   szűréssel kerüljön az oktató elé.
--
-- MIT VÁLTOZTAT — ÉS MIT NEM
--   1. ÚJ: public.echo_results_raw() — nyers, szűretlen nézet, KIZÁRÓLAG
--      adminnak. Nincs benne küszöb, nincs óralátogatás-szűrés, és a szöveges
--      válaszok moderálási állapotukkal együtt jönnek vissza. Minden hívás
--      naplózódik (6. § (4)) — ugyanúgy, mint eddig bármelyik eredménynézés.
--   2. ÚJ: echo.campaign.low_attendance_included — kampányonkénti kapcsoló.
--      Ha be van kapcsolva, a 33% alatti óralátogatású válaszok a FŐ halmazba
--      számítanak, tehát az OKTATÓ felé továbbított eredménybe is beleszámítanak.
--      Alapértelmezés: false, vagyis a mai, 3. § (9) szerinti viselkedés.
--   3. Az echo.results_build() ezt a kapcsolót veszi figyelembe. A függvény
--      többi része BETŰRE változatlan: a 20_echo_report_fix.sql szövegéből
--      generáltuk, egyetlen blokk cseréjével, hogy ne csússzon el semmi.
--
--   AMIT NEM VÁLTOZTATUNK: a k-küszöbök az OKTATÓI nézetben érvényben
--   maradnak. Az anonimitást a hallgató a tanárával szemben élvezi — ezt a
--   nyers admin-nézet nem érinti, mert oda az oktató nem lát be. Ha a küszöböt
--   az oktató felé is le akarjátok vinni, az külön, tudatos döntés: az
--   echo.setting k_* értékei felfelé szabadon, lefelé CHECK-ig állíthatók.
--
-- FÜGGŐSÉG: 16_echo_reports.sql, 20_echo_report_fix.sql
-- IDEMPOTENS: add column if not exists + create or replace.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Kampányonkénti relevancia-kapcsoló
-- ------------------------------------------------------------
alter table echo.campaign
  add column if not exists low_attendance_included boolean not null default false;

comment on column echo.campaign.low_attendance_included is
  'Ha igaz, a 33% alatti oralatogatast vallo hallgatok valaszai a FO halmazba '
  'szamitanak (nem kulon, tajekoztato blokkba). Az adminisztrator dontese, '
  'kampanyonkent. Alapertelmezes: false = a 28/2023. 3. § (9) szerinti mukodes.';


-- ------------------------------------------------------------
-- 2. Az eredmenyepito — a kapcsolot figyelembe veve
--    (a 20_echo_report_fix.sql szovegebol generalva, egy blokk cserejevel)
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
                                                  'rejtve', true, 'kerdesek', '[]'::jsonb));
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

  return v_out;
end $$;


-- ------------------------------------------------------------
-- 3. A kampany relevancia-szurojenek allitasa
-- ------------------------------------------------------------
create or replace function public.echo_campaign_filters_set(
  p_campaign uuid,
  p_low_attendance_included boolean
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $fn$
declare v_c echo.campaign%rowtype;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then
    raise exception 'ECHO_FORBIDDEN: a szuresi feltetelt csak rendszergazda allithatja.';
  end if;
  if p_low_attendance_included is null then
    raise exception 'ECHO_BAD_INPUT: meg kell adni, beleszamitson-e az alacsony oralatogatas.';
  end if;

  select * into v_c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;

  -- LEPECSETELT KAMPANYT NEM IRUNK AT. A 'sealed' allapot pont azt jelenti,
  -- hogy az eredmeny vegleges; ha a szurest utana modositanank, egy mar
  -- atadott jegyzokonyv szamai valtoznanak meg visszamenoleg.
  if v_c.state in ('sealed', 'published') then
    raise exception 'ECHO_SEAL_IRREVERSIBLE: lepecsetelt kampany szurese nem modosithato. '
                    'A szurest a lepecsetelés ELOTT kell veglegesiteni.';
  end if;

  update echo.campaign
     set low_attendance_included = p_low_attendance_included
   where id = p_campaign;

  perform echo.log_access('echo_campaign_filters_set', p_campaign, null, null, 'campaign');

  return jsonb_build_object(
    'campaign_id', p_campaign,
    'low_attendance_included', p_low_attendance_included);
end $fn$;


-- A szuro AKTUALIS erteke. Kulon olvaso RPC, mert az echo_campaigns() JSON
-- alakjahoz nem akartunk hozzanyulni: egy uj mezo ott minden hivot erintene.
create or replace function public.echo_campaign_filters_get(p_campaign uuid)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $fn$
declare v_c echo.campaign%rowtype;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;
  select * into v_c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  return jsonb_build_object(
    'campaign_id',             p_campaign,
    'state',                   v_c.state,
    'low_attendance_included', v_c.low_attendance_included,
    'zarolt',                  (v_c.state in ('sealed', 'published')));
end $fn$;


-- ------------------------------------------------------------
-- 4. NYERS, SZURETLEN NEZET — kizarolag adminnak
-- ------------------------------------------------------------
-- Ez a fuggveny SEMMIT nem rejt el: nincs k-kuszob, nincs oralatogatas-szures,
-- es a szoveges valaszok a moderalasi allapotukkal egyutt jonnek vissza. Az
-- adminisztrator ez alapjan dont arrol, mi relevans, es mi kerulhet az oktato
-- ele. A hivas naplozodik (6. § (4)).
--
-- AMI ITT SINCS: a hallgato szemelye. A valaszsorban nincs olyan oszlop, ami ra
-- mutatna (echo.response: campaign, course, teacher, template_version, scope,
-- attendance_band, answers) — ez a nyers nezetben is igy van.
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

  -- Kerdesenkent: minden ertek, minden szoveg, moderalasi allapottal.
  for v_sec in select * from jsonb_array_elements(v_compiled->'sections') loop
    for v_qq in select * from jsonb_array_elements(coalesce(v_sec->'questions', '[]'::jsonb)) loop
      v_qid := v_qq->>'id';

      select coalesce(jsonb_agg(x.val order by x.val::text), '[]'::jsonb) into v_vals
        from (select r.answers -> v_qid as val
                from echo.response r
               where r.id = any(v_ids) and r.answers ? v_qid) x;

      /* A SZOVEG MAGA A VALASZSORBAN VAN (echo.response.answers -> kerdes-id);
         az echo.moderation csak az ALLAPOTOT tartja rola, szoveget nem tarol.
         Ezert a kettot ossze kell kotni. Csak szoveges tipusnal gyujtunk —
         egy skala-ertekre ertelmetlen volna „szoveg" cimszo alatt visszaadni. */
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
    'valaszadas',   jsonb_build_object(
                      'valaszok',  coalesce(array_length(v_ids, 1), 0),
                      'alacsony',  v_n_lo,
                      'jogosult',  v_jog,
                      'arany',     case when v_jog > 0
                                        then round(100.0 * coalesce(array_length(v_ids,1),0) / v_jog, 1)
                                        else null end),
    'kerdesek',     v_q);
end $fn$;


-- ------------------------------------------------------------
-- 5. Jogosultsagok
-- ------------------------------------------------------------
-- A Supabase alapertelmezese EXECUTE-ot ad az 'anon' szerepnek minden uj
-- public fuggvenyre, es a "revoke from public" ezt NEM veszi el.
do $blk$
declare f text;
begin
  foreach f in array array[
    'public.echo_results_raw(uuid,uuid,text,uuid)',
    'public.echo_campaign_filters_set(uuid,boolean)',
    'public.echo_campaign_filters_get(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $blk$;

do $blk$
declare v_n int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('echo_results_raw', 'echo_campaign_filters_set',
                       'echo_campaign_filters_get')
     and has_function_privilege('anon', p.oid, 'execute');
  if v_n > 0 then
    raise exception 'BIZTONSAGI HIBA: % uj RPC-t az anon is hivhat.', v_n;
  end if;
  raise notice 'Admin nyers nezet + kampany-szuro telepitve, anon-hozzaferes nelkul.';
end $blk$;
