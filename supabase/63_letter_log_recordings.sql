-- ============================================================
-- UniPortal — 63: Felvételi levél kiküldési napló + interjúfelvételek
-- ------------------------------------------------------------
-- A) KIKÜLDÉSI NAPLÓ
--    A felvételi levél eddig csak a folyamat data.letter kulcsában élt: egy
--    újragenerálás vagy visszavonás után nem lehetett megmondani, pontosan
--    milyen levél ment ki. Most minden kiküldés egy sort kap a
--    public.admission_letters táblában, a levél ÖSSZES értékével (snapshot).
--      • Írni csak a felvételi iroda tud (letter_log_send / letter_log_revoke).
--      • Az iroda minden változatot lát; a jelentkező csak az érvényes
--        (kiküldött, nem visszavont, nem felülírt) levelét.
--      • Kiküldéskor a szerver a jelentkező beszélgetésébe (62) is üzenetet ír.
--
-- B) INTERJÚFELVÉTELEK
--    Privát tároló: 'interview-recordings' (rec/<eljárás>/… útvonal), és a
--    public.interview_recordings metaadat-tábla. Csak a felvételi iroda és az
--    interjúztatók láthatják és tölthetik; törölni a felvételi iroda tud. A
--    jelentkező NEM fér hozzá.
--
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 0. előfeltételek ----------
do $$
begin
  if to_regclass('public.admission_processes') is null then
    raise exception 'MEGTAGADVA: hiányzik a public.admission_processes tábla (04-es migráció).';
  end if;
  if to_regprocedure('public.is_admissions()') is null or to_regprocedure('public.my_email()') is null then
    raise exception 'MEGTAGADVA: előbb a 11-es migráció kell (is_admissions, my_email).';
  end if;
  if to_regprocedure('public.interview_is_interviewer()') is null then
    raise exception 'MEGTAGADVA: előbb a 28-as migráció kell (interview_is_interviewer).';
  end if;
end $$;

-- ============================================================
-- A) KIKÜLDÉSI NAPLÓ
-- ============================================================
create table if not exists public.admission_letters (
  id             uuid primary key default gen_random_uuid(),
  process_id     text not null references public.admission_processes(id) on delete cascade,
  owner_email    text not null,
  file_number    text,
  status         text not null default 'sent',
  snapshot       jsonb not null,
  sent_at        timestamptz not null default now(),
  sent_by        uuid,
  sent_by_name   text,
  closed_at      timestamptz,
  closed_by      uuid,
  closed_by_name text,
  close_reason   text
);
alter table public.admission_letters drop constraint if exists admission_letters_status_ck;
alter table public.admission_letters add constraint admission_letters_status_ck check (status in ('sent', 'revoked', 'superseded'));
alter table public.admission_letters drop constraint if exists admission_letters_snapshot_ck;
alter table public.admission_letters add constraint admission_letters_snapshot_ck check (jsonb_typeof(snapshot) = 'object');
create index if not exists admission_letters_process_idx on public.admission_letters (process_id, sent_at desc);

alter table public.admission_letters enable row level security;
revoke all on table public.admission_letters from public, anon, authenticated;
grant select on table public.admission_letters to authenticated;
drop policy if exists admission_letters_select on public.admission_letters;
create policy admission_letters_select on public.admission_letters
  for select to authenticated
  using (coalesce(public.is_admissions(), false)
         or (status = 'sent' and lower(owner_email) = coalesce(public.my_email(), '-')));

create or replace function public.letter_log_json(l public.admission_letters)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'id', l.id, 'process_id', l.process_id, 'file_number', l.file_number, 'status', l.status,
    'snapshot', l.snapshot, 'sent_at', l.sent_at, 'sent_by_name', l.sent_by_name,
    'closed_at', l.closed_at, 'closed_by_name', l.closed_by_name, 'close_reason', l.close_reason)
$fn$;

