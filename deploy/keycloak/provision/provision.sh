#!/bin/sh
# ============================================================================
# UniPortal Keycloak — az NJE IdP és a Supabase SAML-kliens beállítása.
# Idempotens: bármikor újrafuttatható (pl. NJE-tanúsítványcsere után is).
#
#   docker compose run --rm keycloak-provision                     # Keycloak oldal
#   docker compose run --rm keycloak-provision register-supabase   # Supabase provider
#   docker compose run --rm keycloak-provision register-supabase --replace-existing
#   docker compose run --rm keycloak-provision register-supabase --metadata-xml
#
# Mit csinál (alapparancs):
#   1. NJE IdP ("nje"): a metadatát a Keycloak maga tölti le és értelmezi
#      (identity-provider/import-config), erre kerülnek a rögzített beállítások
#      (templates/idp-nje.json): principal = ePPN attribútum, aláírás-ellenőrzés.
#      Az attribútum-mappereket név szerint hangolja össze (idp-nje-mappers.json).
#   2. Supabase SAML-kliens: az EntityID-t, az ACS-t és az SP-tanúsítványt a
#      FUTÓ Supabase Auth metadatájából veszi (client-description-converter), erre
#      kerülnek a rögzített beállítások (client-supabase.json): aláírt válasz és
#      assertion, persistent NameID, attribútum-mapperek.
#
# A register-supabase a GoTrue admin API-jával a Keycloakot veszi fel a
# Supabase SAML-providerének (SSO_DOMAIN, alapból nje.hu). Ha a domainhez
# MÁSIK IdP (pl. a régi, közvetlen NJE-bekötés) tartozik, csak a
# --replace-existing kapcsolóval törli és cseréli le.
#
# Titkot nem ír ki: a jelszó és a token csak 600-as ideiglenes fájlban él.
# ============================================================================
set -eu
umask 077

REALM=uniportal
KC_URL="${KEYCLOAK_INTERNAL_URL:-http://keycloak:8080/keycloak}"
GOTRUE_URL="${GOTRUE_INTERNAL_URL:-http://auth:9999}"
TPL="${PROVISION_TEMPLATES:-/uniportal/templates}"
NJE_IDP_METADATA_URL="${NJE_IDP_METADATA_URL:-https://idp.nje.hu/simplesaml/saml2/idp/metadata.php}"
SUPABASE_SP_METADATA_URL="${SUPABASE_SP_METADATA_URL:-}"
[ -n "$SUPABASE_SP_METADATA_URL" ] || SUPABASE_SP_METADATA_URL="$GOTRUE_URL/sso/saml/metadata"
SSO_DOMAIN="${SSO_DOMAIN:-nje.hu}"
KEYCLOAK_PUBLIC_URL="${KEYCLOAK_PUBLIC_URL%/}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

log() { echo "[keycloak-provision] $*"; }
die() { echo "[keycloak-provision] HIBA: $*" >&2; exit 1; }

# ---- Keycloak admin REST ---------------------------------------------------
get_token() {
  [ -n "${KEYCLOAK_ADMIN_USER:-}" ] && [ -n "${KEYCLOAK_ADMIN_PASSWORD:-}" ] \
    || die "a KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD nincs megadva."
  printf '%s' "$KEYCLOAK_ADMIN_PASSWORD" > "$TMP/pw"
  code=$(curl -sS -o "$TMP/token.json" -w '%{http_code}' \
    --data-urlencode "grant_type=password" \
    --data-urlencode "client_id=admin-cli" \
    --data-urlencode "username=$KEYCLOAK_ADMIN_USER" \
    --data-urlencode "password@$TMP/pw" \
    "$KC_URL/realms/master/protocol/openid-connect/token") || die "a Keycloak nem érhető el: $KC_URL"
  rm -f "$TMP/pw"
  [ "$code" = 200 ] || die "admin-bejelentkezés sikertelen (HTTP $code). Egyezik a .env KEYCLOAK_ADMIN_* a Keycloak adminjával?"
  printf 'Authorization: Bearer %s\n' "$(jq -r .access_token "$TMP/token.json")" > "$TMP/auth.hdr"
  rm -f "$TMP/token.json"
}

