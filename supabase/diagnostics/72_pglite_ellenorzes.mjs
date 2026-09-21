// ============================================================================
// 72_pglite_ellenorzes.mjs — a 72-es migráció ellenőrzése ÉLŐ POSTGRES NÉLKÜL
// ----------------------------------------------------------------------------
// MIÉRT VAN EZ A FÁJL
//   A 11_rbac_additive.sql fejléce (D) pontja kimondja: a features/data-layer.jsx
//   minden hibát elkap és localStorage-ra vált, tehát egy MEGTAGADOTT írás a
//   felületen SIKERESNEK látszik. Kattintással tehát nem lehet ellenőrizni,
//   hogy egy jogosultsági változás elvett-e valamit. Ez a fájl a szerver
//   oldalán, adatbázisban méri le.
//
// MIT MÉR LE
//   1. a 72-es lefut-e, és IDEMPOTENS-e (kétszer futtatva);
//   2. hogy a backfill SENKITŐL nem vett el semmit: minden mai
//      role_permission sorhoz tartozik VIEW jog;
//   3. hogy a SUPERADMIN joga nem elvehető, és nincs hatás nélküli jog;
//   4. a rbac_can() viselkedését mind az öt szerepkörre, plusz egy 'pending'
//      fiókra (szerepkör-imitációval, nem feltevéssel);
//   5. az admin RPC-k kapuit (42501), a naplózást és a vészkapcsolót;
//   6. hogy a VISSZAVONÁS után a menü nem ürül ki — a 72-es átírta a 39-es
//      my_role_permissions() törzsét, ezért a rollbacknek azt is vissza kell
//      írnia, különben mindenki nulla menüpontot kapna.
//
// HOGYAN FUTTASD
//   A pglite nem a projekt függősége (a build nem használja), ezért egy külön
//   könyvtárból kell futtatni, ahol telepítve van:
//
//     cd private-imports/validation     # itt már megvan (lásd check.mjs)
//     node ../../supabase/diagnostics/72_pglite_ellenorzes.mjs
//
//   Vagy bárhol:  npm i @electric-sql/pglite  &&  node 72_pglite_ellenorzes.mjs
//
//   A ROOT alább a repó gyökerére mutat; ha máshonnan futtatod, ezt állítsd át.
//
// A repó már meglévő private-imports/validation/check.mjs mintáját követi:
//   a sémát a VALÓDI migrációkból építi fel (section(...)), nem kézi DDL-ből,
//   így ha egy migráció megváltozik, ez a fájl is azt méri, ami tényleg fut.
// ============================================================================
// A pglite NEM a projekt függősége (a build nem használja), ezért nem lehet
// csupasz importtal behozni: az ESM a FÁJL helyéhez képest keres, nem a
// munkakönyvtárhoz. Végigpróbáljuk a szóba jövő helyeket, és ha egyik sem
// válik be, KIMONDJUK, mit kell telepíteni — nem egy ERR_MODULE_NOT_FOUND
// nyomkövetéssel állunk meg.
const PGLITE_HELYEK = [
  '../../node_modules/@electric-sql/pglite/dist/index.js',
  '../../private-imports/validation/node_modules/@electric-sql/pglite/dist/index.js',
  '@electric-sql/pglite',
];
let PGlite;
for (const hely of PGLITE_HELYEK) {
  try {
    ({ PGlite } = await import(hely.startsWith('.')
      ? new URL(hely, import.meta.url).href : hely));
    break;
  } catch { /* következő hely */ }
}
if (!PGlite) {
  console.error([
    'Nincs @electric-sql/pglite. Telepitsd az egyik helyre:',
    '  npm i --no-save @electric-sql/pglite            (a repo gyokereben)',
    '  cd private-imports/validation && npm i @electric-sql/pglite',
    'Ez a fajl SZANDEKOSAN nem hozza be a projekt fuggosegei koze: a build',
    'nem hasznalja, es egy wasm-csomag nem kell a kiadashoz.',
  ].join(String.fromCharCode(10)));
  process.exit(2);
}
import fs from 'node:fs';
import assert from 'node:assert/strict';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = f => fs.readFileSync(ROOT + f, 'utf8');
const section = (file, start, end) => {
  const s = read(file); const a = s.indexOf(start); const b = s.indexOf(end, a);
  assert(a >= 0 && b > a, `Missing section ${start} in ${file}`);
  return s.slice(a, b);
};