create or replace function public.letter_log_send(p_process_id text, p_file_number text, p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  p      public.admission_processes;
  l      public.admission_letters;
  v_name text;
begin
  if auth.uid() is null or not coalesce(public.is_admissions(), false) then
    raise exception 'A felvételi levél kiküldését csak a felvételi iroda naplózhatja.' using errcode = '42501';
  end if;
  select * into p from public.admission_processes where id = p_process_id;
  if p.id is null or nullif(btrim(coalesce(p.owner_email, '')), '') is null then
    raise exception 'Nincs ilyen felvételi eljárás.' using errcode = '02000';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'A levél adatai hiányoznak.' using errcode = '22023';
  end if;
  if pg_column_size(p_snapshot) > 200000 then
    raise exception 'A levél adatai túl nagyok.' using errcode = '22023';
  end if;

  select nullif(btrim(pr.name), '') into v_name from public.profiles pr where pr.id = auth.uid();

  -- A korábbi érvényes kiküldés felülíródik: a jelentkező mindig csak az utolsót látja.
  update public.admission_letters
     set status = 'superseded', closed_at = now(), closed_by = auth.uid(), closed_by_name = v_name, close_reason = 'Új kiküldés'
   where process_id = p.id and status = 'sent';

  insert into public.admission_letters (process_id, owner_email, file_number, status, snapshot, sent_by, sent_by_name)
  values (p.id, lower(btrim(p.owner_email)), nullif(left(btrim(coalesce(p_file_number, '')), 80), ''), 'sent', p_snapshot, auth.uid(), v_name)
  returning * into l;

  -- Értesítés a jelentkezőnek a beszélgetésbe (62), ha az már telepítve van.
  if to_regclass('public.admission_messages') is not null then
    insert into public.admission_messages (process_id, owner_email, sender_role, sender_id, sender_name, subject, body, tone, read_by_staff_at)
    values (p.id, lower(btrim(p.owner_email)), 'system', auth.uid(), coalesce(v_name, 'Külügyi Iroda'),
            'Felvételi leveled elkészült',
            'A feltételes felvételi leveled' || coalesce(' (' || l.file_number || ')', '') || ' elkészült. A Felvételi folyamatban megtekintheted és letöltheted.',
            'success', now());
  end if;

  return public.letter_log_json(l);
end
$fn$;

create or replace function public.letter_log_revoke(p_process_id text, p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_name text;
  v_n    integer;
begin
  if auth.uid() is null or not coalesce(public.is_admissions(), false) then
    raise exception 'A kiküldést csak a felvételi iroda vonhatja vissza.' using errcode = '42501';
  end if;
  select nullif(btrim(pr.name), '') into v_name from public.profiles pr where pr.id = auth.uid();
  update public.admission_letters
     set status = 'revoked', closed_at = now(), closed_by = auth.uid(), closed_by_name = v_name,
         close_reason = nullif(left(btrim(coalesce(p_reason, '')), 300), '')
   where process_id = p_process_id and status = 'sent';
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

create or replace function public.letter_log_list(p_process_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_staff boolean := coalesce(public.is_admissions(), false);
  p       public.admission_processes;
begin
  if auth.uid() is null then
    raise exception 'Bejelentkezés szükséges.' using errcode = '42501';
  end if;
  select * into p from public.admission_processes where id = p_process_id;
  if p.id is null then
    raise exception 'Nincs ilyen felvételi eljárás.' using errcode = '02000';
  end if;
  if not v_staff and lower(coalesce(p.owner_email, '')) <> coalesce(public.my_email(), '-') then
    raise exception 'Ehhez a felvételi eljáráshoz nincs hozzáférésed.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(public.letter_log_json(l) order by l.sent_at desc)
      from public.admission_letters l
     where l.process_id = p.id and (v_staff or l.status = 'sent')
  ), '[]'::jsonb);
end
$fn$;

-- ============================================================
-- B) INTERJÚFELVÉTELEK
-- ============================================================
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('interview-recordings', 'interview-recordings', false, 2147483648,
          array['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg', 'video/x-msvideo',
                'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/wav', 'audio/ogg', 'audio/x-m4a'])
  on conflict (id) do update
     set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise notice 'A tároló (interview-recordings) nem hozható létre automatikusan (%). Hozd létre kézzel: Storage -> New bucket, privát.', sqlerrm;
end $$;

