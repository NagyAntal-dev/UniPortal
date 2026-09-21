# RBAC jogosultsági réteg - állapot

Git-alapú állapotfelmérés: 2026-09-18. A bejelölt elemekhez tartozó kód vagy migráció megtalálható a jelenlegi, még nem commitolt munkafában. A futtatást, éles migrációt és teljes kézi szerepkörtesztet külön nyitva hagytam.

Folytatás, 2026-09-18: a 73-as korábban csak fejlécet tartalmazott, és nem volt
a manifestben; most 49 restriktív policy-t telepít 20 táblára. Elkészült a 75-ös
kézi rollback és a helyi mérés. Részletek és korlátok:
`supabase/diagnostics/72_meresi_jelentes.md`. Éles adatbázist nem módosítottunk.

## 1. blokk - adatbázis alap

- [x] `supabase/72_rbac_actions.sql`: névütközés-ellenőrzés, táblák, seedek és a jogosultsági függvények.
- [x] 72: a korábbi jogosultságok backfillje, kompatibilis `my_role_permissions()` / `role_permission_set()` átkötés és admin RPC-k.
- [x] 72: RLS, auditnapló, SUPERADMIN-védelem és `rbac_actions_rollback()`.
- [x] 72: egyszeri backfill; újrafuttatás nem adja vissza az elvett jogokat. Rollback után az RPC-réteg állapotjelzője az aktív őröket követi.
- [x] 72: verifikációs lekérdezések, `72_ellenorzes.sql`, `72_pglite_ellenorzes.mjs` és `72_OLVASSEL.md`.
- [x] `deploy/migrate/manifest.txt`: a 72-es migráció felvéve.
- [x] `deploy/reset-data.sql`: az új RBAC-táblák megőrzése reset közben.
- [ ] Migráció futtatása cél Supabase-adatbázison és `reset-data.sh` előnézeti ellenőrzése.

## 2. blokk - felület

- [x] `features/perm.jsx`: `PERM_can`, `PERM_of`, `PERM_Gate` és `PERM_Denied`, migráció előtti fail-open viselkedéssel.
- [x] `build.mjs` és `app.html`: `features/perm.jsx` betöltése.
- [x] `app.jsx`: `my_module_permissions()` betöltése, `canSeeView()` és tiltott nézethez `PERM_Denied`.
- [x] `features/roles.jsx`: valódi `ROLE_Matrix`, műveletmátrix és tömeges sor-/oszlopműveletek.
- [x] `app.jsx`: SystemAdmin a valódi mátrixot és a felhasználói kontextust kapja.
- [x] `features/registrations.jsx`: adatvezérelt kiosztható szerepkörök és szerepkörszínek.
- [x] `app.jsx`: új i18n feliratok és `data-no-i18n` a dinamikus nevekhez.
- [ ] Bejelentkezési és mátrix-módosítási végponttól végpontig teszt mind a hat szerepkörrel, valamint egy saját szerepkörrel.

## 3. blokk - hibák láthatóvá tétele

- [x] `features/data-layer.jsx`: engedélymegtagadáskor dob hibát, nem vált localStorage-fallbackre; hiányzó tábla esetén a fallback megmarad.
- [x] A közös data-layer hívóhelyeinek hibakezelése (`feed`, `programs`, `knowledge-base` az `assistant` nézetben, `student-calendar`): olvasási hiba is látszik, sikertelen mentés után megmarad a szerkesztő és a lépés.
- [x] `tools/data_layer_regresszio.mjs`: 37 automatikus ellenőrzés, köztük probe/olvasás/írás megtagadása, nulla érintett sor, hálózati hiba és hiányzó tábla.
- [x] `tools/program_save_regresszio.mjs`: sikertelen mentés után nincs lépésváltás vagy beadás; a beadó RPC dobott hibája is látszik.
- [ ] Szándékosan elvett joggal mentési hiba tesztelése élő böngészős munkamenetben.

