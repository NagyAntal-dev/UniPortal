// ============================================================================
// saml_match_regresszio.mjs — a SAML-belépés és a Neptun-munkafüzetből
// importált fiókok PÁROSÍTÁSÁNAK ellenőrzése (supabase/79_saml_import_match.sql)
// ----------------------------------------------------------------------------
// MIÉRT: az import 5 567 hallgatói és 273 oktatói fiókot hozott létre
// PLACEHOLDER bejelentkezési névvel (…@nje-import.invalid). Ha a belépés nem
// találja meg őket, a hallgató új, ÜRES fiókot kap, az importált pedig a 66
// ezer kurzusfelvételével együtt árván marad. Ez a mérés azt őrzi, hogy
//   - a párosítás működik (Neptun-kód, oktatónév),
//   - és hogy SOHA nem köt rossz emberhez (kétértelmű név, már kötött profil,
//     nem illő szerepkör).
//
// A private-imports/validation/check.mjs mintájára igazi PostgreSQL-en
// (PGlite) fut, a repó VALÓDI DDL-jével — nem utánzattal.
//
// FUTTATÁS:
//   node tools/saml_match_regresszio.mjs
// A PGlite a private-imports/validation alatt van telepítve (az import
// ellenőrzéséhez); ha hiányzik, a mérés kihagyja magát, nem bukik el.
// ============================================================================
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

// A repó gyökere a fájl helyéből — így mindegy, honnan indítják.
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

// --- a Supabase-környezet, ami PGlite-ban nincs meg ---
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth; create schema echo;
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create table auth.users (
  id uuid primary key, email text unique, email_confirmed_at timestamptz,
  encrypted_password text,
  created_at timestamptz default now(), deleted_at timestamptz, banned_until timestamptz,
  raw_user_meta_data jsonb, raw_app_meta_data jsonb);
create table auth.identities (id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  provider text, provider_id text, identity_data jsonb,
  created_at timestamptz default now(), unique(provider, provider_id));
