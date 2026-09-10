-- ============================================================================
-- 57_raw_attendance.sql — az óralátogatás a nyers nézetben is látsszon
--
-- A TÜNET
--   Az 56-os nyers nézetben az 'attendance' kérdés „0 válasz"-ként jelent meg,
--   pedig mind az öt hallgató válaszolt rá. Úgy nézett ki, mintha hiányozna.
--
-- AZ OK
--   Az echo_submit() az óralátogatást NEM az answers objektumba teszi, hanem a
--   válaszsor külön oszlopába (echo.response.attendance_band) — ezen áll a
--   3. § (9) szerinti kettéosztás. A nyers nézet viszont minden kérdést az
--   answers-ből olvasott, ezért erre az egyre nem talált semmit.
--
-- A JAVÍTÁS
--   Az 'attendance' id-jű kérdésnél az értékeket az attendance_band oszlopból
--   vesszük. Minden más kérdés változatlanul az answers-ből jön.
--   Csak az echo_results_raw() törzse változik; az 56-os migráció többi része
--   érintetlen.
--
-- FÜGGŐSÉG: 56_admin_results_control.sql
-- IDEMPOTENS: create or replace.
-- ============================================================================

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

  for v_sec in select * from jsonb_array_elements(v_compiled->'sections') loop
    for v_qq in select * from jsonb_array_elements(coalesce(v_sec->'questions', '[]'::jsonb)) loop
      v_qid := v_qq->>'id';

      if v_qid = 'attendance' then
        /* AZ ÓRALÁTOGATÁS KÜLÖN OSZLOPBAN ÁLL, nem az answers-ben: az
           echo_submit() a payload gyökeréből veszi ki, mert ezen áll a
           3. § (9) szerinti kettéosztás. Ha innen olvasnánk az answers-t,
           „0 válasz" jönne ki — pedig mindenki válaszolt rá. */
        select coalesce(jsonb_agg(to_jsonb(r.attendance_band) order by r.attendance_band), '[]'::jsonb)
          into v_vals
          from echo.response r
         where r.id = any(v_ids) and r.attendance_band is not null;
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
begin
  if has_function_privilege('anon',
       'public.echo_results_raw(uuid,uuid,text,uuid)'::regprocedure, 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon is hivhatja a nyers nezetet.';
  end if;
  raise notice 'A nyers nezet mostantol az oralatogatast is mutatja.';
end $blk$;
