# UniPortal — telepítés Dockerrel (saját szerver)

Ez a leírás a teljes UniPortal-rendszer saját szerveres telepítéséről szól. A felület **és** a mögötte futó Supabase (adatbázis, bejelentkezés, fájltárolás, valós idejű frissítések, Edge Functions) mind Docker-konténerben fut, egyetlen `docker compose` paranccsal.

> A jelenlegi nyilvános változat (GitHub Pages + felhős Supabase) ettől független, és változatlanul működik tovább.

## Röviden

```sh
unzip UniPortal-docker-*.zip -d /opt            # a kapott csomagból: /opt/UniPortal
cd /opt/UniPortal
./init-env.sh https://uniportal.nje.hu          # egyszer: .env erős, véletlen titkokkal
docker compose up -d --build                    # indítás és minden frissítés
./deploy/make-superadmin.sh te@nje.hu --create  # első rendszergazda
```

A csomag helyett a nyilvános tárolóból is dolgozhatsz: `git clone https://github.com/kecskemetadatkozpont/UniPortal.git /opt/UniPortal`. A `docker compose` parancsokat mindig a UniPortal-könyvtár gyökeréből futtasd: a `.env` ott van, és az tölti be a UniPortal-réteget is.

## 1. Mi indul el

| Szolgáltatás | Mit csinál |
|---|---|
| `web` | A UniPortal felülete (nginx), és **ugyanazon a címen** a Supabase API továbbítása (`/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1`). Ez az egyetlen kifelé nyitott port. |
| `migrate` | Indításkor egyszer lefut. Felviszi az adatbázis-migrációkat (`supabase/NN_*.sql`, a sorrend a `deploy/migrate/manifest.txt`-ben), a már lefutottakat kihagyja, és lezárja a nyilvános jelszavú demó fiókokat. A `web` csak utána indul. |
| `saml-sp` | NJE SAML bejelentkezés (`/saml/*`) automatikus regisztrációval. Kifelé nem nyit portot, a `web` továbbít rá. Részletek: [docs/nje-saml.md](docs/nje-saml.md) |
| `db` | PostgreSQL 17 (Supabase-kép) |
| `auth` | Bejelentkezés, regisztráció, jelszó-visszaállítás |
| `rest` | Adatbázis-API (PostgREST) |
| `realtime` | Valós idejű frissítések |
| `storage`, `imgproxy` | Feltöltött fájlok: dokumentumok, profilképek, kollégiumi fotók |
| `functions` | Edge Functions (WhatsApp-küldés és -webhook) |
| `api-gw` | A Supabase belső API-átjárója |
| `studio`, `meta` | Supabase Studio adminfelület (csak a szerverről érhető el) |
| `supavisor` | Adatbázis-kapcsolatkezelő (pooler) |

A Supabase-szolgáltatások a hivatalos self-host csomagból jönnek, **rögzített verzióval** (`deploy/supabase`; a forrást a `deploy/supabase/UNIPORTAL_VENDOR.txt` rögzíti). A UniPortal saját módosításai külön rétegben vannak (`deploy/compose.uniportal.yml`), a hivatalos fájlokhoz nem kell nyúlni.

## 2. Előfeltételek

- Linux szerver (amd64 vagy arm64), legalább **4 GB RAM** (8 GB ajánlott) és **20 GB** szabad lemez.
- **Docker Engine 24+** és **Docker Compose v2.24.4+**. Ellenőrzés: `docker compose version`. A régi, kötőjeles `docker-compose` (v1) nem jó.
- `unzip` (a csomag kibontásához) vagy `git`, valamint `openssl`.
- Kimenő internet a képek letöltéséhez. A felhasználók böngészőjének néhány nyilvános CDN-t is el kell érnie (lásd *Ismert korlátok*).
- Éles üzemhez **domain + HTTPS** (5. pont) és **SMTP** (6. pont).

## 3. Telepítés

```sh
unzip UniPortal-docker-*.zip -d /opt      # vagy: git clone https://github.com/kecskemetadatkozpont/UniPortal.git /opt/UniPortal
cd /opt/UniPortal
./init-env.sh https://uniportal.nje.hu
```