# kc METÓDUS ÚTVONAL [curl-argumentumok…] — a válasz a $TMP/body-ba, a kód a $HTTP-be.
kc() {
  m=$1; p=$2; shift 2
  HTTP=$(curl -sS -o "$TMP/body" -w '%{http_code}' -X "$m" -H "@$TMP/auth.hdr" "$@" \
    "$KC_URL/admin/realms/$REALM$p") || die "Keycloak-hívás sikertelen: $m $p"
}
kc_ok() { # mint kc, de 2xx-et vár
  kc "$@"
  case "$HTTP" in 2*) ;; *) die "$1 $2 → HTTP $HTTP: $(head -c 500 "$TMP/body")" ;; esac
}
json() { kc_ok "$1" "$2" -H 'Content-Type: application/json' --data-binary "@$3"; }

# ---- 0. Realm: a felhasználó ne írhassa át az NJE-től kapott adatait ------
# Az import a realm alapszerepköréhez (default-roles-uniportal) akkor is
# hozzáadja az account/manage-account jogot, ha a realm JSON kihagyja. Enélkül
# az Account Console-ban mindenki átírhatná az e-mailjét és az attribútumait
# (a következő NJE-belépés felülírná, de addig ez menne a Supabase felé).
harden_realm() {
  kc_ok GET "/clients?clientId=account&search=false"
  acc=$(jq -r '.[0].id // empty' "$TMP/body")
  [ -n "$acc" ] || return 0
  kc_ok GET "/roles/default-roles-$REALM/composites/clients/$acc"
  jq '[.[] | select(.name == "manage-account" or .name == "manage-account-links")]' "$TMP/body" > "$TMP/drop.json"
  if [ "$(jq length "$TMP/drop.json")" -gt 0 ]; then
    json DELETE "/roles/default-roles-$REALM/composites" "$TMP/drop.json"
    log "Account Console: a manage-account jog kivéve az alapszerepkörből."
  fi
}

# ---- 1. NJE Identity Provider ----------------------------------------------
provision_idp() {
  log "NJE IdP metadata: $NJE_IDP_METADATA_URL"
  jq -n --arg u "$NJE_IDP_METADATA_URL" '{providerId: "saml", fromUrl: $u}' > "$TMP/req.json"
  json POST /identity-provider/import-config "$TMP/req.json"
  cp "$TMP/body" "$TMP/imported.json"
  jq -e '.singleSignOnServiceUrl and .signingCertificate' "$TMP/imported.json" >/dev/null \
    || die "az NJE metadatából nem olvasható ki az SSO-cím vagy az aláíró tanúsítvány."

  # A metadatából jövő értékek (SSO/SLO-cím, IdP EntityID, tanúsítvány) + a
  # rögzített beállítások, amelyek MINDIG felülírják a metadatát.
  jq --slurpfile t "$TPL/idp-nje.json" \
     '. as $imp | $t[0] | .config = ($imp + .config)' "$TMP/imported.json" > "$TMP/idp.json"

  kc GET /identity-provider/instances/nje
  if [ "$HTTP" = 200 ]; then
    jq --slurpfile cur "$TMP/body" '. + {internalId: $cur[0].internalId}' "$TMP/idp.json" > "$TMP/idp2.json"
    json PUT /identity-provider/instances/nje "$TMP/idp2.json"
    log "NJE IdP frissítve."
  elif [ "$HTTP" = 404 ]; then
    json POST /identity-provider/instances "$TMP/idp.json"
    log "NJE IdP létrehozva."
  else
    die "GET identity-provider/instances/nje → HTTP $HTTP"
  fi

  kc_ok GET /identity-provider/instances/nje/mappers
  cp "$TMP/body" "$TMP/mappers.json"
  n=$(jq length "$TPL/idp-nje-mappers.json"); i=0
  while [ "$i" -lt "$n" ]; do
    jq ".[$i]" "$TPL/idp-nje-mappers.json" > "$TMP/m.json"
    name=$(jq -r .name "$TMP/m.json")
    id=$(jq -r --arg n "$name" '[.[] | select(.name == $n)][0].id // empty' "$TMP/mappers.json")
    if [ -n "$id" ]; then
      jq --arg id "$id" '. + {id: $id}' "$TMP/m.json" > "$TMP/m2.json"
      json PUT "/identity-provider/instances/nje/mappers/$id" "$TMP/m2.json"
    else
      json POST /identity-provider/instances/nje/mappers "$TMP/m.json"
    fi
    i=$((i + 1))
  done
  log "NJE attribútum-mapperek: $n db rendben."
}

