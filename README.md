# UniPortal Pro — Neumann János Egyetem

Nemzetközi felvételi és hallgatói menedzsment platform **demó**.
Statikus oldal (GitHub Pages) + **Supabase** (PostgreSQL, Auth, Storage, Realtime) backend.

**Élő demó:** https://kecskemetadatkozpont.github.io/UniPortal/

**Saját szerverre, Dockerrel:** lásd [DEPLOY.md](DEPLOY.md) — `./init-env.sh <cím>`, majd `docker compose up -d --build`.

> ⚠️ **Ez egy demó, nem éles rendszer.** Az adatbázisban kizárólag mintaadat van,
> a jelszavak nyilvánosak, és a hozzáférési szabályok szándékosan megengedőek.
> Valós személyes adatot ne vigyél fel.

---

## Belépés

A landing oldalon **Sign in**, majd válassz egy demó fiókot (egy kattintással kitölthető).

| Szerepkör | E-mail | Jelszó |
|---|---|---|
| Admin | `admin@uni.hu` | `Demo1234!` |
| Felvételi | `admissions@uni.hu` | `Demo1234!` |
| Pénzügy | `finance@uni.hu` | `Demo1234!` |
| Ügynök | `agent@globalstudy.com` | `Demo1234!` |
| Hallgató | `ammar@test.com` | `Demo1234!` |

Regisztrálni is lehet (jelentkezőként vagy ügynökként) — az új fiók automatikusan
kap `profiles` sort a `handle_new_user` triggeren keresztül.

---

## Mi van az oldalon

| URL | Tartalom |
|---|---|
| `/` (`index.html`) | Publikus landing page: pozicionálás, animált modul-demók, be-/regisztrálás |
| `/app.html` | A teljes alkalmazás — 12+ modul, szerepkör szerinti menüvel |
| `/Felveteli-Prototipus.html` | Külön, magyar nyelvű jelentkezői folyamat-prototípus (7 lépés, `localStorage`) |
| `/Felveteli-Fejlesztesi-ToDo.html` | A felvételi modul fejlesztési terve / ToDo dokumentum |

Modulok az appban: Hírfolyam · Programok · AI asszisztens · Ügynöki portál ·
Jelentkezés és felvételi · CRM · Pénzügy · Vízum és compliance · Bírálat ·
Interjúfoglalás · Marketing és lead · Hallgatói portál · Riportok · Intelligence ·
Rendszerkezelés. A fejlécben HU/EN nyelvváltó van.

---

## Architektúra

```
index.html   landing (Tailwind CDN + lucide UMD + supabase-js UMD)
app.html     app shell: importmap (React, lucide-react, recharts) + Supabase init
  └─ app.bundle.js      ← esbuild-del előfordítva (build lépés, lásd lentebb)
     ├─ app.jsx         a teljes alkalmazás (~9 400 sor, TSX)
     └─ features/       hírfolyam · programok · AI asszisztens · adatréteg · tudásbázis
supabase/               séma, seed, auth, storage, RLS migrációk
```

Nincs framework-build és nincs szerver: az app egyetlen ES-modul, amit a böngésző
tölt be. A React / lucide / recharts az `esm.sh`-ról jön az import map alapján.

### Miért van build lépés?

Eredetileg az `app.html` **futásidőben**, Babel standalone-nal fordította le az
577 KB-os `app.jsx`-et minden hideg betöltésnél (~3 MB CDN letöltés + több
másodperc fordítás). A `build.mjs` ezt egyszer, előre elvégzi esbuild-del:

```
app.jsx + feature modulok + React/lucide/recharts  →  app.bundle.js
1736 kB minified / 411 kB gzip, egyetlen kérés
```

A függőségek is bekerülnek a bundle-be. Külsőként hagyva a böngésző az
`esm.sh`-ról oldotta fel őket (a recharts d3/lodash fájával együtt):
**138 modul-kérés** sorosított waterfallban minden betöltéskor. Mérve:
bejelentkezés → app váz **1308 ms → 532 ms**, 160 → 21 kérés.

