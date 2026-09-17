-- ============================================================================
-- 69_feed_audience.sql — célzott hírfolyam-bejegyzések
--
-- MIT AD
--   Az „Új bejegyzés” szerkesztőjében kiválasztható, KINEK jelenjen meg a
--   bejegyzés: szerepkör, tagozat (nappali / levelező …), képzési szint, kar,
--   szak, kurzus, csoport, egyedi személy. Üres célközönség = mindenki (a mai
--   viselkedés, a meglévő bejegyzések nem változnak).
--
-- A SZABÁLY (feed_audience_match)
--   * a különböző szempontok ÉS kapcsolatban állnak
--       (pl. tagozat = Nappali ÉS kar = GAMF);
--   * egy szemponton belül az értékek VAGY kapcsolatban
--       (pl. tagozat = Nappali VAGY Levelező);
--   * az EGYEDI SZEMÉLYEK ettől függetlenül mindig látják;
--   * ha csak személyek vannak megadva, csak ők látják;
--   * az ügyintézők (is_staff) mindig mindent látnak — kezelniük kell.
--   A tagozat / szint / kar / szak a Neptun-besorolásból (student_attributes)
--   jön: akinek nincs besorolása (pl. még csak jelentkező), arra ezek a
--   szempontok nem illeszkednek.
--
-- MIÉRT AZ ADATBÁZISBAN SZŰRÜNK
--   A hírfolyam közvetlenül a feed_posts táblát olvassa. Ha csak a felület
--   rejtené el a nem neki szóló bejegyzést, a böngésző konzoljából mégis
--   olvasható lenne. Ezért a SELECT policy dönt.
--
-- A POLICY-K
--   A feed_posts MINDEN meglévő policy-jét eldobjuk (05-ös demo policy-k, a
--   07-es approved_all, a 11-es rbac_feed_posts_*), és a 11-es névvel,
--   ugyanazzal az írási szabállyal hozzuk létre újra — csak a SELECT bővül
--   a célközönséggel. A policy-k száma és neve nem változik, így a
--   12_rbac_flip.sql ellenőrzése (86 rbac_ policy) továbbra is stimmel.
--   FIGYELEM: ez a feed_posts táblán ELŐREHOZZA a 12-es flipet (az
--   approved_all eltűnik). Írni ezután csak SUPERADMIN / ADMIN / ADMISSIONS tud
--   — a felületen is csak az ADMIN látja az „Új bejegyzés” gombot.
--   Ha a 11_rbac_additive.sql-t valaki újra lefuttatja, az a SELECT-et a régi
--   (célközönség nélküli) alakra állítja vissza: utána ezt a fájlt is újra kell
--   futtatni.
--
-- ISMERT KORLÁT
--   A célközönség JSON-ja a sorral együtt olvasható annak, aki látja a
--   bejegyzést: a célzott hallgatók látják a kurzus- / csoport- / személy-
--   azonosítókat (uuid-okat), de neveket nem. A felület ezért nem is ment
--   neveket a célközönségbe.
--
-- FÜGGŐSÉG: 05_features, 07_registration_approval, 11_rbac_additive,
--           15_echo_core (echo.course, echo.enrollment), 38_student_groups.
-- IDEMPOTENS: igen.
-- UTÁNA: a 21_echo_harden_submit.sql újrafuttatása (a szokásos szabály szerint).
-- ============================================================================

do $pre$
begin
  if to_regclass('public.feed_posts') is null then
    raise exception 'ELOFELTETEL: nincs public.feed_posts (05_features.sql).';
  end if;
  if to_regprocedure('public.is_admissions()') is null or to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.is_approved()') is null then
    raise exception 'ELOFELTETEL: hianyzik az is_admissions / is_staff / is_approved (07, 11).';
  end if;
  if to_regclass('public.student_attributes') is null or to_regclass('public.user_group') is null
     or to_regprocedure('public.group_rule_matches(jsonb,uuid)') is null then
    raise exception 'ELOFELTETEL: hianyzik a 38_student_groups.sql.';
  end if;
