#!/bin/sh
# ============================================================================
# UniPortal — EGYSZERI előkészítés: .env létrehozása erős, véletlen titkokkal.
#
#   ./init-env.sh                              # http://localhost:8080
#   ./init-env.sh https://uniportal.pelda.hu   # a nyilvános cím (TLS-proxy mögött)
#
# Utána minden indítás és frissítés:  docker compose up -d --build
#
# A titkok NEM kerülhetnek a git-tárolóba (a tároló nyilvános) — ezért nincs
# kész .env. A kulcsok a hivatalos Supabase utils/generate-keys.sh módszerével
# készülnek (HS256-tal aláírt anon és service_role JWT).
# ============================================================================
set -eu
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "A .env már létezik — nem írom felül."
  echo "Ha tényleg új titkok kellenek: töröld a .env-et ÉS az adatbázist (deploy/supabase/volumes/db/data),"
  echo "mert a meglévő adatbázis a régi jelszóval és JWT-titokkal jött létre."
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "HIBA: az openssl szükséges (pl. apt install openssl)."; exit 1; }

PUBLIC_URL="${1:-http://localhost:8080}"
PUBLIC_URL="${PUBLIC_URL%/}"
case "$PUBLIC_URL" in http://*|https://*) ;; *) echo "HIBA: a címnek http:// vagy https:// kezdetűnek kell lennie."; exit 1 ;; esac

b64url() { openssl enc -base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {
  h=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '%s' "$1" | b64url)
  s=$(printf '%s' "$h.$p" | openssl dgst -binary -sha256 -hmac "$JWT_SECRET" | b64url)
  printf '%s' "$h.$p.$s"
}

JWT_SECRET=$(openssl rand -hex 32)
IAT=$(date +%s); EXP=$((IAT + 5 * 365 * 24 * 3600))
ANON_KEY=$(jwt "{\"role\":\"anon\",\"iss\":\"supabase\",\"iat\":$IAT,\"exp\":$EXP}")
SERVICE_ROLE_KEY=$(jwt "{\"role\":\"service_role\",\"iss\":\"supabase\",\"iat\":$IAT,\"exp\":$EXP}")

set_kv() { # kulcs érték — a .env.tmp-ben az adott sor cseréje
  printf '%s\n' "$2" | grep -q '|' && { echo "belső hiba: | az értékben ($1)"; exit 1; }
  sed -e "s|^$1=.*$|$1=$2|" .env.tmp > .env.tmp2 && mv .env.tmp2 .env.tmp
}

cp .env.example .env.tmp
set_kv UNIPORTAL_PUBLIC_URL        "$PUBLIC_URL"
set_kv SITE_URL                    "$PUBLIC_URL"
set_kv ADDITIONAL_REDIRECT_URLS    "$PUBLIC_URL/**"
set_kv SUPABASE_PUBLIC_URL         "$PUBLIC_URL"
set_kv API_EXTERNAL_URL            "$PUBLIC_URL/auth/v1"
set_kv POSTGRES_PASSWORD           "$(openssl rand -hex 24)"
set_kv JWT_SECRET                  "$JWT_SECRET"
set_kv ANON_KEY                    "$ANON_KEY"
set_kv SERVICE_ROLE_KEY            "$SERVICE_ROLE_KEY"
set_kv DASHBOARD_PASSWORD          "$(openssl rand -hex 16)"
set_kv SECRET_KEY_BASE             "$(openssl rand -hex 48)"
set_kv REALTIME_DB_ENC_KEY         "$(openssl rand -hex 8)"
set_kv VAULT_ENC_KEY               "$(openssl rand -hex 16)"
set_kv PG_META_CRYPTO_KEY          "$(openssl rand -hex 24)"
set_kv LOGFLARE_PUBLIC_ACCESS_TOKEN  "$(openssl rand -hex 24)"
set_kv LOGFLARE_PRIVATE_ACCESS_TOKEN "$(openssl rand -hex 24)"
set_kv S3_PROTOCOL_ACCESS_KEY_ID     "$(openssl rand -hex 16)"
set_kv S3_PROTOCOL_ACCESS_KEY_SECRET "$(openssl rand -hex 32)"
set_kv MINIO_ROOT_PASSWORD         "$(openssl rand -hex 16)"
set_kv POOLER_TENANT_ID            "uniportal-$(openssl rand -hex 4)"
# NJE SAML bejelentkezés (deploy/saml-sp): az SP aláíró kulcsa és tanúsítványa.
SAML_TMP=$(mktemp -d)
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -subj "/CN=uniportal-saml-sp" -keyout "$SAML_TMP/sp.key" -out "$SAML_TMP/sp.crt" 2>/dev/null
set_kv SAML_SP_PRIVATE_KEY         "$(openssl enc -base64 -A < "$SAML_TMP/sp.key")"
set_kv SAML_SP_CERT                "$(openssl enc -base64 -A < "$SAML_TMP/sp.crt")"
rm -rf "$SAML_TMP"
set_kv SAML_COOKIE_SECRET          "$(openssl rand -hex 32)"
mv .env.tmp .env
chmod 600 .env

echo "Kész: .env (jogosultság: 600). Nyilvános cím: $PUBLIC_URL"
echo ""
echo "Következő lépés:   docker compose up -d --build"
echo "NJE SAML: az IT-nak ezt a metaadat-címet kell megadni: $PUBLIC_URL/saml/metadata (docs/nje-saml.md)"
echo "Studio (adminfelület) csak a szerverről: http://127.0.0.1:8000  — felhasználó: supabase,"
echo "jelszó: DASHBOARD_PASSWORD a .env-ben. Távolról SSH-alagúttal: ssh -L 8000:127.0.0.1:8000 <szerver>"
