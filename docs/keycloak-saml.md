# NJE SSO — Keycloak SAML-közvetítő a Supabase Auth előtt

Ez a leírás az „NJE azonosítóval” bejelentkezés (SAML SSO) önálló szerveres beállításáról szól. A UniPortal továbbra is a Supabase Authot használja (munkamenet, JWT, felhasználók). Az NJE IdP és a Supabase közé egy **Keycloak** kerül, amely mindkét irányban SAML-t beszél.

## 1. Miért kell a Keycloak

A Supabase Auth (GoTrue) a SAML-válaszból egy **állandó** felhasználó-azonosítót vár: `persistent` NameID-t vagy `subject-id` attribútumot. Az NJE IdP metadatája szerint azonban csak `transient` NameID-t ad, ami minden belépéskor más. Így a közvetlen bekötés ezzel áll meg:

```
saml_assertion_no_user_id
```

Az NJE a stabil azonosítót az **eduPersonPrincipalName** (ePPN) attribútumban adja (OID `urn:oid:1.3.6.1.4.1.5923.1.1.1.6`, pl. `username@kefo.hu`). A Keycloak ez alapján azonosítja a felhasználót, a Supabase felé pedig aláírt választ ad **persistent NameID-vel**.

```text
Böngésző ── UniPortal (index.html / app.html)
                │  sb.auth.signInWithSSO({ domain: 'nje.hu' })
                ▼
        Supabase Auth / GoTrue          https://uniportal.nje.hu/auth/v1
                │  SAML 2.0 AuthnRequest (NameIDPolicy: persistent)
                ▼
        Keycloak, realm "uniportal"     https://uniportal.nje.hu/keycloak/
                │  SAML 2.0 AuthnRequest (NameIDPolicy: transient)
                ▼
        NJE IdP (SimpleSAMLphp)         https://idp.nje.hu/simplesaml/...
                │  aláírt assertion: ePPN, displayName, mail, ou, title, physicalDeliveryOfficeName
                ▼
        Keycloak: user = federated link (nje + ePPN) → persistent NameID a Supabase-nek
                ▼
        Supabase: auth.users + auth.identities (provider_id = NameID) → munkamenet, JWT
```

**Az azonosítás láncolata:**

| Szakasz | Azonosító | Tulajdonság |
|---|---|---|
| NJE → Keycloak | ePPN (a principal attribútum) | A Keycloak a *federated identity link*et (`nje` + ePPN) keresi. Ha ugyanaz a felhasználó újra belép, ugyanaz a Keycloak-user jön vissza. |
| Keycloak → Supabase | persistent NameID (`G-<uuid>`) | A Keycloak az első kiadáskor generálja, és a useren tárolja (`saml.persistent.name.id.for.<clientId>`). A user élettartama alatt **soha nem változik**, és nem az e-mailből vagy az ePPN-ből képződik. |
| Supabase | `auth.identities.provider_id` = a NameID | Ugyanaz a NameID ugyanazt az `auth.users` sort adja vissza. |

A Keycloak belső, módosíthatatlan user-UUID-ja a `keycloak_user_id` attribútumban is megy, naplózáshoz és egyeztetéshez. A NameID szándékosan nem maga ez az UUID. A Keycloak persistent NameID-je a szabványos, *kliensenként külön* (pairwise) azonosító. Az UUID-t NameID-ként csak saját Keycloak-bővítménnyel (SPI) lehetne kiadni. Stabilitásban nincs különbség: mindkettő a Keycloak-userhez kötött, és csak a user törlésekor veszik el.

## 2. A telepítés részei

| Fájl | Szerep |
|---|---|
| `deploy/compose.keycloak.yml` | Opcionális compose-réteg: `keycloak-db-init`, `keycloak`, `keycloak-provision`. |
| `deploy/keycloak/Dockerfile` | Keycloak 26.7.4, éles módban (`kc.sh build` + `start --optimized`). |
| `deploy/keycloak/db-init.sh` | Külön `keycloak` adatbázis és szerepkör a meglévő Postgresben (idempotens). |
| `deploy/keycloak/realm/uniportal-realm.json` | A `uniportal` realm: user profile, flow-k, biztonsági beállítások. Az első induláskor importálódik. |
| `deploy/keycloak/templates/*.json` | Az NJE IdP, a mapperek és a Supabase-kliens rögzített beállításai. |
| `deploy/keycloak/provision/provision.sh` | Beállító: NJE IdP, Supabase-kliens, Supabase provider. Idempotens. |
| `deploy/web/default.conf.template`, `keycloak-proxy.conf` | A `/keycloak/` továbbítása. Az admin konzol és a master realm kívülről elzárva. |

**Elérés:** `https://uniportal.nje.hu/keycloak/`. A Keycloak ugyanazon a címen fut, mint a felület, a `web` nginx mögött. Nem kell hozzá új DNS-név, tanúsítvány vagy módosítás a külső TLS-proxyn, és a meglévő valós-IP és sebességkorlát logika rá is vonatkozik.

**Adatbázis:** a Keycloak külön `keycloak` adatbázist használ ugyanabban a Postgresben (nem H2, és nem séma a `postgres` DB-ben). A PostgREST, a migrációk és a `reset-data.sh` nem látják. A `deploy/backup.sh` a teljes adatkönyvtárat menti, így ezt is, a `restore.sh` pedig ezt is visszaállítja.

**Portok:**