A csomagot közvetlenül a szerveren bontsd ki. Ha Windows-on vagy a macOS Finderével bontják ki, a szkriptek elveszíthetik a futtatási jogukat; ekkor: `chmod +x init-env.sh deploy/*.sh`.

Az `init-env.sh`-t **egyszer** kell futtatni. A `.env.example` alapján létrehozza a `.env`-et: erős, véletlen titkokat generál (adatbázis-jelszó, JWT-titok, API-kulcsok, Studio-jelszó), és beállítja a nyilvános címet. A paraméter az a cím, amelyen a felhasználók elérik a rendszert. HTTPS-proxy mögött ez a `https://…` cím. Helyi próbánál elhagyható, ekkor `http://localhost:8080` lesz.

> ⚠️ A `.env` a rendszer kulcsa: nélküle a meglévő adatbázis nem használható. Ne kerüljön gitbe (a `.gitignore` kizárja), és legyen része a mentésnek (a `backup.sh` beleteszi).

Éles üzem előtt töltsd ki az SMTP-beállításokat a `.env`-ben (6. pont). Utána:

```sh
docker compose up -d --build
docker compose ps
```

Az első indítás a képek letöltése miatt 5–15 perc. Akkor van rendben, ha minden szolgáltatás `running (healthy)`, a `migrate` pedig `exited (0)` állapotú. Napló: `docker compose logs -f migrate web`. A `migrate` naplójában első indításkor ennek kell szerepelnie: `Lezárva: 5 demó fiók`.

A felület címe `http://<szerver>:8080`, vagy a domain, ha a proxy már áll.

## 4. Az első rendszergazda

- **SMTP nélkül is működik** (ajánlott első lépés):
  ```sh
  ./deploy/make-superadmin.sh te@nje.hu --create
  ```
  Létrehozza a fiókot megerősített e-mail-címmel és SUPERADMIN szerepkörrel, és kiír egy ideiglenes jelszót. Belépés után cseréld le: *Fiók → Jelszó módosítása*.
- **Már regisztrált fiók** előléptetése: `./deploy/make-superadmin.sh te@nje.hu`
- A rendszer egy címet eleve rendszergazdának ismer: aki a `kecskemet.adatkozpont@gmail.com` címmel regisztrál, automatikusan SUPERADMIN lesz (07-es migráció). Ha élesben ezt másik címre kell cserélni, a Studio SQL-szerkesztőjében:
  ```sql
  create or replace function public.superadmin_email()
  returns text language sql immutable as $$ select 'uj.cim@nje.hu' $$;
  ```
- Minden más új regisztráció *függőben* marad, amíg egy rendszergazda jóvá nem hagyja a felületen.

## 5. Portok és HTTPS

| Port | Szolgáltatás | Honnan érhető el |
|---|---|---|
| `8080` (`UNIPORTAL_HTTP_PORT`) | web: felület + API | kívülről; élesben a HTTPS-proxy mögül |
| `127.0.0.1:8000` | api-gw: Studio és nyers API | csak a szerverről |
| `127.0.0.1:5432`, `127.0.0.1:6543` | supavisor: PostgreSQL | csak a szerverről |

A többi szolgáltatás csak a belső Docker-hálózaton látszik. A Studio távolról SSH-alagúttal érhető el:

```sh
ssh -L 8000:127.0.0.1:8000 <szerver>     # majd a böngészőben: http://localhost:8000
```

A felhasználónév `supabase`, a jelszó a `.env` `DASHBOARD_PASSWORD` sora.

### Sebességkorlát és a valós ügyfél-IP

A web-konténer nginxe korlátozza a kérések számát (`/auth/v1/`, `/rest/v1/`,
`/functions/v1/`, `/storage/v1/`). Ehhez tudnia kell, **ki a kérés valódi
küldője** — TLS-proxy mögött ugyanis minden kérés a proxy címéről érkezik, és
akkor a korlát egyetlen közös vödör lenne: az első terhelés az egész
intézményt kizárná.

Ezért a `.env`-ben **kötelező** megadni, honnan fogadjuk el az
`X-Forwarded-For` fejlécet:

```sh
UNIPORTAL_TRUSTED_PROXY=127.0.0.1      # a proxy ugyanezen a gépen fut
```

