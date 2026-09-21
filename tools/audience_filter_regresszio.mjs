// ============================================================================
// audience_filter_regresszio.mjs — a TULAJDONSÁG-SZŰRŐ ellenőrzése
// (supabase/80_audience_attribute_filter.sql)
// ----------------------------------------------------------------------------
// MIÉRT: a szűrő három helyen dönt arról, ki kap kérdőívet vagy ki lát egy
// hírfolyam-bejegyzést — echo.audience_profiles (mentett célközönség),
// echo.audience_target (még nem mentett javaslat) és feed_audience_match
// (RLS policy). Ha ezek elcsúsznak egymástól, a szerkesztőben látott szám
// másról szól, mint ami ténylegesen kimegy.
//
// A LEGDRÁGÁBB HIBA, amit ez a mérés őriz: egy CSAK szűrővel célzott kampány
// vagy bejegyzés NE váljon "mindenki"-vé. A régi kódban a "van célközönség"
// jelző nem ismerte a szűrőt, tehát a félév összes hallgatója jogosult lett
// volna. Lásd a 80-as 4. és 8. szakaszát.
//
// A saml_match_regresszio.mjs mintájára igazi PostgreSQL-en (PGlite) fut, a
// repó VALÓDI DDL-jével — nem utánzattal.
//
// FUTTATÁS:
//   node tools/audience_filter_regresszio.mjs
// A PGlite a private-imports/validation alatt van telepítve; ha hiányzik, a
// mérés kihagyja magát, nem bukik el.
// ============================================================================
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let PGlite;
try {
  // A feloldott útvonal Windowson "C:\…" alakú; az import() csak file:// URL-t
  // fogad el, ezért a pathToFileURL nem elhagyható.
  const entry = require.resolve('@electric-sql/pglite', {
    paths: [path.join(ROOT, 'private-imports', 'validation'), ROOT],
  });
  ({ PGlite } = await import(pathToFileURL(entry).href));
} catch {
  console.log('KIHAGYVA: a @electric-sql/pglite nincs telepitve.');
  console.log('  npm --prefix private-imports/validation install');
  process.exit(0);
}

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const section = (file, start, end) => {
  const s = read(file); const a = s.indexOf(start); const b = s.indexOf(end, a);
  assert(a >= 0 && b > a, `Missing section ${start} in ${file}`); return s.slice(a, b);
};

const db = new PGlite();
const ME = '00000000-0000-0000-0000-000000000001';

// --- a Supabase-környezet, ami PGlite-ban nincs meg -------------------------
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth; create schema echo;
create function auth.uid() returns uuid language sql as $$ select '${ME}'::uuid $$;
create table auth.users (id uuid primary key, email text unique);
create function public.is_staff()          returns boolean language sql as $$ select true $$;
create function public.is_admin()          returns boolean language sql as $$ select true $$;
create function public.is_approved()       returns boolean language sql as $$ select true $$;
create function public.is_superadmin()     returns boolean language sql as $$ select true $$;
create function public.is_trusted_caller() returns boolean language sql as $$ select true $$;
`);

// --- a valódi DDL a repóból ------------------------------------------------
await db.exec(section('supabase/02_auth_profiles.sql',
  'create table if not exists public.profiles', 'alter table public.profiles enable'));
await db.exec(`alter table public.profiles
  add column requested_role text, add column approval_status text default 'pending';`);

// 38: besorolás, csoportok, és a SZABÁLY-MOTOR, amit a 80 újrahasznál.
await db.exec(section('supabase/38_student_groups.sql',
  'create table if not exists public.student_attributes', '-- 2) Csoportok'));
await db.exec(section('supabase/38_student_groups.sql',
  'create table if not exists public.user_group (', '-- 3) Csoport-jogosultság'));
await db.exec(section('supabase/38_student_groups.sql',
  'create or replace function public.group_rule_matches', '-- 5) Egy profil csoportjai'));

// A kampánytáblák váza. A 15/42 teljes betöltése ide nem kell: a 80 által
// érintett logika ezt a négy táblát olvassa.
await db.exec(`
create table echo.campaign (id uuid primary key default gen_random_uuid(),
  term text, state text not null default 'draft');
create table echo.course (id uuid primary key default gen_random_uuid(),
  term text, code text, name_hu text, lang text);
