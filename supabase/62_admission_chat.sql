-- ============================================================
-- UniPortal — 62: Üzenetváltás a felvételi eljárásban (chat + fájlok)
-- ------------------------------------------------------------
-- MIÉRT: az ügyintéző „Beszélgetés a jelentkezővel” üzenetei a
-- process_messages táblába kerültek, de a jelentkező sehol nem látta őket:
--   • a régi hallgatói nézet csak értesítéslistát mutatott (válasz nélkül), és
--     csak annak, akinek régi hallgatói nyilvántartási sora is volt;
--   • „csatolmány” csak egy már feltöltött dokumentumra mutató hivatkozás
--     lehetett — az ügyintéző által feltöltött fájlt a jelentkező a tárolási
--     szabály miatt (csak a saját mappáját olvashatja) meg sem nyithatta;
--   • a process_messages táblán a 07-es „approved_all” szabály él (a 12-es
--     flip élesben nincs érvényben): minden jóváhagyott fiók minden üzenetet
--     olvashat.
--
-- MIT CSINÁL:
--   1. Új tábla: public.admission_messages — SZIGORÚ RLS-sel (a jelentkező a
--      saját eljárásainak üzeneteit, a felvételi iroda mindet olvassa). Írni
--      csak a lenti SECURITY DEFINER függvényeken át lehet.
--   2. Függvények: msg_send, msg_thread, msg_mark_read, msg_inbox,
--      msg_unread_count (+ belső: msg_access, msg_json).
--   3. Fájlok: a 'documents' tároló „chat/<eljárás-azonosító>/…” mappáját az
--      eljárás résztvevői (a jelentkező és a felvételi iroda) olvashatják és
--      tölthetik.
--   4. A régi process_messages sorokat átmásolja (idempotens: legacy_id).
--   5. Az interjú-értesítések (61: interview_notify) mostantól ide kerülnek.
--   6. Realtime: a tábla bekerül a supabase_realtime publikációba.
--
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 0. előfeltételek ----------
do $$
begin
  if to_regclass('public.admission_processes') is null then
    raise exception 'MEGTAGADVA: hiányzik a public.admission_processes tábla (04-es migráció).';
  end if;
  if to_regprocedure('public.is_admissions()') is null or to_regprocedure('public.my_email()') is null
     or to_regprocedure('public.is_approved()') is null then
    raise exception 'MEGTAGADVA: előbb a 07-es és a 11-es migráció kell (is_approved, is_admissions, my_email).';
  end if;
  if to_regprocedure('public.interview_applicant_name(public.admission_processes)') is null then
    raise exception 'MEGTAGADVA: előbb a 61_interview_calendar.sql kell.';
  end if;
end $$;

-- ---------- 1. tábla ----------
create table if not exists public.admission_messages (
  id                   uuid primary key default gen_random_uuid(),
  process_id           text not null references public.admission_processes(id) on delete cascade,
  owner_email          text not null,
  sender_role          text not null,
  sender_id            uuid,
  sender_name          text,
  subject              text,
  body                 text not null default '',
  files                jsonb not null default '[]'::jsonb,
  tone                 text,
  created_at           timestamptz not null default now(),
  read_by_applicant_at timestamptz,
  read_by_staff_at     timestamptz,
  legacy_id            text unique
);

alter table public.admission_messages drop constraint if exists admission_messages_role_ck;
alter table public.admission_messages add constraint admission_messages_role_ck
  check (sender_role in ('staff', 'applicant', 'system'));
alter table public.admission_messages drop constraint if exists admission_messages_body_ck;
alter table public.admission_messages add constraint admission_messages_body_ck
  check (char_length(body) <= 8000);
alter table public.admission_messages drop constraint if exists admission_messages_files_ck;
alter table public.admission_messages add constraint admission_messages_files_ck
  check (jsonb_typeof(files) = 'array');

create index if not exists admission_messages_process_idx on public.admission_messages (process_id, created_at);
create index if not exists admission_messages_owner_idx   on public.admission_messages (lower(owner_email));
create index if not exists admission_messages_staff_unread_idx on public.admission_messages (process_id)
  where sender_role = 'applicant' and read_by_staff_at is null;