# ---- 2. Supabase Auth SAML-kliens ------------------------------------------
provision_client() {
  log "Supabase SP metadata: $SUPABASE_SP_METADATA_URL"
  code=$(curl -sS -o "$TMP/sp.xml" -w '%{http_code}' "$SUPABASE_SP_METADATA_URL") \
    || die "a Supabase Auth nem érhető el: $SUPABASE_SP_METADATA_URL"
  [ "$code" = 200 ] || die "a Supabase SP metadata HTTP $code. Be van kapcsolva a SAML (SAML_ENABLED=true, SAML_PRIVATE_KEY)?"
  grep -q 'EntityDescriptor' "$TMP/sp.xml" || die "a Supabase válasza nem SAML-metadata."

  kc_ok POST /client-description-converter -H 'Content-Type: text/plain' --data-binary "@$TMP/sp.xml"
  cp "$TMP/body" "$TMP/converted.json"
  client_id=$(jq -r '.clientId // empty' "$TMP/converted.json")
  [ -n "$client_id" ] || die "a Supabase metadatából nem olvasható ki az EntityID."
  jq -r '.attributes | to_entries[] | select(.key | startswith("saml_assertion_consumer_url_")) | .value' \
     "$TMP/converted.json" | grep . > "$TMP/acs.txt" || die "a Supabase metadatából nem olvasható ki az ACS."

  kc_ok GET /authentication/flows
  flow_id=$(jq -r '[.[] | select(.alias == "nje-browser")][0].id // empty' "$TMP/body")
  [ -n "$flow_id" ] || die "hiányzik az nje-browser flow — importálódott a realm (deploy/keycloak/realm)?"

  # A metadatából jövő értékek + a rögzített beállítások (a sablon nyer).
  jq --slurpfile t "$TPL/client-supabase.json" --rawfile acs "$TMP/acs.txt" --arg flow "$flow_id" '
      . * ($t[0] | del(.protocolMappers))
      | .redirectUris = ($acs | split("\n") | map(select(length > 0)) | unique)
      | .authenticationFlowBindingOverrides = {browser: $flow}
      | .protocolMappers = $t[0].protocolMappers' "$TMP/converted.json" > "$TMP/client.json"

  enc=$(jq -rn --arg v "$client_id" '$v | @uri')
  kc_ok GET "/clients?clientId=$enc&search=false"
  cid=$(jq -r '.[0].id // empty' "$TMP/body")
  if [ -n "$cid" ]; then
    jq --arg id "$cid" 'del(.protocolMappers, .defaultClientScopes, .optionalClientScopes) + {id: $id}' \
       "$TMP/client.json" > "$TMP/client2.json"
    json PUT "/clients/$cid" "$TMP/client2.json"
    log "Supabase SAML-kliens frissítve."
  else
    json POST /clients "$TMP/client.json"
    kc_ok GET "/clients?clientId=$enc&search=false"
    cid=$(jq -r '.[0].id' "$TMP/body")
    log "Supabase SAML-kliens létrehozva."
  fi

  # Protokoll-mapperek, név szerint.
  kc_ok GET "/clients/$cid/protocol-mappers/models"
  cp "$TMP/body" "$TMP/pm.json"
  n=$(jq '.protocolMappers | length' "$TPL/client-supabase.json"); i=0
  while [ "$i" -lt "$n" ]; do
    jq ".protocolMappers[$i]" "$TPL/client-supabase.json" > "$TMP/m.json"
    name=$(jq -r .name "$TMP/m.json")
    id=$(jq -r --arg n "$name" '[.[] | select(.name == $n)][0].id // empty' "$TMP/pm.json")
    if [ -n "$id" ]; then
      jq --arg id "$id" '. + {id: $id}' "$TMP/m.json" > "$TMP/m2.json"
      json PUT "/clients/$cid/protocol-mappers/models/$id" "$TMP/m2.json"
    else
      json POST "/clients/$cid/protocol-mappers/models" "$TMP/m.json"
    fi
    i=$((i + 1))
  done

  # Nincs alapértelmezett client scope (pl. role_list → "Role" attribútumok).
  for kind in default-client-scopes optional-client-scopes; do
    kc_ok GET "/clients/$cid/$kind"
    for sid in $(jq -r '.[].id' "$TMP/body"); do
      kc_ok DELETE "/clients/$cid/$kind/$sid"
    done
  done

  log "  EntityID (clientId): $client_id"
  while read -r a; do log "  ACS: $a"; done < "$TMP/acs.txt"
  log "Protokoll-mapperek: $n db rendben; NameID: persistent; aláírt válasz és assertion."
}

