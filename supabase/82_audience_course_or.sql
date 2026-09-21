-- ============================================================================
-- 82_audience_course_or.sql — a Kurzusok és a KI-dobozok VAGY kapcsolatban
-- ----------------------------------------------------------------------------
-- MI VÁLTOZIK
--   Eddig a célközönség METSZET volt:
--     (kijelölt kurzusok) ÉS (csoportok ∪ személyek ∪ szűrők)
--   Egy 59 levelezős kurzus + "Tagozat = Nappali" kampány így 3 hallgatónál
--   maradt, mert csak a levelezős kurzusra járó nappalisok estek bele — pedig
--   az admin mindkét halmazt "hozzá akarta adni".
--
--   Mostantól UNIÓ, (hallgató, kurzus) párok szintjén:
--     - a kijelölt kurzusok MINDEN aktív hallgatója, az adott kurzusra; VAGY
--     - a csoportok/személyek/szűrők MINDEN tagja, a kampány félévében
--       felvett ÖSSZES kurzusára.
--   Ami üres, az továbbra sem szűkít:
--     - semmi sincs kijelölve        → a félév minden kurzusa, minden hallgatója
--     - csak kurzus                  → változatlan
--     - csak KI                      → változatlan
--     - kurzus ÉS KI                 → EZ változik: metszet helyett unió
--
-- EGY MOTOR
--   A (hallgató, kurzus) párokat egyetlen függvény adja: echo.audience_pairs().
--   A becslés, a névsor, a mentett állapot összesítője és az alkalmassági
--   motor mind ebből dolgozik. A mentett sorokat az echo.audience_items()
--   alakítja ugyanarra a p_items alakra, amit a szerkesztő küld — így a
--   "mentés előtt" és a "mentés után" szám nem tud elcsúszni egymástól.
--
-- ELŐFELTÉTEL: 80_audience_attribute_filter.sql már lefutott.
-- IDEMPOTENS, kétszer is lefuttatható.
--
-- FIGYELEM — SORREND. Ez a fájl ÚJRADEFINIÁLJA:
--     echo.eligibility_rebuild, echo.audience_target,
--     public.echo_audience_preview, public.echo_campaign_audience   (80)
-- Ha a 42, 45, 47 vagy 80 valamelyikét később újra lefuttatod, a VAGY
-- szemantika ELVÉSZ. Ilyenkor a 82-t utána ismét le kell futtatni.
-- A tools/audience_filter_regresszio.mjs ezt is méri.
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.attr_rules_match(jsonb,uuid)') is null then
    raise exception 'ELOFELTETEL: hianyzik a 80_audience_attribute_filter.sql.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'echo' and table_name = 'campaign_audience'
                    and column_name = 'szabaly') then
    raise exception 'ELOFELTETEL: hianyzik a 80_audience_attribute_filter.sql (szabaly oszlop).';
  end if;
end $pre$;


begin;

-- ---------------------------------------------------------------------------
-- 1) A mentett célközönség p_items alakban
-- ---------------------------------------------------------------------------
create or replace function echo.audience_items(p_campaign uuid)
returns jsonb
language sql stable
set search_path = echo, public, pg_temp
as $$
  select coalesce(jsonb_agg(case a.kind
           when 'course' then jsonb_build_object('kind', 'course', 'id', a.course_id)
           when 'group'  then jsonb_build_object('kind', 'group',  'id', a.group_id)
           when 'user'   then jsonb_build_object('kind', 'user',   'id', a.profile_id)
           when 'filter' then jsonb_build_object('kind', 'filter', 'szabaly', a.szabaly)
         end), '[]'::jsonb)
    from echo.campaign_audience a
   where a.campaign_id = p_campaign
$$;


-- ---------------------------------------------------------------------------
-- 2) A KI-dobozok feloldása p_items-ből
--    Ugyanaz a négy ág, mint az echo.audience_profiles()-ban (80).
-- ---------------------------------------------------------------------------
create or replace function echo.audience_who(p_items jsonb)
returns setof uuid
language plpgsql stable
set search_path = echo, public, pg_temp
as $$
declare
  v_groups text[];
  v_users  uuid[];
  v_rules  jsonb;