create table auth.sessions (id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade);
create function public.is_staff() returns boolean language sql as $$ select true $$;
`);

await db.exec(section('supabase/02_auth_profiles.sql', 'create table if not exists public.profiles', 'alter table public.profiles enable'));
await db.exec(`alter table public.profiles add column requested_role text, add column approval_status text default 'pending',
  add column approved_at timestamptz, add column approved_by text, add column rejected_reason text;`);
await db.exec(section('supabase/15_echo_core.sql', 'create table if not exists echo.org_unit', '-- 3. SZAKASZ'));
await db.exec(section('supabase/38_student_groups.sql', 'create table if not exists public.student_attributes', '-- 2) Csoportok'));
await db.exec(`create unique index echo_teacher_profile_uidx on echo.teacher(profile_id) where profile_id is not null;`);

// --- a két migráció, teljes egészében ---
await db.exec(read('supabase/76_saml_sso.sql'));
console.log('76_saml_sso.sql: OK');
await db.exec(read('supabase/79_saml_import_match.sql'));
console.log('79_saml_import_match.sql: OK (a beepitett ellenorzo blokk lefutott)');

// --- az importált fiókokat utánzó adat ---
const mkUser = async (email, name, role) => {
  const id = (await db.query('select gen_random_uuid() u')).rows[0].u;
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [id, email]);
  await db.query(`insert into auth.identities(user_id,provider,provider_id,identity_data)
    select u.id,'email',u.id::text,jsonb_build_object('sub',u.id::text,'email',u.email)
      from auth.users u where u.id=$1`, [id]);
  await db.query("insert into public.profiles(id,email,name,role,approval_status) values($1,$2,$3,$4,'approved')", [id, email, name, role]);
  return id;
};

const stud = await mkUser('student.a00kh0@nje-import.invalid', 'Árvai Szabolcs', 'STUDENT');
await db.query("insert into public.student_attributes(profile_id,neptun,forras) values($1,'A00KH0','nje-workbook')", [stud]);

await db.query("insert into public.role_definition(kod,nev) values('TEACHER','Oktato') on conflict do nothing")
  .catch(() => {}); // a role_definition tábla itt nincs betöltve — nem baj

const teach = await mkUser('teacher.407debeaed928719@nje-import.invalid', 'Baglyas Ferenc Dr.', 'TEACHER');
await db.query("insert into echo.teacher(code,name,profile_id,ext_source,ext_id) values('NJE-T-407debeaed928719','Baglyas Ferenc Dr.',$1,'nje-workbook','NJE-T-407debeaed928719')", [teach]);

// Kétértelmű: két oktatói sor, ugyanaz a normalizált név, két külön fiók.
const amb1 = await mkUser('teacher.aaa@nje-import.invalid', 'Kiss Péter', 'TEACHER');
const amb2 = await mkUser('teacher.bbb@nje-import.invalid', 'Kiss Péter Dr.', 'TEACHER');
await db.query("insert into echo.teacher(code,name,profile_id) values('T-AMB1','Kiss Péter',$1),('T-AMB2','Kiss Péter Dr.',$2)", [amb1, amb2]);

const find = async (eppn, email, dn) =>
  (await db.query('select * from public.saml_find_user($1,$2,$3)', [eppn, email, dn ?? null])).rows;
const reviews = async () =>
  (await db.query('select eppn,reason,user_id from public.saml_link_review where resolved_at is null order by reason')).rows;

let r;

// 1. HALLGATÓ Neptun-kód szerint
r = await find('a00kh0@kefo.hu', 'a00kh0@kefo.hu');
assert.equal(r.length, 1, 'a hallgatot Neptun-kod alapjan meg kell talalni');
assert.equal(r[0].matched_by, 'neptun');
assert.equal(r[0].user_id, stud);
console.log('1. hallgato @kefo.hu -> matched_by=neptun: OK');

// 2. OKTATÓ név szerint, a titulus más helyen és alakban
r = await find('bferenc@nje.hu', 'bferenc@nje.hu', 'Dr. Baglyas Ferenc');
assert.equal(r.length, 1, 'az oktatot normalizalt nev alapjan meg kell talalni');
assert.equal(r[0].matched_by, 'teacher_name');
assert.equal(r[0].user_id, teach);
console.log('2. oktato "Dr. Baglyas Ferenc" ~ "Baglyas Ferenc Dr." -> teacher_name: OK');

// 3. KÉTÉRTELMŰ oktatónév: SOHA nem tippelünk
r = await find('kpeter@nje.hu', 'kpeter@nje.hu', 'Kiss Péter');
assert.equal(r.length, 0, 'ketertelmu nevre nem szabad parositani');
assert.ok((await reviews()).some(x => x.reason === 'teacher_ambiguous'), 'kell egy teacher_ambiguous sor');
console.log('3. ketertelmu oktatonev -> nincs parositas, elbiralasi sor: OK');

// 4. ELTULAJDONÍTÁS-VÉDELEM: a profil már másik ePPN-hez kötött
await db.query("select public.saml_link_login('masvalaki@kefo.hu',$1,'masvalaki@kefo.hu','X',null,null,null,null,null,false)", [stud]);
r = await find('a00kh0@kefo.hu', 'a00kh0@kefo.hu');
assert.equal(r.length, 0, 'mar kotott profilt nem szabad atkotni');
assert.ok((await reviews()).some(x => x.reason === 'student_linked'), 'kell egy student_linked sor');
console.log('4. mar kotott profil -> nincs atkotes (eltulajdonitas-vedelem): OK');

// 5. REGRESSZIÓ: az ePPN-ág változatlanul működik
r = await find('masvalaki@kefo.hu', 'barmi@nje.hu');
assert.equal(r.length, 1); assert.equal(r[0].matched_by, 'eppn'); assert.equal(r[0].user_id, stud);
console.log('5. regresszio: ePPN-ag valtozatlan: OK');

// 6. REGRESSZIÓ: az e-mail-ág változatlanul működik
r = await find('uj@nje.hu', 'teacher.407debeaed928719@nje-import.invalid', null);
assert.equal(r.length, 1); assert.equal(r[0].matched_by, 'email');
console.log('6. regresszio: e-mail-ag valtozatlan: OK');

// 7. Ismeretlen munkatárs -> elbírálási sor (de fiókot NEM kötünk)
r = await find('ujkolléga@nje.hu', 'ujkollega@nje.hu', 'Teljesen Ismeretlen');
assert.equal(r.length, 0);
assert.ok((await reviews()).some(x => x.reason === 'teacher_unmatched'));
console.log('7. ismeretlen munkatars -> teacher_unmatched sor: OK');

// 8. Szerepkör-védelem: STUDENT profilú oktatói sorra nem kötünk
const wrong = await mkUser('teacher.ccc@nje-import.invalid', 'Rossz Szerep', 'STUDENT');
await db.query("insert into echo.teacher(code,name,profile_id) values('T-WRONG','Rossz Szerep',$1)", [wrong]);
r = await find('rossz@nje.hu', 'rossz@nje.hu', 'Rossz Szerep');
assert.equal(r.length, 0, 'STUDENT szerepkoru profilra nem szabad oktatokent parositani');
assert.ok((await db.query("select candidates from public.saml_link_review where eppn='rossz@nje.hu'")).rows[0].candidates.length === 1,
  'a teacher_unmatched sor mutassa meg a jelolteket (miert bukott a parositas)');
console.log('8. szerepkor-vedelem (STUDENT profil != oktato) + jeloltlista: OK');

// 9. Nem létező Neptun-kód: sima új felhasználó, elbírálási sor nélkül
const before = (await reviews()).length;
r = await find('zzz999@kefo.hu', 'zzz999@kefo.hu', 'Új Hallgató');
assert.equal(r.length, 0);
assert.equal((await reviews()).length, before, 'ismeretlen hallgato ne csinaljon elbiralasi sort');
console.log('9. ismeretlen Neptun-kod -> uj fiok, nincs felesleges elbiralas: OK');

// 10. profiles.email szinkron: a GoTrue csak az auth.users sorát írja
await db.query("update auth.users set email='a00kh0@kefo.hu' where id=$1", [stud]);
await db.query("select public.saml_link_login('masvalaki@kefo.hu',$1,'a00kh0@kefo.hu','X',null,null,null,null,null,false)", [stud]);
assert.equal((await db.query('select email from public.profiles where id=$1', [stud])).rows[0].email, 'a00kh0@kefo.hu');
console.log('10. profiles.email szinkron az auth.users-bol: OK');

// 11. Az elbírálási sor user_id-je kitöltődik, és lezárható
await db.query("select public.saml_link_login('ujkolléga@nje.hu',$1,'ujkollega@nje.hu','Teljesen Ismeretlen',null,null,null,null,null,true)", [wrong]);
const open = (await reviews()).find(x => x.eppn === 'ujkolléga@nje.hu');
assert.equal(open.user_id, wrong, 'a saml_link_login toltse ki a user_id-t');
const openId = (await db.query("select id from public.saml_link_review where eppn='ujkolléga@nje.hu'")).rows[0].id;
await db.query('select public.saml_review_resolve($1)', [openId]);
assert.ok(!(await reviews()).some(x => x.eppn === 'ujkolléga@nje.hu'), 'a lezaras mukodjon');
console.log('11. elbiralas user_id-kitoltes + lezaras: OK');

// 12. Ismételt belépés ne szemetelje tele a táblát
await find('kpeter@nje.hu', 'kpeter@nje.hu', 'Kiss Péter');
await find('kpeter@nje.hu', 'kpeter@nje.hu', 'Kiss Péter');
assert.equal((await db.query("select count(*) c from public.saml_link_review where reason='teacher_ambiguous'")).rows[0].c, 1);
console.log('12. ismetelt belepes -> egyetlen nyitott sor: OK');

// ---------------------------------------------------------------------------
// 13-15. A VALÓDI NJE-FORMÁTUMOK (az éles diagnosztikából, 2026-09).
//
// A feltételezés, hogy a @kefo.hu csak a hallgatóké, HAMIS: az oktatók is
// onnan lépnek be. NEM a tartomány különbözteti meg őket, hanem a helyi rész
// ALAKJA — a hallgatóé a hat karakteres Neptun-kód, az oktatóé pontos
// vezeteknev.keresztnev. Ezt a három eset őrzi, hogy a szűrő ne romoljon el.
// ---------------------------------------------------------------------------
const elo = await mkUser('student.x61p08@nje-import.invalid', 'Valódi Hallgató', 'STUDENT');
await db.query("insert into public.student_attributes(profile_id,neptun,forras) values($1,'X61P08','nje-workbook')", [elo]);
r = await find('x61p08@kefo.hu', 'x61p08@hallgato.uni-neumann.hu', 'Valódi Hallgató');
assert.equal(r.length, 1, 'x61p08@kefo.hu -> Neptun-parositas');
assert.equal(r[0].matched_by, 'neptun');
assert.equal(r[0].user_id, elo);
console.log('13. elo alak: x61p08@kefo.hu (mail mas tartomanyon) -> neptun: OK');

const sagi = await mkUser('teacher.ddd@nje-import.invalid', 'Sági Norberta Dr.', 'TEACHER');
await db.query("insert into echo.teacher(code,name,profile_id) values('T-SAGI','Sági Norberta Dr.',$1)", [sagi]);
r = await find('sagi.norberta@kefo.hu', 'sagi.norberta@kefo.hu', 'Dr. Sági Norberta');
assert.equal(r.length, 1, 'az OKTATO is @kefo.hu-rol jon — a helyi resz alakja dont');
assert.equal(r[0].matched_by, 'teacher_name');
assert.equal(r[0].user_id, sagi);
console.log('14. elo alak: sagi.norberta@kefo.hu -> teacher_name (NEM hallgato): OK');

const szabo = await mkUser('teacher.eee@nje-import.invalid', 'Szabó Lóránt', 'TEACHER');
await db.query("insert into echo.teacher(code,name,profile_id) values('T-SZABO','Szabó Lóránt',$1)", [szabo]);
r = await find('szabo.lorant@kefo.hu', 'szabo.lorant@kefo.hu', 'Szabó Lóránt');
assert.equal(r.length, 1); assert.equal(r[0].matched_by, 'teacher_name');
console.log('15. elo alak: szabo.lorant@kefo.hu (ekezet nelkuli login, ekezetes nev): OK');

// ---------------------------------------------------------------------------
// 16-18. Az ÖSSZEVONÓ szkript (diagnostics/79_saml_duplikatum_merge.sql).
// Fiókokat nyugdíjaz, ezért tesztelés nélkül nem adható ki a kezünkből.
// A psql meta-parancsokat (\echo, \set) a PGlite nem ismeri — kiszedjük.
// ---------------------------------------------------------------------------
const mergeSql = read('supabase/diagnostics/79_saml_duplikatum_merge.sql')
  .split('\n').filter(l => !/^\s*\\/.test(l)).join('\n');

// Egy tiszta duplikátum-pár: importált fiók a kurzusfelvétellel, mellette a
// fölösleges SSO-fiók a valódi címmel.
const imp = await mkUser('student.m99xyz@nje-import.invalid', 'Duplikált Dóra', 'STUDENT');
await db.query("insert into public.student_attributes(profile_id,neptun,forras) values($1,'M99XYZ','nje-workbook')", [imp]);
await db.query("update auth.users set encrypted_password='$2b$10$REGI_CSV_JELSZO_HASH' where id=$1", [imp]);
await db.query("insert into echo.org_unit(code,name_hu,kind) values('NJE','NJE','egyetem') on conflict do nothing");
const kurzus = (await db.query("insert into echo.course(code,name_hu,term,org_unit_id) select 'K-1','Teszt','2026/27/1',id from echo.org_unit limit 1 returning id")).rows[0].id;
await db.query("insert into echo.enrollment(course_id,student_key) values($1,$2)", [kurzus, imp]);

const dup = await mkUser('m99xyz@hallgato.uni-neumann.hu', 'Duplikált Dóra', 'STUDENT');
await db.query("select public.saml_link_login('m99xyz@kefo.hu',$1,'m99xyz@hallgato.uni-neumann.hu','Duplikált Dóra',null,null,null,null,null,true)", [dup]);

// 16. Ha az SSO-fiókhoz ADAT tartozik, az összevonás NEM futhat le.
await db.query("insert into echo.enrollment(course_id,student_key) values($1,$2)", [kurzus, dup]);
// A hibauzenet NEVEZZE MEG a tablat — enelkul egy elgepelt engedelyezett-lista
// miatt is "atmenne" a teszt, csak rossz okbol (ez egyszer meg is tortent).
await assert.rejects(db.exec(mergeSql),
  e => /ADAT tartozik/.test(e.message) && /enrollment\.student_key: 1 sor/.test(e.message),
  'nem ures SSO-fiokot nem szabad nyugdijazni, es mondja meg, mi tartja vissza');
await db.exec('rollback;');
assert.equal((await db.query('select email from auth.users where id=$1', [dup])).rows[0].email,
  'm99xyz@hallgato.uni-neumann.hu', 'a megszakadt osszevonas semmit nem valtoztathat');
console.log('16. nem ures SSO-fiok -> az osszevonas elszall, semmi nem valtozik: OK');

// 17. Üres SSO-fiókkal lefut az összevonás.
await db.query("delete from echo.enrollment where student_key=$1", [dup]);
await db.exec(mergeSql);

const ident = (await db.query("select user_id from public.saml_identities where eppn='m99xyz@kefo.hu'")).rows[0];
assert.equal(ident.user_id, imp, 'az NJE-azonosito az IMPORTALT fiokra kerul');
const cel = (await db.query('select email, encrypted_password from auth.users where id=$1', [imp])).rows[0];
assert.equal(cel.email, 'm99xyz@hallgato.uni-neumann.hu', 'a celfiok megkapja a valodi cimet');
assert.notEqual(cel.encrypted_password, '$2b$10$REGI_CSV_JELSZO_HASH', 'a CSV-jelszo ervenytelenitve');
assert.equal((await db.query('select email from public.profiles where id=$1', [imp])).rows[0].email,
  'm99xyz@hallgato.uni-neumann.hu', 'a profiles.email is kovesse');
assert.equal((await db.query('select count(*) c from echo.enrollment where student_key=$1', [imp])).rows[0].c, 1,
  'a kurzusfelvetel megmarad');
console.log('17. osszevonas: azonosito atkotve, valodi cim, CSV-jelszo ervenytelen: OK');

// 18. A fölösleges fiók nyugdíjazva — de NEM törölve (57 tábla hivatkozik rá).
const regi = (await db.query('select email, banned_until from auth.users where id=$1', [dup])).rows[0];
assert.ok(regi, 'a duplikatum fiok NEM torlodhet');
assert.ok(String(regi.email).startsWith('merged-'), 'a cim felszabadul');
assert.ok(regi.banned_until, 'a fiok tiltva');
assert.equal((await db.query('select approval_status from public.profiles where id=$1', [dup])).rows[0].approval_status, 'rejected');
// Újrafuttatás: nincs mit összevonni, nem csinál semmit.
await db.exec(mergeSql);
assert.equal((await db.query("select user_id from public.saml_identities where eppn='m99xyz@kefo.hu'")).rows[0].user_id, imp);
console.log('18. a duplikatum nyugdijazva (nem torolve), ujrafuttatas ures: OK');

console.log('\nMINDEN ELLENORZES SIKERES.');
