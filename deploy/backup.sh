#!/bin/sh
# ============================================================================
# UniPortal mentés — az adatbázis-könyvtár, a feltöltött fájlok és a .env
# egyetlen archívumba:  backups/uniportal-<időbélyeg>.tar.gz
#
#   sudo ./deploy/backup.sh
#
# A mentés idejére (általában 1 percen belül) leállítja a rendszert, így az
# adatbázis és a feltöltések biztosan egymáshoz illő állapotban kerülnek az
# archívumba; utána újraindítja. Éjszakára ütemezve (root crontab):
#   30 2 * * * /opt/UniPortal/deploy/backup.sh >> /opt/UniPortal/backups/backup.log 2>&1
# Visszaállítás:  sudo ./deploy/restore.sh backups/uniportal-<időbélyeg>.tar.gz
#
# Az archívum SZEMÉLYES ADATOKAT és a .env TITKAIT tartalmazza: a szerveren
# kívülre csak titkosítva vidd. A régebbi archívumokat UNIPORTAL_BACKUP_KEEP_DAYS
# (alapból 14) nap után törli.
# ============================================================================
set -eu
cd "$(dirname "$0")/.."
VOL=deploy/supabase/volumes
KEEP_DAYS="${UNIPORTAL_BACKUP_KEEP_DAYS:-14}"

[ -f .env ] || { echo "[backup] HIBA: nincs .env — ez nem egy telepített UniPortal-könyvtár."; exit 1; }
[ -r "$VOL/db/data/PG_VERSION" ] || {
  echo "[backup] HIBA: az adatbázis-könyvtár nem olvasható. Futtasd sudo-val (vagy a rendszer még nem indult el)."
  exit 1
}

umask 077
mkdir -p backups
chmod 700 backups
TS=$(date +%Y%m%d-%H%M%S)
OUT="backups/uniportal-$TS.tar.gz"
MEMBERS="db/data"
[ -d "$VOL/storage" ] && MEMBERS="$MEMBERS storage"

# Bármi történik a mentés közben, a rendszer induljon újra.
trap 'echo "[backup] a rendszer újraindítása…"; docker compose up -d >/dev/null 2>&1 || echo "[backup] FIGYELEM: az újraindítás nem sikerült — futtasd: docker compose up -d"' EXIT
echo "[backup] a rendszer leállítása a mentés idejére…"
docker compose stop
tar -czf "$OUT.part" .env -C "$VOL" $MEMBERS
mv "$OUT.part" "$OUT"
echo "[backup] kész: $OUT ($(du -h "$OUT" | cut -f1))"
find backups -maxdepth 1 -name 'uniportal-*.tar.gz' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[backup] régi mentés törölve: /'
