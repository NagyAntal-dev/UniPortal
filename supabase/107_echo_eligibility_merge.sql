-- ============================================================================
-- 107_echo_eligibility_merge.sql — echo.eligibility_rebuild: a két ág egyesítése
-- ----------------------------------------------------------------------------
-- MIÉRT
--   Az upstream/main összefésülésekor két, egymástól függetlenül írt változat
--   találkozott, és mindkettő TELJESEN felülírja ugyanazt a függvényt:
--     - 76_echo_exclusion_config.sql (upstream): kampányonként kapcsolható
--       kizárási szabályok és küszöbök (echo.exclusion_effective)
--     - 80_audience_attribute_filter.sql + 82_audience_course_or.sql (mi):
--       célközönség szűrőkkel, a kurzusok és a KI-dobozok VAGY kapcsolatban
--       (echo.audience_items / echo.audience_pairs)
--   A manifestben a 76 a mi 82-esünk UTÁN fut, így önmagában csendben
--   visszavenné a célközönség-logikát. Ez a fájl a 82-es törzsét adja, a 76
--   kapcsolható szabályaival kiegészítve — mindkét funkció megmarad.
--
-- A 76 ellenőrzése (prosrc like '%exclusion_effective%') erre is teljesül.
-- ============================================================================

begin;

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
  -- 76: a kampány saját kizárási beállítása (alap / nincs / egyedi)
  v_eff       jsonb := echo.exclusion_effective(p_campaign);
  v_min_head  integer := (v_eff->>'min_headcount')::integer;
  v_min_share numeric := (v_eff->>'min_share_pct')::numeric;
  v_r_head    boolean := (v_eff->'szabalyok'->>'LETSZAM_ALATT')::boolean;
  v_r_info    boolean := (v_eff->'szabalyok'->>'NINCS_ORARENDI_INFO')::boolean;
  v_r_vizsga  boolean := (v_eff->'szabalyok'->>'VIZSGAKURZUS')::boolean;
  v_r_share   boolean := (v_eff->'szabalyok'->>'OKTATOI_ARANY_ALATT')::boolean;
  -- 82: a célközönség (hallgató, kurzus) párjai
  v_items     jsonb;
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
                  where campaign_id = p_campaign and kind in ('group','user','filter'))
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
  drop table if exists _echo_pairs;

  -- A cimzett (hallgato, kurzus) parok — ugyanaz a motor, mint a becslesnel.
  v_items := echo.audience_items(p_campaign);
  create temporary table _echo_pairs on commit drop as
  select * from echo.audience_pairs(p_campaign, v_items);
  create index on _echo_pairs (course_id, student_key);

  -- A kampány kurzusai, a tényleges létszámmal. Kijeloles nelkul a felev
  -- minden kurzusa; csak KI-val a felev minden kurzusa (a regi viselkedes);
  -- kurzussal a kijeloltek, es ha KI is van, a KI-tagok kurzusai is.
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
   where (not v_has_course and c.term = v_term)
      or (v_has_course and c.id in (select a.course_id from echo.campaign_audience a
                                     where a.campaign_id = p_campaign and a.kind = 'course'))
      or (v_has_course and v_has_who and c.id in (select course_id from _echo_pairs));

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

  -- KI ertekel — a lenti visszavonashoz kell.
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

  -- --- a részvételi napló ---
  -- Csak az 'eligible' jelzőt állítja; az attempted/submitted mezőkhöz nem nyúl.
  insert into echo.participation (campaign_id, course_id, student_key, eligible)
  select p_campaign, p.course_id, p.student_key, true
    from _echo_pairs p
   where exists (select 1 from echo.eligibility el
                  where el.campaign_id = p_campaign and el.course_id = p.course_id)
  on conflict (campaign_id, course_id, student_key) do update set eligible = true;

  -- Visszavonas: kikerult a kurzus, VAGY a par mar nem felel meg a
  -- celkozonsegnek. Szandekosan a SZABALYT nezzuk, nem a beiratkozast: egy
  -- kozben leadott kurzus miatt a mar megtortent kitoltes nyoma ne tunjon el
  -- (ugyanigy viselkedett a 80 is).
  update echo.participation p set eligible = false
   where p.campaign_id = p_campaign
     and (    not exists (select 1 from echo.eligibility el
                           where el.campaign_id = p_campaign and el.course_id = p.course_id)
          or not (    (not v_has_course and not v_has_who)
                   or (v_has_course and exists (select 1 from echo.campaign_audience a
                                                 where a.campaign_id = p_campaign
                                                   and a.kind = 'course'
                                                   and a.course_id = p.course_id))
                   or (v_has_who and exists (select 1 from _echo_who w
                                              where w.profile_id = p.student_key))));

  return query
  select (select count(*)::integer from echo.eligibility where campaign_id = p_campaign),
         (select count(distinct course_id)::integer from echo.eligibility where campaign_id = p_campaign),
         (select count(distinct course_id)::integer from echo.exclusion_log
           where campaign_id = p_campaign and teacher_id is null),
         (select count(*)::integer from echo.exclusion_log
           where campaign_id = p_campaign and teacher_id is not null);
end $$;

commit;

do $chk$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'echo' and p.proname = 'eligibility_rebuild'
                    and p.prosrc like '%exclusion_effective%'
                    and p.prosrc like '%audience_pairs%') then
    raise exception 'HIBA: az eligibility_rebuild nem az egyesitett (76 + 82) valtozat.';
  end if;
  raise notice 'Rendben: 107 — celkozonseg (82) es kampanyonkenti kizarasi szabalyok (76) egyutt.';
end $chk$;
