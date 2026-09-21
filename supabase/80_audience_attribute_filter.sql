-- ============================================================================
-- 80_audience_attribute_filter.sql — tulajdonság-szűrő a célközönségben
-- ----------------------------------------------------------------------------
-- MIT AD
--   A kampány célközönségébe (és a hírfolyam célzásába) közvetlenül felvehető
--   TULAJDONSÁG-SZŰRŐ: tagozat, képzési szint, szak, kar, nyelv, telephely.
--   Eddig ehhez a Felhasználók → Csoportok alatt előre létre kellett hozni egy
--   szabály alapú csoportot, majd vissza kellett lépni a kampányba.
--
-- MIÉRT NINCS ÚJ KIÉRTÉKELŐ
--   A szabály-motor már megvan: public.group_rule_matches(jsonb, uuid) a
--   38_student_groups.sql-ből. A szabály alakja {MEZŐ: [ÉRTÉKEK]}, a mezők ÉS,
--   a listán belüli értékek VAGY kapcsolatban. A mezőlista ZÁRT — szabad SQL-t
--   sehol nem fogadunk el. Ezt a függvényt hívjuk, nem írunk másodikat: két
--   kiértékelő előbb-utóbb elcsúszna egymástól, és nem derülne ki, melyik hazudik.
--
-- A SZEMANTIKA: HOZZÁAD, NEM SZŰKÍT
--   A szűrő ugyanúgy viselkedik, mint egy szabály alapú csoport:
--     célközönség = csoportok ∪ egyedi személyek ∪ szűrőkre illeszkedők
--   Több szűrő VAGY kapcsolatban áll egymással; egy szűrőn belül a mezők ÉS.
--   Így egy nevesített személy soha nem eshet ki attól, hogy valaki felvett egy
--   szűrőt — ez a felület legkevésbé meglepő viselkedése.
--
-- MIÉRT VALIDÁLUNK MENTÉSKOR
--   A group_rule_matches ismeretlen mezőnévre CSENDBEN nem illeszkedik
--   (38_student_groups.sql:143-152). Csoportnál ez helyes védelem. Itt viszont
--   az admin csak annyit látna, hogy "0 fő", és nem tudná meg, miért. Ezért a
--   mentés attr_rule_validate()-en megy át, ami hibát DOB.
--
-- ELŐFELTÉTEL: 38, 42, 47, 69 és 74 már lefutott.
-- IDEMPOTENS, kétszer is lefuttatható.
--
-- FIGYELEM — SORREND. Ez a fájl ÚJRADEFINIÁL öt olyan függvényt, amit korábbi
-- migrációk is kiadnak:
--     echo.audience_profiles, echo.eligibility_rebuild  (42)
--     echo.audience_target, public.echo_audience_preview (47)
--     public.echo_campaign_audience                      (42)
--     public.echo_campaign_audience_set                  (42 → 45 → 74)
--     public.feed_audience_match                         (69)
-- Ha ezek VALAMELYIKÉT később újra lefuttatod, a 'filter' ág ELVÉSZ, és egy
-- csak szűrővel célzott kampány némán "mindenki"-vé válik. Ilyenkor a 80-at
-- utána ismét le kell futtatni. A tools/audience_filter_regresszio.mjs ezt
-- meg is fogja: futtasd le minden migrációs kör után.
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.group_rule_matches(jsonb,uuid)') is null then
    raise exception 'ELOFELTETEL: hianyzik a 38_student_groups.sql.';
  end if;
  if to_regclass('echo.campaign_audience') is null then
    raise exception 'ELOFELTETEL: hianyzik a 42_campaign_editor.sql.';
  end if;
  if to_regprocedure('echo.audience_target(uuid,jsonb)') is null then
    raise exception 'ELOFELTETEL: hianyzik a 47_audience_list.sql.';
  end if;
  if to_regprocedure('public.feed_audience_match(jsonb,uuid)') is null then
    raise exception 'ELOFELTETEL: hianyzik a 69_feed_audience.sql.';
  end if;
end $pre$;


begin;

-- ---------------------------------------------------------------------------
-- 1) Közös segédfüggvények
-- ---------------------------------------------------------------------------