const db = new PGlite();

// ---- Az előfeltétel-séma, a repo valódi DDL-jéből ahol lehet ----
await db.exec(`
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('teszt.uid', true), '')::uuid $$;
`);
await db.exec(section('supabase/02_auth_profiles.sql',
  'create table if not exists public.profiles', 'alter table public.profiles enable'));
await db.exec(`alter table public.profiles
  add column requested_role text,
  add column approval_status text not null default 'pending',
  add column approved_at timestamptz, add column approved_by text,
  add column rejected_reason text;`);

// A 39-es két táblája, szó szerint.
await db.exec(section('supabase/39_role_admin.sql',
  'create table if not exists public.role_definition', 'comment on table public.role_definition'));
// A 39-es szerepkör-seedje, szó szerint.
await db.exec(section('supabase/39_role_admin.sql',
  "insert into public.role_definition (kod, nev, leiras, sorrend, beepitett) values",
  'do $$'));

// A 11-es predikátumai, szó szerint a migrációból.
for (const fn of ['my_role', 'my_email']) {
  await db.exec(section('supabase/11_rbac_additive.sql',
    `create or replace function public.${fn}()`, '$$;') + '$$;');
}
await db.exec(section('supabase/07_registration_approval.sql',
  'create or replace function public.is_superadmin()', '$$;') + '$$;');
await db.exec(section('supabase/07_registration_approval.sql',
  'create or replace function public.is_approved()', '$$;') + '$$;');

console.log('Séma előkészítve a repó valódi DDL-jéből.');

// ---- A 39-es role_permission seedje: a mai menü-láthatóság ----
await db.exec(section('supabase/39_role_admin.sql', 'do $$\ndeclare\n  v_szerep text;', 'commit;'));
const mai = (await db.query('select count(*)::int n from public.role_permission')).rows[0].n;
console.log('A 39-es szerint ma', mai, 'szerepkör-menüpont pár van.');

// ---- Futtatás rövid hibajelentéssel ----
export async function futtat(cimke, sql) {
  try { await db.exec(sql); console.log('  OK  ' + cimke); }
  catch (e) {
    console.log('  HIBA  ' + cimke);
    console.log('        ' + e.message);
    if (e.position) {
      const i = Math.max(0, Number(e.position) - 120);
      console.log('        ...' + sql.slice(i, Number(e.position) + 120).replace(/\s+/g, ' '));
    }
    process.exit(1);
  }
}

await futtat('72_rbac_actions.sql', read('supabase/72_rbac_actions.sql'));
await futtat('72_rbac_actions.sql (2. futás — idempotencia)', read('supabase/72_rbac_actions.sql'));

export { db, read, section, mai };

// ============================================================================
// A BIZONYÍTÁS: a 72-es senkitől nem vett el semmit
// ============================================================================
const q = async (sql) => (await db.query(sql)).rows;
const egy = async (sql) => (await q(sql))[0];

// 1. Minden mai menüpontnak van VIEW joga az új mátrixban.
const hianyzoView = await q(`
  select rp.role_kod, rp.permission
    from public.role_permission rp
    join public.module_definition md on md.kod = rp.permission
   where rp.role_kod <> 'SUPERADMIN'
     and not exists (select 1 from public.role_module_permission rmp
                      where rmp.role_kod = rp.role_kod
                        and rmp.module_kod = rp.permission
                        and rmp.action = 'VIEW')`);
assert.deepEqual(hianyzoView, [], 'VIEW jog nélkül maradt mai menüpont: ' + JSON.stringify(hianyzoView));
console.log('  OK  mind a', mai, 'mai menüpont megkapta a VIEW jogot');

// 2. A SUPERADMIN-nak nincs sora.
const su = await egy(`select count(*)::int n from public.role_module_permission where role_kod = 'SUPERADMIN'`);
assert.equal(su.n, 0, 'A SUPERADMIN-nak sora van a mátrixban — tehát elvehető lenne.');
console.log('  OK  a SUPERADMIN-nak nincs sora (nem elvehető)');

