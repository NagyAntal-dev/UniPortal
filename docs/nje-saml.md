# NJE SAML bejelentkezés

A UniPortal az NJE központi azonosítójával (`https://idp.nje.hu`, SimpleSAMLphp) **saját SAML service providerrel** jelentkeztet be. Ez a `saml-sp` szolgáltatás (`deploy/saml-sp`). A GoTrue beépített SAML-jét és a Keycloakot szándékosan **nem** használjuk.

## Hogyan működik

```
böngésző ─► /saml/login ─► idp.nje.hu (NJE jelszó) ─► POST /saml/acs  (saml-sp)
  1. aláírás, címzett (audience), kiállító, idő és InResponseTo ellenőrzése
  2. felhasználó keresése az ePPN alapján, ha nincs: automatikus regisztráció
  3. egyszer használható token (GoTrue magic link, levél NEM megy ki)
  303 ─► app.html#sso_token_hash=…  ─► sb.auth.verifyOtp() ─► normál Supabase munkamenet
```

A felhasználó a végén **ugyanolyan Supabase munkamenetet** kap, mint jelszavas belépésnél. Minden RLS-szabály, a tokenfrissítés és a kijelentkezés változatlanul működik. A jelszavas belépés megmarad.

### Ki mit kap az első belépéskor

| Eset | Mi történik |
|---|---|
| **Új NJE-felhasználó** | Létrejön a fiók (megerősített e-maillel). A profil **STUDENT** szerepkört kap, és **azonnal jóvá van hagyva** (`approved_by = 'nje-sso'`). A név a `displayName`-ből jön. |
| **Már van jelszavas fiókja ugyanazzal az e-maillel** | A fiókot hozzákötjük az NJE-azonosítóhoz. A szerepköre és a jóváhagyási állapota **nem változik**, tehát egy függőben lévő (például ügynöki) regisztráció függőben marad. Ha az e-mail-címét sosem erősítette meg, a jelszavát véletlenre cseréljük, mert egy előre, más nevére regisztrált fiók jelszava nem maradhat érvényben. |
| **Visszatérő NJE-felhasználó** | Az ePPN alapján találjuk meg. Az attribútumok (`ou`, `title`, iroda) minden belépéskor frissülnek. |
| **A beépített superadmin e-mail-címe** | A `handle_new_user` trigger szabálya érvényes: SUPERADMIN. |

Az adatok a `public.saml_identities` táblában vannak (`supabase/76_saml_sso.sql`). Ezt csak a `service_role` látja.

### Attribútumok

| OID | Név | Használat |
|---|---|---|
| `urn:oid:1.3.6.1.4.1.5923.1.1.1.6` | eduPersonPrincipalName | **kötelező**, állandó azonosító |
| `urn:oid:0.9.2342.19200300.100.1.3` | mail | e-mail-cím (hiánya esetén az ePPN) |
| `urn:oid:2.16.840.1.113730.3.1.241` | displayName | a profil neve |
| `urn:oid:2.5.4.11` | ou | szervezeti egység (tárolva) |
| `urn:oid:2.5.4.12` | title | beosztás (tárolva) |
| `urn:oid:2.5.4.19` | physicalDeliveryOfficeName | iroda (tárolva) |

## Amit az NJE IT-nak meg kell adni

- **SP metaadat:** `https://<a UniPortal címe>/saml/metadata`. Ez tartalmazza az alábbiakat is.
- **Entity ID:** `https://<cím>/saml/metadata`
- **ACS** (HTTP-POST): `https://<cím>/saml/acs`
- **SLO** (HTTP-Redirect): `https://<cím>/saml/slo`
- **Kért attribútumok:** a fenti hat; az `eduPersonPrincipalName` és a `mail` kötelező.
- **Aláírás:** az assertion legyen aláírva (SimpleSAMLphp-ben ez az alapértelmezés). A kéréseinket (AuthnRequest, LogoutRequest) mi is aláírjuk.
- **NameID:** bármi lehet (transient is jó). A felhasználót az ePPN azonosítja.

### Ha az IT-nál a korábbi (GoTrue-s) címek vannak bejegyezve

Ez az NJE-nél a helyzet: az IT-nak a `https://uniportal.nje.hu/auth/v1/sso/saml/{metadata,acs,slo}` címeket adtuk meg. Hogy az IT-nál ne kelljen semmit módosítani, a `saml-sp` ugyanezeken a címeken válaszol. A `.env`-ben:

```
SAML_SP_PATH=/auth/v1/sso/saml
```

