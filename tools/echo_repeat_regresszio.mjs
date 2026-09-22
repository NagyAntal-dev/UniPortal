// ============================================================================
// echo_repeat_regresszio.mjs — a célok / elvárások értékelésének ellenőrzése
// (features/echo.jsx; bugreport 02)
// ----------------------------------------------------------------------------
// MIT ŐRIZ:
//   • repeat:"goal"         — CSAK a saját célokon fut (kind:'goal');
//   • repeat:"teacher_goal" — OKTATÓ × ELVÁRÁS páronként (N×M), és ha nincs
//                             elvárás, egyetlen lépés sem lesz belőle;
//   • a cél képernyőjén csak célkérdés, az elvárásén csak elváráskérdés;
//   • a névtelen payloadba nem kerül tételes kulcs, szöveg vagy darabszám.
//
// A VALÓDI echo.jsx függvényeit futtatja: a forrásból kivágja a tiszta (JSX-
// mentes) függvényeket, és egy sandboxban kiértékeli őket — nem utánzatot.
//
// FUTTATÁS:
//   node tools/echo_repeat_regresszio.mjs
// ============================================================================
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'features', 'echo.jsx'), 'utf8');

// Egy felső szintű `function NAME(` vagy `const NAME =` definíció kivágása
// zárójel-egyeztetéssel (a stringek/kommentek kapcsos zárójeleit kihagyva).
function kivag(name) {
  const re = new RegExp('^(function ' + name + '\\(|const ' + name + ' =)', 'm');
  const m = re.exec(SRC);
  assert(m, 'Nincs ilyen definicio az echo.jsx-ben: ' + name);
  let i = SRC.indexOf('{', m.index);
  let depth = 0, str = null;
  for (; i < SRC.length; i++) {
    const c = SRC[i], n = SRC[i + 1];
    if (str) {
      if (c === '\\') { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '/' && n === '/') { i = SRC.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = SRC.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) break;
  }
  let end = i + 1;
  if (SRC[end] === ';') end++;
  return SRC.slice(m.index, end);
}

const NEVEK = [
  'ECHO_goalItems', 'ECHO_goalKey', 'ECHO_repTeacher', 'ECHO_repGoal', 'ECHO_repTeacherExp',
  'ECHO_goalItemsFor', 'ECHO_repGoalFor', 'ECHO_repTeacherExpFor', 'ECHO_teacherExpKey',
  'ECHO_skipQ', 'ECHO_teacherSkipped', 'ECHO_GOAL_RANK', 'ECHO_goalsMerge', 'ECHO_buildSteps',
  'ECHO_condOk', 'ECHO_answered', 'ECHO_OTHER_WORDS', 'ECHO_isOtherOption', 'ECHO_otherPicked',
  'ECHO_otherText', 'ECHO_otherMissing', 'ECHO_buildPayload', 'ECHO_otherGaps', 'ECHO_elsoHianyosLepes',
  'ECHO_stepId', 'ECHO_stepAfterChange',
];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(NEVEK.map(kivag).join('\n\n') + '\n;globalThis.E = {' + NEVEK.join(',') + '};', ctx);
const E = ctx.E;

// ---- tesztkérdőív: a goals_met (repeat:goal) és egy teacher_goal kérdés
// UGYANABBAN a szakaszban — ez a bugreport képernyőjének helyzete. ----
const OPTS = [{ value: 'nem_teljesult', hu: 'Nem teljesült' }, { value: 'reszben', hu: 'Részben teljesült' },
              { value: 'teljesult', hu: 'Teljesült' }];
const FORM = {
  sections: [
    { id: 'plain', part: 'part2', questions: [{ id: 'overall', type: 'scale' }] },
    { id: 'tsec', part: 'part2', questions: [
      { id: 'skip', type: 'skip', repeat: 'teacher' },
      { id: 't_q', type: 'single', repeat: 'teacher', cond: { skip: null } },
    ] },
    { id: 'goals', part: 'part2', questions: [
      { id: 'goals_met', type: 'single', repeat: 'goal', options: OPTS },
      { id: 'exp_met', type: 'single', repeat: 'teacher_goal', options: OPTS },
    ] },
  ],
};
const T = (n) => Array.from({ length: n }, (_, i) => ({ id: 'T' + (i + 1), name: 'Oktató ' + (i + 1) }));
const G = (goals, exps) => E.ECHO_goalItems({
  goals: Array.from({ length: goals }, (_, i) => 'C' + (i + 1)),
  expectations: Array.from({ length: exps }, (_, i) => 'E' + (i + 1)),
});
const lepesek = (steps, kind) => steps.filter(s => s.kind === kind);
const plain = (x) => JSON.parse(JSON.stringify(x));

let ok = 0;
function eset(nev, fn) { fn(); ok++; console.log('  ok  ' + nev); }

// ---- 1) N × M ----
for (const [n, m, varhato] of [[1, 1, 1], [2, 1, 2], [1, 3, 3], [2, 3, 6], [2, 0, 0]]) {
  eset(`${n} oktató + ${m} elvárás → ${varhato} elvárásértékelés`, () => {
    const steps = E.ECHO_buildSteps(FORM, T(n), G(1, m), {});
    const te = lepesek(steps, 'teacher_exp');
    assert.equal(te.length, varhato);
    // Minden (oktató, elvárás) pár pontosan egyszer.
    const parok = new Set(te.map(s => s.teacher.id + '|' + s.goal.key));
    assert.equal(parok.size, varhato);
    // A teacher_goal kérdés NEM hoz létre sima oktatói lépést — a 'teacher'
    // lépések száma csak a tsec szakaszból jön (oktatónként 1).
    assert.equal(lepesek(steps, 'teacher').length, n);
  });
}

eset('csak teacher_goal kérdés a kérdőívben, 2 oktató + 0 elvárás → 0 lépés', () => {
  const form = { sections: [{ id: 's', questions: [{ id: 'exp_met', type: 'single', repeat: 'teacher_goal', options: OPTS }] }] };
  const steps = E.ECHO_buildSteps(form, T(2), G(2, 0), {});
  assert.deepEqual(plain(steps.map(s => s.kind)), ['review']);
});

eset('0 cél + elvárások → célértékelő lépés nincs', () => {
  const steps = E.ECHO_buildSteps(FORM, T(1), G(0, 2), {});
  assert.equal(lepesek(steps, 'goal').length, 0);
  assert.equal(lepesek(steps, 'teacher_exp').length, 2);
});

eset('célok + 0 elvárás → csak célértékelés', () => {
  const steps = E.ECHO_buildSteps(FORM, T(2), G(3, 0), {});
  assert.equal(lepesek(steps, 'goal').length, 3);
  assert.equal(lepesek(steps, 'teacher_exp').length, 0);
  assert(lepesek(steps, 'goal').every(s => s.goal.kind === 'goal'));
});

eset('cél + elvárás → cél képernyőn csak célkérdés, elvárásén csak elváráskérdés', () => {
  const steps = E.ECHO_buildSteps(FORM, T(2), G(1, 1), {});
  const qs = FORM.sections[2].questions;
  const goal = lepesek(steps, 'goal')[0];
  const exp = lepesek(steps, 'teacher_exp')[0];
  assert.deepEqual(plain(qs.filter(q => E.ECHO_repGoalFor(q, goal.goal)).map(q => q.id)), ['goals_met']);
  assert.deepEqual(plain(qs.filter(q => E.ECHO_repTeacherExpFor(q, exp.goal)).map(q => q.id)), ['exp_met']);
  // A struktúra dönt: egy elvárás-tételre a goal kérdés soha nem illik, és fordítva.
  assert.equal(E.ECHO_repGoalFor(qs[0], exp.goal), false);
  assert.equal(E.ECHO_repTeacherExpFor(qs[1], goal.goal), false);
  // A goals_met hiányzó válasza nem blokkolhat elvárás-lépést és fordítva.
  const hiany = E.ECHO_elsoHianyosLepes(steps.map(s => s.section ? { ...s, section: { ...s.section,
    questions: s.section.questions.map(q => ({ ...q, required: q.repeat === 'goal' })) } } : s), {}, {}, true);
  assert.equal(steps[hiany.lepes].kind, 'goal');
});

eset('kihagyott oktató → a párjai kimaradnak', () => {
  const steps = E.ECHO_buildSteps(FORM, T(2), G(0, 2), { T1: { skip: 'nem tanított' } });
  const te = lepesek(steps, 'teacher_exp');
  assert.equal(te.length, 2);
  assert(te.every(s => s.teacher.id === 'T2'));
});

eset('kihagyás-kapu bepipálása nem ugratja tovább a kitöltőt (elvárás-szakasz ELŐBB)', () => {
  // A teacher_goal szakasz az oktatói szakasz ELŐTT áll: T1E1, T1E2, T2E1, T2E2, T1, T2.
  const form = { sections: [FORM.sections[2], FORM.sections[1]] };
  const before = E.ECHO_buildSteps(form, T(2), G(0, 2), {});
  const idx = before.findIndex(s => s.kind === 'teacher' && s.teacher.id === 'T1');
  const after = E.ECHO_buildSteps(form, T(2), G(0, 2), { T1: { skip: 'nem tanított' } });
  // A régi sorszám már egy másik lépésre mutat — ez volt a hiba.
  assert.notEqual(E.ECHO_stepId(after[idx]), E.ECHO_stepId(before[idx]));
  const n = E.ECHO_stepAfterChange(before, idx, after);
  assert.equal(after[n].kind, 'teacher');
  assert.equal(after[n].teacher.id, 'T1');
  // Visszapipálva is ugyanazon a lépésen marad.
  const back = E.ECHO_stepAfterChange(after, n, before);
  assert.equal(back, idx);
});

// ---- 2) payload ----
eset('payload: oktatónként összevont érték, a goals_met-be nem olvad elvárás', () => {
  const teachers = T(2), items = G(1, 2);
  const ans = {
    'goals_met@g0': 'teljesult',
    'exp_met@e0@T1': 'teljesult', 'exp_met@e1@T1': 'teljesult',
    'exp_met@e0@T2': 'reszben',   'exp_met@e1@T2': 'nem_teljesult',
  };
  // régi (javítás előtti) draftból maradt közvetlen oktatói teacher_goal érték
  const tans = { T1: { exp_met: 'nem_teljesult' }, T2: {} };
  const p = plain(E.ECHO_buildPayload(FORM, teachers, ans, tans, true, items));
  assert.equal(p.course.goals_met, 'teljesult');          // az elvárások NEM rontják
  assert.equal(p.course.exp_met, 'reszben');              // az összes pár összevonva
  assert.equal(p.teachers[0].answers.exp_met, 'teljesult');
  assert.equal(p.teachers[1].answers.exp_met, 'reszben');
  const json = JSON.stringify(p);
  assert(!json.includes('@'), 'tételes kulcs került a payloadba');
  assert(!/\bE[12]\b|\bC1\b/.test(json), 'cél/elvárás szöveg került a payloadba');
});

eset('payload: nincs elvárás → nincs teacher_goal érték sehol', () => {
  const p = plain(E.ECHO_buildPayload(FORM, T(2), { 'goals_met@g0': 'reszben' }, { T1: { exp_met: 'teljesult' } }, true, G(1, 0)));
  assert.equal(p.course.exp_met, undefined);
  assert(p.teachers.every(t => t.answers.exp_met === undefined));
  assert.equal(p.course.goals_met, 'reszben');
});

eset('payload: kihagyott oktató nem kap és nem ad teacher_goal értéket', () => {
  const ans = { 'exp_met@e0@T1': 'nem_teljesult', 'exp_met@e0@T2': 'teljesult' };
  const p = plain(E.ECHO_buildPayload(FORM, T(2), ans, { T1: { skip: 'nem tanított' } }, true, G(0, 1)));
  assert.equal(p.teachers[0].skipped, true);
  assert.deepEqual(p.teachers[0].answers, {});
  assert.equal(p.teachers[1].answers.exp_met, 'teljesult');
  assert.equal(p.course.exp_met, 'teljesult');
});

console.log(`\nRENDBEN: ${ok} eset.`);
