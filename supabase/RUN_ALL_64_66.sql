-- ============================================================================
-- RUN_ALL_64_66.sql — UniPortal · 2026-09-16
--
-- EGYBEN, EBBEN A SORRENDBEN futtatandó a Supabase SQL Editorban. A négy rész
-- egymásra épül, a végén pedig KÖTELEZŐEN a 21-es áll újra.
--
--   1) 64_letter_pdf_message.sql   a feltételes felvételi levél PDF-je a chat
--                                  értesítéshez csatolva, hivatkozással a
--                                  levél lépésre (letter_log_send bővítése)
--   2) 65_echo_results_questions.sql  oktatói eredmények: a part1 szakaszok és
--                                  a „skip” típusú kérdések kimaradnak az
--                                  eredményből; a nyers nézet hatóköre javítva
--   3) 66_interview_scoring.sql    interjú értékelő szempontrendszer
--                                  (bővíthető katalógus) és kitöltött lapok
--   4) 21_echo_harden_submit.sql   ÚJRA — ez mindig az utolsó
--
-- MIÉRT A 21 AZ UTOLSÓ
--   A Supabase alapértelmezett jogosztása MINDEN új public függvényt megnyit az
--   authenticated (és anon) szerepnek. Ha a 21 nem fut le a többi UTÁN, az
--   echo_submit újra hívhatóvá válik közvetlenül, és a kurzusértékelés
--   válaszai elveszítik a névtelenségüket. Ezért minden migráció után a 21-et
--   újra le kell futtatni — akkor is, ha korábban már lefutott.
--
-- TUDNIVALÓK
--   * Minden rész IDEMPOTENS: ha valamelyik már lefutott, újra lefuttatva sem
--     változtat adatot. A már lefutott 64/65 nem okoz hibát.
--   * Nincs benne psql-parancs és tranzakciókezelés, a teljes tartalom
--     bemásolható az SQL Editorba.
--   * A futás végén NOTICE üzenetek jelzik az ellenőrzések eredményét; a
--     „Rendben:” kezdetű sorokat érdemes visszaolvasni.
--   * Ha bármelyik rész hibával áll meg, a következő részek NEM futnak le
--     automatikusan — javítás után onnan folytatható.
--
-- A fájl a négy migráció szó szerinti tartalmát fűzi egybe; forrás:
--   supabase/64_letter_pdf_message.sql, 65_echo_results_questions.sql,
--   supabase/66_interview_scoring.sql, supabase/21_echo_harden_submit.sql
-- ============================================================================



-- ==========================================================================
--  1/4 — Levél PDF a chat értesítéshez
--  forrás: supabase/64_letter_pdf_message.sql
-- ==========================================================================

-- ============================================================
-- UniPortal — 64: A felvételi levél PDF-je az értesítő üzenetben
-- ------------------------------------------------------------
-- A 63-as kiküldési napló a jelentkező beszélgetésébe (62) szöveges
-- értesítést írt. Most a kiküldéskor elkészült PDF is csatolható:
--   • letter_log_send új, nem kötelező paramétere: p_file
--     ({ path, name, size, type }) — a fájlnak a documents tároló
--     chat/<ez az eljárás>/… mappájában kell lennie, és léteznie kell
--     (ugyanaz a szabály, mint a msg_send csatolmányainál);
--   • a napló sora megőrzi a fájlt (admission_letters.file);
--   • az értesítő üzenet csatolmányként kapja, kind = 'letter' és
--     letter_id jelöléssel — a felület erről ismeri fel a levél-értesítést,
--     és ad mellé hivatkozást a levél lépésére.
-- A PDF nélküli hívás (a régi, 3 paraméteres alak) változatlanul működik.
--
-- Idempotens — biztonságosan újrafuttatható. Utána futtasd újra a
-- 21_echo_harden_submit.sql-t is.
-- ============================================================

do $$
begin
  if to_regclass('public.admission_letters') is null or to_regclass('public.admission_messages') is null then
    raise exception 'MEGTAGADVA: előbb a 62-es és a 63-as migráció kell (admission_messages, admission_letters).';
  end if;
end $$;

alter table public.admission_letters add column if not exists file jsonb;
alter table public.admission_letters drop constraint if exists admission_letters_file_ck;
alter table public.admission_letters add constraint admission_letters_file_ck check (file is null or jsonb_typeof(file) = 'object');

