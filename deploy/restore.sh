#!/bin/sh
# ============================================================================
# UniPortal visszaállítás egy backup.sh-archívumból.
#
#   sudo ./deploy/restore.sh backups/uniportal-<időbélyeg>.tar.gz
#
# A jelenlegi adatbázis-könyvtár, a feltöltések és a .env NEM törlődik: átkerül
# a backups/elozo-<időbélyeg>/ könyvtárba. A .env is visszaáll, mert az
# adatbázis az archívumban lévő jelszóval és JWT-titokkal jött létre.
# A mentéssel azonos vagy újabb UniPortal-verzión (git) futtasd — újabbon a
# migrate a hiányzó migrációkat pótolja.
# ============================================================================
set -eu
cd "$(dirname "$0")/.."
VOL=deploy/supabase/volumes
F="${1:-}"
{ [ -n "$F" ] && [ -f "$F" ]; } || { echo "Használat: sudo ./deploy/restore.sh backups/uniportal-….tar.gz"; exit 1; }

LIST="$(tar -tzf "$F" 2>/dev/null)" || { echo "[restore] HIBA: az archívum nem olvasható: $F"; exit 1; }
printf '%s\n' "$LIST" | grep -qx 'db/data/PG_VERSION' || { echo "[restore] HIBA: ez nem UniPortal-mentés (hiányzik: db/data/PG_VERSION)."; exit 1; }
printf '%s\n' "$LIST" | grep -qx '.env' || { echo "[restore] HIBA: az archívumból hiányzik a .env."; exit 1; }
MEMBERS="db/data"
printf '%s\n' "$LIST" | grep -q '^storage/' && MEMBERS="$MEMBERS storage"
if [ -d "$VOL/db/data" ] && [ ! -r "$VOL/db/data" ]; then
  echo "[restore] HIBA: a jelenlegi adatbázis-könyvtár nem érhető el — futtasd sudo-val."; exit 1
fi

echo "A visszaállítás LEÁLLÍTJA a rendszert, és a jelenlegi adatbázist, feltöltéseket"
echo "és .env-et a mentés tartalmára cseréli: $F"
echo "A jelenlegi állapot nem vész el: a backups/elozo-… könyvtárba kerül."
printf 'Folytatod? Írd be: igen  > '
read -r valasz || valasz=""
[ "$valasz" = "igen" ] || { echo "Megszakítva, nem történt változás."; exit 1; }

umask 077
TS=$(date +%Y%m%d-%H%M%S)
OLD="backups/elozo-$TS"
docker compose down
mkdir -p "$OLD"
chmod 700 backups "$OLD"
[ -e "$VOL/db/data" ] && mv "$VOL/db/data" "$OLD/db-data"
[ -e "$VOL/storage" ] && mv "$VOL/storage" "$OLD/storage"
[ -f .env ] && mv .env "$OLD/.env"
tar -xzf "$F" -C "$VOL" $MEMBERS
tar -xzf "$F" .env
chmod 600 .env
echo "[restore] visszaállítva, indítás…"
docker compose up -d --build
echo "[restore] kész. Az előző állapot: $OLD — ha minden rendben, törölhető."
