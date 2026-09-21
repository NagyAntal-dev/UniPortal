// ============================================================================
// perm_regresszio.mjs — a PERM_can viselkedésének és a hívóhelyeknek az
// ellenőrzése (72_rbac_actions.sql, features/perm.jsx)
// ----------------------------------------------------------------------------
// KÉT DOLGOT MÉR LE
//
//   1. A PERM_can SZERZŐDÉSÉT. A legfontosabb állítás: ha a 72-es migráció még
//      nem futott le (user.perms == null), a PERM_can BETŰRE azt adja vissza,
//      amit a hívóhely a negyedik paraméterben átadott — vagyis a MAI értéket.
//      Enélkül az egész „a bevezetés nem vesz el semmit" ígéret üres.
//
//   2. HOGY MINDEN HÍVÓHELY ÁT IS ADJA A MAI ÉRTÉKET. Egy elfelejtett negyedik
//      paraméter csendben átváltaná a viselkedést a PERM_regiStaff tartalékra,
//      ami NEM ugyanaz. A mérés a git HEAD-hez képest dolgozik: minden
//      megváltozott sorra megnézi, hogy a régi feltétel szövegszerűen
//      megjelenik-e a `regi` paraméterben.
//
// FUTTATÁS (nincs függősége, csak git és node):
//   node tools/perm_regresszio.mjs
// ============================================================================
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const ALAP = process.env.ALAP || 'HEAD';
const R = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') + '/';
const perm = fs.readFileSync(R + 'features/perm.jsx', 'utf8');

/* ---- 1. A PERM_can szerződése ---- */
const permSrc = perm.replace(/^\/\*[\s\S]*?\*\/\n/, '').split('function PERM_Denied')[0];
const { PERM_can, PERM_of, PERM_elo } =
  new Function(`${permSrc}\n return { PERM_can, PERM_of, PERM_elo };`)();

const U = (role, perms, status) => ({ role, perms, status: status || 'approved' });

// (a) A 72-es ELŐTT: a `regi` dönt, betűre.
for (const role of ['ADMIN', 'ADMISSIONS', 'FINANCE', 'AGENT', 'STUDENT', 'SAJAT_SZEREP']) {
  for (const regi of [true, false]) {
    assert.equal(PERM_can(U(role, null), 'feed', 'CREATE', regi), regi,
      `perms==null eseten a regi erteknek kell donteni (${role}, regi=${regi})`);
  }
}
console.log('  OK  perms == null -> a hívóhely mai értéke dönt, betűre');

// (b) `regi` nélkül a mai ügyintézői kör dönt — dokumentált tartalék.
assert.equal(PERM_can(U('ADMISSIONS', null), 'feed', 'CREATE'), true);
assert.equal(PERM_can(U('STUDENT', null), 'feed', 'CREATE'), false);
console.log('  OK  regi nélkül a mai ügyintézői kör a tartalék');

// (c) A 72-es UTÁN: a mátrix dönt, és a `regi` NEM írja felül.
const p = { feed: ['VIEW', 'USE'], finance: ['VIEW', 'EDIT'] };
assert.equal(PERM_can(U('FINANCE', p), 'feed', 'CREATE', true), false,
  'a matrix donteset a regi ertek nem irhatja felul');
assert.equal(PERM_can(U('FINANCE', p), 'finance', 'EDIT', false), true);
assert.equal(PERM_can(U('FINANCE', p), 'nincs_ilyen', 'VIEW', true), false);
console.log('  OK  a mátrix dönt, és a mai érték nem írja felül');

// (d) SUPERADMIN: mindig mindent, a mátrixtól és a `regi`-től függetlenül.
assert.equal(PERM_can(U('SUPERADMIN', {}), 'finance', 'DELETE', false), true);
assert.equal(PERM_can(U('SUPERADMIN', null), 'barmi', 'DELETE', false), true);
// A szerver csillagos alakja is mindent nyit.
assert.equal(PERM_can(U('ADMIN', { '*': ['VIEW'] }), 'finance', 'DELETE'), true);
console.log('  OK  a SUPERADMIN joga nem elvehető (és a {"*":[...]} alak is nyit)');

