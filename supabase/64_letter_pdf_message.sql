-- ============================================================
-- UniPortal — 64: A felvételi levél PDF-je az értesítő üzenetben
-- ------------------------------------------------------------
-- A 63-as kiküldési napló a jelentkező beszélgetésébe (62) szöveges
-- értesítést írt. Most a kiküldéskor elkészült PDF is csatolható:
--   • letter_log_send új, nem kötelező paramétere: p_file
--     ({ path, name, size, type }) — a fájlnak a documents tároló
--     chat/<ez az eljárás>/… mappájában kell lennie, és léteznie kell
--     (ugyanaz a szabály, mint a msg_send csatolmányainál);
--   • a napló sora megőrzi a fájlt (admission_letters.file);
--   • az értesítő üzenet csatolmányként kapja, kind = 'letter' és
--     letter_id jelöléssel — a felület erről ismeri fel a levél-értesítést,
--     és ad mellé hivatkozást a levél lépésére.
-- A PDF nélküli hívás (a régi, 3 paraméteres alak) változatlanul működik.
--
-- Idempotens — biztonságosan újrafuttatható. Utána futtasd újra a
-- 21_echo_harden_submit.sql-t is.
-- ============================================================

do $$
begin
  if to_regclass('public.admission_letters') is null or to_regclass('public.admission_messages') is null then
    raise exception 'MEGTAGADVA: előbb a 62-es és a 63-as migráció kell (admission_messages, admission_letters).';
  end if;
end $$;

alter table public.admission_letters add column if not exists file jsonb;
alter table public.admission_letters drop constraint if exists admission_letters_file_ck;
alter table public.admission_letters add constraint admission_letters_file_ck check (file is null or jsonb_typeof(file) = 'object');

create or replace function public.letter_log_json(l public.admission_letters)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'id', l.id, 'process_id', l.process_id, 'file_number', l.file_number, 'status', l.status,
    'snapshot', l.snapshot, 'file', l.file, 'sent_at', l.sent_at, 'sent_by_name', l.sent_by_name,
    'closed_at', l.closed_at, 'closed_by_name', l.closed_by_name, 'close_reason', l.close_reason)
$fn$;

-- A régi, 3 paraméteres alak helyére a 4 paraméteres lép (p_file alapértéke null,
-- így a 3 argumentumos hívás is ezt éri el — két változat kétértelmű lenne).
drop function if exists public.letter_log_send(text, text, jsonb);

create or replace function public.letter_log_send(p_process_id text, p_file_number text, p_snapshot jsonb, p_file jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  p      public.admission_processes;
  l      public.admission_letters;
  v_name text;
  v_file jsonb;
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

  -- A levél PDF-je: csak ennek az eljárásnak az üzenetmappájából, létező fájl.
  if p_file is not null and jsonb_typeof(p_file) <> 'null' then
    if jsonb_typeof(p_file) <> 'object' or nullif(btrim(coalesce(p_file->>'path', '')), '') is null then
      raise exception 'Hibás levél-fájl.' using errcode = '22023';
    end if;
    if (p_file->>'path') not like ('chat/' || p.id || '/%') or (p_file->>'path') like '%..%' then
      raise exception 'A levél PDF-je csak ennek az eljárásnak az üzenetmappájából származhat.' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = p_file->>'path') then
      raise exception 'A levél PDF-je nem található a tárolóban.' using errcode = '22023';
    end if;
    v_file := jsonb_strip_nulls(jsonb_build_object(
      'path', p_file->>'path',
      'name', left(coalesce(nullif(btrim(p_file->>'name'), ''), 'Conditional_Acceptance_Letter.pdf'), 200),
      'size', case when coalesce(p_file->>'size', '') ~ '^[0-9]{1,12}$' then (p_file->>'size')::bigint end,
      'type', left(nullif(btrim(p_file->>'type'), ''), 120)));
  end if;

  select nullif(btrim(pr.name), '') into v_name from public.profiles pr where pr.id = auth.uid();

  -- A korábbi érvényes kiküldés felülíródik: a jelentkező mindig csak az utolsót látja.
  update public.admission_letters
     set status = 'superseded', closed_at = now(), closed_by = auth.uid(), closed_by_name = v_name, close_reason = 'Új kiküldés'
   where process_id = p.id and status = 'sent';

  insert into public.admission_letters (process_id, owner_email, file_number, status, snapshot, file, sent_by, sent_by_name)
  values (p.id, lower(btrim(p.owner_email)), nullif(left(btrim(coalesce(p_file_number, '')), 80), ''), 'sent', p_snapshot, v_file, auth.uid(), v_name)
  returning * into l;

  -- Értesítés a jelentkezőnek a beszélgetésbe (62), a PDF-fel csatolmányként.
  insert into public.admission_messages (process_id, owner_email, sender_role, sender_id, sender_name, subject, body, files, tone, read_by_staff_at)
  values (p.id, lower(btrim(p.owner_email)), 'system', auth.uid(), coalesce(v_name, 'Külügyi Iroda'),
          'Felvételi leveled elkészült',
          'A feltételes felvételi leveled' || coalesce(' (' || l.file_number || ')', '') || ' elkészült. A Felvételi folyamatban megtekintheted és letöltheted.'
            || case when v_file is not null then ' A levelet PDF-ben csatoltuk.' else '' end,
          case when v_file is null then '[]'::jsonb
               else jsonb_build_array(v_file || jsonb_build_object('kind', 'letter', 'letter_id', l.id)) end,
          'success', now());

  return public.letter_log_json(l);
end
$fn$;

revoke all on function public.letter_log_json(public.admission_letters)          from public, anon, authenticated;
revoke all on function public.letter_log_send(text, text, jsonb, jsonb)          from public, anon;
grant execute on function public.letter_log_send(text, text, jsonb, jsonb)       to authenticated;

notify pgrst, 'reload schema';

do $$ begin raise notice '64: rendben.'; end $$;
