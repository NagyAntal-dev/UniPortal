#!/bin/sh
# ============================================================================
# Rendszergazda (SUPERADMIN) kijelölése.
#
#   ./deploy/make-superadmin.sh te@nje.hu            # regisztrált fiók előléptetése
#   ./deploy/make-superadmin.sh te@nje.hu --create   # ha még nincs ilyen fiók, létrehozza
#                                                    # (megerősített e-mail, ideiglenes jelszó)
#
# A --create SMTP nélkül is működik — így lesz első rendszergazda, mielőtt a
# levélküldés be van állítva. A kapcsolatot a migrate szolgáltatás beállításaival
# nyitja (ugyanaz a felhasználó és jelszó, mint a migrációknál). A profilvédő
# trigger a szerverről (felhasználói token nélkül) indított módosítást engedi.
# ============================================================================
set -eu
cd "$(dirname "$0")/.."
EMAIL="${1:-}"; MODE="${2:-}"
if [ -z "$EMAIL" ] || { [ -n "$MODE" ] && [ "$MODE" != "--create" ]; }; then
  echo "Használat: ./deploy/make-superadmin.sh email@pelda.hu [--create]"; exit 1
fi
case "$EMAIL" in
  *[!A-Za-z0-9._%+@-]*|*@*@*|@*|*@) echo "HIBA: érvénytelen e-mail-cím: $EMAIL"; exit 1 ;;
  *@*.*) ;;
  *) echo "HIBA: érvénytelen e-mail-cím: $EMAIL"; exit 1 ;;
esac

CREATE=false; PW=""
if [ "$MODE" = "--create" ]; then
  command -v openssl >/dev/null 2>&1 || { echo "HIBA: a --create-hez openssl szükséges."; exit 1; }
  CREATE=true
  PW="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-16)"
fi

OUT="$(docker compose run --rm --no-deps -T --entrypoint psql migrate \
  -X -q -t -A -v ON_ERROR_STOP=1 -v email="$EMAIL" -v pw="$PW" -v create="$CREATE" <<'SQL'
set search_path = public, extensions;
select exists (select 1 from auth.users where lower(email) = lower(:'email')) as van \gset
\if :van
\elif :create
  -- Ugyanaz a minta, amellyel a 02-es migráció a fiókokat létrehozza.
  select gen_random_uuid() as uid \gset
  begin;
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', :'uid', 'authenticated', 'authenticated',
    lower(:'email'), crypt(:'pw', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', split_part(:'email', '@', 1)),
    false, '', '', '', ''
  );
  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), :'uid', :'uid',
    jsonb_build_object('sub', :'uid', 'email', lower(:'email'), 'email_verified', true),
    'email', now(), now(), now()
  );
  commit;
  \echo LETREHOZVA
\else
  \echo 'NINCS ilyen fiók. Regisztrálj a felületen ezzel a címmel, vagy hozd létre most a --create kapcsolóval.'
  \quit
\endif
update public.profiles
   set role = 'SUPERADMIN', approval_status = 'approved', approved_at = coalesce(approved_at, now())
 where lower(email) = lower(:'email');
select case when exists (select 1 from public.profiles
                          where lower(email) = lower(:'email') and role = 'SUPERADMIN' and approval_status = 'approved')
            then 'OK: ' || :'email' || ' mostantól SUPERADMIN, jóváhagyva.'
            else 'HIBA: a fiók megvan, de a profilja nem jött létre — nézd meg: docker compose logs migrate auth' end;
SQL
)"
printf '%s\n' "$OUT" | grep -v '^LETREHOZVA$' || true
case "$OUT" in
  *LETREHOZVA*)
    echo "A fiók létrejött. Ideiglenes jelszó: $PW"
    echo "Belépés után cseréld le: Fiók → Jelszó módosítása." ;;
esac
case "$OUT" in *"OK: "*) exit 0 ;; *) exit 1 ;; esac
