# echo-receipt — kérdőív-kitöltés visszaigazoló levele

Az ECHO kérdőív sikeres beküldése után a böngésző külön, azonosított kérésben
hívja; a levél a hallgató saját címére megy, a felület nyelvén (hu/en).
Válaszokat és időpontot nem tartalmaz. Részletek: `echo-receipt/index.ts` fejléce.

Docker-telepítésen a `deploy/compose.uniportal.yml` csatolja, és a `.env`
`SMTP_*` soraiból kapja a beállításokat. Felhős projekten:

```bash
supabase functions deploy echo-receipt
supabase secrets set \
  SMTP_HOST=smtp.resend.com SMTP_PORT=465 SMTP_USER=resend SMTP_PASS=<API-kulcs> \
  SMTP_ADMIN_EMAIL=noreply@<domain> SMTP_SENDER_NAME="NJE UniPortal" \
  UNIPORTAL_SITE_URL=https://<az oldal címe>
```

SMTP nélkül a függvény nem küld, csak `{ sent: false, reason: 'smtp_not_configured' }`-ot ad vissza.

---

# WhatsApp Business integráció — telepítés

Két Edge Function. A WhatsApp access token **kizárólag** itt, szerveroldalon
létezik; a statikus oldal sosem látja.

```
böngésző → sb.functions.invoke('whatsapp-send')       → Graph API
Meta     → …/functions/v1/whatsapp-webhook             → wa_messages → realtime → CRM inbox
```

---

## 1. Adatbázis

Futtasd le a [`../10_whatsapp.sql`](../10_whatsapp.sql) migrációt (SQL Editor).
Létrehozza a `wa_contacts` / `wa_messages` táblákat, az ügyintézőkre szűkített
RLS-t, a realtime feliratkozást és a `wa_window_open()` segédfüggvényt.

## 2. Függvények telepítése

```bash
supabase link --project-ref mdccyastwhzwtyukxlpk
supabase functions deploy whatsapp-send
supabase functions deploy whatsapp-webhook --no-verify-jwt
```

> A `--no-verify-jwt` a webhooknál **kötelező**: a Meta nem tud Supabase JWT-t
> küldeni. A hitelesítést helyette az `X-Hub-Signature-256` HMAC-ellenőrzés adja.

## 3. Secretek

```bash
supabase secrets set \
  WHATSAPP_ACCESS_TOKEN=EAAG... \
  WHATSAPP_PHONE_NUMBER_ID=1234567890 \
  WHATSAPP_VERIFY_TOKEN=egy-altalad-kitalalt-hosszu-string \
  WHATSAPP_APP_SECRET=a-meta-app-secret
```

| Secret | Hol találod a Meta felületén |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp → API Setup → *Temporary access token* (fejlesztéshez), éleshez System User token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → *Phone number ID* (nem a telefonszám!) |
| `WHATSAPP_VERIFY_TOKEN` | Te találod ki; ugyanezt írod be a webhook beállításánál |
| `WHATSAPP_APP_SECRET` | App settings → Basic → *App secret* |

Opcionális: `WHATSAPP_API_VERSION` (alapértelmezés `v21.0`).

## 4. Webhook bekötése a Metánál

**Meta for Developers → az appod → WhatsApp → Configuration → Webhook → Edit**

- **Callback URL:** `https://mdccyastwhzwtyukxlpk.supabase.co/functions/v1/whatsapp-webhook`
- **Verify token:** amit a `WHATSAPP_VERIFY_TOKEN`-be tettél

Mentés után a Meta küld egy `GET`-et a `hub.challenge` paraméterrel; a függvény
visszaadja, és a webhook zöldre vált. Ezután a **Manage** gombnál iratkozz fel
legalább a `messages` mezőre — enélkül nem jön se bejövő üzenet, se
kézbesítési státusz.

## 5. Sablonok

Beszélgetést **kezdeményezni csak jóváhagyott sablonnal** lehet; szabad szöveg
csak akkor megy ki, ha a partner az elmúlt **24 órában** írt. A felület ezt
figyeli (`wa_window_open`), és zárt ablaknál sablonválasztóra vált.

A felületen felkínált sablonnevek (ezeket kell a Metánál létrehozni,
**WhatsApp Manager → Message templates**, `hu` nyelvvel):

| Sablonnév | Mire való | Kategória |
|---|---|---|
| `missing_documents` | hiánypótlás emlékeztető | Utility |
| `admission_decision` | felvételi döntés értesítő | Utility |
| `payment_reminder` | fizetési határidő | Utility |
| `interview_invite` | interjú-időpont | Utility |

A `Utility` kategória lényeges: `Marketing`-ként beküldve szigorúbb elbírálás
és más díjszabás vonatkozik rá.

## Fokozatos bevezetés

A rendszer **működik a Meta-fiók előtt is**:

| Állapot | Mi történik |
|---|---|
| Nincs 10-es migráció | A CRM üres szálat mutat, hibaüzenet nélkül |
| Migráció ✓, függvény ✗ | A küldés `simulated` sorként mentődik — a beszélgetés valódi és megosztott, de nem megy ki |
| Függvény ✓, secret ✗ | Ugyanaz, de már a szerveroldali úton, jogosultság-ellenőrzéssel |
| Minden ✓ | Valódi WhatsApp üzenet, kézbesítési státuszokkal |

