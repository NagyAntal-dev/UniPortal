-- ============================================================================
-- 72_teacher_stats.sql — oktatói összesítő az oktatói lapra
--
-- MIT AD
--   Az „Oktatók” képernyőn egy oktatóra kattintva eddig a törzsadat, a
--   kurzus-hozzárendelések és a fiók-kötés látszott. Ez a függvény adja hozzá
--   a SZÁMOKAT: hány kurzusa van, hány hallgatója, félévenkénti bontásban,
--   kurzusonkénti létszámmal, és mennyire érintett a kampányokban.
--
--   Egy hallgató TÖBB kurzusán is ott lehet, ezért kétféle szám kell:
--     hallgato_ossz      — KÜLÖNBÖZŐ hallgatók száma az összes kurzusán;
--     kurzusfelvetel_ossz — kurzusfelvételek száma (a kettő nem ugyanaz).
--   Ugyanez a bontás félévenként is megvan.
--
-- MI NEM SZEREPEL BENNE — SZÁNDÉKOSAN
--   Semmilyen ÉRTÉKELÉSI EREDMÉNY: sem átlag, sem válaszszöveg, sem az, hogy
--   ki töltötte ki. A kurzusértékelés névtelen, az eredmény a k-küszöbökhöz
--   kötött „Oktatói eredmények” képernyőé. Itt csak SZERKEZETI adat van:
--   kurzus, létszám, jogosultság-darabszám.
--   A 'valasz_db' szándékosan NINCS benne: nyitott kampányban a beérkezett
--   válaszok darabszáma egy egy-két hallgatós kurzusnál elárulná, ki küldött be.
--
-- FÜGGŐSÉG: 15_echo_core (echo.course, enrollment, eligibility, exclusion_log),
--           54_teacher_registry (echo.teacher, echo.course_teacher).
-- IDEMPOTENS: igen.
-- UTÁNA: a 21_echo_harden_submit.sql újrafuttatása (a szokásos szabály szerint).
-- ============================================================================

do $pre$
begin
  if to_regclass('echo.teacher') is null or to_regclass('echo.course_teacher') is null then
    raise exception 'ELOFELTETEL: hianyzik az 54_teacher_registry.sql.';
  end if;
end $pre$;

create or replace function public.echo_teacher_stats(p_teacher uuid)
returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  t      echo.teacher%rowtype;
  v_out  jsonb;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;

  select * into t from echo.teacher where id = p_teacher;
  if t.id is null then raise exception 'ECHO_TEACHER_NOT_FOUND'; end if;

  with kurzus as (
    select c.id, c.code, c.name_hu, c.term, ct.role, ct.share_pct,
           (select count(*) from echo.enrollment e
             where e.course_id = c.id and e.status = 'active') as felvett
      from echo.course_teacher ct
      join echo.course c on c.id = ct.course_id
     where ct.teacher_id = t.id
  ), felev as (
    select k.term,
           count(*)                       as kurzus_db,
           coalesce(sum(k.felvett), 0)    as felvetel_db,
           (select count(distinct e.student_key)
              from echo.enrollment e
              join kurzus k2 on k2.id = e.course_id
             where k2.term = k.term and e.status = 'active') as hallgato_db
      from kurzus k
     group by k.term
  )
  select jsonb_build_object(
    'teacher_id', t.id,
    'kurzus_ossz',          (select count(*) from kurzus),
    'kurzusfelvetel_ossz',  (select coalesce(sum(felvett), 0) from kurzus),
    'hallgato_ossz',        (select count(distinct e.student_key)
                               from echo.enrollment e
                               join kurzus k on k.id = e.course_id
                              where e.status = 'active'),
    'aktualis_felev',       (select max(term) from kurzus),
    'felevek',              (select coalesce(jsonb_agg(jsonb_build_object(
                                      'felev', term, 'kurzus', kurzus_db,
                                      'hallgato', hallgato_db, 'felvetel', felvetel_db)
                                    order by term desc), '[]'::jsonb) from felev),
    'kurzusok',             (select coalesce(jsonb_object_agg(id::text, felvett), '{}'::jsonb) from kurzus),
    'szerepek',             (select coalesce(jsonb_object_agg(role, db), '{}'::jsonb)
                               from (select coalesce(role, 'oktato') as role, count(*) as db
                                       from kurzus group by 1) r),
    'atlag_share',          (select round(avg(share_pct)::numeric, 1) from kurzus where share_pct is not null),
    -- Kampánybeli érintettség: hány kampány jogosultsági listájára került fel,
    -- és hány hallgató × kurzus pár tartozik hozzá. Ez NEM eredmény.
    'kampany_db',           (select count(distinct x.campaign_id) from echo.eligibility x where x.teacher_id = t.id),
    'jogosultsag_db',       (select count(*) from echo.eligibility x where x.teacher_id = t.id),
    'kizaras_db',           (select count(*) from echo.exclusion_log x where x.teacher_id = t.id)
  ) into v_out;

  return v_out;
end $$;

revoke all on function public.echo_teacher_stats(uuid) from public, anon;
grant execute on function public.echo_teacher_stats(uuid) to authenticated;

do $chk$
begin
  if has_function_privilege('anon', 'public.echo_teacher_stats(uuid)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja az echo_teacher_stats fuggvenyt.';
  end if;
  raise notice 'Rendben: 72 — oktatoi osszesito (kurzus, letszam, felevek).';
end $chk$;