Ekkor az entityID `https://uniportal.nje.hu/auth/v1/sso/saml/metadata`, az ACS `…/auth/v1/sso/saml/acs`, az SLO `…/auth/v1/sso/saml/slo`. Az nginx ezt az útvonalat a `saml-sp`-hez viszi, nem a GoTrue-hoz, mert a GoTrue saját SAML-je ki van kapcsolva. A metaadat a `/saml/metadata` címen is elérhető, ugyanazzal a tartalommal. A felület gombjai továbbra is a `/saml/login` és a `/saml/logout` címet hívják.

## Telepítés

**Új szerver:** az `./init-env.sh <cím>` a SAML-kulcsokat is elkészíti.

**Meglévő `.env`:**

```sh
sh deploy/saml-sp/gen-keys.sh        # csak a hiányzó értékeket írja be
docker compose up -d --build
curl -s https://<cím>/saml/metadata  # ezt kapja az IT
```

Ha a `.env`-ben már van `SAML_PRIVATE_KEY` (a korábbi GoTrue-s kísérletből), a `gen-keys.sh` **ezt a kulcsot veszi át**, és PEM-re alakítja. A kulcshoz új önaláírt tanúsítványt készít, ha nem kap meglévőt. Ugyanahhoz a kulcshoz tartozó tanúsítvány ugyanazt a nyilvános kulcsot hordozza, ezért az aláírásaink továbbra is ellenőrizhetők. Ha a pontos, az IT-nak már elküldött tanúsítványt akarod megtartani: `sh deploy/saml-sp/gen-keys.sh --cert <fájl.pem>`. A szkript ellenőrzi, hogy a tanúsítvány a kulcshoz tartozik-e.

A `saml-sp` induláskor maga is ellenőrzi a kulcsot és a tanúsítványt. Ha nem olvashatók, vagy nem tartoznak össze, nem indul el, és a naplóban megmondja, miért.

Az IdP aláíró tanúsítványát induláskor a metaadatból töltjük le HTTPS-en, és naponta frissítjük. **Élesben ajánlott rögzíteni** a `.env`-ben:

```sh
curl -s https://idp.nje.hu/simplesaml/saml2/idp/metadata.php \
  | grep -o '<ds:X509Certificate>[^<]*' | head -1 | sed 's/<ds:X509Certificate>//'
# → SAML_IDP_CERT=<ez az érték>
```

Ha rögzítve van, **csak** ezt a tanúsítványt fogadjuk el. IdP-tanúsítványcserénél ezt is frissíteni kell.

> A `SAML_SP_ENTITY_ID`-t és az SP-kulcsot az IT-nál való bejegyzés után ne változtasd. Ha mégis kell (`gen-keys.sh --force`), a metaadatot újra el kell küldeni.

> Az NJE IdP metaadata a SimpleSAMLphp 2 újabb végpontjait is közli (`/simplesaml/module.php/saml/idp/singleSignOnService`, `…/singleLogout`). Az IT által megadott régi `…/SSOService.php` és `…/SingleLogoutService.php` címek is működnek; ezek az alapértékek (`SAML_IDP_SSO_URL`, `SAML_IDP_SLO_URL`).

## Kijelentkezés

- **A UniPortalból:** az NJE-s fiók kijelentkezése után a böngésző a `/saml/logout`-ra megy, az pedig az IdP-n is lezárja a munkamenetet.
- **Máshonnan (IdP-kezdeményezett SLO):** a `/saml/slo` visszavonja a felhasználó munkameneteit az adatbázisban, és a böngészőből is törli a Supabase-munkamenetet. A már kiadott access token legfeljebb a lejáratáig (`JWT_EXPIRY`, alapból 1 óra) él.

## Hibaelhárítás

```sh
docker compose logs -f saml-sp
```

A hiba kódja a nyitóoldal címsorában jelenik meg (`index.html#sso_error=<kód>`), a felhasználó pedig szöveges üzenetet kap.

| Kód | Jelentés |
|---|---|
| `invalid_response` | Érvénytelen aláírás, rossz címzett vagy kiállító, lejárt válasz. Nézd meg a naplót, és a tanúsítványt (`SAML_IDP_CERT`). |
| `expired` | A belépés 10 percnél tovább tartott, vagy a választ már felhasználták (például a vissza gomb miatt). |
| `missing_eppn`, `missing_email` | Az IdP nem adta ki az attribútumot. Ezt az IT-nak kell beállítania. |
| `provision_failed` | Hiba a GoTrue- vagy a PostgREST-hívásban. Nézd meg, hogy lefutott-e a `76_saml_sso.sql`, és helyes-e a `SERVICE_ROLE_KEY`. |

**Tesztek** (a hálózat nélkül futnak, egy ál-IdP-vel):

```sh
cd deploy/saml-sp && npm ci && npm test
```

A `test/fixtures` kulcsai **csak tesztkulcsok**, élesben sehol nem használjuk őket.