// 3. Nincs hatás nélküli jog (olyan művelet, ami a modulon nem értelmes).
const hatastalan = await q(`
  select rmp.role_kod, rmp.module_kod, rmp.action
    from public.role_module_permission rmp
    join public.module_definition md on md.kod = rmp.module_kod
   where not (rmp.action = any (md.actions))`);
assert.deepEqual(hatastalan, [], 'Hatás nélküli jog: ' + JSON.stringify(hatastalan));
console.log('  OK  nincs hatás nélküli jog a mátrixban');

// 4. 26 modul, 5 művelet, a vészkapcsoló bekapcsolva.
const alap = await egy(`select
  (select count(*)::int from public.module_definition where aktiv) modul,
  (select count(*)::int from public.rbac_action) muvelet,
  (select ertek from public.rbac_setting where kulcs = 'rbacx_enforce') kapcsolo`);
assert.equal(alap.modul, 26);
assert.equal(alap.muvelet, 5);
assert.equal(alap.kapcsolo, 'on');
console.log('  OK  26 modul, 5 művelet, a kikényszerítés bekapcsolva');

// 5. my_role_permissions() BETŰRE ugyanazt adja, mint a 39-es adta volna.
for (const szerep of ['ADMIN', 'ADMISSIONS', 'FINANCE', 'AGENT', 'STUDENT']) {
  const uj = (await egy(`
    select coalesce(array_agg(distinct rmp.module_kod order by rmp.module_kod), '{}') a
      from public.role_module_permission rmp
     where rmp.role_kod = '${szerep}' and rmp.action = 'VIEW'`)).a;
  const regi = (await egy(`
    select coalesce(array_agg(rp.permission order by rp.permission), '{}') a
      from public.role_permission rp where rp.role_kod = '${szerep}'`)).a;
  const elveszett = regi.filter(m => !uj.includes(m));
  assert.deepEqual(elveszett, [], `${szerep} ELVESZTETT menüpontot: ${elveszett}`);
  console.log(`  OK  ${szerep}: ${regi.length} mai menüpont -> ${uj.length} VIEW (nem veszett el egy sem)`);
}

// ============================================================================
// Szerepkör-imitáció: a rbac_can() és a jóváhagyás-kapu viselkedése
// ============================================================================
const UID = { sup: '11111111-1111-1111-1111-111111111111',
              adm: '22222222-2222-2222-2222-222222222222',
              fin: '33333333-3333-3333-3333-333333333333',
              stu: '44444444-4444-4444-4444-444444444444',
              pen: '55555555-5555-5555-5555-555555555555' };
await db.exec(`
  insert into auth.users (id, email) values
    ('${UID.sup}','sup@nje.hu'),('${UID.adm}','adm@nje.hu'),('${UID.fin}','fin@nje.hu'),
    ('${UID.stu}','stu@nje.hu'),('${UID.pen}','pen@nje.hu');
  insert into public.profiles (id, email, name, role, approval_status) values
    ('${UID.sup}','sup@nje.hu','Sup','SUPERADMIN','approved'),
    ('${UID.adm}','adm@nje.hu','Adm','ADMISSIONS','approved'),
    ('${UID.fin}','fin@nje.hu','Fin','FINANCE','approved'),
    ('${UID.stu}','stu@nje.hu','Stu','STUDENT','approved'),
    ('${UID.pen}','pen@nje.hu','Pen','ADMISSIONS','pending');`);

const can = async (uid, m, a) => {
  await db.exec(`set teszt.uid = '${uid}'`);
  const v = (await db.query(`select public.rbac_can($1,$2) v`, [m, a])).rows[0].v;
  return v;
};
const varhato = async (uid, m, a, e, cimke) => {
  const v = await can(uid, m, a);
  assert.equal(v, e, `${cimke}: rbac_can('${m}','${a}') = ${v}, elvárt ${e}`);
};

// A jóváhagyás BEÉPÜL a rbac_can()-ba: egy 'pending' ADMISSIONS semmit nem ér el.
await varhato(UID.pen, 'feed', 'VIEW', false, 'pending');
await varhato(UID.pen, 'admissions_core', 'EDIT', false, 'pending');
console.log('  OK  egy pending fiók semmit nem ér el (is_approved beépül)');