begin
  -- Kulon lekerdezesek: a ::uuid kasztolas a csoportsorokon is lefuthatna,
  -- ha egyetlen SELECT-ben lenne (lasd 80, 5. szakasz).
  select coalesce(array_agg(x->>'id'), '{}'::text[]) into v_groups
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'group' and coalesce(x->>'id','') <> '';
  select coalesce(array_agg((x->>'id')::uuid), '{}'::uuid[]) into v_users
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'user' and coalesce(x->>'id','') <> '';
  select coalesce(jsonb_agg(x->'szabaly'), '[]'::jsonb) into v_rules
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'filter' and jsonb_typeof(x->'szabaly') = 'object';

  return query
  select distinct s.id
    from (
      select m.profile_id as id from public.user_group_member m
       where m.group_id = any(v_groups)
      union
      select p.id from public.profiles p
        join public.user_group g on g.id = any(v_groups) and g.tipus = 'szabaly'
       where public.group_rule_matches(g.szabaly, p.id)
      union
      select u from unnest(v_users) u
      union
      select sa.profile_id from public.student_attributes sa
       where jsonb_array_length(v_rules) > 0
         and public.attr_rules_match(v_rules, sa.profile_id)
    ) s
   where s.id is not null;
end $$;


-- ---------------------------------------------------------------------------
-- 3) A (hallgató, kurzus) párok — AZ EGYETLEN MOTOR
-- ---------------------------------------------------------------------------
create or replace function echo.audience_pairs(p_campaign uuid, p_items jsonb)
returns table (student_key uuid, course_id uuid)
language plpgsql stable
set search_path = echo, public, pg_temp
as $$
declare
  v_term    text;
  v_courses uuid[];
  v_has_c   boolean;
  v_has_w   boolean;
begin
  select c.term into v_term from echo.campaign c where c.id = p_campaign;
  if not found then return; end if;

  select coalesce(array_agg((x->>'id')::uuid), '{}'::uuid[]) into v_courses
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'course' and coalesce(x->>'id','') <> '';

  v_has_c := coalesce(array_length(v_courses, 1), 0) > 0;
  v_has_w := exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
                      where (x->>'kind' in ('group','user') and coalesce(x->>'id','') <> '')
                         or (x->>'kind' = 'filter' and jsonb_typeof(x->'szabaly') = 'object'));

  return query
  -- Semmi nincs kijelolve: a felev minden kurzusa, minden hallgatoja.
  select e.student_key, e.course_id
    from echo.enrollment e join echo.course k on k.id = e.course_id
   where not v_has_c and not v_has_w
     and e.status = 'active' and k.term = v_term
  union
  -- A kijelolt kurzusok minden hallgatoja. A felev itt szandekosan nem szur:
  -- ha az admin nevesitette a kurzust, akkor azt akarja.
  select e.student_key, e.course_id
    from echo.enrollment e
   where v_has_c and e.status = 'active' and e.course_id = any(v_courses)
  union
  -- A KI-dobozok tagjai, a felevben felvett osszes kurzusukra.
  select e.student_key, e.course_id
    from echo.audience_who(p_items) w(id)
    join echo.enrollment e on e.student_key = w.id and e.status = 'active'
    join echo.course k on k.id = e.course_id and k.term = v_term
   where v_has_w;
end $$;


-- ---------------------------------------------------------------------------
-- 4) A névsor motorja (47/80 aláírás, VAGY szemantikával)
-- ---------------------------------------------------------------------------
create or replace function echo.audience_target(p_campaign uuid, p_items jsonb)
returns table (student_key uuid, kurzus int)
language sql stable
set search_path = echo, public, pg_temp
as $$
  select p.student_key, count(distinct p.course_id)::int
    from echo.audience_pairs(p_campaign, p_items) p
   group by p.student_key
$$;


-- ---------------------------------------------------------------------------
-- 5) Az összesítő — a becslés és a mentett állapot KÖZÖS számai
-- ---------------------------------------------------------------------------
create or replace function echo.audience_summary(p_campaign uuid, p_items jsonb)
returns jsonb
language plpgsql stable
set search_path = echo, public, pg_temp
as $$
declare
  v_term     text;
  v_courses  uuid[];
  v_has_c    boolean;
  v_has_w    boolean;
  v_kurzus   int;
  v_hallgato int;
  v_who      int;
  v_who_be   int;