## 4. blokk - akciószintű felületi tiltás

- [x] `app.jsx`: felvételi, pénzügyi, vízum- és értékelési akciók `PERM_can` / `PERM_of` alapúak.
- [x] Érintett modulokban jogosultság-alapú CREATE / EDIT / DELETE kapuk: `agency`, `courses`, `feed`, `programs`, `registrations`, `student-calendar`, `teachers` és a közös data layer.
- [x] `assistant`: külön CREATE/DELETE kapu; `programs`: külön CREATE/EDIT, a Képzések `trainings` joga a szerveroldali katalógus-policy-ban is érvényesül.
- [ ] Minden érintett modulban elvett műveleti jog UI- és szerveroldali ellenőrzése.

## 5. blokk - RPC-őrök

- [x] `supabase/74_rbac_enforce_rpc.sql`: RPC-szándéktábla és a kiválasztott írási RPC-k `rbac_require()` őrzése.
- [x] `deploy/migrate/manifest.txt` és `deploy/migrate/verify.sql`: 74-es migráció és az őröket ellenőrző linter.
- [x] `supabase/diagnostics/74_pglite_ellenorzes.mjs` és `tools/perm_regresszio.mjs`: automatizált ellenőrzési alap.
- [ ] Jogosultság nélküli és jogosultsággal futó RPC-k, valamint `make-superadmin.sh` / `reset-data.sh` kézi validálása.

## 6. blokk - restriktív RLS

- [x] `supabase/73_rbac_enforce_rls.sql`: előfeltétel-kapu, táblamodul-leképezés és restriktív `rbacx_` policy-k.
- [x] `deploy/migrate/manifest.txt` és `deploy/migrate/verify.sql`: 73-as migráció és a policy-k katalógusellenőrzése.
- [x] `supabase/75_rbac_actions_rollback.sql`: külön, tranzakciós kézi rollback, a manifesten kívül; policy-k és RPC-őrök bontása, napló/mátrix megőrzése.
- [x] `supabase/diagnostics/72_meresi_jelentes.md`: helyi PGlite előtte-utána jelentés és a mérés korlátai.
- [x] `73_pglite_ellenorzes.mjs`: 1408 szerepkör/tábla/művelet/tulajdonos eset és 24 képzéses eset; 49 jog elvétele/visszaadása, vészkapcsoló, előfeltételek, idempotencia és rollback.
- [x] `74_pglite_ellenorzes.mjs`: mind a 26 RPC őrének pontos bontása, módosított őrnél atomikus hiba, újratelepítés; 72-es rollback megtagadása élő RPC-őr mellett.
- [ ] Teljes sémájú helyi replikán és cél Supabase-on szerepkör-imitációs RLS-vizsgálat, valamint az élő vészkapcsoló tesztje.

## 7. blokk - 2. fázis

- [ ] Önkiszolgáló táblák bevonása ko-modulos `rbac_can_any(...)` szabállyal; külön termékdöntés után.

## 8. blokk - zárás

- [x] `README.md` és `DEPLOY.md`: az új jogosultsági réteg, a telepítési sorrend és a rollback folyamata dokumentálva.
- [ ] Teljes friss telepítéses végigjátszás hat alap- és egy saját szerepkörrel.

## Módosított fájlok a jelenlegi Git munkafában

### Új fájlok

- `features/perm.jsx`
- `supabase/72_rbac_actions.sql`
- `supabase/73_rbac_enforce_rls.sql`
- `supabase/74_rbac_enforce_rpc.sql`
- `supabase/75_rbac_actions_rollback.sql`
- `supabase/diagnostics/72_meresi_jelentes.md`
- `supabase/diagnostics/72_OLVASSEL.md`
- `supabase/diagnostics/72_ellenorzes.sql`
- `supabase/diagnostics/72_pglite_ellenorzes.mjs`
- `supabase/diagnostics/73_pglite_ellenorzes.mjs`
- `supabase/diagnostics/74_pglite_ellenorzes.mjs`
- `tools/menu_regresszio.mjs`
- `tools/perm_regresszio.mjs`
- `tools/data_layer_regresszio.mjs`
- `tools/program_save_regresszio.mjs`

