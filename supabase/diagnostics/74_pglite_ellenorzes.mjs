// ============================================================================
// 74_pglite_ellenorzes.mjs — a 74-es migráció ellenőrzése ÉLŐ POSTGRES NÉLKÜL
// ----------------------------------------------------------------------------
// MIT MÉR LE, ÉS MIT NEM
//   A 74-es 26 függvény TÖRZSÉT veszi át szó szerint az eredeti migrációkból.
//   A tartalmi azonosságot már a generálás bizonyította (soronkénti diff:
//   mindegyik törzsnél pontosan 9 sor jött hozzá, egy sem tűnt el). Ami ezen
//   túl elromolhat, az a SZINTAXIS: egy elvágott dollár-idézés vagy egy
//   rosszul zárt utasítás. Ezt méri ez a fájl, plusz azt, hogy a fájl
//   IDEMPOTENS, és hogy a linter mind a 26 RPC-n megtalálja a kaput.
//
//   check_function_bodies = off SZÁNDÉKOSAN: a törzsekben hivatkozott
//   táblákat nem oldjuk fel, ahhoz a fél séma kellene. A szignatúrákban
//   szereplő rowtype-okhoz csonk-táblák vannak alább.
//
// HOGYAN FUTTASD (a pglite nem a projekt függősége):
//   node supabase/diagnostics/74_pglite_ellenorzes.mjs
//   — vagy ha nincs telepítve: cd private-imports/validation && npm i @electric-sql/pglite
// ============================================================================
// check_function_bodies = off: a táblákra való hivatkozást NEM oldjuk fel (ahhoz
// a fél séma kellene), a dollár-idézés / utasításhatár / szignatúra hibákat
// viszont elkapja — és épp ez a gépi átvétel egyetlen valódi kockázata.
// A törzsek tartalmi azonosságát a diff-ellenőrzés bizonyította (9 hozzáadott sor).
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
  } catch { /* kovetkezo hely */ }
}
if (!PGlite) {
  console.error('Nincs @electric-sql/pglite. Telepitsd: npm i --no-save @electric-sql/pglite');
  process.exit(2);
}
import fs from 'node:fs';
import assert from 'node:assert/strict';
const R = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const db = new PGlite();

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create function public.is_approved()   returns boolean language sql as $$ select true $$;
create function public.is_superadmin() returns boolean language sql as $$ select true $$;
create function public.is_admin()      returns boolean language sql as $$ select true $$;
create function public.is_staff()      returns boolean language sql as $$ select true $$;
create function public.is_admissions() returns boolean language sql as $$ select true $$;
create function public.is_finance()    returns boolean language sql as $$ select true $$;
create function public.is_trusted_caller() returns boolean language sql as $$ select false $$;
create function public.rbac_require(text, text) returns void language plpgsql as $$ begin end $$;
create function public.my_email() returns text language sql as $$ select ''::text $$;
set check_function_bodies = off;
`);

// A szignatúrákban szereplő tábla-rowtype-okhoz csonk kell (azt a CREATE
// feloldja akkor is, ha a törzset nem ellenőrzi).
await db.exec(`
create table public.admission_processes (id text primary key);
create table public.students (id text primary key);
create table public.role_definition (kod text primary key);
create table public.module_definition (kod text primary key);
create table public.user_group (id text primary key);
create table public.agency_commission_period (id text primary key);
create table public.agency_invoice (id text primary key);
create table public.student_attributes (profile_id uuid primary key);
create table public.student_program (id text primary key);
create table public.student_program_setting (id text primary key);
create table public.profiles (id uuid primary key);
create table public.agencies (id text primary key);
create table public.program_applications (id text primary key);
create table public.programs (id text primary key);
create table public.group_permission (group_id text, permission text);
create table public.user_group_member (group_id text, profile_id uuid);
create schema echo;
create table echo.course (id uuid primary key);
create table echo.teacher (id uuid primary key);
create table echo.campaign (id uuid primary key);
create table echo.template (id uuid primary key);
create table echo.template_version (id uuid primary key);
create table echo.question_bank (id uuid primary key);
create table echo.enrollment (id uuid primary key);
create table echo.course_teacher (id uuid primary key);
create table echo.export_log (id uuid primary key);
create table echo.campaign_audience (id uuid primary key);
`);

const sql = fs.readFileSync(R + 'supabase/74_rbac_enforce_rpc.sql', 'utf8');
try {
  await db.exec(sql);
  console.log('  OK  74_rbac_enforce_rpc.sql: SZINTAKTIKAILAG rendben, a linter átment');
} catch (e) {
  console.log('  HIBA  ' + e.message);
  if (e.position) {
    const i = Math.max(0, Number(e.position) - 200);
    console.log('  --- a hiba környéke ---\n' + sql.slice(i, Number(e.position) + 200));
  }
  process.exit(1);
}
// Idempotencia
await db.exec(sql);
console.log('  OK  74_rbac_enforce_rpc.sql: MÁSODSZOR is lefutott (idempotens)');

const n = (await db.query(`select count(*)::int n from public.rbac_rpc_guard where aktiv`)).rows[0].n;
assert.equal(n, 26, 'nem 26 nyilvantartott RPC');
const hiany = (await db.query(`
  select count(*)::int n from public.rbac_rpc_guard g
  left join pg_proc p on p.proname = g.proc_name and p.pronamespace = 'public'::regnamespace
  where g.aktiv and (p.oid is null
    or position('rbac_require(''' || g.module_kod || ''', ''' || g.action || '''' in p.prosrc) = 0)`)).rows[0].n;
assert.equal(hiany, 0, 'van RPC kapu nelkul');
console.log('  OK  mind a 26 nyilvántartott RPC törzsében ott van a kapu');

// A 75-ösnek pontosan a beszúrt kaput kell kivennie, minden egyéb
// függvénytulajdonságot és az eredeti jogosultsági feltételeket megtartva.
const definitions = async () => (await db.query(`select p.oid, p.proname,
  pg_get_functiondef(p.oid) ddl from pg_proc p
  where p.pronamespace='public'::regnamespace and exists
    (select 1 from public.rbac_rpc_guard g where g.proc_name=p.proname)
  order by p.oid`)).rows;
const originals = await definitions();
const baseSql = fs.readFileSync(R + 'supabase/72_rbac_actions.sql', 'utf8');
await db.exec('create table public.rbac_setting(kulcs text, ertek text, updated_at timestamptz)');
const stateStart = baseSql.indexOf('create or replace function public.rbac_enforce_state()');
await db.exec(baseSql.slice(stateStart, baseSql.indexOf('$$;', stateStart) + 3));
assert.equal((await db.query('select public.rbac_enforce_state() s')).rows[0].s.rpc_layer,true);
const rollbackStart = baseSql.indexOf('create or replace function public.rbac_actions_rollback()');
await db.exec(baseSql.slice(rollbackStart, baseSql.indexOf('end $$;', rollbackStart) + 'end $$;'.length));
await assert.rejects(() => db.exec('select public.rbac_actions_rollback()'), /RPC-őrök még élnek/);
const rollback = fs.readFileSync(R + 'supabase/75_rbac_actions_rollback.sql', 'utf8');
// A megváltozott kaput nem hagyhatja hátra félbehagyott bontás után.
const altered = originals.at(-1);
await db.exec(altered.ddl.replace('perform public.rbac_require(', 'perform  public.rbac_require('));
const changed = await definitions();
await assert.rejects(() => db.exec(rollback), /Módosított RPC-őr/);
await db.exec('rollback');
assert.deepEqual(await definitions(), changed);
await db.exec(altered.ddl);
await db.exec(rollback);
await db.exec(rollback);
const restored = await definitions();
const guard = /if not public\.is_trusted_caller\(\) then\n    perform public\.rbac_require\('[^']+', '[^']+'\);\n  end if;/g;
for (let i = 0; i < originals.length; i++) {
  assert.equal(restored[i].ddl, originals[i].ddl.replace(guard,
    '-- RBAC action guard removed by migration 75.'), originals[i].proname);
}
assert.equal((await db.query('select count(*)::int n from public.rbac_rpc_guard where aktiv')).rows[0].n,0);
assert.equal((await db.query('select public.rbac_enforce_state() s')).rows[0].s.rpc_layer,false);
await db.exec(sql);
assert.deepEqual(await definitions(), originals);
console.log('  OK  26 RPC visszavonása, idempotencia, atomikus hiba és újratelepítés');
console.log('\nMIND RENDBEN — a 74-es ellenőrizve.');
await db.close();
