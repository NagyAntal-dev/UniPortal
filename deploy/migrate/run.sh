#!/bin/sh
# ============================================================================
# UniPortal migrációs futtató — a `migrate` szolgáltatás egyszer futtatja a
# stack indulásakor, a `web` csak utána indul.
#
#  • Megvárja, amíg az auth és a storage szolgáltatás létrehozta a sémáját
#    (a migrációk hivatkoznak az auth.users és a storage.buckets táblára).
#  • A manifest.txt sorrendjében futtat; ami már lefutott, azt kihagyja
#    (uniportal_meta.migrations — nem a public sémában, így a REST API nem látja).
#  • MEGLÉVŐ adatbázisnál (pl. visszaállított éles mentés, de még nincs
#    nyilvántartás) NEM futtat semmit — a 01-es migráció táblákat dob el! —,
#    csak nyilvántartásba veszi a listát ("baseline").
# ============================================================================
set -eu
MIG_DIR="${MIG_DIR:-/uniportal/migrations}"
MANIFEST="${MANIFEST:-/uniportal/bin/manifest.txt}"
export PGCONNECT_TIMEOUT=5
q() { psql -X -v ON_ERROR_STOP=1 -qtAc "$1"; }

case "${UNIPORTAL_SECRET_CHECK:-x}" in
  *CHANGE_ME*|"||") echo "[migrate] HIBA: a .env titkai nincsenek kitöltve. Futtasd egyszer: ./init-env.sh  — utána: docker compose up -d --build"; exit 1 ;;
esac


# ---- A UniPortal compose-réteg betöltődött-e? ----
# A deploy/compose.uniportal.yml az EGYETLEN dolog, ami az api-gw-t (Studio +
# nyers API) és a Supavisort a 127.0.0.1-re szorítja. A réteget a .env
# COMPOSE_FILE sora tölti be; enélkül a Studio és a Postgres-pooler MINDEN
# interfészen kinyílik. Csak figyelmeztetünk: a migráció maga ettől még helyes.
if [ "${UNIPORTAL_LAYER:-}" != "on" ]; then
  echo "[migrate] ============================================================"
  echo "[migrate] FIGYELEM: a UniPortal compose-réteg NEM töltődött be."
  echo "[migrate] Ilyenkor a Studio (:8000) és a Postgres-pooler (:5432, :6543)"
  echo "[migrate] MINDEN interfészen elérhető, nem csak a szerverről."
  echo "[migrate] Ellenőrizd a .env-ben:"
  echo "[migrate]   COMPOSE_FILE=docker-compose.yml:deploy/compose.uniportal.yml"
  echo "[migrate] és indítsd sima 'docker compose up -d --build' paranccsal."
  echo "[migrate] ============================================================"
fi
echo "[migrate] várakozás az adatbázisra és a Supabase-sémákra (auth, storage)…"
i=0
until [ "$(q "select (to_regclass('auth.users') is not null and to_regclass('storage.buckets') is not null)::text" 2>/dev/null || true)" = "true" ]; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo "[migrate] HIBA: 10 perc alatt sem jött létre az auth/storage séma — nézd meg: docker compose logs auth storage"; exit 1; fi
  sleep 5
done

psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists uniportal_meta;
create table if not exists uniportal_meta.migrations (
  file       text primary key,
  checksum   text not null,
  mode       text not null default 'applied' check (mode in ('applied', 'baseline')),
  applied_at timestamptz not null default now()
);
revoke all on schema uniportal_meta from public;
SQL

lista() { grep -vE '^[[:space:]]*(#|$)' "$MANIFEST"; }

if [ "$(q "select count(*) from uniportal_meta.migrations")" = "0" ] && [ "$(q "select (to_regclass('public.profiles') is not null)::text")" = "true" ]; then
  echo "[migrate] Meglévő UniPortal-adatbázis, nyilvántartás nélkül (pl. visszaállított mentés)."
  echo "[migrate] A migrációkat NEM futtatom, csak nyilvántartásba veszem (baseline)."
  for f in $(lista); do
    sum="$(sha256sum "$MIG_DIR/$f" | cut -d' ' -f1)"
    q "insert into uniportal_meta.migrations (file, checksum, mode) values ('$f', '$sum', 'baseline') on conflict do nothing" >/dev/null
  done
  echo "[migrate] Kész (baseline)."
