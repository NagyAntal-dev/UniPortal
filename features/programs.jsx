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
  /* Egy képzés-jelentkezés legfeljebb 3 képzésre szólhat (data.program_ids, a
     sorrend a preferencia), egy félévre (data.term). A régi, egyképzéses sorban
     csak a program_id van — abból lesz az egyelemű lista. */
  program_ids:     (r.data && Array.isArray(r.data.program_ids) && r.data.program_ids.length) ? r.data.program_ids
                   : ((r.program_id || (r.data && r.data.program_id)) ? [r.program_id || r.data.program_id] : []),
  term:            (r.data && r.data.term) || '',
  ref_no:          r.ref_no || null,
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
  // Csak a képzésre szóló jelentkezés első lépése — a szerkesztőben nem választható.
  choice:     { label: 'Képzések és félév',   icon: Lucide.ListChecks },
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

/* FÉLÉVEK ÉS TÖBB KÉPZÉS — 60_admission_decision_terms.sql
   ------------------------------------------------------------------
   A képzés `intakes` mezője mondja meg, melyik félévben indul: autumn (őszi),
   spring (tavaszi). A jelentkező egy konkrét félévre jelentkezik; a kód az ECHO
   kurzusokéval azonos: 'ÉÉÉÉ/ÉÉ/F' (F: 1 = őszi, 2 = tavaszi), pl. '2027/28/1'.
   A migráció előtt a programs táblának nincs intakes oszlopa: ilyenkor minden
   képzés mindkét félévben indul, és a szerkesztő nem küldi a mezőt (különben a
   PostgREST az egész mentést elutasítaná). */
const PROG_INTAKES = { autumn: 'Őszi félév', spring: 'Tavaszi félév' };
let PROG_INTAKE_COL = false;
const PROG_intakesOf = (p) => {
  const l = (p && Array.isArray(p.intakes)) ? p.intakes.filter(x => PROG_INTAKES[x]) : [];
  return l.length ? l : ['autumn', 'spring'];
};
const PROG_termSeason = (code) => /\/1$/.test(String(code || '')) ? 'autumn' : (/\/2$/.test(String(code || '')) ? 'spring' : '');
// A következő két induló félév, időrendben: tavaszi (február 1.) és őszi (szeptember 1.).
function PROG_upcomingTerms(most) {
  const d = most || new Date();
  const y = d.getFullYear(), m = d.getMonth();
  const tavasz = m >= 1 ? y + 1 : y;
  const osz = m >= 8 ? y + 1 : y;
  return [
    { season: 'spring', code: (tavasz - 1) + '/' + String(tavasz % 100).padStart(2, '0') + '/2', start: new Date(tavasz, 1, 1) },
    { season: 'autumn', code: osz + '/' + String((osz + 1) % 100).padStart(2, '0') + '/1', start: new Date(osz, 8, 1) },
  ].sort((a, b) => a.start - b.start);
}
// Egyetlen szövegcsomópont, hogy a nyelvváltó kifejezés-mintája ráilleszkedjen.
function PROG_termLabel(code, rovid) {
  const m = /^(\d{4})\/(\d{2})\/([12])$/.exec(String(code || ''));
  if (!m) return String(code || '');
  const osz = m[3] === '1';
  const alap = `${m[1]}/${m[2]} ${osz ? 'őszi' : 'tavaszi'} félév`;
  if (rovid) return alap;
  return `${alap} (kezdés: ${osz ? m[1] + '. szeptember' : (Number(m[1]) + 1) + '. február'})`;
}
const PROG_MAX_DEGREES = 3;
// Egy jelentkezés képzései preferencia-sorrendben (azonosítók).
const PROG_appIds = (a) => (a && Array.isArray(a.program_ids) && a.program_ids.length) ? a.program_ids
  : (a && a.data && Array.isArray(a.data.program_ids) && a.data.program_ids.length) ? a.data.program_ids
  : (a && a.program_id ? [a.program_id] : []);
/* Több képzés EGY folyamatban: a lépések és a kötelező dokumentumok uniója; a
   lépések a PROG_STEP_DEFS sorrendjében, a beadás mindig a végén. */
function PROG_mergeFlow(progs) {
  const rend = Object.keys(PROG_STEP_DEFS);
  const lepesek = new Set(), dok = [];
  (progs || []).forEach(p => {
    (p.steps || []).forEach(x => lepesek.add(x));
    (p.required_docs || []).forEach(x => { if (!dok.includes(x)) dok.push(x); });
  });
  const steps = rend.filter(x => lepesek.has(x) && x !== 'review' && x !== 'choice').concat(['review']);
  return { steps, required_docs: dok };
}

/* ============================================================
   VALÓS FOLYAMATÁLLAPOT — egyetlen forrás
   ------------------------------------------------------------
   A hallgató lépéssávja, a „Felvételi folyamat” gyűjtőnézet, a katalógus
   kártyái és az admin „Folyamat állapota” / „Feltöltött dokumentumok” része
   ugyanebből számol. Egy lépés akkor KÉSZ, ha a mentett adat alapján
   teljesült — nem attól, hogy a hallgató rákattintott vagy továbblépett.

   Két alak:
     • 'kepzes' — a Képzések kártyáiról indított jelentkezés (data.program_ids /
                  program_id): a hallgatói lépések a megjelölt képzések uniója,
                  utána az irodai szakasz (ellenőrzés, [interjú], döntés, levél).
     • 'irodai' — a régi, a Felvételi folyamat felületen indított eljárás
                  (data.programs): az irodai lánc lépései (JourneyShared).
   A bemenet lehet a PROG_fromRow (status) és az spRow (stage) alakja is; a
   katalógus tömb vagy azonosító → képzés térkép.
   ============================================================ */
const PROG_dokFeltoltve = (e) => !!(e && (e.path || e.fileName));

function PROG_folyamVaz(program, valasztott) {
  const isDeg = PROG_kind(program) === 'degree';
  const folyam = isDeg
    ? PROG_mergeFlow(valasztott && valasztott.length ? valasztott : [program])
    : { steps: program.steps || ['personal', 'review'], required_docs: program.required_docs || [] };
  return { isDeg, steps: isDeg ? ['choice', ...folyam.steps] : folyam.steps, required_docs: folyam.required_docs };
}

// Egy hallgatói lépés a MENTETT adat alapján teljesült-e (nem a megtekintés alapján).
function PROG_lepesKesz(stepKey, program, data, beadva) {
  if (stepKey === 'review') return !!beadva;
  if (stepKey === 'language') { const l = data.language || {}; return !!(l.cert && l.level); }
  if (stepKey === 'documents') return (program.required_docs || []).every(d => PROG_dokFeltoltve((data.docs || {})[d]));
  return !!PROG_canAdvance(stepKey, program, data);
}

function PROG_dokOsszegzes(items, extra) {
  const kotelezo = items.filter(x => !x.optional);
  return {
    items, extra,
    osszes: kotelezo.length,
    feltoltve: kotelezo.filter(x => x.feltoltve).length,
    hitelesitve: kotelezo.filter(x => x.hitelesitve).length,
    hianyzik: kotelezo.filter(x => !x.feltoltve),
  };
}

/* A feltöltendő dokumentumok: a megjelölt képzések kötelező dokumentumainak
   uniója (egy dokumentum egyszer). Ha csak az egyik képzés kéri, az is
   benne van — a `kerik` mondja meg, melyik képzés kéri (több képzésnél). */
function PROG_dokKovetelmeny(data, valasztott, required) {
  const docs = (data && data.docs) || {};
  const kell = required || [];
  const tobb = (valasztott || []).length > 1;
  const items = kell.map(id => {
    const e = docs[id];
    const kerik = tobb ? valasztott.filter(p => (p.required_docs || []).includes(id)).map(p => ({ id: p.id, code: p.code || p.degree || p.name, name: p.name })) : [];
    return { id, label: PROG_docLabel(id), kerik, feltoltve: PROG_dokFeltoltve(e), hitelesitve: !!(e && PROG_dokFeltoltve(e) && e.verified), fajl: (e && e.fileName) || '' };
  });
  const extra = Object.keys(docs).filter(id => !kell.includes(id) && PROG_dokFeltoltve(docs[id]))
    .map(id => ({ id, label: PROG_docLabel(id), kerik: [], extra: true, feltoltve: true, hitelesitve: !!docs[id].verified, fajl: docs[id].fileName || '' }));
  return PROG_dokOsszegzes(items, extra);
}

const PROG_DONTES_CIMKE = { admitted: 'Felvéve', rejected: 'Elutasítva', withdrawn: 'Visszalépett' };
const PROG_allapotTone = (fa) => !fa ? 'blue'
  : (fa.kod === 'rejected' || fa.kod === 'cancelled') ? 'red'
  : (fa.kod === 'accepted' || fa.kod === 'admitted') ? 'green'
  : fa.kod === 'withdrawn' ? 'slate' : 'blue';

