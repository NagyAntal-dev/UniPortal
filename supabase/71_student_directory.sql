-- ============================================================================
-- 71_student_directory.sql — hallgatói nyilvántartás az ügyintézőnek
--
-- MIT AD
--   A „Képzés és oktatás → Hallgatók” képernyő adatai:
--     1. student_directory()         — kereshető, szűrhető névsor, lapozva;
--     2. student_directory_stats()   — ugyanarra a szűrésre összesítő számok;
--     3. student_directory_options() — a szűrők értékkészlete;
--     4. student_card()              — egy hallgató adatlapja.
--
-- MIÉRT RPC ÉS NEM TÁBLANÉZET
--   A meglévő public.registration_directory nézetet MINDEN bejelentkezett fiók
--   olvashatja (a nézet a tulajdonos jogán fut, és a grant 'authenticated'-nek
--   szól) — ez a pre-production jelentés egyik nyitott pontja. Az új képernyő
--   ezért nem arra épül: ezek a függvények maguk ellenőrzik, hogy a hívó
--   ügyintéző-e (is_staff), és csak akkor adnak vissza bármit.
--
-- MI NINCS BENNE — SZÁNDÉKOSAN
--   * ECHO: hogy ki mit válaszolt, sőt hogy ki töltötte ki, NEM jelenik meg.
--     A kérdőív névtelen; a kampányonkénti összesítő az ECHO képernyőé.
--   * Kollégium: az elhelyezés a Kollégium modulé. Ott van „védett lakó”
--     fogalom (bántalmazás áldozata, távoltartás), akinek a tartózkodási helye
--     szűk körnek látszik — ezt egy általános hallgatói listán megkerülni
--     súlyos hiba volna.
--   * Fizetési és okmányadat: a Pénzügy és a Felvételi képernyők kezelik.
--   A lista tehát: ki ő, mi a besorolása, milyen csoportokban van, hány
--   kurzusa és hány felvételi folyamata van.
--
-- FÜGGŐSÉG: 07 (is_approved), 08/11 (is_staff), 38_student_groups
--           (student_attributes, user_group, groups_of), valamint — ha
--           megvannak — echo.enrollment/course és public.admission_processes.
-- IDEMPOTENS: igen.
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'ELOFELTETEL: hianyzik a public.is_staff() (08/11).';
  end if;
  if to_regclass('public.student_attributes') is null then
    raise exception 'ELOFELTETEL: hianyzik a 38_student_groups.sql.';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 0) Segéd: szűrőlista szövegtömbként
-- ---------------------------------------------------------------------------
create or replace function public.dir_lista(p_szuro jsonb, p_kulcs text)
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(x) filter (where coalesce(btrim(x), '') <> ''), '{}'::text[])
    from jsonb_array_elements_text(
           case when jsonb_typeof(p_szuro -> p_kulcs) = 'array' then p_szuro -> p_kulcs else '[]'::jsonb end) x
$$;

-- ---------------------------------------------------------------------------
-- 1) A szűrt halmaz — EGY forrás a névsornak és az összesítőnek
--    (a 47_audience_list.sql elve: a szám és a mögötte megnyíló lista nem
--    csúszhat szét, mert akkor nem derül ki, melyik hazudik).
-- ---------------------------------------------------------------------------
create or replace function public.dir_target(p_q text, p_szuro jsonb)
returns table (profile_id uuid)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_q        text   := nullif(btrim(coalesce(p_q, '')), '');
  v_szerep   text[] := public.dir_lista(p_szuro, 'szerep');
  v_allapot  text[] := public.dir_lista(p_szuro, 'allapot');
  v_tagozat  text[] := public.dir_lista(p_szuro, 'tagozat');
  v_szint    text[] := public.dir_lista(p_szuro, 'kepzesi_szint');
  v_kar      text[] := public.dir_lista(p_szuro, 'kar');
  v_szak     text[] := public.dir_lista(p_szuro, 'szak');
  v_nyelv    text[] := public.dir_lista(p_szuro, 'nyelv');
  v_telep    text[] := public.dir_lista(p_szuro, 'telephely');
  v_csoport  text[] := public.dir_lista(p_szuro, 'csoport');
  v_extra    text[] := public.dir_lista(p_szuro, 'jelolo');   -- van_besorolas | van_kurzus | van_felveteli | nincs_besorolas
