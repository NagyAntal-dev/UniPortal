# 72_rbac_actions.sql — mit futtass, és mi történik

## Amit futtatni kell

A `migrate` szolgáltatás magától lefuttatja (`deploy/migrate/manifest.txt`).
Kézzel: **Supabase → SQL Editor → új query → a teljes `supabase/72_rbac_actions.sql`
beillesztése → Run.** Egyetlen, másolható blokk. Idempotens: ha kétszer futtatod, nem hibázik.

## Mit csinál

| | |
|---|---|
| Létrehoz | 5 táblát: `rbac_action`, `module_definition`, `role_module_permission`, `rbac_setting`, `rbac_permission_audit` |
| Létrehoz | 13 függvényt: `rbac_can`, `rbac_can_any`, `rbac_require`, `rbac_can_role`, `my_module_permissions`, `role_action_set`, `role_module_actions_set`, `role_matrix`, `module_save`, `rbac_enforce_set`, `rbac_enforce_state`, `rbac_actions_rollback` (+ átírja a 39-es kettőjét) |
| Feltölti | **26 modult** (az `app.jsx` `MENU_ITEMS`-e) és **5 műveletet** (VIEW, USE, CREATE, EDIT, DELETE) |
| Átkötit | a 39-es `my_role_permissions()` és `role_permission_set()` az új mátrixra |
| **Nem** kényszerít ki | SEMMIT. A kikényszerítés a 73-as (restriktív RLS) és a 74-es (RPC-őrök) dolga. |
| **Nem** dobja el | a `role_permission` táblát, és nem nyúl a 86 permisszív `rbac_` policy-hez |
| **Nem** érinti | az `echo.role_grant` / `dorm.role_grant` dimenziót, sem a másik alkalmazás tábláit (`prefs`, `publications`, `publication_files`) |

## Miért biztonságos most lefuttatni — mérve, nem feltételezve

A migráció önmagában **nem kényszerít ki semmit**: se restriktív policy-t nem tesz fel, se
RPC-t nem őriz. Amit hoz, az adat és néhány függvény, amiket még senki nem hív.

A mátrix kezdőállapota ráadásul **bitre a mai viselkedés**. A 4. szakasz backfillje három
forrásból dolgozik:

1. a `role_permission` sorokból (a mai menü-láthatóság) → `VIEW` **és** `USE`;
2. a menüszűrő **kódba égetett** ágaiból (`app.jsx:12583-12650`) → azok a modulok, amelyeket
   a `role_permission` nem tud (Kurzusok, Oktatók, ECHO, Szállásom);
3. a mai RLS- és RPC-kapukból → `CREATE` / `EDIT` / `DELETE`, soronként odaírt indoklással.

Ezt `pglite`-on lemértük, a repó valódi DDL-jével (a `private-imports/validation/check.mjs`
mintájára). A 39-es seedje szerint ma **48** szerepkör–menüpont pár van; a migráció után
egyetlen olyan sem maradt, amelyhez ne tartozna `VIEW` jog:

```
OK  72_rbac_actions.sql
OK  72_rbac_actions.sql (2. futás — idempotencia)
OK  mind a 48 mai menüpont megkapta a VIEW jogot
OK  a SUPERADMIN-nak nincs sora (nem elvehető)
OK  nincs hatás nélküli jog a mátrixban
OK  26 modul, 5 művelet, a kikényszerítés bekapcsolva
OK  ADMIN:      23 mai menüpont -> 26 VIEW
OK  ADMISSIONS: 10 mai menüpont -> 15 VIEW
OK  FINANCE:     6 mai menüpont -> 11 VIEW
OK  AGENT:       5 mai menüpont ->  5 VIEW
OK  STUDENT:     4 mai menüpont ->  7 VIEW
```

A „több VIEW, mint mai menüpont" **nem hiba, hanem a 2. forrás**: az ADMISSIONS ma is látja a
Kurzusokat, az Oktatókat, a Kurzusértékelést, az Oktatói eredményeket és a Szállásomat —
csak nem a `role_permission`-ból, hanem kódba égetett ágból. A mátrixban ez most látszik is.

## Amit tudni kell, mielőtt bárki hozzányúl

