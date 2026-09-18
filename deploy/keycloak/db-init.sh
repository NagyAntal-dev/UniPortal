#!/bin/sh
# ============================================================================
# A Keycloak saját adatbázisa a meglévő Postgresben — egyszer fut minden
# `docker compose up`-nál, és idempotens:
#   • keycloak login-szerepkör (nem superuser, nem hozhat létre DB-t/szerepkört)
#   • keycloak adatbázis, a keycloak tulajdonában; a PUBLIC nem csatlakozhat
#   • a jelszót minden futáskor a .env KEYCLOAK_DB_PASSWORD értékére állítja
#     (így a jelszó a .env átírásával és `docker compose up -d`-vel cserélhető)
#
# KÜLÖN ADATBÁZIS, nem séma a `postgres` DB-ben: a PostgREST, a Supabase
# migrációk és a reset-data.sh így semmiképp nem látják a Keycloak tábláit.
# A mentés (deploy/backup.sh) a teljes adatkönyvtárat viszi, tehát ezt is.
#
# A titkot nem írjuk ki, és a munkamenetben kikapcsoljuk az utasításnaplózást,
# hogy az ALTER ROLE … PASSWORD sor semmiképp ne kerüljön a Postgres naplójába.
# ============================================================================
set -eu

fail() { echo "[keycloak-db-init] HIBA: $*" >&2; exit 1; }

check_secret() { # név érték
  case "$2" in
    ""|*CHANGE_ME*) fail "a .env $1 értéke nincs kitöltve." ;;
  esac
  [ "${#2}" -ge 16 ] || fail "a .env $1 értéke túl rövid (legalább 16 karakter)."
}
check_secret KEYCLOAK_DB_PASSWORD "${KEYCLOAK_DB_PASSWORD:-}"
check_secret KEYCLOAK_ADMIN_PASSWORD "${KEYCLOAK_ADMIN_PASSWORD:-}"
case "${KEYCLOAK_PUBLIC_URL:-}" in
  https://*|http://localhost*|http://127.0.0.1*) ;;
  *) fail "a KEYCLOAK_PUBLIC_URL hiányzik vagy nem https:// (pl. https://uniportal.nje.hu/keycloak)." ;;
esac

KC_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
KC_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"

for i in $(seq 1 30); do
  pg_isready -q && break
  sleep 2
done

psql -v ON_ERROR_STOP=1 -q \
     -v kc_db="$KC_DB_NAME" -v kc_user="$KC_DB_USER" -v kc_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
set log_statement = 'none';
set log_min_duration_statement = -1;

select format('create role %I login', :'kc_user')
 where not exists (select 1 from pg_roles where rolname = :'kc_user')
\gexec

alter role :"kc_user" with login nosuperuser nocreatedb nocreaterole
  noreplication nobypassrls password :'kc_pw';

select format('create database %I owner %I encoding ''UTF8'' template template0', :'kc_db', :'kc_user')
 where not exists (select 1 from pg_database where datname = :'kc_db')
\gexec

revoke all on database :"kc_db" from public;
grant connect, temporary on database :"kc_db" to :"kc_user";
SQL

echo "[keycloak-db-init] kész: adatbázis \"$KC_DB_NAME\", szerepkör \"$KC_DB_USER\"."