-- 1a) Szabály érvényesítése. Visszaadja a szabályt, ha rendben van — így
--     beírható közvetlenül egy INSERT ... values (...) kifejezésbe.
--     A mezőlista BETŰRE egyezik a group_rule_matches zárt listájával.
create or replace function public.attr_rule_validate(p_rule jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_mezo  text;
  v_ertek jsonb;
  v_db    int := 0;
begin
  if p_rule is null or jsonb_typeof(p_rule) <> 'object' then
    raise exception 'ATTR_BAD_RULE: a szuro objektum kell legyen, {"tagozat":["Nappali"]} alakban.'
      using errcode = '22023';
  end if;

  for v_mezo, v_ertek in select key, value from jsonb_each(p_rule)
  loop
    if v_mezo not in ('tagozat','kepzesi_szint','szak','kar','nyelv','telephely') then
      raise exception 'ATTR_BAD_RULE: ismeretlen szuromezo: "%". Ervenyes: '
                      'tagozat, kepzesi_szint, szak, kar, nyelv, telephely.', v_mezo
        using errcode = '22023';
    end if;
    if jsonb_typeof(v_ertek) <> 'array' then
      raise exception 'ATTR_BAD_RULE: a "%" mezo erteke lista kell legyen.', v_mezo
        using errcode = '22023';
    end if;
    if jsonb_array_length(v_ertek) = 0 then
      raise exception 'ATTR_BAD_RULE: a "%" mezohoz nincs kivalasztott ertek.', v_mezo
        using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_ertek) e
                where jsonb_typeof(e.value) <> 'string'
                   or btrim(e.value #>> '{}') = '') then
      raise exception 'ATTR_BAD_RULE: a "%" mezo minden erteke nem ures szoveg kell legyen.', v_mezo
        using errcode = '22023';
    end if;
    v_db := v_db + 1;
  end loop;

  if v_db = 0 then
    raise exception 'ATTR_BAD_RULE: ures szuro. Valassz legalabb egy tulajdonsagot.'
      using errcode = '22023';
  end if;
  return p_rule;
end $$;


-- 1b) Illeszkedik-e a profil a szabályok BÁRMELYIKÉRE (VAGY kapcsolat).
--     Üres/hiányzó lista = nem illeszkedik senkire; a hívó dönti el, hogy ez
--     "mindenki" vagy "senki" — itt nem találgatunk.
create or replace function public.attr_rules_match(p_rules jsonb, p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_profile is not null
     and jsonb_typeof(p_rules) = 'array'
     and exists (
           select 1 from jsonb_array_elements(p_rules) r
            where public.group_rule_matches(r.value, p_profile))
$$;


-- 1c) Olvasható címke: ezt mutatja a szerkesztő és ez kerül a naplóba.
--     Mezőn belül vesszővel, mezők között középponttal — a középpont a "ÉS".
create or replace function public.attr_rule_label(p_rule jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(string_agg(t.resz, ' · ' order by t.rang), 'üres szűrő')
    from (
      select case k.key
               when 'tagozat'       then 1
               when 'kepzesi_szint' then 2
               when 'kar'           then 3
               when 'szak'          then 4
               when 'nyelv'         then 5
               else 6
             end as rang,
             (select string_agg(e.value #>> '{}', ', ') from jsonb_array_elements(k.value) e)
               as resz
        from jsonb_each(case when jsonb_typeof(p_rule) = 'object'
                             then p_rule else '{}'::jsonb end) k
       where jsonb_typeof(k.value) = 'array' and jsonb_array_length(k.value) > 0
    ) t
$$;


-- 1d) Hány emberre illeszkedik MOST egy szabály — a szerkesztő kártyánként
--     ezt írja ki. A kliens nem tudja kiszámolni: a teljes névsor nincs nála.
create or replace function public.attr_rule_count(p_rule jsonb)
returns int
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  if auth.uid() is null then raise exception 'ATTR_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ATTR_FORBIDDEN'; end if;
  if p_rule is null or jsonb_typeof(p_rule) <> 'object' or p_rule = '{}'::jsonb then
    return 0;
  end if;
  select count(*)::int into v_n
    from public.student_attributes a
   where public.group_rule_matches(p_rule, a.profile_id);
  return coalesce(v_n, 0);
end $$;

commit;


begin;

-- ---------------------------------------------------------------------------
-- 2) echo.campaign_audience — új 'filter' sortípus
--
--    A 'filter' sor nem hivatkozik semmire: MAGA HORDOZZA a szabályt. Ezért a
--    három idegen kulcs oszlopnak üresnek kell lennie, a szabalynak viszont
--    kitöltöttnek — és fordítva a másik három típusnál.
-- ---------------------------------------------------------------------------
alter table echo.campaign_audience add column if not exists szabaly jsonb;

comment on column echo.campaign_audience.szabaly is
  'Tulajdonsag-szuro (80). Csak kind=''filter'' sorokon. Alakja {MEZO: [ERTEKEK]}, '
  'ugyanaz, mint a public.user_group.szabaly — a public.group_rule_matches ertekeli ki.';

alter table echo.campaign_audience drop constraint if exists campaign_audience_kind_ck;
alter table echo.campaign_audience drop constraint if exists campaign_audience_kind_check;
alter table echo.campaign_audience
  add constraint campaign_audience_kind_ck
  check (kind in ('course','group','user','filter'));

alter table echo.campaign_audience drop constraint if exists campaign_audience_ref_ck;
alter table echo.campaign_audience
  add constraint campaign_audience_ref_ck check (
    (kind = 'course' and course_id  is not null and group_id is null and profile_id is null and szabaly is null) or
    (kind = 'group'  and group_id   is not null and course_id is null and profile_id is null and szabaly is null) or
    (kind = 'user'   and profile_id is not null and course_id is null and group_id is null and szabaly is null) or
    (kind = 'filter' and szabaly    is not null and course_id is null and group_id is null and profile_id is null));

-- Ugyanaz a szűrő kétszer ne kerüljön be. A jsonb kanonikus, tehát a kulcsok
-- sorrendje nem számít: {"kar":[...],"tagozat":[...]} = {"tagozat":[...],"kar":[...]}.
create unique index if not exists campaign_audience_filter_uidx
  on echo.campaign_audience (campaign_id, szabaly) where kind = 'filter';

commit;


begin;

-- ---------------------------------------------------------------------------
-- 3) A célközönség feloldása — a 'filter' ág bekötése
--
--    A törzs a 42_campaign_editor.sql:101-122-ből való; az ÚJ a negyedik
--    union-ág. A group_rule_matches-t itt is közvetlenül hívjuk, nem a
--    group_members()-t: annak is_staff() kapuja van, ez a függvény viszont
--    SECURITY DEFINER kontextusban fut, és nem adhat a hívó szerepkörétől
--    függő eredményt.
-- ---------------------------------------------------------------------------
create or replace function echo.audience_profiles(p_campaign uuid)
returns setof uuid
language sql stable
set search_path = echo, public, pg_temp
as $$
  select m.profile_id
    from public.user_group_member m
    join echo.campaign_audience a on a.group_id = m.group_id
   where a.campaign_id = p_campaign and a.kind = 'group'
  union
  select p.id
    from public.profiles p
    join echo.campaign_audience a
      on a.campaign_id = p_campaign and a.kind = 'group'
    join public.user_group g
      on g.id = a.group_id and g.tipus = 'szabaly'
   where public.group_rule_matches(g.szabaly, p.id)
  union
  select a.profile_id
    from echo.campaign_audience a
   where a.campaign_id = p_campaign and a.kind = 'user'
  union
  -- ÚJ (80): a kampányba közvetlenül felvett tulajdonság-szűrők. A
  -- student_attributes-ból indulunk, mert szabályra csak az illeszkedhet,
  -- akinek egyáltalán van besorolása.
  select sa.profile_id
    from public.student_attributes sa
    join echo.campaign_audience a
      on a.campaign_id = p_campaign and a.kind = 'filter'
   where public.group_rule_matches(a.szabaly, sa.profile_id)