### A SUPERADMIN hozzáférése nem szerkeszthető
Nem óvatoskodásból. Ha elvehető lenne, a szuperadmin ki tudná zárni magát abból a
képernyőből is, amivel visszaállítaná — és nem maradna út vissza. Ezért a `SUPERADMIN`-nak
**egyetlen sora sincs** a mátrixban, a `rbac_can()` nála a táblát meg sem nézi, és a
`role_action_set` / `role_module_actions_set` **hibával elutasítja** a `SUPERADMIN`-t.

### Két külön tengely, és ez szándékos
A `role_module_permission` **nem** a menü. Egy szerepkör kaphat `CREATE` jogot olyan modulon,
ami a menüjében nem szerepel. A legfeltűnőbb eset: a **FINANCE** megkapja az
`admissions_core:CREATE/EDIT/DELETE`-et, `VIEW` nélkül.

Ez nem elírás. A `rbac_students_insert` policy `is_staff()`-ot kér, és az `is_staff()`
**tartalmazza a FINANCE-t** (`11_rbac_additive.sql:295`) — a `markPaymentPaid` a
`students.status`-t is írja, tehát a pénzügy hozzáér a jelentkezői sorhoz. Ha a FINANCE nem
kapná meg ezt a jogot, a 73-as bevezetése **elvenné** tőle a befizetés-rögzítést.

Konstrukcióból biztonságos: a permisszív `rbac_` réteg a **padló**, a restriktív `rbacx_`
réteg csak **kivonni** tud. Egy modul-jog tehát nem ad hozzáférést, csak nem vesz el.

### A vészkapcsoló
`select public.rbac_enforce_set(false);` — egyetlen sort állít át, és ezzel **mindkét**
kikényszerítési réteg kinyílik (a restriktív RLS és az RPC-őrök is, mert mindkettő a
`rbac_can()`-ra épül). Se DDL, se zárolás, se deploy, se PostgREST-újratöltés.
Visszakapcsolás: `select public.rbac_enforce_set(true);`
Az állása: `select public.rbac_enforce_state();`

Ha a `rbac_setting` maga a hiba, a következő lépés a `75_rbac_actions_rollback.sql` — az
eldobja a `rbacx_` policy-ket és kiveszi a 74-es RPC-őröket. Szándékosan **nem** a manifestben, a `13_rbac_rollback.sql`
precedense szerint.

## Visszavonás

```sql
select public.rbac_actions_rollback();
```

**Fontos, és ezért van benne külön ellenőrzés:** a visszavonás nem csak táblákat dob el. A
72-es 5. szakasza **átírta** a 39-es `my_role_permissions()` és `role_permission_set()`
törzsét, hogy az új mátrixot olvassák. Ha csak a táblák tűnnének el, a menü egy nem létező
táblára hivatkozó függvényt hívna, és **mindenki nulla menüpontot kapna** — a visszavonás
rontana, nem javítana. Ezért a függvény **először visszaírja a 39-es eredeti törzseit**, és
csak utána dob el bármit.

A `rbac_permission_audit` naplót **szándékosan meghagyja**: egy visszavonás nem törölhet
naplót.

Ha a 73-as (`rbacx_` policy-k) vagy a 74-es RPC-őrei még élnek, a visszavonás **megtagadja magát** — enélkül
kihúzná a policy-k alól a `rbac_can()`-t, és minden lekérdezés elhasalna
*„permission denied for function"*-nal. Ilyenkor előbb a `75_rbac_actions_rollback.sql`.

A teljes telepítési sorrend **72 → 74 → 73**. A SUPERADMIN-ellenőrzést kérő
függvények alkalmazásos munkamenetből hívhatók; a SQL Editor tulajdonosi
kapcsolata önmagában nem ad SUPERADMIN profilazonosítót. A 75-ös fájlt viszont
adatbázis-tulajdonosként kell futtatni. Részletes eljárás:
[DEPLOY.md](../../DEPLOY.md#muveleti-rbac).

A 72-es backfillje egyszer fut: az `rbacx_backfill_complete` beállítás után
az újrafuttatás nem adja vissza a szándékosan elvett műveleti jogokat.
Az új RLS- és rollback-mérések: [72_meresi_jelentes.md](72_meresi_jelentes.md).

## Ellenőrzés

`supabase/diagnostics/72_ellenorzes.sql` — objektumok, szerepkörönkénti összesítés, a
„nem vett el semmit" bizonyítás, és a teljes mátrix `V U C E D` betűkkel kirajzolva.
