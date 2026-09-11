#!/bin/sh
# A UniPortal edge functionjei (supabase/functions/*) átmásolása a self-host
# functions kötetébe. A konténer a deploy/supabase/volumes/functions könyvtárat
# csatolja; szimbolikus link a konténerben nem oldódna fel, ezért másolat.
# A forrás a supabase/functions — ott szerkessz, ne a másolatban.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for d in "$ROOT"/supabase/functions/*/; do
  n="$(basename "$d")"
  rm -rf "$ROOT/deploy/supabase/volumes/functions/$n"
  cp -R "$d" "$ROOT/deploy/supabase/volumes/functions/$n"
  echo "functions: $n"
done