### Módosított fájlok

- RBAC és alkalmazáskeret: `app.jsx`, `app.html`, `app.bundle.js`, `build.mjs`
- Funkciók: `features/agency.jsx`, `features/assistant.jsx`, `features/courses.jsx`, `features/data-layer.jsx`, `features/feed.jsx`, `features/programs.jsx`, `features/registrations.jsx`, `features/roles.jsx`, `features/student-calendar.jsx`, `features/teachers.jsx`
- Telepítés és adatbázis: `deploy/migrate/manifest.txt`, `deploy/migrate/verify.sql`, `deploy/reset-data.sql`
- i18n diagnosztika: `supabase/diagnostics/i18n/.dicteval.mjs`, `supabase/diagnostics/i18n/covcheck.mjs`

<!-- Eredeti részletes végrehajtási lista; megőrizve hivatkozásként.

 Todo-lista (végrehajtási sorrend)

     A blokkok sorrendje szándékosan olyan, hogy minden blokk után működő rendszer legyen, és
     bármelyik után meg lehessen állni. A blokkon belüli sorrend kötött. A blokkok után az
     1. blokk önmagában nem változtat semmit, a 2. blokk után a mátrix már szerkeszthető és a
        menüt vezérli, a 3–4. blokk után a felület akció-szinten pontos, az 5–6. blokk a
        szerveroldali kikényszerítés.

     1. blokk — adatbázis alap (nincs felületi hatás)

     - [ ] supabase/72_rbac_actions.sql — 0. szakasz: névütközés-előellenőrzés.
     - [ ] 72 — 1. szakasz: module_definition, rbac_action, role_module_permission,
        rbac_permission_audit, rbac_setting táblák + CHECK-ek + kommentek.
     - [ ] 72 — 2. szakasz: a 27 modul seedje (MENU_ITEMS + MENU_GROUPS szerint), modulonként
        az értelmes actions listával; az 5 művelet seedje; rbacx_enforce = 'on'.
     - [ ] 72 — 3. szakasz: rbac_can() (a vészkapcsoló 0. ágával), rbac_can_any(),
        rbac_require(), rbac_can_role(), my_module_permissions(), rbac_enforce_set().
     - [ ] 72 — 4. szakasz: backfill, soronkénti indoklással (role_permission → VIEW+USE;
        ADMIN → mind; a kódba égetett menülisták beemelése; CREATE/EDIT/DELETE a mai RLS/RPC
        szerint, a szemantikailag furcsa cellák mellé írt magyarázattal).
     - [ ] 72 — 5. szakasz: my_role_permissions() és role_permission_set() átkötése az új
        táblára (visszafelé kompatibilitás).
     - [ ] 72 — 6. szakasz: admin RPC-k (role_action_set, role_module_actions_set,
        role_matrix, module_save) + napló-írás + SUPERADMIN-tiltás.
     - [ ] 72 — 7. szakasz: RLS az új táblákon (select jóváhagyottnak, írás csak RPC-n át);
         a rbac_setting-en szigorúbban: using (public.is_superadmin()), anon-grant nélkül,
         napló-triggerrel. Függvény-grantok a házi rituálé szerint.
     - [ ] 72 — 8. szakasz: rbac_actions_rollback(), ami a 39-es my_role_permissions() és
         role_permission_set() eredeti törzsét is visszaírja.
     - [ ] 72 — 9. szakasz: verifikációs select-ek (mit / ertek / elvart / allapot), köztük a
         „minden szerepkör minden mai jogát megkapta" bizonyítás.
     - [ ] deploy/migrate/manifest.txt — 72_rbac_actions.sql a lista végére.
     - [ ] deploy/reset-data.sql — a hét új tábla felvétele a reset_keep listára. Ezt nem
         lehet későbbre hagyni: egy közbeeső adatnullázás elveszítené a mátrixot és a
         vészkapcsolót is.
     - [ ] supabase/diagnostics/72_OLVASSEL.md + 72_ellenorzes.sql.
     - [ ] Ellenőrzés: migráció lefuttatása, a 9. szakasz verifikációja zöld; majd
         deploy/reset-data.sh előnézet (-v apply=false), és a mátrix a listán marad.

     2. blokk — felület (a mátrix használható lesz)

     - [ ] features/perm.jsx — PERM_can / PERM_of / PERM_Gate / PERM_Denied, fail-open
         a mai kódba égetett logikára, ha user.perms == null.
     - [ ] build.mjs FEATURE_FILES és app.html:224 — features/perm.jsx felvétele a
         data-layer.jsx után. (Mindkettő, különben a no-build tartalék eltörik.)
     - [ ] app.jsx loadProfile — my_module_permissions() hívás → currentUser.perms.
     - [ ] app.jsx — canSeeView(user, viewId) kiemelése egyetlen függvénybe; a menüszűrő és a
         renderContent() is ezt hívja (a mai duplikáció megszüntetése). A VIEW előtt döntő
         biztonsági ágak bent maradnak.
     - [ ] app.jsx renderContent() — nem engedélyezett nézetre PERM_Denied, nem FeedView.
     - [ ] features/roles.jsx — ROLE_Matrix: modul × művelet táblázat MENU_GROUPS szerint
         csoportosítva, role_module_actions_set egy körútban, sor/oszlop „mind / semmi".
     - [ ] app.jsx SystemAdmin — user prop átadása (:12701), és a makett RBAC panel
         (:7238-7287) helyére a valódi ROLE_Matrix.
     - [ ] features/registrations.jsx — a kiosztható szerepkörök listája ma kódba égetett:
         REG_ASSIGNABLE_ROLES = ['STUDENT','AGENT','ADMISSIONS','FINANCE','ADMIN'] (:13) és
         REG_ROLE_LABEL (:15-18). Enélkül a mátrixban létrehozott saját szerepkört senkihez
         nem lehet hozzárendelni, tehát a rendszer nem lenne „működő". Mindkettő a
         role_definition táblából (aktív sorok, SUPERADMIN kizárva, nev a felirat,
         sorrend a rendezés). A szin oszlop ma egyetlen helyen sincs felhasználva — a
         szerepkör-jelvények színezésére itt kerül be.
     - [ ] app.jsx — i18n: az új magyar feliratok a HU_EN / HU_EN_PHRASES táblába; az
         adatvezérelt modul- és szerepkörnevek data-no-i18n="1".
     - [ ] Ellenőrzés: npm run build, bejelentkezés a hat szerepkörrel, a menü betűre
         változatlan; a mátrixban egy művelet elvétele után a gomb eltűnik; egy új, saját
         szerepkör létrehozható, jogosultságot kap, és egy fiókhoz hozzárendelhető.

     3. blokk — a csendes siker megszüntetése (a 4–5. blokk előfeltétele)

     - [ ] features/data-layer.jsx (:66-105) — dlInsert / dlUpdate / dlDelete:
         jogosultsági megtagadásnál (42501, update/delete utáni PGRST116,
         permission denied, row-level security) dobás, nem localStorage-fallback, és a
         DL_PROBE[table] érintetlenül hagyása. A táblahiány (42P01, PGRST205) marad fallback.
     - [ ] A hívóhelyek (features/feed.jsx, programs.jsx, knowledge-base.jsx,
         student-calendar.jsx) hibakezelésének ellenőrzése: a dobott hiba látszódjon.
     - [ ] Ellenőrzés: szándékosan elvett jog után egy mentés hibát mutasson, ne sikert.

     4. blokk — akció-szintű gombtiltás a felületen

     - [ ] app.jsx — a kódba égetett canEditStatus-ok (:1859, :3374) cserélése
         PERM_of(user,'admissions_core').edit-re; a TrackControls disabled hívások
         (:2094, :2129, :2144, :3770, :4184) prop-neve marad.
     - [ ] Modulonként: CREATE / EDIT / DELETE gombok PERM_of(...)-ra kötése. Ez nem
         gombonkénti munka: a feature modulok már ma is egyetlen, modul-szintű predikátumon
         keresztül döntenek, amit elég átdefiniálni — pl. features/feed.jsx:46-47
         FEED_szerkeszto (ma ['SUPERADMIN','ADMIN']) → PERM_can(user,'feed','CREATE'),
         FEED_ugyintezo → PERM_can(user,'feed','EDIT'). Ugyanez features/data-layer.jsx:203-204
         isAdmin / isStaff, features/dorm.jsx:235 DORM_isAdmin, és a
         features/agency.jsx / teachers.jsx / courses.jsx / registrations.jsx helyi
         predikátumai. (Mellékesen javítandó: a data-layer.jsx isAdmin/isStaff
         egyik sem tartalmazza a SUPERADMIN-t — latens hiba.)
         Sorrend a következmény szerint: finance → admissions_core → evaluation → feed →
         programs/trainings → courses/teachers → engagement_crm/marketing_leads →
         immigration → system_admin → registrations. A dorm_* és echo_* modulokon a
         saját grant-dimenzió marad az elsődleges — ott a modul-mátrix csak a VIEW-t adja.
         Mért terjedelem: includes(user.role) / indexOf(user.role) / user.role === /
         ['SUPERADMIN'…] alakú, kódba égetett szerepkör-ellenőrzés összesen 43 helyen, 14
         fájlban van (app.jsx 19, features/agency.jsx 7, teachers.jsx 4, a többi 1–2).
         Ez a blokk teljes terjedelme — nem nyílt végű.
         Amit NEM kell átírni: a „ki vagyok" típusú ellenőrzéseket, csak a „mit
         tehetek" típusúakat. Pl. features/agency.jsx:480-482 isAgent / isFinance azt
         dönti el, melyik perspektívát kapja a képernyő (ügynöki vs. pénzügyi nézet), nem azt,
         hogy szabad-e; :255 canDecide és :807 canDecide viszont jogosultság →
         PERM_can(user,'agent_portal','USE'). Ez a szétválasztás fájlonként végigolvasást
         igényel, nem kereső-cserét.
     - [ ] Ellenőrzés: minden érintett modulon egy művelet elvétele után a gomb letiltott,
         és a szerver ugyanarra 42501-et ad.

     5. blokk — 3. réteg: RPC-őrök (a kisebb kockázat, ezért ELŐBB)

     - [ ] supabase/74_rbac_enforce_rpc.sql — rbac_rpc_guard(proc_name, args_sig, module_kod,   action, aktiv) szándék-tábla + feltöltése a következmény szerint rangsorolt ~20
         írás-RPC-vel. Nem mind a 238-cal, és egyetlen public.echo_* / public.dorm_*
         függvénnyel sem (azoknak saját, külön seedelt hatókörös kapujuk van).
     - [ ] 74 — a ~20 függvény kézi kiegészítése: create or replace, a meglévő
         if not public.is_admin() then … end if; után egy sor:
         if not public.is_trusted_caller() then perform public.rbac_require('<modul>','<művelet>'); end if;
     - [ ] deploy/migrate/manifest.txt — 74_rbac_enforce_rpc.sql.
     - [ ] deploy/migrate/verify.sql — linter: minden aktív rbac_rpc_guard sorra
         pg_proc.prosrc ~ 'rbac_require\(''<modul>'',''<művelet>''' , mit / ertek / elvart /   allapot formában. Ez fogja meg, ha egy jövőbeli create or replace kihagyja az őrt.
     - [ ] Ellenőrzés: minden rbac_rpc_guard sorra jogosultság nélkül 42501, jogosultsággal
         a mai viselkedés; a make-superadmin.sh és a reset-data.sh továbbra is fut
         (is_trusted_caller() ág).

     6. blokk — 2. réteg: restriktív RLS (a nagyobb kockázat, ezért UTÓBB)

     - [ ] supabase/73_rbac_enforce_rls.sql — előfeltétel-kapu a 12_rbac_flip.sql mintájára
         (megtagadja a futást, ha a backfill nem teljes, vagy ha bármely leképezés önkiszolgáló
         műveletre esne).
     - [ ] 73 — rbacx_table_module leképezés-tábla + a ~55 rbacx_ restriktív policy 20
         táblán, (select public.rbac_can_any(...)) alakban. A per-művelet syntax betartása:
         for insert → csak with check, for delete → csak using.
     - [ ] 73 — a kimaradások soronkénti indoklással. Kimarad teljesen:
         admission_processes és process_messages S/I/U (a permisszív szabály
         is_approved() NÉLKÜL engedi a jelentkezőt — a rbac_can() jóváhagyást kér, tehát egy
         restriktív policy eltörné a jóváhagyás előtti intake-et), valamint "auditLogs"
         (minden szerepkör naplóz, és a tábla már ma append-only).
         Kimarad a restriktív SELECT mindenhol a users kivételével — a RETURNING-re is hat,
         a kódbázis pedig végig .insert().select().single() alakot használ.
     - [ ] supabase/75_rbac_actions_rollback.sql — vészvisszaállító fájl, nem a manifestben
         (a 13_rbac_rollback.sql precedense); a rbac_actions_rollback() bővítése a rbacx_
         policy-k eldobásával.
     - [ ] deploy/migrate/manifest.txt — 73_rbac_enforce_rls.sql; és
         deploy/migrate/verify.sql — rbacx_ policy-szám + „mind RESTRICTIVE" + „egyetlen
         rbacx_ policy sem anon/public szerepkörre".
     - [ ] Ellenőrzés — katalógusból: STUDENT és AGENT egyetlen önkiszolgáló műveleten sincs
         rbacx_ policy alatt (ez az 1. fázis fő, bizonyítható garanciája); a rbac_ permisszív
         réteg továbbra is 86 policy; echo/dorm sémában 0 policy.
     - [ ] Ellenőrzés — szerepkör-imitációval (set local role authenticated,
         set local request.jwt.claims, rollback) nyers insert/update/delete mind a 22 táblán,
         mind a hat szerepkörrel — a mai eredménnyel azonos. A Supabase-napló a hiteles forrás,
         nem a felület.
     - [ ] supabase/diagnostics/72_meresi_jelentes.md — a 11_meresi_jelentes.md precedense
         szerint: a szerepkör × tábla × művelet mátrix a helyi replikán
         (tools/replika_ujraepites.sh) a migrációk előtt és után, és a bizonyítás, hogy azonos.
     - [ ] rbac_enforce_set(false) / (true) kipróbálása élő felületen: a vészkapcsoló
         tényleg nyit és zár, PostgREST-újratöltés nélkül.

     7. blokk — 2. fázis (külön döntés, nem ennek a tervnek a része)

     - [ ] Az önkiszolgáló táblák bevonása rbac_can_any(array['admissions_core','student_portal'], …)
         ko-modul alakban. Előfeltétel: döntés arról, kell-e a rbac_can()-nak
         jóváhagyás-nélküli kivétel a student_portal modulra. Csak a 6. blokk mérése után.

     8. blokk — zárás

     - [ ] README.md / DEPLOY.md — az új jogosultsági réteg és a rollback-lépcső leírása.
     - [ ] Teljes végigjátszás: reset-data.sh utáni friss telepítés, mind a hat szerepkörrel,
         plusz egy saját szerepkörrel.
-->