end $pre$;

alter table public.feed_posts add column if not exists celkozonseg jsonb;

comment on column public.feed_posts.celkozonseg is
  'Célközönség (69). NULL vagy üres = mindenki. Kulcsok: szerep, tagozat, kepzesi_szint, kar, szak, '
  'kurzus (echo.course.id), csoport (user_group.id), szemely (profiles.id) — mind szöveglista.';

-- ---------------------------------------------------------------------------
-- 1) Segéd: egy JSON-lista szövegtömbként (üres/hibás = üres tömb)
-- ---------------------------------------------------------------------------
create or replace function public.feed_lista(p_aud jsonb, p_kulcs text)
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(x) filter (where coalesce(btrim(x), '') <> ''), '{}'::text[])
    from jsonb_array_elements_text(
           case when jsonb_typeof(p_aud -> p_kulcs) = 'array' then p_aud -> p_kulcs else '[]'::jsonb end) x
$$;

-- ---------------------------------------------------------------------------
-- 2) Illeszkedik-e egy profil a célközönségre
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
  v_van_mas  boolean;
  v_role     text;
  v_a        public.student_attributes;
begin
  if p_aud is null or jsonb_typeof(p_aud) <> 'object' then return true; end if;

  v_van_mas := cardinality(v_szerep) + cardinality(v_tagozat) + cardinality(v_szint)
             + cardinality(v_kar) + cardinality(v_szak) + cardinality(v_kurzus)
             + cardinality(v_csoport) > 0;

  -- Teljesen üres célközönség = mindenki.
  if not v_van_mas and cardinality(v_szemely) = 0 then return true; end if;
  if p_profile is null then return false; end if;

  -- Az egyedi személyek mindig látják.
  if p_profile::text = any (v_szemely) then return true; end if;
  if not v_van_mas then return false; end if;

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

-- ---------------------------------------------------------------------------
-- 3) A policy-ben használt: látja-e a BEJELENTKEZETT felhasználó
--    Csak a saját illeszkedését árulja el — ezért hívható authenticated-nek.
-- ---------------------------------------------------------------------------
create or replace function public.feed_post_visible(p_aud jsonb)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p_aud is null
      or public.is_staff()
      or public.has_role('SUPERADMIN', 'ADMIN', 'ADMISSIONS')
      or public.feed_audience_match(p_aud, auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- 4) Policy-k
-- ---------------------------------------------------------------------------
alter table public.feed_posts enable row level security;

do $pol$
declare p text;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'feed_posts'
  loop
    execute format('drop policy %I on public.feed_posts', p);
  end loop;
end $pol$;

create policy "rbac_feed_posts_select" on public.feed_posts
  for select to authenticated using (public.is_approved() and public.feed_post_visible(celkozonseg));
create policy "rbac_feed_posts_insert" on public.feed_posts
  for insert to authenticated with check (public.is_admissions());
create policy "rbac_feed_posts_update" on public.feed_posts
  for update to authenticated
  using (public.is_admissions()) with check (public.is_admissions());
create policy "rbac_feed_posts_delete" on public.feed_posts
  for delete to authenticated using (public.is_admissions());

