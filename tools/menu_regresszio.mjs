// ============================================================================
// menu_regresszio.mjs — a menüszűrő refaktorának regresszió-ellenőrzése
// ----------------------------------------------------------------------------
// MIÉRT VAN EZ A FÁJL
//   Ugyanez a feltétel-sor eddig KÉTSZER szerepelt az app.jsx-ben (menüszűrő és
//   renderContent), kommentben kikötve, hogy betűre egyezniük kell. A 72-es
//   migráció kapcsán egyetlen canSeeView() függvénybe került, és a
//   rolePerms-ág helyére a modul-mátrix VIEW joga (PERM_can) lépett.
//
//   Ez a fájl lemérni, hogy a refaktor SEMMIT nem változtatott: kiveszi a
//   git HEAD-en lévő EREDETI szűrő törzsét, kiveszi az ÚJ canSeeView-t, és
//   minden szerepkör × minden modul × több jogosultsági állapot cellára
//   összehasonlítja a kettőt.
//
// FUTTATÁS (nincs függősége, csak git és node):
//   node tools/menu_regresszio.mjs
//
// A "HEAD" a viszonyítási alap. Ha a refaktort már commitoltad, állítsd át az
// ALAP konstanst arra a commitra, ami a refaktor ELŐTT volt.
// ============================================================================
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const ALAP = process.env.ALAP || 'HEAD';
const R = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') + '/';
const uj = fs.readFileSync(R + 'app.jsx', 'utf8');
const perm = fs.readFileSync(R + 'features/perm.jsx', 'utf8');
const regi = execSync('git -C "' + R + '" show ' + ALAP + ':app.jsx', { encoding: 'utf8', maxBuffer: 1 << 28 });

const kivag = (s, tol, ig) => {
  const a = s.indexOf(tol); assert.ok(a >= 0, 'nincs: ' + tol);
  const b = s.indexOf(ig, a); assert.ok(b > a, 'nincs vege: ' + ig);
  return s.slice(a, b + ig.length);
};

// AppView és a menüpont-azonosítók (mindkét változatban ugyanaz).
const appViewSrc = kivag(uj, 'const AppView = {', '\n};');
const AppView = eval('(' + appViewSrc.slice(appViewSrc.indexOf('{')).replace(/;\s*$/, '') + ')');
const MODULOK = Object.values(AppView);

// --- A RÉGI szűrő: a HEAD-en lévő filter törzse, függvénybe csomagolva ---
const regiFilter = kivag(regi, 'const filteredMenuItems = MENU_ITEMS.filter(item => {', '\n  });');
const regiTorzs = regiFilter
  .slice(regiFilter.indexOf('{') + 1, regiFilter.lastIndexOf('}'))
  .replace(/item\.id/g, 'viewId');
const regiFn = new Function('AppView', 'currentUser', 'viewId', regiTorzs);

// --- Az ÚJ canSeeView + a PERM_* segédek ---
const permSrc = perm
  .replace(/^\/\*[\s\S]*?\*\/\n/, '')            // fejléc-komment
  .split('function PERM_Denied')[0];             // a JSX-es rész nem kell
const ujFn = new Function('AppView', `
  ${permSrc}
  ${kivag(uj, 'function canSeeView(currentUser, viewId) {', '\n}')}
  return canSeeView;
`)(AppView);

// --- A hat beépített szerepkör, a 39-es seedje szerint ---
const SZEREPEK = ['SUPERADMIN', 'ADMIN', 'ADMISSIONS', 'FINANCE', 'AGENT', 'STUDENT'];
// A 39-es role_permission seedje = a rolePerms, amit a szerver ad.
const ROLE_PERMS = {
  SUPERADMIN: null,
  ADMIN: ['feed','programs','trainings','assistant','agent_portal','admissions_core',
          'engagement_crm','finance','immigration','evaluation','system_admin','interviews',
          'student_portal','marketing_leads','reports','intelligence','registrations',
          'echo_student','echo_admin','echo_teacher','dorm_ops','dorm_maintenance','dorm_student'],
  ADMISSIONS: ['feed','assistant','admissions_core','evaluation','engagement_crm',
               'immigration','interviews','marketing_leads','reports','intelligence'],
  FINANCE: ['feed','assistant','finance','agent_portal','interviews','reports'],
  AGENT: ['feed','programs','assistant','agent_portal','interviews'],
  STUDENT: ['feed','programs','assistant','student_portal'],
};

// A kódba égetett BIZTONSÁGI ágak (ECHO- és kollégiumi grantok, csoport-jog)
// mindkét változatban a VIEW előtt döntenek — ezeket is végigmérjük.
const EXTRAK = [
  { nev: 'nincs grant' },
  { nev: 'ECHO OKTATO',        echoRoles: ['OKTATO'] },
  { nev: 'dorm GONDNOK',       dormRoles: ['GONDNOK'] },
  { nev: 'dorm KARBANTARTO',   dormRoles: ['KARBANTARTO'] },
  { nev: 'dorm KOLI_SYSADMIN', dormRoles: ['KOLI_SYSADMIN'] },
  { nev: 'csoport-jog',        groupPerms: ['finance', 'reports'] },
  // EGYENI JOG (73_user_access.sql). Enelkul a userPerms ag VAK FOLT volt:
  // a canSeeView el is felejtette, es a teszt ezt nem vette eszre.
  { nev: 'egyeni jog',         userPerms: ['finance', 'reports'] },
];

let elteres = 0, ossz = 0;
for (const role of SZEREPEK) {
  for (const extra of EXTRAK) {
  for (const perms_e of [false, true]) {   // a 72-es ELŐTT és UTÁN
    const user = {
      role, status: 'approved',
      rolePerms: ROLE_PERMS[role],
      groupPerms: extra.groupPerms || [],
      userPerms:  extra.userPerms  || [],
      echoRoles:  extra.echoRoles  || [],
      dormRoles:  extra.dormRoles  || [],
      // A 72-es utáni állapot: a VIEW jogok = a rolePerms + a kódba égetett ágak.
      // A kódba égetett ágakat a canSeeView a VIEW előtt dönti el, tehát ide
      // csak a rolePerms kell — épp ezt ellenőrizzük.
      perms: perms_e && ROLE_PERMS[role]
        ? Object.fromEntries(ROLE_PERMS[role].map(m => [m, ['VIEW', 'USE']]))
        : (perms_e && role === 'SUPERADMIN' ? { '*': ['VIEW'] } : null),
    };
    for (const m of MODULOK) {
      const a = !!regiFn(AppView, user, m);
      const b = !!ujFn(user, m);
      ossz++;
      if (a !== b) {
        elteres++;
        console.log(`  ELTÉR  ${role} / ${m} / perms=${perms_e} / ${extra.nev}: régi=${a} új=${b}`);
      }
    }
    }
  }
}
console.log(`\n${ossz} cella ellenőrizve, ${elteres} eltérés.`);
assert.equal(elteres, 0, 'A menüszűrő viselkedése MEGVÁLTOZOTT.');
console.log('OK — a menü betűre ugyanazt adja, mint a refaktor előtt.');
