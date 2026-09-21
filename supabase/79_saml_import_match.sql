-- ============================================================
-- UniPortal Pro — SAML belépés összekötése a Neptun-import fiókokkal
--
-- MIÉRT:
--   A "NJE kurzusfelvételek … 2026-27-1.xlsx" importja 5 567 hallgatói és
--   273 oktatói VALÓDI fiókot hozott létre (66 132 kurzusfelvétellel), de
--   PLACEHOLDER bejelentkezési névvel:
--       hallgató → student.<neptun>@nje-import.invalid
--       oktató   → teacher.<hash>@nje-import.invalid
--   Ezek nem postafiókok, csak login-nevek.
--
--   A 76_saml_sso.sql saml_find_user() függvénye két dolgot néz: az ePPN-t,
--   majd az e-mail-címet. Egy hallgató viszont neptunkod@kefo.hu alakú
--   ePPN-nel lép be — az ePPN még ismeretlen, az e-mail pedig SOHA nem
--   egyezik a .invalid placeholderrel. Ezért ÚJ, ÜRES fiókot kapna, miközben
--   az importált fiókja az összes kurzusfelvételével árván maradna. Ráadásul
--   a handle_new_user minden új SSO-fiókot STUDENT-re állít, tehát egy
--   oktató is hallgatóként lépne be.
--
--   Maga az import MÁR elvégzi ezt a párosítást (tools/nje_import.sql.in:
--   Neptun-kód a student_attributes-ból, oktatónál kis-nagybetű-független
--   névegyezés). Ez a migráció UGYANEZT a logikát emeli át a BELÉPÉSI
--   útvonalra.
--
-- MIT CSINÁL:
--   1. nje_name_key(text) — oktatónév-normalizálás (titulusok, központozás
--      levágása). IMMUTABLE, hogy funkcionális indexbe tehető legyen.
--   2. Hiányzó indexek: a student_attributes.neptun oszlopon MA SEMMILYEN
--      index nincs (38_student_groups.sql csak a tagozat/szint/szak/kar
--      oszlopokat indexeli), pedig minden belépéskor 5 567 soron keresnénk.
--   3. saml_link_review tábla — amit NEM sikerült egyértelműen párosítani,
--      az ide kerül kézi elbírálásra. Enélkül senki nem tudná meg, melyik
--      oktató került rossz fiókra.
--   4. saml_find_user(ePPN, e-mail, displayName, hallgatói tartományok) — ÚJ alak.
--      Az 1. (ePPN) és 2. (e-mail) lépés VÁLTOZATLAN; utánuk jön a
--      Neptun-kód, majd az oktatói névegyezés.
--   5. saml_link_login — a profiles.email szinkronizálása az auth.users-ből
--      (a GoTrue csak az auth.users sorát írja), és a nyitott elbírálási
--      sorok user_id-jének kitöltése.
--   6. saml_review_resolve(uuid) — elbírálási sor lezárása.
--
--   A PÁROSÍTÁS HÁROM VÉDŐFELTÉTELE (mindkét új lépésre):
--     a) PONTOSAN EGY találat. Kétértelműnél inkább új fiók, mint rossz
--        emberhez kötött index.
--     b) A jelölt profilhoz NEM tartozhat már másik ePPN. Enélkül a
--        saml_link_login "delete … where user_id = ? and eppn <> ?" sora
--        (76_saml_sso.sql) — ami ott az IdP-oldali névváltást kezeli —
--        itt némán ÁTKÖTNÉ valaki más fiókját.
--     c) A szerepkör illeszkedjen: Neptunnál STUDENT, oktatói névnél
--        TEACHER/ADMIN/SUPERADMIN. Ugyanaz a pár, amit az import ellenőriz.
--
--   A JOGOSULTSÁGOKHOZ NEM NYÚLUNK: párosított fióknál p_is_new = false,
--   tehát a 76-os jóváhagyó blokkja nem fut le. Az importált fiókok amúgy
--   is 'approved' állapotúak. Szerepkört SEHOL nem írunk át.
--
--   A függvényeket CSAK a service_role hívhatja (a saml_review_* olvasás a
--   személyzeté). A 99_harden_grants.sql ezt nem írja felül: a "revoke …
--   from public, anon, authenticated" hármas miatt az authenticated-nek már
--   a pillanatfelvétel idején sincs joga.
--
-- FÜGG: 15_echo_core.sql (echo.teacher), 38_student_groups.sql
--       (student_attributes), 76_saml_sso.sql (saml_identities).
--
-- FIGYELEM: ez a fájl FELÜLÍRJA a 76-os saml_find_user() és saml_link_login()
--   függvényét. Ha a 76-ost valaha kézzel újrafuttatod, utána EZT IS futtasd
--   le — különben visszatér a 2 paraméteres alak, és a párosítás némán
--   megszűnik. (A 9. szakasz ellenőrzése ezt kimondja, ha mégis megtörténik.)
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt).
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. oktatónév-normalizálás ----------
-- A munkafüzet neveiben a titulus hol elöl, hol hátul áll, hol rövidítve:
--   'Angeli Eliza Dr.'            → 'angeli eliza'
--   'Antaliczné dr. Nagy Dorottya'→ 'antaliczné nagy dorottya'
--   'Dr. Baglyas Ferenc'          → 'baglyas ferenc'
-- Az ÉKEZETEKET SZÁNDÉKOSAN MEGTARTJUK: mindkét oldal magyar, az unaccent
-- kiterjesztés pedig nincs telepítve. A token-alapú szűrés (nem regexp_replace)
-- azért kell, mert a 'g' kapcsoló az egymást követő ' dr ' ' prof ' mintákat
-- a közös szóköz miatt nem találná meg mind.
create or replace function public.nje_name_key(p_name text)
returns text
language sql immutable parallel safe as $$
  -- A translate() "from" listája 11 karakter; a "to" ugyanennyi szóköz. Ha a
  -- "to" rövidebb lenne, a felesleges jeleket TÖRÖLNÉ, és a "Kiss-Nagy"-ból
  -- "kissnagy" lenne — a kötőjelnek szóközzé kell válnia, nem eltűnnie.
  select nullif(btrim((
    select coalesce(string_agg(t, ' ' order by ord), '')
      from unnest(regexp_split_to_array(
             btrim(lower(translate(coalesce(p_name, ''), '.,;:()[]-_/', '           '))),
             '\s+')) with ordinality as x(t, ord)
     where t <> ''
       and t not in ('dr','prof','phd','dsc','csc','habil','ifj','id','emer','emerita','emeritus')
  )), '')
