-- ============================================================================
-- 61_interview_calendar.sql
-- UniPortal — interjúnaptár: szünet két interjú között, ügyintézői naptár,
-- jelentkező hozzárendelése, elutasítás új időpont javaslatával
--
-- MIT CSINÁL
--   1) break_minutes beállítás (alap: 5 perc). A jelentkezőnek felkínált sávok
--      és a jelentkezői foglalás ennyi szünetet hagynak két interjú között.
--   2) Az interjú a FELVÉTELI FOLYAMATHOZ kötődik (interviewSlots.process_id).
--      Eddig csak a régi students sorhoz kötődhetett, a felvételi folyamat
--      varázslója pedig beégetett, adatbázisban nem létező időpontokat kínált.
--   3) Új állapotok: Proposed (az iroda javasolta, a jelentkező még nem fogadta
--      el), Declined (az iroda elutasította a jelentkező foglalását), Completed.
--   4) RPC-k a naptárhoz és a jelentkezőhöz: események lekérése, hozzárendelés,
--      áthelyezés (húzás / átméretezés), elutasítás + új időpont javaslata,
--      lemondás, a javaslat elfogadása vagy elutasítása, foglalás a folyamathoz.
--   5) Minden változás bekerül a folyamat data.interview kulcsába is (a listák
--      innen olvasnak), az iroda lépéseiről pedig a jelentkező üzenetet kap.
--
-- AZ ÜGYINTÉZŐ ÉS A JELENTKEZŐ SZABÁLYA ELTÉR
--   • Jelentkező: csak az interjúztató elérhetőségén belül, az ebédszüneten és a
--     távolléten kívül, a két interjú közti szünetet is megtartva foglalhat.
--   • Ügyintéző (naptár): bárhová teheti az interjút, csak ugyanannak az
--     interjúztatónak két interjúja nem fedheti egymást — mint az Outlookban.
--     A munkaidőn kívüli időpontot a felület jelzi, de nem tiltja.
--
-- Előfeltétel: 28, 30, 31 és 60. Idempotens, többször is lefuttatható.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) Szünet két interjú között
-- ---------------------------------------------------------------------------
insert into public.interview_setting (key, value, label) values
  ('break_minutes', '5', 'Szünet két interjú között (perc)')
on conflict (key) do nothing;

-- Külön olvasó, mert az interview_setting_int() a 0-t "nincs beállítva"-ként
-- kezeli — itt viszont a 0 perc érvényes érték (nincs szünet).
create or replace function public.interview_break_minutes()
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v text;
  n integer;
begin
  select s.value into v from public.interview_setting s where s.key = 'break_minutes';
  if v is null then return 0; end if;
  begin
    n := trim(v)::integer;
  exception when others then
    return 0;
  end;
  return least(greatest(coalesce(n, 0), 0), 120);
end
$fn$;

revoke all on function public.interview_break_minutes() from public, anon;
grant execute on function public.interview_break_minutes() to authenticated;