Több proxy esetén szóközzel elválasztva sorolhatók fel. Ha **nincs** proxy a
web előtt, hagyd üresen.

**A proxynak továbbítania kell az `X-Forwarded-For` fejlécet** — a lenti
Caddy- és nginx-minta ezt megteszi. Ha az egyetemi proxy nem küldi, a korlát
mindenkit egy vödörbe tesz.

A mértékek a `.env`-ből hangolhatók (`UNIPORTAL_RL_*`, `UNIPORTAL_CONN_LIMIT`);
üresen hagyva a beépített alapérték él. Az alapértékek a felület mért
terheléséhez igazodnak, és **közös kimenő IP (kampusz NAT) mellett is
használhatók**: a bejelentkezett forgalmat munkamenetenként, nem IP-nként
számoljuk. A bejelentkezési korlát viszont IP szerinti, tehát közös NAT mögött
az egész intézményre vonatkozik — ezért az alapértéke szándékosan bőkezű
(`60r/m`). Ha a felhasználók nem közös IP mögül jönnek, nyugodtan húzd le:

```sh
UNIPORTAL_RL_AUTH=20r/m
```

Ellenőrzés indulás után:

```sh
docker compose logs web | grep uniportal     # a valós IP forrása
docker compose logs web | grep limiting      # üres, ha semmi nem akadt el
```

**HTTPS.** A `web` sima HTTP-t szolgál ki a 8080-as porton, ezért élesben tegyél elé TLS-proxyt (Caddy, nginx, Traefik vagy az egyetemi proxy). A kamera- és mikrofonfunkciók (videós interjú) a böngészőben **csak HTTPS-en** működnek. Ha a proxy ugyanazon a gépen fut, állítsd be a `.env`-ben: `UNIPORTAL_HTTP_PORT=127.0.0.1:8080`. Így a 8080 kívülről nem is látszik.