$$;

comment on function public.nje_name_key(text) is
  'Oktatónév normalizálása párosításhoz: kisbetű, központozás és titulusok '
  '(dr/prof/phd/habil/ifj/id…) nélkül. IMMUTABLE, indexelhető.';

-- ---------- 2. a hiányzó keresőindexek ----------
create index if not exists student_attributes_neptun_idx
  on public.student_attributes (upper(btrim(neptun)))
  where neptun is not null;

create index if not exists echo_teacher_name_key_idx
  on echo.teacher (public.nje_name_key(name))
  where active;

-- ---------- 3. kézi elbírálásra váró esetek ----------
create table if not exists public.saml_link_review (
  id            uuid primary key default gen_random_uuid(),
  eppn          text not null,
  -- A sor a fiók LÉTREJÖTTE ELŐTT keletkezik (a saml_find_user írja), ezért
  -- itt még null; a saml_link_login tölti ki, amikor már van user_id.
  user_id       uuid references auth.users(id) on delete cascade,
  display_name  text,
  email         text,
  ou            text,
  title         text,
  reason        text not null,
  -- A mérlegelt jelöltek (echo.teacher sorok / profilok), hogy az ügyintéző
  -- lássa, MIK között kellett volna dönteni.
  candidates    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references auth.users(id) on delete set null
);

comment on table public.saml_link_review is
  'SAML-belépések, amelyeket nem sikerült egyértelműen meglévő (importált) '
  'fiókhoz kötni. A személyzet innen tudja, kit kell kézzel összekötni.';

-- Egy nyitott sor ügyenként: az ismételt belépés ne szemetelje tele.
create unique index if not exists saml_link_review_open_uidx
  on public.saml_link_review (eppn, reason)
  where resolved_at is null;
create index if not exists saml_link_review_open_idx
  on public.saml_link_review (created_at desc)
  where resolved_at is null;

alter table public.saml_link_review enable row level security;
revoke all on public.saml_link_review from public, anon, authenticated;
grant all on public.saml_link_review to service_role;
-- A személyzet OLVASHATJA (a feloldás RPC-n megy, lásd 6. pont).
grant select on public.saml_link_review to authenticated;

drop policy if exists saml_link_review_staff_read on public.saml_link_review;
create policy saml_link_review_staff_read on public.saml_link_review
  for select to authenticated using (public.is_staff());

-- ---------- 4. keresés: ePPN → e-mail → Neptun-kód → oktatónév ----------
-- A szignatúra bővül (p_display_name), ezért a régi alakot el kell dobni,
-- különben két túlterhelt változat maradna, és a PostgREST a rosszat hívná.
drop function if exists public.saml_find_user(text, text);

