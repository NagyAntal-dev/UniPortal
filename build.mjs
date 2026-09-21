#!/usr/bin/env node
// ============================================================
// UniPortal — build step
// ------------------------------------------------------------
// app.html can compile app.jsx in the browser with Babel standalone, which
// works but costs ~3 MB of CDN payload and a multi-second compile on every
// cold visit. This script does that work once, ahead of time:
//
//   app.jsx + the feature modules  ->  app.bundle.js  (esbuild, minified)
//
// The concatenation mirrors app.html's runtime loader exactly: the feature
// modules are spliced into app.jsx's module scope at its __FEATURES__ marker,
// so they keep sharing one scope.
//
// React / react-dom / lucide-react / recharts are bundled in. Leaving them
// external meant the browser resolved them (and recharts' d3 / lodash tree)
// from esm.sh at runtime: 138 module requests in a serialised waterfall on
// every load. One request is worth the extra bytes — measured 1308 ms -> 532 ms
// to the app shell. The import map in app.html stays for the no-build fallback,
// which still compiles app.jsx in the browser and does need it.
//
// Usage:  npm run build     (the Pages workflow runs this before deploying)
// ============================================================
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));

const FEATURE_FILES = [
  'features/data-layer.jsx',
  // Akció-szintű jogosultság (72_rbac_actions.sql): PERM_can / PERM_of /
  // PERM_Gate / PERM_Denied. A data-layer UTÁN kell állnia: onnan veszi a
  // UEmpty atomot. Minden más modul hivatkozik rá, de csak függvényként,
  // tehát a kiértékelés sorrendje azokhoz képest közömbös.
  'features/perm.jsx',
  // Zászlós országválasztó (CTRY_Select) — a programs.jsx és az app.jsx
  // jelentkezési űrlapjai használják; zászlók: assets/flags/*.svg.
  'features/countries.jsx',
  'features/echo.jsx',
  'features/knowledge-base.jsx',
  'features/feed.jsx',
  'features/programs.jsx',
  'features/assistant.jsx',
  'features/registrations.jsx',
  // Interjú-elérhetőség és 15 perces idősávok (28_interview_availability.sql).
  // A data-layer UTÁN kell állnia: onnan veszi a UModal/UField/U_input atomokat.
  'features/interview.jsx',
  // Interjúnaptár és a jelentkezői interjú-lépés (61_interview_calendar.sql).
  // Az interview.jsx UTÁN: annak IV_rpc / IV_SlotPicker elemeire épül.
  'features/interview-calendar.jsx',
  // Üzenetváltás a felvételi eljárásban (62_admission_chat.sql): beszélgetés,
  // fájlküldés, olvasatlan-értesítés. A data-layer és a programs UTÁN.
  'features/messages.jsx',
  // Hallgatói naptár (interjú, határidők, események). A programs, a feed és a messages UTÁN.
  'features/student-calendar.jsx',
  // Interjúfelvételek feltöltése és lejátszása (63_letter_log_recordings.sql).
  'features/recordings.jsx',
  // Kollégiumi modul (26_dorm.sql). A SORREND KÖTÖTT: a dorm.jsx viszi a közös
  // réteget (DORM_rpc, DORM_api, DORM_Tabs, DORM_Stat, DORM_Empty, DORM_Hidden)
  // és a Kollégium nézetet, a dorm-views.jsx pedig erre épül.
  'features/dorm.jsx',
  'features/dorm-views.jsx',
  // Ugynoksegi portal (29_agency.sql). Az AgentPortal a render-fuggvenyeibol
  // hivatkozik ra, tehat a modul-kiertekeles sorrendje nem szamit.
  'features/agency.jsx',
  'features/multiprogram.jsx',
  'features/groups.jsx',
  'features/roles.jsx',
  // Kurzusnyilvantartas (43_course_registry.sql). Az echo.jsx hivatkozik a
  // CRS_Tab-ra, de az fuggveny-deklaracio, tehat hoistolodik — a modul
  // kiertekelesenek sorrendje emiatt kozombos.
  'features/courses.jsx',
  // Oktatoi nyilvantartas (54_teacher_registry.sql). A data-layer UTAN kell
  // allnia: onnan veszi a UModal/UField/UBadge/UEmpty atomokat.
  'features/teachers.jsx',
  // Jogi dokumentumok, elfogadások, hozzájárulási napló (59_legal_consents.sql).
  // A data-layer UTAN: onnan veszi a UBadge / U_btnPrimary / U_input atomokat.
  // Hallgatoi nyilvantartas (71_student_directory.sql). A data-layer UTAN:
  // onnan veszi a UModal/UBadge/UEmpty/U_input atomokat.
  'features/students.jsx',
  'features/legal.jsx',
  // Jogosultsagok (73_user_access.sql): szerepkor, csoport es EGYENI jog egy
  // kepernyon. A roles/groups/registrations UTAN: azok ROLE_Tab / GRP_Tab /
  // REG_loadProfiles elemeire epul.
  'features/access.jsx',
];

