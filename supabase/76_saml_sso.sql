-- ============================================================
-- UniPortal Pro — NJE SAML bejelentkezés (saját SP) és automatikus regisztráció
--
-- MIÉRT:
--   Az NJE IdP-vel (https://idp.nje.hu) a deploy/saml-sp szolgáltatás beszél:
--   ő ellenőrzi az aláírt SAML-választ, és ő regisztrálja az első belépőt. A
--   GoTrue beépített SAML-jét és a Keycloakot SZÁNDÉKOSAN nem használjuk.
--   A felhasználó a végén normál Supabase munkamenetet kap, tehát minden
--   RLS-szabály (auth.uid()) változatlanul érvényes.
--
--   A SAML-azonosító (eduPersonPrincipalName) és a fiók (auth.users)
--   összekötését valahol tartani kell: az ePPN az állandó kulcs, az e-mail
--   változhat. Ez a saml_identities tábla.
--
-- MIT CSINÁL:
--   1. saml_identities tábla — RLS be, policy NINCS: kliens (anon,
--      authenticated) nem látja, csak a service_role (a saml-sp).
--   2. saml_find_user(ePPN, e-mail) — ePPN szerint, ennek híján e-mail szerint
--      keres (egy korábban jelszóval regisztrált NJE-fiók így összeköthető).
--   3. saml_link_login(...) — az azonosító sor mentése; ÚJ fióknál a profilt
--      jóváhagyja. A szerepkör az marad, amit a handle_new_user adott
--      (STUDENT, illetve a superadmin címnél SUPERADMIN) — itt nem nyúlunk
--      hozzá. MEGLÉVŐ fióknál semmilyen jogosultsági mezőt nem változtat.
--   4. saml_logout(NameID) — az IdP-ről indított kijelentkezéskor a
--      munkamenetek (auth.sessions → a refresh tokenek is) visszavonása.
--
--   A függvényeket CSAK a service_role hívhatja. A 99_harden_grants.sql ezt
--   nem írja felül: a szándékos "revoke ... from authenticated" sorokat
--   meghagyja.
--
--   A jóváhagyás a profiles_protect_privileges triggeren (07) át megy: a
--   service_role-nál auth.uid() null, ezért a trigger engedi, és kitölti az
--   approved_at mezőt.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt).
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. az összekötő tábla ----------
create table if not exists public.saml_identities (
  eppn           text primary key,
  user_id        uuid not null unique references auth.users(id) on delete cascade,
  email          text,
  display_name   text,
  ou             text,
  title          text,
  office         text,
  -- Az utolsó SAML-munkamenet (transient NameID + SessionIndex): az IdP
  -- kijelentkezési kérése ezzel azonosítja a felhasználót.
  name_id        text,
  session_index  text,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now()
);
create index if not exists saml_identities_name_id_idx on public.saml_identities (name_id);

alter table public.saml_identities enable row level security;
revoke all on public.saml_identities from public, anon, authenticated;
grant all on public.saml_identities to service_role;

-- ---------- 2. keresés ----------
create or replace function public.saml_find_user(p_eppn text, p_email text)
returns table (user_id uuid, email text, matched_by text, email_confirmed boolean)
language plpgsql security definer set search_path = public, auth as $$
begin
  return query
    select u.id, u.email::text, 'eppn'::text, (u.email_confirmed_at is not null)
      from public.saml_identities s
      join auth.users u on u.id = s.user_id
     where s.eppn = lower(trim(p_eppn));
  if found then return; end if;

  if coalesce(trim(p_email), '') = '' then return; end if;
  return query
    select u.id, u.email::text, 'email'::text, (u.email_confirmed_at is not null)
      from auth.users u
     where lower(u.email) = lower(trim(p_email))
     order by u.created_at
     limit 1;
end $$;