create or replace function public.saml_find_user(
  p_eppn           text,
  p_email          text,
  p_display_name   text default null,
  -- A hallgatói tartomány(ok). A konfiguráció a .env-ben lakik
  -- (SAML_STUDENT_SCOPES), a saml-sp adja át; itt csak a józan alapérték van.
  p_student_scopes text[] default array['kefo.hu']
) returns table (user_id uuid, email text, matched_by text, email_confirmed boolean)
language plpgsql security definer set search_path = public, auth, echo as $$
declare
  v_eppn   text := lower(btrim(coalesce(p_eppn, '')));
  v_neptun text;
  v_key    text;
  v_uid    uuid;
  v_cnt    integer;
  v_cand   jsonb;
  v_linked boolean;
begin
  if v_eppn = '' then return; end if;

  -- 1. ePPN szerint (visszatérő felhasználó) — VÁLTOZATLAN
  return query
    select u.id, u.email::text, 'eppn'::text, (u.email_confirmed_at is not null)
      from public.saml_identities s
      join auth.users u on u.id = s.user_id
     where s.eppn = v_eppn;
  if found then return; end if;

  -- 2. e-mail szerint (korábbi jelszavas fiók) — VÁLTOZATLAN
  if coalesce(btrim(p_email), '') <> '' then
    return query
      select u.id, u.email::text, 'email'::text, (u.email_confirmed_at is not null)
        from auth.users u
       where lower(u.email) = lower(btrim(p_email))
       order by u.created_at
       limit 1;
    if found then return; end if;
  end if;

  -- 3. HALLGATÓ: az ePPN helyi része a Neptun-kód (neptunkod@kefo.hu).
  --    A minta ugyanaz, amit az import megkövetel: ^[A-Z0-9]{6}$.
  --
  --    A TARTOMÁNY (scope) a döntő, nem a minta! Egy munkatársi felhasználónév
  --    is lehet hat karakter ('kpeter@nje.hu'), és ha pusztán az alak alapján
  --    döntenénk, az illető
  --      a) sosem jutna el az oktatói névegyezésig, sőt
  --      b) egy azonos alakú Neptun-kódú HALLGATÓ fiókjára kötődne.
  --    Ezért a hallgatói ág csak a hallgatói tartományra fut.
  v_neptun := upper(btrim(split_part(v_eppn, '@', 1)));
  if split_part(v_eppn, '@', 2) = any (coalesce(p_student_scopes, '{}'))
     and v_neptun ~ '^[A-Z0-9]{6}$' then
    select count(*) into v_cnt
      from public.student_attributes a
      join public.profiles p on p.id = a.profile_id
     where upper(btrim(a.neptun)) = v_neptun
       and p.role = 'STUDENT';

    if v_cnt = 1 then
      select a.profile_id into v_uid
        from public.student_attributes a
        join public.profiles p on p.id = a.profile_id
       where upper(btrim(a.neptun)) = v_neptun
         and p.role = 'STUDENT'
       limit 1;

      -- (b) a profil nem lehet már MÁSIK ePPN-hez kötve
      select exists (select 1 from public.saml_identities s where s.user_id = v_uid)
        into v_linked;

      if v_linked then
        perform public.saml_review_note(
          v_eppn, p_display_name, p_email, 'student_linked',
          jsonb_build_array(jsonb_build_object('profile_id', v_uid, 'neptun', v_neptun)));
      else
        return query
          select u.id, u.email::text, 'neptun'::text, (u.email_confirmed_at is not null)
            from auth.users u
           where u.id = v_uid
             and u.deleted_at is null
             and (u.banned_until is null or u.banned_until <= now());
        if found then return; end if;
      end if;

    elsif v_cnt > 1 then
      select jsonb_agg(jsonb_build_object('profile_id', a.profile_id, 'name', p.name))
        into v_cand
        from public.student_attributes a
        join public.profiles p on p.id = a.profile_id
       where upper(btrim(a.neptun)) = v_neptun
         and p.role = 'STUDENT';
      perform public.saml_review_note(
        v_eppn, p_display_name, p_email, 'student_ambiguous', coalesce(v_cand, '[]'::jsonb));
    end if;

    -- Hallgatói tartomány: oktatói névegyezést nem keresünk rá, és nem is
    -- írunk elbírálási sort — az ismeretlen Neptun-kód a normális eset
    -- (új hallgató, aki nincs benne a munkafüzetben).
    return;
  end if;

  -- 4. OKTATÓ: az importban nincs se Neptun-kódjuk, se valódi e-mail-címük —
  --    a munkafüzet "Kurzus oktatók" oszlopából csak a NEVÜK van meg.
  v_key := public.nje_name_key(p_display_name);
  if v_key is null then return; end if;

  select count(*) into v_cnt
    from echo.teacher t
    join public.profiles p on p.id = t.profile_id
   where t.active
     and t.profile_id is not null
     and public.nje_name_key(t.name) = v_key
     and p.role in ('TEACHER', 'ADMIN', 'SUPERADMIN');

  if v_cnt = 1 then
    select t.profile_id into v_uid
      from echo.teacher t
      join public.profiles p on p.id = t.profile_id
     where t.active
       and t.profile_id is not null
       and public.nje_name_key(t.name) = v_key
       and p.role in ('TEACHER', 'ADMIN', 'SUPERADMIN')
     limit 1;

    select exists (select 1 from public.saml_identities s where s.user_id = v_uid)
      into v_linked;

    if v_linked then
      perform public.saml_review_note(
        v_eppn, p_display_name, p_email, 'teacher_linked',
        jsonb_build_array(jsonb_build_object('profile_id', v_uid, 'name_key', v_key)));
    else
      return query
        select u.id, u.email::text, 'teacher_name'::text, (u.email_confirmed_at is not null)
          from auth.users u
         where u.id = v_uid
           and u.deleted_at is null
           and (u.banned_until is null or u.banned_until <= now());
      if found then return; end if;
    end if;

  elsif v_cnt > 1 then
    -- A munkafüzet README-je maga figyelmeztet: az azonos nevek különböző
    -- embereket jelölhetnek. Itt SOHA nem tippelünk.
    select jsonb_agg(jsonb_build_object('teacher_id', t.id, 'name', t.name, 'profile_id', t.profile_id))
      into v_cand
      from echo.teacher t
     where t.active and public.nje_name_key(t.name) = v_key;
    perform public.saml_review_note(
      v_eppn, p_display_name, p_email, 'teacher_ambiguous', coalesce(v_cand, '[]'::jsonb));

  else
    -- Nem hallgatói tartomány, van megjelenítési neve, mégsincs használható
    -- oktatói sora: vagy új munkatárs, vagy elírás a munkafüzetben, vagy a
    -- névre VAN sor, csak nincs fiókhoz kötve / rossz a szerepköre. A
    -- jelölteket a szűrők NÉLKÜL gyűjtjük ki, különben az ügyintéző csak egy
    -- üres listát látna, és nem derülne ki, MIÉRT nem sikerült a párosítás.
    select jsonb_agg(jsonb_build_object(
             'teacher_id', t.id, 'name', t.name, 'profile_id', t.profile_id,
             'active', t.active, 'profile_role', p.role))
      into v_cand
      from echo.teacher t
      left join public.profiles p on p.id = t.profile_id
     where public.nje_name_key(t.name) = v_key;
    perform public.saml_review_note(
      v_eppn, p_display_name, p_email, 'teacher_unmatched', coalesce(v_cand, '[]'::jsonb));
  end if;