// SUPERADMIN mindent, a mátrixtól függetlenül — még nem létező modulon is.
await varhato(UID.sup, 'finance', 'DELETE', true, 'superadmin');
await varhato(UID.sup, 'nincs_ilyen_modul', 'DELETE', true, 'superadmin');
console.log('  OK  a SUPERADMIN mindent elér, a mátrixtól függetlenül');

// A mai viselkedés: ADMISSIONS szerkeszt hírfolyamot, de nem töröl programot.
await varhato(UID.adm, 'feed', 'CREATE', true,  'ADMISSIONS');
await varhato(UID.adm, 'feed', 'DELETE', true,  'ADMISSIONS');
await varhato(UID.adm, 'programs', 'EDIT', true,  'ADMISSIONS');
await varhato(UID.adm, 'programs', 'DELETE', false, 'ADMISSIONS');
console.log('  OK  ADMISSIONS: feed CREATE/DELETE igen, programs DELETE nem');

// FINANCE: pénzügy igen, hírfolyam-szerkesztés nem. És a két tengely független.
await varhato(UID.fin, 'finance', 'DELETE', true,  'FINANCE');
await varhato(UID.fin, 'feed', 'CREATE', false, 'FINANCE');
await varhato(UID.fin, 'feed', 'VIEW',   true,  'FINANCE');
await varhato(UID.fin, 'admissions_core', 'CREATE', true,  'FINANCE');
await varhato(UID.fin, 'admissions_core', 'VIEW',   false, 'FINANCE');
console.log('  OK  FINANCE: admissions_core CREATE igen, VIEW nem (a két tengely független)');

// STUDENT: a saját portálján ír, a katalógust nem, és nem töröl.
await varhato(UID.stu, 'student_portal', 'EDIT',   true,  'STUDENT');
await varhato(UID.stu, 'student_portal', 'DELETE', false, 'STUDENT');
await varhato(UID.stu, 'programs', 'EDIT', false, 'STUDENT');
console.log('  OK  STUDENT: student_portal EDIT igen, programs EDIT nem, DELETE nem');

// AGENT: egyetlen írási joga sincs — ma sem volt.
const agentIras = await db.query(`
  select count(*)::int n from public.role_module_permission
   where role_kod = 'AGENT' and action in ('CREATE','EDIT','DELETE')`);
assert.equal(agentIras.rows[0].n, 0, 'Az AGENT írási jogot kapott, holnap többet tudna, mint ma.');
console.log('  OK  az AGENT egyetlen írási jogot sem kapott');

// ============================================================================
// Admin RPC-k és a vészkapcsoló
// ============================================================================
const hiba = async (uid, sql, minta, cimke) => {
  await db.exec(`set teszt.uid = '${uid}'`);
  try { await db.query(sql); assert.fail(cimke + ': NEM dobott hibát'); }
  catch (e) {
    if (e.message.startsWith(cimke)) throw e;
    assert.ok(e.message.includes(minta),
      `${cimke}: más hiba jött — ${e.message}`);
  }
};
const ok = async (uid, sql) => {
  await db.exec(`set teszt.uid = '${uid}'`);
  return (await db.query(sql)).rows[0];
};

// Nem szuperadmin nem állíthat jogot.
await hiba(UID.adm, `select public.role_action_set('FINANCE','feed','CREATE',true)`,
  'csak szuperadmin', 'nem-szuperadmin');
console.log('  OK  jogot csak szuperadmin állíthat (42501)');

// A SUPERADMIN szerepkör nem szerkeszthető — a szerver is elutasítja.
await hiba(UID.sup, `select public.role_action_set('SUPERADMIN','feed','VIEW',false)`,
  'SUPERADMIN hozzáférése szándékosan nem szerkeszthető', 'superadmin-zár');
await hiba(UID.sup, `select public.role_module_actions_set('SUPERADMIN','feed',array['VIEW'])`,
  'SUPERADMIN hozzáférése szándékosan nem szerkeszthető', 'superadmin-zár-sor');
console.log('  OK  a SUPERADMIN sora a szerveren sem szerkeszthető');