begin
  select c.term into v_term from echo.campaign c where c.id = p_campaign;

  select coalesce(array_agg((x->>'id')::uuid), '{}'::uuid[]) into v_courses
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'course' and coalesce(x->>'id','') <> '';
  v_has_c := coalesce(array_length(v_courses, 1), 0) > 0;
  v_has_w := exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
                      where (x->>'kind' in ('group','user') and coalesce(x->>'id','') <> '')
                         or (x->>'kind' = 'filter' and jsonb_typeof(x->'szabaly') = 'object'));

  -- A kurzusszam ugyanazt a halmazt irja le, amit az eligibility_rebuild()
  -- ertekel (lasd ott): kurzus nelkul a felev osszes kurzusa.
  with p as materialized (select * from echo.audience_pairs(p_campaign, p_items))
  select (select count(distinct student_key) from p),
         case when not v_has_c
              then (select count(*) from echo.course k where k.term = v_term)
              else (select count(*) from (select unnest(v_courses)
                                          union select course_id from p) s) end
    into v_hallgato, v_kurzus;

  select count(*) into v_who from echo.audience_who(p_items);
  -- A KI-dobozok tagjai kozul hanyan vettek fel egyaltalan kurzust a felevben.
  select count(distinct e.student_key) into v_who_be
    from echo.audience_who(p_items) w(id)
    join echo.enrollment e on e.student_key = w.id and e.status = 'active'
    join echo.course k on k.id = e.course_id and k.term = v_term;

  return jsonb_build_object(
    'kurzus_szukitve',      v_has_c,
    'hallgato_szukitve',    v_has_w,
    'legfeljebb_kurzus',    coalesce(v_kurzus, 0),
    'legfeljebb_hallgato',  coalesce(v_hallgato, 0),
    'celzott_szemely',      coalesce(v_who, 0),
    'celzott_beiratkozott', coalesce(v_who_be, 0));
end $$;

commit;


begin;

-- ---------------------------------------------------------------------------
-- 6) A becslés — a NEM MENTETT javaslatból
-- ---------------------------------------------------------------------------
create or replace function public.echo_audience_preview(p_campaign uuid, p_items jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c echo.campaign%rowtype;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;
  select * into c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'ECHO_BAD_INPUT: a p_items tomb kell legyen.';
  end if;

  return jsonb_build_object('campaign_id', p_campaign, 'term', c.term,
           'megjegyzes', 'FELSO KORLAT: a kizarasi szabalyok csak az alkalmassag '
                      || 'ujraepitesekor futnak le.')
         || echo.audience_summary(p_campaign, p_items);
end $$;


-- ---------------------------------------------------------------------------
-- 7) A mentett célközönség olvasása
--    A 'sorok' és a 'kampany' blokk BETŰRE a 80-ból való; a számok az
--    összesítőből jönnek.
-- ---------------------------------------------------------------------------
create or replace function public.echo_campaign_audience(p_campaign uuid)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c       echo.campaign%rowtype;
  v_sorok jsonb;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;
  select * into c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(x order by x->>'kind', x->>'cimke'), '[]'::jsonb) into v_sorok
  from (
    select jsonb_build_object(
             'id', a.id, 'kind', a.kind,
             'ref', coalesce(a.course_id::text, a.group_id, a.profile_id::text, a.id::text),
             'szabaly', a.szabaly,
             'cimke', case a.kind
                        when 'course' then k.code || ' · ' || k.name_hu
                        when 'group'  then g.nev
                        when 'filter' then public.attr_rule_label(a.szabaly)
                        else coalesce(pr.name, pr.email) end,
             'reszlet', case a.kind
                          when 'course' then k.term
                          when 'group'  then g.tipus
                          when 'filter' then 'tulajdonság-szűrő'
                          else pr.email end) as x
      from echo.campaign_audience a
      left join echo.course       k  on k.id  = a.course_id
      left join public.user_group g  on g.id  = a.group_id
      left join public.profiles   pr on pr.id = a.profile_id
     where a.campaign_id = p_campaign
  ) s;

  return jsonb_build_object(
    'campaign_id', p_campaign, 'state', c.state, 'term', c.term,
    'kampany', jsonb_build_object(
      'id', c.id, 'code', c.code, 'name', c.name_hu, 'name_en', c.name_en,
      'term', c.term, 'state', c.state,
      'template_version_id', c.template_version_id,
      'opens_at', c.opens_at, 'closes_at', c.closes_at,
      'goals_open_at', c.goals_open_at, 'goals_close_at', c.goals_close_at),
    'sorok', v_sorok,
    'megjegyzes', 'A szamok FELSO KORLATOT jelentenek: a kizarasi szabalyok '
               || '(letszam, orarendi info, vizsgakurzus, oktatoi oraarany) csak az '
               || 'alkalmassag ujraepitesekor futnak le.')
    || echo.audience_summary(p_campaign, echo.audience_items(p_campaign));