end $$;

-- ---------- 5. elbírálási sor rögzítése ----------
-- Külön függvény, mert a saml_find_user több ágból hívja. Nyitott sorból
-- ügyenként egy van; az ismételt belépés csak a last_seen_at-ot frissíti.
create or replace function public.saml_review_note(
  p_eppn text, p_display_name text, p_email text, p_reason text, p_candidates jsonb
) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  insert into public.saml_link_review as r (eppn, display_name, email, reason, candidates)
  values (lower(btrim(p_eppn)), nullif(btrim(coalesce(p_display_name, '')), ''),
          lower(nullif(btrim(coalesce(p_email, '')), '')), p_reason,
          coalesce(p_candidates, '[]'::jsonb))
  on conflict (eppn, reason) where resolved_at is null
  do update set last_seen_at = now(),
                candidates   = excluded.candidates,
                display_name = coalesce(excluded.display_name, r.display_name);
end $$;

-- ---------- 6. elbírálási sor lezárása (a személyzetnek) ----------
create or replace function public.saml_review_resolve(p_id uuid)
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_staff() then
    raise exception 'Nincs jogosultsag a SAML-elbiralas lezarasahoz.'
      using errcode = '42501';
  end if;
  update public.saml_link_review
     set resolved_at = now(), resolved_by = auth.uid()
   where id = p_id and resolved_at is null;
end $$;

