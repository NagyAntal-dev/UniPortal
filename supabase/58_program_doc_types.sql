-- ============================================================================
-- 58_program_doc_types.sql — szabadon bővíthető „Szükséges dokumentumok”
--
-- MIÉRT KELL
--   A program/képzés szerkesztőjében a kötelező dokumentumok listája eddig a
--   kódba volt égetve (features/programs.jsx, PROG_DOC_DEFS: útlevél,
--   érettségi, diploma…). Új típust — pl. „Orvosi alkalmassági igazolás” —
--   csak fejlesztő tudott felvenni. Mostantól az admin a szerkesztőből hoz
--   létre újat, és az onnantól MINDEN program és képzés szerkesztésekor
--   választható.
--
-- A DÖNTÉSEK
--   * A beépített típusok a kódban maradnak; ez a tábla csak az EGYEDIEKET
--     tartja. A kulcs 'c_' előtagú, így beépítettel nem ütközhet.
--   * A KULCS NEM VÁLTOZHAT. Rá hivatkozik a programs.required_docs, a
--     jelentkezés data.docs objektuma és a feltöltött fájl tárolási útvonala
--     is. Átnevezni a MEGNEVEZÉST lehet; a kulcsot a trigger visszaállítja.
--   * NINCS TÖRLÉS, csak elrejtés (active = false). Egy már használt típus
--     törlése után a hallgató feltöltött dokumentuma név nélkül maradna.
--     Az elrejtett típus a meglévő programokban tovább él, csak újonnan nem
--     választható.
--   * Olvasni minden bejelentkezett felhasználó tud (a hallgatónak is látnia
--     kell, MIT kell feltöltenie); írni csak rendszergazda (is_admin():
--     SUPERADMIN vagy ADMIN). Az anon semmit nem lát.
--
-- FÜGGŐSÉG: 11_rbac_additive.sql (public.is_admin)
-- IDEMPOTENS: if not exists / create or replace / drop policy if exists.
-- ============================================================================

create table if not exists public.program_doc_type (
  key         text primary key
              check (key ~ '^c_[a-z0-9_]{2,60}$'),
  label_hu    text not null
              check (char_length(btrim(label_hu)) between 2 and 120),
  label_en    text
              check (label_en is null or char_length(btrim(label_en)) between 2 and 120),
  active      boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Ugyanazzal a névvel ne lehessen kétszer felvenni (kis-nagybetű független).
create unique index if not exists program_doc_type_label_hu_uq
  on public.program_doc_type (lower(btrim(label_hu)));

-- A kulcs, a létrehozó és a létrehozás ideje nem írható felül; a létrehozót
-- a szerver tölti ki, nem a kliens.
create or replace function public.program_doc_type_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.key        := old.key;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.label_hu   := btrim(new.label_hu);
  new.label_en   := nullif(btrim(coalesce(new.label_en, '')), '');
  new.updated_at := now();
  return new;
end $fn$;

revoke all on function public.program_doc_type_guard() from public;
revoke all on function public.program_doc_type_guard() from anon;

drop trigger if exists program_doc_type_guard on public.program_doc_type;
create trigger program_doc_type_guard
  before insert or update on public.program_doc_type
  for each row execute function public.program_doc_type_guard();

alter table public.program_doc_type enable row level security;

drop policy if exists program_doc_type_read   on public.program_doc_type;
drop policy if exists program_doc_type_insert on public.program_doc_type;
drop policy if exists program_doc_type_update on public.program_doc_type;

create policy program_doc_type_read on public.program_doc_type
  for select to authenticated using (true);
create policy program_doc_type_insert on public.program_doc_type
  for insert to authenticated with check (public.is_admin());
create policy program_doc_type_update on public.program_doc_type
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- Szándékosan NINCS delete policy: elrejtés van, törlés nincs.

revoke all on public.program_doc_type from anon;
revoke all on public.program_doc_type from public;
grant select, insert, update on public.program_doc_type to authenticated;

-- Ellenőrzés: az anon ne lássa, és törölni senki ne tudjon policy nélkül.
do $blk$
begin
  if has_table_privilege('anon', 'public.program_doc_type', 'select') then
    raise exception 'BIZTONSAGI HIBA: az anon olvashatja a program_doc_type tablat.';
  end if;
  if has_table_privilege('authenticated', 'public.program_doc_type', 'delete') then
    raise exception 'BIZTONSAGI HIBA: az authenticated torolhet a program_doc_type tablabol.';
  end if;
  raise notice 'Rendben: a program_doc_type tabla kesz, az egyedi dokumentumtipusok felvehetok.';
end $blk$;