Az `app.html` megnézi, hogy létezik-e az `app.bundle.js`; ha nem (pl. sima
`python3 -m http.server` build nélkül), visszaesik a régi, Babel-es útra. Így a
demó akkor sem törik el, ha a build kimarad.

Az `app.html`-ben lévő import map megmarad: a build nélküli tartalék útnak
(Babel a böngészőben) továbbra is szüksége van rá.

> Mivel a Pages közvetlenül a `main` ágat szolgálja ki, az `app.bundle.js` be van
> commitolva — most már 1,7 MB-osan. Ha bekapcsolod a CI buildet (lásd *Deploy*),
> build artifact lesz belőle, és nem terheli a git-előzményeket.

---

## Helyi futtatás

```bash
npm install      # csak esbuild
npm run build    # app.bundle.js
npm run serve    # http://localhost:8000
```

Vagy build nélkül (lassabb betöltés, Babel a böngészőben):

```bash
python3 -m http.server 8000
```

`file://`-ből nem működik (ES-modulok + `fetch`), helyi szerver kell.

---

## Supabase backend

Projekt: `mdccyastwhzwtyukxlpk` (régió: eu-west-1). A kapcsolódási adatok
(Project URL + publikálható kulcs) az `index.html` és az `app.html` fejlécében
vannak — ezek szándékosan nyilvánosak, a védelmet a Row Level Security adja.

### Séma telepítése

Nulláról: **Supabase dashboard → SQL Editor → New query**, illeszd be a
[`supabase/00_setup_all.sql`](supabase/00_setup_all.sql) fájlt, majd **Run**.
Ez a 01–05 migráció összefűzött, egyben futtatható változata (23 tábla + auth
demo fiókok + storage bucket + realtime).

Lépésenként ugyanez:

| Fájl | Mit csinál | Állapot az élő projekten |
|---|---|---|
| `01_schema_and_seed.sql` | 14 tábla + demo adatok + ideiglenes RLS | ✅ telepítve |
| `02_auth_profiles.sql` | `profiles` tábla, sign-up trigger, 5 demo fiók | ✅ telepítve |
| `03_avatars_storage.sql` | `avatars` bucket + storage policy-k | ✅ telepítve |
| `04_admission_processes.sql` | megosztott jelentkezési folyamatok + üzenetek + realtime | ✅ telepítve |
| `05_features.sql` | hírfolyam, programok, jelentkezések, AI tudásbázis | ✅ telepítve |
| `06_harden_rls.sql` | anonim írás kikapcsolása | ✅ telepítve |
| `07_registration_approval.sql` | regisztráció-jóváhagyás + superadmin | ✅ telepítve |
| `08_documents_storage.sql` | jelentkezői dokumentumok Storage-ba (20 MB) | ✅ telepítve |
| `09_process_list_view.sql` | folyamatlista fájltartalom nélkül (teljesítmény) | ✅ telepítve |
| `10_whatsapp.sql` | WhatsApp üzenetek és kapcsolatok | ⛔ **még nem futott le** |

> **`05_features.sql` nélkül** a Hírfolyam / Programok / AI asszisztens modulok
> egy seed-elt `localStorage` tárolóra esnek vissza: működnek, de eszközönként
> külön adatot látnak. A migráció után minden élőben megosztott — a táblák
> üresen indulnak; az élő táblákba a frontend nem tölt automatikus demó adatot.
> A mintaadatok csak a helyi, `localStorage`-alapú előnézetben jelennek meg.

> A `programs` táblának **nincs `kind` oszlopa**, és nem is kell: a
> program/képzés kategória a `level`-ből származik (`PROG_kind()`). Ha új mezőt
> veszel fel a program-szerkesztőbe, előbb a `05_features.sql` sémáját bővítsd —
> a PostgREST minden ismeretlen kulcsra `PGRST204`-gyel elutasítja az írást.

### WhatsApp Business

