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

# ---------------------------------------------------------------------------
# Valós ügyfél-IP a sebességkorláthoz (deploy/web/default.conf.template).
#
# Élesben a web egy TLS-proxy MÖGÖTT fut (DEPLOY.md 5. pont), tehát a
# $remote_addr a proxy címe — MINDEN kérésé ugyanaz. Enélkül a
# sebességkorlát egyetlen közös vödör lenne, és az első terhelés az egész
# oldalt kizárná. A proxy X-Forwarded-For fejlécét csak MEGBÍZHATÓ feladótól
# szabad elhinni, különben bárki hamisíthatna magának új IP-t.
#
#   UNIPORTAL_TRUSTED_PROXY   szóközzel elválasztott cím/CIDR lista.
#                             Alapérték: 127.0.0.1 (a proxy ugyanazon a gépen).
#                             Ha nincs előtte proxy, állítsd üresre.
# ---------------------------------------------------------------------------
RIP_CONF="/etc/nginx/uniportal/realip.conf"
: > "$RIP_CONF"
for cidr in ${UNIPORTAL_TRUSTED_PROXY:-}; do
  case "$cidr" in
    *[!0-9a-fA-F.:/]*)
      echo "[uniportal] HIBA: tiltott karakter az UNIPORTAL_TRUSTED_PROXY értékében: $cidr" >&2
      exit 1 ;;
  esac
  echo "set_real_ip_from $cidr;" >> "$RIP_CONF"
done
if [ -s "$RIP_CONF" ]; then
  echo "real_ip_header X-Forwarded-For;" >> "$RIP_CONF"
  echo "real_ip_recursive on;"           >> "$RIP_CONF"
  echo "[uniportal] valós ügyfél-IP a következőktől: ${UNIPORTAL_TRUSTED_PROXY}"
else
  echo "# Nincs megbízható proxy: a \$remote_addr marad az ügyfél címe." >> "$RIP_CONF"
  echo "[uniportal] FIGYELEM: UNIPORTAL_TRUSTED_PROXY üres — ha TLS-proxy mögött futsz, a sebességkorlát MINDEN látogatót egy vödörbe tesz."
fi