-- A 28-as mentés, kibővítve az új kulccsal (0–120 perc).
create or replace function public.interview_setting_save(p_key text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_n integer;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'A foglalási beállításokat csak rendszergazda módosíthatja.' using errcode = '42501';
  end if;
  if p_key not in ('slot_minutes', 'timezone', 'booking_horizon_days', 'lead_time_hours', 'break_minutes') then
    raise exception 'Ismeretlen beállítás: %', p_key using errcode = '22023';
  end if;

  if p_key = 'timezone' then
    begin
      perform now() at time zone p_value;
    exception when others then
      raise exception 'Ismeretlen időzóna: % (pl. Europe/Budapest).', p_value using errcode = '22023';
    end;
  else
    begin
      v_n := trim(p_value)::integer;
    exception when others then
      raise exception 'A(z) "%" beállítás értéke szám kell legyen.', p_key using errcode = '22023';
    end;
    if p_key = 'slot_minutes' and (v_n < 5 or v_n > 240) then
      raise exception 'Az idősáv hossza 5 és 240 perc között lehet.' using errcode = '22023';
    end if;
    if p_key = 'break_minutes' and (v_n < 0 or v_n > 120) then
      raise exception 'A két interjú közti szünet 0 és 120 perc között lehet.' using errcode = '22023';
    end if;
    if v_n < 0 then
      raise exception 'A(z) "%" beállítás nem lehet negatív.', p_key using errcode = '22023';
    end if;
  end if;

  update public.interview_setting
     set value = trim(p_value), updated_at = now(), updated_by = auth.uid()
   where key = p_key;
  if not found then
    raise exception 'Ismeretlen beállítás: %', p_key using errcode = '22023';
  end if;

  return jsonb_build_object('key', p_key, 'value', trim(p_value),
                            'slot_minutes', public.interview_slot_minutes(),
                            'break_minutes', public.interview_break_minutes());
end
$fn$;

revoke all on function public.interview_setting_save(text, text) from public, anon;
grant execute on function public.interview_setting_save(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Az interjú a felvételi folyamathoz kötődik
-- ---------------------------------------------------------------------------
alter table public."interviewSlots"
  add column if not exists process_id    text,
  add column if not exists note          text,
  add column if not exists previous_slot text,
  add column if not exists created_by    uuid,
  add column if not exists updated_at    timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'interviewslots_process_fk') then
    alter table public."interviewSlots"
      add constraint interviewslots_process_fk
      foreign key (process_id) references public.admission_processes (id) on delete cascade;
  end if;
end $$;

create index if not exists interviewslots_process_idx
  on public."interviewSlots" (process_id) where process_id is not null;

comment on column public."interviewSlots".process_id is
  'A felvételi folyamat (admission_processes.id), amelyhez az interjú tartozik.';
comment on column public."interviewSlots".previous_slot is
  'Időpont-javaslatnál: az elutasított foglalás azonosítója.';

-- Állapotok
alter table public."interviewSlots" drop constraint if exists "interviewSlots_status_check";
alter table public."interviewSlots"
  add constraint "interviewSlots_status_check"
  check (status in ('Available', 'Booked', 'Cancelled', 'Proposed', 'Declined', 'Completed'));

-- Az ütközési megszorítás az elutasított sort is szabadnak tekinti.
alter table public."interviewSlots" drop constraint if exists interviewslots_no_overlap;
alter table public."interviewSlots"
  add constraint interviewslots_no_overlap
  exclude using gist (
    (coalesce("interviewerKey"::text, "interviewerId")) with =,
    tstzrange("startTime", "endTime", '[)') with &&
  )
  where (coalesce(status, '') not in ('Cancelled', 'Declined'));

comment on constraint interviewslots_no_overlap on public."interviewSlots" is
  'Egy interjúztatónak nem lehet két átfedő, élő (nem lemondott, nem elutasított) interjúja.';

drop index if exists public.interviewslots_one_live_per_student;
create unique index interviewslots_one_live_per_student
  on public."interviewSlots" ("studentId")
  where "studentId" is not null
    and coalesce(status, '') not in ('Cancelled', 'Completed', 'Declined');

create unique index if not exists interviewslots_one_live_per_process
  on public."interviewSlots" (process_id)
  where process_id is not null and status in ('Booked', 'Proposed');

-- ---------------------------------------------------------------------------
-- 3) A foglalhatóság szabálya — jelentkező és ügyintéző külön
-- ---------------------------------------------------------------------------
create or replace function public.interview_slot_blocked_reason_ex(
  p_interviewer  uuid,
  p_start        timestamptz,
  p_end          timestamptz,
  p_exclude_slot text,
  p_staff        boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tz    text    := public.interview_tz();
  v_break integer := case when coalesce(p_staff, false) then 0 else public.interview_break_minutes() end;
  v_ls    timestamp;
  v_le    timestamp;
  v_day   date;
  v_dow   smallint;
  v_label text;
begin
  if p_interviewer is null then return null; end if;
  if p_start is null or p_end is null then
    return 'Az idősáv kezdete és vége is kötelező.';
  end if;
  if p_end <= p_start then
    return 'Az idősáv vége nem lehet a kezdete előtt.';
  end if;
  if p_end - p_start > interval '4 hours' then
    return 'Egy interjú legfeljebb 4 órás lehet.';
  end if;

  v_ls  := (p_start at time zone v_tz);
  v_le  := (p_end   at time zone v_tz);
  v_day := v_ls::date;
  v_dow := extract(isodow from v_day)::smallint;

  if not exists (select 1 from public.interview_interviewer i
                  where i.interviewer = p_interviewer and i.active) then
    return 'A választott interjúztató nem szerepel az aktív interjúztatók között.';
  end if;

  if not coalesce(p_staff, false) then
    -- (a) egészében az interjúztató elérhetőségén belül
    if not exists (
         select 1 from public.interview_availability a
          where a.interviewer = p_interviewer
            and a.active
            and a.weekday = v_dow
            and (a.valid_from is null or v_day >= a.valid_from)
            and (a.valid_to   is null or v_day <= a.valid_to)
            and v_ls >= (v_day + a.start_time)
            and v_le <= (v_day + a.end_time)) then
      return 'A kért időpont kívül esik az interjúztató elérhetőségén.';
    end if;

    -- (b) ismétlődő kizárás (ebédszünet)
    select coalesce(nullif(trim(b.label), ''), 'kizárt idősáv') into v_label
      from public.interview_break b
     where b.active
       and (b.interviewer is null or b.interviewer = p_interviewer)
       and (b.weekday is null or b.weekday = v_dow)
       and v_ls < (v_day + b.end_time)
       and v_le > (v_day + b.start_time)
     limit 1;
    if v_label is not null then
      return 'A kért időpont kizárt idősávra esik: ' || v_label || '.';
    end if;

    -- (c) távollét — az indoklást nem írjuk ki, a jelentkező is látja
    if exists (
         select 1 from public.interview_absence ab
          where ab.interviewer = p_interviewer
            and p_start < ab.ends_at
            and p_end   > ab.starts_at) then
      return 'Az interjúztató a kért időpontban nem elérhető (bejelentett távollét).';
    end if;
  end if;

  -- (d) ütközés egy élő interjúval
  if exists (
       select 1 from public."interviewSlots" s
        where s."interviewerKey" = p_interviewer
          and (p_exclude_slot is null or s.id <> p_exclude_slot)
          and coalesce(s.status, '') not in ('Cancelled', 'Declined')
          and p_start < s."endTime"
          and p_end   > s."startTime") then
    return 'A kért időpont ütközik egy már kiadott interjú-időponttal.';
  end if;

  -- (e) a két interjú közti szünet — csak a jelentkezői foglalásnál
  if v_break > 0 and exists (
       select 1 from public."interviewSlots" s
        where s."interviewerKey" = p_interviewer
          and (p_exclude_slot is null or s.id <> p_exclude_slot)
          and coalesce(s.status, '') not in ('Cancelled', 'Declined')
          and p_start < s."endTime"   + make_interval(mins => v_break)
          and p_end   > s."startTime" - make_interval(mins => v_break)) then
    return 'A kért időpont túl közel esik egy másik interjúhoz: két interjú között ' || v_break || ' perc szünet kell.';
  end if;

  return null;
end
$fn$;

revoke all on function public.interview_slot_blocked_reason_ex(uuid, timestamptz, timestamptz, text, boolean) from public, anon;
grant execute on function public.interview_slot_blocked_reason_ex(uuid, timestamptz, timestamptz, text, boolean) to authenticated;

-- A régi név a jelentkezői szabályt jelenti (a 28-as hívók változatlanok).
create or replace function public.interview_slot_blocked_reason(
  p_interviewer  uuid,
  p_start        timestamptz,
  p_end          timestamptz,
  p_exclude_slot text default null
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.interview_slot_blocked_reason_ex(p_interviewer, p_start, p_end, p_exclude_slot, false)
$fn$;

-- ---------------------------------------------------------------------------
-- 4) A szabad sávok — a szünettel
-- ---------------------------------------------------------------------------
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

grant execute on function public.interview_free_slots(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Triggerek
-- ---------------------------------------------------------------------------
-- Időpont-kapu: az ügyintézőnél csak az ütközést nézi, a jelentkezőnél mindent.
-- A javaslat elfogadása (Proposed → Booked, ugyanaz az időpont) nem új foglalás.
create or replace function public.interviewslots_availability_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_reason  text;
  v_recheck boolean := true;
begin
  if new."interviewerKey" is null then
    return new;
  end if;
  if coalesce(new.status, '') in ('Cancelled', 'Declined', 'Completed') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_recheck := (old."interviewerKey" is distinct from new."interviewerKey")
              or (old."startTime"      is distinct from new."startTime")
              or (old."endTime"        is distinct from new."endTime")
              or (coalesce(new.status, '') in ('Booked', 'Proposed')
                  and coalesce(old.status, '') not in ('Booked', 'Proposed'));
  end if;
  if not v_recheck then return new; end if;

  v_reason := public.interview_slot_blocked_reason_ex(
                new."interviewerKey", new."startTime", new."endTime", new.id,
                coalesce(public.is_staff(), false));
  if v_reason is not null then
    raise exception '%', v_reason
      using errcode = '42501',
            hint    = 'Az elérhetőséget, az ebédszünetet és a szabadságot az Interjú Foglalás → Elérhetőség fülön lehet szerkeszteni.';
  end if;
  return new;
end;
$fn$;

-- A státusz-kapu (27/30) a régi, students-sorhoz kötött foglalásra vonatkozik.
-- A felvételi folyamathoz kötött interjú kapuja a folyamat lépése, amelyet az
-- RPC-k ellenőriznek — ide ezért korai kilépés kerül.
create or replace function public.interviewslots_booking_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_student_id text;
  v_status     text;
  v_required   text := public.interview_gate_required_status();
  v_label      text;
  v_was_booked boolean;
  v_old_sid    text;
begin
  if new.process_id is not null then
    return new;
  end if;
  if lower(btrim(coalesce(new."status", ''))) <> 'booked' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_was_booked := (lower(btrim(coalesce(old."status", ''))) = 'booked');
    v_old_sid    := coalesce(old."studentId", '');
  else
    v_was_booked := false;
    v_old_sid    := null;
  end if;

  if v_was_booked and v_old_sid = coalesce(new."studentId", '') then
    return new;
  end if;

  v_student_id := nullif(new."studentId", '');

  if v_student_id is null then
    raise exception
      'Az interjú-foglaláshoz be kell kötni a fiókot egy jelentkezői sorhoz (profiles."studentId" → students.id). Kérjük, forduljon a Külügyi Irodához.'
      using errcode = '42501';
  end if;

  v_status := public.student_status_of(v_student_id);

  if v_status is null then
    raise exception
      'Az interjú-foglalás alanya (%) nem szerepel a jelentkezők között.', v_student_id
      using errcode = '42501';
  end if;

  if v_status <> v_required then
    select coalesce(ss.label_hu, v_status) into v_label
      from public.student_status ss where ss.code = v_status;
    raise exception
      'Interjú-időpontot csak a dokumentum-ellenőrzésen túljutott jelentkező foglalhat. A jelentkező jelenlegi státusza: "%" (%), a foglaláshoz szükséges: "%".',
      coalesce(v_label, v_status), v_status, v_required
      using errcode = '42501',
            hint = 'Az ügyintéző a felvételi státuszt a Jelentkezők nézetben állíthatja "Dokumentumok ellenőrizve" értékre.';
  end if;

  return new;
end
$fn$;

create or replace function public.interviewslots_gate_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_required text;
  v_status   text;
  v_label    text;
begin
  if new.process_id is not null then return new; end if;
  if lower(btrim(coalesce(new.status, ''))) <> 'booked' then return new; end if;
  if to_regprocedure('public.interview_gate_required_status()') is null
     or to_regprocedure('public.student_status_of(text)') is null then
    return new;
  end if;

  execute 'select public.interview_gate_required_status()' into v_required;

  if nullif(new."studentId", '') is null then
    raise exception
      'Az interjú-foglaláshoz be kell kötni a fiókot egy jelentkezői sorhoz (profiles."studentId" → students.id). Kérjük, forduljon a Külügyi Irodához.'
      using errcode = '42501';
  end if;

  execute 'select public.student_status_of($1)' into v_status using new."studentId";
  if v_status is null then
    raise exception 'Az interjú-foglalás alanya (%) nem szerepel a jelentkezők között.', new."studentId"
      using errcode = '42501';
  end if;
  if v_status <> v_required then
    select coalesce(ss.label_hu, v_status) into v_label
      from public.student_status ss where ss.code = v_status;
    raise exception
      'Interjú-időpontot csak a dokumentum-ellenőrzésen túljutott jelentkező foglalhat. A jelentkező jelenlegi státusza: "%" (%), a foglaláshoz szükséges: "%".',
      coalesce(v_label, v_status), v_status, v_required
      using errcode = '42501';
  end if;
  return new;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 6) Segédfüggvények (csak az RPC-k hívják)
-- ---------------------------------------------------------------------------
create or replace function public.interview_applicant_name(p public.admission_processes)
returns text
language sql
stable
set search_path = public, pg_temp
as $fn$
  select coalesce(
    nullif(btrim(p.data -> 'extracted' ->> 'name'), ''),
    nullif(btrim(p.data -> 'personal'  ->> 'name'), ''),
    nullif(btrim(p.data -> 'account'   ->> 'fullName'), ''),
    nullif(btrim(p.applicant_name), ''),
    p.owner_email)
$fn$;

create or replace function public.interview_hu_label(p_ts timestamptz)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select to_char(x.l, 'YYYY') || '. '
      || (array['január', 'február', 'március', 'április', 'május', 'június', 'július',
                'augusztus', 'szeptember', 'október', 'november', 'december'])[extract(month from x.l)::int]
      || ' ' || extract(day from x.l)::int || '. ' || to_char(x.l, 'HH24:MI')
    from (select p_ts at time zone public.interview_tz() as l) x
$fn$;

create or replace function public.interview_slot_json(s public."interviewSlots")
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'id',               s.id,
    'status',           s.status,
    'start',            s."startTime",
    'end',              s."endTime",
    'interviewer',      s."interviewerKey",
    'interviewer_name', s."interviewerName",
    'student_id',       s."studentId",
    'student_name',     s."studentName",
    'process_id',       s.process_id,
    'teams_url',        s."teamsMeetingUrl",
    'note',             s.note,
    'previous_slot',    s.previous_slot,
    'updated_at',       s.updated_at)