begin
  return query
  select p.id
    from public.profiles p
    left join public.student_attributes a on a.profile_id = p.id
   where (cardinality(v_szerep)  = 0 or coalesce(p.role, '') = any (v_szerep))
     and (cardinality(v_allapot) = 0 or coalesce(p.approval_status, '') = any (v_allapot))
     and (cardinality(v_tagozat) = 0 or coalesce(a.tagozat, '')       = any (v_tagozat))
     and (cardinality(v_szint)   = 0 or coalesce(a.kepzesi_szint, '') = any (v_szint))
     and (cardinality(v_kar)     = 0 or coalesce(a.kar, '')           = any (v_kar))
     and (cardinality(v_szak)    = 0 or coalesce(a.szak, '')          = any (v_szak))
     and (cardinality(v_nyelv)   = 0 or coalesce(a.nyelv, '')         = any (v_nyelv))
     and (cardinality(v_telep)   = 0 or coalesce(a.telephely, '')     = any (v_telep))
     and (v_q is null
          or p.email ilike '%' || v_q || '%'
          or coalesce(p.name, '')   ilike '%' || v_q || '%'
          or coalesce(a.neptun, '') ilike '%' || v_q || '%')
     and (cardinality(v_csoport) = 0
          or exists (select 1 from public.user_group_member m
                      where m.profile_id = p.id and m.group_id = any (v_csoport))
          or exists (select 1 from public.user_group g
                      where g.id = any (v_csoport) and g.tipus = 'szabaly'
                        and public.group_rule_matches(g.szabaly, p.id)))
     and (not ('van_besorolas'  = any (v_extra)) or a.profile_id is not null)
     and (not ('nincs_besorolas' = any (v_extra)) or a.profile_id is null)
     and (not ('van_kurzus'     = any (v_extra)) or public.dir_kurzus_db(p.id) > 0)
     and (not ('van_felveteli'  = any (v_extra)) or public.dir_felveteli_db(p.email) > 0);
end $$;

-- Kurzusszám és felvételiszám külön, mert a két forrás OPCIONÁLIS: ha az ECHO
-- vagy a felvételi rész nincs telepítve, a névsor akkor is működik.
create or replace function public.dir_kurzus_db(p_profile uuid)
returns int
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v int := 0;
begin
  if to_regclass('echo.enrollment') is null then return 0; end if;
  select count(*) into v from echo.enrollment e
   where e.student_key = p_profile and e.status = 'active';
  return coalesce(v, 0);
end $$;

create or replace function public.dir_felveteli_db(p_email text)
returns int
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v int := 0;
begin
  if to_regclass('public.admission_processes') is null or p_email is null then return 0; end if;
  select count(*) into v from public.admission_processes ap
   where lower(coalesce(ap.owner_email, '')) = lower(p_email);
  return coalesce(v, 0);
end $$;

-- ---------------------------------------------------------------------------
-- 2) A névsor
-- ---------------------------------------------------------------------------
create or replace function public.student_directory(
  p_q text default null, p_szuro jsonb default '{}'::jsonb,
  p_limit int default 50, p_offset int default 0
) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_lim  int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_off  int := greatest(coalesce(p_offset, 0), 0);
  v_ossz int;
  v_out  jsonb;