Egyik lépés sem igényel kódmódosítást — a felület minden esetben megmondja,
melyik állapotban van.

## Tesztelés Meta tesztszámmal

Fejlesztéshez a Meta ad egy ingyenes tesztszámot, amivel legfeljebb 5 általad
megadott címzettnek lehet küldeni (**API Setup → To → Manage phone number
list**). Ehhez nincs szükség cégellenőrzésre, és a teljes folyamat — küldés,
webhook, kézbesítési státusz — végigpróbálható.

---

# grants-fetch-calls — EU-felhívások betöltése

Telepítve 2026-09-23-án (`supabase functions deploy grants-fetch-calls`).
A `77_grants_core.sql` katalógusát tölti fel az EU Funding & Tenders portál
nyilvános referencia-állományából.

```
felület („Betöltés most”) ─┐
ütemező (service_role) ────┴→ grants-fetch-calls → ec.europa.eu (130 MB JSON)
                                     │
                                     └→ grants_call_upsert (200-as kötegek)
                                        grants_etl_start / _finish (napló)
```

## Amit tudni kell róla

* **SZELETEKBEN dolgozik.** Egy invokáció nem tudja végigolvasni a 124 MB-os
  forrást: mérve (2026-09-23) már a tiszta olvasás is `WORKER_RESOURCE_LIMIT`-tel
  elhal 40 és 124 MB között, feldolgozás nélkül. A forrás nem tömörít
  (nincs `Content-Encoding`), de tud byte-range kérést (`Accept-Ranges: bytes`)
  és ad ETag-et — ezért egy hívás ~16 MB-ot dolgoz fel, és a válasz `kovetkezo`
  mezője mondja meg, mi a következő szelet. A felület jár végig rajtuk, és a
  `run` azonosítót továbbadja, hogy a naplóban EGY futás legyen.
  Mérve élesben: 8 szelet, 689 felhívás, 24 másodperc; ismételt futásra
  689 változatlan.
* **A cron azonosítása külön titok.** `GRANTS_CRON_SECRET` (beállítva), amit az
  `x-grants-cron` fejlécben kell küldeni. Azért nem a service_role kulcs
  egyezését vizsgáljuk: mérve a projekt által kiadott service_role kulcs NEM
  azonos azzal, amit a futtatókörnyezet `SUPABASE_SERVICE_ROLE_KEY`-ként ad.
* **Nem kell hozzá új secret a működéshez.** A `SUPABASE_URL`, az anon és a
  service_role kulcs a futtatókörnyezetből jön. Felülírható környezeti
  változók: `GRANTS_EU_URL`, `GRANTS_USER_AGENT`.
* **JWT-ellenőrzés KELL** (tehát `--no-verify-jwt` nélkül kell telepíteni): a
  felület a bejelentkezett felhasználó tokenjével hív, és a jogosultságot a
  függvény a `grants_context()`-tel állapítja meg. Ütemezőből a service_role
  kulcs az `Authorization` fejlécben ugyanezt a kaput nyitja.
* **Két fájl**, és a nevük kötött: az `index.ts` a `./parser.js`-t importálja.
  A parszer külön fájl, mert az a legkockázatosabb rész (130 MB folyamatos
  olvasása darabhatárokon átnyúló tételekkel), és így Node-ból tesztelhető.
* **Idempotens**: ugyanaz a köteg másodszorra „változatlan”. Félbeszakadt futás
  után a már betöltött tételek bent maradnak, és a naplóban látszik, hol állt meg.

## Üzemzavar-vizsgálat

```bash
# csak a letöltést méri, feldolgozás nélkül (így derült ki az erőforrás-korlát)
... -d '{"probe":"olvas","maxMb":20}'
```

A válasz `tetel_latott` / `minta_kizart` / `horgony_hiany` mezői megmondják,
hogy egy szelet egyáltalán látott-e tételeket. A `horgony_hiany` akkor nő, ha a
forrás tördelése megváltozott — ilyenkor a parser.js mintáit kell frissíteni.

## Próbamenet és korlátozott futás

```bash
# csak olvas, nem ír (a naplóba sem)
curl -X POST "$URL/functions/v1/grants-fetch-calls" \
  -H "apikey: $ANON" -H "Authorization: Bearer $SERVICE_ROLE" \
  -H 'Content-Type: application/json' -d '{"dry":true}'

# legfeljebb 50 tétel — gyors ellenőrzéshez
... -d '{"max":50}'
```

## Ellenőrzés a telepítés után (mérve)

| Hívás | Várt válasz |
|---|---|
| POST `Authorization` nélkül | 401 `{"hiba":"Hiányzó Authorization fejléc."}` |
| POST publikus kulccsal | 401 — a `grants_context()` megtagadja |
| OPTIONS | 200 (CORS) |

A tényleges betöltés a felületről indítható: **Pályázatfigyelő → Adatforrások →
Betöltés most**. Utána az SQL Editorban:

```sql
select allapot, count(*) from grants.call group by 1 order by 2 desc;
select source_kod, allapot, uj_db, modosult_db, valtozatlan_db, indult, hiba
  from grants.etl_run order by indult desc limit 5;
```