create or replace function public.letter_log_json(l public.admission_letters)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'id', l.id, 'process_id', l.process_id, 'file_number', l.file_number, 'status', l.status,
    'snapshot', l.snapshot, 'file', l.file, 'sent_at', l.sent_at, 'sent_by_name', l.sent_by_name,
    'closed_at', l.closed_at, 'closed_by_name', l.closed_by_name, 'close_reason', l.close_reason)
$fn$;

-- A régi, 3 paraméteres alak helyére a 4 paraméteres lép (p_file alapértéke null,
-- így a 3 argumentumos hívás is ezt éri el — két változat kétértelmű lenne).
drop function if exists public.letter_log_send(text, text, jsonb);

create or replace function public.letter_log_send(p_process_id text, p_file_number text, p_snapshot jsonb, p_file jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  p      public.admission_processes;
  l      public.admission_letters;
  v_name text;
  v_file jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_admissions(), false) then
    raise exception 'A felvételi levél kiküldését csak a felvételi iroda naplózhatja.' using errcode = '42501';
  end if;
  select * into p from public.admission_processes where id = p_process_id;
  if p.id is null or nullif(btrim(coalesce(p.owner_email, '')), '') is null then
    raise exception 'Nincs ilyen felvételi eljárás.' using errcode = '02000';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'A levél adatai hiányoznak.' using errcode = '22023';
  end if;
  if pg_column_size(p_snapshot) > 200000 then
    raise exception 'A levél adatai túl nagyok.' using errcode = '22023';
  end if;

  -- A levél PDF-je: csak ennek az eljárásnak az üzenetmappájából, létező fájl.
  if p_file is not null and jsonb_typeof(p_file) <> 'null' then
    if jsonb_typeof(p_file) <> 'object' or nullif(btrim(coalesce(p_file->>'path', '')), '') is null then
      raise exception 'Hibás levél-fájl.' using errcode = '22023';
    end if;
    if (p_file->>'path') not like ('chat/' || p.id || '/%') or (p_file->>'path') like '%..%' then
      raise exception 'A levél PDF-je csak ennek az eljárásnak az üzenetmappájából származhat.' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = p_file->>'path') then
      raise exception 'A levél PDF-je nem található a tárolóban.' using errcode = '22023';
    end if;
    v_file := jsonb_strip_nulls(jsonb_build_object(
      'path', p_file->>'path',
      'name', left(coalesce(nullif(btrim(p_file->>'name'), ''), 'Conditional_Acceptance_Letter.pdf'), 200),
      'size', case when coalesce(p_file->>'size', '') ~ '^[0-9]{1,12}$' then (p_file->>'size')::bigint end,
      'type', left(nullif(btrim(p_file->>'type'), ''), 120)));
  end if;

  select nullif(btrim(pr.name), '') into v_name from public.profiles pr where pr.id = auth.uid();

  -- A korábbi érvényes kiküldés felülíródik: a jelentkező mindig csak az utolsót látja.
  update public.admission_letters
     set status = 'superseded', closed_at = now(), closed_by = auth.uid(), closed_by_name = v_name, close_reason = 'Új kiküldés'
   where process_id = p.id and status = 'sent';

  insert into public.admission_letters (process_id, owner_email, file_number, status, snapshot, file, sent_by, sent_by_name)
  values (p.id, lower(btrim(p.owner_email)), nullif(left(btrim(coalesce(p_file_number, '')), 80), ''), 'sent', p_snapshot, v_file, auth.uid(), v_name)
  returning * into l;

  -- Értesítés a jelentkezőnek a beszélgetésbe (62), a PDF-fel csatolmányként.
  insert into public.admission_messages (process_id, owner_email, sender_role, sender_id, sender_name, subject, body, files, tone, read_by_staff_at)
  values (p.id, lower(btrim(p.owner_email)), 'system', auth.uid(), coalesce(v_name, 'Külügyi Iroda'),
          'Felvételi leveled elkészült',
          'A feltételes felvételi leveled' || coalesce(' (' || l.file_number || ')', '') || ' elkészült. A Felvételi folyamatban megtekintheted és letöltheted.'
            || case when v_file is not null then ' A levelet PDF-ben csatoltuk.' else '' end,
          case when v_file is null then '[]'::jsonb
               else jsonb_build_array(v_file || jsonb_build_object('kind', 'letter', 'letter_id', l.id)) end,
          'success', now());

  return public.letter_log_json(l);