create table echo.enrollment (course_id uuid, student_key uuid, status text,
  primary key (course_id, student_key));
`);
await db.exec(section('supabase/42_campaign_editor.sql',
  'create table if not exists echo.campaign_audience', '-- RLS policy nélkül'));

// A 80 előfeltétel-blokkja megköveteli, hogy ezek LÉTEZZENEK — a 80 aztán
// mindkettőt felülírja. A csonk aláírása betűre egyezik a 47-essel.
await db.exec(`
create function echo.audience_target(p_campaign uuid, p_items jsonb)
returns table (student_key uuid, kurzus int) language plpgsql stable as $$
begin return; end $$;
create table public.feed_posts (id uuid primary key default gen_random_uuid(),
  celkozonseg jsonb);
`);
await db.exec(section('supabase/69_feed_audience.sql',
  'create or replace function public.feed_lista', '-- 2) Illeszkedik-e egy profil'));
await db.exec(section('supabase/69_feed_audience.sql',
  'create or replace function public.feed_audience_match', '-- 3) A policy-ben használt'));

// --- A MÉRT MIGRÁCIÓ, teljes egészében -------------------------------------
await db.exec(read('supabase/80_audience_attribute_filter.sql'));
console.log('80_audience_attribute_filter.sql: OK (a beepitett ellenorzo blokk lefutott)');

// Idempotencia: a 80 kétszer is lefuthat. Ez nem formalitás — a constraintek
// drop/add párban vannak, és egy felejtett "if not exists" itt bukna el.
await db.exec(read('supabase/80_audience_attribute_filter.sql'));
console.log('80_audience_attribute_filter.sql: OK masodszor is (idempotens)');

// --- adat ------------------------------------------------------------------
const mkProfile = async (email, name, role, attr) => {
  const id = (await db.query('select gen_random_uuid() u')).rows[0].u;
  await db.query('insert into auth.users(id,email) values($1,$2)', [id, email]);
  await db.query(
    "insert into public.profiles(id,email,name,role,approval_status) values($1,$2,$3,$4,'approved')",
    [id, email, name, role]);
  if (attr) {
    await db.query(`insert into public.student_attributes
      (profile_id,tagozat,kepzesi_szint,kar,forras) values($1,$2,$3,$4,'teszt')`,
      [id, attr.tagozat, attr.szint, attr.kar]);
  }
  return id;
};

const NAPPALI = 'Nappali', LEVELEZO = 'Levelező';
const BSC = 'alapképzés (BA/BSc/BProf)', MSC = 'mesterképzés (MA/MSc)';

const p1 = await mkProfile('p1@x.hu', 'Nappali BSc GAMF', 'STUDENT',
  { tagozat: NAPPALI, szint: BSC, kar: 'NJE-GAMF' });
const p2 = await mkProfile('p2@x.hu', 'Levelező MSc KVK', 'STUDENT',
  { tagozat: LEVELEZO, szint: MSC, kar: 'NJE-KVK' });
const p3 = await mkProfile('p3@x.hu', 'Nappali MSc GAMF', 'STUDENT',
  { tagozat: NAPPALI, szint: MSC, kar: 'NJE-GAMF' });
// Besorolás NÉLKÜL: szabályra soha nem illeszkedhet (38_student_groups.sql:136-137).
const p4 = await mkProfile('p4@x.hu', 'Besorolatlan', 'STUDENT', null);

const TERM = '2025/26/1';
const camp = (await db.query(
  "insert into echo.campaign(term,state) values($1,'draft') returning id", [TERM])).rows[0].id;
const kurzus = (await db.query(
  "insert into echo.course(term,code,name_hu) values($1,'K1','Kurzus egy') returning id",
  [TERM])).rows[0].id;
for (const p of [p1, p2, p3, p4]) {
  await db.query("insert into echo.enrollment values($1,$2,'active')", [kurzus, p]);
}

// --- mérések ---------------------------------------------------------------
let hibak = 0;
const egyenlo = async (mit, sql, params, vart) => {
  const got = (await db.query(sql, params)).rows[0].v;
  const ok = JSON.stringify(got) === JSON.stringify(vart);
  if (!ok) { hibak++; console.log(`  BUKOTT  ${mit}: ${JSON.stringify(got)} != ${JSON.stringify(vart)}`); }
  else console.log(`  ok      ${mit}`);
};
const dobjon = async (mit, sql, params) => {
  try { await db.query(sql, params); hibak++; console.log(`  BUKOTT  ${mit}: nem dobott hibat`); }
  catch { console.log(`  ok      ${mit}`); }
};

console.log('\n1) attr_rules_match — a mezok ES, a szabalyok VAGY kapcsolatban');
const R_NAPPALI = '[{"tagozat":["Nappali"]}]';
await egyenlo('nappali szabaly illeszkedik a nappalira',
  'select public.attr_rules_match($1::jsonb,$2) v', [R_NAPPALI, p1], true);
await egyenlo('nappali szabaly NEM illeszkedik a levelezore',
  'select public.attr_rules_match($1::jsonb,$2) v', [R_NAPPALI, p2], false);
await egyenlo('besorolatlanra semmi nem illeszkedik',
  'select public.attr_rules_match($1::jsonb,$2) v', [R_NAPPALI, p4], false);

// Egy karty an belul ES: "nappali ES alapkepzes" a p3-ra (nappali, MSc) nem all.
const R_KET = `[{"tagozat":["Nappali"],"kepzesi_szint":["${BSC}"]},{"tagozat":["${LEVELEZO}"]}]`;
await egyenlo('1. kartya (nappali ES BSc) illeszkedik a p1-re',
  'select public.attr_rules_match($1::jsonb,$2) v', [R_KET, p1], true);
await egyenlo('2. kartya (levelezo) illeszkedik a p2-re — VAGY kapcsolat',
  'select public.attr_rules_match($1::jsonb,$2) v', [R_KET, p2], true);
await egyenlo('p3 (nappali MSc) egyik kartyara sem illeszkedik',
  'select public.attr_rules_match($1::jsonb,$2) v', [R_KET, p3], false);
await egyenlo('ures szabalylista senkire nem illeszkedik',
  'select public.attr_rules_match($1::jsonb,$2) v', ['[]', p1], false);

console.log('\n2) attr_rule_label es attr_rule_count');
await egyenlo('a cimke mezosorrendje rogzitett',
  `select public.attr_rule_label('{"kar":["NJE-GAMF"],"tagozat":["Nappali"]}'::jsonb) v`,
  [], 'Nappali · NJE-GAMF');
await egyenlo('egy mezon belul vesszo',
  `select public.attr_rule_label('{"tagozat":["Nappali","Levelező"]}'::jsonb) v`,
  [], 'Nappali, Levelező');
await egyenlo('ket nappali hallgato van',
  `select public.attr_rule_count('{"tagozat":["Nappali"]}'::jsonb) v`, [], 2);
await egyenlo('ures szabaly = 0 fo, nem mindenki',
  `select public.attr_rule_count('{}'::jsonb) v`, [], 0);

console.log('\n3) attr_rule_validate — hibat DOB, nem csendben nem-illeszkedik');
await dobjon('ismeretlen mezo',
  `select public.attr_rule_validate('{"nincs_ilyen":["x"]}'::jsonb)`, []);
await dobjon('ures szuro', `select public.attr_rule_validate('{}'::jsonb)`, []);
await dobjon('nem lista ertek',
  `select public.attr_rule_validate('{"tagozat":"Nappali"}'::jsonb)`, []);
await dobjon('ures ertekista',
  `select public.attr_rule_validate('{"tagozat":[]}'::jsonb)`, []);
await dobjon('ures szoveg az ertekek kozt',
  `select public.attr_rule_validate('{"tagozat":["Nappali","  "]}'::jsonb)`, []);

console.log('\n4) a campaign_audience CHECK-je');
await dobjon('filter sor group_id-vel egyutt nem mehet be',
  `insert into echo.campaign_audience(campaign_id,kind,group_id,szabaly)
     values($1,'filter','GRP1','{"tagozat":["Nappali"]}'::jsonb)`, [camp]);
await dobjon('filter sor szabaly nelkul nem mehet be',
  `insert into echo.campaign_audience(campaign_id,kind) values($1,'filter')`, [camp]);
await dobjon('user sor szabalyt nem hordozhat',
  `insert into echo.campaign_audience(campaign_id,kind,profile_id,szabaly)
     values($1,'user',$2,'{"tagozat":["Nappali"]}'::jsonb)`, [camp, p1]);

console.log('\n5) echo.audience_profiles — a MENTETT celkozonseg feloldasa');
await db.query(`insert into echo.campaign_audience(campaign_id,kind,szabaly)
  values($1,'filter','{"tagozat":["Nappali"]}'::jsonb)`, [camp]);
await egyenlo('a mentett szuro a ket nappalit adja',
  `select count(*)::int v from echo.audience_profiles($1)`, [camp], 2);
// Egyedi szemely MELLE: a szemantika HOZZAAD, nem szukit.
await db.query(`insert into echo.campaign_audience(campaign_id,kind,profile_id)
  values($1,'user',$2)`, [camp, p2]);
await egyenlo('a szuro MELLE felvett szemely novelt, nem szukit',
  `select count(*)::int v from echo.audience_profiles($1)`, [camp], 3);
await egyenlo('a besorolatlan p4 nincs benne',
  `select count(*)::int v from echo.audience_profiles($1) t(id) where t.id=$2`,
  [camp, p4], 0);

console.log('\n6) echo.audience_target — a MEG NEM MENTETT javaslat');
const ITEMS = JSON.stringify([{ kind: 'filter', szabaly: { tagozat: [NAPPALI] } }]);
await egyenlo('csak szuro: a ket nappali, NEM mind a negy beiratkozott',
  `select count(*)::int v from echo.audience_target($1,$2::jsonb)`, [camp, ITEMS], 2);
const ITEMS2 = JSON.stringify([
  { kind: 'filter', szabaly: { tagozat: [NAPPALI], kepzesi_szint: [BSC] } },
  { kind: 'filter', szabaly: { tagozat: [LEVELEZO] } },
]);
await egyenlo('ket szurokartya VAGY kapcsolatban: p1 es p2',
  `select count(*)::int v from echo.audience_target($1,$2::jsonb)`, [camp, ITEMS2], 2);
await egyenlo('szuro nelkul (ures javaslat) a felev minden beiratkozottja',
  `select count(*)::int v from echo.audience_target($1,'[]'::jsonb)`, [camp], 4);

console.log('\n7) feed_audience_match — a hirfolyam RLS-e');
const F = (aud, p) => ['select public.feed_audience_match($1::jsonb,$2) v', [aud, p]];
await egyenlo('ures celkozonseg = mindenki', ...F('{}', p4), true);
await egyenlo('csak szuro: a nappali latja', ...F('{"szurok":[{"tagozat":["Nappali"]}]}', p1), true);
// EZ A LEGFONTOSABB SOR: csak szuro eseten a nem illeszkedo NE lasson.
await egyenlo('csak szuro: a levelezo NEM latja',
  ...F('{"szurok":[{"tagozat":["Nappali"]}]}', p2), false);
await egyenlo('csak szuro: a besorolatlan NEM latja',
  ...F('{"szurok":[{"tagozat":["Nappali"]}]}', p4), false);
await egyenlo('nevesitett szemely a szuro mellett is lat',
  ...F(JSON.stringify({ szurok: [{ tagozat: [NAPPALI] }], szemely: [p2] }), p2), true);
// A szuro OR-agon van: akkor is beenged, ha az ES-ag (szerep) nem all.
await egyenlo('a szuro beenged az ES-ag ellenere is',
  ...F('{"szerep":["ADMIN"],"szurok":[{"tagozat":["Nappali"]}]}', p1), true);
await egyenlo('sem a szuro, sem az ES-ag: nem lat',
  ...F('{"szerep":["ADMIN"],"szurok":[{"tagozat":["Nappali"]}]}', p2), false);
// A regi viselkedes valtozatlan: szuro nelkul minden a regi.
await egyenlo('szuro nelkuli regi celzas valtozatlan (illeszkedo)',
  ...F('{"tagozat":["Levelező"]}', p2), true);
await egyenlo('szuro nelkuli regi celzas valtozatlan (nem illeszkedo)',
  ...F('{"tagozat":["Levelező"]}', p1), false);

console.log(hibak === 0
  ? '\nMINDEN MERES RENDBEN.'
  : `\n${hibak} MERES BUKOTT.`);
process.exit(hibak === 0 ? 0 : 1);
