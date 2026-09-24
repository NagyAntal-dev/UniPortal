#!/bin/sh
# ============================================================================
# Teszt hallgatói fiókok létrehozása (STUDENT, jóváhagyva, megerősített e-mail).
#
#   ./deploy/make-test-students.sh                      # student1..3@tester.com
#   ./deploy/make-test-students.sh anna bela cecil      # anna@tester.com, ...
#   TEST_PW=MasJelszo ./deploy/make-test-students.sh    # más jelszóval
#
# Ismételten futtatható: meglévő fióknál a jelszót visszaállítja, a profilt
# STUDENT-re és jóváhagyottra állítja. Ugyanazt a mintát követi, mint a
# make-superadmin.sh --create (a migrate szolgáltatás kapcsolatán át).
#
# Törlés:  delete from auth.users where email like '%@tester.com';
#          (a profil kaszkádol)
# ============================================================================
set -eu
cd "$(dirname "$0")/.."
PW="${TEST_PW:-njedev123}"
[ "$#" -gt 0 ] || set -- student1 student2 student3

USERS=""
for U in "$@"; do
  case "$U" in
    ''|*[!A-Za-z0-9._-]*) echo "HIBA: érvénytelen felhasználónév: $U"; exit 1 ;;
  esac
  USERS="${USERS:+$USERS,}$(printf '%s' "$U" | tr 'A-Z' 'a-z')"
done

docker compose run --rm --no-deps -T --entrypoint psql migrate \
  -X -q -t -A -v ON_ERROR_STOP=1 -v users="$USERS" -v pw="$PW" <<'SQL'
set search_path = public, extensions;
-- A psql-változók a $$ blokkon belül nem helyettesítődnek, ezért beállításon át adjuk át.
select set_config('tst.users', :'users', false), set_config('tst.pw', :'pw', false) \g /dev/null

do $$
declare
  v_user  text;
  v_email text;
  v_id    uuid;
  v_hash  text := crypt(current_setting('tst.pw'), gen_salt('bf'));
begin
  foreach v_user in array string_to_array(current_setting('tst.users'), ',') loop
    v_email := v_user || '@tester.com';
    select id into v_id from auth.users where lower(email) = v_email;

    if v_id is null then
      v_id := gen_random_uuid();
      -- A GoTrue a szöveges token-mezőkre NULL-nál "Database error"-t ad: üres szöveg kell.
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin,
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
        v_email, v_hash, now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('name', v_user, 'role', 'STUDENT'),
        false, '', '', '', ''
      );
      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), v_id, v_id::text,
        jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
        'email', now(), now(), now()
      );
    else
      update auth.users
         set encrypted_password = v_hash,
             email_confirmed_at = coalesce(email_confirmed_at, now()),
             updated_at = now()
       where id = v_id;
    end if;

    -- A profilt a trigger 'pending' állapotban hozza létre; itt jóváhagyjuk.
    update public.profiles
       set role = 'STUDENT', approval_status = 'approved',
           approved_at = coalesce(approved_at, now())
     where id = v_id;
  end loop;
end $$;

select 'OK: ' || p.email || ' — ' || p.role || ' / ' || p.approval_status
  from public.profiles p
 where p.email = any (select u || '@tester.com' from unnest(string_to_array(:'users', ',')) u)
 order by p.email;
SQL
echo "Jelszó mindegyikhez: $PW"