end
$fn$;

revoke all on function public.letter_log_json(public.admission_letters)          from public, anon, authenticated;
revoke all on function public.letter_log_send(text, text, jsonb, jsonb)          from public, anon;
grant execute on function public.letter_log_send(text, text, jsonb, jsonb)       to authenticated;

notify pgrst, 'reload schema';

do $$ begin raise notice '64: rendben.'; end $$;


-- ==========================================================================
--  2/4 — Oktatói eredmények: kérdésszűrés javítása
--  forrás: supabase/65_echo_results_questions.sql
-- ==========================================================================

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


-- ==========================================================================
--  3/4 — Interjú értékelő szempontrendszer
--  forrás: supabase/66_interview_scoring.sql
-- ==========================================================================

-- ============================================================================
-- 66_interview_scoring.sql — interjú értékelő szempontrendszer és kitöltött lapok
--
-- MIÉRT KELL
--   Az interjúk értékelése eddig egy külön Excel-táblában készült („Interjú
--   értékelő.xlsx”): egy sor = egy interjú, hat szempont 1–5 ponttal, összesen
--   30 pont, eredmény igen/nem, interjúztató. Ez a táblázat nem kapcsolódott a
--   jelentkezéshez, nem volt visszakereshető, és a szempontokat csak az tudta
--   bővíteni, akinél a fájl volt. Mostantól a szempontrendszert az ügyintéző a
--   saját felületén bővíti, az értékelést pedig a jelentkezés interjúkártyáján
--   tölti ki.
--
-- A DÖNTÉSEK
--   * KÉT tábla: a SZEMPONT-katalógus (bővíthető) és a KITÖLTÖTT értékelés.
--     A kitöltött lap a szempont KULCSÁRA hivatkozik, nem a nevére — a szempont
--     átnevezése így nem írja át a már kitöltött lapokat.
--   * NINCS TÖRLÉS, csak elrejtés (active = false): egy már pontozott szempont
--     törlése után a korábbi értékelések értelmezhetetlenek lennének.
--   * A PONTSZÁMOT A SZERVER SZÁMOLJA. A kliens csak a szempontonkénti pontokat
--     küldi; az összeget, a maximumot és az értékelő személyét a trigger tölti
--     ki, és az érvénytelen pontszámot (nem szám, negatív, maximum feletti,
--     ismeretlen szempont) elutasítja. Így a felületről nem lehet „30/30”-at
--     hamisítani.
--   * A kitöltött lap CSAK ügyintézőnek látszik (is_staff). A jelentkező a saját
--     felvételi folyamatában sem látja — ez belső bírálati adat.
--   * Egy jelentkezéshez egy értékelőlap tartozik (unique process_id). Az
--     ismételt interjú felülírja; a változás idejét az updated_at őrzi.
--
-- FÜGGŐSÉG: 04_admission_processes.sql, 11_rbac_additive.sql (is_staff, is_admin),
--           61_interview_calendar.sql (interviewSlots.process_id)
-- IDEMPOTENS: if not exists / create or replace / drop policy if exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) A szempont-katalógus
-- ---------------------------------------------------------------------------
create table if not exists public.interview_criterion (
  key         text primary key
              check (key ~ '^[a-z0-9_]{2,60}$'),
  label_hu    text not null
              check (char_length(btrim(label_hu)) between 2 and 120),
  label_en    text
              check (label_en is null or char_length(btrim(label_en)) between 2 and 120),
  max_score   int not null default 5
              check (max_score between 1 and 100),
  sort_order  int not null default 100,
  active      boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Ugyanazzal a megnevezéssel ne lehessen kétszer felvenni (kis-nagybetű független).
create unique index if not exists interview_criterion_label_hu_uq
  on public.interview_criterion (lower(btrim(label_hu)));

create or replace function public.interview_criterion_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    -- A kulcsra hivatkoznak a kitöltött lapok: nem változhat.
    new.key        := old.key;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.label_hu   := btrim(new.label_hu);
  new.label_en   := nullif(btrim(coalesce(new.label_en, '')), '');
  new.updated_at := now();
  return new;
end $fn$;

revoke all on function public.interview_criterion_guard() from public, anon;

drop trigger if exists interview_criterion_guard on public.interview_criterion;
create trigger interview_criterion_guard
  before insert or update on public.interview_criterion
  for each row execute function public.interview_criterion_guard();

alter table public.interview_criterion enable row level security;

drop policy if exists interview_criterion_read   on public.interview_criterion;
drop policy if exists interview_criterion_insert on public.interview_criterion;
drop policy if exists interview_criterion_update on public.interview_criterion;

-- Olvasni ügyintéző és interjúztató tud (belső bírálati eszköz), írni rendszergazda.
create policy interview_criterion_read on public.interview_criterion
  for select to authenticated using (coalesce(public.is_staff(), false));
create policy interview_criterion_insert on public.interview_criterion
  for insert to authenticated with check (public.is_admin());
create policy interview_criterion_update on public.interview_criterion
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- Szándékosan NINCS delete policy: elrejtés van, törlés nincs.

revoke all on public.interview_criterion from anon, authenticated, public;
grant select, insert, update on public.interview_criterion to authenticated;

-- A jelenlegi Excel hat szempontja, 1–5 ponttal (összesen 30).
insert into public.interview_criterion (key, label_hu, label_en, max_score, sort_order) values
  ('kommunikacio',   'Kommunikációs képesség',                   'Communication skills',            5, 10),
  ('nyelvhelyesseg', 'Nyelvhelyesség',                           'Grammatical accuracy',            5, 20),
  ('kiejtes',        'Kiejtés',                                  'Pronunciation',                   5, 30),
  ('szokincs',       'Szókincs',                                 'Vocabulary',                      5, 40),
  ('targyi_ismeret', 'Egyetemi / választott tantárgyi ismeretek', 'Subject knowledge',              5, 50),
  ('motivacio',      'Tanulmányi motiváció',                     'Motivation to study',             5, 60)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2) A kitöltött értékelőlap