-- ---------- 3. összekötés + az új fiók jóváhagyása ----------
create or replace function public.saml_link_login(
  p_eppn          text,
  p_user_id       uuid,
  p_email         text,
  p_display_name  text,
  p_ou            text,
  p_title         text,
  p_office        text,
  p_name_id       text,
  p_session_index text,
  p_is_new        boolean
) returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  v_eppn text := lower(trim(p_eppn));
begin
  if v_eppn = '' or p_user_id is null then
    raise exception 'saml_link_login: hiányzó ePPN vagy felhasználó';
  end if;

  -- Egy fiókhoz egy NJE-azonosító tartozik. Ha az IdP-nél megváltozott az
  -- ePPN (névváltozás), a régi sort az újra cseréljük.
  delete from public.saml_identities where user_id = p_user_id and eppn <> v_eppn;

  insert into public.saml_identities as s
    (eppn, user_id, email, display_name, ou, title, office, name_id, session_index, last_login_at)
  values
    (v_eppn, p_user_id, lower(p_email), p_display_name, p_ou, p_title, p_office, p_name_id, p_session_index, now())
  on conflict (eppn) do update
     set email         = excluded.email,
         display_name  = excluded.display_name,
         ou            = excluded.ou,
         title         = excluded.title,
         office        = excluded.office,
         name_id       = excluded.name_id,
         session_index = excluded.session_index,
         last_login_at = now()
   where s.user_id = excluded.user_id;
  if not found then
    raise exception 'saml_link_login: az ePPN (%) már egy másik fiókhoz tartozik', v_eppn;
  end if;

  -- Csak a MOST regisztrált fiókot hagyjuk jóvá: az IdP már igazolta a
  -- személyazonosságát. Egy korábbi, függőben lévő (pl. ügynöki) jelszavas
  -- regisztráció attól, hogy összekötjük, NEM kap jogot.
  if p_is_new then
    update public.profiles
       set approval_status = 'approved'
     where id = p_user_id and approval_status = 'pending';
    -- A trigger az approved_by mezőt 'sql-editor'-ra állítja; írjuk át a
    -- valódi forrásra (ez a második módosítás már nem állapotváltás).
    update public.profiles
       set approved_by = 'nje-sso'
     where id = p_user_id and approval_status = 'approved' and approved_by = 'sql-editor';
  end if;
end $$;

-- ---------- 4. kijelentkezés az IdP felől ----------
create or replace function public.saml_logout(p_name_id text)
returns integer
language plpgsql security definer set search_path = public, auth as $$
declare
  v_users uuid[];
begin
  if coalesce(p_name_id, '') = '' then return 0; end if;
  select coalesce(array_agg(user_id), '{}') into v_users
    from public.saml_identities where name_id = p_name_id;
  if cardinality(v_users) = 0 then return 0; end if;

  -- A refresh tokenek a munkamenettel együtt törlődnek (on delete cascade).
  -- A már kiadott access token a lejáratáig (JWT_EXPIRY) még él.
  delete from auth.sessions where user_id = any (v_users);
  update public.saml_identities set name_id = null, session_index = null where user_id = any (v_users);
  return cardinality(v_users);
end $$;

-- ---------- 5. jogosultságok: csak a service_role ----------
revoke all on function public.saml_find_user(text, text) from public, anon, authenticated;
revoke all on function public.saml_link_login(text, uuid, text, text, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.saml_logout(text) from public, anon, authenticated;
grant execute on function public.saml_find_user(text, text) to service_role;
grant execute on function public.saml_link_login(text, uuid, text, text, text, text, text, text, text, boolean) to service_role;
grant execute on function public.saml_logout(text) to service_role;

notify pgrst, 'reload schema';

-- ---------- 6. ellenőrzés ----------
do $blk$
declare
  fn text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.saml_identities'::regclass) then
    raise exception 'BIZTONSAGI HIBA: a saml_identities tablan nincs RLS.';
  end if;
  if has_table_privilege('authenticated', 'public.saml_identities', 'select')
     or has_table_privilege('anon', 'public.saml_identities', 'select') then
    raise exception 'BIZTONSAGI HIBA: a saml_identities kliensbol olvashato.';
  end if;

  foreach fn in array array[
    'public.saml_find_user(text, text)',
    'public.saml_link_login(text, uuid, text, text, text, text, text, text, text, boolean)',
    'public.saml_logout(text)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'BIZTONSAGI HIBA: a % kliensbol hivhato.', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception 'HIBA: a service_role nem hivhatja: %', fn;
    end if;
  end loop;

  raise notice 'Rendben: a SAML-azonosito tabla es fuggvenyei csak a service_role szamara elerhetok.';
end $blk$;