A *Kommunikáció és CRM → WhatsApp* fül a Meta Cloud API-ra van kötve, két Edge
Functionön keresztül (`whatsapp-send`, `whatsapp-webhook`). Az access token
kizárólag szerveroldalon létezik; a webhook `X-Hub-Signature-256` HMAC-kel
hitelesíti a Metát. A beszélgetések a `wa_messages` táblában élnek, realtime
frissítéssel.

Telepítés és Meta-oldali teendők: [`supabase/functions/README.md`](supabase/functions/README.md).

A rendszer a Meta-fiók előtt is használható: ilyenkor az üzenet `simulated`
jelöléssel mentődik — a beszélgetés valódi és megosztott, csak nem megy ki.
A felület mindig kiírja, melyik állapotban van.

### Teljesítmény

A felvételi listák a `admission_process_list` **nézetből** olvasnak
(`09_process_list_view.sql`), nem közvetlenül a táblából. A nézet ugyanazokat a
sorokat adja, de a `data.docs` alól kiveszi a beágyazott fájltartalmat.

Enélkül a lista `select('*')`-ot futtatott a teljes `data` JSONB-re,
12 másodpercenként ismételve — mérve **12,5 MB / 3,6 mp** egyetlen lekérésre.
Ez volt az oka a „sokszor lassan tölt" jelenségnek. A megnyitott folyamat
teljes sorát az app külön, egyesével kéri le; a poll 60 mp-re ritkult, mert a
realtime feliratkozás (04-es migráció) úgyis azonnal értesít.

### Jelentkezői dokumentumok

A feltöltött dokumentumok a privát `documents` Storage bucketbe kerülnek
(`08_documents_storage.sql`), a folyamat JSONB mezőjében csak az elérési út
marad. **Felső határ dokumentumonként 20 MB** — a böngésző és a bucket
`file_size_limit`-je is ezt érvényesíti. Efölött a jelentkező hibaüzenetet kap,
és a korábban feltöltött fájlja érintetlen marad.

Ki mit lát: a jelentkező a saját `<auth.uid()>/…` mappáját, az ügyintézők
(`SUPERADMIN`, `ADMIN`, `ADMISSIONS`, `FINANCE`) mindenkiét — `public.is_staff()`.
Az olvasás rövid életű aláírt URL-lel történik, a bucket nem publikus.

> A `08` migráció előtt (vagy ha a Storage nem elérhető) a 4 MB alatti fájlok a
> régi módon, beágyazva mentődnek, hogy a demó ne törjön el; e fölött a
> jelentkező azt kapja, hogy a dokumentumtár nem érhető el. A régebbi,
> beágyazott dokumentumok továbbra is megnyithatók.

### Regisztráció, e-mail-megerősítés, jóváhagyás

Új fiók két kapun megy át, mielőtt használható lenne:

1. **Megerősített e-mail-cím.** Supabase Auth intézi; kapcsold be:
   Authentication → Sign In / Providers → Email → **Confirm email**.
   Megerősítés nélkül a belépés `Email not confirmed` hibával elutasítva.
2. **Superadmin jóváhagyás.** Minden regisztráció `approval_status='pending'`
   állapotban jön létre. A felhasználó be tud lépni, de a *Jóváhagyásra vár*
   képernyőnél megáll, és **egyetlen adatsort sem kap** — ezt nem a felület,
   hanem az RLS érvényesíti (`public.is_approved()` minden adattáblán).

**Superadmin:** `kecskemet.adatkozpont@gmail.com`. Ez az egyetlen fiók, amely
látja a *Regisztrációk* menüpontot. Még az `ADMIN` sem. Az e-mail-cím a
`public.superadmin_email()` függvényben van, egy helyen cserélhető.

A *Regisztrációk* nézet három füle:

| Fül | Mit lehet |
|---|---|
| **Jóváhagyásra vár** | jóváhagyás a végleges szerepkör megadásával, vagy elutasítás indoklással |
| **Felhasználók** | a **szerepkör bármikor átállítható** legördülőből; hozzáférés visszavonása |
| **Elutasítva** | utólagos jóváhagyás |