else
  uj=0
  for f in $(lista); do
    path="$MIG_DIR/$f"
    [ -f "$path" ] || { echo "[migrate] HIBA: a manifestben szereplő fájl hiányzik: $f"; exit 1; }
    sum="$(sha256sum "$path" | cut -d' ' -f1)"
    prev="$(q "select checksum from uniportal_meta.migrations where file = '$f'")"
    if [ -n "$prev" ]; then
      [ "$prev" = "$sum" ] || echo "[migrate] FIGYELEM: $f tartalma megváltozott a lefutása óta — nem futtatom újra."
      continue
    fi
    echo "[migrate] $f"
    if ! psql -X -v ON_ERROR_STOP=1 --single-transaction -f "$path" >/tmp/migrate.log 2>&1; then
      cat /tmp/migrate.log
      echo "[migrate] HIBA a(z) $f futtatásakor. A javítás után: docker compose up -d migrate"
      exit 1
    fi
    grep -E "NOTICE:  (Rendben|Kész)|WARNING" /tmp/migrate.log | sed 's/^/           /' || true
    q "insert into uniportal_meta.migrations (file, checksum) values ('$f', '$sum')" >/dev/null
    uj=$((uj + 1))
  done
  echo "[migrate] Kész: $uj új migráció futott le."
fi

# ---- Éles védelem: a nyilvánosan ismert jelszavú demó fiókok lezárása ----
if [ "${UNIPORTAL_DEMO_ACCOUNTS:-lock}" = "keep" ]; then
  echo "[migrate] FIGYELEM: UNIPORTAL_DEMO_ACCOUNTS=keep — a demó fiókok (jelszó: Demo1234!) nyitva maradnak. Éles szerveren NE!"
else
  if ! psql -X -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/harden.sql" >/tmp/harden.log 2>&1; then
    cat /tmp/harden.log
    echo "[migrate] HIBA a demó fiókok lezárásakor (deploy/migrate/harden.sql)."
    exit 1
  fi
  sed -n 's/^.*NOTICE:  /[migrate] /p' /tmp/harden.log
fi

# ---- Éles védelem: függvény-jogosultságok lezárása ----
# MINDEN indításkor lefut, a migrációk után — ezért NEM a manifest része.
# A PostgreSQL minden új függvényre ad EXECUTE-ot a PUBLIC-nak, a Supabase
# pedig külön az anonnak; e nélkül minden új migráció újranyitná a felületet.
# Részletek: supabase/99_harden_grants.sql fejléce.
if ! psql -X -v ON_ERROR_STOP=1 -q -f "$MIG_DIR/99_harden_grants.sql" >/tmp/grants.log 2>&1; then
  cat /tmp/grants.log
  echo "[migrate] HIBA a függvény-jogosultságok lezárásakor (supabase/99_harden_grants.sql)."
  exit 1
fi
sed -n 's/^.*NOTICE:  /[migrate] /p' /tmp/grants.log
sed -n 's/^.*WARNING:  /[migrate] FIGYELEM: /p' /tmp/grants.log

# ---- Biztonsági önellenőrzés (nem állítja meg az indulást) ----
if ! psql -X -q -f "$(dirname "$0")/verify.sql" >/tmp/verify.log 2>&1; then
  echo "[migrate] FIGYELEM: a biztonsági önellenőrzés nem futott le."
  cat /tmp/verify.log
else
  sed -n 's/^.*NOTICE:  /[migrate] /p'  /tmp/verify.log
  sed -n 's/^.*WARNING:  /[migrate] FIGYELEM: /p' /tmp/verify.log
fi

# A PostgREST a migrációk előtt indult: töltse újra a sémát (új táblák, függvények).
q "notify pgrst, 'reload schema'" >/dev/null
echo "[migrate] Az adatbázis naprakész."
