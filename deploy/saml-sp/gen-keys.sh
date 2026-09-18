#!/bin/sh
# ============================================================================
# A SAML SP kulcsai egy MEGLÉVŐ .env-be (az init-env.sh új telepítésnél
# magától elkészíti őket, de meglévő .env-hez nem nyúl).
#
#   sh deploy/saml-sp/gen-keys.sh                  # csak a hiányzó értékeket írja be
#   sh deploy/saml-sp/gen-keys.sh --cert FILE.pem  # a tanúsítvány egy meglévő fájlból
#                                                  # (pl. amit az IT már megkapott)
#   sh deploy/saml-sp/gen-keys.sh --force          # ÚJ kulcspár (utána az NJE IT-nak
#                                                  # újra el kell küldeni a metaadatot!)
#
# A kulcs forrása, ebben a sorrendben:
#   1. SAML_SP_PRIVATE_KEY — ha már megvan, nem nyúlunk hozzá;
#   2. SAML_PRIVATE_KEY    — a korábbi GoTrue-s SAML-kísérlet kulcsa (a DER
#                            base64-e): ezt PEM-re alakítva ÁTVESSZÜK, így az
#                            IT-nál esetleg már bejegyzett kulcs érvényes marad;
#   3. új, 3072 bites RSA-kulcs.
# A tanúsítvány: --cert fájlból (csak ha a kulcshoz tartozik), különben a
# kulccsal aláírt új, 10 éves önaláírt tanúsítvány. Ugyanahhoz a kulcshoz
# készült új tanúsítvány ugyanazt a nyilvános kulcsot hordozza.
#
# Utána:  docker compose up -d --build
# ============================================================================
set -eu
cd "$(dirname "$0")/../.."

[ -f .env ] || { echo "Nincs .env — előbb: ./init-env.sh <nyilvános cím>"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "HIBA: az openssl szükséges."; exit 1; }

FORCE=""
CERT_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --cert)  shift; CERT_FILE="${1:-}"; [ -f "$CERT_FILE" ] || { echo "HIBA: nincs ilyen fájl: $CERT_FILE"; exit 1; } ;;
    *) echo "Ismeretlen kapcsoló: $1"; exit 1 ;;
  esac
  shift
done

current() { sed -n "s/^$1=//p" .env | tail -n 1 | sed -e 's/^"//' -e 's/"$//'; }
put() { # kulcs érték — meglévő sor cseréje, vagy hozzáfűzés
  if grep -q "^$1=" .env; then
    sed -e "s|^$1=.*$|$1=$2|" .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
b64() { openssl enc -base64 -A < "$1"; }
unb64() { printf '%s' "$1" | openssl enc -base64 -d -A > "$2"; }
pub_of_key()  { openssl pkey -in "$1" -pubout 2>/dev/null; }
pub_of_cert() { openssl x509 -in "$1" -noout -pubkey 2>/dev/null; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# ---- 1. a kulcs ----
KEY_CHANGED=""
if [ -n "$FORCE" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$tmp/sp.key" 2>/dev/null
  echo "Kész: ÚJ SP-kulcs (--force)."
  KEY_CHANGED=1
elif [ -n "$(current SAML_SP_PRIVATE_KEY)" ]; then
  unb64 "$(current SAML_SP_PRIVATE_KEY)" "$tmp/sp.key"
  echo "Az SP-kulcs már megvan (SAML_SP_PRIVATE_KEY) — megtartom."
elif [ -n "$(current SAML_PRIVATE_KEY)" ]; then
  # GoTrue-formátum: a PKCS#1 vagy PKCS#8 DER base64-e. PEM is lehet.
  unb64 "$(current SAML_PRIVATE_KEY)" "$tmp/old.der"
  if grep -q "BEGIN" "$tmp/old.der" 2>/dev/null; then
    openssl pkey -in "$tmp/old.der" -out "$tmp/sp.key" 2>/dev/null
  else
    openssl pkey -inform DER -in "$tmp/old.der" -out "$tmp/sp.key" 2>/dev/null \
      || openssl rsa -inform DER -in "$tmp/old.der" -out "$tmp/sp.key" 2>/dev/null
  fi || { echo "HIBA: a SAML_PRIVATE_KEY nem olvasható kulcs (base64 DER vagy PEM kell)."; exit 1; }
  echo "Kész: a meglévő SAML_PRIVATE_KEY átvéve SP-kulcsnak."
  KEY_CHANGED=1
else
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$tmp/sp.key" 2>/dev/null
  echo "Kész: új SP-kulcs."
  KEY_CHANGED=1
fi
pub_of_key "$tmp/sp.key" > "$tmp/key.pub" || { echo "HIBA: az SP-kulcs érvénytelen."; exit 1; }
[ -n "$KEY_CHANGED" ] && put SAML_SP_PRIVATE_KEY "$(b64 "$tmp/sp.key")"

# ---- 2. a tanúsítvány ----
cert_matches() { pub_of_cert "$1" > "$tmp/crt.pub" && cmp -s "$tmp/crt.pub" "$tmp/key.pub"; }
if [ -n "$CERT_FILE" ]; then
  cert_matches "$CERT_FILE" || { echo "HIBA: a(z) $CERT_FILE tanúsítvány NEM ehhez a kulcshoz tartozik (vagy nem tanúsítvány)."; exit 1; }
  openssl x509 -in "$CERT_FILE" -out "$tmp/sp.crt"
  put SAML_SP_CERT "$(b64 "$tmp/sp.crt")"
  echo "Kész: tanúsítvány átvéve: $CERT_FILE"
else
  if [ -n "$(current SAML_SP_CERT)" ] && [ -z "$KEY_CHANGED" ]; then
    unb64 "$(current SAML_SP_CERT)" "$tmp/sp.crt"
  fi
  if [ -s "$tmp/sp.crt" ] && cert_matches "$tmp/sp.crt"; then
    echo "A tanúsítvány már megvan, és a kulcshoz tartozik — megtartom."
  else
    openssl req -x509 -new -key "$tmp/sp.key" -sha256 -days 3650 \
      -subj "/CN=uniportal-saml-sp" -out "$tmp/sp.crt" 2>/dev/null
    put SAML_SP_CERT "$(b64 "$tmp/sp.crt")"
    echo "Kész: új, 10 évig érvényes tanúsítvány a kulcshoz."
  fi
fi

# ---- 3. a süti-titok ----
if [ -z "$(current SAML_COOKIE_SECRET)" ]; then
  put SAML_COOKIE_SECRET "$(openssl rand -hex 32)"
  echo "Kész: SAML_COOKIE_SECRET."
fi

chmod 600 .env
URL="$(current UNIPORTAL_PUBLIC_URL)"
echo ""
echo "Következő lépés:   docker compose up -d --build"
echo "Az NJE IT-nak:     ${URL}/saml/metadata"
