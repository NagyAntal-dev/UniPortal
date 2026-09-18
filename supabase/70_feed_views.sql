-- ============================================================================
-- 70_feed_views.sql — „hányan látták” a hírfolyam bejegyzéseinél
--
-- MIT AD
--   A hírfolyam bejegyzés-kártyáján egy szem ikon mutatja, hány KÜLÖNBÖZŐ
--   felhasználó látta a bejegyzést. Ugyanazt a számot látja a hallgató és az
--   ügyintéző is. NÉVSOR NINCS: sem a felületen, sem RPC-n nem adjuk ki, ki
--   látta — a darabszám az, ami a közléshez kell.
--
-- MIT JELENT A „LÁTTA”
--   A bejegyzés ténylegesen megjelent a képernyőn (a felület akkor naplóz,
--   amikor a kártya legalább félig láthatóvá válik). Nem kattintás, nem
--   olvasás — ezért hívja a felület is „látta”-nak, nem „elolvasta”-nak.
--   Felhasználónként EGY sor van: az első és a legutóbbi megtekintés ideje.
--   Az ügyintézők megtekintése NEM számít bele (ők minden bejegyzést látnak,
--   a szám különben a saját ellenőrzéseiktől nőne).
--
-- ADATVÉDELEM
--   A sor személyes adat (ki mit látott), ezért:
--     * a tábla KÖZVETLENÜL nem olvasható (nincs rá policy, és a grantokat
--       visszavonjuk) — csak a két függvényen át, amelyek csak SZÁMOT adnak;
--     * a szám csak olyan bejegyzésre kérdezhető le, amit a hívó maga is lát
--       (feed_post_visible, 69);
--     * kis célközönségnél a szám önmagában is árulkodó lehet (1 fős
--       célközönségnél az 1 megtekintés az illetőt jelenti) — ezt a
--       felület szövege nem tagadja, és névsort sehol nem ad.
--   A bejegyzés törlésekor a megtekintései is törlődnek (on delete cascade).
--
-- FÜGGŐSÉG: 05_features (feed_posts), 07 (is_approved), 11 (is_staff),
--           69_feed_audience (feed_post_visible).
-- IDEMPOTENS: igen.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.feed_posts') is null then
    raise exception 'ELOFELTETEL: nincs public.feed_posts (05_features.sql).';
  end if;
  if to_regprocedure('public.feed_post_visible(jsonb)') is null then
    raise exception 'ELOFELTETEL: eloszor a 69_feed_audience.sql-t kell lefuttatni.';
  end if;
end $pre$;

create table if not exists public.feed_post_view (
  post_id    text not null references public.feed_posts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id)   on delete cascade,
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  primary key (post_id, profile_id)
);

create index if not exists feed_post_view_post_idx on public.feed_post_view (post_id);

comment on table public.feed_post_view is
  'Ki látta melyik hírfolyam-bejegyzést (70). Közvetlenül nem olvasható: csak a '
  'feed_view_log / feed_view_counts függvények adnak belőle DARABSZÁMOT.';

-- A tábla zárt: nincs policy, és a szerepkörök grantjait is visszavonjuk.
alter table public.feed_post_view enable row level security;
do $pol$
declare p text;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'feed_post_view'
  loop
    execute format('drop policy %I on public.feed_post_view', p);
  end loop;
end $pol$;
revoke all on table public.feed_post_view from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1) Megtekintés naplózása + a friss számok visszaadása
--    Csak arra a bejegyzésre, amit a hívó tényleg lát. Ügyintézőnél nem
--    naplózunk, de a számokat visszaadjuk.
-- ---------------------------------------------------------------------------
create or replace function public.feed_view_log(p_posts text[])
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_ids   text[] := coalesce(p_posts, '{}'::text[]);
begin
  if v_me is null then raise exception 'FEED_NOT_AUTHENTICATED'; end if;
  if not public.is_approved() then raise exception 'FEED_NOT_APPROVED'; end if;
  if cardinality(v_ids) = 0 then return '{}'::jsonb; end if;
  if cardinality(v_ids) > 200 then raise exception 'FEED_TOO_MANY'; end if;

  if not public.is_staff() and not public.has_role('SUPERADMIN', 'ADMIN', 'ADMISSIONS') then
    insert into public.feed_post_view (post_id, profile_id)
    select f.id, v_me
      from public.feed_posts f
     where f.id = any (v_ids)
       and public.feed_post_visible(f.celkozonseg)
    on conflict (post_id, profile_id) do update set last_at = now();
  end if;

  return public.feed_view_counts(v_ids);
end $$;

-- ---------------------------------------------------------------------------
-- 2) A számok — csak a hívó által látható bejegyzésekre
-- ---------------------------------------------------------------------------
create or replace function public.feed_view_counts(p_posts text[])
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_ids text[] := coalesce(p_posts, '{}'::text[]);
  v_out jsonb;
begin
  if auth.uid() is null then raise exception 'FEED_NOT_AUTHENTICATED'; end if;
  if not public.is_approved() then raise exception 'FEED_NOT_APPROVED'; end if;
  if cardinality(v_ids) = 0 then return '{}'::jsonb; end if;
  if cardinality(v_ids) > 200 then raise exception 'FEED_TOO_MANY'; end if;

  select coalesce(jsonb_object_agg(s.id, s.db), '{}'::jsonb) into v_out
    from (
      select f.id,
             (select count(*) from public.feed_post_view v where v.post_id = f.id) as db
        from public.feed_posts f
       where f.id = any (v_ids)
         and public.feed_post_visible(f.celkozonseg)
    ) s;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Jogosultságok
-- ---------------------------------------------------------------------------
revoke all on function public.feed_view_log(text[])    from public, anon;
revoke all on function public.feed_view_counts(text[]) from public, anon;
grant execute on function public.feed_view_log(text[])    to authenticated;
grant execute on function public.feed_view_counts(text[]) to authenticated;

do $chk$
begin
  if has_function_privilege('anon', 'public.feed_view_log(text[])', 'execute')
     or has_function_privilege('anon', 'public.feed_view_counts(text[])', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a feed_view fuggvenyeket.';
  end if;
  if has_table_privilege('authenticated', 'public.feed_post_view', 'select') then
    raise exception 'BIZTONSAGI HIBA: a feed_post_view kozvetlenul olvashato.';
  end if;
  raise notice 'Rendben: 70 — hirfolyam megtekintes-szamlalo (nevsor nelkul).';
end $chk$;
