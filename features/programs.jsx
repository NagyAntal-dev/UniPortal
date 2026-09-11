/* ============================================================
   UniPortal Pro — Program Management
   • Students browse the real NJE English-taught programmes and apply.
   • Each programme has its OWN configurable admission flow (steps +
     required documents) — a preparatory course differs from a degree.
   • Admins create/edit programmes, set fees/deadlines/capacity,
     open/close applications, configure the flow, and review applicants.
   ============================================================ */

const PROG_TABLE = 'programs', PROG_LS = 'uni_programs';
/* ÖSSZEVONT JELENTKEZÉSI FOLYAMAT — 37_merge_application_flows.sql
   ------------------------------------------------------------------
   Korábban a hallgatói jelentkezés a program_applications táblába ment, az
   ügyintéző viszont az admission_processes-t nézte. A kettő nem tudott
   egymásról, ezért a feltöltött dokumentumok nem jelentek meg az admin
   oldalon, és a felvételi folyamat megállt. (Ugyanez okozta a "dupla listát".)

   Mostantól EGY tábla van, két szakasszal:
     stage = 'student'  a jelentkező tölti   (student_step a számláló)
     stage = 'office'   az iroda dolgozik    (step a számláló)

   Az oszlopnevek eltérnek attól, amit ez a felület eddig használt. Hogy a
   húsz olvasási helyet ne kelljen átírni (és elrontani), a HATÁRON fordítunk:
   PROG_fromRow / PROG_toRow. A komponensek változatlan alakot látnak. */
const APP_TABLE = 'admission_processes', APP_LS = 'uni_applications';

const PROG_fromRow = (r) => !r ? r : ({
  id:              r.id,
  program_id:      r.program_id || (r.data && r.data.program_id) || '',
  applicant_email: r.owner_email || r.applicant_email || '',
  applicant_name:  r.applicant_name || '',
  // A felület 'draft' / 'submitted' párost vár; a tábla szakaszt tárol.
  status:          r.stage === 'office' ? 'submitted' : 'draft',
  step_index:      r.student_step || 0,
  data:            r.data || {},
  created_at:      r.created_at,
  updated_at:      r.updated_at,
});

const PROG_STEP_DEFS = {
  personal:   { label: 'Személyes adatok',    icon: Lucide.User },
  documents:  { label: 'Dokumentumok',           icon: Lucide.Upload },
  language:   { label: 'Angol nyelvtudás',  icon: Lucide.Languages },
  motivation: { label: 'Motivációs levél',    icon: Lucide.PenLine },
  math:       { label: 'Matematika szintfelmérő',  icon: Lucide.Calculator },
  interview:  { label: 'Online interjú',     icon: Lucide.Video },
  fee:        { label: 'Jelentkezési díj',       icon: Lucide.CreditCard },
  review:     { label: 'Beadás és ellenőrzés',       icon: Lucide.Send },
};
const PROG_DOC_DEFS = {
  passport:       'Útlevél (adatoldal)',
  hs_diploma:     'Érettségi bizonyítvány + leckekönyv',
  bsc_diploma:    'Alapdiploma + leckekönyv',
  msc_diploma:    'Mesterdiploma + leckekönyv',
  english:        'Angol nyelvtudás igazolása (B2+)',
  motivation:     'Motivációs levél',
  cv:             'Önéletrajz (CV)',
  portfolio:      'Portfólió / munkaminták',
  research:       'Kutatási terv',
  recommendation: 'Ajánlólevél',
};

/* EGYEDI DOKUMENTUMTÍPUSOK — 58_program_doc_types.sql
   ------------------------------------------------------------------
   A fenti beépített lista mellé az admin a szerkesztőből vehet fel újat; az
   onnantól minden program és képzés szerkesztésekor választható. A tábla csak
   az egyedieket tartja ('c_' előtagú kulccsal). A KULCS NEM VÁLTOZIK — rá
   hivatkozik a required_docs, a jelentkezés data.docs-a és a fájl útvonala —,
   csak a megnevezés. Törlés nincs, csak elrejtés: a már használt típus neve így
   sosem vész el.
   A név feloldása MINDENHOL a PROG_docLabel()-en megy át, hogy a hallgató, az
   admin és a szerkesztő ugyanazt a nevet lássa. Az angol nevet a HU_EN
   szótárba jegyezzük be, így a nyelvváltó a megszokott úton fordítja. */
const PROG_DOC_TABLE = 'program_doc_type';
let PROG_EGYEDI_DOK = {};   // kulcs -> { key, label_hu, label_en, active }
const PROG_docLabel = (id) => PROG_DOC_DEFS[id] || (PROG_EGYEDI_DOK[id] && PROG_EGYEDI_DOK[id].label_hu) || id;

function PROG_docTypeHiba(e) {
  const kod = (e && e.code) || '';
  const msg = String((e && e.message) || e || '');
  if (kod === 'PGRST205' || kod === '42P01' || (/program_doc_type/.test(msg) && /does not exist|schema cache/i.test(msg)))
    return 'Az 58_program_doc_types.sql migráció még nem futott le — egyedi dokumentumtípus addig nem vehető fel.';
  if (kod === '42501' || /row-level security|permission denied/i.test(msg)) return 'Új dokumentumtípust csak rendszergazda vehet fel.';
  // Az RLS a tiltott UPDATE-et nem hibaként, hanem 0 érintett sorként adja vissza.
  if (kod === 'PGRST116') return 'A módosítás nem ment át — dokumentumtípust csak rendszergazda módosíthat.';
  if (kod === '23505') return 'Ilyen nevű dokumentumtípus már van.';
  if (kod === '23514') return 'A megnevezés 2–120 karakter legyen.';
  return 'A mentés nem sikerült: ' + msg;
}

// Ékezet nélküli, tárolási útvonalba is biztonságos kulcs: c_<név>_<4 jel>.
const PROG_docKey = (nev) => 'c_' + ((String(nev).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)) || 'dok') + '_' + Math.random().toString(36).slice(2, 6).padEnd(4, '0');

/* NEM a dlSelect-en át: az a hiányzó táblát csendben localStorage-ra cseréli,
   és akkor az egyedi típus csak az adott böngészőben létezne. */
async function PROG_loadDocTypes() {
  if (!window.sb) return { rows: [], hiba: 'Nincs kapcsolat az adatbázissal.' };
  try {
    const { data, error } = await window.sb.from(PROG_DOC_TABLE).select('key,label_hu,label_en,active').order('created_at', { ascending: true });
    if (error) return { rows: [], hiba: PROG_docTypeHiba(error) };
    const m = {};
    (data || []).forEach(r => {
      m[r.key] = r;
      if (r.label_en && typeof HU_EN !== 'undefined') HU_EN[r.label_hu] = r.label_en;
    });
    PROG_EGYEDI_DOK = m;
    return { rows: data || [], hiba: null };
  } catch (e) { return { rows: [], hiba: PROG_docTypeHiba(e) }; }
}
const PROG_LEVELS = { preparatory: 'Előkészítő', course: 'Eseti / rövid kurzus', training: 'Továbbképzés', company_visit: 'Céglátogatás', excursion: 'Tanulmányi kirándulás', bachelor: 'Alapképzés (BSc)', master: 'Mesterképzés (MA · MBA)', doctoral: 'Doktori (PhD)' };
const PROG_LEVEL_TONE = { preparatory: 'amber', course: 'green', training: 'violet', company_visit: 'slate', excursion: 'blue', bachelor: 'blue', master: 'violet', doctoral: 'primary' };
/* KÉT KÜLÖN KÍNÁLAT, EGY TÁBLÁBAN. A `level` dönti el, hová tartozik egy sor:
     képzés (degree)  — féléves, fokozatot adó képzések: az admin „Képzések”,
                        a hallgató „Képzések” (a volt Hallgatói Portál) menüpontja;
     program          — kisebb, eseti programok (céglátogatás, továbbképzés,
                        eseti kurzus…): mindkét oldalon a „Programok” menüpont.
   A `level` szabad szöveg az adatbázisban, új típushoz nem kell migráció. */
const PROG_DEGREE_LEVELS = ['bachelor', 'master', 'doctoral'];
const PROG_PROGRAM_LEVELS = ['course', 'training', 'company_visit', 'preparatory', 'excursion'];
/* A kártyán megjelenő címke alapértéke típusonként — a szerkesztő ezt írja be,
   amíg az admin át nem írja a sajátjára. */
const PROG_DEFAULT_DEGREE = { preparatory: 'Certificate', course: 'Short course', training: 'Training', company_visit: 'Company visit', excursion: 'Excursion', bachelor: 'BSc', master: 'MA', doctoral: 'PhD' };
const PROG_kind = (p) => (p && p.kind) || (PROG_DEGREE_LEVELS.includes(p && p.level) ? 'degree' : 'program');

