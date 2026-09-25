-- ============================================================
-- UniPortal Pro — Cserediák szerepkör (EXCHANGE_STUDENT)
--
-- MIÉRT:
--   Akinek nincs NJE-azonosítója, a home.html-en regisztrál ("Applicant").
--   Eddig minden ilyen fiók STUDENT / pending lett, tehát az e-mail-cím
--   megerősítése után is a "Jóváhagyásra vár" képernyőn ragadt, amíg egy
--   szuperadmin kézzel jóvá nem hagyta.
--
-- MIT CSINÁL:
--   1. Új szerepkör: EXCHANGE_STUDENT. Egyetlen menüpontja a student_portal
--      (a hallgatónál "Képzések"), abban is csak a képzési kínálat látszik —
--      ezt a felület szűri (app.jsx: canSeeView, StudentPortal).
--   2. A handle_new_user() engedélyezett listájára felkerül. A törzs egyébként
--      BETŰRE azonos a 68-aséval, csak a szerepkör-lista és a jóváhagyás
--      változott: ha a megerősítés már a beszúráskor megvan (autoconfirm),
--      a cserediák azonnal jóváhagyott.
--   3. Az e-mail-cím megerősítésekor (auth.users.email_confirmed_at
--      NULL -> kitöltött) a pending EXCHANGE_STUDENT profil automatikusan
--      jóváhagyott lesz. Ügynök és hallgató továbbra is kézi jóváhagyást kap.
--
--   Biztonság: a cserediák a legszűkebb szerepkör. Az adatokhoz a 11-es
--   tulajdonosi RLS-en át fér hozzá (a saját sorai), a 73-as restriktív réteg
--   pedig csak ügyintézői utakat fed — új policy nem kell.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt),
--   vagy: Supabase dashboard → SQL Editor → New query → beilleszt → Run
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. a szerepkör ----------
insert into public.role_definition (kod, nev, leiras, sorrend, beepitett) values
  ('EXCHANGE_STUDENT', 'Cserediák', 'Önregisztrált cserediák: csak a Képzések menüpontot látja.', 65, true)
on conflict (kod) do nothing;

insert into public.role_permission (role_kod, permission)
values ('EXCHANGE_STUDENT', 'student_portal')
on conflict do nothing;

-- A modul-mátrix (72): ugyanaz, mint a STUDENT-nél a student_portal modulon.
-- A md.actions szűrő miatt csak a modulon értelmes művelet kerül be.
do $blk$
begin
  if to_regclass('public.role_module_permission') is not null then
    insert into public.role_module_permission (role_kod, module_kod, action)
    select 'EXCHANGE_STUDENT', md.kod, a.kod
      from public.module_definition md
      cross join (values ('VIEW'), ('USE'), ('CREATE'), ('EDIT')) as a(kod)
     where md.kod = 'student_portal'
       and a.kod = any (md.actions)
    on conflict do nothing;
  end if;
end $blk$;

-- ---------- 2. a sign-up trigger ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wanted_role text;
  requested   text;
  is_super    boolean;
  auto_ok     boolean;
  ag_id       text;
  ag_name     text;
  ag_countries text[];