create table if not exists public.interview_recordings (
  id               uuid primary key default gen_random_uuid(),
  process_id       text references public.admission_processes(id) on delete cascade,
  slot_id          text,
  path             text not null unique,
  file_name        text not null,
  size_bytes       bigint,
  mime             text,
  note             text,
  uploaded_by      uuid,
  uploaded_by_name text,
  uploaded_at      timestamptz not null default now()
);
alter table public.interview_recordings drop constraint if exists interview_recordings_target_ck;
alter table public.interview_recordings add constraint interview_recordings_target_ck check (process_id is not null or slot_id is not null);
create index if not exists interview_recordings_process_idx on public.interview_recordings (process_id, uploaded_at desc);
create index if not exists interview_recordings_slot_idx on public.interview_recordings (slot_id);

-- Ki férhet a felvételekhez: a felvételi iroda és az aktív interjúztatók.
create or replace function public.interview_recording_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null and (coalesce(public.is_admissions(), false) or coalesce(public.interview_is_interviewer(), false))
$fn$;

alter table public.interview_recordings enable row level security;
revoke all on table public.interview_recordings from public, anon, authenticated;
grant select on table public.interview_recordings to authenticated;
drop policy if exists interview_recordings_select on public.interview_recordings;
create policy interview_recordings_select on public.interview_recordings
  for select to authenticated using (public.interview_recording_access());

create or replace function public.interview_recording_add(
  p_path       text,
  p_file_name  text,
  p_size       bigint default null,
  p_mime       text default null,
  p_process_id text default null,
  p_slot_id    text default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_process text := nullif(btrim(coalesce(p_process_id, '')), '');
  v_slot    text := nullif(btrim(coalesce(p_slot_id, '')), '');
  v_name    text;
  r         public.interview_recordings;
begin
  if not public.interview_recording_access() then
    raise exception 'Interjúfelvételt csak a felvételi iroda vagy interjúztató tölthet fel.' using errcode = '42501';
  end if;
  if coalesce(p_path, '') not like 'rec/%' or p_path like '%..%' then
    raise exception 'Hibás felvétel-útvonal.' using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'interview-recordings' and o.name = p_path) then
    raise exception 'A feltöltött felvétel nem található a tárolóban.' using errcode = '22023';
  end if;
  if v_process is null and v_slot is not null and to_regclass('public."interviewSlots"') is not null then
    execute 'select process_id from public."interviewSlots" where id = $1' into v_process using v_slot;
  end if;
  if v_process is not null and not exists (select 1 from public.admission_processes where id = v_process) then
    raise exception 'Nincs ilyen felvételi eljárás.' using errcode = '02000';
  end if;
  if v_process is null and v_slot is null then
    raise exception 'A felvételt egy interjúhoz vagy felvételi eljáráshoz kell kötni.' using errcode = '22023';
  end if;
  select nullif(btrim(pr.name), '') into v_name from public.profiles pr where pr.id = auth.uid();

  insert into public.interview_recordings (process_id, slot_id, path, file_name, size_bytes, mime, note, uploaded_by, uploaded_by_name)
  values (v_process, v_slot, p_path, left(coalesce(nullif(btrim(p_file_name), ''), 'felvetel'), 200),
          case when p_size >= 0 then p_size end, left(nullif(btrim(coalesce(p_mime, '')), ''), 120),
          nullif(left(btrim(coalesce(p_note, '')), 500), ''), auth.uid(), v_name)
  returning * into r;
  return to_jsonb(r);
end
$fn$;

create or replace function public.interview_recording_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_path text;
begin
  if auth.uid() is null or not coalesce(public.is_admissions(), false) then
    raise exception 'Felvételt csak a felvételi iroda törölhet.' using errcode = '42501';
  end if;
  delete from public.interview_recordings where id = p_id returning path into v_path;
  if v_path is null then
    raise exception 'Nincs ilyen felvétel.' using errcode = '02000';
  end if;
  return v_path;
end
$fn$;