// (e) Jóváhagyás nélkül semmi — a szerver rbac_can()-ja is így dönt.
assert.equal(PERM_can(U('ADMIN', { feed: ['CREATE'] }, 'pending'), 'feed', 'CREATE', true), false);
assert.equal(PERM_can(null, 'feed', 'VIEW', true), false);
console.log('  OK  pending fiók és hiányzó user: semmi');

// (f) PERM_of: az öt művelet egy objektumban, a `del` kulccsal.
const jog = PERM_of(U('FINANCE', p), 'finance', {});
assert.deepEqual(jog, { view: true, use: false, create: false, edit: true, del: false });
assert.equal(PERM_elo(U('FINANCE', p)), true);
assert.equal(PERM_elo(U('FINANCE', null)), false);
console.log('  OK  PERM_of öt kulcsot ad (view/use/create/edit/del), PERM_elo jelzi az adatot');

/* ---- 2. Minden hívóhely átadja-e a MAI értéket? ---- */
// A négyparaméteres PERM_can hívások `regi` argumentumát vizsgáljuk. Ami nem
// tartalmaz szerepkör-ellenőrzést (user.role) vagy egy másik predikátum-hívást,
// az gyanús: ott elfelejtődhetett a mai érték.
// A listát NEM égetjük be: egy új feature-fájl hívóhelye is látszódjon.
const FAJLOK = ['app.jsx'].concat(
  fs.readdirSync(R + 'features')
    .filter(n => n.endsWith('.jsx') && n !== 'perm.jsx')
    .map(n => 'features/' + n));

let hivas = 0;
const gyanus = [];
const literal = [];
for (const f of FAJLOK) {
  const src = fs.readFileSync(R + f, 'utf8');
  // A hívás a zárójel-párosításig; a PERM_can(...) belseje több sor is lehet.
  const re = /PERM_can\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, szint = 1;
    while (i < src.length && szint > 0) {
      if (src[i] === '(') szint++;
      else if (src[i] === ')') szint--;
      i++;
    }
    const args = src.slice(m.index + m[0].length, i - 1);
    // Az argumentumok szétszedése a legfelső szintű vesszőknél.
    const reszek = []; let d = 0, akt = '';
    for (const ch of args) {
      if (ch === '(' || ch === '[' || ch === '{') d++;
      if (ch === ')' || ch === ']' || ch === '}') d--;
      if (ch === ',' && d === 0) { reszek.push(akt); akt = ''; continue; }
      akt += ch;
    }
    reszek.push(akt);
    if (reszek.length < 3) continue;   // definíció, nem hívás
    hivas++;
    const regi = (reszek[3] || '').trim();
    const sor = src.slice(0, m.index).split('\n').length;
    if (!regi) { gyanus.push(`${f}:${sor}  NINCS negyedik parameter`); continue; }
    // A literális `true` ELFOGADHATÓ, és nem lazaság: négy nézet (Finance,
    // ImmigrationCompliance, Evaluation, MarketingLeads) eddig a `user` propot
    // sem kapta meg, tehát SEMMILYEN jogosultság-ellenőrzés nem volt bennük.
    // Ott a mai érték szó szerint „mindenki, aki látja a modult" = true.
    // Ezeket külön felsoroljuk, hogy látható legyen, hol nőtt a szigor.
    if (/^(true|false)$/.test(regi)) { literal.push(`${f}:${sor}`); continue; }
    if (!/user\.role|isAdmin\(|isStaff\(|rolePerms|attrOpciok|undefined/.test(regi)) {
      gyanus.push(`${f}:${sor}  a regi ertek nem szerepkor-ellenorzes: ${regi.slice(0, 60)}`);
    }
  }
}
if (gyanus.length) {
  console.log('\n  GYANÚS HÍVÓHELY:');
  gyanus.forEach(g => console.log('   ' + g));
}
assert.deepEqual(gyanus, [], 'Van hívóhely, ami nem adja át a mai értéket.');
console.log(`  OK  mind a ${hivas} PERM_can hívóhely átadja a mai értéket`);
if (literal.length) {
  console.log(`      ebből ${literal.length} helyen a mai érték "true" volt (a nézetnek`);
  console.log('      eddig nem is volt jogosultság-ellenőrzése): ' + literal.join(', '));
}

console.log('\nMIND RENDBEN — a PERM_can szerződése és a hívóhelyek ellenőrizve.');