alter table public.admission_messages enable row level security;
revoke all on table public.admission_messages from public, anon, authenticated;
-- Csak OLVASÁS közvetlenül (a realtime is ezen a szabályon át kézbesít); írás csak függvényen át.
grant select on table public.admission_messages to authenticated;
drop policy if exists admission_messages_select on public.admission_messages;
create policy admission_messages_select on public.admission_messages
  for select to authenticated
  using (coalesce(public.is_admissions(), false) or lower(owner_email) = coalesce(public.my_email(), '-'));

-- ---------- 2. belső segédfüggvények ----------
-- Ki vehet részt az eljárás beszélgetésében: 'staff' (felvételi iroda) | 'applicant' (a tulajdonos) | null.
create or replace function public.msg_access(p_process_id text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when coalesce(public.is_admissions(), false) then 'staff'
    when exists (
      select 1 from public.admission_processes p
       where p.id = p_process_id
         and lower(coalesce(p.owner_email, '')) = coalesce(public.my_email(), '-')
         and coalesce(public.is_approved(), false)
    ) then 'applicant'
    else null
  end
$fn$;

create or replace function public.msg_json(m public.admission_messages)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'id',                   m.id,
    'process_id',           m.process_id,
    'sender_role',          m.sender_role,
    'sender_name',          m.sender_name,
    'subject',              m.subject,
    'body',                 m.body,
    'files',                m.files,
    'tone',                 m.tone,
    'created_at',           m.created_at,
    'read_by_applicant_at', m.read_by_applicant_at,
    'read_by_staff_at',     m.read_by_staff_at,
    'own',                  (m.sender_id is not null and m.sender_id = auth.uid()))
$fn$;

-- ---------- 3. üzenetküldés ----------
create or replace function public.msg_send(
  p_process_id text,
  p_body       text,
  p_subject    text  default null,
  p_files      jsonb default '[]'::jsonb,
  p_tone       text  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role  text;
  p       public.admission_processes;
  v_body  text := btrim(coalesce(p_body, ''));
  v_files jsonb := coalesce(p_files, '[]'::jsonb);
  v_tiszta jsonb := '[]'::jsonb;
  v_name  text;
  f       jsonb;
  m       public.admission_messages;
begin
  if auth.uid() is null then
    raise exception 'Bejelentkezés szükséges.' using errcode = '42501';
  end if;
  v_role := public.msg_access(p_process_id);
  if v_role is null then
    raise exception 'Ehhez a felvételi eljáráshoz nem küldhetsz üzenetet.' using errcode = '42501';
  end if;

  select * into p from public.admission_processes where id = p_process_id;
  if p.id is null or nullif(btrim(coalesce(p.owner_email, '')), '') is null then
    raise exception 'Nincs ilyen felvételi eljárás.' using errcode = '02000';
  end if;

  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Hibás csatolmánylista.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_files) > 10 then
    raise exception 'Egy üzenethez legfeljebb 10 fájl csatolható.' using errcode = '22023';
  end if;
  if v_body = '' and jsonb_array_length(v_files) = 0 then
    raise exception 'Üres üzenet nem küldhető.' using errcode = '22023';
  end if;
  if char_length(v_body) > 8000 then
    raise exception 'Az üzenet legfeljebb 8000 karakter lehet.' using errcode = '22023';
  end if;

  /* Csatolmány kétféle lehet:
       • feltöltött fájl — a tároló „chat/<ez az eljárás>/…” mappájából, és a
         fájlnak léteznie kell (máshová mutató útvonal nem csempészhető be);
       • hivatkozás az eljárás egy már feltöltött dokumentumára (ref) — csak az
         iroda küldheti, és csak létező data.docs kulcsra. */
  for f in select * from jsonb_array_elements(v_files) loop
    if jsonb_typeof(f) <> 'object' then
      raise exception 'Hibás csatolmány.' using errcode = '22023';
    end if;
    if f ? 'path' then
      if (f->>'path') not like ('chat/' || p.id || '/%') or (f->>'path') like '%..%' then
        raise exception 'A csatolmány csak ennek az eljárásnak az üzenetmappájából származhat.' using errcode = '22023';
      end if;
      if not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = f->>'path') then
        raise exception 'A csatolt fájl nem található a tárolóban: %', f->>'name' using errcode = '22023';
      end if;
      v_tiszta := v_tiszta || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'path', f->>'path',
        'name', left(coalesce(nullif(btrim(f->>'name'), ''), 'fájl'), 200),
        'size', case when coalesce(f->>'size', '') ~ '^[0-9]{1,12}$' then (f->>'size')::bigint end,
        'type', left(nullif(btrim(f->>'type'), ''), 120))));
    elsif f ? 'ref' then
      if v_role <> 'staff' or not (coalesce(p.data->'docs', '{}'::jsonb) ? (f->>'ref')) then
        raise exception 'Ismeretlen dokumentum-hivatkozás.' using errcode = '22023';
      end if;
      v_tiszta := v_tiszta || jsonb_build_array(jsonb_build_object(
        'ref', f->>'ref', 'name', left(coalesce(nullif(btrim(f->>'name'), ''), f->>'ref'), 200)));
    else
      raise exception 'Hibás csatolmány.' using errcode = '22023';
    end if;
  end loop;

  select nullif(btrim(pr.name), '') into v_name from public.profiles pr where pr.id = auth.uid();
  if v_role = 'applicant' then v_name := coalesce(v_name, public.interview_applicant_name(p)); end if;

  insert into public.admission_messages
    (process_id, owner_email, sender_role, sender_id, sender_name, subject, body, files, tone,
     read_by_applicant_at, read_by_staff_at)
  values
    (p.id, lower(btrim(p.owner_email)), v_role, auth.uid(), coalesce(v_name, case when v_role = 'staff' then 'Külügyi Iroda' end),
     nullif(left(btrim(coalesce(p_subject, '')), 200), ''), v_body, v_tiszta,
     case when v_role = 'staff' and p_tone in ('info', 'success', 'warning', 'action') then p_tone end,
     case when v_role = 'applicant' then now() end,
     case when v_role = 'staff' then now() end)
  returning * into m;

  return public.msg_json(m);
