#!/bin/sh
# ============================================================================
# config.js előállítása a konténer indulásakor, a környezeti változókból.
#   UNIPORTAL_SUPABASE_ANON_KEY  kötelező (a .env ANON_KEY értéke)
#   UNIPORTAL_SUPABASE_URL       üresen: a böngésző saját címe (a web
#                                konténer továbbítja az API-t)
# ============================================================================
set -eu
URL="${UNIPORTAL_SUPABASE_URL:-}"
KEY="${UNIPORTAL_SUPABASE_ANON_KEY:-}"
HTML_DIR="${UNIPORTAL_HTML_DIR:-/usr/share/nginx/html}"
case "$KEY" in *CHANGE_ME*) KEY="" ;; esac
if [ -z "$KEY" ]; then
  echo "[uniportal] HIBA: az UNIPORTAL_SUPABASE_ANON_KEY üres — futtattad az ./init-env.sh-t?" >&2
  exit 1
fi
# Csak biztonságos karakterek kerülhetnek a JavaScript-szövegbe.
case "$URL$KEY" in
  *[\'\"\\\<\>\`]*) echo "[uniportal] HIBA: tiltott karakter a Supabase URL-ben vagy kulcsban." >&2; exit 1 ;;
esac
cat > "$HTML_DIR/config.js" <<EOF
/* A konténer indulásakor generálva (deploy/web/40-uniportal-config.sh). */
window.SUPABASE_URL = '${URL}' || window.location.origin;
window.SUPABASE_ANON_KEY = '${KEY}';
EOF
echo "[uniportal] config.js kész (API: ${URL:-azonos cím, továbbítva})."