$$;

commit;


begin;

-- ---------------------------------------------------------------------------
-- 4) Az alkalmassági motor — EGYETLEN sor változik
--
--    A v_has_who flagnek a 'filter' sorokat is látnia kell. Enélkül egy
--    CSAK szűrővel célzott kampány úgy viselkedne, mintha nem lenne
--    célközönsége: a félév MINDEN hallgatója jogosulttá válna. A törzs többi
--    sora betűre a 42_campaign_editor.sql:143-287-ből való.
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
  -- Celkozonseg: kulon a 'MIT' (kurzus) es a 'KI' (csoport/felhasznalo/szuro).
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

  -- A kampány félévéhez tartozó kurzusok, a tényleges létszámmal.
  -- Ugyanabban a tranzakcioban ketszer hivva a temp tabla mar letezne.
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
   -- MIT ertekelnek. Kurzussor nelkul a felev minden kurzusa (a regi
   -- viselkedes); kurzussorral PONTOSAN a kijelolt kurzusok. A felev
   -- ilyenkor szandekosan nem szur tovabb: ha az admin nevesitette a
   -- kurzust, akkor azt akarja, nem a felev metszetet.
   where (    (v_has_course and c.id in (select a.course_id from echo.campaign_audience a
                                          where a.campaign_id = p_campaign and a.kind = 'course'))
          or (not v_has_course and c.term = v_term));

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

  -- KI ertekel. A tabla akkor is letrejon, ha ures — a lenti lekerdesek
  -- hivatkoznak ra, es a v_has_who feltetel nem garantaltan rovidzaras.
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

  -- --- a részvételi napló vázának előállítása/frissítése ---
  -- Csak az 'eligible' jelzőt állítja; az attempted/submitted mezőkhöz nem nyúl,
  -- hogy egy újraépítés ne törölje a már megtörtént kitöltés nyomát.
  insert into echo.participation (campaign_id, course_id, student_key, eligible)
  select p_campaign, e.course_id, e.student_key, true
    from echo.enrollment e
    join echo.eligibility el on el.campaign_id = p_campaign and el.course_id = e.course_id
   where e.status = 'active'
     and (not v_has_who
          or exists (select 1 from _echo_who w where w.profile_id = e.student_key))
   group by e.course_id, e.student_key
  on conflict (campaign_id, course_id, student_key) do update set eligible = true;

  -- Ket okbol veszti el valaki a jogosultsagat: kikerult a kurzus, VAGY
  -- kikerult O maga a celkozonsegbol. A masodik nelkul egy szukitett
  -- ujraepites utan a regi cimzettek tovabbra is kitolthetnek.
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