| Port | Mi | Honnan |
|---|---|---|
| `8080` (web) → `/keycloak/` | a uniportal realm (SAML-végpontok, NJE-visszatérés) | kívülről, a TLS-proxyn át |
| `127.0.0.1:8180` | Keycloak admin konzol | **csak a szerverről** (SSH-alagút) |
| `9000` | Keycloak health/management | csak a belső Docker-hálózaton |

## 3. Környezeti változók (`.env`)

Új telepítésnél az `./init-env.sh` generálja a titkokat. Meglévő `.env`-be kézzel kell felvenni a sorokat (lásd a 4. pontot).

| Változó | Példa / alapérték | Megjegyzés |
|---|---|---|
| `COMPOSE_FILE` | `docker-compose.yml:deploy/compose.uniportal.yml:deploy/compose.keycloak.yml` | A Keycloak-réteg bekapcsolása. |
| `SAML_ENABLED` | `true` | A Supabase Auth SAML-je. |
| `SAML_PRIVATE_KEY` | base64(DER, **PKCS#1** RSA) | **Titok.** A Supabase SP aláíró kulcsa. |
| `SAML_EXTERNAL_URL` | üres | Üresen az `API_EXTERNAL_URL` (`https://uniportal.nje.hu/auth/v1`). Ebből képződik az SP EntityID és az ACS. |
| `KEYCLOAK_PUBLIC_URL` | `https://uniportal.nje.hu/keycloak` | A Keycloak nyilvános címe (`KC_HOSTNAME`). |
| `KEYCLOAK_ADMIN_PORT` | `8180` | Az admin konzol portja, csak a `127.0.0.1` címen. |
| `KEYCLOAK_ADMIN_USER` | `kcadmin` | Az első induláskor létrejövő admin. |
| `KEYCLOAK_ADMIN_PASSWORD` | `openssl rand -hex 24` | **Titok.** |
| `KEYCLOAK_DB_PASSWORD` | `openssl rand -hex 24` | **Titok.** A `keycloak` DB-szerepkör jelszava. |
| `KEYCLOAK_PROXY_TRUSTED_ADDRESSES` | üres → `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Ezektől fogad el X-Forwarded-* fejlécet (a belső Docker-hálózat, ahonnan a web továbbít). |
| `NJE_IDP_METADATA_URL` | `https://idp.nje.hu/simplesaml/saml2/idp/metadata.php` | |
| `SUPABASE_SP_METADATA_URL` | üres → `http://auth:9999/sso/saml/metadata` | A futó Supabase Auth metadatája, belső hálózaton. |
| `SSO_DOMAIN` | `nje.hu` | Egyeznie kell a frontend `signInWithSSO({ domain })` értékével. |
| `UNIPORTAL_RL_KEYCLOAK`, `_BURST` | üres → `300r/m`, `100` | A `/keycloak/` sebességkorlátja, IP szerint. |

SAML-kulcs kézi előállítása (OpenSSL 3; 1.1-en `-traditional` nélkül):

```sh
openssl genrsa 2048 | openssl rsa -traditional -outform DER | base64 -w0
```

> A `.env` titkai nem kerülhetnek gitbe, és ne küldd el őket e-mailben vagy chatben. A realm aláíró kulcsai a Keycloak adatbázisában keletkeznek, nem a tárolóban. Realm-exportot (`kc.sh export`) csak a gitignore-olt `deploy/keycloak/export/` könyvtárba készíts: az export a privát kulcsokat is tartalmazza.

## 4. Telepítés

### 4.1 Meglévő szerveren (uniportal.nje.hu)

```sh
cd /opt/UniPortal
sudo ./deploy/backup.sh
git pull
```

Egészítsd ki a `.env`-et. A titkokat a szerveren generáld, és ne írd ki a képernyőre:

```sh
# a Keycloak-réteg bekapcsolása
sed -i 's|^COMPOSE_FILE=.*|COMPOSE_FILE=docker-compose.yml:deploy/compose.uniportal.yml:deploy/compose.keycloak.yml|' .env

cat >> .env <<EOF

# ---- NJE SSO — Keycloak (docs/keycloak-saml.md) ----
KEYCLOAK_PUBLIC_URL=https://uniportal.nje.hu/keycloak
KEYCLOAK_ADMIN_PORT=8180
KEYCLOAK_ADMIN_USER=kcadmin
KEYCLOAK_ADMIN_PASSWORD=$(openssl rand -hex 24)
KEYCLOAK_DB_PASSWORD=$(openssl rand -hex 24)
KEYCLOAK_PROXY_TRUSTED_ADDRESSES=
NJE_IDP_METADATA_URL=https://idp.nje.hu/simplesaml/saml2/idp/metadata.php
SUPABASE_SP_METADATA_URL=
SSO_DOMAIN=nje.hu
UNIPORTAL_RL_KEYCLOAK=
UNIPORTAL_RL_KEYCLOAK_BURST=
EOF
chmod 600 .env
```

A SAML-sorok (`SAML_ENABLED=true`, `SAML_PRIVATE_KEY=…`) a közvetlen NJE-bekötéshez már bekerültek a `.env`-be. **Ne generálj új kulcsot**, a meglévő maradhat. Ellenőrzés (csak a hossz látszik, a kulcs nem):

```sh
grep -E '^SAML_(ENABLED|EXTERNAL_URL)=' .env
grep '^SAML_PRIVATE_KEY=' .env | awk '{ print "SAML_PRIVATE_KEY hossza:", length($0) - 17 }'
```

Indítás:

```sh
docker compose up -d --build
docker compose ps keycloak keycloak-db-init web auth
docker compose logs keycloak-db-init        # "kész: adatbázis "keycloak" …"
docker compose logs keycloak | grep -iE "import|started|error"
```

Akkor van rendben, ha a `keycloak` állapota `running (healthy)` (az első indulás 1–2 perc), a `keycloak-db-init` pedig `exited (0)`. A `web` új képet kap (a `/keycloak/` útvonal miatt), ezért kell a `--build`.

### 4.2 Új telepítésnél

Az `./init-env.sh` már kitölti a `KEYCLOAK_*` titkokat és a `SAML_PRIVATE_KEY`-t. Utána csak a `COMPOSE_FILE` sort kell a fenti értékre állítani, és beírni: `SAML_ENABLED=true`.

## 5. Első admin-belépés

Az admin konzol kívülről **nem** érhető el: a web nginx a `/keycloak/admin/` és a `/keycloak/realms/master/` útvonalon 404-et ad. Belépés SSH-alagúton át:

```sh
ssh -L 8180:127.0.0.1:8180 <szerver>
# böngészőben: http://127.0.0.1:8180/keycloak/admin/
```

- Felhasználó: `KEYCLOAK_ADMIN_USER`, jelszó: `KEYCLOAK_ADMIN_PASSWORD` a `.env`-ből.
- A bootstrap admint a Keycloak ideiglenesnek jelöli (sárga sáv). Ajánlott lépés: *master realm → Users → Add user* egy névre szóló adminnak, majd *Role mapping → Assign role → `admin`*. Ha ezután a bootstrap admint törlöd, **írd át a `.env` `KEYCLOAK_ADMIN_USER/PASSWORD` sorát** egy olyan admin adataira, akivel a `keycloak-provision` beléphet.
- Ha a jelszót az admin felületen cseréled, a `.env`-ben is cseréld: a `.env` csak az **első** induláskor hozza létre az admint, később nem írja felül.

## 6. A `uniportal` realm

A `deploy/keycloak/realm/uniportal-realm.json` az első induláskor importálódik (`--import-realm`). Ha a realm már létezik, a Keycloak **nem** írja felül: a fájl későbbi módosításait az Admin Console-ban vagy a 12. pont szerint kell átvezetni.

Ami a realmben be van állítva:

| Beállítás | Érték | Miért |
|---|---|---|
| Require SSL | external requests | |
| User registration, Forgot password, Remember me | ki | Felhasználó csak az NJE-n át jöhet létre. |
| Login with email | ki; **Duplicate emails: be** | A felhasználót az ePPN azonosítja. Két NJE-fiók közös e-mail-címe se vonja össze őket. |
| Edit username | ki | |
| Brute force detection | be | |
| Events / Admin events | be (30 nap) | Belépési napló a hibaelhárításhoz. |
| Default roles | `offline_access`, `uma_authorization`, `account/view-profile` | **`manage-account` nincs benne**: a felhasználók az Account Console-ban nem írhatják át az adataikat. Az import ezt a jogot magától visszarakja, ezért a `keycloak-provision` minden futáskor kiveszi. Kézzel: *Realm settings → User registration → Default roles → `manage-account` → Unassign*. |
| User profile | `eduPersonPrincipalName`, `displayName`, `mail`, `ou` (többértékű), `title`, `physicalDeliveryOfficeName` az „NJE” csoportban; firstName/lastName nem kötelező; unmanaged attributes: *admin can view* | Az NJE-attribútumok tárolása. A nem kötelező név miatt nincs „Update profile” oldal. Az unmanaged beállítás a persistent NameID tárolt attribútuma miatt kell. |
| Flow `nje-browser` | Cookie (ALTERNATIVE) + Identity Provider Redirector → `nje` (ALTERNATIVE) | A Supabase-ből érkező felhasználó azonnal az NJE-re megy, Keycloak-loginoldal nélkül. |
| Flow `nje-first-broker-login` | Create User If Unique (REQUIRED) | Első NJE-belépéskor új user jön létre. **Nincs** e-mail alapú automatikus összekapcsolás. Ütközéskor hibára fut, nem kapcsol össze. |

## 7. Az NJE Identity Provider

A `keycloak-provision` állítja be (8. pont). Az Admin Console-ban így ellenőrizhető, vagy szükség esetén kézzel beállítható:

**uniportal realm → Identity providers → Add provider → SAML v2.0** (létező esetén: **nje**)

| Mező | Érték |
|---|---|
| Alias | `nje` |
| Display name | `NJE` |
| Service provider entity ID | `https://uniportal.nje.hu/keycloak/realms/uniportal` (alapérték) |
| Use entity descriptor / SAML entity descriptor | `https://idp.nje.hu/simplesaml/saml2/idp/metadata.php` → ebből töltődik az SSO-cím és a tanúsítvány |
| Identity provider entity ID | `https://idp.nje.hu/simplesaml/saml2/idp/metadata.php` |
| Single Sign-On service URL | `https://idp.nje.hu/simplesaml/module.php/saml/idp/singleSignOnService` (a metadatából) |
| NameID policy format | **Transient** (az NJE csak ezt hirdeti) |
| **Principal type** | **Attribute [Name]** |
| **Principal attribute** | **`urn:oid:1.3.6.1.4.1.5923.1.1.1.6`** |
| Allow create | be |
| HTTP-POST binding response | be |
| HTTP-POST binding for AuthnRequest | ki (az NJE csak HTTP-Redirectet fogad) |
| Want AuthnRequests signed | be (RSA_SHA256) |
| Want Assertions signed | **be** |
| Validate signatures | **be**. A tanúsítvány az NJE metadatájából jön. |
| Allowed clock skew | 30 |
| Trust email | be |
| First login flow override | `nje-first-broker-login` |
| Sync mode | **Force**: minden belépéskor frissíti az attribútumokat |
| Store tokens | ki |

**Mapperek** (*Identity providers → nje → Mappers*). Mindegyik típusa *Attribute Importer*, a Name format *URI_REFERENCE*, a Sync mode *Inherit*:

| Név | Attribute Name | User Attribute Name |
|---|---|---|
| `nje-eppn` | `urn:oid:1.3.6.1.4.1.5923.1.1.1.6` | `eduPersonPrincipalName` |
| `nje-displayName` | `urn:oid:2.16.840.1.113730.3.1.241` | `displayName` |
| `nje-mail-to-email` | `urn:oid:0.9.2342.19200300.100.1.3` | `email` (a Keycloak e-mail mezője) |
| `nje-mail` | `urn:oid:0.9.2342.19200300.100.1.3` | `mail` |
| `nje-ou` | `urn:oid:2.5.4.11` | `ou` |
| `nje-title` | `urn:oid:2.5.4.12` | `title` |
| `nje-physicalDeliveryOfficeName` | `urn:oid:2.5.4.19` | `physicalDeliveryOfficeName` |

A `mail` így kétszer kerül be: a Keycloak **e-mail mezőjébe** (a *Trust email* miatt ellenőrzöttként) és a `mail` attribútumba. Az e-mail csak adat: a felhasználó azonosítása az ePPN-en, a Supabase felé a NameID-n múlik.

### Teendők az NJE IT felé (külső előfeltétel)

A Keycloak **új Service Provider** az NJE IdP számára. Az NJE IT-nak:

1. Regisztrálja az SP metadatáját: `https://uniportal.nje.hu/keycloak/realms/uniportal/broker/nje/endpoint/descriptor`
   - EntityID: `https://uniportal.nje.hu/keycloak/realms/uniportal`
   - ACS (HTTP-POST): `https://uniportal.nje.hu/keycloak/realms/uniportal/broker/nje/endpoint`
2. Engedje ki ennek az SP-nek az attribútumokat: `eduPersonPrincipalName`, `displayName`, `mail`, `ou`, `title`, `physicalDeliveryOfficeName`, URI (OID) névformában.
3. A régi, közvetlen Supabase SP (`https://uniportal.nje.hu/auth/v1/sso/saml/metadata`) bejegyzése az átállás után törölhető.

## 8. Beállítás a `keycloak-provision`-nel

```sh
docker compose run --rm keycloak-provision
```

Idempotens, bármikor újrafuttatható, például ha az NJE tanúsítványt cserél. Ezt csinálja:

1. **NJE IdP:** a metadatát a Keycloak maga tölti le (`identity-provider/import-config`). Erre kerülnek a `templates/idp-nje.json` rögzített beállításai (principal = ePPN, aláírás-ellenőrzés), majd név szerint összehangolja a mappereket.
2. **Supabase SAML-kliens:** letölti a **futó** Supabase Auth metadatáját (`http://auth:9999/sso/saml/metadata`). A Keycloak `client-description-converter`-e kiolvassa belőle az EntityID-t (ez lesz a clientId), az ACS-t és az SP-tanúsítványt. Erre kerülnek a `templates/client-supabase.json` beállításai. Az EntityID és az ACS **nincs beégetve**.
3. A realm alapszerepköréből kiveszi az `account/manage-account` jogot (6. pont).
4. Kiírja a Supabase-nek szóló és az NJE IT-nak szóló metadata-címet.

A kimenet vége:

```
[keycloak-provision]   EntityID (clientId): https://uniportal.nje.hu/auth/v1/sso/saml/metadata
[keycloak-provision]   ACS: https://uniportal.nje.hu/auth/v1/sso/saml/acs
[keycloak-provision]   Keycloak IdP metadata (a Supabase-nek):  https://uniportal.nje.hu/keycloak/realms/uniportal/protocol/saml/descriptor
[keycloak-provision]   Keycloak SP metadata (az NJE IT-nak):    https://uniportal.nje.hu/keycloak/realms/uniportal/broker/nje/endpoint/descriptor
```

### A Supabase SAML-kliens (ellenőrzéshez vagy kézi beállításhoz)

**uniportal realm → Clients → `https://uniportal.nje.hu/auth/v1/sso/saml/metadata`**. Kézzel: *Clients → Import client*, és a Supabase SP metadata XML-jének feltöltése.

| Fül → mező | Érték |
|---|---|
| Settings → Client ID | a Supabase SP EntityID-ja (a metadatából) |
| Settings → Valid redirect URIs | a Supabase ACS (a metadatából) |
| Settings → Name ID format | **persistent** |
| Settings → Force name ID format | **be** |
| Settings → Force POST binding | be |
| Settings → Include AuthnStatement | be |
| Settings → Sign documents | **be** |
| Settings → Sign assertions | **be** |
| Settings → Signature algorithm | RSA_SHA256 |
| Settings → Canonicalization method | EXCLUSIVE |
| Keys → Encrypt assertions | ki (a Supabase `SAML_ALLOW_ENCRYPTED_ASSERTIONS=false`) |
| Keys → Client signature required | a Supabase metadatája szerint (a converter állítja) |
| Advanced → Assertion Consumer Service POST Binding URL | a Supabase ACS |
| Advanced → Authentication flow overrides → Browser flow | `nje-browser` |
| Client scopes | nincs hozzárendelt scope (nincs `role_list`) |
| Dedicated scope → Full scope allowed | ki |

**Mapperek** (*Client scopes → …-dedicated → Mappers*), mind *Basic* névformával:

| Név (SAML Attribute Name) | Típus | Forrás |
|---|---|---|
| `email` | User Property | `email` |
| `name` | User Attribute | `displayName` (a UniPortal-profil neve) |
| `eduPersonPrincipalName` | User Attribute | `eduPersonPrincipalName` |
| `displayName` | User Attribute | `displayName` |
| `mail` | User Attribute | `mail` |
| `ou` | User Attribute (Aggregate attribute values: be) | `ou` |
| `title` | User Attribute | `title` |
| `physicalDeliveryOfficeName` | User Attribute | `physicalDeliveryOfficeName` |
| `keycloak_user_id` | User Property | `id` (a Keycloak belső UUID-ja) |

## 9. Supabase provider regisztráció

A Supabase a Keycloakot a GoTrue admin API-ján át ismeri meg. A frontend `signInWithSSO({ domain: 'nje.hu' })` hívása a domain alapján találja meg a providert.

```sh
docker compose run --rm keycloak-provision register-supabase
```

- Ha a `nje.hu` domainhez még **nincs** provider, létrehozza.
- Ha már a Keycloakra mutat, frissíti (attribute mapping, NameID-formátum).
- Ha **másik** IdP-re mutat (a régi, közvetlen NJE-bekötésre), megáll. Az átállás:
  ```sh
  docker compose run --rm keycloak-provision register-supabase --replace-existing
  ```
  Ez törli a régi providert, és létrehozza az újat. **Ez az átállás pillanata.** A régi providerhez tartozó (egyébként a hiba miatt létre sem jött) SSO-identitások ezzel megszűnnek.
- Ha a GoTrue konténer nem éri el a publikus HTTPS-címet (hairpin NAT), használd a `--metadata-xml` kapcsolót. Ekkor a Keycloak metadatája beágyazva kerül a providerbe. Figyelem: így a Keycloak kulcscseréje után a regisztrációt újra kell futtatni.

A nyers API-hívás, ugyanez kézzel, a szerveren:

```sh
set -a; . ./.env; set +a      # a SERVICE_ROLE_KEY a .env-ből — ne másold parancssorba, ne naplózd

# a meglévő providerek
curl -s http://127.0.0.1:8000/auth/v1/admin/sso/providers \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" | jq '.items[] | {id, entity: .saml.entity_id, domains}'

# a régi (közvetlen NJE) provider törlése — CSAK az átálláskor
curl -s -X DELETE http://127.0.0.1:8000/auth/v1/admin/sso/providers/<RÉGI-ID> \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY"

# az új provider: a Keycloak
curl -s -X POST http://127.0.0.1:8000/auth/v1/admin/sso/providers \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{
    "type": "saml",
    "metadata_url": "https://uniportal.nje.hu/keycloak/realms/uniportal/protocol/saml/descriptor",
    "domains": ["nje.hu"],
    "name_id_format": "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    "attribute_mapping": { "keys": {
      "email":                      { "name": "email" },
      "name":                       { "name": "name" },
      "eduPersonPrincipalName":     { "name": "eduPersonPrincipalName" },
      "displayName":                { "name": "displayName" },
      "mail":                       { "name": "mail" },
      "ou":                         { "name": "ou", "array": true },
      "title":                      { "name": "title" },
      "physicalDeliveryOfficeName": { "name": "physicalDeliveryOfficeName" },
      "keycloak_user_id":           { "name": "keycloak_user_id" }
    } }
  }'
```

A leképezésben szándékosan **nincs `role` kulcs**. A `handle_new_user` trigger a `raw_user_meta_data.role`-ból kérné a szerepkört (a 68-as migráció STUDENT/AGENT-re szorítja). Az NJE-felhasználó így STUDENT/pending profillal jön létre, és a jogokat a rendszergazda adja meg, ugyanúgy, mint a jelszavas regisztrációnál. A `name` a profil neve lesz.

## 10. Metadata-címek

| Mi | Cím |
|---|---|
| NJE IdP metadata | `https://idp.nje.hu/simplesaml/saml2/idp/metadata.php` |
| Keycloak SP metadata (az NJE-nek) | `https://uniportal.nje.hu/keycloak/realms/uniportal/broker/nje/endpoint/descriptor` |
| Keycloak NJE ACS | `https://uniportal.nje.hu/keycloak/realms/uniportal/broker/nje/endpoint` |
| Keycloak IdP metadata (a Supabase-nek) | `https://uniportal.nje.hu/keycloak/realms/uniportal/protocol/saml/descriptor` |
| Keycloak IdP EntityID | `https://uniportal.nje.hu/keycloak/realms/uniportal` |
| Supabase SP metadata | `https://uniportal.nje.hu/auth/v1/sso/saml/metadata` |
| Supabase ACS | `https://uniportal.nje.hu/auth/v1/sso/saml/acs` |

## 11. Tesztelés

**0. Előfeltétel-ellenőrzés a szerveren**

```sh
docker compose ps keycloak                               # healthy
curl -s https://uniportal.nje.hu/keycloak/realms/uniportal/protocol/saml/descriptor | grep -c X509Certificate   # ≥ 1
curl -s -o /dev/null -w '%{http_code}\n' https://uniportal.nje.hu/keycloak/admin/                             # 404
curl -s -o /dev/null -w '%{http_code}\n' https://uniportal.nje.hu/keycloak/realms/master/                     # 404
curl -s https://uniportal.nje.hu/auth/v1/sso/saml/metadata | grep -o 'entityID="[^"]*"'
ss -ltnp | grep -E ':8180|:9000'                         # csak 127.0.0.1:8180
```

**1. A Keycloak–NJE szakasz önmagában** (a Supabase-provider cseréje előtt; az NJE IT regisztrációja kell hozzá):

1. Privát böngészőablakban: `https://uniportal.nje.hu/keycloak/realms/uniportal/account/` → *NJE* → NJE-belépés.
2. Admin Console → *uniportal → Users*: a username az ePPN kisbetűsen. Az *Attributes* fülön kitöltve: `eduPersonPrincipalName`, `displayName`, `mail`, `ou`, `title`, `physicalDeliveryOfficeName`; az *Email* mező kitöltve, ellenőrzöttként. Az *Identity provider links* fülön: `nje` az ePPN-nel.
3. Kijelentkezés, újra belépés: a *Users* listában **ugyanaz az egy** user marad.

**2. Átállás:** `docker compose run --rm keycloak-provision register-supabase --replace-existing`

**3. A teljes lánc**, a várt folyamat:

1. A felhasználó megnyitja a UniPortalt.
2. „Sign in with NJE ID” → `signInWithSSO` → a Supabase `/auth/v1/sso`.
3. Supabase → Keycloak (`…/protocol/saml`, AuthnRequest, NameIDPolicy persistent).
4. Keycloak → NJE IdP (`nje-browser` flow, azonnali átirányítás).
5. Belépés NJE-azonosítóval.
6. NJE → Keycloak SAML Response (`…/broker/nje/endpoint`).
7. A Keycloak az ePPN alapján azonosítja a usert (federated link).
8. Keycloak → Supabase aláírt SAML Response (`/auth/v1/sso/saml/acs`).
9. A Supabase a persistent NameID alapján azonosítja a usert.
10. Létrejön a munkamenet és a JWT.
11. A felhasználó visszakerül a UniPortalba (`app.html`).

**4. Ellenőrzés az adatbázisban** (Studio SQL-szerkesztő, vagy `docker compose exec db psql -U postgres`):

```sql
select u.id, u.email, u.is_sso_user, i.provider, i.provider_id,
       i.identity_data->'custom_claims'->>'eduPersonPrincipalName' as eppn,
       u.raw_user_meta_data->>'name' as name, u.created_at, u.last_sign_in_at
  from auth.users u join auth.identities i on i.user_id = u.id
 where u.is_sso_user
 order by u.created_at desc limit 20;

select id, email, name, role, approval_status from public.profiles
 where id in (select id from auth.users where is_sso_user);
```

Várt eredmény: `provider = 'sso:<provider-uuid>'`, `provider_id = 'G-…'` (a NameID). Az attribútumok az `identity_data`-ban látszanak, a GoTrue-verziótól függően közvetlenül vagy a `custom_claims` alatt. A profil `pending`, amíg egy rendszergazda jóvá nem hagyja.

**5. Ismételt belépés:** kijelentkezés után lépj be újra ugyanazzal az NJE-fiókkal. A fenti lekérdezés **ugyanazt az `auth.users.id`-t** adja, a `last_sign_in_at` frissül, és nincs új sor. A Keycloakban továbbra is egy user van.

**6. Második felhasználó:** egy másik NJE-fiók új `auth.users` sort és más `provider_id`-t kap.

## 12. Módosítás és karbantartás

- **NJE-tanúsítványcsere:** `docker compose run --rm keycloak-provision` (a metadatát újra letölti).
- **A Supabase SAML-kulcsának cseréje** (`SAML_PRIVATE_KEY`): `docker compose up -d auth`, majd `docker compose run --rm keycloak-provision` (a kliens az új SP-tanúsítványt kapja).
- **A realm JSON változott:** létező realmet az import nem ír felül. Vezesd át az Admin Console-ban. Teljes újraimport csak üres realmre való: *Realm settings → Action → Delete*, majd `docker compose restart keycloak` és `keycloak-provision`. Ez **minden Keycloak-usert töröl**; a törölt user újra belépve új NameID-t, így a Supabase-ben is új usert kap.
- **Keycloak-frissítés:** emeld a verziót a `deploy/keycloak/Dockerfile`-ban és a `deploy/compose.keycloak.yml` `image:` sorában, a Keycloak migration guide-ja szerint. Előtte készíts mentést. Utána: `docker compose up -d --build keycloak`.
- **Keycloak-user törlése:** a törölt user következő belépésekor új Keycloak-user és **új NameID** keletkezik, vagyis a Supabase-ben új felhasználó. Ne törölj usert, ha a UniPortal-fiókját meg kell tartani.
- **Kijelentkezés:** a UniPortal kijelentkezése csak a Supabase-munkamenetet zárja le. A Keycloak- és az NJE-munkamenet él tovább, így a következő „Sign in with NJE ID” jelszó nélkül visszaléptet (SSO). Közös gépen a böngésző bezárása kell.
- **A vendorolt Envoy SLO-útvonala** (`/auth/v1/sso/saml/slo`) a `deploy/supabase/volumes/api/envoy/lds.template.yaml`-ban van, amit a `deploy/vendor-supabase.sh` felülír. Supabase-frissítés után vezesd át újra, ha kell.

## 13. Hibaelhárítás

Napló és események:

```sh
docker compose logs --tail=200 keycloak
docker compose logs --tail=200 auth | grep -iE 'saml|sso'
```

Admin Console → *uniportal → Events → User events*: `IDENTITY_PROVIDER_LOGIN_ERROR`, `LOGIN_ERROR` és hasonlók, az okkal. A SAML-üzeneteket a böngésző fejlesztői eszközeivel lehet elkapni (*Network → Preserve log*, a POST törzsében a `SAMLResponse` base64-ben), vagy SAML-tracer bővítménnyel.

### `saml_assertion_no_user_id`
A Supabase nem talált állandó azonosítót az assertionben.
- A Supabase-provider még a régi, közvetlen NJE-bekötésre mutat → `register-supabase --replace-existing`. Ellenőrzés: a 9. pont `jq` listája, az `entity` a Keycloak legyen.
- A Keycloak-kliensben nem `persistent` a Name ID format, vagy nincs bekapcsolva a *Force name ID format* → `keycloak-provision`.
- SAML-tracerben a Keycloak válaszában a `<saml:NameID Format="…:persistent">G-…</saml:NameID>` sornak kell látszania.

### invalid NameID / `InvalidNameIDPolicy`
- **NJE → Keycloak:** az NJE csak `transient`-et ad. Ha a Keycloak IdP NameID policy-ja nem *Transient*, az NJE `InvalidNameIDPolicy` státusszal utasít el → `keycloak-provision`, vagy kézzel: *Identity providers → nje → NameID policy format: Transient*. Ha az NJE így is elutasít, próbáld az *Unspecified* értéket.
- **Supabase → Keycloak:** a provider `name_id_format` értéke `persistent`, a Keycloak-kliensben pedig *Force name ID format: be* legyen.

### invalid signature
- **Keycloak ← NJE** (a Keycloak-naplóban `Invalid signature` / `IDENTITY_PROVIDER_LOGIN_ERROR`): az NJE tanúsítványt cserélt → `keycloak-provision` (újraolvassa a metadatát). Az aláírás-ellenőrzést **ne kapcsold ki**.
- **Supabase ← Keycloak** (az auth-naplóban `signature` hiba): a Keycloak realm-kulcsa megváltozott (*Realm settings → Keys*), de a Supabase a régi metadatát őrzi. `--metadata-xml` regisztrációnál ez biztos, ilyenkor futtasd újra a `register-supabase`-t. `metadata_url` esetén a GoTrue idővel frissít, de a `register-supabase` azonnal frissíti.
- A Keycloak-kliensben a *Sign documents* és a *Sign assertions* is legyen bekapcsolva.

### ACS mismatch (`Invalid redirect uri` / `invalid_redirect_uri` a Keycloakban)
A Supabase AuthnRequestjének `AssertionConsumerServiceURL`-je nem szerepel a kliens *Valid redirect URIs* listájában. Ennek oka szinte mindig egy megváltozott `API_EXTERNAL_URL` vagy `SAML_EXTERNAL_URL`. Ellenőrzés: `curl -s https://uniportal.nje.hu/auth/v1/sso/saml/metadata | grep -o 'Location="[^"]*acs"'`, majd `keycloak-provision`.

### EntityID mismatch
- **Keycloak: `Client not found` / `Invalid requester`:** a Supabase EntityID-ja (`…/auth/v1/sso/saml/metadata`) nem egyezik a Keycloak-kliens Client ID-jával. Ez az `API_EXTERNAL_URL`/`SAML_EXTERNAL_URL` változása után fordul elő → `keycloak-provision` (új klienst hoz létre az új EntityID-val; a régi kézzel törölhető).
- **Supabase: audience/issuer hiba:** a Keycloak IdP EntityID-ja a `KEYCLOAK_PUBLIC_URL`-ből képződik. Ha a cím megváltozott, a Supabase-providert újra kell regisztrálni (`register-supabase --replace-existing`), mert az EntityID nem módosítható helyben.
- **NJE: `Unknown SP` / `metadata not found`:** az NJE IdP nem ismeri a Keycloak SP-t (7. pont, teendők az NJE IT felé).

### redirect loop
- **`KEYCLOAK_PUBLIC_URL` / proxy:** http-t ad https helyett, vagy a külső proxy nem küld `X-Forwarded-Proto: https`-t. A Keycloak ilyenkor rossz címre irányít, vagy a sütik nem maradnak meg. Ellenőrzés: a `…/protocol/saml/descriptor` minden `Location` értéke `https://uniportal.nje.hu/keycloak/…` legyen.
- **Hosszú óraeltérés** (a SAML-időablak lejár, és a folyamat újraindul): `timedatectl` – az NTP legyen szinkronban a szerveren.
- **Supabase `redirectTo`:** az `app.html` címének az `ADDITIONAL_REDIRECT_URLS`-ben kell lennie (`https://uniportal.nje.hu/**`). Különben a GoTrue a `SITE_URL`-re küld vissza.
- **Harmadik féltől származó sütik tiltása:** a Keycloak saját domainen (azonos originen) fut, így ez nem érinti. Ha mégis előjön, töröld az `uniportal.nje.hu` sütijeit.

### attribute mapping failure
A Keycloak-userből vagy a Supabase `identity_data`-ból hiányzik egy attribútum.
1. **Az NJE nem küldi:** SAML-tracerben az NJE → Keycloak válaszban nincs benne az adott OID → az NJE IT-nak kell kiengednie (7. pont).
2. **Más névformában küldi** (pl. friendly name `eduPersonPrincipalName` az OID helyett): *Identity providers → nje → Mappers* → az *Attribute Name* a ténylegesen küldött név legyen, a *Name Format* pedig ahhoz illő.
3. **A Keycloak nem tárolja:** a User profile-ban kell lennie az attribútumnak (*Realm settings → User profile*).
4. **Nem jut el a Supabase-ig:** a kliens-mapper *SAML Attribute Name* értékének egyeznie kell a Supabase `attribute_mapping` `name` mezőjével (kis- és nagybetűre is).
5. **`saml_assertion_no_email`:** az NJE nem küldte a `mail` attribútumot, így a Keycloak-usernek nincs e-mail-címe, a Supabase pedig e-mail nélkül nem hoz létre felhasználót → 1. pont.

### user duplicated in Keycloak
- **A principal nem az ePPN:** *Identity providers → nje*: *Principal type* = *Attribute [Name]*, *Principal attribute* = `urn:oid:1.3.6.1.4.1.5923.1.1.1.6`. Ha ez *Subject NameID*, minden belépés új usert hozna (transient NameID).
- **Kézzel törölt user:** a következő belépés új usert (és új NameID-t) hoz létre, lásd a 12. pontot.
- **Két user ugyanahhoz az NJE-fiókhoz:** a `nje-first-broker-login` szándékosan **nem** kapcsol össze automatikusan (ütközéskor hibát ad). Előbb nézd meg, melyik Keycloak-userhez tartozik már Supabase-felhasználó: a user *Attributes* fülén a `saml.persistent.name.id.for.…` értéket vesd össze az `auth.identities.provider_id` oszloppal. A **másik**, Supabase-kapcsolat nélküli usert töröld (*Users → … → Delete*). A megmaradó user *Identity provider links* fülén az `nje` link az ePPN-nel legyen.
- **Duplikált Supabase-user ugyanazzal az e-mail-címmel:** ez **nem hiba**. Az SSO-fiók (`is_sso_user = true`) a GoTrue-ban mindig külön user, akkor is, ha az adott címmel már van jelszavas UniPortal-fiók. A régi fiók adatait szükség esetén a rendszergazdának kell átvezetnie.

### Supabase SSO provider not found (`sso_provider_not_found` / „No SSO provider assigned for this domain”)
- A `signInWithSSO({ domain: 'nje.hu' })` domainjéhez nincs provider → `register-supabase`. Ellenőrzés: a 9. pont listájában a `domains` között legyen `nje.hu`.
- A `SAML_ENABLED` nem `true`, vagy a `SAML_PRIVATE_KEY` hibás (az auth-napló induláskor jelzi). A kulcsnak **PKCS#1** DER-nek kell lennie; egy OpenSSL 3-mal `-traditional` nélkül készült PKCS#8-kulcs nem jó.
- A `register-supabase` hibája `metadata_url`-lel: a GoTrue nem érte el a publikus címet (hairpin) → `--metadata-xml`.

### Egyéb
- **429 a `/keycloak/` alatt:** közös NAT mögött emeld az `UNIPORTAL_RL_KEYCLOAK` értékét. A GoTrue saját SSO-korlátja (`over_request_rate_limit` a `/auth/v1/sso`-n) szintén IP szerinti.
- **`keycloak-db-init` → exited (1):** `docker compose logs keycloak-db-init`. Tipikusan a `.env` `KEYCLOAK_*` sora nincs kitöltve (`CHANGE_ME`), vagy a `KEYCLOAK_PUBLIC_URL` nem `https://`.
- **A Keycloak nem lesz healthy:** `docker compose logs keycloak`. Adatbázis-hitelesítési hiba esetén a `KEYCLOAK_DB_PASSWORD` változott; a `keycloak-db-init` minden `up`-nál újra beállítja: `docker compose up -d`.
- **`admin-bejelentkezés sikertelen` a provisionnél:** a `.env` `KEYCLOAK_ADMIN_*` nem egyezik a Keycloak valódi adminjával (5. pont).

## 14. Visszaállás

1. Supabase-provider: a Keycloak-provider törlése a 9. pont `DELETE` hívásával. A régi, közvetlen NJE-provider visszaállítása értelmetlen, mert nem működött.
2. Keycloak kikapcsolása: vedd ki a `:deploy/compose.keycloak.yml`-t a `COMPOSE_FILE`-ból, majd `docker compose up -d --remove-orphans`. A `keycloak` adatbázis megmarad; végleges törlés: `docker compose exec db psql -U supabase_admin -c 'drop database keycloak' -c 'drop role keycloak'`.
3. A frontend „Sign in with NJE ID” gombja provider nélkül hibaüzenetet ad, a jelszavas belépés változatlanul működik.