begin
  if auth.uid() is null then raise exception 'DIR_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'DIR_FORBIDDEN'; end if;

  select count(*) into v_ossz from public.dir_target(p_q, p_szuro);

  select coalesce(jsonb_agg(x order by x->>'nev'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'id', p.id, 'nev', coalesce(nullif(p.name, ''), p.email), 'email', p.email,
             'szerep', p.role, 'allapot', p.approval_status, 'regisztralt', p.created_at,
             'neptun', a.neptun, 'tagozat', a.tagozat, 'kepzesi_szint', a.kepzesi_szint,
             'szak', a.szak, 'kar', a.kar, 'nyelv', a.nyelv, 'telephely', a.telephely,
             'csoportok', coalesce((select array_agg(g.nev order by g.nev)
                                      from public.groups_of(p.id) g), '{}'::text[]),
             'kurzus_db', public.dir_kurzus_db(p.id),
             'felveteli_db', public.dir_felveteli_db(p.email)) as x
      from public.dir_target(p_q, p_szuro) t
      join public.profiles p on p.id = t.profile_id
      left join public.student_attributes a on a.profile_id = p.id
     order by coalesce(nullif(p.name, ''), p.email)
     limit v_lim offset v_off
  ) s;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_out),
                            'hatar', v_lim, 'eltolas', v_off, 'sorok', v_out);
end $$;

-- ---------------------------------------------------------------------------
-- 3) Összesítő — UGYANARRA a szűrésre
-- ---------------------------------------------------------------------------
create or replace function public.student_directory_stats(
  p_q text default null, p_szuro jsonb default '{}'::jsonb
) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then raise exception 'DIR_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'DIR_FORBIDDEN'; end if;

  with cel as (
    select p.id, p.role, p.approval_status, p.created_at,
           a.tagozat, a.kepzesi_szint, a.kar, a.szak, (a.profile_id is not null) as van_besorolas,
           public.dir_kurzus_db(p.id)         as kurzus_db,
           public.dir_felveteli_db(p.email)   as felveteli_db
      from public.dir_target(p_q, p_szuro) t
      join public.profiles p on p.id = t.profile_id
      left join public.student_attributes a on a.profile_id = p.id
  ), bont as (
    select 'tagozat' as mezo, coalesce(tagozat, '— nincs megadva') as ertek, count(*) as db from cel group by 2
    union all select 'kepzesi_szint', coalesce(kepzesi_szint, '— nincs megadva'), count(*) from cel group by 2
    union all select 'kar',           coalesce(kar, '— nincs megadva'),           count(*) from cel group by 2
    union all select 'szak',          coalesce(szak, '— nincs megadva'),          count(*) from cel group by 2
    union all select 'szerep',        coalesce(role, '—'),                        count(*) from cel group by 2
    union all select 'allapot',       coalesce(approval_status, '—'),             count(*) from cel group by 2
  )
  select jsonb_build_object(
    'ossz',           (select count(*) from cel),
    'besorolassal',   (select count(*) from cel where van_besorolas),
    'kurzussal',      (select count(*) from cel where kurzus_db > 0),
    'felvetelivel',   (select count(*) from cel where felveteli_db > 0),
    'kurzus_osszesen',(select coalesce(sum(kurzus_db), 0) from cel),
    'uj_30_nap',      (select count(*) from cel where created_at >= now() - interval '30 days'),
    'bontas',         (select coalesce(jsonb_object_agg(mezo, lista), '{}'::jsonb)
                         from (select mezo, jsonb_agg(jsonb_build_object('ertek', ertek, 'db', db)
                                                      order by db desc, ertek) as lista
                                 from bont group by mezo) b)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 4) A szűrők értékkészlete
-- ---------------------------------------------------------------------------
create or replace function public.student_directory_options()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then raise exception 'DIR_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'DIR_FORBIDDEN'; end if;

  select jsonb_build_object(
    'tagozat',       (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select tagozat v, count(*) n from public.student_attributes where tagozat is not null group by 1) t),
    'kepzesi_szint', (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select kepzesi_szint v, count(*) n from public.student_attributes where kepzesi_szint is not null group by 1) t),
    'kar',           (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select kar v, count(*) n from public.student_attributes where kar is not null group by 1) t),
    'szak',          (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select szak v, count(*) n from public.student_attributes where szak is not null group by 1) t),
    'nyelv',         (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select nyelv v, count(*) n from public.student_attributes where nyelv is not null group by 1) t),
    'telephely',     (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select telephely v, count(*) n from public.student_attributes where telephely is not null group by 1) t),
    'szerep',        (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select role v, count(*) n from public.profiles where role is not null group by 1) t),
    'allapot',       (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                        from (select approval_status v, count(*) n from public.profiles where approval_status is not null group by 1) t),
    'csoport',       (select coalesce(jsonb_agg(jsonb_build_object('ertek', id, 'cimke', nev) order by nev), '[]'::jsonb)
                        from public.user_group)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Egy hallgató adatlapja