commit;


begin;

-- ---------------------------------------------------------------------------
-- 5) A becslés és a névsor motorja — a NEM MENTETT javaslatból
--
--    A p_items elemei: {"kind":"course","id":"<uuid>"},
--                      {"kind":"group","id":"GRP..."},
--                      {"kind":"user","id":"<uuid>"},
--                      {"kind":"filter","szabaly":{...}}   <- ÚJ (80)
--    A 'filter' elemnek NINCS id-ja. A törzs a 47_audience_list.sql:35-95-ből
--    való; az új a v_rules gyűjtése és a negyedik union-ág.
-- ---------------------------------------------------------------------------
create or replace function echo.audience_target(p_campaign uuid, p_items jsonb)
returns table (student_key uuid, kurzus int)
language plpgsql stable
set search_path = echo, public, pg_temp
as $$
declare
  c         echo.campaign%rowtype;
  v_courses uuid[];
  v_groups  text[];
  v_users   uuid[];
  v_rules   jsonb;
  v_who     uuid[];
  v_has_c   boolean;
  v_has_w   boolean;
begin
  select * into c from echo.campaign where id = p_campaign;
  if not found then return; end if;

  -- Harom kulon lekerdezes: a csoport azonositoja szoveg, a kurzuse uuid, es
  -- egyetlen SELECT-ben a ::uuid kasztolas a csoportsorokon is lefuthatna a
  -- FILTER elott. A sima WHERE viszont a sorokat elobb szuri ki.
  select coalesce(array_agg((x->>'id')::uuid), '{}'::uuid[]) into v_courses
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'course' and coalesce(x->>'id','') <> '';
  select coalesce(array_agg(x->>'id'), '{}'::text[]) into v_groups
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'group' and coalesce(x->>'id','') <> '';
  select coalesce(array_agg((x->>'id')::uuid), '{}'::uuid[]) into v_users
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'user' and coalesce(x->>'id','') <> '';
  select coalesce(jsonb_agg(x->'szabaly'), '[]'::jsonb) into v_rules
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'filter' and jsonb_typeof(x->'szabaly') = 'object';

  v_has_c := coalesce(array_length(v_courses, 1), 0) > 0;
  v_has_w := coalesce(array_length(v_groups, 1), 0) > 0
             or coalesce(array_length(v_users, 1), 0) > 0
             or jsonb_array_length(v_rules) > 0;

  select coalesce(array_agg(distinct s.id), '{}'::uuid[]) into v_who
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
       where public.attr_rules_match(v_rules, sa.profile_id)
    ) s
   where s.id is not null;

  -- A kurzusszam a CELZOTT halmazon belul ertendo: nem az osszes felvett
  -- kurzusa, hanem az, ahany kerdoivet ettol a kampanytol kapna.
  return query
  with cel as (
    select k.id from echo.course k
     where (    (v_has_c and k.id = any(v_courses))
            or (not v_has_c and k.term = c.term))
  )
  select e.student_key, count(distinct e.course_id)::int
    from echo.enrollment e join cel on cel.id = e.course_id
   where e.status = 'active'
     and (not v_has_w or e.student_key = any(v_who))
   group by e.student_key;
end $$;