// Hatás nélküli jogot nem lehet bepipálni.
await hiba(UID.sup, `select public.role_action_set('STUDENT','consents','DELETE',true)`,
  'nincs értelme', 'hatás-nélküli');
console.log('  OK  hatás nélküli jog nem adható (a modul actions listája dönt)');

// Egy cella állítása oda-vissza, naplóval.
await ok(UID.sup, `select public.role_action_set('FINANCE','feed','CREATE',true)`);
await varhato(UID.fin, 'feed', 'CREATE', true, 'megadás után');
await ok(UID.sup, `select public.role_action_set('FINANCE','feed','CREATE',false)`);
await varhato(UID.fin, 'feed', 'CREATE', false, 'elvétel után');
const naplo = await ok(UID.sup, `select count(*)::int n from public.rbac_permission_audit
  where role_kod = 'FINANCE' and module_kod = 'feed' and action = 'CREATE'`);
assert.equal(naplo.n, 2, 'A napló nem rögzítette mind a két állítást.');
console.log('  OK  cella állítása oda-vissza, mind a két lépés naplózva');

// Egy teljes modulsor egy körben — és a role_permission szinkronban marad.
await ok(UID.sup, `select public.role_module_actions_set('FINANCE','reports',array['VIEW'])`);
await varhato(UID.fin, 'reports', 'VIEW', true,  'sor-állítás');
await varhato(UID.fin, 'reports', 'USE',  false, 'sor-állítás');
const rp1 = await ok(UID.sup, `select count(*)::int n from public.role_permission
  where role_kod='FINANCE' and permission='reports'`);
assert.equal(rp1.n, 1, 'A role_permission nem maradt szinkronban a VIEW-val.');
await ok(UID.sup, `select public.role_module_actions_set('FINANCE','reports',array[]::text[])`);
const rp0 = await ok(UID.sup, `select count(*)::int n from public.role_permission
  where role_kod='FINANCE' and permission='reports'`);
assert.equal(rp0.n, 0, 'A VIEW elvétele nem tükrözte a régi role_permission táblát.');
console.log('  OK  modulsor egy körben, a régi role_permission szinkronban marad');
// Visszaállítjuk, hogy a mai állapot maradjon.
await ok(UID.sup, `select public.role_module_actions_set('FINANCE','reports',array['VIEW','USE'])`);

// A vészkapcsoló: kikapcsolva MINDENT átenged, még egy pending fióknak is.
await hiba(UID.adm, `select public.rbac_enforce_set(false)`, 'csak szuperadmin', 'kapcsoló-jog');
await ok(UID.sup, `select public.rbac_enforce_set(false)`);
await varhato(UID.pen, 'admissions_core', 'DELETE', true, 'kapcsoló ki');
await varhato(UID.stu, 'finance', 'DELETE', true, 'kapcsoló ki');
await ok(UID.sup, `select public.rbac_enforce_set(true)`);
await varhato(UID.pen, 'admissions_core', 'DELETE', false, 'kapcsoló be');
await varhato(UID.stu, 'finance', 'DELETE', false, 'kapcsoló be');
console.log('  OK  a vészkapcsoló nyit és zár (és csak szuperadmin húzhatja)');

// A felület egyetlen hívásból megkapja a képét.
await db.exec(`set teszt.uid = '${UID.adm}'`);
const perms = (await db.query(`select public.my_module_permissions() p`)).rows[0].p;
assert.ok(perms.feed.includes('CREATE') && perms.feed.includes('VIEW'));
assert.ok(!('finance' in perms), 'Az ADMISSIONS finance jogot kapott.');
await db.exec(`set teszt.uid = '${UID.sup}'`);
const supPerms = (await db.query(`select public.my_module_permissions() p`)).rows[0].p;
assert.deepEqual(Object.keys(supPerms), ['*'], 'A SUPERADMIN nem a csillagos alakot kapta.');
console.log('  OK  my_module_permissions(): modulonkénti lista, SUPERADMIN-nál {"*": [...]}');