-- ---------------------------------------------------------------------------
create or replace function public.student_card(p_profile uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_p     public.profiles%rowtype;
  v_a     public.student_attributes%rowtype;
  v_kurz  jsonb := '[]'::jsonb;
  v_felv  jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'DIR_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'DIR_FORBIDDEN'; end if;

  select * into v_p from public.profiles where id = p_profile;
  if not found then raise exception 'DIR_NOT_FOUND'; end if;
  select * into v_a from public.student_attributes where profile_id = p_profile;

  if to_regclass('echo.enrollment') is not null and to_regclass('echo.course') is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', k.id, 'kod', k.code, 'nev', k.name_hu, 'felev', k.term,
             'nyelv', k.lang, 'allapot', e.status) order by k.term desc, k.code), '[]'::jsonb)
      into v_kurz
      from echo.enrollment e join echo.course k on k.id = e.course_id
     where e.student_key = p_profile;
  end if;

  if to_regclass('public.admission_processes') is not null and v_p.email is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ap.id, 'ref_no', ap.ref_no, 'program_id', ap.program_id,
             'nev', ap.applicant_name, 'szakasz', ap.stage, 'kesz', ap.done,
             'letrehozva', ap.created_at, 'frissitve', ap.updated_at,
             'beadva', ap.submitted_at) order by ap.updated_at desc nulls last), '[]'::jsonb)
      into v_felv
      from public.admission_processes ap
     where lower(coalesce(ap.owner_email, '')) = lower(v_p.email);
  end if;

  return jsonb_build_object(
    'profil', jsonb_build_object('id', v_p.id, 'nev', coalesce(nullif(v_p.name, ''), v_p.email),
                'email', v_p.email, 'szerep', v_p.role, 'allapot', v_p.approval_status,
                'regisztralt', v_p.created_at),
    'jellemzok', jsonb_build_object('neptun', v_a.neptun, 'tagozat', v_a.tagozat,
                'kepzesi_szint', v_a.kepzesi_szint, 'szak', v_a.szak, 'kar', v_a.kar,
                'nyelv', v_a.nyelv, 'telephely', v_a.telephely, 'frissitve', v_a.updated_at),
    'csoportok', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'nev', g.nev, 'tipus', g.tipus)
                                            order by g.nev) from public.groups_of(p_profile) g), '[]'::jsonb),
    'kurzusok', v_kurz,
    'felveteli', v_felv);
end $$;

-- ---------------------------------------------------------------------------
-- 6) Jogosultságok
-- ---------------------------------------------------------------------------
revoke all on function public.dir_lista(jsonb, text)                       from public, anon;
revoke all on function public.dir_target(text, jsonb)                      from public, anon, authenticated;
revoke all on function public.dir_kurzus_db(uuid)                          from public, anon, authenticated;
revoke all on function public.dir_felveteli_db(text)                       from public, anon, authenticated;
revoke all on function public.student_directory(text, jsonb, int, int)     from public, anon;
revoke all on function public.student_directory_stats(text, jsonb)         from public, anon;
revoke all on function public.student_directory_options()                  from public, anon;
revoke all on function public.student_card(uuid)                           from public, anon;
grant execute on function public.student_directory(text, jsonb, int, int)  to authenticated;
grant execute on function public.student_directory_stats(text, jsonb)      to authenticated;
grant execute on function public.student_directory_options()               to authenticated;
grant execute on function public.student_card(uuid)                        to authenticated;

do $chk$
begin
  if has_function_privilege('anon', 'public.student_directory(text, jsonb, int, int)', 'execute')
     or has_function_privilege('anon', 'public.student_card(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.dir_target(text, jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: a hallgatoi nyilvantartas fuggvenyei tul tagon elerhetok.';
  end if;
  raise notice 'Rendben: 71 — hallgatoi nyilvantartas (nevsor, osszesito, adatlap).';
end $chk$;