Caddy (a Let's Encrypt-tanúsítványt magától megszerzi):

```
uniportal.nje.hu {
    reverse_proxy 127.0.0.1:8080
}
```

nginx:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name uniportal.nje.hu;
    ssl_certificate     /etc/letsencrypt/live/uniportal.nje.hu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/uniportal.nje.hu/privkey.pem;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;          # valós idejű frissítések (WebSocket)
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```

**Címváltás.** Ha a nyilvános cím később változik, írd át a `.env`-ben ezt az öt sort, majd futtasd: `docker compose up -d`.
- `UNIPORTAL_PUBLIC_URL`
- `SITE_URL`
- `ADDITIONAL_REDIRECT_URLS` (`<cím>/**`)
- `SUPABASE_PUBLIC_URL`
- `API_EXTERNAL_URL` (`<cím>/auth/v1`)

## 6. E-mail (SMTP)

A regisztráció megerősítése és az „Elfelejtettem a jelszavam” levél SMTP-n megy ki, ezért éles üzemhez kötelező. Resend esetén a `.env`-ben:

```
SMTP_ADMIN_EMAIL=noreply@<a Resendben hitelesített domain>
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<Resend API-kulcs>
SMTP_SENDER_NAME=NJE UniPortal
ENABLE_EMAIL_AUTOCONFIRM=false
```

Utána futtasd: `docker compose up -d`. Az `auth` az új beállításokkal indul újra. A Resendben előbb a küldő domaint kell hitelesíteni (DNS: SPF, DKIM). Az API-kulcs **csak** a szerver `.env`-jébe kerüljön.

- A **jelszó-visszaállító levél** magyar/angol sablont használ (`deploy/web/email/recovery.html`). A link a `reset-password.html` oldalra visz, és csak a mentés gomb megnyomásakor váltódik be. Így a levelezők biztonsági szűrői nem tudják előre „elhasználni”.
- A többi levél (regisztráció megerősítése, e-mail-cím módosítása) a Supabase alap angol sablonját használja.
- Az `ENABLE_EMAIL_AUTOCONFIRM=true` **csak helyi próbához** való. Ilyenkor bárki megerősítés nélkül regisztrálhat, a beépített superadmin címmel is.
- Ellenőrzés: `docker compose logs auth | grep -iE "mail|smtp|template"`

## 7. Frissítés

```sh
cd /opt/UniPortal
sudo ./deploy/backup.sh                            # előtte mentés
unzip -o /tmp/UniPortal-docker-<új>.zip -d /opt    # az új csomag a régi fölé (git esetén: git pull)
docker compose up -d --build
docker compose logs migrate                        # mi futott le
```

A csomagban nincs `.env`, adatbázis, feltöltött fájl és mentés, ezért a kibontás csak a programfájlokat írja felül.

A `migrate` csak az új migrációkat futtatja; a nyilvántartás az `uniportal_meta.migrations` táblában van. Egy már lefutott, de utólag módosított migrációt nem futtat újra, csak figyelmeztet.

<a id="muveleti-rbac"></a>

### Műveleti RBAC telepítése és visszaállítása

A manifest sorrendje **72_rbac_actions.sql → 74_rbac_enforce_rpc.sql →
73_rbac_enforce_rls.sql**. A 72-es a mátrixot és kompatibilis RPC-ket hozza létre,
a 74-es 26 RPC-t őriz, a 73-as 49 restriktív policy-t ad 20 táblához.
A 73-as megszakítja a telepítést hiányzó backfill, kikapcsolt RLS vagy nem
igazolt ügyintézői permisszív kapu esetén. Ilyenkor a megnevezett eltérést kell
ellenőrizni; az előfeltételt ne kerüld meg. A data reset az RBAC-mátrixot,
beállításokat, auditnaplót és mindkét leképezési táblát megőrzi.

Az alkalmazásos ellenőrzés SUPERADMIN munkamenetben `rbac_enforce_state()`;
a deploy linter a kapukat és policy-ket is ellenőrzi. Az élő környezetben
külön szükséges a hat alap- és egy saját szerepkörös bejelentkezési/mentési
próba, valamint a `reset-data.sh` előnézet. A helyi tesztparancsok és az eddigi
bizonyítékok a [mérési jelentésben](supabase/diagnostics/72_meresi_jelentes.md) vannak.

Visszaállítási sorrend:

1. **Vészkapcsoló, SUPERADMIN alkalmazásos munkamenetből:**
   `rbac_enforce_set(false)`. A régi RLS és RPC szerepkörkapuk továbbra is élnek.
   Visszakapcsolás: `rbac_enforce_set(true)`. A SQL Editor adatbázis-tulajdonosa
   nem automatikusan alkalmazásos SUPERADMIN; a függvény profilazonosítót kér.
2. **A kikényszerítési rétegek bontása:** adatbázis-tulajdonosként futtasd a
   teljes `supabase/75_rbac_actions_rollback.sql` fájlt. Ez egy tranzakcióban
   eldobja az `rbacx_` policy-ket és kiveszi a 74-es pontosan azonosított
   RPC-őrblokkjait. A mátrix és napló megmarad. Ismeretlenül módosított őrnél
   az egész bontás visszagördül. A fájl kétszer is futtatható, és **nem része
   a manifestnek**.
3. **Az alapréteg teljes eltávolítása, csak ha szükséges:** SUPERADMIN
   munkamenetből `rbac_actions_rollback()`. Ez megtagadja a futást élő policy
   vagy RPC-őr mellett; máskülönben visszaállítja a korábbi menü-RPC-ket és
   elbontja a 72-es mátrixot. A jogosultsági auditnaplót megőrzi.

A 75-ös kézi futtatása nem változtatja meg a migrációs nyilvántartást.
Visszatelepítéshez ezért a 74-es és a 73-as fájlt kell kézzel újrafuttatni,
nem elegendő a konténerek újraindítása. Ha a 72-est is elbontottad, előbb az
is szükséges. A 72-es első backfilljét jelölő beállítás megakadályozza, hogy
egy újrafuttatás visszaadja az azóta szándékosan elvett jogokat. Újratelepítés
után ellenőrizd a vészkapcsoló állását és futtasd a deploy verifikációt.

A Supabase-verziót nem a szerveren kell frissíteni: a fejlesztő emeli a `deploy/vendor-supabase.sh`-val, kipróbálja, és a tárolóban adja tovább.

## 8. Mentés és visszaállítás

```sh
sudo ./deploy/backup.sh
```

Az eredmény egy `backups/uniportal-<időbélyeg>.tar.gz` archívum: benne az adatbázis-könyvtár, a feltöltött fájlok és a `.env`. A szkript a mentés idejére (általában 1 percen belül) leállítja a rendszert, így az adatbázis és a fájlok biztosan összeillenek. Utána újraindítja. A 14 napnál régebbi archívumokat törli (`UNIPORTAL_BACKUP_KEEP_DAYS`).

Éjszakára ütemezve (`sudo crontab -e`):

```
30 2 * * * /opt/UniPortal/deploy/backup.sh >> /opt/UniPortal/backups/backup.log 2>&1
```

Visszaállítás:

```sh
sudo ./deploy/restore.sh backups/uniportal-20260911-023000.tar.gz
```

A jelenlegi állapotot nem törli, hanem a `backups/elozo-<időbélyeg>/` könyvtárba teszi. A `.env` is visszaáll, mert az adatbázis az archívumban lévő jelszóval jött létre. A mentéssel azonos vagy újabb UniPortal-verzión futtasd.

> Az archívum személyes adatokat és a rendszer titkait tartalmazza. A szerveren kívülre csak **titkosítva** vidd (pl. `gpg -c`, restic, borg). Negyedévente próbáld ki a visszaállítást egy tesztszerveren. Ha a szerverről VM-pillanatkép is készül, az jó kiegészítés.

### Reset application data while keeping users and RBAC

Deploy this version first (`docker compose up -d --build`), and close old browser
tabs: older frontend versions automatically insert demo programs into empty tables.
Run the following from the repository directory on the Docker server:

```sh
# Preview only: exercises the database reset and rolls it back, lists upload counts.
sh deploy/reset-data.sh --dry-run

# Optional full backup before deletion.
sudo sh deploy/backup.sh

# Permanently delete application data and uploads.
sh deploy/reset-data.sh --yes
```

The command clears business data in `public`, `echo`, and `dorm`, including courses,
enrollments, programs, applications, survey responses, financial records, logs,
templates, settings and reference catalogs. It preserves:

- Supabase Auth accounts, passwords and identities; `public.users` and `profiles`.
- User attributes, RBAC role definitions, permissions, grants, groups and membership.
- Only the organization scopes (and their ancestors), buildings and related
  site/landlord/tenure rows required by existing scoped grants. These are retained
  to preserve the grants' meaning; scoped permissions never become global permissions.
- User avatars; all other Storage objects are deleted through the Storage API.
- Database schema, functions, policies, bucket definitions and migration history.

Profile links to deleted students/agencies are cleared. The application requires
fresh configuration/catalog data before those modules can be used again. Existing
migrations are not rerun and demo data is not automatically reinserted by the new
frontend. Browser-local demo data, server logs and backup archives are outside this reset.

The destructive command pauses running entry points and background writers, validates
the SQL in a rolled-back transaction, removes uploads, then commits the database reset.
It restarts only the services it paused. File deletion cannot be rolled back together
with SQL: a failure may leave some files deleted. The command reports errors and can
be retried after the cause is fixed. Do not run other maintenance jobs or direct
database writers concurrently. Without `--yes`, no deletion is committed.

This is a manual command, **not a migration**. Never add `deploy/reset-data.sql` to
`deploy/migrate/manifest.txt`.

## 9. Meglévő adatok áthozása a felhős Supabase-ből (haladó)

Az új telepítés üres adatbázissal indul, amelyben csak a migrációk demó adatai vannak. Ha a jelenlegi, felhős rendszer felhasználóit, jelentkezéseit és dokumentumait is át kell hozni, azt külön lépésben, előbb tesztszerveren kipróbálva végezd:

1. A hivatalos útmutató: https://supabase.com/docs/guides/self-hosting/restore-from-platform
2. A `migrate` felismeri a visszaállított adatbázist: van benne `public.profiles`, de nincs nyilvántartás. Ilyenkor **nem futtat migrációt** (a 01-es táblákat dobna el), csak nyilvántartásba veszi a migrációkat (*baseline*). A demó fiókokat ilyenkor is lezárja.
3. A feltöltött fájlokat (a `documents`, `avatars` és `dorm-photos` tárolókat) külön kell átmásolni.
4. Utána ellenőrizd a Studio SQL-szerkesztőjében:
   ```sql
   -- regisztrációs triggerek: on_auth_user_created, on_auth_user_created_legal
   select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
   -- a tárolók hozzáférési szabályai: avatars_*, documents_*, dorm_photos_*
   select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects';
   ```
   Ha valamelyik hiányzik, a regisztráció vagy a fájlfeltöltés nem fog működni.

Az áthozott mentés személyes adatokat tartalmaz: kezeld a GDPR szerint.

## 10. Hibaelhárítás

| Tünet | Teendő |
|---|---|
| A `docker compose` a `.env` hiányára panaszkodik | Még nem futott az `./init-env.sh`. |
| `./init-env.sh: Permission denied` | A csomagot nem a szerveren bontották ki. Futtasd: `chmod +x init-env.sh deploy/*.sh`. |
| `migrate` → `exited (1)` | `docker compose logs migrate`: kiírja a hibás fájlt és az SQL-hibát. A javítás után `docker compose up -d`. |
| A `web` nem indul | Megvárja a `migrate` sikeres lefutását és az `api-gw` egészséges állapotát: `docker compose ps`. |
| „HIBA: a .env titkai nincsenek kitöltve” | A `.env`-ben `CHANGE_ME` maradt. Új telepítésnél töröld a `.env`-et, és futtasd újra az `./init-env.sh`-t. |
| Nem jön meg a jelszó-visszaállító levél | Ellenőrizd az SMTP-beállításokat és a `docker compose logs auth` kimenetét. Ha a napló *template*-hibát ír, a `web`-nek futnia kell (onnan jön a sablon). |
| A levélben kapott link „lejárt” | A link egyszer használható, és egy idő után lejár: kérj újat. |
| A valós idejű frissítés nem működik a proxy mögött | A proxynak a WebSocketet is át kell engednie (`Upgrade`/`Connection` fejléc, 5. pont). |
| Foglalt a 8080-as port | A `.env`-ben állítsd be: `UNIPORTAL_HTTP_PORT=8081`, majd `docker compose up -d`. |
| Minden elölről (**ADATVESZTÉS!**) | `docker compose down`, majd `sudo rm -rf deploy/supabase/volumes/db/data deploy/supabase/volumes/storage`, végül `docker compose up -d`. A `.env` maradhat. |

## 11. Biztonsági ellenőrzőlista éles indulás előtt

- [ ] A `.env` jogosultsága 600, nincs gitben, és benne van a mentésben.
- [ ] Kívülről csak a HTTPS-proxy érhető el (tűzfal). A 8000, 5432 és 6543-as port csak a 127.0.0.1-en figyel.
- [ ] Az SMTP működik, és `ENABLE_EMAIL_AUTOCONFIRM=false`.
- [ ] `UNIPORTAL_DEMO_ACCOUNTS=lock`, és a `migrate` naplójában szerepel: „Lezárva: 5 demó fiók”.
- [ ] Van rendszergazda, és a `superadmin_email()` címe rendben van.
- [ ] Az ütemezett mentés fut, és a visszaállítást kipróbáltátok.
- [ ] Az adatkezelési tájékoztató és a felhasználási feltételek (`privacy.html`, `terms.html`) `[kitöltendő]` helyei ki vannak töltve.
- [ ] `UNIPORTAL_TRUSTED_PROXY` be van állítva, és a `docker compose logs web` a valós ügyfél-címeket mutatja, nem a proxyét. Enélkül a sebességkorlát mindenkit egy vödörbe tesz.
- [ ] A `migrate` naplójában nincs „FIGYELEM: a UniPortal compose-réteg NEM töltődött be”.
- [ ] A `migrate` naplójának biztonsági önellenőrzése (`--- UniPortal biztonsagi onellenorzes ---`) nem ír FIGYELEM sort.
- [ ] `WHATSAPP_APP_SECRET` és `WHATSAPP_VERIFY_TOKEN` ki van töltve — különben a webhook szándékosan nem üzemel (503).
- [ ] Néhány perc valódi használat után a `docker compose logs web | grep limiting` üres (a korlát nem akadályozza a normál munkát).
- [ ] A szerver és a Docker frissítései ütemezve vannak.

## 12. Ismert korlátok

- **CDN-függés:** a felhasználók böngészője néhány könyvtárat nyilvános CDN-ről tölt: cdn.jsdelivr.net (supabase-js, PDF-előnézet), cdn.tailwindcss.com, unpkg.com (ikonok), fonts.googleapis.com (betűtípus). Zárt hálózaton ezeket helyben kellene kiszolgálni.
- **Demó adatok:** a 01-es migráció bemutató adatokat is betölt (ügynökségek, hallgatók, számlák, kampányok stb.). Ezek a mostani éles rendszerben is látszanak. A demó *fiókokat* a `migrate` lezárja, de az adatok eltávolítása külön feladat.
- **WhatsApp:** a `whatsapp-send` és `whatsapp-webhook` függvények a `.env` `WHATSAPP_*` soraival működnek; ha üresek, a WhatsApp-küldés nem működik. A Meta webhook címe: `https://<domain>/functions/v1/whatsapp-webhook`. A `WHATSAPP_APP_SECRET` és a `WHATSAPP_VERIFY_TOKEN` **kötelező**: e kettő nélkül a webhook szándékosan nem üzemel (503-at ad). Korábban ilyenkor átengedte az aláírás nélküli kéréseket is (hitelesítetlenként jelölve) — vagyis bárki írhatott az ügyintézői beérkezett mappába. A beállítás után futtasd: `docker compose up -d`.
- **A `dorm` séma a REST API-n is kint van:** a `.env` `PGRST_DB_SCHEMAS` sora `public,graphql_public,dorm` (a hivatalos alapértelmezés csak `public,graphql_public`), és a 26-os migráció `grant select on all tables in schema dorm to authenticated`-et ad. Így van rendjén — a felület közvetlenül a `dorm` sémából olvas (`features/dorm.jsx`, `features/dorm-views.jsx`) —, és minden `dorm` táblán be van kapcsolva az RLS, tehát ez nem nyitott ajtó. A `dorm` policy-k viszont abban a feltevésben készültek, hogy a sémát csak a saját RPC-ken át érik el; **érdemes egyszer átnézni őket abból a szemszögből, hogy bármelyik tábla közvetlenül is lekérdezhető.**
- **Levélsablonok:** csak a jelszó-visszaállító levél magyarított, a többi a Supabase alap angol sablonja.

## 13. Csak a felület, a felhős Supabase-szel

Ha csak a felületet kell konténerben futtatni, és az adatok a felhős Supabase-projektben maradnak:

```sh
docker compose -f deploy/frontend-only.compose.yml up -d --build
```

Ekkor a Supabase Dashboardon (*Authentication → URL Configuration*) az új címet fel kell venni a Redirect URLs közé.

## Fejlesztőknek

- **Új migráció:** hozd létre a `supabase/NN_leiras.sql` fájlt, **és** vegyél fel egy sort a `deploy/migrate/manifest.txt`-be (a sorrend számít). Lefutott migrációt ne módosíts, hanem írj újat.
- **Edge Functions:** a függvények közvetlenül a `supabase/functions/<név>` könyvtárból futnak; a `deploy/compose.uniportal.yml` csatolja őket a functions-konténerbe. Új függvénynél vegyél fel oda egy újabb `volumes` sort.
- **Supabase-verzió emelése:** írd át a REF-et a `deploy/vendor-supabase.sh`-ban, és futtasd. Utána vesd össze a `deploy/supabase/.env.example`-t a gyökér `.env.example`-lel, és próbáld ki tesztszerveren.
- **Felület:** a Docker-kép maga csomagolja (`npm ci` + `node build.mjs`). A GitHub Pages-hez továbbra is a commitolt `app.bundle.js` kell.
- **Futásidejű beállítás:** a `config.js`-t a web-konténer induláskor írja (`deploy/web/40-uniportal-config.sh`). GitHub Pages-en a tárolóbeli, üres `config.js` töltődik be, és az oldalak a felhős címet használják.