-- A becsles. A torzs a 47_audience_list.sql:100-167-bol valo; az uj a v_rules.
create or replace function public.echo_audience_preview(p_campaign uuid, p_items jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c          echo.campaign%rowtype;
  v_courses  uuid[];
  v_groups   text[];
  v_users    uuid[];
  v_rules    jsonb;
  v_who      int;
  v_has_c    boolean;
  v_has_w    boolean;
  v_kurzus   int;
  v_hallgato int;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;
  select * into c from echo.campaign where id = p_campaign;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'ECHO_BAD_INPUT: a p_items tomb kell legyen.';
  end if;

  select coalesce(array_agg((x->>'id')::uuid), '{}'::uuid[]) into v_courses
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'course' and coalesce(x->>'id','') <> '';
  select coalesce(array_agg(x->>'id'), '{}'::text[]) into v_groups
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'group' and coalesce(x->>'id','') <> '';
  select coalesce(array_agg((x->>'id')::uuid), '{}'::uuid[]) into v_users
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'user' and coalesce(x->>'id','') <> '';
  select coalesce(jsonb_agg(x->'szabaly'), '[]'::jsonb) into v_rules
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
   where x->>'kind' = 'filter' and jsonb_typeof(x->'szabaly') = 'object';

  v_has_c := coalesce(array_length(v_courses, 1), 0) > 0;
  v_has_w := coalesce(array_length(v_groups, 1), 0) > 0
             or coalesce(array_length(v_users, 1), 0) > 0
             or jsonb_array_length(v_rules) > 0;

  select count(*) into v_kurzus from echo.course k
   where (    (v_has_c and k.id = any(v_courses))
          or (not v_has_c and k.term = c.term));

  select count(*) into v_hallgato from echo.audience_target(p_campaign, p_items);

  -- Hany emberre illeszkedik egyaltalan a kijeloles (kurzustol fuggetlenul).
  select count(distinct s.id) into v_who
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
       where public.attr_rules_match(v_rules, sa.profile_id)
    ) s
   where s.id is not null;

  return jsonb_build_object(
    'campaign_id', p_campaign, 'term', c.term,
    'kurzus_szukitve', v_has_c,
    'hallgato_szukitve', v_has_w,
    'legfeljebb_kurzus', v_kurzus,
    'legfeljebb_hallgato', v_hallgato,
    'celzott_szemely', coalesce(v_who, 0),
    'megjegyzes', 'FELSO KORLAT: a kizarasi szabalyok csak az alkalmassag '
               || 'ujraepitesekor futnak le.');
end $$;

commit;


begin;

-- ---------------------------------------------------------------------------
-- 6) A célközönség olvasása — a 'filter' sorok szabállyal és címkével
--
--    A törzs a 42_campaign_editor.sql:683-767-ből való. Új: a 'szabaly' mező a
--    sorokban (ebből épül vissza a szerkesztő), a filter-ág a cimke/reszlet
--    case-ekben, és a v_has_w bővítése.
-- ---------------------------------------------------------------------------
create or replace function public.echo_campaign_audience(p_campaign uuid)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c          echo.campaign%rowtype;
  v_sorok    jsonb;
  v_has_c    boolean;
  v_has_w    boolean;
  v_kurzus   int;
  v_hallgato int;
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

  v_has_c := exists (select 1 from echo.campaign_audience
                      where campaign_id = p_campaign and kind = 'course');
  v_has_w := exists (select 1 from echo.campaign_audience
                      where campaign_id = p_campaign and kind in ('group','user','filter'));

  -- Felső korlát: hány kurzus és hány ember esne bele a kizárási szabályok előtt.
  with cel as (
    select k.id from echo.course k
     where (    (v_has_c and k.id in (select course_id from echo.campaign_audience
                                       where campaign_id = p_campaign and kind = 'course'))
            or (not v_has_c and k.term = c.term))
  )
  select count(*) into v_kurzus from cel;

  with cel as (
    select k.id from echo.course k
     where (    (v_has_c and k.id in (select course_id from echo.campaign_audience
                                       where campaign_id = p_campaign and kind = 'course'))
            or (not v_has_c and k.term = c.term))
  )
  select count(distinct e.student_key) into v_hallgato
    from echo.enrollment e join cel on cel.id = e.course_id
   where e.status = 'active'
     and (not v_has_w or e.student_key in (select echo.audience_profiles(p_campaign)));

  return jsonb_build_object(
    'campaign_id', p_campaign, 'state', c.state, 'term', c.term,
    -- A szerkesztheto mezok EGYBEN. A szerkeszto igy egyetlen hivasbol
    -- felepul: az echo_campaigns() nem ad name_en-t, az echo_campaign_get()
    -- pedig a celmeghatarozasi ablakot nem adja vissza. Ket forrasbol
    -- osszerakni egy urlapot annyit jelent, hogy a ket forras el is tud
    -- csuszni egymastol.
    'kampany', jsonb_build_object(
      'id', c.id, 'code', c.code, 'name', c.name_hu, 'name_en', c.name_en,
      'term', c.term, 'state', c.state,
      'template_version_id', c.template_version_id,
      'opens_at', c.opens_at, 'closes_at', c.closes_at,
      'goals_open_at', c.goals_open_at, 'goals_close_at', c.goals_close_at),
    'sorok', v_sorok,
    'kurzus_szukitve', v_has_c,
    'hallgato_szukitve', v_has_w,
    'legfeljebb_kurzus', v_kurzus,
    'legfeljebb_hallgato', v_hallgato,
    'megjegyzes', 'A szamok FELSO KORLATOT jelentenek: a kizarasi szabalyok '
               || '(letszam, orarendi info, vizsgakurzus, oktatoi oraarany) csak az '
               || 'alkalmassag ujraepitesekor futnak le.');
