#!/bin/sh
# ============================================================================
# A hivatalos Supabase self-host fájlok beemelése RÖGZÍTETT verzióban
# (deploy/supabase). A tesztek és a fejlesztői fájlok kimaradnak.
#
#   sh deploy/vendor-supabase.sh            # a rögzített commit
#   sh deploy/vendor-supabase.sh <sha|tag>  # frissítés egy újabb verzióra
#
# Frissítés után: git diff deploy/supabase, majd docker compose up -d --build.
# A deploy/supabase-ba nem kerül saját fájl: a UniPortal eltéréseit a
# deploy/compose.uniportal.yml tartalmazza (a függvényeket is onnan csatoljuk
# a supabase/functions könyvtárból), így az újrabeemelés semmit nem ír felül.
# ============================================================================
set -eu
REF="${1:-8c7a4d9dbbaf8b552893822e89d7bf06f33f9220}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/deploy/supabase"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" remote add origin https://github.com/supabase/supabase.git
git -C "$TMP" sparse-checkout set --no-cone /docker/ >/dev/null
git -C "$TMP" fetch -q --depth 1 --filter=blob:none origin "$REF"
git -C "$TMP" checkout -q FETCH_HEAD

rm -rf "$DEST"
mkdir -p "$DEST"
( cd "$TMP/docker" && tar cf - --exclude ./tests --exclude ./dev . ) | ( cd "$DEST" && tar xf - )
printf 'Forrás: https://github.com/supabase/supabase/tree/%s/docker\nBeemelve: %s\nA tests/ és dev/ könyvtár szándékosan kimaradt. Licenc: Apache-2.0.\n' \
  "$REF" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEST/UNIPORTAL_VENDOR.txt"
echo "Kész: $DEST ($REF)"