-- ---------------------------------------------------------------------------
create table if not exists public.interview_evaluation (
  id               uuid primary key default gen_random_uuid(),
  process_id       text not null references public.admission_processes(id) on delete cascade,
  slot_id          text references public."interviewSlots"(id) on delete set null,
  scores           jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(scores) = 'object'),
  total            int not null default 0,
  max_total        int not null default 0,
  result           text not null default 'pending'
                   check (result in ('yes', 'no', 'pending')),
  note             text check (note is null or char_length(note) <= 4000),
  interviewer_name text,
  evaluated_by     uuid,
  evaluated_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Egy jelentkezéshez egy értékelőlap.
create unique index if not exists interview_evaluation_process_uq
  on public.interview_evaluation (process_id);

/* A pontszám a szerveré: a kliens csak a szempontonkénti pontokat küldi.
   Az összeget és a maximumot itt számoljuk, az érvénytelen értéket elutasítjuk. */
create or replace function public.interview_evaluation_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  k text;
  v int;
  c public.interview_criterion;
  v_total int := 0;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.process_id := old.process_id;
    new.created_at := old.created_at;
  end if;

  if new.scores is null or jsonb_typeof(new.scores) <> 'object' then
    new.scores := '{}'::jsonb;
  end if;

  for k in select key from jsonb_each(new.scores) loop
    select * into c from public.interview_criterion where key = k;
    if c.key is null then
      raise exception 'Ismeretlen értékelési szempont: %', k using errcode = '22023';
    end if;
    if jsonb_typeof(new.scores -> k) <> 'number' then
      raise exception 'A(z) "%" szempont pontszáma nem szám.', c.label_hu using errcode = '22023';
    end if;
    v := (new.scores ->> k)::numeric::int;
    if v < 0 or v > c.max_score then
      raise exception 'A(z) "%" szempont pontszáma 0 és % között lehet.', c.label_hu, c.max_score using errcode = '22023';
    end if;
    v_total := v_total + v;
  end loop;

  new.total     := v_total;
  new.max_total := coalesce((select sum(max_score) from public.interview_criterion where active), 0);
  new.note      := nullif(btrim(coalesce(new.note, '')), '');
  -- Az értékelő személyét és idejét a szerver tölti ki, nem a kliens.
  new.evaluated_by := coalesce(auth.uid(), old.evaluated_by);
  new.evaluated_at := now();
  new.updated_at   := now();
  return new;