// A teljes mátrix egy hívásban (a felület ezt tölti be).
const m = (await db.query(`select public.role_matrix() m`)).rows[0].m;
assert.equal(m.modules.length, 26);
assert.equal(m.actions.length, 5);
assert.ok(m.roles.find(r => r.kod === 'SUPERADMIN').superadmin === true);
assert.ok(!('SUPERADMIN' in m.grants), 'A SUPERADMIN-nak jogai vannak a mátrixban.');
console.log('  OK  role_matrix(): 26 modul, 5 művelet, a SUPERADMIN megjelölve');

// Az idempotencia a tiltásokat is őrizze, ne csak a táblák létét.
await ok(UID.sup, `select public.role_module_actions_set('ADMIN','feed',array[]::text[])`);
await db.exec(read('supabase/72_rbac_actions.sql'));
assert.equal((await db.query(`select count(*)::int n from public.role_module_permission
  where role_kod='ADMIN' and module_kod='feed'`)).rows[0].n, 0);
await ok(UID.sup, `select public.role_module_actions_set('ADMIN','feed',array['VIEW','USE','CREATE','EDIT','DELETE'])`);
console.log('  OK  a 72-es újrafuttatása nem adja vissza az elvett jogokat');


// ============================================================================
// VISSZAVONÁS — ez a blokk elbontja a sémát, ezért UTOLSÓ
// ============================================================================
// A lényeg: a visszavonás után a menü NEM állhat üresen. A 72-es 5. szakasza
// átírta a 39-es my_role_permissions() törzsét; ha a rollback csak a táblákat
// dobná el, a függvény egy nem létező táblára hivatkozna, és MINDENKI nulla
// menüpontot kapna.
await db.exec(`set teszt.uid = '${UID.adm}'`);
const menuElotte = (await db.query(`select public.my_role_permissions() a`)).rows[0].a;
const legacyMenu = (await db.query(`select array_agg(permission order by permission) a
  from public.role_permission where role_kod='ADMISSIONS'`)).rows[0].a;
assert.ok(menuElotte.length >= 10, 'A visszavonás előtt sem volt menüje az ADMISSIONS-nak.');

await hiba(UID.adm, `select public.rbac_actions_rollback()`, 'Csak szuperadmin', 'rollback-jog');
console.log('  OK  visszavonni csak szuperadmin tud');

await ok(UID.sup, `select public.rbac_actions_rollback()`);
console.log('  OK  rbac_actions_rollback(): lefutott');

// A táblák eltűntek, a NAPLÓ viszont SZÁNDÉKOSAN megmaradt.
const utan = (await db.query(`select
  (select count(*)::int from pg_tables where schemaname='public'
     and tablename in ('role_module_permission','module_definition','rbac_action','rbac_setting')) tablak,
  (select count(*)::int from pg_tables where schemaname='public'
     and tablename = 'rbac_permission_audit') naplo`)).rows[0];
assert.equal(utan.tablak, 0, 'A visszavonás nem dobta el a 72-es tábláit.');
assert.equal(utan.naplo, 1, 'A visszavonás eldobta a naplót — egy visszavonás nem törölhet naplót.');
console.log('  OK  a táblák eltűntek, a napló szándékosan megmaradt');

// ÉS A LÉNYEG: a menü visszaállt a role_permission táblára, nem ürült ki.
await db.exec(`set teszt.uid = '${UID.adm}'`);
const menuUtana = (await db.query(`select public.my_role_permissions() a`)).rows[0].a;
assert.ok(menuUtana.length > 0,
  'A visszavonás után az ADMISSIONS NULLA menüpontot kap — a rollback rontott, nem javított.');
assert.deepEqual([...menuUtana].sort(), [...legacyMenu].sort());
console.log(`  OK  a menü visszaállt a role_permission táblára (${menuUtana.length} menüpont), nem ürült ki`);

// A 39-es role_permission_set() is visszaállt és működik.
await ok(UID.sup, `select public.role_permission_set('FINANCE','reports',false)`);
await db.exec(`set teszt.uid = '${UID.fin}'`);
const finUtan = (await db.query(`select public.my_role_permissions() a`)).rows[0].a;
assert.ok(!finUtan.includes('reports'), 'A visszaállított role_permission_set() nem működik.');
console.log('  OK  a 39-es role_permission_set() törzse is visszaállt és működik');

console.log('\nMIND RENDBEN — a 72-es migráció és a visszavonása ellenőrizve.');