end $$;

commit;


begin;

-- ---------------------------------------------------------------------------
-- 8) Az alkalmassági motor
--    A kizárási szabályok BETŰRE a 80-ból valók. Ami változik: a kurzushalmaz
--    és a résztvevők az echo.audience_pairs()-ból jönnek.
-- ---------------------------------------------------------------------------
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
  v_min_head  integer := (select value::integer from echo.setting where key = 'min_headcount');
  v_min_share numeric := (select value::numeric from echo.setting where key = 'min_share_pct');
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

  -- --- kurzusszintű kizárások ---
  insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
  select p_campaign, course_id, null, 'LETSZAM_ALATT',
         jsonb_build_object('letszam', headcount, 'kuszob', v_min_head)
    from _echo_c where headcount < v_min_head;

  insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
  select p_campaign, course_id, null, 'NINCS_ORARENDI_INFO', '{}'::jsonb
    from _echo_c where van_orarendi_info = false;

  insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
  select p_campaign, course_id, null, 'VIZSGAKURZUS', '{}'::jsonb
    from _echo_c where vizsgakurzus = true;

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
   where headcount >= v_min_head
     and van_orarendi_info = true
     and vizsgakurzus = false
     and teacher_count > 0;

  -- --- pár szintű kizárás: oktatói óraarány ---
  insert into echo.exclusion_log (campaign_id, course_id, teacher_id, rule_code, detail)
  select p_campaign, ct.course_id, ct.teacher_id, 'OKTATOI_ARANY_ALATT',
         jsonb_build_object('share_pct', ct.share_pct, 'kuszob', v_min_share)
    from echo.course_teacher ct
    join _echo_ok o on o.course_id = ct.course_id
   where ct.share_pct < v_min_share;

  -- --- a véleményezhető párok ---
  insert into echo.eligibility (campaign_id, course_id, teacher_id, share_pct)
  select p_campaign, ct.course_id, ct.teacher_id, ct.share_pct
    from echo.course_teacher ct
    join _echo_ok o on o.course_id = ct.course_id
   where ct.share_pct >= v_min_share
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


begin;

-- ---------------------------------------------------------------------------
-- 9) Jogosultságok — a belső segédfüggvények az echo sémában maradnak, a
--    kliens csak a public RPC-ken át éri el őket.
-- ---------------------------------------------------------------------------
revoke all on function echo.audience_items(uuid)          from public, anon, authenticated;
revoke all on function echo.audience_who(jsonb)           from public, anon, authenticated;
revoke all on function echo.audience_pairs(uuid, jsonb)   from public, anon, authenticated;
revoke all on function echo.audience_summary(uuid, jsonb) from public, anon, authenticated;

revoke all on function public.echo_audience_preview(uuid, jsonb) from public, anon;
revoke all on function public.echo_campaign_audience(uuid)       from public, anon;
grant execute on function public.echo_audience_preview(uuid, jsonb) to authenticated;
grant execute on function public.echo_campaign_audience(uuid)       to authenticated;

commit;


do $ell$
begin
  if has_function_privilege('anon', 'public.echo_audience_preview(uuid,jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja az echo_audience_preview fuggvenyt.';
  end if;
  raise notice 'Rendben: 82 — a kurzusok es a KI-dobozok VAGY kapcsolatban.';
end $ell$;
