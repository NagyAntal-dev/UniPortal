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
