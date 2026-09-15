-- ============================================================================
-- claude_teszt_fiok.sql — egy fiók, amivel Claude be tud lépni tesztelni
--
-- MIÉRT
--   Eddig csak kódot tudtam olvasni és az adatbázist szondázni. A most
--   bejelentett fehér képernyő például olyan hiba volt, amit belépés nélkül
--   nem lehet észrevenni: a felület csak a bejelentkezés UTÁN omlott össze.
--
-- MIT KELL TUDNOD RÓLA
--   Ez VALÓDI, JOGOSULT FIÓK az éles rendszeretekben, ahol valódi adat is van
--   (15 valódi profil, valódi felvételi folyamatok). A szerepköre SUPERADMIN,
--   mert a most hibás képernyő (Regisztrációk) csak annak látszik.
--
--   Bármikor törölhető, egyetlen sorral:
--       delete from auth.users where email = 'claude.teszt@teszt.hu';
--
--   Ha kevesebbet szeretnél adni, írd át a metaadatban a 'SUPERADMIN'-t
--   'ADMIN'-ra — akkor a Regisztrációkat nem fogom tudni tesztelni, minden
--   mást igen.
--
-- JELSZÓ:  NINCS A FÁJLBAN. Futtatás előtt írd be a v_pw sorba; jelszóval kitöltve NE commitold (a repó nyilvános).
-- ============================================================================

do $$
declare
  v_id   uuid := 'c1a0de00-0000-4000-8000-000000000001';
  v_pw   text := '<UJ_JELSZO_IDE>';
  v_hash text := crypt(v_pw, gen_salt('bf'));
begin
  if v_pw = '<UJ_JELSZO_IDE>' or length(v_pw) < 12 then
    raise exception 'Futtatás előtt adj meg új, legalább 12 karakteres jelszót a v_pw sorban (a fájlt jelszóval ne commitold).';
  end if;
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current)
  values (
    v_id, '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated', 'claude.teszt@teszt.hu', v_hash,
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"role":"SUPERADMIN","name":"Claude (teszt)"}'::jsonb,
    '', '', '', '', '')
  on conflict (id) do update
    set encrypted_password = excluded.encrypted_password,
        email_confirmed_at = now();

  insert into auth.identities (id, user_id, provider, provider_id, identity_data,
                               created_at, updated_at)
  values (gen_random_uuid(), v_id, 'email', v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', 'claude.teszt@teszt.hu',
                             'email_verified', true),
          now(), now())
  on conflict do nothing;

  -- A profilt a trigger hozza létre 'pending' állapotban; jóváhagyjuk.
  update public.profiles
     set role = 'SUPERADMIN', approval_status = 'approved', approved_at = now(),
         name = 'Claude (teszt)'
   where id = v_id;

  raise notice 'Kész. Belépés: claude.teszt@teszt.hu';
end $$;

select 'Fiók' as "mit", email as "érték", role as "szerepkör"
  from public.profiles where email = 'claude.teszt@teszt.hu';