-- ---------- 7. saml_link_login: e-mail-szinkron + az elbírálás lezárása ----------
-- A 76-os változat elé/mögé illesztett két lépés. A törzs többi része
-- SZÁNDÉKOSAN azonos a 76_saml_sso.sql-beli eredetivel.
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

  if p_is_new then
    update public.profiles
       set approval_status = 'approved'
     where id = p_user_id and approval_status = 'pending';
    update public.profiles
       set approved_by = 'nje-sso'
     where id = p_user_id and approval_status = 'approved' and approved_by = 'sql-editor';
  end if;

  -- ÚJ: a profiles.email külön oszlop, a GoTrue csak az auth.users sorát írja.
  -- Az importált fiók átvételekor (placeholder → valódi cím) enélkül a két
  -- érték szétcsúszna, és a felület a .invalid címet mutatná.
  update public.profiles p
     set email = u.email
    from auth.users u
   where p.id = p_user_id and u.id = p_user_id
     and p.email is distinct from u.email;

  -- ÚJ: a fiók már létezik, tölthetjük a korábban rögzített elbírálási sorok
  -- user_id-jét, hogy az ügyintéző lássa, MELYIK új fiókot kell összekötni.
  update public.saml_link_review
     set user_id = p_user_id
   where eppn = v_eppn and resolved_at is null and user_id is null;
end $$;

-- ---------- 8. jogosultságok ----------
-- A "public"-ot is el kell venni, különben a 99_harden_grants.sql 1. lépése
-- a PUBLIC-on keresztül látná jogosultnak az authenticated-et, és a 3. lépés
-- expliciten VISSZAADNÁ neki.
revoke all on function public.saml_find_user(text, text, text, text[])     from public, anon, authenticated;
revoke all on function public.saml_review_note(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.saml_link_login(text, uuid, text, text, text, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.saml_find_user(text, text, text, text[])  to service_role;
grant execute on function public.saml_review_note(text, text, text, text, jsonb) to service_role;
grant execute on function public.saml_link_login(text, uuid, text, text, text, text, text, text, text, boolean) to service_role;

-- A lezárás a személyzeté — a függvény maga ellenőrzi az is_staff()-ot.
revoke all on function public.saml_review_resolve(uuid) from public, anon;
grant execute on function public.saml_review_resolve(uuid) to authenticated, service_role;

grant execute on function public.nje_name_key(text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ---------- 9. ellenőrzés ----------
do $blk$
declare
  fn text;
begin
  -- A normalizáló a munkafüzetben ténylegesen előforduló alakokra
  if public.nje_name_key('Angeli Eliza Dr.') <> 'angeli eliza' then
    raise exception 'HIBA: nje_name_key(''Angeli Eliza Dr.'') = %', public.nje_name_key('Angeli Eliza Dr.');
  end if;
  if public.nje_name_key('Antaliczné dr. Nagy Dorottya') <> 'antaliczné nagy dorottya' then
    raise exception 'HIBA: nje_name_key(''Antaliczné dr. Nagy Dorottya'') = %', public.nje_name_key('Antaliczné dr. Nagy Dorottya');
  end if;
  if public.nje_name_key('Dr. Baglyas Ferenc') <> public.nje_name_key('Baglyas Ferenc Dr.') then
    raise exception 'HIBA: a titulus helye szamit a nje_name_key()-ben.';
  end if;
  if public.nje_name_key('   ') is not null then
    raise exception 'HIBA: nje_name_key() ures nevre nem NULL-t ad.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.saml_link_review'::regclass) then
    raise exception 'BIZTONSAGI HIBA: a saml_link_review tablan nincs RLS.';
  end if;
  if has_table_privilege('anon', 'public.saml_link_review', 'select') then
    raise exception 'BIZTONSAGI HIBA: a saml_link_review anon-bol olvashato.';
  end if;
  if has_table_privilege('authenticated', 'public.saml_link_review', 'insert')
     or has_table_privilege('authenticated', 'public.saml_link_review', 'update') then
    raise exception 'BIZTONSAGI HIBA: a saml_link_review kliensbol irhato.';
  end if;

  -- A régi, 2 paraméteres alak nem maradhat ott: a PostgREST azt hívná.
  if to_regprocedure('public.saml_find_user(text, text)') is not null then
    raise exception 'HIBA: a regi 2 parameteres saml_find_user() meg letezik.';
  end if;

  foreach fn in array array[
    'public.saml_find_user(text, text, text, text[])',
    'public.saml_review_note(text, text, text, text, jsonb)',
    'public.saml_link_login(text, uuid, text, text, text, text, text, text, text, boolean)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'BIZTONSAGI HIBA: a % kliensbol hivhato.', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception 'HIBA: a service_role nem hivhatja: %', fn;
    end if;
  end loop;

  raise notice 'Rendben: a Neptun- es oktatonev-parositas el, a tabla es a fuggvenyek zartak.';
end $blk$;
