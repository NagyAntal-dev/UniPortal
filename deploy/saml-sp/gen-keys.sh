#!/bin/sh
# ============================================================================
# A SAML SP kulcsai egy MEGLÉVŐ .env-be (az init-env.sh új telepítésnél
# magától elkészíti őket, de meglévő .env-hez nem nyúl).
#
#   ./deploy/saml-sp/gen-keys.sh           # csak a hiányzó értékeket írja be
#   ./deploy/saml-sp/gen-keys.sh --force   # új kulcspár (utána az NJE IT-nak
#                                          # újra el kell küldeni a metaadatot!)
#
# Utána:  docker compose up -d --build
# ============================================================================
set -eu
cd "$(dirname "$0")/../.."

[ -f .env ] || { echo "Nincs .env — előbb: ./init-env.sh <nyilvános cím>"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "HIBA: az openssl szükséges."; exit 1; }
FORCE="${1:-}"

current() { sed -n "s/^$1=//p" .env | tail -n 1; }
put() { # kulcs érték — meglévő sor cseréje, vagy hozzáfűzés
  if grep -q "^$1=" .env; then
    sed -e "s|^$1=.*$|$1=$2|" .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

if [ -z "$(current SAML_SP_PRIVATE_KEY)" ] || [ "$FORCE" = "--force" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
    -subj "/CN=uniportal-saml-sp" -keyout "$tmp/sp.key" -out "$tmp/sp.crt" 2>/dev/null
  put SAML_SP_PRIVATE_KEY "$(openssl enc -base64 -A < "$tmp/sp.key")"
  put SAML_SP_CERT        "$(openssl enc -base64 -A < "$tmp/sp.crt")"
  echo "Kész: új SP-kulcspár (10 évig érvényes tanúsítvány)."
else
  echo "Az SP-kulcspár már megvan — nem cserélem (új kulcshoz: --force)."
fi

if [ -z "$(current SAML_COOKIE_SECRET)" ]; then
  put SAML_COOKIE_SECRET "$(openssl rand -hex 32)"
  echo "Kész: SAML_COOKIE_SECRET."
fi

chmod 600 .env
URL="$(current UNIPORTAL_PUBLIC_URL)"
echo ""
echo "Következő lépés:   docker compose up -d --build"
echo "Az NJE IT-nak:     ${URL}/saml/metadata"
