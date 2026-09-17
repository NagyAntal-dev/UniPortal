-- ============================================================================
-- 67_echo_campaign_students_status.sql — a kitöltöttség NÉVTELEN összesítője
--                                          a „Jogosult hallgatók” listához
--
-- MIÉRT KELL
--   Az ügyintéző a kampány jogosult hallgatóinál látni szeretné, hol tart a
--   kitöltés: hány kurzusértékelés nem kezdődött el, hány van folyamatban, és
--   hány kész. Eddig csak a névsor és a jegyek száma látszott.
--
-- A DÖNTÉS: CSAK ÖSSZESÍTŐ, NEVEK NÉLKÜL (egyeztetve, 2026-09-17)
--   Névenkénti állapotot SZÁNDÉKOSAN nem adunk ki:
--     * a „kész” egyenként nem is ismerhető: a beküldés munkamenet nélküli,
--       névtelen jeggyel megy, és a participation.submitted jelzőt az
--       echo.mark_submitted() KÖTEGELVE, a kampány lezárásakor teszi fel —
--       egyenkénti jelölés elárulná, ki mikor küldött be (15_echo_core.sql);
--     * az adatkezelési tájékoztató szerint a részvételt azért rögzítjük, hogy
--       ne kérjük újra a kitöltést — ügyintézői névenkénti figyelés új cél lenne.
--   Az összesítő a kampány összes kurzusértékelésén (hallgató × kurzus) számol,
--   így ugyanazt a szintet mutatja, mint a kampánykártya jegy-darabszáma.
--
-- AZ ÁLLAPOTOK (kurzusértékelésenként, csak a jogosult sorokon)
--   kesz        submitted (a kötegelt jelölés után)
--   elkezdte    nem submitted, és jegyet kért (attempted) VAGY élő piszkozata van
--   nem_kezdte  egyik sem
--   A 'kampany_allapot' mellé kerül, hogy a felület eldönthesse: nyitott
--   kampánynál a „kész” szám még nem értelmezhető (0-nak látszana).
--
-- A FÜGGVÉNY TÖBBI RÉSZE BETŰRE VÁLTOZATLAN a 47_audience_list.sql-hez képest:
-- ugyanaz a jogosultság-ellenőrzés, névsor, szűrés, korlát és visszatérési alak;
-- csak a 'statusz' kulcs új. A felület a migráció előtt is működik (a kulcs
-- hiányában egyszerűen nem mutat összesítőt).
--
-- FÜGGŐSÉG: 15_echo_core.sql, 22_echo_draft.sql, 47_audience_list.sql
-- IDEMPOTENS: create or replace.
-- UTÁNA: a 21_echo_harden_submit.sql újrafuttatása (a szokásos szabály szerint).
-- ============================================================================

create or replace function public.echo_campaign_students(
  p_campaign uuid, p_q text default null, p_limit int default 300
) returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  v_q      text := nullif(btrim(coalesce(p_q, '')), '');
  v_lim    int  := least(greatest(coalesce(p_limit, 300), 1), 2000);
  v_ossz   int;
  v_out    jsonb;
  v_state  text;
  v_status jsonb;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;
  select state into v_state from echo.campaign where id = p_campaign;
  if v_state is null then
    raise exception 'ECHO_CAMPAIGN_NOT_FOUND';
  end if;

  select count(distinct student_key) into v_ossz
    from echo.participation where campaign_id = p_campaign and eligible;

  select coalesce(jsonb_agg(x order by x->>'nev'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'profile_id', p.id,
             'nev', coalesce(p.name, p.email),
             'email', p.email,
             'tagozat', a.tagozat, 'kepzesi_szint', a.kepzesi_szint,
             'szak', a.szak, 'kar', a.kar,
             'kurzus', count(distinct pa.course_id)) as x
      from echo.participation pa
      join public.profiles p on p.id = pa.student_key
      left join public.student_attributes a on a.profile_id = p.id
     where pa.campaign_id = p_campaign and pa.eligible
       and (v_q is null or p.email ilike '%'||v_q||'%' or coalesce(p.name,'') ilike '%'||v_q||'%')
     group by p.id, p.name, p.email, a.tagozat, a.kepzesi_szint, a.szak, a.kar
     order by coalesce(p.name, p.email)
     limit v_lim
  ) s;

  -- ÚJ: névtelen összesítő, a szűrőtől FÜGGETLENÜL a teljes kampányra.
  select jsonb_build_object(
           'egyseg',     count(*),
           'kesz',       count(*) filter (where pa.submitted),
           'elkezdte',   count(*) filter (where not pa.submitted and (pa.attempted or d.student_key is not null)),
           'nem_kezdte', count(*) filter (where not pa.submitted and not pa.attempted and d.student_key is null),
           'kampany_allapot', v_state)
    into v_status
    from echo.participation pa
    left join echo.draft d
      on d.campaign_id = pa.campaign_id and d.course_id = pa.course_id
     and d.student_key = pa.student_key and d.expires_at > now()
   where pa.campaign_id = p_campaign and pa.eligible;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_out),
                            'hatar', v_lim, 'sorok', v_out, 'statusz', v_status);
end $$;

-- Jogosultságok: ugyanaz, mint a 47-ben (a create or replace megtartja az ACL-t,
-- de a Supabase alapjogai miatt kifejezetten újra rögzítjük).
revoke all on function public.echo_campaign_students(uuid, text, int) from public;
revoke all on function public.echo_campaign_students(uuid, text, int) from anon;
grant execute on function public.echo_campaign_students(uuid, text, int) to authenticated;

do $blk$
begin
  if has_function_privilege('anon', 'public.echo_campaign_students(uuid, text, int)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja az echo_campaign_students fuggvenyt.';
  end if;
  raise notice 'Rendben: 67 — az echo_campaign_students statusz osszesitovel bovitve (nevek nelkul).';
end $blk$;