create or replace function public.interview_recordings_list(p_process_id text default null, p_slot_id text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.interview_recording_access() then
    raise exception 'Az interjúfelvételekhez nincs hozzáférésed.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'process_id', r.process_id, 'slot_id', r.slot_id, 'path', r.path, 'file_name', r.file_name,
             'size_bytes', r.size_bytes, 'mime', r.mime, 'note', r.note, 'uploaded_at', r.uploaded_at, 'uploaded_by_name', r.uploaded_by_name,
             'ref_no', p.ref_no,
             'applicant_name', case when p.id is not null then public.interview_applicant_name(p) end,
             'owner_email', lower(p.owner_email),
             'program_id', p.program_id,
             'program_ids', case when jsonb_typeof(p.data -> 'program_ids') = 'array' then p.data -> 'program_ids' else '[]'::jsonb end,
             'term', p.data ->> 'term')
           order by r.uploaded_at desc)
      from public.interview_recordings r
      left join public.admission_processes p on p.id = r.process_id
     where (p_process_id is null or r.process_id = p_process_id)
       and (p_slot_id is null or r.slot_id = p_slot_id)
  ), '[]'::jsonb);
end
$fn$;

do $rec$
begin
  begin
    execute $p$drop policy if exists "recordings_read" on storage.objects$p$;
    execute $p$create policy "recordings_read" on storage.objects for select to authenticated
              using (bucket_id = 'interview-recordings' and public.interview_recording_access())$p$;
    execute $p$drop policy if exists "recordings_insert" on storage.objects$p$;
    execute $p$create policy "recordings_insert" on storage.objects for insert to authenticated
              with check (bucket_id = 'interview-recordings' and (storage.foldername(name))[1] = 'rec' and public.interview_recording_access())$p$;
    execute $p$drop policy if exists "recordings_delete" on storage.objects$p$;
    execute $p$create policy "recordings_delete" on storage.objects for delete to authenticated
              using (bucket_id = 'interview-recordings' and coalesce(public.is_admissions(), false))$p$;
  exception when others then
    raise notice 'Storage policy-k kihagyva (%). Allitsd be kezzel: Storage -> interview-recordings -> Policies.', sqlerrm;
  end;
end
$rec$;

-- ---------- jogosultságok ----------
revoke all on function public.letter_log_json(public.admission_letters)                          from public, anon, authenticated;
revoke all on function public.letter_log_send(text, text, jsonb)                                 from public, anon;
revoke all on function public.letter_log_revoke(text, text)                                      from public, anon;
revoke all on function public.letter_log_list(text)                                              from public, anon;
revoke all on function public.interview_recording_access()                                       from public, anon;
revoke all on function public.interview_recording_add(text, text, bigint, text, text, text, text) from public, anon;
revoke all on function public.interview_recording_delete(uuid)                                   from public, anon;
revoke all on function public.interview_recordings_list(text, text)                              from public, anon;
grant execute on function public.letter_log_send(text, text, jsonb)                                 to authenticated;
grant execute on function public.letter_log_revoke(text, text)                                      to authenticated;
grant execute on function public.letter_log_list(text)                                              to authenticated;
-- Az access a storage-szabályban is fut, ezért a bejelentkezett felhasználó hívhatja.
grant execute on function public.interview_recording_access()                                       to authenticated;
grant execute on function public.interview_recording_add(text, text, bigint, text, text, text, text) to authenticated;
grant execute on function public.interview_recording_delete(uuid)                                   to authenticated;
grant execute on function public.interview_recordings_list(text, text)                              to authenticated;

-- ---------- ellenőrzés ----------
do $$
begin
  if has_table_privilege('anon', 'public.admission_letters', 'select') or has_table_privilege('anon', 'public.interview_recordings', 'select') then
    raise exception 'BIZTONSAGI HIBA: az anon olvashatja a naplot vagy a felveteleket.';
  end if;
  if has_table_privilege('authenticated', 'public.admission_letters', 'insert') or has_table_privilege('authenticated', 'public.interview_recordings', 'insert') then
    raise exception 'BIZTONSAGI HIBA: a tabla kozvetlenul irhato.';
  end if;
  if has_function_privilege('anon', 'public.letter_log_send(text, text, jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a letter_log_send fuggvenyt.';
  end if;
  raise notice '63: rendben.';
end $$;

notify pgrst, 'reload schema';