$fn$;

-- A folyamat data.interview kulcsa az élő interjút tükrözi. A `slot` alkulcs a
-- régi olvasóknak szól (nap, idő, interjúztató szövegként).
create or replace function public.interview_sync_process(p_process_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  s       public."interviewSlots";
  v_local timestamp;
  v       jsonb;
  v_hon   text[] := array['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];
begin
  if p_process_id is null then return; end if;

  select * into s
    from public."interviewSlots"
   where process_id = p_process_id and status in ('Booked', 'Proposed')
   order by "startTime" desc
   limit 1;

  if s.id is null then
    -- Csak a rendszer által létrehozott bejegyzést töröljük; a régi, beégetett
    -- időpontos foglalás nyoma megmarad.
    update public.admission_processes
       set data = coalesce(data, '{}'::jsonb) - 'interview', updated_at = now()
     where id = p_process_id
       and coalesce(data -> 'interview' ->> 'slotId', '') like 'IV%';
    return;
  end if;

  v_local := s."startTime" at time zone public.interview_tz();
  v := jsonb_build_object(
    'slotId',          s.id,
    'status',          s.status,
    'booked',          s.status = 'Booked',
    'proposed',        s.status = 'Proposed',
    'start',           s."startTime",
    'end',             s."endTime",
    'interviewer',     s."interviewerKey",
    'interviewerName', s."interviewerName",
    'teamsUrl',        s."teamsMeetingUrl",
    'note',            s.note,
    'slot', jsonb_build_object(
      'day',  to_char(v_local, 'YYYY') || '. ' || v_hon[extract(month from v_local)::int] || ' ' || extract(day from v_local)::int || '.',
      'time', to_char(v_local, 'HH24:MI'),
      'who',  s."interviewerName"));

  update public.admission_processes
     set data = jsonb_set(coalesce(data, '{}'::jsonb), '{interview}', v, true), updated_at = now()
   where id = p_process_id;
end
$fn$;

create or replace function public.interview_notify(p_process_id text, p_subject text, p_body text, p_tone text default 'info')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  p        public.admission_processes;
  v_sender text;
begin
  if p_process_id is null then return; end if;
  select * into p from public.admission_processes where id = p_process_id;
  if p.id is null or nullif(btrim(coalesce(p.owner_email, '')), '') is null then return; end if;
  select nullif(btrim(pr.name), '') into v_sender from public.profiles pr where pr.id = auth.uid();

  insert into public.process_messages
    (id, process_id, owner_email, applicant, sender, subject, preview, tone, attachments, read, date)
  values
    ('msg-iv-' || replace(gen_random_uuid()::text, '-', ''), p.id, lower(p.owner_email),
     public.interview_applicant_name(p), coalesce(v_sender, 'Külügyi Iroda'), p_subject, p_body,
     coalesce(p_tone, 'info'), '[]'::jsonb, false,
     to_char(now() at time zone public.interview_tz(), 'YYYY.MM.DD'));
end
$fn$;

-- Ki kezelheti az interjút: a felvételi iroda, vagy a saját naptárában az interjúztató.
create or replace function public.interview_can_manage(p_interviewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(public.is_admissions(), false)
      or (public.interview_is_interviewer() and p_interviewer is not null and p_interviewer = auth.uid())
$fn$;

revoke all on function public.interview_applicant_name(public.admission_processes) from public, anon, authenticated;
revoke all on function public.interview_hu_label(timestamptz)                    from public, anon, authenticated;
revoke all on function public.interview_slot_json(public."interviewSlots")      from public, anon, authenticated;
revoke all on function public.interview_sync_process(text)                       from public, anon, authenticated;
revoke all on function public.interview_notify(text, text, text, text)           from public, anon, authenticated;
revoke all on function public.interview_can_manage(uuid)                         from public, anon;
grant execute on function public.interview_can_manage(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) RPC-k
-- ---------------------------------------------------------------------------

-- 7.1 A naptár eseményei egy interjúztatóra, időtartományra
create or replace function public.interview_calendar_events(
  p_interviewer uuid default null,
  p_from        timestamptz default null,
  p_to          timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_key  uuid        := coalesce(p_interviewer, auth.uid());
  v_from timestamptz := coalesce(p_from, date_trunc('week', now()));
  v_to   timestamptz;
begin
  if not (coalesce(public.is_staff(), false) or v_key = auth.uid()) then
    raise exception 'Nincs jogosultság ennek a naptárnak a megtekintéséhez.' using errcode = '42501';
  end if;
  v_to := coalesce(p_to, v_from + interval '7 days');
  if v_to <= v_from then
    raise exception 'Hibás időtartomány.' using errcode = '22023';
  end if;
  if v_to - v_from > interval '62 days' then
    v_to := v_from + interval '62 days';
  end if;

  return coalesce((
    select jsonb_agg(
             public.interview_slot_json(s) || jsonb_build_object(
               'ref_no',          p.ref_no,
               'applicant_name',  case when p.id is not null then public.interview_applicant_name(p) else s."studentName" end,
               'applicant_email', p.owner_email,
               'country',         coalesce(nullif(p.data -> 'extracted' ->> 'country', ''),
                                           nullif(p.data -> 'personal'  ->> 'country', ''),
                                           nullif(p.data -> 'account'   ->> 'country', '')),
               'program_id',      p.program_id,
               'program_ids',     case when jsonb_typeof(p.data -> 'program_ids') = 'array' then p.data -> 'program_ids'
                                       when jsonb_typeof(p.data -> 'programs')    = 'array' then p.data -> 'programs'
                                       else null end,
               'term',            p.data ->> 'term',
               'decided',         coalesce(p.data ? 'decision', false))
             order by s."startTime")
      from public."interviewSlots" s
      left join public.admission_processes p on p.id = s.process_id
     where s."interviewerKey" = v_key
       and coalesce(s.status, '') in ('Booked', 'Proposed', 'Completed')
       and s."startTime" < v_to
       and s."endTime"   > v_from
  ), '[]'::jsonb);
end
$fn$;

-- 7.2 Jelentkező hozzárendelése egy időponthoz (ügyintéző)
create or replace function public.interview_assign(
  p_process_id  text,
  p_interviewer uuid,
  p_start       timestamptz,
  p_end         timestamptz default null,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  p        public.admission_processes;
  s        public."interviewSlots";
  v_live   public."interviewSlots";
  v_end    timestamptz;
  v_reason text;
  v_id     text;
begin
  if not coalesce(public.is_admissions(), false) then
    raise exception 'Interjút jelentkezőhöz csak a felvételi iroda munkatársa rendelhet.' using errcode = '42501';
  end if;
  if p_process_id is null or p_interviewer is null or p_start is null then
    raise exception 'Hiányzó jelentkező, interjúztató vagy időpont.' using errcode = '22023';
  end if;

  select * into p from public.admission_processes where id = p_process_id for update;
  if p.id is null then
    raise exception 'Nincs ilyen felvételi folyamat: %', p_process_id using errcode = '02000';
  end if;
  if coalesce(p.data ->> '_cancelled', '') = 'true' then
    raise exception 'A jelentkező megszakította ezt a felvételi folyamatot.' using errcode = '22023';
  end if;

  select * into v_live from public."interviewSlots"
   where process_id = p.id and status in ('Booked', 'Proposed')
   order by "startTime" desc limit 1;
  if v_live.id is not null then
    raise exception 'Ennek a jelentkezőnek már van interjú-időpontja (%). Azt helyezd át, vagy előbb mondd le.',
      public.interview_hu_label(v_live."startTime") using errcode = '22023';
  end if;

  v_end := coalesce(p_end, p_start + make_interval(mins => public.interview_slot_minutes()));
  v_reason := public.interview_slot_blocked_reason_ex(p_interviewer, p_start, v_end, null, true);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = '42501';
  end if;

  v_id := left('IV' || replace(gen_random_uuid()::text, '-', ''), 22);
  insert into public."interviewSlots"
    (id, "startTime", "endTime", status, "interviewerId", "interviewerName", "interviewerKey",
     "studentId", "studentName", "teamsMeetingUrl", process_id, note, created_by, updated_at)
  values
    (v_id, p_start, v_end, 'Booked', p_interviewer::text, public.interview_name(p_interviewer), p_interviewer,
     null, public.interview_applicant_name(p),
     'https://teams.microsoft.com/l/meetup-join/19%3ameeting_' || left(replace(v_id, 'IV', ''), 12),
     p.id, nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), now())
  returning * into s;

  perform public.interview_sync_process(p.id);
  perform public.interview_notify(p.id, 'Interjú-időpont',
    'A felvételi interjúd időpontja: ' || public.interview_hu_label(p_start)
    || ' (Microsoft Teams). Interjúztató: ' || public.interview_name(p_interviewer)
    || '. Ha nem megfelelő, a felvételi folyamatodban lemondhatod, és választhatsz másikat.', 'info');

  return public.interview_slot_json(s);
end
$fn$;

-- 7.3 Jelentkezői foglalás a saját felvételi folyamatához
create or replace function public.interview_book_process(
  p_process_id  text,
  p_interviewer uuid,
  p_start       timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  p        public.admission_processes;
  s        public."interviewSlots";
  v_live   public."interviewSlots";
  v_office boolean := coalesce(public.is_admissions(), false);
  v_lead   integer := public.interview_setting_int('lead_time_hours', 2);
  v_end    timestamptz;
  v_reason text;
  v_sid    text;
  v_id     text;
begin
  if not coalesce(public.is_approved(), false) then
    raise exception 'Jóváhagyásra váró fiókkal nem lehet interjút foglalni.' using errcode = '42501';
  end if;
  if p_process_id is null or p_interviewer is null or p_start is null then
    raise exception 'Hiányzó interjúztató vagy időpont.' using errcode = '22023';
  end if;

  select * into p from public.admission_processes where id = p_process_id for update;
  if p.id is null then
    raise exception 'Nincs ilyen felvételi folyamat: %', p_process_id using errcode = '02000';
  end if;
  if not (v_office or lower(coalesce(p.owner_email, '')) = public.my_email()) then
    raise exception 'Csak a saját felvételi folyamatodhoz foglalhatsz interjút.' using errcode = '42501';
  end if;
  if coalesce(p.data ->> '_cancelled', '') = 'true' then
    raise exception 'Ez a felvételi folyamat meg lett szakítva.' using errcode = '22023';
  end if;
  if p.data ? 'decision' then
    raise exception 'Erről a jelentkezésről már döntés született — interjú-időpont nem foglalható.' using errcode = '22023';
  end if;
  -- Az irodai úton (képzés nélkül) indított folyamatban az interjú a
  -- dokumentumok ellenőrzése után következik (STEP_IDS_V2: 3. index).
  if not v_office
     and nullif(p.program_id, '') is null
     and coalesce(jsonb_typeof(p.data -> 'program_ids'), '') <> 'array'
     and coalesce(p.step, 0) < 3 then
    raise exception 'Az interjú-időpont a dokumentumok ellenőrzése után foglalható.' using errcode = '42501';
  end if;
  if not v_office and p_start < now() + make_interval(hours => v_lead) then
    raise exception 'Ez az időpont már túl közeli — legalább % órával előbb kell foglalni.', v_lead using errcode = '42501';
  end if;

  select * into v_live from public."interviewSlots"
   where process_id = p.id and status in ('Booked', 'Proposed')
   order by "startTime" desc limit 1;
  if v_live.id is not null and v_live.status = 'Booked' then
    raise exception 'Már van lefoglalt interjú-időpontod (%). Előbb mondd le, utána választhatsz másikat.',
      public.interview_hu_label(v_live."startTime") using errcode = '22023';
  end if;
  if v_live.id is not null then
    -- A jelentkező a javaslat helyett maga választott időpontot.
    update public."interviewSlots"
       set status = 'Cancelled',
           note = concat_ws(' · ', nullif(note, ''), 'A jelentkező másik időpontot választott.'),
           updated_at = now()
     where id = v_live.id;
  end if;

  v_end := p_start + make_interval(mins => public.interview_slot_minutes());
  v_reason := public.interview_slot_blocked_reason_ex(p_interviewer, p_start, v_end, null, v_office);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = '42501';
  end if;

  if not v_office then
    v_sid := public.my_student_id();
    if v_sid is not null and exists (
         select 1 from public."interviewSlots" x
          where x."studentId" = v_sid
            and coalesce(x.status, '') not in ('Cancelled', 'Completed', 'Declined')) then
      raise exception 'Már van élő interjú-foglalásod a Hallgatói portál Interjúk fülén. Előbb azt mondd le.' using errcode = '22023';
    end if;
  end if;

  v_id := left('IV' || replace(gen_random_uuid()::text, '-', ''), 22);
  insert into public."interviewSlots"
    (id, "startTime", "endTime", status, "interviewerId", "interviewerName", "interviewerKey",
     "studentId", "studentName", "teamsMeetingUrl", process_id, created_by, updated_at)
  values
    (v_id, p_start, v_end, 'Booked', p_interviewer::text, public.interview_name(p_interviewer), p_interviewer,
     v_sid, public.interview_applicant_name(p),
     'https://teams.microsoft.com/l/meetup-join/19%3ameeting_' || left(replace(v_id, 'IV', ''), 12),
     p.id, auth.uid(), now())
  returning * into s;

  perform public.interview_sync_process(p.id);
  return public.interview_slot_json(s);
end
$fn$;

-- 7.4 Áthelyezés — húzás, átméretezés, másik interjúztatóhoz tétel
create or replace function public.interview_move(
  p_slot        text,
  p_start       timestamptz,
  p_end         timestamptz default null,
  p_interviewer uuid default null,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  s           public."interviewSlots";
  v_new_iv    uuid;
  v_end       timestamptz;
  v_reason    text;
  v_old_start timestamptz;
  v_old_iv    uuid;
begin
  select * into s from public."interviewSlots" where id = p_slot for update;
  if s.id is null then
    raise exception 'Nincs ilyen interjú-időpont.' using errcode = '02000';
  end if;
  if not public.interview_can_manage(s."interviewerKey") then
    raise exception 'Az interjút csak a felvételi iroda munkatársa vagy az interjúztató helyezheti át.' using errcode = '42501';
  end if;
  if coalesce(s.status, '') not in ('Booked', 'Proposed') then
    raise exception 'Csak élő (foglalt vagy javasolt) interjú helyezhető át.' using errcode = '22023';
  end if;
  if p_start is null then
    raise exception 'Hiányzó időpont.' using errcode = '22023';
  end if;

  v_new_iv := coalesce(p_interviewer, s."interviewerKey");
  if v_new_iv is null then
    raise exception 'A régi, interjúztató nélküli időpont a naptárban nem helyezhető át.' using errcode = '22023';
  end if;
  if v_new_iv is distinct from s."interviewerKey" and not coalesce(public.is_admissions(), false) then
    raise exception 'Másik interjúztatóhoz csak a felvételi iroda munkatársa teheti át az interjút.' using errcode = '42501';
  end if;

  v_end := coalesce(p_end, p_start + (s."endTime" - s."startTime"));
  v_reason := public.interview_slot_blocked_reason_ex(v_new_iv, p_start, v_end, s.id, true);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = '42501';
  end if;

  v_old_start := s."startTime";
  v_old_iv    := s."interviewerKey";

  update public."interviewSlots"
     set "startTime"       = p_start,
         "endTime"         = v_end,
         "interviewerKey"  = v_new_iv,
         "interviewerId"   = v_new_iv::text,
         "interviewerName" = public.interview_name(v_new_iv),
         note              = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
         updated_at        = now()
   where id = s.id
  returning * into s;

  perform public.interview_sync_process(s.process_id);
  if s.process_id is not null and (v_old_start is distinct from p_start or v_old_iv is distinct from v_new_iv) then
    perform public.interview_notify(s.process_id, 'Módosult az interjúd időpontja',
      'Az interjúd új időpontja: ' || public.interview_hu_label(p_start)
      || ' (korábban: ' || public.interview_hu_label(v_old_start) || '). Interjúztató: '
      || public.interview_name(v_new_iv) || '.'
      || case when s.status = 'Proposed' then ' Kérjük, fogadd el az időpontot a felvételi folyamatodban.' else '' end,
      'info');
  end if;

  return public.interview_slot_json(s);
end
$fn$;

-- 7.5 A jelentkező foglalásának elutasítása, új időpont javaslatával
create or replace function public.interview_decline(
  p_slot            text,
  p_reason          text default null,
  p_new_start       timestamptz default null,
  p_new_interviewer uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  s        public."interviewSlots";
  n        public."interviewSlots";
  v_iv     uuid;
  v_dur    interval;
  v_reason text;
  v_ok     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id     text;
  v_msg    text;
begin
  select * into s from public."interviewSlots" where id = p_slot for update;
  if s.id is null then
    raise exception 'Nincs ilyen interjú-időpont.' using errcode = '02000';
  end if;
  if not public.interview_can_manage(s."interviewerKey") then
    raise exception 'A foglalást csak a felvételi iroda munkatársa vagy az interjúztató utasíthatja el.' using errcode = '42501';
  end if;
  if coalesce(s.status, '') <> 'Booked' then
    raise exception 'Csak lefoglalt interjú-időpont utasítható el.' using errcode = '22023';
  end if;

  update public."interviewSlots"
     set status = 'Declined', note = v_ok, updated_at = now()
   where id = s.id
  returning * into s;

  if p_new_start is not null then
    v_iv := coalesce(p_new_interviewer, s."interviewerKey");
    if v_iv is distinct from s."interviewerKey" and not coalesce(public.is_admissions(), false) then
      raise exception 'Másik interjúztatót csak a felvételi iroda munkatársa javasolhat.' using errcode = '42501';
    end if;
    v_dur := s."endTime" - s."startTime";
    v_reason := public.interview_slot_blocked_reason_ex(v_iv, p_new_start, p_new_start + v_dur, null, true);
    if v_reason is not null then
      raise exception '%', v_reason using errcode = '42501';
    end if;
    v_id := left('IV' || replace(gen_random_uuid()::text, '-', ''), 22);
    insert into public."interviewSlots"
      (id, "startTime", "endTime", status, "interviewerId", "interviewerName", "interviewerKey",
       "studentId", "studentName", "teamsMeetingUrl", process_id, note, previous_slot, created_by, updated_at)
    values
      (v_id, p_new_start, p_new_start + v_dur, 'Proposed', v_iv::text, public.interview_name(v_iv), v_iv,
       s."studentId", s."studentName",
       'https://teams.microsoft.com/l/meetup-join/19%3ameeting_' || left(replace(v_id, 'IV', ''), 12),
       s.process_id, v_ok, s.id, auth.uid(), now())
    returning * into n;
  end if;

  perform public.interview_sync_process(s.process_id);

  if s.process_id is not null then
    v_msg := 'Az általad választott interjú-időpontot (' || public.interview_hu_label(s."startTime") || ') sajnos nem tudjuk fogadni'
          || case when v_ok is not null then ': ' || rtrim(v_ok, '.!? ') else '' end || '.';
    if n.id is not null then
      v_msg := v_msg || ' Helyette ezt az időpontot javasoljuk: ' || public.interview_hu_label(n."startTime")
            || ' (interjúztató: ' || n."interviewerName" || '). A felvételi folyamatodban elfogadhatod, vagy választhatsz másik időpontot.';
      perform public.interview_notify(s.process_id, 'Új interjú-időpontot javaslunk', v_msg, 'warning');
    else
      v_msg := v_msg || ' Kérjük, válassz másik időpontot a felvételi folyamatodban.';
      perform public.interview_notify(s.process_id, 'Válassz új interjú-időpontot', v_msg, 'warning');
    end if;
  end if;

  return jsonb_build_object(
    'declined', public.interview_slot_json(s),
    'proposal', case when n.id is null then null else public.interview_slot_json(n) end);
end
$fn$;

-- 7.6 Lemondás — az iroda vagy a jelentkező
create or replace function public.interview_cancel(p_slot text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  s       public."interviewSlots";
  p       public.admission_processes;
  v_owner boolean := false;
  v_staff boolean;
  v_ok    text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into s from public."interviewSlots" where id = p_slot for update;
  if s.id is null then
    raise exception 'Nincs ilyen interjú-időpont.' using errcode = '02000';
  end if;
  if s.process_id is not null then
    select * into p from public.admission_processes where id = s.process_id;
    v_owner := lower(coalesce(p.owner_email, '')) = coalesce(public.my_email(), '-');
  end if;
  if not v_owner and s."studentId" is not null and s."studentId" = public.my_student_id() then
    v_owner := true;
  end if;
  v_staff := public.interview_can_manage(s."interviewerKey");
  if not (v_staff or v_owner) then
    raise exception 'Ezt az interjút nem mondhatod le.' using errcode = '42501';
  end if;
  if coalesce(s.status, '') not in ('Booked', 'Proposed') then
    raise exception 'Ez az interjú-időpont már nem él.' using errcode = '22023';
  end if;

  update public."interviewSlots"
     set status = 'Cancelled',
         note = coalesce(v_ok, note),
         updated_at = now()
   where id = s.id
  returning * into s;

  perform public.interview_sync_process(s.process_id);
  if v_staff and not v_owner and s.process_id is not null then
    perform public.interview_notify(s.process_id, 'Lemondtuk az interjúdat',
      'A(z) ' || public.interview_hu_label(s."startTime") || ' időpontra szóló interjúdat lemondtuk'
      || case when v_ok is not null then ': ' || rtrim(v_ok, '.!? ') else '' end
      || '. Kérjük, válassz új időpontot a felvételi folyamatodban.', 'warning');
  end if;

  return public.interview_slot_json(s);
end
$fn$;

-- 7.7 A javasolt időpont elfogadása vagy elutasítása (jelentkező)
create or replace function public.interview_proposal_respond(p_slot text, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  s    public."interviewSlots";
  p    public.admission_processes;
  v_ok boolean := false;
begin
  select * into s from public."interviewSlots" where id = p_slot for update;
  if s.id is null then
    raise exception 'Nincs ilyen időpont-javaslat.' using errcode = '02000';
  end if;
  if coalesce(s.status, '') <> 'Proposed' then
    raise exception 'Ez az időpont-javaslat már nem él.' using errcode = '22023';
  end if;
  if s.process_id is not null then
    select * into p from public.admission_processes where id = s.process_id;
    v_ok := lower(coalesce(p.owner_email, '')) = coalesce(public.my_email(), '-');
  end if;
  if not (v_ok or public.interview_can_manage(s."interviewerKey")) then
    raise exception 'Erre az időpont-javaslatra nem válaszolhatsz.' using errcode = '42501';
  end if;

  if coalesce(p_accept, false) then
    update public."interviewSlots"
       set status = 'Booked', updated_at = now()
     where id = s.id
    returning * into s;
  else
    update public."interviewSlots"
       set status = 'Cancelled',
           note = concat_ws(' · ', nullif(note, ''), 'A jelentkező nem fogadta el a javasolt időpontot.'),
           updated_at = now()
     where id = s.id
    returning * into s;
  end if;

  perform public.interview_sync_process(s.process_id);
  return public.interview_slot_json(s);
end
$fn$;

-- 7.8 Egy felvételi folyamat interjú-állapota (jelentkező és iroda)
create or replace function public.interview_process_state(p_process_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  p   public.admission_processes;
  cur public."interviewSlots";
  dec public."interviewSlots";
begin
  select * into p from public.admission_processes where id = p_process_id;
  if p.id is null then
    raise exception 'Nincs ilyen felvételi folyamat: %', p_process_id using errcode = '02000';
  end if;
  if not (coalesce(public.is_staff(), false) or lower(coalesce(p.owner_email, '')) = coalesce(public.my_email(), '-')) then
    raise exception 'Ehhez a felvételi folyamathoz nincs hozzáférésed.' using errcode = '42501';
  end if;

  select * into cur from public."interviewSlots"
   where process_id = p.id and status in ('Booked', 'Proposed')
   order by "startTime" desc limit 1;
  select * into dec from public."interviewSlots"
   where process_id = p.id and status = 'Declined'
   order by updated_at desc limit 1;

  return jsonb_build_object(
    'current',       case when cur.id is null then null else public.interview_slot_json(cur) end,
    'declined',      case when dec.id is null then null else public.interview_slot_json(dec) end,
    'decided',       coalesce(p.data ? 'decision', false),
    'slot_minutes',  public.interview_slot_minutes(),
    'break_minutes', public.interview_break_minutes(),
    'timezone',      public.interview_tz());
end
$fn$;

-- 7.9 A modul közös állapota — a 28-as, kiegészítve a szünettel és a kezelési joggal
create or replace function public.interview_my_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_admin boolean := coalesce(public.is_admin(), false);
  v_staff boolean := coalesce(public.is_staff(), false);
  v_iv    boolean := public.interview_is_interviewer();
begin
  return jsonb_build_object(
    'admin',          v_admin,
    'staff',          v_staff,
    'can_manage',     coalesce(public.is_admissions(), false),
    'interviewer',    v_iv,
    'interviewer_id', case when v_iv then auth.uid() else null end,
    'my_name',        case when v_iv then public.interview_name(auth.uid()) else null end,
    'slot_minutes',   public.interview_slot_minutes(),
    'break_minutes',  public.interview_break_minutes(),
    'timezone',       public.interview_tz(),
    'horizon_days',   public.interview_setting_int('booking_horizon_days', 30),
    'lead_hours',     public.interview_setting_int('lead_time_hours', 2),
    'interviewers',   coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', i.interviewer,
                 'name', public.interview_name(i.interviewer),
                 'email', p.email,
                 'active', i.active) order by public.interview_name(i.interviewer))
          from public.interview_interviewer i
          left join public.profiles p on p.id = i.interviewer
         where i.active or v_admin), '[]'::jsonb),
    'candidates',     case when v_admin then coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(trim(p.name), ''), p.email), 'email', p.email, 'role', p.role)
                         order by coalesce(nullif(trim(p.name), ''), p.email))
          from public.profiles p
         where p.approval_status = 'approved'
           and p.role in ('SUPERADMIN', 'ADMIN', 'ADMISSIONS')
           and not exists (select 1 from public.interview_interviewer i where i.interviewer = p.id)),
        '[]'::jsonb) else '[]'::jsonb end,
    'settings',       case when v_admin then coalesce((
        select jsonb_agg(jsonb_build_object('key', s.key, 'value', s.value, 'label', s.label) order by s.key)
          from public.interview_setting s), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$fn$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.interview_calendar_events(uuid, timestamptz, timestamptz)',
    'public.interview_assign(text, uuid, timestamptz, timestamptz, text)',
    'public.interview_book_process(text, uuid, timestamptz)',
    'public.interview_move(text, timestamptz, timestamptz, uuid, text)',
    'public.interview_decline(text, text, timestamptz, uuid)',
    'public.interview_cancel(text, text)',
    'public.interview_proposal_respond(text, boolean)',
    'public.interview_process_state(text)',
    'public.interview_my_context()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 8) A data.interview kulcsot is az iroda (és az RPC-k) írják
--    (a 60-as védelem kulcslistájának bővítése)
-- ---------------------------------------------------------------------------
create or replace function public.admission_office_keys()
returns text[] language sql immutable as $fn$
  select array['decision', 'interview']::text[]
$fn$;

-- ---------------------------------------------------------------------------
-- 9) Záró ellenőrzés
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(x, ', ') into v_missing
    from unnest(array[
      'public.interview_calendar_events(uuid,timestamptz,timestamptz)',
      'public.interview_assign(text,uuid,timestamptz,timestamptz,text)',
      'public.interview_book_process(text,uuid,timestamptz)',
      'public.interview_move(text,timestamptz,timestamptz,uuid,text)',
      'public.interview_decline(text,text,timestamptz,uuid)',
      'public.interview_cancel(text,text)',
      'public.interview_proposal_respond(text,boolean)',
      'public.interview_process_state(text)'
    ]) x
   where to_regprocedure(x) is null;
  if v_missing is not null then
    raise exception 'HIBA: hiányzó függvény(ek): %', v_missing;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.interview_assign(text,uuid,timestamptz,timestamptz,text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja az interview_assign fuggvenyt.';
  end if;
  raise notice 'Rendben: 61 — interjúnaptár kész. Szünet két interjú között: % perc, idősáv: % perc.',
    public.interview_break_minutes(), public.interview_slot_minutes();
end $$;

commit;
