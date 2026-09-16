-- ============================================================================
-- 66_interview_scoring.sql — interjú értékelő szempontrendszer és kitöltött lapok
--
-- MIÉRT KELL
--   Az interjúk értékelése eddig egy külön Excel-táblában készült („Interjú
--   értékelő.xlsx”): egy sor = egy interjú, hat szempont 1–5 ponttal, összesen
--   30 pont, eredmény igen/nem, interjúztató. Ez a táblázat nem kapcsolódott a
--   jelentkezéshez, nem volt visszakereshető, és a szempontokat csak az tudta
--   bővíteni, akinél a fájl volt. Mostantól a szempontrendszert az ügyintéző a
--   saját felületén bővíti, az értékelést pedig a jelentkezés interjúkártyáján
--   tölti ki.
--
-- A DÖNTÉSEK
--   * KÉT tábla: a SZEMPONT-katalógus (bővíthető) és a KITÖLTÖTT értékelés.
--     A kitöltött lap a szempont KULCSÁRA hivatkozik, nem a nevére — a szempont
--     átnevezése így nem írja át a már kitöltött lapokat.
--   * NINCS TÖRLÉS, csak elrejtés (active = false): egy már pontozott szempont
--     törlése után a korábbi értékelések értelmezhetetlenek lennének.
--   * A PONTSZÁMOT A SZERVER SZÁMOLJA. A kliens csak a szempontonkénti pontokat
--     küldi; az összeget, a maximumot és az értékelő személyét a trigger tölti
--     ki, és az érvénytelen pontszámot (nem szám, negatív, maximum feletti,
--     ismeretlen szempont) elutasítja. Így a felületről nem lehet „30/30”-at
--     hamisítani.
--   * A kitöltött lap CSAK ügyintézőnek látszik (is_staff). A jelentkező a saját
--     felvételi folyamatában sem látja — ez belső bírálati adat.
--   * Egy jelentkezéshez egy értékelőlap tartozik (unique process_id). Az
--     ismételt interjú felülírja; a változás idejét az updated_at őrzi.
--
-- FÜGGŐSÉG: 04_admission_processes.sql, 11_rbac_additive.sql (is_staff, is_admin),
--           61_interview_calendar.sql (interviewSlots.process_id)
-- IDEMPOTENS: if not exists / create or replace / drop policy if exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) A szempont-katalógus
-- ---------------------------------------------------------------------------
create table if not exists public.interview_criterion (
  key         text primary key
              check (key ~ '^[a-z0-9_]{2,60}$'),
  label_hu    text not null
              check (char_length(btrim(label_hu)) between 2 and 120),
  label_en    text
              check (label_en is null or char_length(btrim(label_en)) between 2 and 120),
  max_score   int not null default 5
              check (max_score between 1 and 100),
  sort_order  int not null default 100,
  active      boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Ugyanazzal a megnevezéssel ne lehessen kétszer felvenni (kis-nagybetű független).
create unique index if not exists interview_criterion_label_hu_uq
  on public.interview_criterion (lower(btrim(label_hu)));

create or replace function public.interview_criterion_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    -- A kulcsra hivatkoznak a kitöltött lapok: nem változhat.
    new.key        := old.key;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.label_hu   := btrim(new.label_hu);
  new.label_en   := nullif(btrim(coalesce(new.label_en, '')), '');
  new.updated_at := now();
  return new;
end $fn$;

revoke all on function public.interview_criterion_guard() from public, anon;

drop trigger if exists interview_criterion_guard on public.interview_criterion;
create trigger interview_criterion_guard
  before insert or update on public.interview_criterion
  for each row execute function public.interview_criterion_guard();

alter table public.interview_criterion enable row level security;

drop policy if exists interview_criterion_read   on public.interview_criterion;
drop policy if exists interview_criterion_insert on public.interview_criterion;
drop policy if exists interview_criterion_update on public.interview_criterion;

-- Olvasni ügyintéző és interjúztató tud (belső bírálati eszköz), írni rendszergazda.
create policy interview_criterion_read on public.interview_criterion
  for select to authenticated using (coalesce(public.is_staff(), false));
create policy interview_criterion_insert on public.interview_criterion
  for insert to authenticated with check (public.is_admin());
create policy interview_criterion_update on public.interview_criterion
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- Szándékosan NINCS delete policy: elrejtés van, törlés nincs.

revoke all on public.interview_criterion from anon, authenticated, public;
grant select, insert, update on public.interview_criterion to authenticated;

-- A jelenlegi Excel hat szempontja, 1–5 ponttal (összesen 30).
insert into public.interview_criterion (key, label_hu, label_en, max_score, sort_order) values
  ('kommunikacio',   'Kommunikációs képesség',                   'Communication skills',            5, 10),
  ('nyelvhelyesseg', 'Nyelvhelyesség',                           'Grammatical accuracy',            5, 20),
  ('kiejtes',        'Kiejtés',                                  'Pronunciation',                   5, 30),
  ('szokincs',       'Szókincs',                                 'Vocabulary',                      5, 40),
  ('targyi_ismeret', 'Egyetemi / választott tantárgyi ismeretek', 'Subject knowledge',              5, 50),
  ('motivacio',      'Tanulmányi motiváció',                     'Motivation to study',             5, 60)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2) A kitöltött értékelőlap