// `motion` is only referenced by the shim at the top of app.jsx, which renders
// plain elements — nothing to bundle.
const EXTERNALS = ['motion', 'motion/react'];

let src = readFileSync(join(root, 'app.jsx'), 'utf8');
const features = FEATURE_FILES.map((f) => readFileSync(join(root, f), 'utf8')).join('\n\n');
src = src.includes('/*__FEATURES__*/')
  ? src.replace('/*__FEATURES__*/', features)
  : src + '\n\n' + features;

// esbuild infers the loader from the extension, so stage the combined source
// as .tsx (app.jsx contains both TypeScript annotations and JSX).
const entry = join(root, '.app.build.tsx');
writeFileSync(entry, src);

try {
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile: join(root, 'app.bundle.js'),
    bundle: true,
    format: 'esm',
    target: 'es2020',
    jsx: 'transform', // classic runtime — React is imported at the top of app.jsx
    minify: true,
    external: EXTERNALS,
    define: { 'process.env.NODE_ENV': '"production"' },  // React's production build
    logOverride: { 'duplicate-object-key': 'silent' }, // known dupes in the HU→EN table
    metafile: true,
  });
  const bytes = Object.values(result.metafile.outputs)[0].bytes;

  // A csomag TARTALMI ujjlenyomata bekerul az app.html-be, es a betoltes ezzel
  // hivja: ./app.bundle.js?v=<hash>
  // MIERT KELL: a GitHub Pages 'cache-control: max-age=600' fejlecet ad a
  // csomagra, a betoltes pedig verziojel nelkul ugyanarra az URL-re mutatott.
  // Egy kiadas utan a bongeszo tehat akar tiz percig — sajat modul-
  // gyorsitotarabol pedig tovabb — a REGI kodot futtatta. Ez nem elmeleti:
  // egy valos bejelentesnel az elo csomagban MAR benne volt a javitas, a
  // felhasznalo bongeszoje megis a regi hibauzenetet mutatta.
  // Tartalmi hash es nem idobelyeg: valtozatlan csomagnal az app.html sem
  // valtozik, tehat nem termel zajt a git-tortenetben.
  const bundlePath = join(root, 'app.bundle.js');
  const hash = createHash('sha256').update(readFileSync(bundlePath)).digest('hex').slice(0, 12);
  const htmlPath = join(root, 'app.html');
  const html = readFileSync(htmlPath, 'utf8');
  if (!/const BUNDLE_V = '[^']*';/.test(html)) {
    console.error('FIGYELEM: az app.html-ben nincs BUNDLE_V sor — a gyorsitotar-tores NEM aktiv.');
  } else {
    const ujHtml = html.replace(/const BUNDLE_V = '[^']*';/, `const BUNDLE_V = '${hash}';`);
    if (ujHtml !== html) writeFileSync(htmlPath, ujHtml);
  }

  console.log(`app.bundle.js  ${(bytes / 1024).toFixed(1)} kB   v=${hash}`);
} finally {
  rmSync(entry, { force: true });
}