function PROG_folyamatAllapot(proc, katalogus) {
  const p = proc || {};
  const data = p.data || {};
  const keres = (id) => Array.isArray(katalogus) ? (katalogus.find(x => x && x.id === id) || null) : ((katalogus || {})[id] || null);
  const ids = PROG_appIds({ data, program_id: p.program_id || p.programId || data.program_id });
  const beadva = p.stage ? p.stage !== 'student' : (!!p.status && p.status !== 'draft');
  const dontes = data.decision && PROG_DONTES_CIMKE[data.decision.outcome] ? data.decision : null;
  const levelKiment = !!(typeof JourneyShared !== 'undefined' && JourneyShared.letterSent && JourneyShared.letterSent(p));
  const lepesek = [];
  let tipus, dok, valasztott = [];

  if (ids.length) {
    tipus = 'kepzes';
    valasztott = ids.map(keres).filter(Boolean);
    const alap = valasztott[0] || { id: ids[0], kind: Array.isArray(data.program_ids) ? 'degree' : 'program', steps: ['personal', 'documents', 'review'], required_docs: [] };
    const vaz = PROG_folyamVaz(alap, valasztott);
    const virt = { ...alap, steps: vaz.steps, required_docs: vaz.required_docs, _valasztott: valasztott, _katalogus: Array.isArray(katalogus) ? katalogus : Object.values(katalogus || {}) };
    vaz.steps.forEach(key => lepesek.push({ key, fazis: 'hallgato', label: (PROG_STEP_DEFS[key] || {}).label || key, kesz: PROG_lepesKesz(key, virt, data, beadva) }));
    dok = PROG_dokKovetelmeny(data, valasztott, vaz.required_docs);
    lepesek.push({ key: 'check', fazis: 'iroda', label: 'Dokumentum-ellenőrzés', kesz: beadva && dok.hitelesitve === dok.osszes, megj: dok.osszes ? `${dok.hitelesitve}/${dok.osszes} dokumentum jóváhagyva` : '' });
    const iv = data.interview || {};
    if (!vaz.steps.includes('interview') && (iv.slotId || iv.start || iv.status)) {
      lepesek.push({ key: 'interview', fazis: 'iroda', label: 'Interjú', kesz: !!(iv.booked || iv.status === 'Completed') });
    }
    lepesek.push({ key: 'decision', fazis: 'iroda', label: 'Felvételi döntés', kesz: !!dontes, elutasitva: !!dontes && dontes.outcome !== 'admitted', megj: dontes ? PROG_DONTES_CIMKE[dontes.outcome] : '' });
    lepesek.push({ key: 'letter', fazis: 'iroda', label: 'Felvételi levél', kesz: levelKiment, kihagyva: !!dontes && dontes.outcome !== 'admitted' });
  } else {
    tipus = 'irodai';
    const SD = (typeof JourneyShared !== 'undefined' && JourneyShared.STEP_DEFS) || [];
    const DT = (typeof JourneyShared !== 'undefined' && JourneyShared.DOC_TYPES) || [];
    const docs = data.docs || {};
    const items = DT.map(d => { const e = docs[d.id]; return { id: d.id, label: d.label, Icon: d.Icon, optional: !!d.optional, kerik: [], feltoltve: PROG_dokFeltoltve(e), hitelesitve: !!(e && PROG_dokFeltoltve(e) && e.verified), fajl: (e && e.fileName) || '' }; });
    const extra = Object.keys(docs).filter(id => !DT.some(d => d.id === id) && PROG_dokFeltoltve(docs[id]))
      .map(id => ({ id, label: PROG_docLabel(id), kerik: [], extra: true, feltoltve: true, hitelesitve: !!docs[id].verified, fajl: docs[id].fileName || '' }));
    dok = PROG_dokOsszegzes(items, extra);
    const mt = data.math || {}, iv = data.interview || {}, acc = data.account || {};
    const kesz = {
      register: !!(acc.fullName && acc.email),
      programs: (data.programs || []).length > 0,
      documents: dok.feltoltve === dok.osszes,
      check: dok.osszes > 0 && dok.hitelesitve === dok.osszes,
      interview: !!(iv.booked || iv.status === 'Completed'),
      math: !!mt.passed,
      letter: levelKiment,
    };
    SD.forEach(s => {
      if (s.id === 'letter' && dontes) lepesek.push({ key: 'decision', fazis: null, label: 'Felvételi döntés', kesz: true, elutasitva: dontes.outcome !== 'admitted', megj: PROG_DONTES_CIMKE[dontes.outcome] });
      lepesek.push({ key: s.id, fazis: null, label: s.label, kesz: !!p.done || !!kesz[s.id], kihagyva: s.id === 'letter' && !!dontes && dontes.outcome !== 'admitted' });
    });
  }

  const megszakitva = !!data._cancelled;
  const szamolt = lepesek.filter(l => !l.kihagyva);
  const aktualis = megszakitva ? null : (szamolt.find(l => !l.kesz) || null);
  lepesek.forEach(l => { l.aktualis = l === aktualis; });
  const kesz = szamolt.filter(l => l.kesz).length;
  const osszes = Math.max(szamolt.length, 1);
  let cimke, kod, rend;
  if (megszakitva) { cimke = 'Megszakítva'; kod = 'cancelled'; rend = 99; }
  else if (dontes && dontes.outcome === 'rejected') { cimke = 'Elutasítva'; kod = 'rejected'; rend = 95; }
  else if (dontes && dontes.outcome === 'withdrawn') { cimke = 'Visszalépett'; kod = 'withdrawn'; rend = 96; }
  else if (levelKiment || p.done) { cimke = 'Felvéve · levél kiállítva'; kod = 'accepted'; rend = 90; }
  else if (dontes && dontes.outcome === 'admitted') {
    const fp = valasztott.find(x => x.id === dontes.programId);
    cimke = 'Felvéve: ' + (fp ? (fp.code || fp.name) : (dontes.programId || '')); kod = 'admitted'; rend = 85;
  }
  else if (tipus === 'kepzes' && !beadva) { cimke = 'Hallgató tölti ki'; kod = 'student'; rend = 0; }
  else if (aktualis) { cimke = aktualis.key === 'decision' ? 'Döntésre vár' : aktualis.label; kod = 'step:' + aktualis.key; rend = 10 + lepesek.indexOf(aktualis); }
  else { cimke = 'Minden lépés kész'; kod = 'accepted'; rend = 90; }
  return { tipus, beadva, megszakitva, ids, valasztott, lepesek, aktualis, kesz, osszes, pct: Math.round((kesz / osszes) * 100), cimke, kod, rend, dok, dontes, levelKiment };
}

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

/* A legutóbb betöltött katalógus — a felvételi levél (app.jsx: letterValues) a
   kártyáról indított jelentkezés képzését ebből oldja fel. */