-- ---------------------------------------------------------------------------
-- 5) Előnézet a szerkesztőnek: hány fő látná (csak darabszám)
-- ---------------------------------------------------------------------------
create or replace function public.feed_audience_preview(p_aud jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then raise exception 'FEED_NOT_AUTHENTICATED'; end if;
  if not public.is_admissions() then raise exception 'FEED_FORBIDDEN'; end if;

  select jsonb_build_object(
           'osszes', count(*),
           'hallgato', count(*) filter (where p.role = 'STUDENT'),
           'oktato',   count(*) filter (where p.role = 'TEACHER'),
           'ugynok',   count(*) filter (where p.role = 'AGENT'))
    into v_out
    from public.profiles p
   where p.approval_status = 'approved'
     and coalesce(p.role, '') not in ('SUPERADMIN', 'ADMIN', 'ADMISSIONS', 'FINANCE')
     and public.feed_audience_match(p_aud, p.id);
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 6) Választható kurzusok / csoportok / személyek a szerkesztőnek
-- ---------------------------------------------------------------------------
create or replace function public.feed_audience_options(p_kind text, p_q text default null, p_limit int default 50)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_q   text := nullif(btrim(coalesce(p_q, '')), '');
  v_lim int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_out jsonb;
begin
  if auth.uid() is null then raise exception 'FEED_NOT_AUTHENTICATED'; end if;
  if not public.is_admissions() then raise exception 'FEED_FORBIDDEN'; end if;

  if p_kind = 'course' then
    if to_regclass('echo.course') is null then return '[]'::jsonb; end if;
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object('id', k.id, 'cimke', k.code || ' · ' || k.name_hu,
               'reszlet', k.term || ' · ' ||
                 (select count(*) from echo.enrollment e where e.course_id = k.id and e.status = 'active')::text || ' fő') as x
        from echo.course k
       where v_q is null or k.code ilike '%' || v_q || '%' or k.name_hu ilike '%' || v_q || '%'
       order by k.term desc, k.code
       limit v_lim
    ) s;

  elsif p_kind = 'group' then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object('id', g.id, 'cimke', g.nev,
               'reszlet', case when g.tipus = 'szabaly' then 'szabály alapú' else 'kézi' end) as x
        from public.user_group g
       where v_q is null or g.nev ilike '%' || v_q || '%'
       order by g.nev
       limit v_lim
    ) s;

  elsif p_kind = 'user' then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object('id', p.id, 'cimke', coalesce(nullif(p.name, ''), p.email),
               'reszlet', p.email || ' · ' || coalesce(p.role, '')) as x
        from public.profiles p
       where p.approval_status = 'approved'
         and coalesce(p.role, '') not in ('SUPERADMIN', 'ADMIN', 'ADMISSIONS', 'FINANCE')
         and (v_q is null or p.email ilike '%' || v_q || '%' or coalesce(p.name, '') ilike '%' || v_q || '%')
       order by coalesce(nullif(p.name, ''), p.email)
       limit v_lim
    ) s;

  else
    raise exception 'FEED_BAD_INPUT: ismeretlen tipus: %', coalesce(p_kind, '(null)');
  end if;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 7) Jogosultságok
-- ---------------------------------------------------------------------------
revoke all on function public.feed_lista(jsonb, text)               from public, anon;
revoke all on function public.feed_audience_match(jsonb, uuid)      from public, anon, authenticated;
revoke all on function public.feed_post_visible(jsonb)              from public, anon;
revoke all on function public.feed_audience_preview(jsonb)          from public, anon;
revoke all on function public.feed_audience_options(text, text, int) from public, anon;
grant execute on function public.feed_lista(jsonb, text)               to authenticated;
grant execute on function public.feed_post_visible(jsonb)              to authenticated;
grant execute on function public.feed_audience_preview(jsonb)          to authenticated;
grant execute on function public.feed_audience_options(text, text, int) to authenticated;

do $chk$
begin
  if has_function_privilege('anon', 'public.feed_audience_preview(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.feed_audience_options(text, text, int)', 'execute')
     or has_function_privilege('anon', 'public.feed_post_visible(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.feed_audience_match(jsonb, uuid)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: a feed celkozonseg-fuggvenyek jogosultsaga tul tag.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'feed_posts') <> 4 then
    raise exception 'HIBA: a feed_posts policy-k szama nem 4.';
  end if;
  raise notice 'Rendben: 69 — celzott hirfolyam-bejegyzesek (celkozonseg + RLS).';
end $chk$;
