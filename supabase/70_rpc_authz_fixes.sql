-- ============================================================
-- UniPortal Pro — Három hiányzó jogosultság-ellenőrzés
--
-- Mindhárom SECURITY DEFINER függvény, tehát a tábla tulajdonosaként fut és
-- megkerüli az RLS-t. A hívójukat eddig senki nem nézte meg.
--
--   1. log_status_event()  — bárki, aki be van jelentkezve, tetszőleges
--      sorokat írhatott az "auditLogs" táblába. A "user" oszlopot a függvény
--      a hívó e-mailjére köti, de az action/target/changes mezők szabad
--      szövegek: a napló elönthető és félrevezető bejegyzésekkel tölthető,
--      valódi művelethez rendelve. Ráadásul a törzs "exception when others
--      then null" ága a HIBÁS naplózást is elnyeli.
--      A gyakorlatban a felület soha nem hívja közvetlenül: mindig más
--      SECURITY DEFINER függvényből fut (pl. 26_dorm.sql). Ezért az
--      authenticated jogot is elvesszük — a belső hívókat ez nem érinti,
--      mert azok a tulajdonos jogán futnak.
--
--   2. wa_window_open(text) — "írt-e nekünk ez a telefonszám az elmúlt 24
--      órában?" Bármelyik bejelentkezett felhasználó kérdezhette, tetszőleges
--      számra: ügyfél-felderítő orákulum. Maguk a wa_* táblák helyesen
--      ügyintézőre szűkítettek (10_whatsapp.sql:57-61), csak ez a kapu
--      maradt nyitva. Mostantól nem ügyintézőnek mindig hamisat ad.
--      A whatsapp-send Edge Function service_role kulccsal hívja (a 24 órás
--      ablakot a küldés előtt nézi meg), ezért az is_trusted_caller() is
--      átengedi — enélkül a szabad szöveges küldés mindig elakadna.
--
--   3. interview_free_slots(date,date,uuid) — a 28-as migráció szabad
--      interjú-idősávjai. A 28-as fájl maga írja le (392-397. sor), hogy a
--      távollét OKA érzékeny adat, és ezért van külön függvény — a
--      függvényben viszont NINCS jogosultság-ellenőrzés, tehát a hívó
--      kilistázhatta az interjúztatói kart, a munkaidőket és a távollétek
--      alakját. Jelentkezőnek látnia KELL a szabad sávokat (ebből foglal),
--      ezért nem ügyintézőre szűkítünk, hanem jóváhagyott fiókra.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt),
--   vagy: Supabase dashboard → SQL Editor → New query → beilleszt → Run
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. log_status_event ----------
create or replace function public.log_status_event(
  p_action  text,
  p_target  text,
  p_changes text
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public."auditLogs" ("id", "timestamp", "user", "action", "target", "changes")
  values (
    'LOG-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12),
    to_char(now(), 'YYYY.MM.DD HH24:MI'),
    coalesce(nullif(public.my_email(), ''), 'system (SQL)'),
    p_action,
    p_target,
    p_changes
  );
exception when others then
  -- A naplózás soha ne buktassa el a felvételi műveletet. A hiba viszont
  -- KERÜLJÖN A NAPLÓBA — eddig csendben elveszett.
  raise warning 'log_status_event: a naplobejegyzes nem jott letre: %', sqlerrm;
end
$$;

revoke all on function public.log_status_event(text, text, text) from public, anon, authenticated;

-- ---------- 2. wa_window_open ----------
create or replace function public.wa_window_open(p_wa_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select (public.is_staff() or public.is_trusted_caller()) and coalesce(
    (select last_inbound_at > now() - interval '24 hours' from public.wa_contacts where wa_id = p_wa_id),
    false)
$$;

revoke all on function public.wa_window_open(text) from public, anon;
grant execute on function public.wa_window_open(text) to authenticated;

-- ---------- 3. interview_free_slots ----------
-- A törzs a 61-es migrációéval BETŰRE azonos; csak a "begin" után került be
-- a jogosultság-ellenőrzés. (A 28-as migráció eredeti törzsét a 61-es már
-- felülírta, ezért abból indulunk ki.)
create or replace function public.interview_free_slots(
  p_from        date default null,
  p_to          date default null,
  p_interviewer uuid default null
)
returns table (
  iv_id      uuid,
  iv_name    text,
  slot_start timestamptz,
  slot_end   timestamptz,
  slot_day   date,
  slot_label text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tz       text    := public.interview_tz();
  v_min      integer := public.interview_slot_minutes();
  v_break    integer := public.interview_break_minutes();
  v_horizon  integer := public.interview_setting_int('booking_horizon_days', 30);
  v_lead     integer := public.interview_setting_int('lead_time_hours', 2);
  v_from     date;
  v_to       date;
  v_earliest timestamptz := now() + make_interval(hours => v_lead);
begin
  -- JOGOSULTSÁG. A 28-as migráció fejléce (392-397. sor) kimondja, hogy a
  -- távollét OKA érzékeny, és ezért számol külön függvény szabad sávokat —
  -- a függvény maga viszont eddig senkit nem ellenőrzött, tehát bárki
  -- kilistázhatta az interjúztatói kart, a munkaidőket és a távollétek
  -- alakját. A jelentkezőnek LÁTNIA KELL a szabad sávokat (ebből foglal),
  -- ezért nem ügyintézőre szűkítünk, hanem jóváhagyott fiókra.
  if not (public.is_approved() or public.is_trusted_caller()) then
    raise exception 'A szabad interjú-idősávok megtekintéséhez jóváhagyott fiók kell.'
      using errcode = 'insufficient_privilege';
  end if;

  v_from := coalesce(p_from, (now() at time zone v_tz)::date);
  v_to   := coalesce(p_to,   v_from + v_horizon);
  if v_to < v_from then v_to := v_from; end if;
  if v_to > v_from + v_horizon then v_to := v_from + v_horizon; end if;

  return query
  with days as (
    select d::date as day, extract(isodow from d)::smallint as dow
      from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d
  ),
  av as (
    select a.interviewer as ikey, a.weekday, a.start_time, a.end_time,
           a.valid_from, a.valid_to
      from public.interview_availability a
      join public.interview_interviewer i
        on i.interviewer = a.interviewer and i.active
     where a.active
       and (p_interviewer is null or a.interviewer = p_interviewer)
  ),
  cand as (
    select av.ikey,
           d.day,
           d.dow,
           gs                                   as local_start,
           gs + make_interval(mins => v_min)    as local_end
      from days d
      join av
        on av.weekday = d.dow
       and (av.valid_from is null or d.day >= av.valid_from)
       and (av.valid_to   is null or d.day <= av.valid_to)
      cross join lateral generate_series(
             d.day + av.start_time,
             d.day + av.end_time - make_interval(mins => v_min),
             make_interval(mins => v_min + v_break)) as gs
  ),
  cand_tz as (
    select c.ikey, c.day, c.dow, c.local_start, c.local_end,
           (c.local_start at time zone v_tz) as st,
           (c.local_end   at time zone v_tz) as en
      from cand c
  )
  select distinct
         c.ikey,
         public.interview_name(c.ikey),
         c.st,
         c.en,
         c.day,
         to_char(c.local_start, 'HH24:MI') || '–' || to_char(c.local_end, 'HH24:MI')
    from cand_tz c
   where c.st >= v_earliest
     and not exists (
           select 1 from public.interview_break b
            where b.active
              and (b.interviewer is null or b.interviewer = c.ikey)
              and (b.weekday is null or b.weekday = c.dow)
              and c.local_start < (c.day + b.end_time)
              and c.local_end   > (c.day + b.start_time))
     and not exists (
           select 1 from public.interview_absence ab
            where ab.interviewer = c.ikey
              and c.st < ab.ends_at and c.en > ab.starts_at)
     and not exists (
           select 1 from public."interviewSlots" s
            where s."interviewerKey" = c.ikey
              and coalesce(s.status, '') not in ('Cancelled', 'Declined')
              and c.st < s."endTime"   + make_interval(mins => v_break)
              and c.en > s."startTime" - make_interval(mins => v_break))
   order by 3, 2;
end;
$fn$;


revoke all on function public.interview_free_slots(date, date, uuid) from public, anon;
grant execute on function public.interview_free_slots(date, date, uuid) to authenticated;

-- ---------- 4. ellenőrzés ----------
do $blk$
begin
  if has_function_privilege('anon', 'public.wa_window_open(text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a wa_window_open fuggvenyt.';
  end if;
  if has_function_privilege('authenticated', 'public.log_status_event(text,text,text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az authenticated kozvetlenul hivhatja a log_status_event fuggvenyt.';
  end if;
  raise notice 'Rendben: log_status_event zarva, wa_window_open ugyintezore szukitve.';
end $blk$;