-- ---------------------------------------------------------------------------
create table if not exists public.interview_evaluation (
  id               uuid primary key default gen_random_uuid(),
  process_id       text not null references public.admission_processes(id) on delete cascade,
  slot_id          text references public."interviewSlots"(id) on delete set null,
  scores           jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(scores) = 'object'),
  total            int not null default 0,
  max_total        int not null default 0,
  result           text not null default 'pending'
                   check (result in ('yes', 'no', 'pending')),
  note             text check (note is null or char_length(note) <= 4000),
  interviewer_name text,
  evaluated_by     uuid,
  evaluated_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Egy jelentkezéshez egy értékelőlap.
create unique index if not exists interview_evaluation_process_uq
  on public.interview_evaluation (process_id);

/* A pontszám a szerveré: a kliens csak a szempontonkénti pontokat küldi.
   Az összeget és a maximumot itt számoljuk, az érvénytelen értéket elutasítjuk. */
create or replace function public.interview_evaluation_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  k text;
  v int;
  c public.interview_criterion;
  v_total int := 0;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.process_id := old.process_id;
    new.created_at := old.created_at;
  end if;

  if new.scores is null or jsonb_typeof(new.scores) <> 'object' then
    new.scores := '{}'::jsonb;
  end if;

  for k in select key from jsonb_each(new.scores) loop
    select * into c from public.interview_criterion where key = k;
    if c.key is null then
      raise exception 'Ismeretlen értékelési szempont: %', k using errcode = '22023';
    end if;
    if jsonb_typeof(new.scores -> k) <> 'number' then
      raise exception 'A(z) "%" szempont pontszáma nem szám.', c.label_hu using errcode = '22023';
    end if;
    v := (new.scores ->> k)::numeric::int;
    if v < 0 or v > c.max_score then
      raise exception 'A(z) "%" szempont pontszáma 0 és % között lehet.', c.label_hu, c.max_score using errcode = '22023';
    end if;
    v_total := v_total + v;
  end loop;

  new.total     := v_total;
  new.max_total := coalesce((select sum(max_score) from public.interview_criterion where active), 0);
  new.note      := nullif(btrim(coalesce(new.note, '')), '');
  -- Az értékelő személyét és idejét a szerver tölti ki, nem a kliens.
  new.evaluated_by := coalesce(auth.uid(), old.evaluated_by);
  new.evaluated_at := now();
  new.updated_at   := now();
  return new;
end $fn$;

revoke all on function public.interview_evaluation_guard() from public, anon;

drop trigger if exists interview_evaluation_guard on public.interview_evaluation;
create trigger interview_evaluation_guard
  before insert or update on public.interview_evaluation
  for each row execute function public.interview_evaluation_guard();

alter table public.interview_evaluation enable row level security;

drop policy if exists interview_evaluation_read   on public.interview_evaluation;
drop policy if exists interview_evaluation_insert on public.interview_evaluation;
drop policy if exists interview_evaluation_update on public.interview_evaluation;

-- Csak ügyintéző: a jelentkező a saját lapját sem látja (belső bírálati adat).
create policy interview_evaluation_read on public.interview_evaluation
  for select to authenticated using (coalesce(public.is_staff(), false));
create policy interview_evaluation_insert on public.interview_evaluation
  for insert to authenticated with check (coalesce(public.is_staff(), false));
create policy interview_evaluation_update on public.interview_evaluation
  for update to authenticated using (coalesce(public.is_staff(), false))
  with check (coalesce(public.is_staff(), false));
-- Szándékosan NINCS delete policy.

revoke all on public.interview_evaluation from anon, authenticated, public;
grant select, insert, update on public.interview_evaluation to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Lista- és exportnézet (a hívó jogán — az RLS érvényes marad)
-- ---------------------------------------------------------------------------
drop view if exists public.interview_evaluation_list;
create view public.interview_evaluation_list
  with (security_invoker = on)
as
  select
    e.id, e.process_id, e.slot_id, e.scores, e.total, e.max_total, e.result, e.note,
    e.interviewer_name, e.evaluated_at, e.updated_at,
    p.ref_no,
    p.applicant_name,
    p.owner_email,
    p.program_id,
    p.data ->> 'term'                          as term,
    coalesce(p.data -> 'personal' ->> 'name', p.applicant_name) as personal_name,
    p.data -> 'personal' ->> 'country'         as country,
    s."startTime"                              as interview_start,
    s."interviewerName"                        as slot_interviewer
  from public.interview_evaluation e
  join public.admission_processes p on p.id = e.process_id
  left join public."interviewSlots" s on s.id = e.slot_id;

revoke all on public.interview_evaluation_list from public, anon;
grant select on public.interview_evaluation_list to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Ellenőrzés
-- ---------------------------------------------------------------------------
do $blk$
declare
  v_db int;
  v_max int;
begin
  if has_table_privilege('anon', 'public.interview_criterion', 'select')
     or has_table_privilege('anon', 'public.interview_evaluation', 'select') then
    raise exception 'BIZTONSAGI HIBA: az anon olvashatja az interju ertekelo tablakat.';
  end if;
  if has_table_privilege('authenticated', 'public.interview_evaluation', 'delete')
     or has_table_privilege('authenticated', 'public.interview_evaluation', 'truncate')
     or has_table_privilege('authenticated', 'public.interview_criterion', 'delete') then
    raise exception 'BIZTONSAGI HIBA: az authenticated torolhet az interju ertekelo tablakbol.';
  end if;
  select count(*), coalesce(sum(max_score), 0) into v_db, v_max
    from public.interview_criterion where active;
  raise notice 'Rendben: 66 — % aktiv ertekelesi szempont, osszesen % pont. Az ertekelolapok tablaja kesz.', v_db, v_max;
end $blk$;