A saját sor zárolt (a superadmin nem tudja magát lefokozni), és `SUPERADMIN`
szerepkör a felületről nem osztható — azt a `superadmin_email()` dönti el. A
korlátozás nem csak felületi: a `profiles_protect_privileges` trigger minden
más fiók szerepkör-módosítását visszaírja, a nyers API-n keresztül is.

A superadmin fióknak egyszer regisztrálnia kell a felületen a fenti címmel — a
`handle_new_user` trigger felismeri, és azonnal `SUPERADMIN` + `approved`
állapotot ad neki. (Ha az e-mail nem érkezik meg, a fiók kézzel is
megerősíthető: Authentication → Users → a felhasználó → Confirm email.)

Önjóváhagyás nem lehetséges: a `profiles_protect_privileges` trigger
visszaírja a `role` / `approval_status` / `agencyId` / `studentId` mezőket, ha
nem superadmin módosít — a nyers PostgREST API-n keresztül is.

> ⚠️ **E-mail-kézbesítés:** a Supabase beépített levélküldője erősen
> korlátozott (óránként néhány levél) és tesztelésre való. Mielőtt valódi
> jelentkezők regisztrálnának, állíts be saját SMTP-t (Resend, SendGrid,
> Postmark…): Authentication → Emails → SMTP Settings.

> ℹ️ Ebben a Supabase projektben a `public.profiles` táblát **egy másik
> alkalmazás is használja** (publikációs/kutatói nyilvántartás — saját `status`,
> `is_researcher`, `affiliation` oszlopokkal). Ezért hívják az UniPortal mezőjét
> `approval_status`-nak: a másik alkalmazás `status` oszlopát nem olvassuk és
> nem írjuk. Ha a `profiles` sémáját bővíted, erre figyelj.

### Biztonság

A `01`-es migráció eredetileg `for all to anon, authenticated` policy-t tett a 14
demo táblára, ami — mivel a publikálható kulcs benne van a statikus oldal
forrásában — azt jelentette, hogy bejelentkezés nélkül is bárki írhatta/törölhette
a demo adatokat. A [`06_harden_rls.sql`](supabase/06_harden_rls.sql) ezt levette
`authenticated`-re; ellenőrizve: anonim olvasás üres tömböt ad, anonim írás
`42501`-gyel elutasítva, bejelentkezve viszont minden modul hiánytalanul működik.

Élesítés előtt mindenképp cserélendő: szerepkör-alapú RLS a jelenlegi
„mindenki mindent” policy-k helyett, és valódi jelszavak a demó fiókok helyett.

---

## Deploy

A Pages **közvetlenül a `main` ágat** szolgálja ki
(Settings → Pages → Source: *Deploy from a branch* → `main` / `root`), ezért az
`app.bundle.js` **be van commitolva**. Minden `app.jsx` / `features/` módosítás
után futtasd:

```bash
npm run build && git add app.bundle.js && git commit -m "rebuild" && git push
```

### Automatikus build (opcionális, ajánlott)

Hogy a bundle ne kézzel karbantartott artifact legyen, kapcsolható GitHub
Actions build. A kész workflow itt van: [`ci/github-pages.yml`](ci/github-pages.yml).

```bash
gh auth refresh -h github.com -s workflow   # a jelenlegi tokenben nincs workflow scope
mkdir -p .github/workflows && git mv ci/github-pages.yml .github/workflows/deploy.yml
echo 'app.bundle.js' >> .gitignore && git rm --cached app.bundle.js
git commit -am "CI build a Pages deployhoz" && git push
```

Utána: **Settings → Pages → Source: GitHub Actions**.

---

## Adatvédelem

- A repóban és a seed adatokban **nincs valós személyes adat**. A korábbi
  mintasorban szereplő valós e-mail-cím `tamas@test.com`-ra lett cserélve — a
  repóban és az élő adatbázisban egyaránt.
- A projekt eredeti forrásdokumentumai (`*.docx`, `*.pdf` — valós útlevélszámmal,
  banki adatokkal) `.gitignore`-ban vannak, és nincsenek ebben a repóban.
- A demó bemutatóra készült; ne vigyél fel rá valós jelentkezői adatot.