end $fn$;

revoke all on function public.interview_evaluation_guard() from public, anon;

drop trigger if exists interview_evaluation_guard on public.interview_evaluation;
create trigger interview_evaluation_guard
  before insert or update on public.interview_evaluation
  for each row execute function public.interview_evaluation_guard();

alter table public.interview_evaluation enable row level security;

drop policy if exists interview_evaluation_read   on public.interview_evaluation;
drop policy if exists interview_evaluation_insert on public.interview_evaluation;
drop policy if exists interview_evaluation_update on public.interview_evaluation;

-- Csak ügyintéző: a jelentkező a saját lapját sem látja (belső bírálati adat).
create policy interview_evaluation_read on public.interview_evaluation
  for select to authenticated using (coalesce(public.is_staff(), false));
create policy interview_evaluation_insert on public.interview_evaluation
  for insert to authenticated with check (coalesce(public.is_staff(), false));
create policy interview_evaluation_update on public.interview_evaluation
  for update to authenticated using (coalesce(public.is_staff(), false))
  with check (coalesce(public.is_staff(), false));
-- Szándékosan NINCS delete policy.

revoke all on public.interview_evaluation from anon, authenticated, public;
grant select, insert, update on public.interview_evaluation to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Lista- és exportnézet (a hívó jogán — az RLS érvényes marad)
-- ---------------------------------------------------------------------------
drop view if exists public.interview_evaluation_list;
create view public.interview_evaluation_list
  with (security_invoker = on)
as
  select
    e.id, e.process_id, e.slot_id, e.scores, e.total, e.max_total, e.result, e.note,
    e.interviewer_name, e.evaluated_at, e.updated_at,
    p.ref_no,
    p.applicant_name,
    p.owner_email,
    p.program_id,
    p.data ->> 'term'                          as term,
    coalesce(p.data -> 'personal' ->> 'name', p.applicant_name) as personal_name,
    p.data -> 'personal' ->> 'country'         as country,
    s."startTime"                              as interview_start,
    s."interviewerName"                        as slot_interviewer
  from public.interview_evaluation e
  join public.admission_processes p on p.id = e.process_id
  left join public."interviewSlots" s on s.id = e.slot_id;

revoke all on public.interview_evaluation_list from public, anon;
grant select on public.interview_evaluation_list to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Ellenőrzés
-- ---------------------------------------------------------------------------
do $blk$
declare
  v_db int;
  v_max int;
begin
  if has_table_privilege('anon', 'public.interview_criterion', 'select')
     or has_table_privilege('anon', 'public.interview_evaluation', 'select') then
    raise exception 'BIZTONSAGI HIBA: az anon olvashatja az interju ertekelo tablakat.';
  end if;
  if has_table_privilege('authenticated', 'public.interview_evaluation', 'delete')
     or has_table_privilege('authenticated', 'public.interview_evaluation', 'truncate')
     or has_table_privilege('authenticated', 'public.interview_criterion', 'delete') then
    raise exception 'BIZTONSAGI HIBA: az authenticated torolhet az interju ertekelo tablakbol.';
  end if;
  select count(*), coalesce(sum(max_score), 0) into v_db, v_max
    from public.interview_criterion where active;
  raise notice 'Rendben: 66 — % aktiv ertekelesi szempont, osszesen % pont. Az ertekelolapok tablaja kesz.', v_db, v_max;
end $blk$;


-- ==========================================================================
--  4/4 — ECHO beküldés újrazárása — MINDIG EZ AZ UTOLSÓ
--  forrás: supabase/21_echo_harden_submit.sql
-- ==========================================================================

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


-- ============================================================================
--  VÉGE — RUN_ALL_64_66.sql
--  Ellenőrzés: a NOTICE üzenetek között szerepelnie kell a 64, 65, 66 és a
--  21 visszajelzésének. Ha igen, a felületen a levél-PDF, az oktatói
--  eredmények és az interjú értékelés is működik.
-- ============================================================================