const PROG_IMGS = {
  'prep-engmath': 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=800&q=70',
  'bsc-cse': 'https://images.unsplash.com/photo-1517180102446-f3ece451e9d8?auto=format&fit=crop&w=800&q=70',
  'bsc-me': 'https://images.unsplash.com/photo-1537462715879-360eeb61a0ad?auto=format&fit=crop&w=800&q=70',
  'bsc-ve': 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=70',
  'bsc-le': 'https://images.unsplash.com/photo-1553413077-190dd305871c?auto=format&fit=crop&w=800&q=70',
  'bsc-bam': 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=800&q=70',
  'bsc-ibe': 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=800&q=70',
  'bsc-tc': 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=800&q=70',
  'bsc-hort': 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=800&q=70',
  'ma-ree': 'https://images.unsplash.com/photo-1466611653911-95081537e5b7?auto=format&fit=crop&w=800&q=70',
  'mba': 'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?auto=format&fit=crop&w=800&q=70',
  'phd-mba': 'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?auto=format&fit=crop&w=800&q=70',
  'prep-health': 'https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=800&q=70',
  'course-hun-lang': 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?auto=format&fit=crop&w=800&q=70',
  'course-summer-robotics': 'https://images.unsplash.com/photo-1561144257-e32e8efc6c4f?auto=format&fit=crop&w=800&q=70',
  'excursion-danube': 'https://images.unsplash.com/photo-1541849546-216549ae216d?auto=format&fit=crop&w=800&q=70',
  'excursion-automotive': 'https://images.unsplash.com/photo-1565043666747-69f6646db940?auto=format&fit=crop&w=800&q=70',
};
const PROG_LEVEL_GRAD = { preparatory: 'from-amber-400 to-orange-500', course: 'from-emerald-500 to-teal-600', training: 'from-violet-500 to-fuchsia-600', company_visit: 'from-slate-600 to-blue-700', excursion: 'from-sky-400 to-cyan-600', bachelor: 'from-sky-500 to-blue-600', master: 'from-violet-500 to-purple-600', doctoral: 'from-primary to-orange-600' };
function PROG_Banner({ program, className }) {
  const grad = PROG_LEVEL_GRAD[program.level] || 'from-slate-500 to-slate-700';
  return (
    <div className={'relative overflow-hidden bg-gradient-to-br ' + grad + ' ' + (className || '')}>
      <div className="absolute inset-0 flex items-center justify-center text-white/25"><Lucide.GraduationCap size={64} /></div>
      {program.image_url ? <img src={program.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 w-full h-full object-cover" onError={e => { e.currentTarget.style.display = 'none'; }} /> : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
    </div>
  );
}

function PROG_seed() {
  const dl = '2026-06-30';
  const now = todayStr();
  const P = (id, code, name, level, faculty, degree, dur, ects, tuition, cap, steps, docs, summary, tags) =>
    ({ id, code, name, level, faculty, degree, duration_semesters: dur, ects, tuition, currency: 'EUR', language: 'English', deadline: dl, capacity: cap, seats_taken: Math.floor(cap * (0.2 + Math.random() * 0.4)), is_open: true, summary, required_docs: docs, steps, tags, created_at: now });
  const engSteps = ['personal', 'documents', 'math', 'interview', 'fee', 'review'];
  const bizSteps = ['personal', 'documents', 'motivation', 'interview', 'fee', 'review'];
  const list = [
    P('prep-engmath', 'PREP', 'Preparatory English and Mathematics', 'preparatory', 'Preparatory Programme', 'Certificate', 2, 60, 1800, 60,
      ['personal', 'documents', 'math', 'fee', 'review'], ['passport', 'hs_diploma'],
      'A two-semester foundation year that strengthens English and mathematics so you can enter an English-taught bachelor programme with confidence.', ['Foundation', 'English + Maths']),
    P('prep-health', 'PREP-H', 'Preparatory course for Health Sciences', 'preparatory', 'Preparatory Programme', 'Certificate', 2, 60, 1800, 40,
      ['personal', 'documents', 'fee', 'review'], ['passport', 'hs_diploma'],
      'A one-year preparatory track for applicants aiming at health- and life-science degrees.', ['Foundation', 'Science']),
    P('course-hun-lang', 'HUN', 'Hungarian Language & Culture', 'course', 'International Office', 'Short course', 1, 10, 400, 60,
      ['personal', 'fee', 'review'], ['passport'],
      'A one-semester evening course in Hungarian language and culture for international students.', ['Language', 'Culture']),
    P('course-summer-robotics', 'SUM-ROB', 'Summer School: Introduction to Robotics', 'course', 'GAMF Faculty of Engineering & Computer Science', 'Short course', 1, 6, 600, 30,
      ['personal', 'documents', 'fee', 'review'], ['passport'],
      'A two-week hands-on summer school building and programming small robots.', ['Summer', 'Robotics']),
    P('excursion-danube', 'EXC-DAN', 'Study excursion: Budapest & the Danube Bend', 'excursion', 'International Office', 'Excursion', 1, 0, 90, 45,
      ['personal', 'fee', 'review'], ['passport'],
      'A guided two-day educational excursion to Budapest and the Danube Bend — history, industry and culture.', ['Excursion', 'Culture']),
    P('excursion-automotive', 'EXC-AUTO', 'Industry visit: Automotive plant tour', 'excursion', 'GAMF Faculty of Engineering & Computer Science', 'Excursion', 1, 0, 0, 25,
      ['personal', 'review'], [],
      'A one-day educational visit to a regional automotive manufacturing plant — engineering in practice.', ['Excursion', 'Industry']),
    P('bsc-cse', 'CSE', 'Computer Science Engineering', 'bachelor', 'GAMF Faculty of Engineering & Computer Science', 'BSc', 7, 210, 2900, 40,
      engSteps, ['passport', 'hs_diploma', 'english'],
      'Software, embedded systems, networks and AI foundations with strong regional IT-industry placements.', ['Software', 'AI', 'Industry links']),
    P('bsc-me', 'ME', 'Mechanical Engineering', 'bachelor', 'GAMF Faculty of Engineering & Computer Science', 'BSc', 7, 210, 2900, 35,
      engSteps, ['passport', 'hs_diploma', 'english'],
      'Design, manufacturing and mechatronics with hands-on lab and workshop practice.', ['Mechatronics', 'Manufacturing']),
    P('bsc-ve', 'VE', 'Vehicle Engineering', 'bachelor', 'GAMF Faculty of Engineering & Computer Science', 'BSc', 7, 210, 3000, 35,
      engSteps, ['passport', 'hs_diploma', 'english'],
      'Automotive design and testing, closely tied to the region\u2019s automotive manufacturing cluster.', ['Automotive', 'Testing']),
    P('bsc-le', 'LE', 'Logistics Engineering', 'bachelor', 'GAMF Faculty of Engineering & Computer Science', 'BSc', 7, 210, 2800, 30,
      engSteps, ['passport', 'hs_diploma', 'english'],
      'Supply-chain, transport and warehouse systems engineering with data-driven optimisation.', ['Supply chain', 'Optimisation']),
    P('bsc-bam', 'BAM', 'Business Administration and Management', 'bachelor', 'Faculty of Economics and Business', 'BSc', 7, 210, 2400, 45,
      bizSteps, ['passport', 'hs_diploma', 'english', 'motivation'],
      'Management, finance, marketing and entrepreneurship for a global business career.', ['Management', 'Finance']),
    P('bsc-ibe', 'IBE', 'International Business Economics', 'bachelor', 'Faculty of Economics and Business', 'BSc', 7, 210, 2400, 40,
      bizSteps, ['passport', 'hs_diploma', 'english', 'motivation'],
      'International trade, economics and cross-border business in an English-only cohort.', ['Economics', 'International']),
    P('bsc-tc', 'TC', 'Tourism and Catering', 'bachelor', 'Faculty of Economics and Business', 'BSc', 7, 210, 2400, 40,
      bizSteps, ['passport', 'hs_diploma', 'english', 'motivation'],
      'Hospitality, tourism management and catering with practical placements.', ['Hospitality', 'Tourism']),
    P('bsc-hort', 'HORT', 'Horticultural Engineering', 'bachelor', 'Faculty of Horticulture & Rural Development', 'BSc', 7, 210, 2600, 25,
      ['personal', 'documents', 'interview', 'fee', 'review'], ['passport', 'hs_diploma', 'english'],
      'Plant production, greenhouse technology and sustainable horticulture.', ['Sustainability', 'Agri-tech']),
    P('ma-ree', 'REE', 'Regional and Environmental Economics', 'master', 'Faculty of Economics and Business', 'MA', 4, 120, 3200, 25,
      bizSteps, ['passport', 'bsc_diploma', 'english', 'motivation', 'cv'],
      'Environmental policy, regional development and applied economics for a sustainable economy.', ['Policy', 'Sustainability']),
    P('mba', 'MBA', 'Master of Business Administration', 'master', 'Faculty of Economics and Business', 'MBA', 4, 120, 3900, 30,
      bizSteps, ['passport', 'bsc_diploma', 'english', 'motivation', 'cv'],
      'A general-management MBA for early-career professionals, with leadership and strategy focus.', ['Leadership', 'Strategy']),
    P('phd-mba', 'PHD', 'Management and Business Administration Sciences', 'doctoral', 'Doctoral School of Management & Business', 'PhD', 8, 240, 0, 12,
      ['personal', 'documents', 'motivation', 'interview', 'review'], ['passport', 'msc_diploma', 'english', 'research', 'recommendation', 'cv'],
      'A research doctorate supervised within the Doctoral School; tuition may be covered by scholarship.', ['Research', 'Doctoral']),
  ];
  // `kind` is deliberately NOT part of a stored row: the programs table has no
  // such column, and it is fully derived from `level` anyway. Read it through
  // PROG_kind(), which falls back to that derivation.
  return list.map(p => ({ ...p, image_url: PROG_IMGS[p.id] || null }));
}

async function PROG_loadPrograms() {
  const list = await dlSelect(PROG_TABLE, PROG_LS, PROG_seed, 'name', true);
  // Add any seed programmes missing from an existing store (e.g. the newer
  // short courses / excursions), and backfill images + category — all
  // non-destructive (never overwrites an admin's own edits).
  const seed = PROG_seed();
  const has = {}; list.forEach(p => { has[p.id] = true; });
  const missing = seed.filter(s => !has[s.id]);
  let changed = missing.length > 0;
  let merged = list.concat(missing).map(p => {
    let q = p;
    if (!q.image_url && PROG_IMGS[q.id]) { changed = true; q = { ...q, image_url: PROG_IMGS[q.id] }; }
    return q;
  });
  if (changed) {
    if (DL_PROBE[PROG_TABLE] === 'ls') { try { dlLocalSave(PROG_LS, merged); } catch (e) {} }
    else if (DL_PROBE[PROG_TABLE] === 'sb' && missing.length && window.sb) { try { await window.sb.from(PROG_TABLE).upsert(missing.map(s => ({ ...s, image_url: PROG_IMGS[s.id] || null })), { onConflict: 'id', ignoreDuplicates: true }); } catch (e) {} }
  }
  return merged;
}
const PROG_loadApps = async () =>
  ((await dlSelect(APP_TABLE, APP_LS, () => [], 'created_at', false)) || []).map(PROG_fromRow);

const PROG_STATUS = {
  draft:     { label: 'Piszkozat',      tone: 'slate' },
  submitted: { label: 'Beadva',  tone: 'blue' },
  in_review: { label: 'Bírálat alatt',  tone: 'amber' },
  accepted:  { label: 'Elfogadva',   tone: 'green' },
  waitlist:  { label: 'Várólistán', tone: 'violet' },
  rejected:  { label: 'Elutasítva',   tone: 'red' },
};

/* ---------- compact math placement generator ---------- */
const PROG_rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
function PROG_genMath() {
  const x = PROG_rnd(2, 9), y = PROG_rnd(1, 8), a = x + y, b = x - y;
  const ea = PROG_rnd(2, 6), eb = PROG_rnd(1, 4), ek = PROG_rnd(2, 3), eVal = Math.pow(ea - ek * eb, 2) + ea * eb;
  const p = PROG_rnd(1, 5), q = PROG_rnd(1, 6), t = PROG_rnd(2, 5), qVal = t * t + p * t + q;
  return [
    { id: 't1', title: 'Egyenletrendszer', prompt: 'Oldd meg x-re és y-ra:  x + y = ' + a + '  és  x \u2212 y = ' + b, fields: [{ key: 'x', label: 'x =' }, { key: 'y', label: 'y =' }], answers: { x, y } },
    { id: 't2', title: 'Kifejezés kiértékelése', prompt: 'Számítsd ki: (a \u2212 ' + ek + 'b)\u00b2 + a\u00b7b  ha  a = ' + ea + '  és  b = ' + eb, fields: [{ key: 'r', label: 'Érték =' }], answers: { r: eVal } },
    { id: 't3', title: 'Másodfokú függvény', prompt: 'Adott f(x) = x\u00b2 + ' + p + 'x + ' + q + ',  mennyi f(' + t + ')', fields: [{ key: 'r', label: 'f(' + t + ') =' }], answers: { r: qVal } },
  ];
}
const PROG_gradeMath = (tasks, ans) => {
  let correct = 0;
  for (const t of tasks) { const ok = t.fields.every(f => Math.abs(parseFloat(ans[t.id + '_' + f.key]) - t.answers[f.key]) < 1e-6); if (ok) correct++; }
  return { correct, total: tasks.length, passed: correct >= Math.ceil(tasks.length * 0.67) };
};
function PROG_slots() {
  const out = []; const base = new Date(); base.setHours(9, 0, 0, 0);
  for (let d = 3; d <= 9; d += 2) for (const h of [9, 11, 14]) { const s = new Date(base.getTime() + d * 86400000); s.setHours(h); out.push({ id: 'IV-' + d + '-' + h, time: s.toISOString(), interviewer: h < 12 ? 'Dr. Kovács' : 'Szabó Péter' }); }
  return out;
}

/* ---------- student: program detail + apply launcher ---------- */
function PROG_Detail({ program, myApp, onClose, onApply }) {
  if (!program) return null;
  const dleft = DL_daysLeft(program.deadline);
  const steps = program.steps || [];
  return (
    <UModal open={!!program} onClose={onClose} max="max-w-2xl" title={program.name} subtitle={program.degree + ' · ' + program.faculty} icon={<Lucide.GraduationCap size={20} />}>
      <div className="space-y-6">
        <div className="relative h-40 rounded-2xl overflow-hidden">
          <PROG_Banner program={program} className="h-full" />
        </div>
        <div className="flex flex-wrap gap-2">
          <UBadge tone={PROG_LEVEL_TONE[program.level]}>{PROG_LEVELS[program.level]}</UBadge>
          {(program.tags || []).map(t => <UBadge key={t} tone="slate">{t}</UBadge>)}
        </div>
        <p className="text-sm text-slate-500 leading-relaxed">{program.summary}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[['Tandíj', DL_money(program.tuition) + (program.tuition ? '/sem' : '')], ['Időtartam', program.duration_semesters + ' szemeszter'], ['ECTS', program.ects], ['Nyelv', program.language]].map(([k, v]) => (
            <div key={k} className="bg-slate-50 rounded-2xl p-3"><div className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{k}</div><div className="font-black text-slate-800 mt-0.5">{v}</div></div>
          ))}
        </div>
        <div>
          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">A képzés felvételi lépései</div>
          <div className="flex flex-wrap items-center gap-2">
            {steps.map((s, i) => { const def = PROG_STEP_DEFS[s]; const I = def ? def.icon : Lucide.Circle; return (
              <React.Fragment key={s}>
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-slate-100 text-[12px] font-bold text-slate-600"><I size={13} className="text-primary" /> {def ? def.label : s}</span>
                {i < steps.length - 1 && <Lucide.ChevronRight size={13} className="text-slate-300" />}
              </React.Fragment>
            ); })}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Szükséges dokumentumok</div>
          <div className="grid sm:grid-cols-2 gap-2">
            {(program.required_docs || []).map(d => <div key={d} className="flex items-center gap-2 text-sm text-slate-600"><Lucide.FileCheck size={15} className="text-emerald-500 flex-none" /> {PROG_docLabel(d)}</div>)}
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-100">
          <div className="text-sm">
            {program.is_open ? <span className="font-bold text-slate-500">Határidő <span className="text-slate-800">{DL_date(program.deadline)}</span>{dleft != null && dleft >= 0 && <span className="text-primary"> · {dleft + ' nap van hátra'}</span>}</span> : <span className="font-bold text-red-500">A jelentkezés lezárult</span>}
          </div>
          {myApp ? <button className={U_btnPrimary} onClick={() => onApply(program)}><Lucide.ArrowRight size={16} /> Jelentkezés folytatása</button>
                 : <button className={U_btnPrimary} disabled={!program.is_open} onClick={() => onApply(program)}><Lucide.Send size={16} /> Jelentkezem</button>}
        </div>
      </div>
    </UModal>
  );
}

/* ---------- student: the apply flow (runs the programme's own steps) ---------- */
function ProgramApply({ program, app, user, onExit, onSaved }) {
  const steps = program.steps || ['personal', 'review'];
  const [cur, setCur] = useState(app);
  const [idx, setIdx] = useState(Math.min(app.step_index || 0, steps.length - 1));
  const [saving, setSaving] = useState(false);
  const data = cur.data || {};
  const setData = (patch) => setCur(c => ({ ...c, data: { ...(c.data || {}), ...patch } }));

  const persist = async (extra = {}) => {
    setSaving(true);
    const patch = { student_step: idx, data: cur.data || {}, updated_at: new Date().toISOString(), ...extra };
    const saved = await dlUpdate(APP_TABLE, cur.id, patch, APP_LS);
    setSaving(false);
    if (saved) { const m = PROG_fromRow(saved); setCur(m); onSaved && onSaved(m); }
    return saved;
  };
  const goNext = async () => { const n = Math.min(idx + 1, steps.length - 1); setIdx(n); await persist({ student_step: n }); };
  const goPrev = () => setIdx(i => Math.max(0, i - 1));
  const stepKey = steps[idx];

  return (
    <div className="max-w-5xl 2xl:max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-in fade-in duration-300">
      <button onClick={onExit} className="flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-primary mb-4 transition-colors"><Lucide.ArrowLeft size={16} /> Vissza a képzésekhez</button>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">{program.degree} jelentkezés</p>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">{program.name}</h1>
        </div>
        <UBadge tone={PROG_STATUS[cur.status] ? PROG_STATUS[cur.status].tone : 'slate'}>{PROG_STATUS[cur.status] ? PROG_STATUS[cur.status].label : cur.status}</UBadge>
      </div>

      <div className="grid lg:grid-cols-[240px,1fr] gap-6">
        {/* step rail */}
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-3 h-fit">
          {steps.map((s, i) => { const def = PROG_STEP_DEFS[s] || { label: s, icon: Lucide.Circle }; const I = def.icon; const done = i < idx; const active = i === idx; return (
            <button key={s} onClick={() => setIdx(i)} className={'w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left transition-colors ' + (active ? 'bg-primary/10 text-primary' : done ? 'text-emerald-600 hover:bg-slate-50' : 'text-slate-500 hover:bg-slate-50')}>
              <span className={'w-7 h-7 rounded-lg flex items-center justify-center flex-none ' + (active ? 'bg-primary text-white' : done ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400')}>{done ? <Lucide.Check size={15} /> : <I size={15} />}</span>
              <span className="text-[13px] font-bold">{def.label}</span>
            </button>
          ); })}
        </div>

        {/* step body */}
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 sm:p-8 min-h-[360px]">
          <PROG_StepBody stepKey={stepKey} program={program} data={data} setData={setData} user={user} cur={cur} setCur={setCur}
            onSubmit={async () => {
              /* Előbb mentünk (hogy az utolsó lépés adatai is bent legyenek),
                 utána a szerver fordítja át a sort az irodai szakaszba. */
              await persist({ student_step: idx });
              if (!window.sb) return;
              const { error } = await window.sb.rpc('application_submit', { p_id: cur.id });
              if (error) { alert(error.message || 'A beadás nem sikerült. Próbáld újra.'); return; }
              setCur(c => ({ ...c, status: 'submitted' }));
              onSaved && onSaved({ ...cur, status: 'submitted' });
            }} />
          <div className="flex items-center justify-between gap-3 mt-8 pt-5 border-t border-slate-100">
            <button onClick={goPrev} disabled={idx === 0} className={U_btnGhost + (idx === 0 ? ' opacity-0 pointer-events-none' : '')}><Lucide.ArrowLeft size={15} /> Vissza</button>
            <div className="flex items-center gap-3">
              <button onClick={async () => { await persist(); onExit && onExit(); }} disabled={saving} className="text-sm font-bold text-slate-400 hover:text-slate-700 transition-colors disabled:opacity-50">{saving ? 'Mentés…' : 'Mentés és kilépés'}</button>
              {idx < steps.length - 1 && <button onClick={goNext} className={U_btnPrimary} disabled={!PROG_canAdvance(stepKey, program, data)}>Folytatás <Lucide.ArrowRight size={15} /></button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PROG_canAdvance(stepKey, program, data) {
  if (stepKey === 'documents') return (program.required_docs || []).every(d => data.docs && data.docs[d]);
  if (stepKey === 'math') return data.math && data.math.passed;
  if (stepKey === 'motivation') return (data.motivation || '').trim().length >= 40;
  if (stepKey === 'interview') return data.interview && data.interview.slot;
  if (stepKey === 'fee') return program.tuition === 0 || (data.fee && data.fee.paid);
  if (stepKey === 'personal') return data.personal && data.personal.name && data.personal.country;
  return true;
}

/* ---------- per-step bodies ---------- */
function PROG_StepBody({ stepKey, program, data, setData, user, cur, onSubmit }) {
  /* A feltöltés állapota. A hookok a függvény TETEJÉN állnak, mert a törzs
     lépésenként korán visszatér — feltételes ágban deklarálva megsértenék a
     hook-sorrendet. */
  const [docBusy, setDocBusy] = useState('');
  const [docErr, setDocErr] = useState('');

  if (stepKey === 'personal') {
    const p = data.personal || { name: (user && user.name) || '', email: (user && user.email) || '', phone: '', country: '', dob: '' };
    const set = (k, v) => setData({ personal: { ...p, [k]: v } });
    return (
      <div className="space-y-5">
        <PROG_Head icon={Lucide.User} title="Személyes adatok" sub="Erősítsd meg a kapcsolattartási adataidat ehhez a jelentkezéshez." />
        <div className="grid sm:grid-cols-2 gap-4">
          <UField label="Teljes név"><input className={U_input} value={p.name} onChange={e => set('name', e.target.value)} /></UField>
          <UField label="E-mail"><input className={U_input} value={p.email} onChange={e => set('email', e.target.value)} /></UField>
          <UField label="Telefon"><input className={U_input} value={p.phone} onChange={e => set('phone', e.target.value)} placeholder="+…" /></UField>
          <UField label="Állampolgárság szerinti ország"><input className={U_input} value={p.country} onChange={e => set('country', e.target.value)} placeholder="pl. Nigéria" /></UField>
          <UField label="Születési dátum"><input type="date" className={U_input} value={p.dob} onChange={e => set('dob', e.target.value)} /></UField>
        </div>
      </div>
    );
  }
  if (stepKey === 'documents') {
    const docs = data.docs || {};
    /* VALÓDI FELTÖLTÉS — korábban csak a fájl NEVÉT jegyeztük fel, maga a
       fájl eldobódott. Ezért nem látott semmit az ügyintéző a dokumentum-
       ellenőrzésnél, és állt meg a folyamat.

       A DOC_upload az app.jsx-ben él, a feature-fájlok annak a modul-
       hatókörébe fűződnek, tehát elérhető. Ugyanaz a tároló és ugyanaz az
       útvonalséma, mint az irodai úton — így az admin oldal aláírt
       hivatkozással meg tudja nyitni. */
    const upload = async (id, e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      setDocBusy(id);
      try {
        /* A TULAJDONOS A FELHASZNÁLÓ AZONOSÍTÓJA, NEM AZ E-MAIL-CÍME.
           A 'documents' tároló írási szabálya (08_documents_storage.sql,
           documents_insert_own) előírja, hogy az útvonal ELSŐ szegmense a
           feltöltő auth.uid()-ja legyen. Korábban itt az e-mail-cím állt, ezért
           MINDEN hallgatói feltöltést elutasított a szabály („new row violates
           row-level security policy") — MÉRVE élesben: e-mail-lel elbukott,
           UUID-val sikerült. Az irodai út (app.jsx) mindig is a user.id-t adta
           át; a két út most ugyanazt a sémát követi. A 'guest' tartalék is
           kikerült: munkamenet nélkül a DOC_upload 'storage-unavailable'-t dob,
           és azt alább érthetően kiírjuk. */
        const path = await DOC_upload(file, (user && user.id) || null, cur.id, id);
        setData({ docs: { ...docs, [id]: {
          fileName: file.name, path, size: file.size,
          type: file.type || '', at: todayStr(),
        } } });
      } catch (err) {
        /* A valódi okot eddig lenyeltük, és mindenre „Próbáld újra"-t írtunk —
           ezért nem derült ki, hogy a szabály utasítja el. Az ismert okokat
           most néven nevezzük; ismeretlen hibánál marad az általános üzenet. */
        const msg = String((err && (err.message || err.error)) || '');
        setDocErr(id + ': ' + (
          msg === 'storage-unavailable'
            ? 'Nincs kapcsolat a tárolóval — jelentkezz be újra.'
          : /row-level security|violates|unauthorized|403/i.test(msg)
            ? 'Nincs jogosultságod ide feltölteni. Jelentkezz ki és be újra; ha így sem megy, szólj az ügyintézőnek.'
          : /exceeded|too large|maximum allowed size|413/i.test(msg)
            ? 'A fájl túl nagy — legfeljebb 20 MB lehet.'
          : 'A feltöltés nem sikerült. Próbáld újra.'));
      } finally {
        setDocBusy('');
        e.target.value = '';
      }
    };
    return (
      <div className="space-y-5">
        <PROG_Head icon={Lucide.Upload} title="Dokumentumok feltöltése" sub="Ezek a fájlok kötelezőek ehhez a képzéshez." />
        <div className="space-y-3">
          {(program.required_docs || []).map(id => { const got = docs[id]; return (
            <div key={id} className={'flex items-center justify-between gap-4 p-4 rounded-2xl border ' + (got ? 'border-emerald-100 bg-emerald-50/40' : 'border-slate-100')}>
              <div className="flex items-center gap-3 min-w-0">
                <div className={'w-9 h-9 rounded-xl flex items-center justify-center flex-none ' + (got ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400')}>{got ? <Lucide.Check size={17} /> : <Lucide.FileText size={17} />}</div>
                <div className="min-w-0"><div className="text-sm font-bold text-slate-700 truncate">{PROG_docLabel(id)}</div>{got && <div className="text-[11px] text-emerald-600 font-semibold truncate">{got.fileName}</div>}</div>
              </div>
              <label className={U_btnGhost + ' flex-none cursor-pointer text-[13px] py-2 px-4 ' + (docBusy === id ? 'opacity-50 pointer-events-none' : '')}>
                {docBusy === id ? 'Feltöltés…' : got ? 'Csere' : 'Feltöltés'}
                <input type="file" className="hidden" disabled={!!docBusy} onChange={e => upload(id, e)} />
              </label>
            </div>
          ); })}
        </div>
          {docErr && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600">
            <Lucide.AlertCircle size={16} className="flex-none mt-0.5" />
            <span className="flex-1">{docErr}</span>
            <button onClick={() => setDocErr('')} className="text-red-400 hover:text-red-600"><Lucide.X size={14} /></button>
          </div>
          )}
      </div>
    );
  }
  if (stepKey === 'language') {
    const l = data.language || { cert: '', level: '' };
    const set = (k, v) => setData({ language: { ...l, [k]: v } });
    return (
      <div className="space-y-5">
        <PROG_Head icon={Lucide.Languages} title="Angol nyelvtudás" sub="Add meg az angol nyelvvizsgád adatait (B2 vagy magasabb ajánlott)." />
        <div className="grid sm:grid-cols-2 gap-4">
          <UField label="Bizonyítvány"><select className={U_input} value={l.cert} onChange={e => set('cert', e.target.value)}><option value="">Válassz…</option>{['IELTS', 'TOEFL', 'Cambridge', 'Duolingo', 'Oktatás nyelve', 'Egyéb'].map(o => <option key={o}>{o}</option>)}</select></UField>
          <UField label="Pontszám / szint"><input className={U_input} value={l.level} onChange={e => set('level', e.target.value)} placeholder="e.g. 6.5 / B2" /></UField>
        </div>
      </div>
    );
  }
  if (stepKey === 'motivation') {
    const val = data.motivation || '';
    return (
      <div className="space-y-4">
        <PROG_Head icon={Lucide.PenLine} title="Motivációs levél" sub="Miért ezt a képzést választod? Legalább ~40 karakter (egy rövid bekezdés ideális)." />
        <textarea className={U_input + ' min-h-[220px] resize-y'} value={val} onChange={e => setData({ motivation: e.target.value })} placeholder="Tisztelt Felvételi Bizottság! …" />
        <div className="text-[11px] font-bold text-slate-400">{val.trim().length + ' karakter'}</div>
      </div>
    );
  }
  if (stepKey === 'math') return <PROG_MathStep data={data} setData={setData} />;
  if (stepKey === 'interview') {
    const iv = data.interview || {};
    const slots = PROG_slots();
    const book = (s) => setData({ interview: { slot: s.time, interviewer: s.interviewer, teamsUrl: 'https://teams.microsoft.com/l/meetup-join/nje-' + s.id } });
    return (
      <div className="space-y-5">
        <PROG_Head icon={Lucide.Video} title="Online interjú foglalása" sub="A foglaláskor automatikusan létrejön a Microsoft Teams meeting." />
        {iv.slot ? (
          <div className="p-5 rounded-2xl bg-emerald-50 border border-emerald-100">
            <div className="flex items-center gap-2 text-emerald-700 font-black mb-2"><Lucide.CalendarCheck size={18} /> Interjú lefoglalva</div>
            <div className="text-sm text-slate-600 font-bold">{DL_dateLong(iv.slot)} · {new Date(iv.slot).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="text-sm text-slate-500">Interjúztató: {iv.interviewer} · Microsoft Teams</div>
            <button className="text-xs font-bold text-slate-400 hover:text-primary mt-2" onClick={() => setData({ interview: {} })}>Időpont módosítása</button>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {slots.map(s => <button key={s.id} onClick={() => book(s)} className="text-left p-4 rounded-2xl border border-slate-100 hover:border-primary hover:bg-primary/5 transition-all"><div className="font-black text-slate-800 text-sm">{DL_date(s.time)}</div><div className="text-primary font-bold text-sm">{new Date(s.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div><div className="text-[11px] text-slate-400 mt-1">{s.interviewer}</div></button>)}
          </div>
        )}
      </div>
    );
  }
  if (stepKey === 'fee') {
    const fee = data.fee || {};
    const isSmall = PROG_kind(program) === 'program';
    const amount = isSmall ? (program.tuition || 0) : 200;
    const feeLabel = isSmall ? 'Regisztrációs díj' : 'Jelentkezési díj';
    return (
      <div className="space-y-5">
        <PROG_Head icon={Lucide.CreditCard} title={feeLabel} sub={isSmall ? 'Foglald le a helyed — ez a díj erősíti meg a regisztrációdat.' : 'A jelentkezés feldolgozásához egyszeri, vissza nem térítendő jelentkezési díj szükséges.'} />
        <div className="p-5 rounded-2xl bg-slate-50 flex items-center justify-between"><span className="font-bold text-slate-600">{feeLabel}</span><span className="text-2xl font-black text-slate-900">{DL_money(amount)}</span></div>
        {amount === 0 ? (
          <div className="flex items-center gap-2 text-emerald-600 font-black p-4 rounded-2xl bg-emerald-50 border border-emerald-100"><Lucide.CheckCircle2 size={18} /> Nincs fizetendő díj — minden rendben.</div>
        ) : fee.paid ? (
          <div className="flex items-center gap-2 text-emerald-600 font-black p-4 rounded-2xl bg-emerald-50 border border-emerald-100"><Lucide.CheckCircle2 size={18} /> Fizetve: {fee.method} · {fee.date}</div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <button className={U_btnPrimary} onClick={() => setData({ fee: { paid: true, method: 'Kártya', date: todayStr() } })}><Lucide.CreditCard size={16} /> Fizetés kártyával</button>
            <button className={U_btnGhost} onClick={() => setData({ fee: { paid: true, method: 'Banki átutalás', date: todayStr() } })}><Lucide.Landmark size={16} /> Banki átutalás rögzítése</button>
          </div>
        )}
        <p className="text-[11px] text-slate-400">Teszt üzemmód — valódi terhelés nem történik.</p>
      </div>
    );
  }
  if (stepKey === 'review') {
    const ok = program.steps.filter(s => s !== 'review').every(s => PROG_canAdvance(s, program, data));
    const submitted = cur.status && cur.status !== 'draft';
    return (
      <div className="space-y-5">
        <PROG_Head icon={Lucide.Send} title={submitted ? 'Jelentkezés beadva' : 'Ellenőrzés és beadás'} sub={submitted ? 'A jelentkezésed a felvételi csoportnál van.' : 'Ellenőrizd, hogy minden kész, majd add be bírálatra.'} />
        {submitted ? (
          <div className="p-6 rounded-2xl bg-emerald-50 border border-emerald-100 text-center">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500 text-white flex items-center justify-center mx-auto mb-3"><Lucide.CheckCircle2 size={28} /></div>
            <div className="font-black text-emerald-800 text-lg">Köszönjük, {(data.personal && data.personal.name || '').split(' ')[0] || 'jelentkező'}!</div>
            <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">Megkaptuk a jelentkezésedet a(z) <b>{program.name}</b> képzésre. A következő lépésekről e-mailben és a Hírfolyamban értesítünk.</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {program.steps.filter(s => s !== 'review').map(s => { const def = PROG_STEP_DEFS[s]; const done = PROG_canAdvance(s, program, data); return (
                <div key={s} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50"><span className={'w-6 h-6 rounded-lg flex items-center justify-center flex-none ' + (done ? 'bg-emerald-500 text-white' : 'bg-amber-400 text-white')}>{done ? <Lucide.Check size={13} /> : <Lucide.Minus size={13} />}</span><span className="text-sm font-bold text-slate-600">{def ? def.label : s}</span><span className="ml-auto text-[11px] font-black uppercase tracking-wider text-slate-400">{done ? 'Kész' : 'Hiányos'}</span></div>
              ); })}
            </div>
            <button className={U_btnPrimary + ' w-full py-4'} disabled={!ok} onClick={onSubmit}>{ok ? 'Jelentkezés beadása' : 'A beadáshoz minden lépést teljesíts'}</button>
          </>
        )}
      </div>
    );
  }
  return <div className="text-slate-400">Ismeretlen lépés.</div>;
}
const PROG_Head = ({ icon, title, sub }) => { const I = icon; return (
  <div className="flex items-start gap-3"><div className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center flex-none"><I size={20} /></div><div><h3 className="text-lg font-black text-slate-900 tracking-tight">{title}</h3><p className="text-sm text-slate-400">{sub}</p></div></div>
); };

function PROG_MathStep({ data, setData }) {
  const [tasks, setTasks] = useState(null);
  const [ans, setAns] = useState({});
  const [result, setResult] = useState(data.math || null);
  useEffect(() => { if (!tasks) setTasks(PROG_genMath()); }, []);
  const grade = () => { const r = PROG_gradeMath(tasks, ans); setResult(r); setData({ math: r }); };
  const reset = () => { setTasks(PROG_genMath()); setAns({}); setResult(null); setData({ math: null }); };
  if (!tasks) return null;
  return (
    <div className="space-y-5">
      <PROG_Head icon={Lucide.Calculator} title="Matematika szintfelmérő" sub="Három rövid feladat. A megfeleléshez legalább 2 helyes válasz kell." />
      <div className="space-y-4">
        {tasks.map((t, i) => (
          <div key={t.id} className="p-4 rounded-2xl border border-slate-100">
            <div className="flex items-center gap-2 mb-2"><span className="w-6 h-6 rounded-lg bg-primary/10 text-primary text-xs font-black flex items-center justify-center">{i + 1}</span><span className="text-[11px] font-black uppercase tracking-wider text-slate-400">{t.title}</span></div>
            <p className="text-sm font-bold text-slate-700 mb-3">{t.prompt}</p>
            <div className="flex flex-wrap gap-3">
              {t.fields.map(f => <label key={f.key} className="flex items-center gap-2 text-sm font-bold text-slate-500">{f.label}<input disabled={!!result} className="w-24 bg-slate-50 border border-slate-100 rounded-lg px-3 py-1.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary/20" value={ans[t.id + '_' + f.key] || ''} onChange={e => setAns(a => ({ ...a, [t.id + '_' + f.key]: e.target.value }))} /></label>)}
            </div>
          </div>
        ))}
      </div>
      {result ? (
        <div className={'p-4 rounded-2xl border flex items-center justify-between ' + (result.passed ? 'bg-emerald-50 border-emerald-100' : 'bg-red-50 border-red-100')}>
          <div className={'font-black ' + (result.passed ? 'text-emerald-700' : 'text-red-600')}>{result.passed ? <span className="flex items-center gap-2"><Lucide.CheckCircle2 size={18} /> Sikeres — {result.correct}/{result.total} helyes</span> : <span className="flex items-center gap-2"><Lucide.XCircle size={18} /> {result.correct}/{result.total} helyes — próbáld újra</span>}</div>
          {!result.passed && <button className={U_btnGhost} onClick={reset}><Lucide.RefreshCw size={15} /> Új teszt</button>}
        </div>
      ) : <button className={U_btnPrimary} onClick={grade}>Válaszok beadása</button>}
    </div>
  );
}

/* ---------- student catalog ---------- */
/* A HALLGATÓ SZEMSZÖGÉBŐL: hol tart ezen a programon.
     tier 0 = FOLYTATANDÓ — megkezdte, és a program még nyitva: ezek állnak ELÖL
     tier 1 = BEADVA      — a hallgatónak most nincs vele teendője
     tier 2 = LEZÁRULT    — megkezdte, de a program közben lezárult
     tier 3 = még nem kezdte el
   A feltöltött dokumentumot a TÁROLÓBELI ÚTVONAL (path) jelzi. A régi
   bejegyzések csak a fájl nevét őrizték, maga a fájl nem került fel — azokat
   nem számoljuk feltöltöttnek, mert az ügyintéző sem látja őket. */
function PROG_myState(p, mine) {
  if (!mine) return { tier: 3 };
  const docs = (mine.data && mine.data.docs) || {};
  const kell = p.required_docs || [];
  const feltoltve = kell.filter(d => docs[d] && docs[d].path).length;
  const lepesek = (p.steps || []).filter(s => s !== 'review');
  const lepes = Math.min(Number(mine.step_index) || 0, lepesek.length);
  const alap = { feltoltve, kell: kell.length, lepes, osszes: lepesek.length };
  if (mine.status && mine.status !== 'draft') return { tier: 1, ...alap };
  if (!p.is_open) return { tier: 2, ...alap };
  return { tier: 0, ...alap };
}

// A számot EGY szövegcsomópontba építjük: a {a}/{b} JSX-alak több csomópontra
// törne, és a nyelvváltó kifejezés-mintája nem találna rá.
function PROG_hataridoSzoveg(p) {
  const d = DL_daysLeft(p.deadline);
  if (d == null || d < 0) return null;
  return { szoveg: d === 0 ? 'ma jár le a határidő' : `még ${d} nap a határidőig`, surgos: d <= 7 };
}

function PROG_Catalog({ programs, myApps, onOpen, onContinue, isDeg }) {
  const [level, setLevel] = useState('all');
  const [q, setQ] = useState('');
  const list = programs.filter(p => (level === 'all' || p.level === level) && (!q || (p.name + ' ' + p.faculty).toLowerCase().includes(q.toLowerCase())));
  // Csak a saját kínálat típusai, és közülük is csak azok, amelyekből van tétel —
  // egy üres szűrőgomb csak zsákutca.
  const chips = [['all', isDeg ? 'Minden szint' : 'Minden típus'],
    ...(isDeg ? PROG_DEGREE_LEVELS : PROG_PROGRAM_LEVELS).filter(k => programs.some(p => p.level === k)).map(k => [k, PROG_LEVELS[k]])];

  /* SORREND. A folytatandók elöl, azon belül a KÖZELEBBI HATÁRIDŐ előbb —
     akinek holnap zár, az ne a lista közepén várjon. Utánuk a beadottak és a
     lezárultak (a legutóbb módosított elöl), végül a többi program változatlan
     sorrendben. A rendezés a SZŰRT listán fut, tehát a szint- és a keresőszűrő
     ugyanúgy működik, mint eddig. */
  const ordered = list
    .map((p, i) => { const mine = myApps.find(a => a.program_id === p.id); return { p, i, mine, st: PROG_myState(p, mine) }; })
    .sort((a, b) => {
      if (a.st.tier !== b.st.tier) return a.st.tier - b.st.tier;
      if (a.st.tier === 0) {
        const da = DL_daysLeft(a.p.deadline), db = DL_daysLeft(b.p.deadline);
        const na = da == null ? 1e9 : da, nb = db == null ? 1e9 : db;
        if (na !== nb) return na - nb;
      }
      if (a.st.tier <= 2) {
        const ta = Date.parse((a.mine && a.mine.updated_at) || '') || 0;
        const tb = Date.parse((b.mine && b.mine.updated_at) || '') || 0;
        if (ta !== tb) return tb - ta;
      }
      return a.i - b.i;
    });
  const folytatando = ordered.filter(x => x.st.tier === 0).length;

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1"><Lucide.Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" /><input className={U_input + ' pl-10'} placeholder={isDeg ? 'Keresés a képzések között…' : 'Keresés a programok között…'} value={q} onChange={e => setQ(e.target.value)} /></div>
      </div>
      <div className="flex items-center gap-2 overflow-x-auto pb-2 mb-5 custom-scrollbar">
        {chips.map(([k, label]) => <button key={k} onClick={() => setLevel(k)} className={'flex-none px-4 py-2 rounded-full text-[13px] font-bold transition-all ' + (level === k ? 'bg-slate-900 text-white' : 'bg-white border border-slate-100 text-slate-500 hover:border-slate-300')}>{label}</button>)}
      </div>

      {folytatando > 0 && (
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <Lucide.PlayCircle size={18} className="text-amber-600 flex-none mt-0.5" />
          <div>
            <p className="text-sm font-black text-amber-900">{folytatando === 1 ? 'Egy megkezdett jelentkezésed vár folytatásra' : `${folytatando} megkezdett jelentkezésed vár folytatásra`}</p>
            <p className="text-[12px] text-amber-800/80">Elöl, kiemelve látod őket.</p>
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
        {ordered.map(({ p, mine, st }) => {
          const kiemelt = st.tier === 0;
          const hd = kiemelt ? PROG_hataridoSzoveg(p) : null;
          const stat = mine ? (PROG_STATUS[mine.status] || PROG_STATUS.draft) : null;
          return (
          <div key={p.id} className={'group bg-white rounded-3xl border shadow-sm flex flex-col overflow-hidden hover:shadow-md transition-all '
            + (kiemelt ? 'border-amber-300 ring-2 ring-amber-200' : st.tier === 1 ? 'border-blue-200' : 'border-slate-100 hover:border-slate-200')}>
            <div className="relative h-32">
              <PROG_Banner program={p} className="h-full" />
              <div className="absolute top-3 left-3 right-3 flex items-center justify-between">
                <UBadge tone={PROG_LEVEL_TONE[p.level]} className="!bg-white/90 backdrop-blur">{p.degree}</UBadge>
                {kiemelt ? <UBadge tone="amber" className="!bg-white/90 backdrop-blur">Folytatandó</UBadge>
                  : st.tier === 1 ? <UBadge tone={stat.tone} className="!bg-white/90 backdrop-blur">{stat.label}</UBadge>
                  : !p.is_open ? <UBadge tone="red" className="!bg-white/90 backdrop-blur">Lezárva</UBadge> : null}
              </div>
            </div>
            {kiemelt && (
              <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-100 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-amber-800">
                <span>{`${st.lepes}/${st.osszes} lépés kész`}</span>
                {st.kell > 0 && <span>{`${st.feltoltve}/${st.kell} dokumentum feltöltve`}</span>}
                {hd && <span className={hd.surgos ? 'text-red-600' : ''}>{hd.szoveg}</span>}
              </div>
            )}
            {st.tier === 2 && (
              <div className="px-5 py-2.5 bg-red-50 border-b border-red-100 text-[11px] font-bold text-red-700">A jelentkezés már nem folytatható</div>
            )}
            <div className="p-5 flex flex-col flex-1">
              <h3 className="font-black text-slate-900 tracking-tight leading-snug">{p.name}</h3>
              <p className="text-[12px] text-slate-400 font-semibold mt-1">{p.faculty}</p>
              <p className="text-sm text-slate-500 mt-3 leading-relaxed line-clamp-3 flex-1">{p.summary}</p>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-50">
                <div><div className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Tandíj</div><div className="font-black text-slate-800">{DL_money(p.tuition)}{p.tuition ? <span className="text-[11px] text-slate-400 font-bold">/sem</span> : ''}</div></div>
                {kiemelt ? (
                  <button onClick={() => onContinue(p, mine)} className={U_btnPrimary + ' py-2 px-4 text-[13px]'}>Folytatás <Lucide.ArrowRight size={15} /></button>
                ) : (
                  <button onClick={() => mine ? onContinue(p, mine) : onOpen(p)} className={'text-sm font-bold ' + (mine ? 'text-primary' : 'text-slate-500 group-hover:text-primary') + ' flex items-center gap-1 transition-colors'}>{(st.tier === 1 || st.tier === 2) ? 'Megnyitás' : mine ? 'Folytatás' : 'Megtekintés'} <Lucide.ArrowRight size={15} /></button>
                )}
              </div>
            </div>
          </div>
        ); })}
      </div>
      {list.length === 0 && <div className="bg-white rounded-3xl border border-slate-100 mt-2"><UEmpty icon={<Lucide.Search size={24} />} title="Nincs találat" subtitle="Próbálj másik szintet vagy keresőkifejezést." /></div>}
    </div>
  );
}

/* ---------- admin: program editor (incl. per-program flow editor) ---------- */
function PROG_Editor({ open, program, onClose, onSaved, scope }) {
  const isDeg = scope === 'degrees';
  const levelOpts = isDeg ? PROG_DEGREE_LEVELS : PROG_PROGRAM_LEVELS;
  const blank = { id: '', code: '', name: '', level: isDeg ? 'bachelor' : 'course', faculty: '', degree: isDeg ? 'BSc' : 'Short course', duration_semesters: isDeg ? 7 : 2, ects: isDeg ? 210 : 30, tuition: isDeg ? 2500 : 400, currency: 'EUR', language: 'English', deadline: '2026-06-30', capacity: 30, seats_taken: 0, is_open: true, summary: '', image_url: '', required_docs: isDeg ? ['passport', 'hs_diploma', 'english'] : ['passport'], steps: isDeg ? ['personal', 'documents', 'interview', 'fee', 'review'] : ['personal', 'fee', 'review'], tags: [] };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  // Egyedi dokumentumtípusok: minden megnyitáskor frissen, hogy a más admin
  // által közben felvett típus is látsszon.
  const DOK_URES = { open: false, hu: '', en: '', active: true, szerk: null, busy: false, hiba: '' };
  const [egyedi, setEgyedi] = useState([]);
  const [dokHiba, setDokHiba] = useState(null);
  const [dok, setDok] = useState(DOK_URES);
  useEffect(() => {
    if (!open) return;
    setDok(DOK_URES);
    let el = false;
    PROG_loadDocTypes().then(r => { if (!el) { setEgyedi(r.rows); setDokHiba(r.hiba); } });
    return () => { el = true; };
  }, [open]);
  const mentDok = async () => {
    const hu = dok.hu.trim(), en = dok.en.trim();
    if (hu.length < 2) { setDok(d => ({ ...d, hiba: 'A magyar megnevezés legalább 2 karakter.' })); return; }
    const foglalt = [...Object.values(PROG_DOC_DEFS), ...egyedi.filter(r => r.key !== dok.szerk).map(r => r.label_hu)]
      .some(l => String(l).trim().toLowerCase() === hu.toLowerCase());
    if (foglalt) { setDok(d => ({ ...d, hiba: 'Ilyen nevű dokumentumtípus már van.' })); return; }
    if (!window.sb) { setDok(d => ({ ...d, hiba: 'Nincs kapcsolat az adatbázissal.' })); return; }
    setDok(d => ({ ...d, busy: true, hiba: '' }));
    const res = dok.szerk
      ? await window.sb.from(PROG_DOC_TABLE).update({ label_hu: hu, label_en: en || null, active: dok.active }).eq('key', dok.szerk).select().single()
      : await window.sb.from(PROG_DOC_TABLE).insert({ key: PROG_docKey(hu), label_hu: hu, label_en: en || null }).select().single();
    if (res.error) { setDok(d => ({ ...d, busy: false, hiba: PROG_docTypeHiba(res.error) })); return; }
    const r = await PROG_loadDocTypes(); setEgyedi(r.rows); setDokHiba(r.hiba);
    // Az újonnan felvett típust rögtön be is jelöljük ennél a programnál — ezért hozta létre.
    if (!dok.szerk && res.data) setF(p => ({ ...p, required_docs: p.required_docs.includes(res.data.key) ? p.required_docs : [...p.required_docs, res.data.key] }));
    setDok(DOK_URES);
  };
  useEffect(() => { if (open) setF(program ? { ...blank, ...program, required_docs: program.required_docs || [], steps: program.steps || [], tags: program.tags || [] } : blank); }, [open, program, scope]);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  // Típusváltáskor a kártyacímke is követi — de csak amíg az admin nem írt be sajátot.
  const setLevel = (uj) => setF(p => ({ ...p, level: uj,
    degree: (!p.degree || Object.values(PROG_DEFAULT_DEGREE).includes(p.degree)) ? (PROG_DEFAULT_DEGREE[uj] || p.degree) : p.degree }));
  const toggleArr = (key, val) => setF(p => ({ ...p, [key]: p[key].includes(val) ? p[key].filter(x => x !== val) : [...p[key], val] }));
  const moveStep = (i, dir) => setF(p => { const s = [...p.steps]; const j = i + dir; if (j < 0 || j >= s.length) return p; [s[i], s[j]] = [s[j], s[i]]; return { ...p, steps: s }; });
  const uploadImg = async (e) => { const file = e.target.files && e.target.files[0]; if (!file) return; const dataUrl = await KB_readFileAsDataUrl(file); set('image_url', dataUrl); };

  const save = async () => {
    if (!f.name.trim()) return; setBusy(true);
    const row = { ...f, tuition: Number(f.tuition) || 0, ects: Number(f.ects) || 0, duration_semesters: Number(f.duration_semesters) || 0, capacity: Number(f.capacity) || 0, tags: typeof f.tags === 'string' ? f.tags.split(',').map(s => s.trim()).filter(Boolean) : f.tags };
    if (program) { await dlUpdate(PROG_TABLE, program.id, row, PROG_LS); }
    else { row.id = uid('prog'); row.created_at = todayStr(); await dlInsert(PROG_TABLE, row, PROG_LS); }
    setBusy(false); onSaved && onSaved(); onClose();
  };

  return (
    <UModal open={open} onClose={onClose} max="max-w-3xl" title={(program ? 'Szerkesztés — ' : 'Új ') + (isDeg ? 'képzés' : 'program')} subtitle={isDeg ? 'Az adatok és a képzés felvételi folyamatának beállítása' : 'Az adatok és a program jelentkezési folyamatának beállítása'} icon={<Lucide.GraduationCap size={20} />}>
      <div className="space-y-6">
        <div className="grid sm:grid-cols-2 gap-4">
          <UField label={isDeg ? 'Képzés neve' : 'Program neve'}><input className={U_input} value={f.name} onChange={e => set('name', e.target.value)} /></UField>
          <UField label="Kar"><input className={U_input} value={f.faculty} onChange={e => set('faculty', e.target.value)} /></UField>
          <UField label={isDeg ? 'Szint' : 'Típus'}><select className={U_input} value={f.level} onChange={e => setLevel(e.target.value)}>{levelOpts.map(k => <option key={k} value={k}>{PROG_LEVELS[k]}</option>)}</select></UField>
          <UField label={isDeg ? 'Fokozat megnevezése' : 'Címke a kártyán'}><input className={U_input} value={f.degree} onChange={e => set('degree', e.target.value)} placeholder={isDeg ? 'BSc / MA / MBA / PhD' : 'Short course / Training / Company visit'} /></UField>
          <UField label="Tandíj / szemeszter (EUR)"><input type="number" className={U_input} value={f.tuition} onChange={e => set('tuition', e.target.value)} /></UField>
          <UField label="Időtartam (szemeszter)"><input type="number" className={U_input} value={f.duration_semesters} onChange={e => set('duration_semesters', e.target.value)} /></UField>
          <UField label="ECTS"><input type="number" className={U_input} value={f.ects} onChange={e => set('ects', e.target.value)} /></UField>
          <UField label="Létszámkeret"><input type="number" className={U_input} value={f.capacity} onChange={e => set('capacity', e.target.value)} /></UField>
          <UField label="Jelentkezési határidő"><input type="date" className={U_input} value={f.deadline} onChange={e => set('deadline', e.target.value)} /></UField>
          <UField label="Címkék (vesszővel elválasztva)"><input className={U_input} value={Array.isArray(f.tags) ? f.tags.join(', ') : f.tags} onChange={e => set('tags', e.target.value)} /></UField>
        </div>
        <UField label="Összefoglaló"><textarea className={U_input + ' min-h-[70px]'} value={f.summary} onChange={e => set('summary', e.target.value)} /></UField>

        {/* mockup image */}
        <div>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1.5">{isDeg ? 'Képzés borítóképe' : 'Program borítóképe'}</span>
          <div className="flex items-center gap-3">
            <div className="w-32 h-20 rounded-xl overflow-hidden bg-slate-100 flex-none flex items-center justify-center text-slate-300">
              {f.image_url ? <img src={f.image_url} alt="" className="w-full h-full object-cover" onError={e => { e.currentTarget.style.display = 'none'; }} /> : <Lucide.Image size={22} />}
            </div>
            <div className="flex-1 space-y-2">
              <input className={U_input} value={f.image_url && f.image_url.indexOf('data:') === 0 ? '' : (f.image_url || '')} onChange={e => set('image_url', e.target.value)} placeholder={f.image_url && f.image_url.indexOf('data:') === 0 ? 'Feltöltött kép ✓' : 'Kép URL (https://…)'} />
              <div className="flex items-center gap-2">
                <label className={U_btnGhost + ' cursor-pointer text-[13px] py-2 px-4'}><Lucide.Upload size={15} /> Kép feltöltése<input type="file" accept="image/*" className="hidden" onChange={uploadImg} /></label>
                {f.image_url && <button type="button" className="text-[13px] font-bold text-slate-400 hover:text-red-500 px-2" onClick={() => set('image_url', '')}>Eltávolítás</button>}
              </div>
            </div>
          </div>
        </div>

        {/* flow editor */}
        <div className="rounded-2xl border border-slate-100 p-4">
          <div className="flex items-center gap-2 mb-3"><Lucide.ListChecks size={16} className="text-primary" /><span className="text-sm font-black text-slate-700">Felvételi folyamat — lépések</span></div>
          <div className="grid sm:grid-cols-2 gap-2 mb-4">
            {Object.entries(PROG_STEP_DEFS).map(([k, def]) => { const on = f.steps.includes(k); const I = def.icon; return (
              <button key={k} onClick={() => toggleArr('steps', k)} className={'flex items-center gap-2 px-3 py-2 rounded-xl border text-[13px] font-bold transition-all ' + (on ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 text-slate-400 hover:border-slate-200')}><I size={15} /> {def.label}{on && <Lucide.Check size={14} className="ml-auto" />}</button>
            ); })}
          </div>
          {f.steps.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Sorrend</div>
              {f.steps.map((s, i) => { const def = PROG_STEP_DEFS[s]; return (
                <div key={s} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50"><span className="w-5 h-5 rounded bg-white text-[11px] font-black text-slate-500 flex items-center justify-center">{i + 1}</span><span className="text-sm font-bold text-slate-600">{def ? def.label : s}</span><div className="ml-auto flex gap-1"><button onClick={() => moveStep(i, -1)} className="w-6 h-6 rounded hover:bg-white text-slate-400"><Lucide.ChevronUp size={15} /></button><button onClick={() => moveStep(i, 1)} className="w-6 h-6 rounded hover:bg-white text-slate-400"><Lucide.ChevronDown size={15} /></button></div></div>
              ); })}
            </div>
          )}
        </div>

        {/* required docs */}
        <div className="rounded-2xl border border-slate-100 p-4">
          <div className="flex items-center gap-2 mb-3"><Lucide.FileCheck size={16} className="text-primary" /><span className="text-sm font-black text-slate-700">Szükséges dokumentumok</span></div>
          <div className="grid sm:grid-cols-2 gap-2">
            {[
              ...Object.entries(PROG_DOC_DEFS).map(([k, label]) => ({ k, label, egyedi: null })),
              // Az elrejtett egyedi típus csak ott látszik, ahol már be van jelölve.
              ...egyedi.filter(t => t.active || f.required_docs.includes(t.key)).map(t => ({ k: t.key, label: t.label_hu, egyedi: t })),
              // Egy kulcs, amelyet sem a beépített lista, sem a tábla nem ismer (pl. a migráció
              // előtt vagy egy másik rendszerből jött): ne tűnjön el szó nélkül a kijelölésből.
              ...f.required_docs.filter(k => !PROG_DOC_DEFS[k] && !egyedi.some(t => t.key === k)).map(k => ({ k, label: PROG_docLabel(k), egyedi: null })),
            ].map(({ k, label, egyedi: t }) => { const on = f.required_docs.includes(k); return (
              <div key={k} className="flex items-stretch gap-1">
                <button onClick={() => toggleArr('required_docs', k)} className={'flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-xl border text-[12px] font-bold text-left transition-all ' + (on ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-100 text-slate-400 hover:border-slate-200')}>
                  <span className={'w-4 h-4 rounded flex-none flex items-center justify-center ' + (on ? 'bg-emerald-500 text-white' : 'bg-slate-200')}>{on && <Lucide.Check size={11} />}</span>
                  <span className="min-w-0 break-words">{label}</span>
                  {t && <span className={'ml-auto flex-none px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider ' + (t.active ? 'bg-sky-50 text-sky-600' : 'bg-slate-100 text-slate-400')}>{t.active ? 'egyedi' : 'rejtett'}</span>}
                </button>
                {t && <button type="button" title="Dokumentumtípus szerkesztése" onClick={() => setDok({ ...DOK_URES, open: true, szerk: t.key, hu: t.label_hu, en: t.label_en || '', active: t.active })} className="w-8 flex-none rounded-xl border border-slate-100 text-slate-400 hover:text-primary hover:border-slate-200 flex items-center justify-center"><Lucide.Pencil size={13} /></button>}
              </div>
            ); })}
          </div>
          {dokHiba ? (
            <p className="mt-3 text-[12px] font-semibold text-amber-700">{dokHiba}</p>
          ) : dok.open ? (
            <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-2">
              <div className="text-[12px] font-black text-slate-700">{dok.szerk ? 'Dokumentumtípus szerkesztése' : 'Új dokumentumtípus'}</div>
              <div className="grid sm:grid-cols-2 gap-2">
                <input className={U_input} autoFocus maxLength={120} placeholder="Megnevezés magyarul (kötelező)" value={dok.hu} onChange={e => setDok(d => ({ ...d, hu: e.target.value, hiba: '' }))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); mentDok(); } }} />
                <input className={U_input} maxLength={120} placeholder="Megnevezés angolul (nem kötelező)" value={dok.en} onChange={e => setDok(d => ({ ...d, en: e.target.value, hiba: '' }))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); mentDok(); } }} />
              </div>
              {dok.szerk && <label className="flex items-center gap-2 text-[12px] font-bold text-slate-600 cursor-pointer"><input type="checkbox" className="w-4 h-4 accent-primary" checked={!dok.active} onChange={e => setDok(d => ({ ...d, active: !e.target.checked }))} /> Elrejtés az új választások elől</label>}
              {dok.hiba && <p className="text-[12px] font-semibold text-red-600">{dok.hiba}</p>}
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-slate-500">{dok.szerk ? 'A név minden programnál és jelentkezésnél megváltozik.' : 'Az új típus minden program és képzés szerkesztésekor választható lesz.'}</p>
                <div className="flex gap-2 flex-none">
                  <button type="button" className={U_btnGhost + ' py-2 px-4 text-[13px]'} onClick={() => setDok(DOK_URES)}>Mégse</button>
                  <button type="button" className={U_btnPrimary + ' py-2 px-4 text-[13px]'} disabled={dok.busy || dok.hu.trim().length < 2} onClick={mentDok}>{dok.busy ? 'Mentés…' : dok.szerk ? 'Módosítás mentése' : 'Típus létrehozása'}</button>
                </div>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setDok({ ...DOK_URES, open: true })} className="mt-3 text-[13px] font-bold text-primary hover:underline flex items-center gap-1"><Lucide.Plus size={15} /> Új dokumentumtípus</button>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-2">
          <label className="flex items-center gap-2.5 text-sm font-bold text-slate-600 cursor-pointer"><input type="checkbox" checked={f.is_open} onChange={e => set('is_open', e.target.checked)} className="w-4 h-4 accent-primary" /> Jelentkezés nyitva</label>
          <div className="flex gap-3"><button className={U_btnGhost} onClick={onClose}>Mégse</button><button className={U_btnPrimary} disabled={busy || !f.name.trim()} onClick={save}>{busy ? 'Mentés…' : (isDeg ? 'Képzés mentése' : 'Program mentése')}</button></div>
        </div>
      </div>
    </UModal>
  );
}

/* ---------- admin: applicants review ---------- */
function PROG_Applicants({ programs, apps, onChange }) {
  const [pid, setPid] = useState('all');
  const rows = apps.filter(a => pid === 'all' || a.program_id === pid);
  const nameOf = (id) => { const p = programs.find(x => x.id === id); return p ? p.name : id; };
  /* A BEADÁS nem sima mezőírás, hanem RPC: a hallgatói -> irodai szakaszváltás
     egyirányú, és innen indul az ügyintézés. Egy elgépelt UPDATE ne tudja
     visszatolni a sort a jelentkezőhöz. A szerver a 'check' lépésre fordítja,
     oda, ahol a 27/30-as migráció interjúkapuja nyílik. */
  const setStatus = async (a, status) => {
    if (status === 'submitted') {
      if (!window.sb) return;
      const { error } = await window.sb.rpc('application_submit', { p_id: a.id });
      if (error) {
        // A szerver magyar mondata a legjobb üzenet — ha van, azt mutatjuk.
        alert(error.message || error.details || 'A beadás nem sikerült. Próbáld újra.');
        return;
      }
    } else {
      await dlUpdate(APP_TABLE, a.id, { updated_at: new Date().toISOString() }, APP_LS);
    }
    onChange && onChange();
  };
  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <select className={U_input + ' max-w-xs'} value={pid} onChange={e => setPid(e.target.value)}><option value="all">Minden képzés</option>{programs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <span className="text-sm font-bold text-slate-400">{rows.length + ' jelentkezés'}</span>
      </div>
      {rows.length === 0 ? <div className="bg-white rounded-3xl border border-slate-100"><UEmpty icon={<Lucide.Inbox size={24} />} title="Még nincs jelentkezés" subtitle="A hallgatói jelentkezések itt fognak megjelenni." /></div> : (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100"><th className="px-5 py-3">Jelentkező</th><th className="px-5 py-3">Képzés</th><th className="px-5 py-3">Előrehaladás</th><th className="px-5 py-3">Beadva</th><th className="px-5 py-3">Státusz</th></tr></thead>
            <tbody>
              {rows.map(a => { const p = programs.find(x => x.id === a.program_id); const total = p ? (p.steps || []).length : 1; const prog = Math.round(((a.step_index || 0) / Math.max(total - 1, 1)) * 100); return (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <td className="px-5 py-3"><div className="font-bold text-slate-700">{a.applicant_name || '—'}</div><div className="text-[11px] text-slate-400">{a.applicant_email}</div></td>
                  <td className="px-5 py-3 text-slate-600 font-semibold">{nameOf(a.program_id)}</td>
                  <td className="px-5 py-3"><div className="flex items-center gap-2"><div className="w-20 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-primary rounded-full" style={{ width: prog + '%' }} /></div><span className="text-[11px] font-bold text-slate-400">{prog}%</span></div></td>
                  <td className="px-5 py-3 text-[12px] text-slate-400 font-semibold">{a.status === 'draft' ? '—' : DL_date(a.updated_at || a.created_at)}</td>
                  <td className="px-5 py-3"><select value={a.status} onChange={e => setStatus(a, e.target.value)} className="text-[12px] font-bold rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/20">{Object.entries(PROG_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- main view (role-aware) ---------- */
/* `embedded`: a hallgatói „Képzések” menüpont (StudentPortal) egyik füle.
   Ilyenkor NINCS saját fejléc és külső margó (a portálé látszik), és a nézet
   mindig a hallgatói katalógus — akkor is, ha egy admin nyitja meg, különben
   a portál közepén a kezelőtábla jelenne meg. */
const ProgramsView = ({ user, scope = 'programs', embedded = false }) => {
  const isDeg = scope === 'degrees';
  const keret = embedded ? 'animate-in fade-in duration-500' : 'max-w-6xl xl:max-w-[1360px] 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-in fade-in duration-500';
  const [programs, setPrograms] = useState(null);
  const [apps, setApps] = useState([]);
  const [detail, setDetail] = useState(null);
  const [applying, setApplying] = useState(null); // {program, app}
  const [editor, setEditor] = useState({ open: false, program: null });
  /* A közös isAdmin() csak az ADMIN szerepkört nézi, ezért a SUPERADMIN eddig
     a hallgatói katalógust kapta kezelőtábla helyett. Itt mindkettő kezelő. */
  const kezelo = !!user && (isAdmin(user) || user.role === 'SUPERADMIN');
  const [tab, setTab] = useState(kezelo && !embedded ? 'manage' : 'explore');

  // A dokumentumtípusok is itt töltődnek, hogy a hallgató feltöltési lépése és a
  // részletező ablak az egyedi típusok NEVÉT mutassa, ne a kulcsát.
  const refetch = async () => { const [p, a] = await Promise.all([PROG_loadPrograms(), PROG_loadApps(), PROG_loadDocTypes()]); setPrograms(p); setApps(a); };
  useEffect(() => { refetch(); }, []);

  /* Kis-nagybetű független egyezés: a beszúrás kisbetűsít (owner_email), itt
     viszont eddig a nyers e-mailt hasonlítottuk. Eltérő írásmódnál a hallgató
     nem látta a saját piszkozatát — és minden kattintás ÚJ piszkozatot szúrt be. */
  const sajatEmail = String((user && user.email) || '').toLowerCase();
  const myApps = (apps || []).filter(a => sajatEmail && String(a.applicant_email || '').toLowerCase() === sajatEmail);

  const openApply = async (program) => {
    let app = myApps.find(a => a.program_id === program.id);
    if (!app) {
      const sor = {
        id: uid('APP'), program_id: program.id,
        owner_email: (user.email || '').toLowerCase(), applicant_name: user.name,
        stage: 'student', student_step: 0, step: 0, max_reached: 0, done: false,
        data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      app = PROG_fromRow(await dlInsert(APP_TABLE, sor, APP_LS) || sor);
      await refetch();
    }
    setDetail(null); setApplying({ program, app });
  };

  if (programs === null) return <div className={keret}><div className="grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="h-56 rounded-3xl bg-white border border-slate-100 animate-pulse" />)}</div></div>;

  if (applying) {
    const fresh = apps.find(a => a.id === applying.app.id) || applying.app;
    return <ProgramApply program={applying.program} app={fresh} user={user} onExit={() => { refetch(); setApplying(null); }} onSaved={() => refetch()} />;
  }

  const staff = kezelo && !embedded;
  // A hallgató is csak a saját kínálatát látja: a Programok alatt a kisebb
  // programokat, a Képzések alatt a féléves képzéseket — nem a kettő keverékét.
  const scopedPrograms = programs.filter(p => PROG_kind(p) === (isDeg ? 'degree' : 'program'));
  const scopedApps = apps.filter(a => scopedPrograms.some(p => p.id === a.program_id));
  return (
    <div className={keret}>
      {!embedded && <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">{isDeg ? 'Képzések' : 'Programok'}</p>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">{staff ? (isDeg ? 'Képzések kezelése' : 'Programok kezelése') : (isDeg ? 'Képzési kínálat' : 'Programkínálat')}</h1>
          <p className="text-slate-400 mt-1 font-medium">{staff
            ? (isDeg ? 'Képzések (BSc, MSc, MA, MBA, PhD), a felvételi folyamataik és a jelentkezők kezelése.' : 'Kisebb programok — céglátogatások, továbbképzések, eseti kurzusok, előkészítők és tanulmányi kirándulások — kezelése.')
            : (isDeg ? 'Böngészd az NJE angol nyelvű képzéseit és jelentkezz online.' : 'Céglátogatások, továbbképzések, eseti kurzusok és más rövid programok — jelentkezz online.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {staff && <button className={U_btnGhost} onClick={() => setTab(tab === 'manage' ? 'applicants' : 'manage')}>{tab === 'manage' ? <><Lucide.Users size={16} /> Jelentkezők</> : <><Lucide.GraduationCap size={16} /> {isDeg ? 'Képzések' : 'Programok'}</>}</button>}
          {staff && tab === 'manage' && <button className={U_btnPrimary} onClick={() => setEditor({ open: true, program: null })}><Lucide.Plus size={16} /> Új {isDeg ? 'képzés' : 'program'}</button>}
        </div>
      </div>}

      {!staff && (
        <>
          <PROG_Catalog programs={scopedPrograms} isDeg={isDeg} myApps={myApps} onOpen={setDetail} onContinue={(p, a) => setApplying({ program: p, app: a })} />
          {(() => {
            // Ugyanaz a rangsor, mint a katalógusban — a két helyen ne álljon más sorrendben ugyanaz.
            // Csak ennek a kínálatnak a jelentkezései: a képzésre adott jelentkezés
            // a Képzések, a programra adott a Programok alatt látszik.
            const sorok = myApps
              .map(a => ({ a, p: scopedPrograms.find(x => x.id === a.program_id) }))
              .filter(x => x.p)
              .map(x => ({ ...x, st: PROG_myState(x.p, x.a) }))
              .sort((x, y) => (x.st.tier - y.st.tier) ||
                ((Date.parse(y.a.updated_at || '') || 0) - (Date.parse(x.a.updated_at || '') || 0)));
            if (!sorok.length) return null;
            return (
            <div className="mt-10">
              <h2 className="text-lg font-black text-slate-900 mb-4">Jelentkezéseim</h2>
              <div className="grid sm:grid-cols-2 gap-3">
                {sorok.map(({ a, p, st }) => { const stat = PROG_STATUS[a.status] || PROG_STATUS.draft; return (
                  <button key={a.id} onClick={() => setApplying({ program: p, app: a })}
                    className={'text-left bg-white rounded-2xl border shadow-sm p-4 flex items-center gap-4 transition-colors '
                      + (st.tier === 0 ? 'border-amber-300 ring-1 ring-amber-200 hover:border-amber-400' : 'border-slate-100 hover:border-primary')}>
                    <div className={'w-11 h-11 rounded-2xl flex items-center justify-center flex-none ' + (st.tier === 0 ? 'bg-amber-100 text-amber-700' : 'bg-primary/10 text-primary')}><Lucide.GraduationCap size={20} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-800 truncate">{p.name}</div>
                      <div className="text-[11px] text-slate-400">{st.tier === 0 ? (`${st.lepes}/${st.osszes} lépés kész` + (st.kell ? ` · ${st.feltoltve}/${st.kell} dokumentum` : '')) : p.degree}</div>
                    </div>
                    {st.tier === 0 ? <UBadge tone="amber">Folytatandó</UBadge>
                      : st.tier === 2 ? <UBadge tone="red">Lezárva</UBadge>
                      : <UBadge tone={stat.tone}>{stat.label}</UBadge>}
                  </button>
                ); })}
              </div>
            </div>
            );
          })()}
        </>
      )}

      {staff && tab === 'manage' && scopedPrograms.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100"><UEmpty icon={<Lucide.GraduationCap size={26} />} title={isDeg ? 'Még nincs képzés' : 'Még nincs program'} subtitle={isDeg ? 'Vedd fel az első képzést (BSc, MSc, MA, MBA vagy PhD).' : 'Vegyél fel egy céglátogatást, továbbképzést, eseti kurzust vagy tanulmányi kirándulást.'} action={<button className={U_btnPrimary} onClick={() => setEditor({ open: true, program: null })}><Lucide.Plus size={16} /> Új {isDeg ? 'képzés' : 'program'}</button>} /></div>
      )}
      {staff && tab === 'manage' && scopedPrograms.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100"><th className="px-5 py-3">{isDeg ? 'Képzés' : 'Program'}</th><th className="px-5 py-3">Szint</th><th className="px-5 py-3">Tandíj</th><th className="px-5 py-3">Folyamat</th><th className="px-5 py-3">Határidő</th><th className="px-5 py-3">Státusz</th><th className="px-5 py-3"></th></tr></thead>
            <tbody>
              {scopedPrograms.map(p => { const apps4 = apps.filter(a => a.program_id === p.id).length; return (
                <tr key={p.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <td className="px-5 py-3"><div className="flex items-center gap-3"><div className="w-12 h-9 rounded-lg overflow-hidden flex-none"><PROG_Banner program={p} className="h-full w-full" /></div><div><div className="font-bold text-slate-700">{p.name}</div><div className="text-[11px] text-slate-400">{p.faculty}{apps4 ? ' · ' + apps4 + ' jelentkező' : ''}</div></div></div></td>
                  <td className="px-5 py-3"><UBadge tone={PROG_LEVEL_TONE[p.level]}>{p.degree}</UBadge></td>
                  <td className="px-5 py-3 font-black text-slate-700">{DL_money(p.tuition)}</td>
                  <td className="px-5 py-3 text-[12px] font-bold text-slate-400">{(p.steps || []).length + ' lépés'}</td>
                  <td className="px-5 py-3 text-[12px] font-semibold text-slate-500">{DL_date(p.deadline)}</td>
                  <td className="px-5 py-3">{p.is_open ? <UBadge tone="green">Nyitva</UBadge> : <UBadge tone="red">Lezárva</UBadge>}</td>
                  <td className="px-5 py-3 text-right"><div className="flex items-center gap-1 justify-end"><button onClick={() => dlUpdate(PROG_TABLE, p.id, { is_open: !p.is_open }, PROG_LS).then(refetch)} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center" title={p.is_open ? 'Jelentkezés lezárása' : 'Jelentkezés megnyitása'}>{p.is_open ? <Lucide.Lock size={15} /> : <Lucide.LockOpen size={15} />}</button><button onClick={() => setEditor({ open: true, program: p })} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center" title="Szerkesztés"><Lucide.Pencil size={15} /></button></div></td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}

      {staff && tab === 'applicants' && <PROG_Applicants programs={scopedPrograms} apps={scopedApps} onChange={refetch} />}

      <PROG_Detail program={detail} myApp={detail ? myApps.find(a => a.program_id === detail.id) : null} onClose={() => setDetail(null)} onApply={openApply} />
      <PROG_Editor open={editor.open} program={editor.program} scope={scope} onClose={() => setEditor({ open: false, program: null })} onSaved={refetch} />
    </div>
  );
};