end
$fn$;

-- ---------- 4. egy eljárás beszélgetése ----------
create or replace function public.msg_thread(p_process_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text := public.msg_access(p_process_id);
  p      public.admission_processes;
begin
  if auth.uid() is null or v_role is null then
    raise exception 'Ehhez a felvételi eljáráshoz nincs hozzáférésed.' using errcode = '42501';
  end if;
  select * into p from public.admission_processes where id = p_process_id;
  if p.id is null then
    raise exception 'Nincs ilyen felvételi eljárás.' using errcode = '02000';
  end if;
  return jsonb_build_object(
    'role',           v_role,
    'process_id',     p.id,
    'ref_no',         p.ref_no,
    'applicant_name', public.interview_applicant_name(p),
    'owner_email',    lower(coalesce(p.owner_email, '')),
    'messages',       coalesce((select jsonb_agg(public.msg_json(m) order by m.created_at, m.id)
                                  from public.admission_messages m where m.process_id = p.id), '[]'::jsonb));
end
$fn$;

-- ---------- 5. olvasottnak jelölés (a MÁSIK fél üzenetei) ----------
create or replace function public.msg_mark_read(p_process_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text := public.msg_access(p_process_id);
  v_n    integer;
begin
  if auth.uid() is null or v_role is null then
    raise exception 'Ehhez a felvételi eljáráshoz nincs hozzáférésed.' using errcode = '42501';
  end if;
  if v_role = 'staff' then
    update public.admission_messages set read_by_staff_at = now()
     where process_id = p_process_id and sender_role = 'applicant' and read_by_staff_at is null;
  else
    update public.admission_messages set read_by_applicant_at = now()
     where process_id = p_process_id and sender_role <> 'applicant' and read_by_applicant_at is null;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- ---------- 6. beszélgetéslista ----------
-- Iroda: a beszélgetéssel rendelkező eljárások (p_mind = true: minden eljárás, új beszélgetéshez).
-- Jelentkező: a saját eljárásai (üzenet nélkül is, hogy írhasson az irodának).
create or replace function public.msg_inbox(p_mind boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_staff boolean := coalesce(public.is_admissions(), false);
  v_me    text := coalesce(public.my_email(), '-');
begin
  if auth.uid() is null then
    raise exception 'Bejelentkezés szükséges.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.utolso desc nulls last, x.letrehozva desc)
      from (
        select jsonb_build_object(
                 'process_id',     p.id,
                 'ref_no',         p.ref_no,
                 'applicant_name', public.interview_applicant_name(p),
                 'owner_email',    lower(coalesce(p.owner_email, '')),
                 'stage',          p.stage,
                 'program_id',     p.program_id,
                 'program_ids',    coalesce(p.data->'program_ids', '[]'::jsonb),
                 'term',           p.data->>'term',
                 'cancelled',      coalesce(p.data->>'_cancelled', '') = 'true',
                 'last_at',        l.created_at,
                 'last_body',      left(coalesce(nullif(l.body, ''), l.subject, ''), 160),
                 'last_role',      l.sender_role,
                 'last_files',     coalesce(jsonb_array_length(l.files), 0),
                 'total',          c.total,
                 'unread',         c.unread) as j,
               l.created_at as utolso,
               p.created_at as letrehozva
          from public.admission_processes p
          cross join lateral (
            select count(*) as total,
                   count(*) filter (where (v_staff and m.sender_role = 'applicant' and m.read_by_staff_at is null)
                                       or (not v_staff and m.sender_role <> 'applicant' and m.read_by_applicant_at is null)) as unread
              from public.admission_messages m where m.process_id = p.id
          ) c
          left join lateral (
            select m.* from public.admission_messages m where m.process_id = p.id
             order by m.created_at desc, m.id desc limit 1
          ) l on true
         where p.id not like 'PROC-demo%'
           and nullif(btrim(coalesce(p.owner_email, '')), '') is not null
           and (v_staff or lower(p.owner_email) = v_me)
           and (c.total > 0 or ((p_mind or not v_staff) and coalesce(p.data->>'_cancelled', '') <> 'true'))
      ) x
  ), '[]'::jsonb);
end
$fn$;

-- ---------- 7. olvasatlan üzenetek száma (értesítő) ----------
create or replace function public.msg_unread_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when auth.uid() is null then 0
    when coalesce(public.is_admissions(), false) then
      (select count(*)::int from public.admission_messages m
        where m.sender_role = 'applicant' and m.read_by_staff_at is null)
    else
      (select count(*)::int from public.admission_messages m
        where lower(m.owner_email) = coalesce(public.my_email(), '-')
          and m.sender_role <> 'applicant' and m.read_by_applicant_at is null)
  end
$fn$;

-- ---------- 8. interjú-értesítések: mostantól a beszélgetésbe ----------
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

  insert into public.admission_messages
    (process_id, owner_email, sender_role, sender_id, sender_name, subject, body, tone, read_by_staff_at)
  values
    (p.id, lower(btrim(p.owner_email)), 'system', auth.uid(), coalesce(v_sender, 'Külügyi Iroda'),
     p_subject, coalesce(p_body, ''),
     case when p_tone in ('info', 'success', 'warning', 'action') then p_tone else 'info' end,
     now());
end
$fn$;

-- ---------- 9. a régi üzenetek átmásolása (idempotens) ----------
do $$
begin
  if to_regclass('public.process_messages') is null then return; end if;
  insert into public.admission_messages
    (process_id, owner_email, sender_role, sender_name, subject, body, files, tone, created_at,
     read_by_applicant_at, read_by_staff_at, legacy_id)
  select pm.process_id,
         lower(btrim(p.owner_email)),
         case when coalesce(pm.sender, '') ~* '(rendszer|system)' then 'system' else 'staff' end,
         coalesce(nullif(btrim(pm.sender), ''), 'Külügyi Iroda'),
         nullif(left(btrim(coalesce(pm.subject, '')), 200), ''),
         left(coalesce(pm.preview, ''), 8000),
         coalesce((
           select jsonb_agg(jsonb_build_object('ref', a->>'id', 'name', coalesce(a->>'label', a->>'fileName', a->>'id')))
             from jsonb_array_elements(case when jsonb_typeof(pm.attachments) = 'array' then pm.attachments else '[]'::jsonb end) a
            where a ? 'id'
         ), '[]'::jsonb),
         case when pm.tone in ('info', 'success', 'warning', 'action') then pm.tone end,
         coalesce(pm.created_at, now()),
         case when coalesce(pm.read, false) then coalesce(pm.created_at, now()) end,
         coalesce(pm.created_at, now()),
         pm.id
    from public.process_messages pm
    join public.admission_processes p on p.id = pm.process_id
   where nullif(btrim(coalesce(p.owner_email, '')), '') is not null
     and pm.id not like 'msg-welcome%'
  on conflict (legacy_id) do nothing;
end $$;

-- ---------- 10. fájlok a tárolóban: chat/<eljárás>/… ----------
do $chat$
begin
  begin
    execute $p$drop policy if exists "documents_chat_read" on storage.objects$p$;
    execute $p$create policy "documents_chat_read" on storage.objects
              for select to authenticated
              using (
                bucket_id = 'documents'
                and (storage.foldername(name))[1] = 'chat'
                and public.msg_access((storage.foldername(name))[2]) is not null
              )$p$;
    execute $p$drop policy if exists "documents_chat_insert" on storage.objects$p$;
    execute $p$create policy "documents_chat_insert" on storage.objects
              for insert to authenticated
              with check (
                bucket_id = 'documents'
                and (storage.foldername(name))[1] = 'chat'
                and public.msg_access((storage.foldername(name))[2]) is not null
              )$p$;
  exception when others then
    raise notice 'Storage policy-k kihagyva (%). Allitsd be kezzel: Storage -> documents -> Policies.', sqlerrm;
  end;
end
$chat$;

-- ---------- 11. jogosultságok ----------
revoke all on function public.msg_access(text)                                  from public, anon;
revoke all on function public.msg_json(public.admission_messages)               from public, anon, authenticated;
revoke all on function public.msg_send(text, text, text, jsonb, text)           from public, anon;
revoke all on function public.msg_thread(text)                                  from public, anon;
revoke all on function public.msg_mark_read(text)                               from public, anon;
revoke all on function public.msg_inbox(boolean)                                from public, anon;
revoke all on function public.msg_unread_count()                                from public, anon;
revoke all on function public.interview_notify(text, text, text, text)          from public, anon, authenticated;
-- A msg_access a storage-szabályban is fut, ezért a bejelentkezett felhasználó hívhatja.
grant execute on function public.msg_access(text)                               to authenticated;
grant execute on function public.msg_send(text, text, text, jsonb, text)        to authenticated;
grant execute on function public.msg_thread(text)                               to authenticated;
grant execute on function public.msg_mark_read(text)                            to authenticated;
grant execute on function public.msg_inbox(boolean)                             to authenticated;
grant execute on function public.msg_unread_count()                             to authenticated;

-- ---------- 12. realtime ----------
do $$
begin
  begin execute 'alter publication supabase_realtime add table public.admission_messages'; exception when others then null; end;
end $$;

-- ---------- 13. ellenőrzés ----------
do $$
begin
  if has_table_privilege('anon', 'public.admission_messages', 'select') then
    raise exception 'BIZTONSAGI HIBA: az anon olvashatja az admission_messages tablat.';
  end if;
  if has_table_privilege('authenticated', 'public.admission_messages', 'insert')
     or has_table_privilege('authenticated', 'public.admission_messages', 'update')
     or has_table_privilege('authenticated', 'public.admission_messages', 'delete') then
    raise exception 'BIZTONSAGI HIBA: az admission_messages kozvetlenul irhato.';
  end if;
  if has_function_privilege('anon', 'public.msg_send(text, text, text, jsonb, text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a msg_send fuggvenyt.';
  end if;
  raise notice '62: rendben — % uzenet a beszelgetesekben.', (select count(*) from public.admission_messages);
end $$;

notify pgrst, 'reload schema';