summary() {
  code=$(curl -sS -o "$TMP/idp-desc.xml" -w '%{http_code}' "$KC_URL/realms/$REALM/protocol/saml/descriptor") || code=000
  [ "$code" = 200 ] && grep -q 'X509Certificate' "$TMP/idp-desc.xml" \
    || die "a Keycloak IdP descriptor nem elérhető vagy nincs benne tanúsítvány (HTTP $code)."
  echo ""
  log "Kész. Fontos címek:"
  log "  Keycloak IdP metadata (a Supabase-nek):  $KEYCLOAK_PUBLIC_URL/realms/$REALM/protocol/saml/descriptor"
  log "  Keycloak SP metadata (az NJE IT-nak):    $KEYCLOAK_PUBLIC_URL/realms/$REALM/broker/nje/endpoint/descriptor"
  log "Következő lépés: docker compose run --rm keycloak-provision register-supabase"
}

# ---- 3. Supabase SSO provider (GoTrue admin API) ---------------------------
register_supabase() {
  replace=no; use_xml=no
  for a in "$@"; do
    case "$a" in
      --replace-existing) replace=yes ;;
      --metadata-xml) use_xml=yes ;;
      *) die "ismeretlen kapcsoló: $a" ;;
    esac
  done
  case "${SERVICE_ROLE_KEY:-}" in ""|*CHANGE_ME*) die "a SERVICE_ROLE_KEY nincs megadva." ;; esac
  printf 'Authorization: Bearer %s\n' "$SERVICE_ROLE_KEY" > "$TMP/sb.hdr"

  code=$(curl -sS -o "$TMP/idp-desc.xml" -w '%{http_code}' "$KC_URL/realms/$REALM/protocol/saml/descriptor") || code=000
  [ "$code" = 200 ] || die "a Keycloak IdP descriptor nem elérhető (HTTP $code). Fut a Keycloak, lefutott a provision?"
  kc_entity=$(grep -o 'entityID="[^"]*"' "$TMP/idp-desc.xml" | head -n1 | cut -d'"' -f2)
  [ -n "$kc_entity" ] || die "a Keycloak descriptorából nem olvasható ki az EntityID."
  md_url="$KEYCLOAK_PUBLIC_URL/realms/$REALM/protocol/saml/descriptor"

  jq -n --arg d "$SSO_DOMAIN" '{
      type: "saml",
      domains: [$d],
      name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      attribute_mapping: { keys: {
        email:                      { name: "email" },
        name:                       { name: "name" },
        eduPersonPrincipalName:     { name: "eduPersonPrincipalName" },
        displayName:                { name: "displayName" },
        mail:                       { name: "mail" },
        ou:                         { name: "ou", array: true },
        title:                      { name: "title" },
        physicalDeliveryOfficeName: { name: "physicalDeliveryOfficeName" },
        keycloak_user_id:           { name: "keycloak_user_id" }
      } } }' > "$TMP/base.json"
  if [ "$use_xml" = yes ]; then
    jq --rawfile x "$TMP/idp-desc.xml" '. + {metadata_xml: $x}' "$TMP/base.json" > "$TMP/prov.json"
  else
    case "$md_url" in https://*) ;; *) die "a GoTrue csak https:// metadata-URL-t fogad el ($md_url). Helyi próbán: --metadata-xml" ;; esac
    jq --arg u "$md_url" '. + {metadata_url: $u}' "$TMP/base.json" > "$TMP/prov.json"
  fi

  gt() { m=$1; p=$2; shift 2
    HTTP=$(curl -sS -o "$TMP/gbody" -w '%{http_code}' -X "$m" -H "@$TMP/sb.hdr" "$@" "$GOTRUE_URL$p") \
      || die "a Supabase Auth nem érhető el: $GOTRUE_URL"
    case "$HTTP" in 2*) ;; *) die "$m $p → HTTP $HTTP: $(head -c 500 "$TMP/gbody")" ;; esac
  }

  gt GET /admin/sso/providers
  jq --arg d "$SSO_DOMAIN" '[.items[]? | select(any(.domains[]?; .domain == $d))][0] // empty' \
     "$TMP/gbody" > "$TMP/existing.json"

  if [ -s "$TMP/existing.json" ]; then
    pid=$(jq -r .id "$TMP/existing.json")
    old_entity=$(jq -r '.saml.entity_id // ""' "$TMP/existing.json")
    if [ "$old_entity" = "$kc_entity" ]; then
      jq 'del(.type)' "$TMP/prov.json" > "$TMP/upd.json"
      gt PUT "/admin/sso/providers/$pid" -H 'Content-Type: application/json' --data-binary "@$TMP/upd.json"
      log "Supabase SSO provider frissítve: $pid ($SSO_DOMAIN → $kc_entity)"
      return
    fi
    if [ "$replace" != yes ]; then
      die "a(z) $SSO_DOMAIN domainhez már tartozik egy MÁSIK IdP: $pid ($old_entity).
       Lecserélése (a régi provider törlése): register-supabase --replace-existing"
    fi
    gt DELETE "/admin/sso/providers/$pid"
    log "A régi provider törölve: $pid ($old_entity)"
  fi

  gt POST /admin/sso/providers -H 'Content-Type: application/json' --data-binary "@$TMP/prov.json"
  log "Supabase SSO provider létrehozva: $(jq -r .id "$TMP/gbody") ($SSO_DOMAIN → $kc_entity)"
}

# ---- main ------------------------------------------------------------------
[ -n "$KEYCLOAK_PUBLIC_URL" ] || die "a KEYCLOAK_PUBLIC_URL nincs megadva."
cmd="${1:-provision}"; [ $# -gt 0 ] && shift
case "$cmd" in
  provision)
    get_token
    kc GET ""
    [ "$HTTP" = 200 ] || die "a \"$REALM\" realm nem létezik (HTTP $HTTP) — az első induláskor a deploy/keycloak/realm importálja."
    harden_realm
    provision_idp
    get_token   # a master realm tokenje rövid életű
    provision_client
    summary
    ;;
  register-supabase)
    register_supabase "$@"
    ;;
  *) die "ismeretlen parancs: $cmd (provision | register-supabase)" ;;
esac