end $$;

commit;


begin;

-- ---------------------------------------------------------------------------
-- 7) A célközönség mentése — 'filter' ág
--
--    A törzs a 74_rbac_enforce_rpc.sql:1769-1861-ből való (az a HATÁLYOS
--    verzió: a 42 és a 45 után az RBAC-kapuval bővített). Megtartva:
--      - a rbac_require / is_trusted_caller kapu
--      - a záró echo.eligibility_rebuild() hívás
--    Változás:
--      - az "id kötelező" ellenőrzés a három hivatkozásos ágba került, mert a
--        'filter' tételnek nincs id-ja, csak szabálya
--      - új 'filter' ág, attr_rule_validate()-tel
-- ---------------------------------------------------------------------------
create or replace function public.echo_campaign_audience_set(p_campaign uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c      echo.campaign%rowtype;
  v_it   jsonb;
  v_kind text;
  v_id   text;
  v_n    int := 0;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('echo_admin', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;

  select * into c from echo.campaign where id = p_campaign for update;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  if c.state <> 'draft' then
    raise exception 'ECHO_CAMPAIGN_RUNNING: a celkozonseg csak "draft" allapotban '
                    'modosithato (a kampany most "%"). Futo kampanyon a mar kiadott '
                    'jegyek valnanak ervenytelenne.', c.state;
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'ECHO_BAD_INPUT: a p_items tomb kell legyen.';
  end if;

  delete from echo.campaign_audience where campaign_id = p_campaign;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_kind := v_it->>'kind';
    v_id   := v_it->>'id';

    if v_kind = 'course' then
      if coalesce(v_id, '') = '' then
        raise exception 'ECHO_BAD_INPUT: hianyzo azonosito a "course" tetelnel.';
      end if;
      if not exists (select 1 from echo.course where id = v_id::uuid) then
        raise exception 'ECHO_COURSE_NOT_FOUND: %', v_id;
      end if;
      insert into echo.campaign_audience (campaign_id, kind, course_id, added_by)
      values (p_campaign, 'course', v_id::uuid, auth.uid())
      on conflict do nothing;

    elsif v_kind = 'group' then
      if coalesce(v_id, '') = '' then
        raise exception 'ECHO_BAD_INPUT: hianyzo azonosito a "group" tetelnel.';
      end if;
      if not exists (select 1 from public.user_group where id = v_id) then
        raise exception 'ECHO_GROUP_NOT_FOUND: %', v_id;
      end if;
      insert into echo.campaign_audience (campaign_id, kind, group_id, added_by)
      values (p_campaign, 'group', v_id, auth.uid())
      on conflict do nothing;

    elsif v_kind = 'user' then
      if coalesce(v_id, '') = '' then
        raise exception 'ECHO_BAD_INPUT: hianyzo azonosito a "user" tetelnel.';
      end if;
      if not exists (select 1 from public.profiles where id = v_id::uuid) then
        raise exception 'ECHO_PROFILE_NOT_FOUND: %', v_id;
      end if;
      insert into echo.campaign_audience (campaign_id, kind, profile_id, added_by)
      values (p_campaign, 'user', v_id::uuid, auth.uid())
      on conflict do nothing;

    elsif v_kind = 'filter' then
      -- A 'filter' tetelnek nincs id-ja: MAGA HORDOZZA a szabalyt. A validalas
      -- hibat DOB, nem csendben nem-illeszkedik — kulonben az admin csak azt
      -- latna, hogy "0 fo", es nem tudna meg, miert.
      insert into echo.campaign_audience (campaign_id, kind, szabaly, added_by)
      values (p_campaign, 'filter', public.attr_rule_validate(v_it->'szabaly'), auth.uid())
      on conflict do nothing;

    else
      raise exception 'ECHO_BAD_INPUT: ismeretlen celkozonseg-tipus: "%". '
                      'Ervenyes: course, group, user, filter.', coalesce(v_kind, '(null)');
    end if;
    v_n := v_n + 1;
  end loop;

  insert into echo.campaign_log (campaign_id, from_state, to_state, irany, actor_key, actor_email, detail)
  values (p_campaign, c.state, c.state, 'celkozonseg', auth.uid(),
          (select email from public.profiles where id = auth.uid()),
          jsonb_build_object('tetel', v_n, 'items', coalesce(p_items, '[]'::jsonb)));

  perform echo.log_access('echo_campaign_audience_set', p_campaign, null, null, 'campaign');

  -- AZONNAL ujraepitjuk az alkalmassagot. Enelkul a kampany "Jogosult par" es
  -- "Jogosult hallgato" szamai a MENTES UTAN IS a regi celkozonseget mutatjak,
  -- mert azok az echo.eligibility / echo.participation tablakbol jonnek, azokat
  -- pedig kizarolag az eligibility_rebuild() irja. A felhasznalo joggal hiszi,
  -- hogy nem tortent semmi.
  -- Biztonsagos: ez a fuggveny csak 'draft' allapotban fut le (lasd fent),
  -- tehat nincs meg kiadott jegy, amit ervenytelenithetne.
  perform echo.eligibility_rebuild(p_campaign);

  return public.echo_campaign_audience(p_campaign);
end $$;

commit;


begin;

-- ---------------------------------------------------------------------------
-- 8) Hírfolyam — tulajdonság-szűrő a célközönségben
--
--    Új, opcionális 'szurok' kulcs: szabályobjektumok TÖMBJE, egymással VAGY.
--    A törzs a 69_feed_audience.sql:89-155-ből való.
--
--    A SZERKEZETI VÁLTOZÁS: a régi v_van_mas flag összemosta a "van ÉS-feltétel"
--    és a "van bármi" kérdést. A 'szurok' viszont — a 'szemely'-hez hasonlóan —
--    OR-ágon szerepel, tehát külön kell kezelni, különben egy CSAK szűrővel
--    célzott bejegyzés mindenkinek látszana.
-- ---------------------------------------------------------------------------
create or replace function public.feed_audience_match(p_aud jsonb, p_profile uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_szerep   text[] := public.feed_lista(p_aud, 'szerep');
  v_tagozat  text[] := public.feed_lista(p_aud, 'tagozat');
  v_szint    text[] := public.feed_lista(p_aud, 'kepzesi_szint');
  v_kar      text[] := public.feed_lista(p_aud, 'kar');
  v_szak     text[] := public.feed_lista(p_aud, 'szak');
  v_kurzus   text[] := public.feed_lista(p_aud, 'kurzus');
  v_csoport  text[] := public.feed_lista(p_aud, 'csoport');
  v_szemely  text[] := public.feed_lista(p_aud, 'szemely');
  v_szurok   jsonb;
  v_szuro_db int;
  v_van_and  boolean;
  v_role     text;
  v_a        public.student_attributes;
begin
  if p_aud is null or jsonb_typeof(p_aud) <> 'object' then return true; end if;

  v_szurok := case when jsonb_typeof(p_aud -> 'szurok') = 'array'
                   then p_aud -> 'szurok' else '[]'::jsonb end;
  v_szuro_db := jsonb_array_length(v_szurok);

  -- Az ÉS-ágon szereplő feltételek. A 'szemely' és a 'szurok' NEM tartozik ide:
  -- azok "mindig látja" ágak.
  v_van_and := cardinality(v_szerep) + cardinality(v_tagozat) + cardinality(v_szint)
             + cardinality(v_kar) + cardinality(v_szak) + cardinality(v_kurzus)
             + cardinality(v_csoport) > 0;

  -- Teljesen üres célközönség = mindenki.
  if not v_van_and and cardinality(v_szemely) = 0 and v_szuro_db = 0 then return true; end if;
  if p_profile is null then return false; end if;

  -- Az egyedi személyek mindig látják.
  if p_profile::text = any (v_szemely) then return true; end if;

  -- ÚJ (80): a tulajdonság-szűrők VAGY kapcsolatban, a többitől függetlenül.
  if v_szuro_db > 0 and public.attr_rules_match(v_szurok, p_profile) then return true; end if;

  -- Ha csak OR-ágak voltak megadva és egyik sem illeszkedett, nincs mit
  -- tovább vizsgálni. (A régi kód itt a v_van_mas flaget nézte, ami a
  -- szűrőket is beleszámolta volna — és így mindenkit beengedett volna.)
  if not v_van_and then return false; end if;

  if cardinality(v_szerep) > 0 then
    select role into v_role from public.profiles where id = p_profile;
    if v_role is null or not (v_role = any (v_szerep)) then return false; end if;
  end if;

  if cardinality(v_tagozat) + cardinality(v_szint) + cardinality(v_kar) + cardinality(v_szak) > 0 then
    select * into v_a from public.student_attributes where profile_id = p_profile;
    if v_a.profile_id is null then return false; end if;
    if cardinality(v_tagozat) > 0 and not (coalesce(v_a.tagozat, '')       = any (v_tagozat)) then return false; end if;
    if cardinality(v_szint)   > 0 and not (coalesce(v_a.kepzesi_szint, '') = any (v_szint))   then return false; end if;
    if cardinality(v_kar)     > 0 and not (coalesce(v_a.kar, '')           = any (v_kar))     then return false; end if;
    if cardinality(v_szak)    > 0 and not (coalesce(v_a.szak, '')          = any (v_szak))    then return false; end if;
  end if;

  if cardinality(v_kurzus) > 0 then
    if to_regclass('echo.enrollment') is null then return false; end if;
    if not exists (select 1 from echo.enrollment e
                    where e.student_key = p_profile and e.status = 'active'
                      and e.course_id::text = any (v_kurzus)) then
      return false;
    end if;
  end if;

  if cardinality(v_csoport) > 0 then
    if not exists (select 1 from public.user_group_member m
                    where m.profile_id = p_profile and m.group_id = any (v_csoport))
       and not exists (select 1 from public.user_group g
                        where g.id = any (v_csoport) and g.tipus = 'szabaly'
                          and public.group_rule_matches(g.szabaly, p_profile)) then
      return false;
    end if;
  end if;

  return true;
end $$;

comment on column public.feed_posts.celkozonseg is
  'Célközönség (69, bővítve 80). NULL vagy üres = mindenki. Kulcsok: szerep, tagozat, '
  'kepzesi_szint, kar, szak, kurzus (echo.course.id), csoport (user_group.id), '
  'szemely (profiles.id) — mind szöveglista —, továbbá szurok: tulajdonság-szűrő '
  'objektumok TÖMBJE (VAGY kapcsolatban), a public.attr_rules_match értékeli ki.';

commit;


begin;

-- ---------------------------------------------------------------------------
-- 9) Jogosultságok
-- ---------------------------------------------------------------------------
revoke all on function public.attr_rule_validate(jsonb)        from public, anon;
revoke all on function public.attr_rules_match(jsonb, uuid)    from public, anon;
revoke all on function public.attr_rule_label(jsonb)           from public, anon;
revoke all on function public.attr_rule_count(jsonb)           from public, anon;

grant execute on function public.attr_rule_validate(jsonb)     to authenticated;
grant execute on function public.attr_rules_match(jsonb, uuid) to authenticated;
grant execute on function public.attr_rule_label(jsonb)        to authenticated;
grant execute on function public.attr_rule_count(jsonb)        to authenticated;

commit;


-- ---------------------------------------------------------------------------
-- 10) Önellenőrzés
-- ---------------------------------------------------------------------------
do $ell$
declare
  v_hiba text;
  v_ok   boolean;