let PROG_KAT_CACHE = [];
async function PROG_loadPrograms() {
  const list = await dlSelect(PROG_TABLE, PROG_LS, PROG_seed, 'name', true);
  // Demo backfill belongs only to the local preview. Live deletions must persist.
  // Fill missing display images without overwriting an admin's own edits.
  const seed = PROG_seed();
  const has = {}; list.forEach(p => { has[p.id] = true; });
  const missing = DL_PROBE[PROG_TABLE] === 'ls' ? seed.filter(s => !has[s.id]) : [];
  let changed = missing.length > 0;
  let merged = list.concat(missing).map(p => {
    let q = p;
    if (!q.image_url && PROG_IMGS[q.id]) { changed = true; q = { ...q, image_url: PROG_IMGS[q.id] }; }
    return q;
  });
  if (changed) {
    if (DL_PROBE[PROG_TABLE] === 'ls') { try { dlLocalSave(PROG_LS, merged); } catch (e) {} }
  }
  // A 60-as migráció után a sorok hordozzák az intakes mezőt; localStorage-ban bármi tárolható.
  PROG_INTAKE_COL = DL_PROBE[PROG_TABLE] === 'ls' || list.some(x => x && Object.prototype.hasOwnProperty.call(x, 'intakes'));
  PROG_KAT_CACHE = merged;
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
          {PROG_kind(program) === 'degree' && PROG_intakesOf(program).map(k => <UBadge key={'i' + k} tone="violet">{PROG_INTAKES[k]}</UBadge>)}
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

/* ---------- student: the apply flow (runs the programme's own steps) ----------
   KÉPZÉSNÉL a jelentkezés legfeljebb 3 képzésre szólhat — EGY felvételi folyamat.
   Az első lépés a képzések és a félév kiválasztása, a többi a kiválasztott
   képzések lépéseinek és kötelező dokumentumainak uniója. Az interjú után a
   felvételi iroda dönt, melyik képzésre vesszük fel (admission_decide).
   Kisebb programnál minden a régi: egy program, a saját lépései. */
function ProgramApply({ program, programs, app, user, onExit, onSaved, notice, backLabel, kezdoLepes }) {
  const isDeg = PROG_kind(program) === 'degree';
  const regiPiszkozat = isDeg && !(app.data && Array.isArray(app.data.program_ids) && app.data.program_ids.length);
  const [cur, setCur] = useState(() => regiPiszkozat
    ? { ...app, data: { ...(app.data || {}), program_ids: PROG_appIds(app).length ? PROG_appIds(app) : [program.id] } }
    : app);
  const data = cur.data || {};
  const setData = (patch) => setCur(c => ({ ...c, data: { ...(c.data || {}), ...patch } }));
  const katalogus = programs && programs.length ? programs : [program];
  const valasztott = isDeg ? PROG_appIds({ data }).map(id => katalogus.find(x => x.id === id)).filter(Boolean) : [program];
  const vaz = PROG_folyamVaz(program, valasztott);
  const steps = vaz.steps;
  const nevek = valasztott.map(x => x.name);
  const virt = { ...program, steps, required_docs: vaz.required_docs, name: nevek.length > 1 ? nevek.join(', ') : program.name, _valasztott: valasztott, _katalogus: katalogus };
  const beadva = !!cur.status && cur.status !== 'draft';
  /* VALÓS ÁLLAPOT A LÉPÉSSÁVON. A pipa korábban a megtekintett lépés indexéből
     jött (i < lepes): aki az utolsó lépésre kattintott, annak minden korábbi
     lépése „kész” lett, visszakattintva pedig eltűntek a pipák. Most minden
     lépés a mentett adat alapján kész vagy nem (PROG_lepesKesz) — ugyanaz a
     számítás, amit a gyűjtőnézet és az admin „Folyamat állapota” használ.
     A hallgatói lépések után az irodai szakasz is látszik (ellenőrzés,
     döntés, levél), hogy a beadás után is kiderüljön, hol tart az eljárás. */
  const irodai = PROG_folyamatAllapot({ ...cur, data }, katalogus).lepesek.filter(l => l.fazis === 'iroda');
  const rail = [
    ...steps.map(key => ({ key, fazis: 'hallgato', label: (PROG_STEP_DEFS[key] || {}).label || key, icon: (PROG_STEP_DEFS[key] || {}).icon || Lucide.Circle, kesz: PROG_lepesKesz(key, virt, data, beadva) })),
    ...irodai.map(l => ({ ...l, icon: PROG_IRODA_IKON[l.key] || Lucide.Circle })),
  ];
  const railKesz = rail.filter(l => l.kesz).length;
  const railOsszes = rail.filter(l => !l.kihagyva).length;
  /* Nyitó lépés: a legelső még nem teljesült. Beadás előtt legfeljebb a
     legutóbb mentett lépésig (a régi piszkozatnál az új első lépés miatt
     eggyel odébb), így a frissen indított jelentkezés a képzésválasztással
     kezdődik. */
  const [idx, setIdx] = useState(() => {
    // A levél-értesítés hivatkozásáról nyitva (kezdoLepes = 'letter') a kért lépésen indul.
    const kert = kezdoLepes ? rail.findIndex(l => l.key === kezdoLepes) : -1;
    if (kert >= 0) return kert;
    const elso = rail.findIndex(l => !l.kesz && !l.kihagyva);
    const nyitott = elso < 0 ? rail.length - 1 : elso;
    if (beadva) return nyitott;
    return Math.min((app.step_index || 0) + (regiPiszkozat ? 1 : 0), nyitott, steps.length - 1);
  });
  const lepes = Math.max(0, Math.min(idx, rail.length - 1));
  const hallgatoiNezet = lepes < steps.length;
  const [saving, setSaving] = useState(false);
  /* A mentés a 72/73-as jogosultsági réteg óta MEGTAGADHATÓ. A dlUpdate
     ilyenkor dob (lásd data-layer.jsx): a hibát ki kell írni, nem szabad
     sikeresnek látszania. A persist ilyenkor null-t ad vissza, amit a
     hívók már ma is kezelnek (`if (saved)`). */
  const [mentesHiba, setMentesHiba] = useState('');
  // Üzenetváltás a felvételi irodával (features/messages.jsx, 62) — a jelentkezés nézetéből is.
  const [uzenetNyitva, setUzenetNyitva] = useState(false);
  const msgTerkep = MSG_useInboxTerkep();
  const msgOlvasatlan = (msgTerkep[cur.id] && msgTerkep[cur.id].unread) || 0;

  const persist = async (extra = {}) => {
    setSaving(true);
    const ids = PROG_appIds({ data: cur.data || {} });
    const patch = { student_step: Math.min(lepes, steps.length - 1), data: cur.data || {}, updated_at: new Date().toISOString(), ...(isDeg && ids.length ? { program_id: ids[0] } : {}), ...extra };
    let saved = null;
    try {
      saved = await dlUpdate(APP_TABLE, cur.id, patch, APP_LS);
      setMentesHiba('');
    } catch (e) {
      setMentesHiba((e && e.message) || 'A mentés nem sikerült.');
      setSaving(false);
      return null;
    }
    setSaving(false);
    if (saved) { const m = PROG_fromRow(saved); setCur(m); onSaved && onSaved(m); }
    return saved;
  };
  const goNext = async () => { const n = Math.min(lepes + 1, steps.length - 1); if (await persist({ student_step: n })) setIdx(n); };
  const goPrev = () => setIdx(Math.max(0, lepes - 1));
  const stepKey = hallgatoiNezet ? steps[lepes] : null;
  const statusz = PROG_STATUS[cur.status] || null;

  return (
    <div className="max-w-5xl 2xl:max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-in fade-in duration-300">
      <button onClick={onExit} className="flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-primary mb-4 transition-colors"><Lucide.ArrowLeft size={16} /> {backLabel || 'Vissza a képzésekhez'}</button>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div className="min-w-0">
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">{isDeg && valasztott.length > 1 ? `Jelentkezés ${valasztott.length} képzésre` : <>{program.degree} jelentkezés</>}</p>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">{isDeg && nevek.length > 1 ? nevek.join(' · ') : program.name}</h1>
          {isDeg && data.term && <p className="text-sm font-bold text-slate-400 mt-1">{PROG_termLabel(data.term)}</p>}
        </div>
        <div className="flex items-center gap-2 flex-none">
          <button type="button" onClick={() => setUzenetNyitva(v => !v)} aria-expanded={uzenetNyitva} data-msg-eljaras-gomb="1"
            className={U_btnGhost + ' !py-2 !px-3 text-[13px]' + (uzenetNyitva ? ' !bg-primary/10 !text-primary' : '')}>
            <Lucide.MessageSquare size={15} /> Üzenetek <MSG_Jelveny szam={msgOlvasatlan} />
          </button>
          {cur.ref_no && <UBadge>{'FV-' + String(cur.ref_no).padStart(5, '0')}</UBadge>}
          <UBadge tone={statusz ? statusz.tone : 'slate'}>{statusz ? statusz.label : cur.status}</UBadge>
        </div>
      </div>
      {notice && (
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-800" role="status">
          <Lucide.Info size={16} className="flex-none mt-0.5" /><span>{notice}</span>
        </div>
      )}

      {uzenetNyitva && (
        <div className="mb-6 bg-white rounded-3xl border border-slate-100 shadow-sm p-5 sm:p-6" data-msg-eljaras-panel="1">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2"><Lucide.MessageSquare size={16} className="text-primary" /><span className="text-sm font-black text-slate-800">Üzenetváltás a felvételi irodával</span></div>
            <button type="button" onClick={() => setUzenetNyitva(false)} aria-label="Bezárás" title="Bezárás" className="text-slate-400 hover:text-slate-700"><Lucide.X size={18} /></button>
          </div>
          <MSG_Thread processId={cur.id} role="applicant" docs={data.docs || {}} magassag="max-h-[360px]"
            onLevelMegnyit={() => {
              // Ugyanebben a nézetben: a levél lépésére vált, és bezárja az üzenetpanelt.
              const k = rail.findIndex(l => l.key === 'letter');
              if (k >= 0) setIdx(k);
              setUzenetNyitva(false);
              try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
            }} />
        </div>
      )}
      <div className="grid lg:grid-cols-[240px,1fr] gap-6">
        {/* step rail */}
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-3 h-fit">
          <div className="px-3 pt-1 pb-2 text-[11px] font-bold text-slate-400" data-lepes-osszesito="1">{`${railKesz}/${railOsszes} lépés kész`}</div>
          {rail.map((s, i) => { const I = s.icon; const active = i === lepes; const elsoIrodai = s.fazis === 'iroda' && (i === 0 || rail[i - 1].fazis !== 'iroda'); return (
            <React.Fragment key={s.fazis + ':' + s.key}>
              {elsoIrodai && <div className="px-3 pt-4 pb-1 mt-2 border-t border-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400">Felvételi iroda</div>}
              <button onClick={() => setIdx(i)} data-lepes={s.key} data-kesz={s.kesz ? '1' : '0'} aria-current={active ? 'step' : undefined}
                className={'w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left transition-colors ' + (active ? 'bg-primary/10 text-primary' : s.elutasitva ? 'text-red-600 hover:bg-slate-50' : s.kesz ? 'text-emerald-600 hover:bg-slate-50' : s.kihagyva ? 'text-slate-300 hover:bg-slate-50' : 'text-slate-500 hover:bg-slate-50')}>
                <span className={'w-7 h-7 rounded-lg flex items-center justify-center flex-none ' + (s.elutasitva ? 'bg-red-500 text-white' : s.kesz ? 'bg-emerald-500 text-white' : active ? 'bg-primary text-white' : 'bg-slate-100 text-slate-400')}>{s.elutasitva ? <Lucide.X size={15} /> : s.kesz ? <Lucide.Check size={15} /> : <I size={15} />}</span>
                <span className="text-[13px] font-bold">{s.label}</span>
              </button>
            </React.Fragment>
          ); })}
        </div>

        {/* step body */}
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 sm:p-8 min-h-[360px]">
          {hallgatoiNezet ? <PROG_StepBody stepKey={stepKey} program={virt} data={data} setData={setData} user={user} cur={cur} setCur={setCur}
            onSubmit={async () => {
              /* Előbb mentünk (hogy az utolsó lépés adatai is bent legyenek),
                 utána a szerver fordítja át a sort az irodai szakaszba. */
              if (!(await persist({ student_step: lepes }))) return;
              if (!window.sb) return;
              try {
              const { error } = await window.sb.rpc('application_submit', { p_id: cur.id });
              if (error) { alert(error.message || 'A beadás nem sikerült. Próbáld újra.'); return; }
              setCur(c => ({ ...c, status: 'submitted' }));
              onSaved && onSaved({ ...cur, status: 'submitted' });
              } catch (e) { setMentesHiba(e.message || 'A mentés nem sikerült.'); }
            }} /> : <PROG_IrodaiLepes lepes={rail[lepes]} cur={cur} data={data} program={virt} />}
          {mentesHiba && (
            <div className="mt-6 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
              <Lucide.AlertCircle size={16} className="mt-0.5 flex-none" />
              <span className="flex-1">{mentesHiba}</span>
              <button onClick={() => setMentesHiba('')} className="text-red-400 hover:text-red-700"><Lucide.X size={14} /></button>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 mt-8 pt-5 border-t border-slate-100">
            <button onClick={goPrev} disabled={lepes === 0} className={U_btnGhost + (lepes === 0 ? ' opacity-0 pointer-events-none' : '')}><Lucide.ArrowLeft size={15} /> Vissza</button>
            <div className="flex items-center gap-3">
              <button onClick={async () => { const ok = await persist(); if (ok) onExit && onExit(); }} disabled={saving} className="text-sm font-bold text-slate-400 hover:text-slate-700 transition-colors disabled:opacity-50">{saving ? 'Mentés…' : 'Mentés és kilépés'}</button>
              {hallgatoiNezet && lepes < steps.length - 1 && <button onClick={goNext} className={U_btnPrimary} disabled={!PROG_canAdvance(stepKey, virt, data)}>Folytatás <Lucide.ArrowRight size={15} /></button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PROG_canAdvance(stepKey, program, data) {
  if (stepKey === 'choice') {
    const ids = PROG_appIds({ data });
    const evszak = PROG_termSeason(data.term);
    const kat = program._katalogus || [];
    return !!evszak && ids.length >= 1 && ids.length <= PROG_MAX_DEGREES
      && ids.every(id => { const p = kat.find(x => x.id === id); return !p || PROG_intakesOf(p).includes(evszak); });
  }
  if (stepKey === 'documents') return (program.required_docs || []).every(d => data.docs && data.docs[d]);
  if (stepKey === 'math') return data.math && data.math.passed;
  if (stepKey === 'motivation') return (data.motivation || '').trim().length >= 40;
  // Új (61-es) formában a `booked` dönt; a régi, beégetett foglalásnak csak `slot`-ja van.
  if (stepKey === 'interview') return !!(data.interview && (data.interview.booked || (!data.interview.status && data.interview.slot)));
  // A díj akkor enged tovább, ha a pénzügy jóváhagyta (paid), VAGY a jelentkező bejelentette az
  // átutalást (declared). A bejelentés nem befizetés — a pénzügy a bankkivonaton ellenőrzi.
  if (stepKey === 'fee') return program.tuition === 0 || (data.fee && (data.fee.paid || data.fee.declared));
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

  if (stepKey === 'choice') {
    const kat = program._katalogus || [];
    const beadva = !!(cur.status && cur.status !== 'draft');
    const felevek = PROG_upcomingTerms();
    const term = data.term || '';
    const evszak = PROG_termSeason(term);
    const ids = PROG_appIds({ data });
    const setIds = (uj) => setData({ program_ids: uj.slice(0, PROG_MAX_DEGREES) });
    const mozgat = (i, irany) => { const u = [...ids]; const j = i + irany; if (j < 0 || j >= u.length) return; [u[i], u[j]] = [u[j], u[i]]; setIds(u); };
    const nyitott = kat.filter(x => PROG_kind(x) === 'degree' && x.is_open && !ids.includes(x.id));
    return (
      <div className="space-y-7" data-lepes-kepzesek="1">
        <PROG_Head icon={Lucide.ListChecks} title="Képzések és félév" sub="Egy jelentkezésben legfeljebb 3 képzést jelölhetsz meg. A sorrend a preferenciád — az interjú után a felvételi iroda dönt, melyikre veszünk fel." />
        <div>
          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Melyik félévre jelentkezel?</div>
          <div className="grid sm:grid-cols-2 gap-3">
            {felevek.map(t => { const on = term === t.code; return (
              <button key={t.code} type="button" disabled={beadva} aria-pressed={on} onClick={() => setData({ term: t.code })}
                className={'text-left p-4 rounded-2xl border transition-all disabled:cursor-not-allowed ' + (on ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-slate-100 hover:border-slate-300')}>
                <div className="flex items-center gap-2"><Lucide.CalendarRange size={16} className={on ? 'text-primary' : 'text-slate-400'} /><span className="font-black text-slate-800">{PROG_termLabel(t.code, true)}</span></div>
                <div className="text-[12px] font-semibold text-slate-400 mt-1">{PROG_termLabel(t.code)}</div>
              </button>
            ); })}
          </div>
          {term && !felevek.some(t => t.code === term) && <p className="mt-2 text-[12px] font-bold text-slate-500">{'Mentett félév: ' + PROG_termLabel(term)}</p>}
        </div>
        <div>
          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">{`Megjelölt képzések (${ids.length}/${PROG_MAX_DEGREES})`}</div>
          <div className="space-y-2">
            {ids.map((id, i) => { const x = kat.find(k => k.id === id); const nemIndul = !!(x && evszak && !PROG_intakesOf(x).includes(evszak)); return (
              <div key={id} className={'flex items-center gap-3 p-3 rounded-2xl border ' + (nemIndul ? 'border-red-200 bg-red-50/60' : 'border-slate-100')}>
                <span className="w-7 h-7 rounded-lg bg-primary text-white text-xs font-black flex items-center justify-center flex-none">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-slate-800 truncate">{x ? x.name : id}</div>
                  <div className="text-[11px] font-semibold text-slate-400 flex flex-wrap gap-x-2">
                    {x && <span>{x.degree}</span>}
                    {x && <span>{PROG_intakesOf(x).map(k => PROG_INTAKES[k]).join(' · ')}</span>}
                  </div>
                  {nemIndul && <div className="text-[11px] font-bold text-red-600 mt-0.5">Ez a képzés a választott félévben nem indul.</div>}
                </div>
                {!beadva && (
                  <div className="flex items-center gap-1 flex-none">
                    <button type="button" aria-label="Feljebb" onClick={() => mozgat(i, -1)} disabled={i === 0} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 disabled:opacity-30 flex items-center justify-center"><Lucide.ChevronUp size={16} /></button>
                    <button type="button" aria-label="Lejjebb" onClick={() => mozgat(i, 1)} disabled={i === ids.length - 1} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 disabled:opacity-30 flex items-center justify-center"><Lucide.ChevronDown size={16} /></button>
                    <button type="button" aria-label="Eltávolítás" onClick={() => setIds(ids.filter(k => k !== id))} disabled={ids.length === 1} className="w-8 h-8 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 disabled:opacity-30 flex items-center justify-center"><Lucide.X size={16} /></button>
                  </div>
                )}
              </div>
            ); })}
          </div>
          {!beadva && ids.length < PROG_MAX_DEGREES && nyitott.length > 0 && (
            <div className="mt-3">
              <UField label="További képzés hozzáadása">
                <select className={U_input} value="" onChange={e => { if (e.target.value) setIds([...ids, e.target.value]); }}>
                  <option value="">Válassz képzést…</option>
                  {nyitott.map(x => { const ok = !evszak || PROG_intakesOf(x).includes(evszak); return <option key={x.id} value={x.id} disabled={!ok}>{x.name + (ok ? '' : ' — ebben a félévben nem indul')}</option>; })}
                </select>
              </UField>
            </div>
          )}
          {beadva && <p className="mt-3 text-[12px] font-semibold text-slate-400">A beadott jelentkezés képzései és féléve már nem módosíthatók.</p>}
        </div>
      </div>
    );
  }
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
          <UField label="Állampolgárság szerinti ország"><CTRY_Select value={p.country} onChange={v => set('country', v)} inputClassName={U_input} /></UField>
          <UField label="Születési dátum"><input type="date" className={U_input} value={p.dob} onChange={e => set('dob', e.target.value)} /></UField>
        </div>
      </div>
    );
  }
  if (stepKey === 'documents') {
    const docs = data.docs || {};
    // Több képzésnél a kötelező dokumentumok uniója; a sor mutatja, melyik képzés kéri.
    const valasztottK = program._valasztott || [];
    const tobbKepzes = valasztottK.length > 1;
    const feltoltveN = (program.required_docs || []).filter(id => PROG_dokFeltoltve(docs[id])).length;
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
        <PROG_Head icon={Lucide.Upload} title="Dokumentumok feltöltése" sub={tobbKepzes ? 'A megjelölt képzések által kért összes dokumentum. Ami több képzéshez is kell, azt elég egyszer feltölteni.' : 'Ezek a fájlok kötelezőek ehhez a képzéshez.'} />
        <p className="text-[12px] font-bold text-slate-400" data-dok-osszesito="1">{`${feltoltveN}/${(program.required_docs || []).length} dokumentum feltöltve`}</p>
        <div className="space-y-3">
          {(program.required_docs || []).map(id => { const got = docs[id]; return (
            <div key={id} className={'flex items-center justify-between gap-4 p-4 rounded-2xl border ' + (got ? 'border-emerald-100 bg-emerald-50/40' : 'border-slate-100')}>
              <div className="flex items-center gap-3 min-w-0">
                <div className={'w-9 h-9 rounded-xl flex items-center justify-center flex-none ' + (got ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400')}>{got ? <Lucide.Check size={17} /> : <Lucide.FileText size={17} />}</div>
                <div className="min-w-0"><div className="text-sm font-bold text-slate-700 truncate">{PROG_docLabel(id)}</div>{got && <div className="text-[11px] text-emerald-600 font-semibold truncate">{got.fileName}</div>}{tobbKepzes && <div className="mt-1 flex flex-wrap items-center gap-1" data-keri={id}><span className="text-[10px] font-bold text-slate-400">Kéri:</span>{valasztottK.filter(x => (x.required_docs || []).includes(id)).map(x => <span key={x.id} title={x.name} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-bold">{x.code || x.name}</span>)}</div>}</div>
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
    /* A régi, beégetett időpontlista CSAK akkor jelenik meg, ha a 61-es
       migráció még nem futott le (vagy nincs adatbázis-kapcsolat) — az
       IV_ProcessInterview ilyenkor ezt a tartalékot rendereli. */
    const slots = PROG_slots();
    const book = (s) => setData({ interview: { slot: s.time, interviewer: s.interviewer, teamsUrl: 'https://teams.microsoft.com/l/meetup-join/nje-' + s.id } });
    const regi = iv.slot ? (
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
    );
    // A szerver állapotát tükrözzük a data.interview-ban: ettől nyílik a „Folytatás”.
    const allapot = (st) => {
      const c = st && st.current;
      const uj = c ? { slotId: c.id, status: c.status, booked: c.status === 'Booked', slot: c.start, start: c.start, end: c.end, interviewer: c.interviewer_name, teamsUrl: c.teams_url } : {};
      if ((iv.slotId || '') !== (uj.slotId || '') || (iv.status || '') !== (uj.status || '')) setData({ interview: uj });
    };
    return (
      <div className="space-y-5">
        <PROG_Head icon={Lucide.Video} title="Online interjú foglalása" sub="A foglaláskor automatikusan létrejön a Microsoft Teams meeting." />
        <IV_ProcessInterview processId={cur.id} fallback={regi} onState={allapot} />
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
        ) : (fee.paid || fee.declared) ? (
          <div className={'flex flex-wrap items-center gap-2 font-black p-4 rounded-2xl border ' + (fee.paid ? 'text-emerald-600 bg-emerald-50 border-emerald-100' : 'text-amber-700 bg-amber-50 border-amber-200')}>
            {fee.paid ? <Lucide.CheckCircle2 size={18} /> : <Lucide.Clock size={18} />}
            <span>{fee.paid ? 'Befizetés jóváhagyva' : 'Átutalás bejelentve — a pénzügy ellenőrzi'}</span>
            <span className="font-semibold text-[13px]">{[fee.method, fee.date].filter(Boolean).join(' · ')}</span>
            {fee.reference ? <span className="font-mono text-[12px]">{fee.reference}</span> : null}
          </div>
        ) : (
          <>
            {/* Az utalási közlemény a folyamatszámból (ref_no) képződik — ugyanazt látja az iroda és a pénzügy. */}
            {cur.ref_no ? <FIZ_KozlemenyDoboz refNo={cur.ref_no} magyarazat="A díj banki átutalásakor ezt írd a közlemény rovatba — enélkül nem tudjuk a befizetést a jelentkezésedhez rendelni." />
              : <p className="text-[12px] text-slate-500">Az utalási közlemény a jelentkezés mentése után jelenik meg.</p>}
            <div className="flex flex-wrap gap-3">
              <button className={U_btnPrimary} onClick={() => setData({ fee: { declared: true, method: 'Banki átutalás', date: todayStr(), reference: FIZ_kozlemeny(cur.ref_no) || null } })}><Lucide.Landmark size={16} /> Átutalás bejelentése</button>
            </div>
          </>
        )}
        <p className="text-[12px] text-slate-500 leading-relaxed">A díjat banki átutalással kell rendezni a fenti közleménnyel. A bejelentés után a jelentkezés folytatható; a befizetést a pénzügy a bankkivonaton ellenőrzi, és csak azután lesz jóváhagyva.</p>
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
            {PROG_kind(program) === 'degree' && (program._valasztott || []).length > 0 && (
              <div className="p-4 rounded-2xl border border-slate-100 space-y-2">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Megjelölt képzések és félév</div>
                <ol className="space-y-1">
                  {program._valasztott.map((x, i) => <li key={x.id} className="text-sm font-bold text-slate-700">{(i + 1) + '. ' + x.name}</li>)}
                </ol>
                {data.term && <div className="text-[12px] font-semibold text-slate-500">{PROG_termLabel(data.term)}</div>}
              </div>
            )}
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

/* ---------- a jelentkezés irodai szakasza, a hallgató szemszögéből ----------
   A beadás után a kártyáról indított jelentkezés NEM egy másik felületen
   folytatódik: ugyanitt látszik a dokumentum-ellenőrzés, a döntés és a
   felvételi levél — ugyanaz az állapot, amit az ügyintéző lát. */
const PROG_IRODA_IKON = { check: Lucide.ShieldCheck, interview: Lucide.Video, decision: Lucide.Gavel, letter: Lucide.FileCheck };
function PROG_IrodaiLepes({ lepes, cur, data, program }) {
  if (!lepes) return null;
  const beadva = !!cur.status && cur.status !== 'draft';
  const elotte = !beadva ? (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-600 flex items-start gap-2" role="note">
      <Lucide.Info size={16} className="flex-none mt-0.5" />
      <span>Ez a lépés a jelentkezés beadása után következik, a felvételi iroda végzi.</span>
    </div>
  ) : null;
  if (lepes.key === 'check') {
    const dok = PROG_dokKovetelmeny(data, program._valasztott || [], program.required_docs || []);
    return (
      <div className="space-y-5" data-iroda-lepes="check">
        <PROG_Head icon={Lucide.ShieldCheck} title="Dokumentum-ellenőrzés" sub="A felvételi iroda átnézi és jóváhagyja a feltöltött dokumentumokat." />
        {elotte}
        <p className="text-[12px] font-bold text-slate-400">{`${dok.hitelesitve}/${dok.osszes} dokumentum jóváhagyva`}</p>
        <div className="space-y-2">
          {dok.items.map(d => (
            <div key={d.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100">
              <span className={'w-8 h-8 rounded-lg flex items-center justify-center flex-none ' + (d.hitelesitve ? 'bg-emerald-500 text-white' : d.feltoltve ? 'bg-amber-100 text-amber-700' : 'bg-red-50 text-red-500')}>
                {d.hitelesitve ? <Lucide.ShieldCheck size={16} /> : d.feltoltve ? <Lucide.Clock size={16} /> : <Lucide.AlertCircle size={16} />}
              </span>
              <span className="flex-1 min-w-0 text-sm font-bold text-slate-700 truncate">{d.label}</span>
              <span className={'text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-full ' + (d.hitelesitve ? 'bg-emerald-50 text-emerald-700' : d.feltoltve ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600')}>{d.hitelesitve ? 'Jóváhagyva' : d.feltoltve ? 'Ellenőrzésre vár' : 'Hiányzik'}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (lepes.key === 'interview') {
    return (
      <div className="space-y-5" data-iroda-lepes="interview">
        <PROG_Head icon={Lucide.Video} title="Interjú" sub="Az interjú időpontját a felvételi iroda jelölte ki." />
        <IV_ProcessInterview processId={cur.id} />
      </div>
    );
  }
  if (lepes.key === 'decision') {
    const d = data.decision && PROG_DONTES_CIMKE[data.decision.outcome] ? data.decision : null;
    const fp = d && d.programId ? (program._valasztott || []).find(x => x.id === d.programId) : null;
    return (
      <div className="space-y-5" data-iroda-lepes="decision">
        <PROG_Head icon={Lucide.Gavel} title="Felvételi döntés" sub="A döntést a felvételi iroda hozza meg a dokumentumok és az interjú alapján." />
        {elotte}
        {!d ? (beadva && <p className="text-sm text-slate-500">Még nem született döntés. Amint megszületik, itt látod.</p>)
          : d.outcome === 'admitted' ? (
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5">
              <div className="font-black text-emerald-800 flex items-center gap-2"><Lucide.CheckCircle2 size={18} /> Felvettünk!</div>
              {fp && <p className="text-sm text-emerald-800 mt-1"><span>Képzés:</span> <span className="font-bold">{fp.name}</span></p>}
            </div>
          ) : d.outcome === 'rejected' ? (
            <div className="rounded-2xl border border-red-100 bg-red-50 p-5 text-red-700 font-black flex items-center gap-2"><Lucide.XCircle size={18} /> A jelentkezésedet ezúttal nem tudtuk elfogadni.</div>
          ) : (
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5 text-slate-600 font-bold">A jelentkezéstől visszaléptél.</div>
          )}
      </div>
    );
  }
  if (lepes.key === 'letter') {
    const proc = { ...cur, data };
    const kiment = !!(JourneyShared.letterSent && JourneyShared.letterSent(proc));
    const LetterDoc = JourneyShared.LetterDoc;
    return (
      <div className="space-y-5" data-iroda-lepes="letter">
        <PROG_Head icon={Lucide.FileCheck} title="Felvételi levél" sub="A felvételi levelet a felvételi iroda állítja ki és küldi el." />
        {elotte}
        {lepes.kihagyva ? <p className="text-sm text-slate-500">A döntés alapján felvételi levél nem készül.</p>
          : (kiment && LetterDoc) ? (
            <div className="space-y-3" data-level-hallgato="1">
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3">
                <Lucide.CheckCircle2 size={18} className="text-emerald-600 flex-none" />
                <span className="text-sm font-bold text-emerald-800 flex-1 min-w-0"><span>Felvételi leveled elkészült</span>{data.letter && data.letter.sentAt ? <span className="font-semibold text-emerald-700">{' · ' + DL_date(data.letter.sentAt)}</span> : null}</span>
                <LEVEL_LetoltesGomb processId={cur.id} fileNumber={data.letter && data.letter.fileNumber}
                  forras='[data-level-hallgato="1"] [data-no-i18n="1"]' className={U_btnPrimary + ' !py-2 text-sm'} />
              </div>
              {cur.ref_no ? <FIZ_KozlemenyDoboz refNo={cur.ref_no} magyarazat="A levélben szereplő díjak átutalásakor ezt írd a közlemény rovatba — enélkül nem tudjuk a befizetést a jelentkezésedhez rendelni." /> : null}
              <LetterDoc proc={proc} />
            </div>
          )
          : (beadva && <p className="text-sm text-slate-500">A levél a felvételi döntés után készül el. Amint kiküldtük, itt olvashatod.</p>)}
      </div>
    );
  }
  return null;
}

/* A „Felvételi folyamat” gyűjtőnézetből megnyitott, kártyáról indított
   jelentkezés: ugyanaz a nézet (ProgramApply), mint a Képzési kínálatból. */
function PROG_FolyamatMegnyitas({ processId, user, onExit, kezdoLepes }) {
  const [allapot, setAllapot] = useState(null);
  const [hiba, setHiba] = useState('');
  const betolt = async () => {
    try {
    const [programs, apps] = await Promise.all([PROG_loadPrograms(), PROG_loadApps(), PROG_loadDocTypes()]);
    setAllapot({ programs: programs || [], app: (apps || []).find(a => a.id === processId) || null });
    setHiba('');
    } catch (e) { setHiba(e.message || 'A betöltés nem sikerült.'); }
  };
  useEffect(() => { betolt(); }, [processId]);
  const vissza = <button className={U_btnGhost} onClick={onExit}><Lucide.ArrowLeft size={15} /> Vissza a felvételi folyamatokhoz</button>;
  if (hiba) return <div role="alert" className="space-y-4 rounded-xl bg-red-50 p-6 text-red-700"><p>{hiba}</p>{vissza}</div>;
  if (!allapot) return <div className="h-64 rounded-3xl bg-white border border-slate-100 animate-pulse" />;
  if (!allapot.app) return <div className="bg-white rounded-3xl border border-slate-100 p-8 text-center space-y-4"><p className="text-slate-500 font-semibold">A jelentkezés nem található.</p>{vissza}</div>;
  const program = allapot.programs.find(x => x.id === PROG_appIds(allapot.app)[0]);
  if (!program) return <div className="bg-white rounded-3xl border border-slate-100 p-8 text-center space-y-4"><p className="text-slate-500 font-semibold">A jelentkezés képzése már nem szerepel a kínálatban.</p>{vissza}</div>;
  return <ProgramApply key={allapot.app.id} program={program} programs={allapot.programs} app={allapot.app} user={user} onExit={onExit} onSaved={() => betolt()} backLabel="Vissza a felvételi folyamatokhoz" kezdoLepes={kezdoLepes} />;
}

/* ---------- jelentkezés indítása, ha már van jelentkezése ----------
   A kijelölés alapból ÚJ jelentkezést indít. A választó megmutatja a
   folyamatban lévő és a már beadott jelentkezéseket, és ezekből kínál:
   • Folytatás — ha pontosan ugyanezekre a képzésekre és félévre szól;
   • Hozzáadás ehhez — ha ugyanarra a félévre szól, és így sem lesz 3-nál több;
   • Megnyitás — beadott jelentkezésnél, vagy ha a képzések már benne vannak. */
function PROG_InditasValaszto({ ids, term, programs, myApps, busy, onClose, onUj, onHozzaad, onMegnyit }) {
  const keres = (id) => (programs || []).find(x => x.id === id);
  const nev = (id) => (keres(id) || {}).name || id;
  const kepzesApp = (a) => PROG_appIds(a).some(id => { const x = keres(id); return x && PROG_kind(x) === 'degree'; });
  const azon = (a) => a.ref_no ? 'FV-' + String(a.ref_no).padStart(5, '0') : '';
  const kulcs = (arr) => [...arr].sort().join('|');
  const felevE = (a) => (a.data && a.data.term) || '';
  const nyitott = (myApps || []).filter(a => a.status === 'draft' && !(a.data && a.data._cancelled) && kepzesApp(a));
  const beadott = (myApps || []).filter(a => a.status !== 'draft' && !(a.data && a.data._cancelled) && kepzesApp(a) && PROG_appIds(a).some(id => ids.includes(id)));
  const azonos = nyitott.find(a => kulcs(PROG_appIds(a)) === kulcs(ids) && felevE(a) === term) || null;
  const cimke = 'text-[10px] font-black text-slate-400 uppercase tracking-widest';

  const kartya = (a, gomb) => {
    const fa = PROG_folyamatAllapot(a, programs);
    return (
      <div key={a.id} data-inditas-app={a.id} className="rounded-2xl border border-slate-100 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {azon(a) && <span className="font-mono text-[11px] font-bold text-slate-500">{azon(a)}</span>}
            {felevE(a) && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-violet-50 text-violet-700">{PROG_termLabel(felevE(a), true)}</span>}
            <UBadge tone={PROG_allapotTone(fa)}>{fa.cimke}</UBadge>
          </div>
          <div className="text-sm font-bold text-slate-700 mt-1">{PROG_appIds(a).map(nev).join(' · ')}</div>
          <div className="text-[11px] text-slate-400">{`${fa.kesz}/${fa.osszes} lépés kész`}</div>
        </div>
        <div className="flex-none">{gomb}</div>
      </div>
    );
  };

  return (
    <UModal open onClose={busy ? () => {} : onClose} max="max-w-2xl" title="Jelentkezés indítása" subtitle={PROG_termLabel(term, true)} icon={<Lucide.Send size={20} />}>
      <div className="space-y-5" data-inditas-valaszto="1">
        <div>
          <div className={cimke + ' mb-1.5'}>Kijelölt képzések</div>
          <ol className="space-y-1">{ids.map((id, i) => <li key={id} className="text-sm font-bold text-slate-700">{(i + 1) + '. ' + nev(id)}</li>)}</ol>
        </div>
        {azonos && (
          <div role="note" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
            <Lucide.Info size={16} className="flex-none mt-0.5" />
            <span>Ugyanezekre a képzésekre és félévre már van folyamatban lévő jelentkezésed — érdemes azt folytatni.</span>
          </div>
        )}
        {nyitott.length > 0 && (
          <div className="space-y-2">
            <div className={cimke}>Folyamatban lévő jelentkezéseid</div>
            {nyitott.map(a => {
              if (a === azonos) return kartya(a, <button type="button" disabled={busy} onClick={() => onMegnyit(a)} className={U_btnPrimary + ' !py-2 text-sm'} data-inditas-folytat={a.id}>Folytatás</button>);
              const regi = PROG_appIds(a);
              const ujak = ids.filter(id => !regi.includes(id));
              const osszesen = regi.length + ujak.length;
              const miert = felevE(a) && felevE(a) !== term ? 'Más félévre szól.'
                : !ujak.length ? 'Ezek a képzések már benne vannak.'
                : osszesen > PROG_MAX_DEGREES ? `Így ${osszesen} képzés lenne (legfeljebb ${PROG_MAX_DEGREES}).` : '';
              const hozzaadhato = !miert;
              return kartya(a, (
                <div className="flex flex-col items-stretch sm:items-end gap-1">
                  {!ujak.length
                    ? <button type="button" disabled={busy} onClick={() => onMegnyit(a)} className={U_btnGhost + ' !py-2 text-sm'}>Megnyitás</button>
                    : <button type="button" disabled={busy || !hozzaadhato} onClick={() => onHozzaad(a)} className={U_btnGhost + ' !py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed'} data-inditas-hozzaad={a.id}>Hozzáadás ehhez</button>}
                  {miert && <span className="text-[11px] font-semibold text-slate-400" data-inditas-miert={a.id}>{miert}</span>}
                </div>
              ));
            })}
          </div>
        )}
        {beadott.length > 0 && (
          <div className="space-y-2">
            <div className={cimke}>Már beadott jelentkezésed ezekre a képzésekre</div>
            {beadott.map(a => kartya(a, <button type="button" disabled={busy} onClick={() => onMegnyit(a)} className={U_btnGhost + ' !py-2 text-sm'}>Megnyitás</button>))}
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-4 border-t border-slate-100">
          <button type="button" disabled={busy} onClick={onClose} className={U_btnGhost}>Mégse</button>
          <button type="button" disabled={busy} onClick={onUj} className={U_btnPrimary} data-inditas-uj="1">
            {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.Plus size={16} />} {busy ? 'Indítás…' : 'Új jelentkezés indítása'}
          </button>
        </div>
      </div>
    </UModal>
  );
}

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
            {/* TESZT-SEGÍTSÉG: a megoldás a kérdés végén, amíg a felületet teszteljük (ugyanígy az app.jsx matek-lépésében). Élesítés előtt törlendő. */}
            <p className="text-sm font-bold text-slate-700 mb-3">{t.prompt}<span data-teszt-megoldas className="ml-2 inline-flex items-center gap-1 align-middle text-xs font-bold text-amber-600"><Lucide.FlaskConical size={12} /> TESZT — helyes válasz: {t.fields.map(f => f.label + ' ' + t.answers[f.key]).join(', ')}</span></p>
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
function PROG_myState(p, mine, katalogus) {
  if (!mine) return { tier: 3 };
  /* Ugyanaz a valós állapot, mint a lépéssávon és a „Felvételi folyamat”
     gyűjtőnézetben: a kész lépés és a feltöltött dokumentum az adatból számol,
     több képzésnél a megjelölt képzések uniójával. */
  const fa = PROG_folyamatAllapot(mine, katalogus && katalogus.length ? katalogus : [p]);
  const alap = { feltoltve: fa.dok.feltoltve, kell: fa.dok.osszes, lepes: fa.kesz, osszes: fa.osszes, fa };
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

function PROG_Catalog({ programs, myApps, onOpen, onContinue, isDeg, felev, setFelev, kijelolt, onKijelol }) {
  const [level, setLevel] = useState('all');
  const [q, setQ] = useState('');
  const evszak = isDeg ? PROG_termSeason(felev) : '';
  const alapLista = programs.filter(p => (level === 'all' || p.level === level) && (!q || (p.name + ' ' + p.faculty).toLowerCase().includes(q.toLowerCase())));
  // Képzésnél csak a választott félévben induló látszik — a saját jelentkezéseié mindig.
  const list = alapLista.filter(p => !evszak || PROG_intakesOf(p).includes(evszak) || myApps.some(a => PROG_appIds(a).includes(p.id)));
  const rejtett = alapLista.length - list.length;
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
    .map((p, i) => { const mine = myApps.find(a => PROG_appIds(a).includes(p.id)); return { p, i, mine, st: PROG_myState(p, mine, programs) }; })
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
      {isDeg && felev && setFelev && (
        <div className="mb-5 rounded-2xl border border-slate-100 bg-white p-4" data-felev-valaszto="1">
          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Melyik félévre jelentkeznél?</div>
          <div className="flex flex-wrap gap-2">
            {PROG_upcomingTerms().map(t => (
              <button key={t.code} type="button" aria-pressed={felev === t.code} onClick={() => setFelev(t.code)}
                className={'px-4 py-2 rounded-full text-[13px] font-bold transition-all ' + (felev === t.code ? 'bg-primary text-white' : 'bg-slate-50 border border-slate-100 text-slate-600 hover:border-slate-300')}>{PROG_termLabel(t.code, true)}</button>
            ))}
          </div>
          <p className="text-[12px] text-slate-400 font-semibold mt-2">Egy jelentkezésben legfeljebb 3 képzést jelölhetsz meg — jelöld ki őket a kártyákon.</p>
          {rejtett > 0 && <p className="text-[12px] text-slate-500 font-bold mt-1">{`${rejtett} képzés ebben a félévben nem indul, ezért nem látszik.`}</p>}
        </div>
      )}
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
                  : st.tier === 1 ? <UBadge tone={st.fa ? PROG_allapotTone(st.fa) : stat.tone} className="!bg-white/90 backdrop-blur">{st.fa ? st.fa.cimke : stat.label}</UBadge>
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
            {st.tier === 1 && st.fa && (
              <div className="px-5 py-2.5 bg-blue-50 border-b border-blue-100 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-blue-800" data-kartya-allapot="1">
                <span>{`${st.lepes}/${st.osszes} lépés kész`}</span>
                {st.kell > 0 && <span>{`${st.feltoltve}/${st.kell} dokumentum feltöltve`}</span>}
                {st.fa.aktualis && !['rejected', 'withdrawn', 'cancelled', 'accepted'].includes(st.fa.kod) && <span><span>Következő:</span> <span>{st.fa.aktualis.label}</span></span>}
              </div>
            )}
            {st.tier === 2 && (
              <div className="px-5 py-2.5 bg-red-50 border-b border-red-100 text-[11px] font-bold text-red-700">A jelentkezés már nem folytatható</div>
            )}
            <div className="p-5 flex flex-col flex-1">
              <h3 className="font-black text-slate-900 tracking-tight leading-snug">{p.name}</h3>
              <p className="text-[12px] text-slate-400 font-semibold mt-1">{p.faculty}</p>
              {isDeg && <p className="text-[11px] font-bold text-violet-600 mt-1">{PROG_intakesOf(p).map(k => PROG_INTAKES[k]).join(' · ')}</p>}
              <p className="text-sm text-slate-500 mt-3 leading-relaxed line-clamp-3 flex-1">{p.summary}</p>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-50">
                <div><div className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Tandíj</div><div className="font-black text-slate-800">{DL_money(p.tuition)}{p.tuition ? <span className="text-[11px] text-slate-400 font-bold">/sem</span> : ''}</div></div>
                {isDeg && !mine && p.is_open && onKijelol && (() => { const on = (kijelolt || []).includes(p.id); const tele = !on && (kijelolt || []).length >= PROG_MAX_DEGREES; return (
                  <button type="button" onClick={() => onKijelol(p.id)} disabled={tele} aria-pressed={on} title={tele ? 'Legfeljebb 3 képzés jelölhető meg.' : undefined}
                    className={'mr-auto ml-3 px-3 py-1.5 rounded-xl text-[12px] font-black inline-flex items-center gap-1.5 border transition-all disabled:opacity-40 ' + (on ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-slate-200 hover:border-primary')}>
                    {on ? <Lucide.CheckSquare size={14} /> : <Lucide.Square size={14} />}{on ? 'Kijelölve' : 'Kijelölés'}
                  </button>
                ); })()}
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
function PROG_Editor({ open, program, onClose, onSaved, scope, user }) {
  const isDeg = scope === 'degrees';
  const levelOpts = isDeg ? PROG_DEGREE_LEVELS : PROG_PROGRAM_LEVELS;
  const blank = { id: '', code: '', name: '', level: isDeg ? 'bachelor' : 'course', faculty: '', degree: isDeg ? 'BSc' : 'Short course', duration_semesters: isDeg ? 7 : 2, ects: isDeg ? 210 : 30, tuition: isDeg ? 2500 : 400, currency: 'EUR', language: 'English', deadline: '2026-06-30', capacity: 30, seats_taken: 0, is_open: true, summary: '', image_url: '', required_docs: isDeg ? ['passport', 'hs_diploma', 'english'] : ['passport'], steps: isDeg ? ['personal', 'documents', 'interview', 'fee', 'review'] : ['personal', 'fee', 'review'], tags: [], intakes: ['autumn', 'spring'] };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  // A mentés megtagadható (72/73-as jogosultsági réteg) — a modál ilyenkor
  // nyitva marad a beírt adatokkal, és kiírja, miért nem sikerült.
  const [mentesHiba, setMentesHiba] = useState('');
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
  const toggleIntake = (k) => setF(p => { const most = PROG_intakesOf(p); const uj = most.includes(k) ? most.filter(x => x !== k) : [...most, k]; return uj.length ? { ...p, intakes: ['autumn', 'spring'].filter(x => uj.includes(x)) } : p; });
  const moveStep = (i, dir) => setF(p => { const s = [...p.steps]; const j = i + dir; if (j < 0 || j >= s.length) return p; [s[i], s[j]] = [s[j], s[i]]; return { ...p, steps: s }; });
  const uploadImg = async (e) => { const file = e.target.files && e.target.files[0]; if (!file) return; const dataUrl = await KB_readFileAsDataUrl(file); set('image_url', dataUrl); };

  const save = async () => {
    if (!PERM_can(user, isDeg ? 'trainings' : 'programs', program ? 'EDIT' : 'CREATE',
      !!user && ['ADMIN', 'SUPERADMIN'].includes(user.role))) return;
    if (!f.name.trim()) return; setBusy(true);
    const row = { ...f, tuition: Number(f.tuition) || 0, ects: Number(f.ects) || 0, duration_semesters: Number(f.duration_semesters) || 0, capacity: Number(f.capacity) || 0, tags: typeof f.tags === 'string' ? f.tags.split(',').map(s => s.trim()).filter(Boolean) : f.tags };
    // A 60-as migráció előtt nincs intakes oszlop: a mezőt nem küldjük, különben az egész mentés elbukna.
    if (!PROG_INTAKE_COL) delete row.intakes; else row.intakes = PROG_intakesOf(f);
    // A dlUpdate/dlInsert megtagadás esetén dob (data-layer.jsx): a modál
    // maradjon nyitva a beírt adatokkal, és mondja meg, miért nem mentett.
    try {
      if (program) { await dlUpdate(PROG_TABLE, program.id, row, PROG_LS); }
      else { row.id = uid('prog'); row.created_at = todayStr(); await dlInsert(PROG_TABLE, row, PROG_LS); }
    } catch (e) {
      setMentesHiba((e && e.message) || 'A mentés nem sikerült.');
      setBusy(false);
      return;
    }
    setBusy(false); onSaved && onSaved(); onClose();
  };

  return (
    <UModal open={open} onClose={onClose} max="max-w-3xl" title={(program ? 'Szerkesztés — ' : 'Új ') + (isDeg ? 'képzés' : 'program')} subtitle={isDeg ? 'Az adatok és a képzés felvételi folyamatának beállítása' : 'Az adatok és a program jelentkezési folyamatának beállítása'} icon={<Lucide.GraduationCap size={20} />}>
      <div className="space-y-6">
        {mentesHiba && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
            <Lucide.AlertCircle size={16} className="mt-0.5 flex-none" />
            <span className="flex-1">{mentesHiba}</span>
            <button onClick={() => setMentesHiba('')} className="text-red-400 hover:text-red-700"><Lucide.X size={14} /></button>
          </div>
        )}
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

        {isDeg && (
          <div className="rounded-2xl border border-slate-100 p-4" data-inditas-felev="1">
            <div className="flex items-center gap-2 mb-1"><Lucide.CalendarRange size={16} className="text-primary" /><span className="text-sm font-black text-slate-700">Indulás féléve</span></div>
            <p className="text-[12px] text-slate-400 mb-3">A jelentkező csak olyan félévre jelölheti meg a képzést, amelyben az elindul.</p>
            <div className="grid sm:grid-cols-2 gap-2">
              {Object.entries(PROG_INTAKES).map(([k, label]) => { const on = PROG_intakesOf(f).includes(k); return (
                <button key={k} type="button" aria-pressed={on} onClick={() => toggleIntake(k)} className={'flex items-center gap-2 px-3 py-2 rounded-xl border text-[13px] font-bold transition-all ' + (on ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 text-slate-400 hover:border-slate-200')}>
                  <span className={'w-4 h-4 rounded flex-none flex items-center justify-center ' + (on ? 'bg-primary text-white' : 'bg-slate-200')}>{on && <Lucide.Check size={11} />}</span>{label}
                </button>
              ); })}
            </div>
            {!PROG_INTAKE_COL && <p className="text-[12px] font-semibold text-amber-700 mt-2">A félév mentéséhez futtasd le a 60-as adatbázis-migrációt — addig minden képzés mindkét félévben indul.</p>}
          </div>
        )}

        {/* flow editor */}
        <div className="rounded-2xl border border-slate-100 p-4">
          <div className="flex items-center gap-2 mb-3"><Lucide.ListChecks size={16} className="text-primary" /><span className="text-sm font-black text-slate-700">Felvételi folyamat — lépések</span></div>
          <div className="grid sm:grid-cols-2 gap-2 mb-4">
            {Object.entries(PROG_STEP_DEFS).filter(([k]) => k !== 'choice').map(([k, def]) => { const on = f.steps.includes(k); const I = def.icon; return (
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
  const rows = apps.filter(a => pid === 'all' || PROG_appIds(a).includes(pid));
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
      try {
        await dlUpdate(APP_TABLE, a.id, { updated_at: new Date().toISOString() }, APP_LS);
      } catch (e) {
        alert((e && e.message) || 'A művelet nem sikerült.');
        return;
      }
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
            <thead><tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100"><th className="px-5 py-3">Jelentkező</th><th className="px-5 py-3">Képzés</th><th className="px-5 py-3">Előrehaladás</th><th className="px-5 py-3">Beadva</th><th className="px-5 py-3">Státusz</th><th className="px-5 py-3">Döntés</th></tr></thead>
            <tbody>
              {rows.map(a => { const p = programs.find(x => x.id === a.program_id); const total = p ? (p.steps || []).length : 1; const prog = Math.round(((a.step_index || 0) / Math.max(total - 1, 1)) * 100); return (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <td className="px-5 py-3"><div className="font-bold text-slate-700">{a.applicant_name || '—'}</div><div className="text-[11px] text-slate-400">{a.applicant_email}</div>{a.ref_no && <div className="text-[10px] font-mono font-bold text-slate-400">{'FV-' + String(a.ref_no).padStart(5, '0')}</div>}</td>
                  <td className="px-5 py-3 text-slate-600 font-semibold"><div className="space-y-0.5">{PROG_appIds(a).map((id, i, all) => <div key={id}>{(all.length > 1 ? (i + 1) + '. ' : '') + nameOf(id)}</div>)}</div>{a.term && <div className="text-[11px] font-bold text-violet-600 mt-0.5">{PROG_termLabel(a.term, true)}</div>}</td>
                  <td className="px-5 py-3"><div className="flex items-center gap-2"><div className="w-20 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-primary rounded-full" style={{ width: prog + '%' }} /></div><span className="text-[11px] font-bold text-slate-400">{prog}%</span></div></td>
                  <td className="px-5 py-3 text-[12px] text-slate-400 font-semibold">{a.status === 'draft' ? '—' : DL_date(a.updated_at || a.created_at)}</td>
                  <td className="px-5 py-3">{a.status === 'draft'
                    ? <div className="flex flex-col items-start gap-1"><UBadge tone="slate">Piszkozat</UBadge><button onClick={() => setStatus(a, 'submitted')} className="text-[11px] font-bold text-primary hover:underline">Beadás az iroda nevében</button></div>
                    : <UBadge tone="blue">Beadva</UBadge>}</td>
                  <td className="px-5 py-3">{(() => { const dd = a.data && a.data.decision; if (!dd) return <span className="text-[11px] text-slate-300">—</span>; const tone = dd.outcome === 'admitted' ? 'green' : dd.outcome === 'rejected' ? 'red' : 'slate'; const label = { admitted: 'Felvéve', rejected: 'Elutasítva', withdrawn: 'Visszalépett' }[dd.outcome] || dd.outcome; return <div className="space-y-0.5"><UBadge tone={tone}>{label}</UBadge>{dd.outcome === 'admitted' && dd.programId && <div className="text-[11px] font-semibold text-slate-500">{nameOf(dd.programId)}</div>}</div>; })()}</td>
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
  const [betoltesHiba, setBetoltesHiba] = useState('');
  const [apps, setApps] = useState([]);
  const [detail, setDetail] = useState(null);
  const [applying, setApplying] = useState(null); // {program, app}
  const [editor, setEditor] = useState({ open: false, program: null });
  /* KEZELŐI NÉZET: a katalógus szerkesztése. A 72-es óta a `programs` modul
     EDIT joga dönti el, nem szerepkör-lista.
     A `regi` érték a MAI viselkedés — beleértve a SUPERADMIN külön ágát, amit
     azért kellett ideírni, mert a régi isAdmin() csak az ADMIN-t nézte, és a
     szuperadmin a hallgatói katalógust kapta kezelőtábla helyett. */
  const regiKezelo = !!user && (user.role === 'ADMIN' || user.role === 'SUPERADMIN');
  const jog = PERM_of(user, isDeg ? 'trainings' : 'programs', { create: regiKezelo, edit: regiKezelo });
  const kezelo = jog.create || jog.edit;
  const [tab, setTab] = useState(kezelo && !embedded ? 'manage' : 'explore');

  // A dokumentumtípusok is itt töltődnek, hogy a hallgató feltöltési lépése és a
  // részletező ablak az egyedi típusok NEVÉT mutassa, ne a kulcsát.
  const refetch = async () => {
    try {
      const [p, a] = await Promise.all([PROG_loadPrograms(), PROG_loadApps(), PROG_loadDocTypes()]);
      setPrograms(p); setApps(a); setBetoltesHiba('');
    } catch (e) { setBetoltesHiba(e.message || 'A betöltés nem sikerült.'); }
  };
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
      // A dlInsert megtagadáskor dob (data-layer.jsx). Enélkül a piszkozat
      // csak a helyi tárolóba kerülne, és a jelentkező azt hinné, elindult.
      try {
        app = PROG_fromRow(await dlInsert(APP_TABLE, sor, APP_LS) || sor);
      } catch (e) {
        alert((e && e.message) || 'A jelentkezés nem indítható el.');
        return;
      }
      await refetch();
    }
    setDetail(null); setApplying({ program, app });
  };

  /* KÉPZÉS: legfeljebb 3 képzés EGY jelentkezésben, egy félévre. Ha van
     folyamatban lévő (be nem adott) képzés-jelentkezés, az új képzés abba kerül:
     a rendszer egy felvételi folyamatként kezeli. */
  const [felev, setFelev] = useState(() => PROG_upcomingTerms()[0].code);
  const [kijelolt, setKijelolt] = useState([]);
  useEffect(() => {
    const evszak = PROG_termSeason(felev);
    setKijelolt(k => k.filter(id => { const x = (programs || []).find(p => p.id === id); return !x || PROG_intakesOf(x).includes(evszak); }));
  }, [felev]);
  const kijelol = (id) => setKijelolt(k => k.includes(id) ? k.filter(x => x !== id) : (k.length >= PROG_MAX_DEGREES ? k : [...k, id]));
  /* INDÍTÁS. Korábban az új kijelölés NÉMÁN a folyamatban lévő (be nem adott)
     jelentkezésbe került — ha az már tele volt (3 képzés), a rendszer a régit
     nyitotta meg új jelentkezés helyett (mérve: FV-00037). Most az új kijelölés
     ÚJ jelentkezést indít; meglévőhöz csak a hallgató kifejezett választására
     kerül (PROG_InditasValaszto), egy félévre és legfeljebb 3 képzésig. A dupla
     kattintás nem hoz létre két piszkozatot (inditasRef) — ez okozta az
     FV-00036/37 párost. */
  const [inditas, setInditas] = useState(null);         // { ids, term } — nyitott választó
  const [inditasBusy, setInditasBusy] = useState(false);
  const inditasRef = useRef(false);
  const zarolva = async (fn) => {
    if (inditasRef.current) return;
    inditasRef.current = true; setInditasBusy(true);
    // A dlInsert/dlUpdate a 72/73-as óta dobhat megtagadáskor. Enélkül a hiba
    // néma elutasított ígéret lenne: a gomb visszaállna, és semmi nem történne.
    try { await fn(); }
    catch (e) { alert((e && e.message) || 'A művelet nem sikerült.'); }
    finally { inditasRef.current = false; setInditasBusy(false); }
  };
  const keresProg = (id) => (programs || []).find(x => x.id === id);
  const kepzesApp = (a) => PROG_appIds(a).some(id => { const x = keresProg(id); return x && PROG_kind(x) === 'degree'; });
  const megnyitJelentkezes = (app, notice, tartalekId) => {
    setKijelolt([]); setDetail(null); setInditas(null);
    setApplying({ program: keresProg(PROG_appIds(app)[0]) || keresProg(tartalekId), app, notice: notice || '' });
  };
  const ujJelentkezes = (ids, term) => zarolva(async () => {
    const most = new Date().toISOString();
    const sor = {
      id: uid('APP'), program_id: ids[0],
      owner_email: (user.email || '').toLowerCase(), applicant_name: user.name,
      stage: 'student', student_step: 0, step: 0, max_reached: 0, done: false,
      data: { program_ids: ids, term }, created_at: most, updated_at: most,
    };
    const app = PROG_fromRow(await dlInsert(APP_TABLE, sor, APP_LS) || sor);
    await refetch();
    megnyitJelentkezes(app, '', ids[0]);
  });
  const hozzaadas = (app, ids, term) => zarolva(async () => {
    const regi = PROG_appIds(app);
    const uj = [...regi, ...ids.filter(id => !regi.includes(id))].slice(0, PROG_MAX_DEGREES);
    const ujData = { ...(app.data || {}), program_ids: uj, term: (app.data && app.data.term) || term };
    const saved = await dlUpdate(APP_TABLE, app.id, { data: ujData, program_id: uj[0], updated_at: new Date().toISOString() }, APP_LS);
    const kesz = saved ? PROG_fromRow(saved) : { ...app, data: ujData, program_ids: uj, program_id: uj[0] };
    await refetch();
    megnyitJelentkezes(kesz, 'A kijelölt képzéseket hozzáadtuk a folyamatban lévő jelentkezésedhez.', uj[0]);
  });
  const startDegreeApply = (idsBe, term) => {
    const ids = idsBe.filter((x, i) => idsBe.indexOf(x) === i).slice(0, PROG_MAX_DEGREES);
    if (!ids.length || !user || inditasRef.current) return;
    const nyitott = myApps.filter(a => a.status === 'draft' && !(a.data && a.data._cancelled) && kepzesApp(a));
    const beadott = myApps.filter(a => a.status !== 'draft' && !(a.data && a.data._cancelled) && kepzesApp(a) && PROG_appIds(a).some(id => ids.includes(id)));
    // Ha nincs mivel ütköznie, azonnal indul; különben a hallgató választ.
    if (!nyitott.length && !beadott.length) { ujJelentkezes(ids, term); return; }
    setDetail(null);
    setInditas({ ids, term });
  };

  if (programs === null && betoltesHiba) return <div role="alert" className={keret + ' text-red-700'}>{betoltesHiba}</div>;
  if (programs === null) return <div className={keret}><div className="grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="h-56 rounded-3xl bg-white border border-slate-100 animate-pulse" />)}</div></div>;

  if (applying) {
    const fresh = apps.find(a => a.id === applying.app.id) || applying.app;
    return <ProgramApply program={applying.program} programs={programs} app={fresh} user={user} notice={applying.notice} onExit={() => { refetch(); setApplying(null); }} onSaved={() => refetch()} />;
  }

  const staff = kezelo && !embedded;
  // A hallgató is csak a saját kínálatát látja: a Programok alatt a kisebb
  // programokat, a Képzések alatt a féléves képzéseket — nem a kettő keverékét.
  const scopedPrograms = programs.filter(p => PROG_kind(p) === (isDeg ? 'degree' : 'program'));
  const scopedApps = apps.filter(a => scopedPrograms.some(p => PROG_appIds(a).includes(p.id)));
  return (
    <div className={keret}>
      {betoltesHiba && <div role="alert" className="mb-4 rounded-xl bg-red-50 p-4 text-red-700">{betoltesHiba}</div>}
      {inditas && (
        <PROG_InditasValaszto ids={inditas.ids} term={inditas.term} programs={programs} myApps={myApps} busy={inditasBusy}
          onClose={() => setInditas(null)}
          onUj={() => ujJelentkezes(inditas.ids, inditas.term)}
          onHozzaad={(a) => hozzaadas(a, inditas.ids, inditas.term)}
          onMegnyit={(a) => megnyitJelentkezes(a, '', inditas.ids[0])} />
      )}
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
          {staff && jog.create && tab === 'manage' && <button className={U_btnPrimary} onClick={() => setEditor({ open: true, program: null })}><Lucide.Plus size={16} /> Új {isDeg ? 'képzés' : 'program'}</button>}
        </div>
      </div>}

      {!staff && (
        <>
          <PROG_Catalog programs={scopedPrograms} isDeg={isDeg} myApps={myApps} onOpen={setDetail}
            onContinue={(p, a) => setApplying({ program: (isDeg && scopedPrograms.find(x => x.id === PROG_appIds(a)[0])) || p, app: a })}
            felev={felev} setFelev={setFelev} kijelolt={kijelolt} onKijelol={isDeg ? kijelol : null} />
          {isDeg && kijelolt.length > 0 && (
            <div className="sticky bottom-4 z-30 mt-6" data-kijeloles-sav="1">
              <div className="mx-auto max-w-3xl rounded-3xl bg-slate-900 text-white shadow-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-black">{`${kijelolt.length} képzés kijelölve (legfeljebb ${PROG_MAX_DEGREES})`}</div>
                  <div className="text-[12px] text-white/70 truncate">{kijelolt.map(id => (scopedPrograms.find(x => x.id === id) || {}).name || id).join(' · ')}</div>
                  <div className="text-[12px] text-white/70">{PROG_termLabel(felev)}</div>
                </div>
                <div className="flex items-center gap-2 flex-none">
                  <button type="button" onClick={() => setKijelolt([])} className="px-3 py-2 rounded-xl text-sm font-bold text-white/70 hover:text-white">Kijelölés törlése</button>
                  <button type="button" disabled={inditasBusy} onClick={() => startDegreeApply(kijelolt, felev)} className={U_btnPrimary + ' !py-2.5'}>{inditasBusy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.Send size={16} />} Jelentkezés indítása</button>
                </div>
              </div>
            </div>
          )}
          {(() => {
            // Ugyanaz a rangsor, mint a katalógusban — a két helyen ne álljon más sorrendben ugyanaz.
            // Csak ennek a kínálatnak a jelentkezései: a képzésre adott jelentkezés
            // a Képzések, a programra adott a Programok alatt látszik.
            const sorok = myApps
              .map(a => ({ a, p: scopedPrograms.find(x => x.id === PROG_appIds(a)[0]) }))
              .filter(x => x.p)
              .map(x => ({ ...x, st: PROG_myState(x.p, x.a, scopedPrograms) }))
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
                      <div className="font-bold text-slate-800 truncate">{PROG_appIds(a).map(id => (scopedPrograms.find(x => x.id === id) || {}).name).filter(Boolean).join(' · ') || p.name}</div>
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
        <div className="bg-white rounded-3xl border border-slate-100"><UEmpty icon={<Lucide.GraduationCap size={26} />} title={isDeg ? 'Még nincs képzés' : 'Még nincs program'} subtitle={isDeg ? 'Vedd fel az első képzést (BSc, MSc, MA, MBA vagy PhD).' : 'Vegyél fel egy céglátogatást, továbbképzést, eseti kurzust vagy tanulmányi kirándulást.'} action={jog.create && <button className={U_btnPrimary} onClick={() => setEditor({ open: true, program: null })}><Lucide.Plus size={16} /> Új {isDeg ? 'képzés' : 'program'}</button>} /></div>
      )}
      {staff && tab === 'manage' && scopedPrograms.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100"><th className="px-5 py-3">{isDeg ? 'Képzés' : 'Program'}</th><th className="px-5 py-3">Szint</th>{isDeg && <th className="px-5 py-3">Indulás</th>}<th className="px-5 py-3">Tandíj</th><th className="px-5 py-3">Folyamat</th><th className="px-5 py-3">Határidő</th><th className="px-5 py-3">Státusz</th><th className="px-5 py-3"></th></tr></thead>
            <tbody>
              {scopedPrograms.map(p => { const apps4 = apps.filter(a => PROG_appIds(a).includes(p.id)).length; return (
                <tr key={p.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <td className="px-5 py-3"><div className="flex items-center gap-3"><div className="w-12 h-9 rounded-lg overflow-hidden flex-none"><PROG_Banner program={p} className="h-full w-full" /></div><div><div className="font-bold text-slate-700">{p.name}</div><div className="text-[11px] text-slate-400">{p.faculty}{apps4 ? ' · ' + apps4 + ' jelentkező' : ''}</div></div></div></td>
                  <td className="px-5 py-3"><UBadge tone={PROG_LEVEL_TONE[p.level]}>{p.degree}</UBadge></td>
                  {isDeg && <td className="px-5 py-3 text-[12px] font-bold text-violet-600 whitespace-nowrap">{PROG_intakesOf(p).map(k => PROG_INTAKES[k]).join(' · ')}</td>}
                  <td className="px-5 py-3 font-black text-slate-700">{DL_money(p.tuition)}</td>
                  <td className="px-5 py-3 text-[12px] font-bold text-slate-400">{(p.steps || []).length + ' lépés'}</td>
                  <td className="px-5 py-3 text-[12px] font-semibold text-slate-500">{DL_date(p.deadline)}</td>
                  <td className="px-5 py-3">{p.is_open ? <UBadge tone="green">Nyitva</UBadge> : <UBadge tone="red">Lezárva</UBadge>}</td>
                  <td className="px-5 py-3 text-right"><div className="flex items-center gap-1 justify-end"><button disabled={!jog.edit} onClick={() => dlUpdate(PROG_TABLE, p.id, { is_open: !p.is_open }, PROG_LS)
                      .then(refetch)
                      .catch(e => alert((e && e.message) || 'A módosítás nem sikerült.'))} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center disabled:opacity-40" title={p.is_open ? 'Jelentkezés lezárása' : 'Jelentkezés megnyitása'}>{p.is_open ? <Lucide.Lock size={15} /> : <Lucide.LockOpen size={15} />}</button><button disabled={!jog.edit} onClick={() => setEditor({ open: true, program: p })} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center disabled:opacity-40" title="Szerkesztés"><Lucide.Pencil size={15} /></button></div></td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}

      {staff && tab === 'applicants' && <PROG_Applicants programs={scopedPrograms} apps={scopedApps} onChange={refetch} />}

      <PROG_Detail program={detail} myApp={detail ? myApps.find(a => PROG_appIds(a).includes(detail.id)) : null} onClose={() => setDetail(null)} onApply={isDeg ? (x) => startDegreeApply([x.id], felev) : openApply} />
      <PROG_Editor user={user} open={editor.open && (editor.program ? jog.edit : jog.create)} program={editor.program} scope={scope} onClose={() => setEditor({ open: false, program: null })} onSaved={refetch} />
    </div>
  );
};
