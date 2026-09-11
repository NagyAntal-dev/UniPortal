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

# A PostgREST a migrációk előtt indult: töltse újra a sémát (új táblák, függvények).
q "notify pgrst, 'reload schema'" >/dev/null
echo "[migrate] Az adatbázis naprakész."