begin
  is_super    := lower(new.email) = public.superadmin_email();

  -- A raw_user_meta_data a KLIENSTŐL jön (auth.signUp options.data), tehát
  -- szabadon választható: ide bármit be lehet írni, 'SUPERADMIN'-t is.
  -- Önregisztrálni csak jelentkezőként, cserediákként vagy ügynökként lehet,
  -- minden más kérésből STUDENT lesz. A KÉRT szerepkör a requested_role
  -- oszlopban marad meg — ott adat, amit a jóváhagyó lát, nem jogosultság.
  requested   := upper(coalesce(new.raw_user_meta_data->>'role', 'STUDENT'));
  wanted_role := case when requested in ('STUDENT', 'AGENT', 'EXCHANGE_STUDENT') then requested else 'STUDENT' end;

  -- A cserediák a megerősített e-mail-címmel automatikusan jóváhagyott. Ha a
  -- projekten ki van kapcsolva a megerősítés, a cím már a beszúráskor
  -- megerősített — különben a lenti approve_exchange_on_confirm() hagyja jóvá.
  auto_ok     := is_super or (wanted_role = 'EXCHANGE_STUDENT' and new.email_confirmed_at is not null);

  -- Az ügynökség-azonosítót csak ÜGYNÖKI regisztrációnál vesszük át. Enélkül
  -- egy hallgatói regisztráció előre ráköthetné magát egy létező ügynökségre,
  -- és jóváhagyás után a my_agency() azt az ügynökséget adná vissza.
  ag_id       := case when wanted_role = 'AGENT'
                      then nullif(new.raw_user_meta_data->>'agencyId', '')
                      else null end;

  -- Önregisztráló ügynök, aki NEM egy meglévő ügynökséghez csatlakozik:
  -- neki nyitunk egy függőben lévő ügynökség-sort.
  if wanted_role = 'AGENT' and not is_super and ag_id is null then
    ag_name := nullif(trim(coalesce(new.raw_user_meta_data->>'agencyName', '')), '');
    if ag_name is null then
      ag_name := coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));
    end if;

    -- 'countries_of_recruitment': tömb vagy vesszős lista is jöhet.
    begin
      if jsonb_typeof(new.raw_user_meta_data->'agencyCountries') = 'array' then
        select coalesce(array_agg(trim(v)), '{}')
          into ag_countries
          from jsonb_array_elements_text(new.raw_user_meta_data->'agencyCountries') v
         where trim(v) <> '';
      else
        select coalesce(array_agg(trim(v)), '{}')
          into ag_countries
          from unnest(string_to_array(coalesce(new.raw_user_meta_data->>'agencyCountries', ''), ',')) v
         where trim(v) <> '';
      end if;
    exception when others then
      ag_countries := '{}';
    end;

    ag_id := 'AG-' || substr(md5(new.id::text), 1, 10);
  end if;

  -- A SORREND KÖTÖTT: az agencies."requested_by" a profiles(id)-ra mutat,
  -- tehát a PROFIL SORNAK ELŐBB kell megszületnie (lásd 68).
  insert into public.profiles (id, email, name, role, requested_role, "agencyId", approval_status, approved_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    case when is_super then 'SUPERADMIN' else wanted_role end,
    requested,
    ag_id,
    case when auto_ok then 'approved' else 'pending' end,
    case when auto_ok then now() else null end
  )
  on conflict (id) do nothing;

  -- Most már van mire hivatkoznia a requested_by-nak.
  if ag_name is not null then
    insert into public."agencies"
      (id, name, "commissionRate", "contactPerson", email, status,
       "country_of_origin", "countries_of_recruitment",
       "approval_status", "requested_by", "requested_at", "self_registered")
    values
      (ag_id, ag_name, 0,
       coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
       new.email, 'Pending',
       nullif(trim(coalesce(new.raw_user_meta_data->>'agencyCountry', '')), ''),
       coalesce(ag_countries, '{}'),
       'pending', new.id, now(), true)
    on conflict (id) do nothing;
  end if;

  return new;
end $$;

-- ---------- 3. jóváhagyás az e-mail-cím megerősítésekor ----------
-- A GoTrue a megerősítő link kattintásakor tölti ki az email_confirmed_at-et.
-- Csak a MÉG pending EXCHANGE_STUDENT profilt hagyjuk jóvá: egy elutasított
-- vagy más szerepkörű fiók ettől nem kap jogot. Hiba esetén a megerősítés
-- NEM akad meg — legfeljebb a fiók marad kézi jóváhagyásra.
create or replace function public.approve_exchange_on_confirm()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    begin
      update public.profiles
         set approval_status = 'approved'
       where id = new.id and role = 'EXCHANGE_STUDENT' and approval_status = 'pending';
      -- A profiles_protect_privileges (07) JWT nélkül 'sql-editor'-t ír az
      -- approved_by-ba; írjuk át a valódi forrásra (76_saml_sso.sql mintája).
      update public.profiles
         set approved_by = 'email-confirm'
       where id = new.id and role = 'EXCHANGE_STUDENT'
         and approval_status = 'approved' and approved_by = 'sql-editor';
    exception when others then
      raise warning 'approve_exchange_on_confirm: az automatikus jóváhagyás nem sikerült (%). A fiók kézi jóváhagyásra vár.', sqlerrm;
    end;
  end if;
  return new;
end $fn$;

drop trigger if exists on_auth_user_confirmed_exchange on auth.users;
create trigger on_auth_user_confirmed_exchange
  after update of email_confirmed_at on auth.users
  for each row execute function public.approve_exchange_on_confirm();

revoke all on function public.approve_exchange_on_confirm() from public, anon, authenticated;

-- ---------- 4. ellenőrzés ----------
do $blk$
declare
  src text;
begin
  if not exists (select 1 from public.role_definition where kod = 'EXCHANGE_STUDENT') then
    raise exception 'HIBA: nincs EXCHANGE_STUDENT szerepkor a role_definition-ben.';
  end if;

  select prosrc into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'handle_new_user';

  if src is null then
    raise exception 'BIZTONSAGI HIBA: nincs handle_new_user fuggveny.';
  end if;
  if src not like '%in (''STUDENT'', ''AGENT'', ''EXCHANGE_STUDENT'')%' then
    raise exception 'BIZTONSAGI HIBA: a handle_new_user nem szoritja a kert szerepkort STUDENT/AGENT/EXCHANGE_STUDENT-re.';
  end if;
  if src like '%wanted_role := upper(coalesce(new.raw_user_meta_data->>''role''%' then
    raise exception 'BIZTONSAGI HIBA: a handle_new_user meg mindig kozvetlenul veszi at a kliens szerepkoret.';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'on_auth_user_confirmed_exchange'
       and tgrelid = 'auth.users'::regclass and not tgisinternal
  ) then
    raise exception 'HIBA: hianyzik az on_auth_user_confirmed_exchange trigger.';
  end if;

  raise notice 'Rendben: EXCHANGE_STUDENT szerepkor felveve, a megerositett e-mail-cimmel automatikusan jovahagyott.';
end $blk$;