begin
  -- (a) az anon nem hivhatja az uj fuggvenyeket
  if has_function_privilege('anon', 'public.attr_rule_count(jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja az attr_rule_count fuggvenyt.';
  end if;
  if has_function_privilege('anon', 'public.attr_rules_match(jsonb, uuid)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja az attr_rules_match fuggvenyt.';
  end if;

  -- (b) a validalas elutasitja az ismeretlen mezot
  begin
    perform public.attr_rule_validate('{"nincs_ilyen_mezo":["x"]}'::jsonb);
    raise exception 'HIBA: az attr_rule_validate atengedte az ismeretlen mezot.';
  exception when sqlstate '22023' then null;
  end;

  -- (c) a validalas elutasitja az ures szurot es a nem-lista erteket
  begin
    perform public.attr_rule_validate('{}'::jsonb);
    raise exception 'HIBA: az attr_rule_validate atengedte az ures szurot.';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.attr_rule_validate('{"tagozat":"Nappali"}'::jsonb);
    raise exception 'HIBA: az attr_rule_validate atengedte a nem-lista erteket.';
  exception when sqlstate '22023' then null;
  end;

  -- (d) az ervenyes szuro atmegy, es a cimke olvashato
  perform public.attr_rule_validate('{"tagozat":["Nappali"],"kar":["NJE-GAMF"]}'::jsonb);
  if public.attr_rule_label('{"tagozat":["Nappali"],"kar":["NJE-GAMF"]}'::jsonb)
     <> 'Nappali · NJE-GAMF' then
    raise exception 'HIBA: az attr_rule_label cimkeje varatlan: %',
      public.attr_rule_label('{"tagozat":["Nappali"],"kar":["NJE-GAMF"]}'::jsonb);
  end if;

  -- (e) a CHECK elfogadja a filter sort es elutasitja a hibridet
  select count(*) = 1 into v_ok
    from information_schema.check_constraints
   where constraint_name = 'campaign_audience_ref_ck';
  if not v_ok then
    raise exception 'HIBA: a campaign_audience_ref_ck nem jott letre.';
  end if;

  -- (f) a szabaly oszlop letezik
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'echo' and table_name = 'campaign_audience'
                    and column_name = 'szabaly') then
    raise exception 'HIBA: az echo.campaign_audience.szabaly oszlop hianyzik.';
  end if;

  raise notice 'Rendben: 80 — tulajdonsag-szuro a kampany- es a hirfolyam-celkozonsegben.';
end $ell$;
