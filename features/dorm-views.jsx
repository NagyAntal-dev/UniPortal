/* ============================================================
   UniPortal — Kollégium- és ingatlanüzemeltetési modul
   "Karbantartás" (DORM_MAINTENANCE) és "Szállásom" (DORM_STUDENT)
   ------------------------------------------------------------
   Ez a fájl az app.jsx moduljába van fűzve (build.mjs), a
   features/dorm.jsx UTÁN. NINCS import: a React, a hookok, a Lucide,
   a window.sb, a U* atomok és a DORM_* közös réteg a scope-ban vannak.

   AMIT EZ A FÁJL NEM DEFINIÁL (a dorm.jsx adja, egy modul-scope):
     DORM_rpc, DORM_api, DORM_Tabs, DORM_Stat, DORM_Empty, DORM_Hidden
   Ezeket itt csak HASZNÁLJUK. A DORMV_* burkolók azért vannak, mert a
   két fájl párhuzamosan készül: ha a közös komponens jelen van, azt
   rendereljük, ha nem, a burkoló saját, azonos szemantikájú markupot ad —
   így egyik fájl sem tudja megbuktatni a másik build-jét.

   HÁROM KÖVETELMÉNY, AMI VÉGIGMEGY AZ EGÉSZ FÁJLON
   ------------------------------------------------------------
   1. ADATVÉDELEM. A "ki hol lakik" a modul legérzékenyebb adata. A
      dorm_open_issues() RPC SZÁNDÉKOSAN nem ad vissza lakónevet: a
      hibajegy a SZOBÁRA hivatkozik, nem a lakóra. Ahol a név hiányzik,
      NEM üres cellát mutatunk, hanem a DORM_Hidden-nel megmondjuk, hogy
      adatvédelmi okból rejtett. A felület sehol nem próbálja megkerülni
      az adatbázis szűrését — ha egy lekérdezés üresen jön vissza, az a
      helyes viselkedés, nem hiba.
   2. RESZPONZIVITÁS ELEVE. Minden táblázat saját overflow-x-auto
      konténerben ül, a lap törzse soha nem görög vízszintesen; a sok
      oszlopos listák sm alatt kártyára váltanak; az érintési célpontok
      44 px-esek; a fülsáv kis kijelzőn vízszintesen görgethető.
   3. A HIBABEJELENTŐ MOBIL-FIRST. Ez az egyetlen nézet, amit a lakó
      nagy eséllyel telefonról használ: egy kérdés – egy döntés ritmus,
      nagy célpontok, a képernyő alján rögzített elsődleges gomb.
   ============================================================ */

/* ---------- 0. Burkolók a dorm.jsx közös komponenseihez -------------------- */

const DORMV_Ic = ({ n, size = 16, className = '' }) => {
  const C = (Lucide && Lucide[n]) || Lucide.Circle;
  return <C size={size} className={className} />;
};

/* Fülsáv. Kis kijelzőn vízszintesen görgethető, sm felett tördelt — a
   fülsáv soha nem lóghat ki, és nem viheti vízszintes görgetésbe a lapot. */
function DORMV_Tabs({ tabs, tab, setTab }) {
  if (typeof DORM_Tabs !== 'undefined') {
    // Több elnevezési konvenciót is kiszolgálunk: a közös komponens
    // szignatúrája a másik munkacsomagban dől el.
    return (
      <DORM_Tabs
        tabs={tabs} items={tabs} options={tabs}
        tab={tab} active={tab} value={tab} current={tab}
        setTab={setTab} onChange={setTab} onSelect={setTab} onTab={setTab}
      />
    );
  }
  return (
    <div className="flex gap-2 mb-6 overflow-x-auto sm:flex-wrap sm:overflow-visible -mx-1 px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map(t => {
        const on = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={'flex-none inline-flex items-center gap-2 rounded-2xl px-4 min-h-[44px] text-sm font-black whitespace-nowrap transition-all ' +
              (on ? 'bg-primary text-white shadow-lg shadow-primary/10'
                  : 'bg-white border border-slate-100 text-slate-500 hover:text-slate-800 hover:border-slate-200')}>
            <DORMV_Ic n={t.icon} size={15} /> {t.label}
            {t.count != null && (
              <span className={'ml-0.5 text-[11px] font-black ' + (on ? 'text-white/70' : 'text-slate-400')}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function DORMV_Stat({ label, value, hint, icon, tone = 'slate' }) {
  if (typeof DORM_Stat !== 'undefined') {
    return <DORM_Stat label={label} title={label} value={value} hint={hint} sub={hint} icon={icon} tone={tone} />;
  }
  const tones = {
    slate: 'text-slate-900', red: 'text-red-600', amber: 'text-amber-600',
    green: 'text-emerald-600', violet: 'text-violet-600', primary: 'text-primary',
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 min-w-0">
      <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">
        {icon && <DORMV_Ic n={icon} size={13} />} <span className="truncate">{label}</span>
      </div>
      <div className={'text-2xl font-black mt-1 tabular-nums ' + (tones[tone] || tones.slate)}>{value}</div>
      {hint && <div className="text-[11px] text-slate-400 font-medium mt-0.5 leading-snug">{hint}</div>}
    </div>
  );
}

function DORMV_Empty({ icon, title, subtitle, action }) {
  if (typeof DORM_Empty !== 'undefined') {
    return <DORM_Empty icon={icon} title={title} subtitle={subtitle} text={subtitle} action={action} />;
  }
  return (
    <div className="bg-white rounded-3xl border border-slate-100 py-14 px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-slate-50 text-slate-300 flex items-center justify-center mx-auto mb-4">
        <DORMV_Ic n={icon || 'Inbox'} size={26} />
      </div>
      <p className="font-black text-slate-700">{title}</p>
      {subtitle && <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto leading-relaxed">{subtitle}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/* Adatvédelmi okból rejtett mező. Ez a komponens a modul egyik lényege:
   ahol nincs név, ott NEM üres helyet mutatunk — kimondjuk, miért nincs. */
function DORMV_Hidden({ label, reason }) {
  if (typeof DORM_Hidden !== 'undefined') {
    return <DORM_Hidden label={label} field={label} reason={reason} title={reason} />;
  }
  return (
    <span
      title={reason || 'Adatvédelmi okból rejtett'}
      className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-2 py-1">
      <DORMV_Ic n="EyeOff" size={12} />
      {label ? label + ': rejtve' : 'Adatvédelmi okból rejtett'}
    </span>
  );
}

/* ---------- 1. Adathozzáférés --------------------------------------------- */

/* A `dorm` séma KITETT (26_dorm.sql, 3. szerkezeti döntés), tehát a táblák
   közvetlenül is olvashatók, RLS mögül. A 13 public RPC ezért kényelmi és
   aggregáló réteg, nem az egyetlen út befelé — a fülek nagy része olyan
   táblát olvas, amire nincs (és nem is kell) külön RPC. */
function DORMV_db() {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  return window.sb.schema ? window.sb.schema('dorm') : window.sb;
}

/* Egységes olvasás: sose dobjon a renderbe, a hibaüzenet is magyar legyen.
   Az ÜRES találat gyakran HELYES válasz (RLS szűrt), nem hiba — ezt a hívó
   dönti el, ezért adjuk vissza külön a sorokat és a hibát. */
async function DORMV_sel(table, build) {
  try {
    let q = DORMV_db().from(table).select('*');
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) return { rows: [], error: DORMV_msg(error) };
    return { rows: Array.isArray(data) ? data : [], error: '' };
  } catch (e) {
    return { rows: [], error: DORMV_msg(e) };
  }
}

async function DORMV_update(table, id, patch) {
  const { data, error } = await DORMV_db().from(table).update(patch).eq('id', id).select();
  if (error) throw new Error(DORMV_msg(error));
  return (data && data[0]) || null;
}

async function DORMV_insert(table, row) {
  const { data, error } = await DORMV_db().from(table).insert(row).select();
  if (error) throw new Error(DORMV_msg(error));
  return (data && data[0]) || null;
}

/* Az adatbázis beszédes hibákat dob (DORM_FORBIDDEN, DORM_ISSUE_STATUS_INVALID,
   DORM_CATEGORY_UNKNOWN…). Ezeket emberi mondatra fordítjuk, de a nyers
   üzenetet nem dobjuk el: a hibakeresés enélkül vakrepülés. */
function DORMV_msg(e) {
  const raw = (e && (e.message || e.error_description || e.details)) || String(e || '');
  if (/DORM_FORBIDDEN/i.test(raw)) return 'Ehhez nincs jogosultságod. A kollégiumi szerepkört a rendszergazda adja ki.';
  if (/DORM_ISSUE_STATUS_INVALID/i.test(raw)) return 'Ez az állapotváltás nem megengedett. Válassz a felkínált állapotok közül.';
  if (/DORM_CATEGORY_UNKNOWN/i.test(raw)) return 'Ismeretlen hibakategória.';
  if (/DORM_NO_LOCATION|helyszin/i.test(raw)) return 'A bejelentéshez meg kell adni a helyszínt (szoba vagy épület).';
  if (/row-level security|permission denied/i.test(raw)) return 'Az adatbázis nem engedte a műveletet — a szerepköröd erre nem terjed ki.';
  if (/Failed to fetch|NetworkError/i.test(raw)) return 'Nincs kapcsolat a szerverrel.';
  return raw || 'Ismeretlen hiba.';
}

/* ---------- 2. Katalógus-címkék és formázás -------------------------------- */

const DORMV_PRIO = {
  P1: { label: 'P1 · életveszély',  cls: 'bg-red-50 text-red-700 border-red-200',        dot: 'bg-red-500',     tone: 'red' },
  P2: { label: 'P2 · lakhatatlan',  cls: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500', tone: 'amber' },
  P3: { label: 'P3 · akadályozó',   cls: 'bg-sky-50 text-sky-700 border-sky-200',        dot: 'bg-sky-500',     tone: 'slate' },
  P4: { label: 'P4 · ütemezett',    cls: 'bg-slate-50 text-slate-600 border-slate-200',  dot: 'bg-slate-400',   tone: 'slate' },
};
const DORMV_prio = (p) => DORMV_PRIO[p] || DORMV_PRIO.P3;

const DORMV_LIABLE = {
  UNIVERSITY: 'Egyetem', LANDLORD: 'Bérbeadó', RESIDENT: 'Kollégista',
  SERVICE_CONTRACT: 'Szolgáltatói szerződés', INSURANCE: 'Biztosító',
};
const DORMV_ROUTE = {
  INTERNAL_MAINT: 'Belső karbantartás', LANDLORD_TICKET: 'Bérbeadói bejelentés',
  EXTERNAL_VENDOR: 'Külsős szolgáltató', HOUSE_MANAGER: 'Gondnok',
  IT_HELPDESK: 'IT ügyfélszolgálat', DORM_ADMIN: 'Kollégiumi ügyintéző',
};
const DORMV_SOURCE_LEVEL = {
  BUILDING: 'épület-szintű sor', TENURE: 'jogcím-szintű alapértelmezés', GLOBAL: 'globális alapértelmezés',
};
const DORMV_TENURE = {
  OWNED: 'Saját tulajdon', OWNED_OUT_OF_USE: 'Saját, nem hasznosított',
  LEASED_WHOLE: 'Teljes épület bérlete', LEASED_PARTIAL: 'Részleges bérlet',
  CONTRACTED_CAPACITY: 'Szerződött férőhely', MANAGED_FOR_OTHER: 'Idegen tulajdon, mi üzemeltetjük',
};
/* Ami NEM saját tulajdon: ott van bérbeadói szál, felelősségi vita és
   szerződéspont. A modul napi haszna ezeken az épületeken keletkezik. */
const DORMV_isLeased = (tenure) => !!tenure && tenure !== 'OWNED' && tenure !== 'OWNED_OUT_OF_USE';

const DORMV_IMPACT = [
  { v: 'NONE',          label: 'Nem akadályoz',            hint: 'Kellemetlen, de használható a szoba' },
  { v: 'ONE_BED',       label: 'Egy férőhelyet érint',      hint: 'Egy ágy nem használható' },
  { v: 'ROOM_UNUSABLE', label: 'A szoba lakhatatlan',       hint: 'Itt most nem lehet aludni' },
  { v: 'MULTI_ROOM',    label: 'Több szobát érint',         hint: 'Pl. folyosószakasz, közös vizesblokk' },
  { v: 'BUILDING',      label: 'Az egész épületet érinti',  hint: 'Pl. nincs fűtés vagy melegvíz sehol' },
  { v: 'SAFETY',        label: 'Balesetveszélyes',          hint: 'Gázszag, áramütés-veszély, leszakadás' },
];

const DORMV_WORK_KIND = { MATERIAL: 'Anyag', LABOUR: 'Munkaóra', EXTERNAL_INVOICE: 'Külsős számla', OTHER: 'Egyéb' };
const DORMV_PM_RESP = {
  UNIVERSITY: 'Egyetem', LANDLORD: 'Bérbeadó',
  SERVICE_CONTRACT: 'Szolgáltatói szerződés', EXTERNAL_VENDOR: 'Külsős szolgáltató',
};
const DORMV_PM_RESULT = {
  OK: 'Rendben', WITH_FINDINGS: 'Hiányossággal', FAILED: 'Nem felelt meg', NOT_ACCESSIBLE: 'Nem volt hozzáférhető',
};
const DORMV_COND = {
  1: 'Új / kifogástalan', 2: 'Jó', 3: 'Elfogadható', 4: 'Rossz', 5: 'Selejtezendő',
};
const DORMV_FEE_TYPE = {
  DORM_FEE_MONTHLY: 'Kollégiumi díj (havi)', DORM_FEE_SEMESTER: 'Kollégiumi díj (féléves)',
  DEPOSIT: 'Kaució', KEY_REPLACEMENT: 'Kulcspótlás', LATE_FEE: 'Késedelmi díj',
  CLEANING_PENALTY: 'Takarítási kötbér', GUEST_NIGHT: 'Vendégéjszaka',
  DAMAGE: 'Kártérítés', UTILITY_REBILL: 'Rezsi-továbbszámlázás',
};
const DORMV_CHARGE_STATUS = {
  planned:        { label: 'Tervezett',      cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  due:            { label: 'Esedékes',       cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  invoiced:       { label: 'Kiszámlázva',    cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  paid:           { label: 'Befizetve',      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  partially_paid: { label: 'Részben fizetve', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  waived:         { label: 'Elengedve',      cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  written_off:    { label: 'Leírva',         cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  refunded:       { label: 'Visszatérítve',  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};
const DORMV_DEPOSIT_STATUS = {
  HELD: 'Letétben', PARTIALLY_SETTLED: 'Részben elszámolva', SETTLED: 'Elszámolva',
  REFUNDED: 'Visszafizetve', FORFEITED: 'Elveszett', OVERDUE: 'Késedelmes',
};
const DORMV_CONTRACT_KIND = {
  FULL_YEAR: 'Teljes tanév', SEMESTER: 'Egy félév', SHORT_STAY: 'Rövid tartózkodás',
  SUMMER: 'Nyári', ROLLING: 'Folyamatos',
};
const DORMV_OCC_STATE = {
  ALLOCATED: 'Kiosztva', MOVED_IN: 'Beköltözve', MOVED_OUT: 'Kiköltözve', CANCELLED: 'Visszavonva',
};
const DORMV_BATHROOM = { PRIVATE: 'Saját fürdő', SHARED_UNIT: 'Lakóegységen belül közös', SHARED_FLOOR: 'Emeleti közös', NONE: 'Nincs' };
const DORMV_KITCHEN = { PRIVATE: 'Saját konyha', KITCHENETTE: 'Teakonyha', SHARED_UNIT: 'Lakóegységen belül közös', SHARED_FLOOR: 'Emeleti közös', NONE: 'Nincs' };

/* --- formázók (magyar) --- */
const DORMV_d = (v) => {
  if (!v) return '—';
  const d = new Date(v); if (isNaN(d)) return String(v).slice(0, 10);
  return d.toLocaleDateString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit' });
};
const DORMV_dt = (v) => {
  if (!v) return '—';
  const d = new Date(v); if (isNaN(d)) return String(v).slice(0, 16);
  return d.toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const DORMV_huf = (n, cur = 'HUF') => {
  if (n == null || n === '') return '—';
  try { return new Intl.NumberFormat('hu-HU', { style: 'currency', currency: cur || 'HUF', maximumFractionDigits: 0 }).format(Number(n)); }
  catch (e) { return Number(n).toLocaleString('hu-HU') + ' ' + (cur || 'HUF'); }
};
const DORMV_num = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('hu-HU'));
/* Hány nap van hátra? Negatív = lejárt. A "0 nap" külön eset: ma esedékes. */
const DORMV_daysTo = (v) => {
  if (!v) return null;
  const d = new Date(v); if (isNaN(d)) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 86400000);
};
const DORMV_dueText = (v) => {
  const n = DORMV_daysTo(v);
  if (n == null) return 'nincs határidő';
  if (n < 0) return Math.abs(n) + ' napja lejárt';
  if (n === 0) return 'ma esedékes';
  return n + ' nap múlva';
};

/* Storage: a hibabejelentés fotói privát bucketbe kerülnek, a lista CSAK az
   elérési utat és a darabszámot hozza (a 09-es migráció mérése: egy beágyazott
   dokumentumokat is cipelő listalekérdezés 12,5 MB / 3,6 mp volt). */
const DORMV_BUCKETS = ['dorm-photos', 'documents'];

function DORMV_safeName(name) {
  return String(name || 'kep')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_').slice(-70);
}

async function DORMV_uploadPhotos(files, prefix) {
  const out = [];
  if (!files || !files.length || !window.sb) return out;
  for (const f of files) {
    // Fotótár: csak valódi kép mehet fel. A típust a böngésző mondja, ezért
    // itt is szűrünk (a tároló oldalán a 69-es migráció zárja le).
    const kepTipus = FELT_kepTipus(f);
    if (!kepTipus) continue;
    const path = [prefix || 'dorm', Date.now().toString(36) + '-' + DORMV_safeName(f.name)].join('/');
    let stored = null;
    for (const bucket of DORMV_BUCKETS) {
      try {
        const { error } = await window.sb.storage.from(bucket).upload(path, f, {
          upsert: true, contentType: kepTipus,
        });
        if (!error) { stored = { bucket, path }; break; }
      } catch (e) { /* következő bucket */ }
    }
    if (stored) out.push({ ...stored, name: f.name, size: f.size, type: kepTipus });
  }
  return out;
}

const DORMV_URL_CACHE = new Map();
async function DORMV_photoUrl(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') entry = { path: entry };
  if (entry.url) return entry.url;
  if (!entry.path || !window.sb) return '';
  const key = (entry.bucket || '?') + '|' + entry.path;
  const hit = DORMV_URL_CACHE.get(key);
  if (hit && hit.until > Date.now()) return hit.url;
  for (const bucket of (entry.bucket ? [entry.bucket] : DORMV_BUCKETS)) {
    try {
      const { data, error } = await window.sb.storage.from(bucket).createSignedUrl(entry.path, 3600);
      if (!error && data && data.signedUrl) {
        DORMV_URL_CACHE.set(key, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
        return data.signedUrl;
      }
    } catch (e) { /* következő bucket */ }
  }
  return '';
}

/* A photos jsonb alakja a bejelentés forrásától függ (tömb objektumokkal vagy
   sima útvonalakkal) — normalizáljuk, hogy a nézetnek egy alakja legyen. */
function DORMV_photoList(photos) {
  if (!photos) return [];
  let arr = photos;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { return []; } }
  if (!Array.isArray(arr)) arr = arr && Array.isArray(arr.items) ? arr.items : [];
  return arr.map(x => (typeof x === 'string' ? { path: x, name: x.split('/').pop() } : x)).filter(Boolean);
}

function DORMV_Photos({ photos, compact }) {
  const list = DORMV_photoList(photos);
  const [urls, setUrls] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = [];
      for (const p of list) res.push({ p, url: await DORMV_photoUrl(p) });
      if (alive) setUrls(res);
    })();
    return () => { alive = false; };
  }, [JSON.stringify(list)]);

  if (!list.length) return <span className="text-sm text-slate-400">Nincs fotó</span>;
  return (
    <div className={'grid gap-2 ' + (compact ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4')}>
      {urls.map((u, i) => (
        u.url ? (
          <a key={i} href={u.url} target="_blank" rel="noreferrer"
             className="block rounded-xl overflow-hidden border border-slate-100 bg-slate-50 aspect-[4/3]">
            <img src={u.url} alt={u.p.name || 'fotó'} className="w-full h-full object-cover" loading="lazy" />
          </a>
        ) : (
          <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 aspect-[4/3] flex flex-col items-center justify-center text-slate-300 p-2">
            <DORMV_Ic n="ImageOff" size={18} />
            <span className="text-[10px] font-bold mt-1 text-center break-all">{u.p.name || 'fotó'}</span>
          </div>
        )
      ))}
    </div>
  );
}

/* ---------- 3. Apró, közösen használt megjelenítők ------------------------- */

function DORMV_Chip({ children, cls = 'bg-slate-50 text-slate-600 border-slate-200', icon }) {
  return (
    <span className={'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-black border whitespace-nowrap ' + cls}>
      {icon && <DORMV_Ic n={icon} size={11} />} {children}
    </span>
  );
}

function DORMV_PrioChip({ p }) {
  const s = DORMV_prio(p);
  return <span className={'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-black border whitespace-nowrap ' + s.cls}>
    <span className={'w-1.5 h-1.5 rounded-full ' + s.dot} /> {s.label}
  </span>;
}

function DORMV_TenureChip({ tenure }) {
  if (!tenure) return null;
  const leased = DORMV_isLeased(tenure);
  return (
    <DORMV_Chip icon={leased ? 'Building2' : 'Home'}
      cls={leased ? 'bg-violet-50 text-violet-700 border-violet-200' : 'bg-slate-50 text-slate-500 border-slate-200'}>
      {leased ? 'Bérlemény' : 'Saját'}
    </DORMV_Chip>
  );
}

function DORMV_Err({ msg, onClose }) {
  if (!msg) return null;
  return (
    <div className="mb-5 flex items-start gap-3 text-sm font-semibold text-red-700 bg-red-50 border border-red-100 rounded-2xl px-4 py-3">
      <DORMV_Ic n="AlertCircle" size={16} className="mt-0.5 flex-none" />
      <span className="min-w-0 break-words">{msg}</span>
      {onClose && <button onClick={onClose} className="ml-auto flex-none text-red-400 hover:text-red-700"><DORMV_Ic n="X" size={15} /></button>}
    </div>
  );
}

function DORMV_Loading({ text = 'Betöltés…' }) {
  return (
    <div className="p-8 flex items-center gap-3 text-slate-400">
      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      {text}
    </div>
  );
}

/* Címke-érték pár. Mobilon egymás alatt, nagyobb kijelzőn rácsban. */
function DORMV_KV({ label, children, wide }) {
  return (
    <div className={'min-w-0 ' + (wide ? 'sm:col-span-2' : '')}>
      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</div>
      <div className="text-sm font-bold text-slate-800 mt-0.5 break-words">{children == null || children === '' ? '—' : children}</div>
    </div>
  );
}

/* Épületválasztó. Egyetlen helyen definiálva, mert mind a négy karbantartási
   fül ugyanazt a hatókört használja. */
function DORMV_BuildingPicker({ buildings, value, onChange }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="min-h-[44px] w-full sm:w-auto bg-white border border-slate-200 rounded-xl px-3 text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20">
      <option value="">Minden épület</option>
      {buildings.map(b => (
        <option key={b.id} value={b.id}>
          {(b.code ? b.code + ' · ' : '') + (b.name || '')}{DORMV_isLeased(b.tenure) ? ' (bérlemény)' : ''}
        </option>
      ))}
    </select>
  );
}

/* ============================================================
   4. FELELŐSSÉGI MÁTRIX — a modul lényege bérelt épületnél
   ------------------------------------------------------------
   A dorm.responsibility HÁROM szinten él: épület → jogcím → globális, és a
   szűkebb szint FELÜLÍRJA a tágabbat (26_dorm.sql, dorm.resolve_responsibility).
   A táblát minden bejelentkezett felhasználó olvashatja — szándékosan: a lakó
   is lássa, hova megy a bejelentése és mi a határidő.

   Miért oldjuk fel itt is, kliensoldalon, ha az adatbázisban is megvan?
   Mert a MEGLÉVŐ jegyeken a felelősség be van fagyasztva a rögzítés
   pillanatára (liable_party_initial / _final, contract_clause) — a mátrix
   viszont időközben változhatott. A munkalapon MINDKETTŐT mutatjuk: mi van
   a jegyen, és mit mond ma a mátrix. A kettő eltérése önmagában információ.
   ============================================================ */

function DORMV_resolveResp(rows, buildingId, tenure, category) {
  if (!Array.isArray(rows)) return null;
  const forCat = rows.filter(r => r.category_code === category);
  const byBuilding = forCat.find(r => r.building_id && r.building_id === buildingId);
  if (byBuilding) return { ...byBuilding, source: 'BUILDING' };
  const byTenure = forCat.find(r => !r.building_id && r.tenure && r.tenure === tenure);
  if (byTenure) return { ...byTenure, source: 'TENURE' };
  const global = forCat.find(r => !r.building_id && !r.tenure);
  if (global) return { ...global, source: 'GLOBAL' };
  return null;
}

/* A bérbeadói szál doboza. Vizuálisan KIEMELT (ibolya keret, saját fejléc):
   a bérelt épület az a hely, ahol a rossz döntés pénzbe kerül — kifizetünk
   valamit, ami szerződés szerint a bérbeadóé. */
function DORMV_LandlordPanel({ issue, resp, landlord, onNotify, busy }) {
  const clause = issue.contract_clause || (resp && resp.contract_clause);
  const liable = issue.liable_party_final || issue.liable_party_initial || (resp && resp.liable_party);
  const route = issue.route || (resp && resp.route);
  const drift = resp && liable && resp.liable_party && resp.liable_party !== liable;

  return (
    <div className="mt-4 rounded-2xl border-2 border-violet-200 bg-violet-50/60 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-violet-100/70 border-b border-violet-200">
        <DORMV_Ic n="Building2" size={16} className="text-violet-700" />
        <span className="text-[11px] font-black text-violet-900 uppercase tracking-widest">Bérelt épület · bérbeadói szál</span>
        {issue.substitute_repair && (
          <DORMV_Chip icon="Hammer" cls="bg-white text-violet-800 border-violet-300">Helyettesítő javítás — beszámítandó</DORMV_Chip>
        )}
      </div>

      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <DORMV_KV label="Felelős">{DORMV_LIABLE[liable] || liable || '—'}</DORMV_KV>
        <DORMV_KV label="Útvonal">{DORMV_ROUTE[route] || route || '—'}</DORMV_KV>
        <DORMV_KV label="Költségviselő">{DORMV_LIABLE[issue.cost_bearer] || (resp && DORMV_LIABLE[resp.cost_bearer]) || '—'}</DORMV_KV>
        <DORMV_KV label="Határidő">
          <span className={issue.due_at && new Date(issue.due_at) < new Date() ? 'text-red-600' : ''}>
            {DORMV_dt(issue.due_at)}{issue.due_at ? ' · ' + DORMV_dueText(issue.due_at) : ''}
          </span>
        </DORMV_KV>
        <DORMV_KV label="Eszkaláció">{DORMV_dt(issue.escalate_at)}</DORMV_KV>
        <DORMV_KV label="Mátrix szintje">
          {DORMV_SOURCE_LEVEL[issue.responsibility_source || (resp && resp.source)] || '—'}
        </DORMV_KV>
        <DORMV_KV label="Szerződéspont" wide>
          {clause ? <span className="font-mono text-[13px] bg-white border border-violet-200 rounded-lg px-2 py-1 inline-block">{clause}</span> : 'a szerződés nem nevesíti'}
        </DORMV_KV>
        <DORMV_KV label="Bérbeadói kapcsolat">
          {(resp && resp.contact_name) || (landlord && landlord.name) || '—'}
          {(resp && resp.contact_phone) || (landlord && (landlord.duty_phone || landlord.phone)) ? (
            <a className="block text-primary font-black mt-1"
               href={'tel:' + ((resp && resp.contact_phone) || landlord.duty_phone || landlord.phone)}>
              <DORMV_Ic n="Phone" size={12} /> {(resp && resp.contact_phone) || landlord.duty_phone || landlord.phone}
            </a>
          ) : null}
        </DORMV_KV>
      </div>

      {drift && (
        <div className="mx-4 mb-4 text-[12px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2">
          <DORMV_Ic n="Info" size={13} className="mt-0.5 flex-none" />
          <span>
            A jegyen rögzített felelős <b>{DORMV_LIABLE[liable] || liable}</b>, a mátrix ma
            <b> {DORMV_LIABLE[resp.liable_party] || resp.liable_party}</b>-t mond. A jegyen a
            rögzítéskori állapot marad — ez a kártérítési vita bizonyítéka.
          </span>
        </div>
      )}

      <div className="px-4 pb-4 flex flex-wrap items-center gap-3">
        {issue.landlord_notified_at ? (
          <DORMV_Chip icon="CheckCircle2" cls="bg-emerald-50 text-emerald-700 border-emerald-200">
            Bejelentve a bérbeadónak: {DORMV_dt(issue.landlord_notified_at)}
            {issue.landlord_ticket_ref ? ' · ' + issue.landlord_ticket_ref : ''}
          </DORMV_Chip>
        ) : (
          <>
            <DORMV_Chip icon="Clock" cls="bg-white text-slate-500 border-slate-200">Még nincs bérbeadói bejelentés</DORMV_Chip>
            {onNotify && (
              <button disabled={busy} onClick={onNotify}
                className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl text-sm font-black bg-violet-700 text-white hover:bg-violet-800 disabled:opacity-50">
                <DORMV_Ic n="Send" size={15} /> Bejelentve a bérbeadónak
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   5. HIBAJEGY RÉSZLETEI — a Bejelentések és a Munkalapok közös modálja
   ------------------------------------------------------------
   A LAKÓ NEVE ITT SEM JELENIK MEG. A dorm_open_issues() nem is adja vissza,
   a dorm.issue.reporter_name/-phone pedig csak akkor tárolódik, ha a bejelentő
   maga hozzájárult (dorm.issue_contact_mask trigger). Ahol nincs adat, a
   DORM_Hidden mondja meg, hogy ez adatvédelmi döntés, nem hiányzó mező.
   ============================================================ */

function DORMV_IssueModal({ ticketNo, buildings, respRows, landlords, onClose, onChanged, canWrite }) {
  const [issue, setIssue] = useState(null);
  const [events, setEvents] = useState([]);
  const [costs, setCosts] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const a = await DORMV_sel('issue', q => q.eq('ticket_no', ticketNo).limit(1));
    if (a.error) { setErr(a.error); setIssue(false); return; }
    const row = a.rows[0] || null;
    setIssue(row || false);
    if (!row) return;
    const [ev, wc] = await Promise.all([
      DORMV_sel('issue_event', q => q.eq('issue_id', row.id).order('happened_at', { ascending: false }).limit(50)),
      DORMV_sel('work_cost', q => q.eq('issue_id', row.id).order('created_at', { ascending: false })),
    ]);
    setEvents(ev.rows); setCosts(wc.rows);
  };
  useEffect(() => { setIssue(null); load(); }, [ticketNo]);

  const building = issue && buildings.find(b => b.id === issue.building_id);
  const tenure = building && building.tenure;
  const resp = issue && DORMV_resolveResp(respRows, issue.building_id, tenure, issue.category_code);
  const landlord = building && landlords.find(l => l.id === building.landlord_id);

  const notifyLandlord = async () => {
    const ref = window.prompt('A bérbeadó ügyszáma / hivatkozása (ha van):', issue.landlord_ticket_ref || '');
    if (ref === null) return;
    setBusy(true); setErr('');
    try {
      await DORMV_update('issue', issue.id, {
        landlord_notified_at: new Date().toISOString(),
        landlord_ticket_ref: ref || null,
      });
      // Az állapotváltást külön kíséreljük meg: az átmenettáblát az adatbázis
      // őrzi, és a jelenlegi állapotból nem biztos, hogy megengedett.
      try { await DORMV_update('issue', issue.id, { status: 'WAITING_LANDLORD' }); } catch (e) { /* marad a jelenlegi állapot */ }
      await load(); onChanged && onChanged();
    } catch (e) { setErr(DORMV_msg(e)); }
    finally { setBusy(false); }
  };

  const costSum = costs.reduce((s, c) => s + Number(c.amount || 0), 0);

  return (
    <UModal open onClose={onClose} max="max-w-3xl"
      title={issue ? (issue.ticket_no + ' · ' + issue.title) : 'Hibajegy'}
      subtitle={issue ? (building ? (building.code + ' · ') : '') + 'Bejelentve: ' + DORMV_dt(issue.created_at) : ticketNo}
      icon={<DORMV_Ic n="AlertTriangle" size={20} />}>
      <DORMV_Err msg={err} onClose={() => setErr('')} />
      {issue === null && <DORMV_Loading text="Hibajegy betöltése…" />}
      {issue === false && (
        <DORMV_Empty icon="SearchX" title="A hibajegy nem érhető el"
          subtitle="Vagy időközben lezárták, vagy a szerepköröd nem terjed ki erre az épületre." />
      )}
      {issue && (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <DORMV_PrioChip p={issue.priority} />
            <DORMV_TenureChip tenure={tenure} />
            {issue.is_chronic && (
              <DORMV_Chip icon="Repeat" cls="bg-red-50 text-red-700 border-red-200">
                Krónikus hiba — 90 napon belül a 3. jegy
              </DORMV_Chip>
            )}
            {issue.needs_triage && <DORMV_Chip icon="Search" cls="bg-amber-50 text-amber-700 border-amber-200">Megállapítás szükséges</DORMV_Chip>}
            {issue.entry_permitted
              ? <DORMV_Chip icon="KeyRound" cls="bg-emerald-50 text-emerald-700 border-emerald-200">Belépés engedélyezve távollétben</DORMV_Chip>
              : <DORMV_Chip icon="Lock">Belépés csak a kollégista jelenlétében</DORMV_Chip>}
          </div>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <DORMV_KV label="Épület">{building ? building.name : '—'}</DORMV_KV>
            <DORMV_KV label="Kategória">{issue.category_code}</DORMV_KV>
            <DORMV_KV label="Állapot">{issue.status}</DORMV_KV>
            <DORMV_KV label="Hatás">{(DORMV_IMPACT.find(i => i.v === issue.impact) || {}).label || issue.impact}</DORMV_KV>
            <DORMV_KV label="Határidő">
              <span className={issue.due_at && new Date(issue.due_at) < new Date() ? 'text-red-600' : ''}>{DORMV_dt(issue.due_at)}</span>
            </DORMV_KV>
            <DORMV_KV label="Munkaóra">{issue.work_hours == null ? '—' : DORMV_num(issue.work_hours) + ' óra'}</DORMV_KV>
          </div>

          <div className="mt-5">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Leírás</div>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap break-words">
              {issue.description || 'A bejelentő nem adott meg leírást.'}
            </p>
          </div>

          <div className="mt-5">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Fotók</div>
            <DORMV_Photos photos={issue.photos} />
          </div>

          {/* Bejelentő: NÉV CSAK HOZZÁJÁRULÁSSAL. Ez nem képernyő-elrejtés:
              ha nincs hozzájárulás, az adat el sem jut a felületig. */}
          <div className="mt-5">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Bejelentő elérhetősége</div>
            {issue.contact_ok && (issue.reporter_name || issue.reporter_phone) ? (
              <div className="text-sm font-bold text-slate-800">
                {issue.reporter_name || '—'}
                {issue.reporter_phone && <a href={'tel:' + issue.reporter_phone} className="block text-primary mt-0.5">{issue.reporter_phone}</a>}
              </div>
            ) : (
              <DORMV_Hidden label="Bejelentő"
                reason="A bejelentő nem járult hozzá az elérhetősége továbbadásához, ezért a rendszer nem is tárolta. A hibajegy a szobára hivatkozik, nem a lakóra." />
            )}
          </div>

          {DORMV_isLeased(tenure) && (
            <DORMV_LandlordPanel issue={issue} resp={resp} landlord={landlord} busy={busy}
              onNotify={canWrite ? notifyLandlord : null} />
          )}

          {costs.length > 0 && (
            <div className="mt-5">
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
                Költségtételek · összesen {DORMV_huf(costSum, costs[0].currency)}
              </div>
              <div className="overflow-x-auto rounded-2xl border border-slate-100">
                <table className="w-full min-w-[520px]">
                  <thead>
                    <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                      <th className="text-left px-3 py-2">Típus</th>
                      <th className="text-left px-3 py-2">Megnevezés</th>
                      <th className="text-right px-3 py-2">Összeg</th>
                      <th className="text-left px-3 py-2">Terhére</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costs.map(c => (
                      <tr key={c.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-3 py-2 text-[13px] font-bold text-slate-700">{DORMV_WORK_KIND[c.kind] || c.kind}</td>
                        <td className="px-3 py-2 text-[13px] text-slate-500">{c.description || '—'}</td>
                        <td className="px-3 py-2 text-[13px] font-black text-slate-800 text-right tabular-nums">{DORMV_huf(c.amount, c.currency)}</td>
                        <td className="px-3 py-2 text-[13px] text-slate-500">
                          {DORMV_LIABLE[c.charged_to] || c.charged_to}
                          {c.recoverable && !c.recovered_at && <span className="block text-[11px] font-black text-violet-600">visszakövetelhető</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="mt-5">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Előzmény</div>
            {events.length === 0 ? (
              <p className="text-sm text-slate-400">Nincs rögzített esemény.</p>
            ) : (
              <ol className="space-y-2">
                {events.map(ev => (
                  <li key={ev.id} className="flex items-start gap-3 text-[13px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-2 flex-none" />
                    <span className="text-slate-400 tabular-nums flex-none">{DORMV_dt(ev.happened_at)}</span>
                    <span className="text-slate-700 font-semibold min-w-0 break-words">
                      {ev.body || ((ev.from_status ? ev.from_status + ' → ' : '') + (ev.to_status || ev.event_kind))}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </UModal>
  );
}

/* ============================================================
   6. KARBANTARTÁS · 1. fül — BEJELENTÉSEK
   ------------------------------------------------------------
   Forrás: dorm_open_issues(p_building, p_only_overdue, p_limit). Ez az RPC
   szándékosan NEM ad vissza lakónevet — a KARBANTARTO a szobát és a hibát
   látja, a lakót nem. A szűrés adatbázis-szintű; a felület nem kerüli meg.
   ============================================================ */

function DORMV_IssuesPanel({ buildings, building, respRows, landlords, canWrite }) {
  const [rows, setRows] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [prio, setPrio] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('');

  const load = async (bg) => {
    if (bg) setRefreshing(true); else setRows(null);
    setErr('');
    try {
      const data = await DORM_api.openIssues(building || null, overdue);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) { setRows([]); setErr(DORMV_msg(e)); }
    finally { setRefreshing(false); }
  };
  useEffect(() => { load(false); }, [building, overdue]);

  const list = (rows || []).filter(r => {
    if (prio && r.priority !== prio) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [r.ticket_no, r.room_code, r.title, r.category_label, r.building_code]
      .some(v => String(v || '').toLowerCase().includes(needle));
  });

  const stats = {
    total: (rows || []).length,
    p1: (rows || []).filter(r => r.priority === 'P1').length,
    late: (rows || []).filter(r => r.is_overdue).length,
    leased: (rows || []).filter(r => DORMV_isLeased(r.tenure)).length,
  };

  if (rows === null) return <DORMV_Loading text="Nyitott hibák betöltése…" />;

  return (
    <div>
      <DORMV_Err msg={err} onClose={() => setErr('')} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <DORMV_Stat label="Nyitott hiba" value={stats.total} icon="AlertTriangle" />
        <DORMV_Stat label="P1 — azonnali" value={stats.p1} tone={stats.p1 ? 'red' : 'slate'} icon="Siren"
          hint={stats.p1 ? 'életveszély vagy azonnali beavatkozás' : 'most nincs ilyen'} />
        <DORMV_Stat label="Határidőn túl" value={stats.late} tone={stats.late ? 'amber' : 'slate'} icon="Clock" />
        <DORMV_Stat label="Bérelt épületben" value={stats.leased} tone="violet" icon="Building2"
          hint="itt a bérbeadói szál dönt" />
      </div>

      {/* Adatvédelmi keret: kimondjuk, MIÉRT nincs lakónév. */}
      <div className="mt-5 flex items-start gap-3 text-[12px] font-semibold text-slate-600 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3">
        <DORMV_Ic n="ShieldCheck" size={15} className="mt-0.5 flex-none text-slate-400" />
        <span>
          A hibajegy a <b>szobára</b> hivatkozik, nem a lakóra. A lakó nevét ez a lista
          adatvédelmi okból nem tartalmazza — a szűrést az adatbázis végzi, nem a felület.
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {[['', 'Minden prioritás'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3'], ['P4', 'P4']].map(([k, label]) => (
          <button key={k || 'all'} onClick={() => setPrio(k)}
            className={'min-h-[44px] px-4 rounded-xl text-sm font-black transition-colors ' +
              (prio === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50')}>
            {label}
          </button>
        ))}
        <button onClick={() => setOverdue(v => !v)}
          className={'min-h-[44px] px-4 rounded-xl text-sm font-black inline-flex items-center gap-2 transition-colors ' +
            (overdue ? 'bg-amber-500 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50')}>
          <DORMV_Ic n="Clock" size={15} /> Csak lejárt
        </button>
        <div className="relative w-full sm:w-auto sm:ml-auto">
          <DORMV_Ic n="Search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Jegyszám, szoba, hiba…"
            className="w-full sm:w-64 min-h-[44px] bg-white border border-slate-200 rounded-xl pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>
        <button onClick={() => load(true)}
          className="min-h-[44px] px-4 rounded-xl text-sm font-bold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-2">
          <DORMV_Ic n="RefreshCw" size={15} /> Frissítés
        </button>
        <RefreshingBadge on={refreshing} />
      </div>

      {list.length === 0 ? (
        <div className="mt-5">
          <DORMV_Empty icon="CheckCircle2"
            title={q.trim() || prio || overdue ? 'Nincs találat a szűrőkre' : 'Nincs nyitott hiba'}
            subtitle={q.trim() || prio || overdue
              ? 'Lazíts a szűrőkön, vagy válts épületet.'
              : 'Ebben a hatókörben most minden bejelentés le van zárva.'} />
        </div>
      ) : (
        <>
          {/* Kis kijelző: kártyák. Nyolc oszlop telefonon olvashatatlan. */}
          <div className="mt-5 space-y-3 md:hidden">
            {list.map(r => (
              <button key={r.ticket_no} onClick={() => setOpen(r.ticket_no)}
                className="w-full text-left bg-white rounded-2xl border border-slate-100 p-4 active:scale-[0.99] transition-transform">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-black text-slate-900 break-words">{r.title}</div>
                    <div className="text-[12px] text-slate-400 font-bold mt-0.5">
                      {r.ticket_no} · {r.building_code} · {r.room_code || 'épület-szintű'}
                    </div>
                  </div>
                  <DORMV_PrioChip p={r.priority} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <DORMV_Chip>{r.category_label}</DORMV_Chip>
                  <DORMV_Chip icon="Activity">{r.status_label}</DORMV_Chip>
                  <DORMV_Chip icon="Clock" cls={r.is_overdue
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-slate-50 text-slate-500 border-slate-200'}>
                    {r.is_overdue ? 'lejárt' : r.age_bucket}
                  </DORMV_Chip>
                  {DORMV_isLeased(r.tenure) && <DORMV_TenureChip tenure={r.tenure} />}
                </div>
                <div className="mt-3">
                  <DORMV_Hidden label="Kollégista" reason="A hibajegy a szobára hivatkozik. A kollégista nevét a karbantartási nézet adatvédelmi okból nem kapja meg." />
                </div>
              </button>
            ))}
          </div>

          {/* Nagy kijelző: táblázat, saját vízszintes görgetésben. */}
          <div className="mt-5 hidden md:block bg-white rounded-3xl border border-slate-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px]">
                <thead>
                  <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                    <th className="text-left px-4 py-3">Jegy</th>
                    <th className="text-left px-4 py-3">Helyszín</th>
                    <th className="text-left px-4 py-3">Hiba</th>
                    <th className="text-left px-4 py-3">Prioritás</th>
                    <th className="text-left px-4 py-3">Állapot</th>
                    <th className="text-left px-4 py-3">Felelős</th>
                    <th className="text-left px-4 py-3">Kor / határidő</th>
                    <th className="text-left px-4 py-3">Kollégista</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(r => (
                    <tr key={r.ticket_no} onClick={() => setOpen(r.ticket_no)}
                      className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 cursor-pointer">
                      <td className="px-4 py-3 font-mono text-[12px] font-bold text-slate-500 whitespace-nowrap">{r.ticket_no}</td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-800 whitespace-nowrap">{r.room_code || 'épület-szintű'}</div>
                        <div className="text-[12px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                          {r.building_code} {DORMV_isLeased(r.tenure) && <DORMV_TenureChip tenure={r.tenure} />}
                        </div>
                      </td>
                      <td className="px-4 py-3 max-w-[280px]">
                        <div className="font-bold text-slate-800 break-words">{r.title}</div>
                        <div className="text-[12px] text-slate-400">{r.category_label}</div>
                      </td>
                      <td className="px-4 py-3"><DORMV_PrioChip p={r.priority} /></td>
                      <td className="px-4 py-3 text-[13px] font-bold text-slate-600 whitespace-nowrap">{r.status_label}</td>
                      <td className="px-4 py-3 text-[13px] whitespace-nowrap">
                        <span className={r.liable_party === 'LANDLORD' ? 'font-black text-violet-700' : 'font-bold text-slate-600'}>
                          {DORMV_LIABLE[r.liable_party] || r.liable_party || '—'}
                        </span>
                        {r.contract_clause && <div className="text-[11px] text-slate-400 font-mono">{r.contract_clause}</div>}
                      </td>
                      <td className="px-4 py-3 text-[13px] whitespace-nowrap">
                        <div className="font-bold text-slate-600">{r.age_bucket}</div>
                        <div className={'text-[11px] font-black ' + (r.is_overdue ? 'text-red-600' : 'text-slate-400')}>
                          {r.due_at ? DORMV_dueText(r.due_at) : 'nincs határidő'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <DORMV_Hidden label="Kollégista" reason="A hibajegy a szobára hivatkozik. A kollégista nevét a karbantartási nézet adatvédelmi okból nem kapja meg." />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {open && (
        <DORMV_IssueModal ticketNo={open} buildings={buildings} respRows={respRows} landlords={landlords}
          canWrite={canWrite} onClose={() => setOpen('')} onChanged={() => load(true)} />
      )}
    </div>
  );
}

/* ============================================================
   7. KARBANTARTÁS · 2. fül — MUNKALAPOK
   ------------------------------------------------------------
   A munkalap az a nézet, ahol a jegy MUNKÁVÁ válik: kiosztás, határidő,
   anyagköltség, lezárás. Bérelt épületnél emellett fut a BÉRBEADÓI SZÁL —
   ez a modul lényege, ezért vizuálisan kiemelt (DORMV_LandlordPanel):
   felelős · útvonal · határidő · szerződéspont · bérbeadói kapcsolat.

   Miért nem a dorm_open_issues() az adatforrás? Mert az összesített olvasat,
   amiben nincs benne a kiosztás, a munkaóra és az anyagköltség. A dorm séma
   ki van téve, tehát a dorm.issue táblát közvetlenül olvassuk, RLS mögül.
   Beágyazott joint (PostgREST embed) szándékosan NEM használunk: a room_id-n
   összetett idegen kulcs ül, amit a PostgREST nem old fel egyértelműen —
   a szoba- és épületkódot kliensoldalon fűzzük hozzá.
   ============================================================ */

const DORMV_WO_STATUSES = ['NEW', 'ACKNOWLEDGED', 'TRIAGE', 'ASSIGNED', 'IN_PROGRESS',
  'WAITING_PARTS', 'WAITING_LANDLORD', 'WAITING_RESIDENT', 'DONE'];

function DORMV_WorkOrdersPanel({ buildings, building, respRows, landlords, statuses, transitions, canWrite }) {
  const [rows, setRows] = useState(null);
  const [rooms, setRooms] = useState({});
  const [costs, setCosts] = useState({});
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);     // munkalap-szerkesztő
  const [costOn, setCostOn] = useState(null); // költségrögzítő
  const [detail, setDetail] = useState('');

  const statusLabel = (code) => (statuses[code] && statuses[code].label_hu) || code;

  const load = async (bg) => {
    if (bg) setRefreshing(true); else setRows(null);
    setErr('');
    const a = await DORMV_sel('issue', q2 => {
      let x = q2.in('status', DORMV_WO_STATUSES).order('due_at', { ascending: true, nullsFirst: false }).limit(300);
      if (building) x = x.eq('building_id', building);
      return x;
    });
    if (a.error) setErr(a.error);
    const list = a.rows;
    setRows(list);

    const roomIds = Array.from(new Set(list.map(r => r.room_id).filter(Boolean)));
    if (roomIds.length) {
      const rr = await DORMV_sel('room', q2 => q2.in('id', roomIds));
      const map = {}; rr.rows.forEach(r => { map[r.id] = r; });
      setRooms(map);
    } else setRooms({});

    const ids = list.map(r => r.id);
    if (ids.length) {
      const cc = await DORMV_sel('work_cost', q2 => q2.in('issue_id', ids));
      const agg = {};
      cc.rows.forEach(c => {
        const k = c.issue_id;
        if (!agg[k]) agg[k] = { total: 0, currency: c.currency || 'HUF', recoverable: 0, n: 0 };
        agg[k].total += Number(c.amount || 0);
        agg[k].n += 1;
        if (c.charged_to === 'LANDLORD' && !c.recovered_at) agg[k].recoverable += Number(c.amount || 0);
      });
      setCosts(agg);
    } else setCosts({});
    setRefreshing(false);
  };
  useEffect(() => { load(false); }, [building]);

  const bMap = {}; buildings.forEach(b => { bMap[b.id] = b; });

  const list = (rows || []).filter(r => {
    const b = bMap[r.building_id];
    if (filter === 'landlord' && r.status !== 'WAITING_LANDLORD') return false;
    if (filter === 'overdue' && !(r.due_at && new Date(r.due_at) < new Date())) return false;
    if (filter === 'leased' && !(b && DORMV_isLeased(b.tenure))) return false;
    if (filter === 'mine' && !r.assigned_to && !r.assigned_vendor) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    const room = rooms[r.room_id];
    return [r.ticket_no, r.title, r.category_code, room && room.full_code, b && b.code]
      .some(v => String(v || '').toLowerCase().includes(needle));
  });

  const waitingLandlord = (rows || []).filter(r => r.status === 'WAITING_LANDLORD').length;
  const recoverable = Object.values(costs).reduce((s, c) => s + c.recoverable, 0);

  if (rows === null) return <DORMV_Loading text="Munkalapok betöltése…" />;

  return (
    <div>
      <DORMV_Err msg={err} onClose={() => setErr('')} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <DORMV_Stat label="Nyitott munkalap" value={(rows || []).length} icon="ClipboardList" />
        <DORMV_Stat label="Bérbeadóra vár" value={waitingLandlord} tone={waitingLandlord ? 'violet' : 'slate'} icon="Building2"
          hint="ez a szám a szerződéshosszabbítás érve" />
        <DORMV_Stat label="Határidőn túl" value={(rows || []).filter(r => r.due_at && new Date(r.due_at) < new Date()).length}
          tone="amber" icon="Clock" />
        <DORMV_Stat label="Visszakövetelhető" value={DORMV_huf(recoverable)} tone="violet" icon="Wallet"
          hint="bérbeadóra terhelt, de általunk kifizetett" />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {[['all', 'Mind'], ['landlord', 'Bérbeadóra vár'], ['leased', 'Bérelt épület'], ['overdue', 'Lejárt'], ['mine', 'Kiosztott']].map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={'min-h-[44px] px-4 rounded-xl text-sm font-black transition-colors ' +
              (filter === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50')}>
            {label}
          </button>
        ))}
        <div className="relative w-full sm:w-auto sm:ml-auto">
          <DORMV_Ic n="Search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Jegyszám, szoba, munka…"
            className="w-full sm:w-64 min-h-[44px] bg-white border border-slate-200 rounded-xl pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>
        <button onClick={() => load(true)}
          className="min-h-[44px] px-4 rounded-xl text-sm font-bold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-2">
          <DORMV_Ic n="RefreshCw" size={15} /> Frissítés
        </button>
        <RefreshingBadge on={refreshing} />
      </div>

      {list.length === 0 ? (
        <div className="mt-5">
          <DORMV_Empty icon="ClipboardCheck" title="Nincs nyitott munkalap"
            subtitle="Ebben a hatókörben és szűrésben most nincs folyamatban lévő munka." />
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {list.map(r => {
            const b = bMap[r.building_id];
            const room = rooms[r.room_id];
            const leased = b && DORMV_isLeased(b.tenure);
            const resp = DORMV_resolveResp(respRows, r.building_id, b && b.tenure, r.category_code);
            const landlord = b && landlords.find(l => l.id === b.landlord_id);
            const late = r.due_at && new Date(r.due_at) < new Date();
            const c = costs[r.id];

            return (
              <div key={r.id}
                className={'bg-white rounded-3xl border p-4 sm:p-5 ' + (leased ? 'border-violet-100' : 'border-slate-100')}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] font-black text-slate-400">{r.ticket_no}</span>
                      <DORMV_PrioChip p={r.priority} />
                      <DORMV_Chip icon="Activity">{statusLabel(r.status)}</DORMV_Chip>
                      {b && <DORMV_TenureChip tenure={b.tenure} />}
                      {r.is_chronic && <DORMV_Chip icon="Repeat" cls="bg-red-50 text-red-700 border-red-200">Krónikus</DORMV_Chip>}
                    </div>
                    <h3 className="text-lg font-black text-slate-900 mt-2 break-words">{r.title}</h3>
                    <p className="text-[13px] text-slate-400 font-bold mt-0.5">
                      {(b ? b.name + ' · ' : '')}{room ? room.full_code : 'épület-szintű'}
                    </p>
                  </div>
                  <button onClick={() => setDetail(r.ticket_no)}
                    className="min-h-[44px] px-4 rounded-xl text-sm font-bold text-slate-600 bg-slate-50 hover:bg-slate-100 inline-flex items-center gap-2 flex-none">
                    <DORMV_Ic n="Eye" size={15} /> Részletek
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4">
                  <DORMV_KV label="Kiosztva">{r.assigned_vendor || (r.assigned_to ? 'belső kollégának' : 'még senkinek')}</DORMV_KV>
                  <DORMV_KV label="Határidő">
                    <span className={late ? 'text-red-600' : ''}>{DORMV_dt(r.due_at)}</span>
                    <span className={'block text-[11px] font-black ' + (late ? 'text-red-600' : 'text-slate-400')}>{DORMV_dueText(r.due_at)}</span>
                  </DORMV_KV>
                  <DORMV_KV label="Munkaóra">{r.work_hours == null ? '—' : DORMV_num(r.work_hours) + ' óra'}</DORMV_KV>
                  <DORMV_KV label="Anyagköltség">{c ? DORMV_huf(c.total, c.currency) : DORMV_huf(r.cost_amount, r.cost_currency)}</DORMV_KV>
                  <DORMV_KV label="Felhasznált anyag" wide>{r.materials_note || '—'}</DORMV_KV>
                </div>

                {/* A BÉRELT ÉPÜLET SZÁLA — a modul lényege, ezért kiemelve. */}
                {leased && (
                  <DORMV_LandlordPanel issue={r} resp={resp} landlord={landlord}
                    onNotify={canWrite ? () => setEdit({ row: r, mode: 'landlord' }) : null} />
                )}

                {canWrite && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button onClick={() => setEdit({ row: r, mode: 'work' })}
                      className="min-h-[44px] px-4 rounded-xl text-sm font-black bg-primary text-white hover:bg-primary/90 inline-flex items-center gap-2">
                      <DORMV_Ic n="Pencil" size={15} /> Munkalap szerkesztése
                    </button>
                    <button onClick={() => setCostOn(r)}
                      className="min-h-[44px] px-4 rounded-xl text-sm font-bold bg-slate-50 text-slate-600 hover:bg-slate-100 inline-flex items-center gap-2">
                      <DORMV_Ic n="Plus" size={15} /> Költség rögzítése
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {edit && (
        <DORMV_WorkOrderModal entry={edit} buildings={buildings} rooms={rooms} statuses={statuses}
          transitions={transitions} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(true); }} />
      )}
      {costOn && (
        <DORMV_CostModal issue={costOn} onClose={() => setCostOn(null)} onSaved={() => { setCostOn(null); load(true); }} />
      )}
      {detail && (
        <DORMV_IssueModal ticketNo={detail} buildings={buildings} respRows={respRows} landlords={landlords}
          canWrite={canWrite} onClose={() => setDetail('')} onChanged={() => load(true)} />
      )}
    </div>
  );
}

/* Munkalap-szerkesztő. Az állapotváltásnál CSAK a megengedett átmeneteket
   kínáljuk fel (dorm.issue_status_transition) — az adatbázis guardja úgyis
   visszautasítaná a többit, de a felhasználót nem ütközni küldjük. */
function DORMV_WorkOrderModal({ entry, statuses, transitions, onClose, onSaved }) {
  const row = entry.row;
  const [assignedVendor, setAssignedVendor] = useState(row.assigned_vendor || '');
  const [due, setDue] = useState(row.due_at ? String(row.due_at).slice(0, 16) : '');
  const [hours, setHours] = useState(row.work_hours == null ? '' : String(row.work_hours));
  const [materials, setMaterials] = useState(row.materials_note || '');
  const [amount, setAmount] = useState(row.cost_amount == null ? '' : String(row.cost_amount));
  const [invoice, setInvoice] = useState(row.external_invoice_ref || '');
  const [status, setStatus] = useState('');
  const [ref, setRef] = useState(row.landlord_ticket_ref || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const allowed = (transitions || []).filter(t => t.from_code === row.status);
  const isLandlordMode = entry.mode === 'landlord';

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const patch = {};
      if (isLandlordMode) {
        patch.landlord_notified_at = new Date().toISOString();
        patch.landlord_ticket_ref = ref || null;
      } else {
        patch.assigned_vendor = assignedVendor || null;
        patch.due_at = due ? new Date(due).toISOString() : null;
        patch.work_hours = hours === '' ? null : Number(hours);
        patch.materials_note = materials || null;
        patch.cost_amount = amount === '' ? null : Number(amount);
        patch.external_invoice_ref = invoice || null;
      }
      await DORMV_update('issue', row.id, patch);

      // Az állapotváltás KÜLÖN update: ha a guard elutasítja, a fenti adatok
      // akkor is elmentődtek — a karbantartó munkája ne vesszen el.
      const nextStatus = isLandlordMode ? (allowed.some(t => t.to_code === 'WAITING_LANDLORD') ? 'WAITING_LANDLORD' : '') : status;
      if (nextStatus) {
        try { await DORMV_update('issue', row.id, { status: nextStatus }); }
        catch (e) { setErr('Az adatok elmentve, de az állapotváltás nem sikerült: ' + DORMV_msg(e)); setBusy(false); return; }
      }
      onSaved();
    } catch (e) { setErr(DORMV_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <UModal open onClose={onClose} max="max-w-xl"
      title={isLandlordMode ? 'Bejelentés a bérbeadónak' : 'Munkalap · ' + row.ticket_no}
      subtitle={row.title}
      icon={<DORMV_Ic n={isLandlordMode ? 'Building2' : 'ClipboardList'} size={20} />}>
      <DORMV_Err msg={err} onClose={() => setErr('')} />

      {isLandlordMode ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-500 leading-relaxed">
            A rögzítéssel elindul a bérbeadói óra. Ez az az idő, amit később
            épületenként és hibakategóriánként ki lehet mutatni — a
            szerződéshosszabbítási tárgyalás legerősebb érve, és a helyettesítő
            javítás jogalapjának bizonyítéka.
          </p>
          <UField label="A bérbeadó ügyszáma / hivatkozása" hint="Ha még nincs, hagyd üresen — később pótolható.">
            <input className={U_input + ' min-h-[48px]'} value={ref} onChange={e => setRef(e.target.value)} placeholder="pl. BB-2026-0413" />
          </UField>
        </div>
      ) : (
        <div className="space-y-4">
          <UField label="Kiosztva (külsős szolgáltató vagy csapat)">
            <input className={U_input + ' min-h-[48px]'} value={assignedVendor} onChange={e => setAssignedVendor(e.target.value)}
              placeholder="pl. Kovács Kft. · vízszerelés" />
          </UField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UField label="Határidő">
              <input type="datetime-local" className={U_input + ' min-h-[48px]'} value={due} onChange={e => setDue(e.target.value)} />
            </UField>
            <UField label="Munkaóra">
              <input type="number" step="0.25" min="0" inputMode="decimal" className={U_input + ' min-h-[48px]'}
                value={hours} onChange={e => setHours(e.target.value)} />
            </UField>
          </div>
          <UField label="Felhasznált anyag">
            <textarea className={U_input + ' min-h-[90px] resize-y'} value={materials} onChange={e => setMaterials(e.target.value)}
              placeholder="pl. 1 db mosdócsaptelep, 2 m flexibilis bekötőcső" />
          </UField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UField label="Anyagköltség összesen (Ft)">
              <input type="number" min="0" inputMode="numeric" className={U_input + ' min-h-[48px]'}
                value={amount} onChange={e => setAmount(e.target.value)} />
            </UField>
            <UField label="Külsős számla hivatkozása">
              <input className={U_input + ' min-h-[48px]'} value={invoice} onChange={e => setInvoice(e.target.value)} />
            </UField>
          </div>
          <UField label="Állapotváltás" hint="Csak a megengedett átmenetek jelennek meg. Az állapotgépet az adatbázis őrzi.">
            <select className={U_input + ' min-h-[48px]'} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">Marad: {(statuses[row.status] && statuses[row.status].label_hu) || row.status}</option>
              {allowed.map(t => (
                <option key={t.to_code} value={t.to_code}>
                  {(statuses[t.to_code] && statuses[t.to_code].label_hu) || t.to_code}
                </option>
              ))}
            </select>
          </UField>
        </div>
      )}

      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <button disabled={busy} onClick={save} className={U_btnPrimary + ' min-h-[48px] w-full sm:w-auto'}>
          {busy ? 'Mentés…' : 'Mentés'}
        </button>
        <button onClick={onClose} className={U_btnGhost + ' min-h-[48px] w-full sm:w-auto'}>Mégsem</button>
      </div>
    </UModal>
  );
}

/* Költségtétel rögzítése. A "kinek a terhére" mező azért kötelező döntés, mert
   a bérbeadóra terhelt, de általunk kifizetett tétel a visszakövetelhető
   riport alapja — ha itt nem dől el, később sem fog. */
function DORMV_CostModal({ issue, onClose, onSaved }) {
  const [kind, setKind] = useState('MATERIAL');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [chargedTo, setChargedTo] = useState('UNIVERSITY');
  const [recoverable, setRecoverable] = useState(false);
  const [invoiceRef, setInvoiceRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!amount) { setErr('Az összeg megadása kötelező.'); return; }
    setBusy(true); setErr('');
    try {
      await DORMV_insert('work_cost', {
        issue_id: issue.id,
        building_id: issue.building_id,
        kind, description: desc || null,
        amount: Number(amount), currency: 'HUF',
        charged_to: chargedTo,
        recoverable: chargedTo === 'LANDLORD' ? true : recoverable,
        invoice_ref: invoiceRef || null,
      });
      onSaved();
    } catch (e) { setErr(DORMV_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <UModal open onClose={onClose} max="max-w-lg" title="Költségtétel rögzítése"
      subtitle={issue.ticket_no + ' · ' + issue.title} icon={<DORMV_Ic n="Wallet" size={20} />}>
      <DORMV_Err msg={err} onClose={() => setErr('')} />
      <div className="space-y-4">
        <UField label="Típus">
          <select className={U_input + ' min-h-[48px]'} value={kind} onChange={e => setKind(e.target.value)}>
            {Object.keys(DORMV_WORK_KIND).map(k => <option key={k} value={k}>{DORMV_WORK_KIND[k]}</option>)}
          </select>
        </UField>
        <UField label="Megnevezés">
          <input className={U_input + ' min-h-[48px]'} value={desc} onChange={e => setDesc(e.target.value)} />
        </UField>
        <UField label="Összeg (Ft)">
          <input type="number" min="0" inputMode="numeric" className={U_input + ' min-h-[48px]'}
            value={amount} onChange={e => setAmount(e.target.value)} />
        </UField>
        <UField label="Kinek a terhére" hint="A bérbeadóra terhelt tétel automatikusan visszakövetelhetőként kerül nyilvántartásba.">
          <select className={U_input + ' min-h-[48px]'} value={chargedTo} onChange={e => setChargedTo(e.target.value)}>
            {['UNIVERSITY', 'LANDLORD', 'RESIDENT', 'INSURANCE'].map(k => <option key={k} value={k}>{DORMV_LIABLE[k]}</option>)}
          </select>
        </UField>
        {chargedTo !== 'LANDLORD' && (
          <label className="flex items-center gap-3 min-h-[48px] cursor-pointer">
            <input type="checkbox" className="w-5 h-5 rounded accent-primary"
              checked={recoverable} onChange={e => setRecoverable(e.target.checked)} />
            <span className="text-sm font-bold text-slate-700">Visszakövetelhető tétel</span>
          </label>
        )}
        <UField label="Számla hivatkozása">
          <input className={U_input + ' min-h-[48px]'} value={invoiceRef} onChange={e => setInvoiceRef(e.target.value)} />
        </UField>
      </div>
      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <button disabled={busy} onClick={save} className={U_btnPrimary + ' min-h-[48px] w-full sm:w-auto'}>{busy ? 'Mentés…' : 'Rögzítés'}</button>
        <button onClick={onClose} className={U_btnGhost + ' min-h-[48px] w-full sm:w-auto'}>Mégsem</button>
      </div>
    </UModal>
  );
}

/* ============================================================
   8. KARBANTARTÁS · 3. fül — ESZKÖZÖK / LELTÁR
   ------------------------------------------------------------
   Szobánkénti bútor- és eszközlista, állapot, selejtezés. A mozgásnapló
   (dorm.asset_move) azért van a részletekben, mert a "hova tűnt a hűtő a
   312-esből" kérdés hetente előjön, és enélkül a leltár néhány hónap alatt
   használhatatlanná válik.
   ============================================================ */

/* Műszaki avulás: beszerzés + várható élettartam. Nem selejtezési döntés,
   csak jelzés — a döntés emberi. */
function DORMV_assetAge(a) {
  if (!a.acquired_on || !a.expected_life_years) return null;
  const acquired = new Date(a.acquired_on);
  if (isNaN(acquired)) return null;
  const years = (Date.now() - acquired) / (365.25 * 86400000);
  return { years, over: years > Number(a.expected_life_years) };
}

function DORMV_AssetsPanel({ buildings, building, canWrite }) {
  const [rows, setRows] = useState(null);
  const [rooms, setRooms] = useState({});
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setRows(null); setErr('');
    const a = await DORMV_sel('asset', q2 => {
      let x = q2.order('inventory_no', { ascending: true }).limit(1000);
      if (building) x = x.eq('building_id', building);
      return x;
    });
    if (a.error) setErr(a.error);
    setRows(a.rows);
    const ids = Array.from(new Set(a.rows.map(r => r.room_id).filter(Boolean)));
    if (ids.length) {
      const rr = await DORMV_sel('room', q2 => q2.in('id', ids));
      const map = {}; rr.rows.forEach(r => { map[r.id] = r; });
      setRooms(map);
    } else setRooms({});
  };
  useEffect(() => { load(); }, [building]);

  if (rows === null) return <DORMV_Loading text="Leltár betöltése…" />;

  const list = rows.filter(a => {
    if (onlyActive && !a.is_active) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    const room = rooms[a.room_id];
    return [a.inventory_no, a.name, a.asset_type, a.serial_number, room && room.full_code]
      .some(v => String(v || '').toLowerCase().includes(needle));
  });

  // Szobánkénti csoportosítás: a leltárt szobában járják be, nem listában.
  const groups = {};
  list.forEach(a => {
    const key = a.room_id ? ((rooms[a.room_id] && rooms[a.room_id].full_code) || a.room_id) : 'Nincs szobához rendelve';
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  });
  const keys = Object.keys(groups).sort();
  const aged = rows.filter(a => a.is_active && (DORMV_assetAge(a) || {}).over).length;

  return (
    <div>
      <DORMV_Err msg={err} onClose={() => setErr('')} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <DORMV_Stat label="Nyilvántartott eszköz" value={rows.filter(a => a.is_active).length} icon="Package" />
        <DORMV_Stat label="Élettartamon túl" value={aged} tone={aged ? 'amber' : 'slate'} icon="History"
          hint="beszerzés + várható élettartam alapján" />
        <DORMV_Stat label="Selejtezett" value={rows.filter(a => !a.is_active).length} icon="Trash2" />
        <DORMV_Stat label="Érintett szoba" value={keys.filter(k => k !== 'Nincs szobához rendelve').length} icon="DoorOpen" />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button onClick={() => setOnlyActive(v => !v)}
          className={'min-h-[44px] px-4 rounded-xl text-sm font-black transition-colors ' +
            (onlyActive ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50')}>
          {onlyActive ? 'Csak aktív' : 'Selejtezettel együtt'}
        </button>
        <div className="relative w-full sm:w-auto sm:ml-auto">
          <DORMV_Ic n="Search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Leltári szám, megnevezés, szoba…"
            className="w-full sm:w-64 min-h-[44px] bg-white border border-slate-200 rounded-xl pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>
        {canWrite && (
          <button onClick={() => setAdding(true)}
            className="min-h-[44px] px-4 rounded-xl text-sm font-black bg-primary text-white hover:bg-primary/90 inline-flex items-center gap-2">
            <DORMV_Ic n="Plus" size={15} /> Új eszköz
          </button>
        )}
      </div>

      {keys.length === 0 ? (
        <div className="mt-5">
          <DORMV_Empty icon="Package" title="Nincs leltári tétel"
            subtitle="Ebben az épületben még nincs rögzített eszköz. A leltár feltöltése az adatfelvétel legidőigényesebb része — érdemes szobánként haladni." />
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {keys.map(k => (
            <div key={k} className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
              <div className="px-4 sm:px-5 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
                <DORMV_Ic n="DoorOpen" size={15} className="text-slate-400" />
                <span className="font-black text-slate-800">{k}</span>
                <span className="text-[11px] font-black text-slate-400">{groups[k].length} tétel</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                      <th className="text-left px-4 py-2.5">Leltári szám</th>
                      <th className="text-left px-4 py-2.5">Megnevezés</th>
                      <th className="text-left px-4 py-2.5">Típus</th>
                      <th className="text-left px-4 py-2.5">Állapot</th>
                      <th className="text-left px-4 py-2.5">Beszerzés</th>
                      <th className="text-right px-4 py-2.5">Művelet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups[k].map(a => {
                      const age = DORMV_assetAge(a);
                      return (
                        <tr key={a.id} className={'border-b border-slate-50 last:border-0 ' + (a.is_active ? '' : 'opacity-50')}>
                          <td className="px-4 py-3 font-mono text-[12px] font-bold text-slate-500 whitespace-nowrap">{a.inventory_no || '—'}</td>
                          <td className="px-4 py-3">
                            <div className="font-bold text-slate-800 break-words">{a.name}</div>
                            {a.serial_number && <div className="text-[11px] text-slate-400">gyári sz.: {a.serial_number}</div>}
                          </td>
                          <td className="px-4 py-3 text-[13px] text-slate-500 whitespace-nowrap">{a.asset_type}</td>
                          <td className="px-4 py-3">
                            {a.is_active ? (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <DORMV_Chip cls={a.condition_grade >= 4
                                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                                  : 'bg-slate-50 text-slate-600 border-slate-200'}>
                                  {DORMV_COND[a.condition_grade] || 'nincs minősítés'}
                                </DORMV_Chip>
                                {age && age.over && <DORMV_Chip icon="History" cls="bg-amber-50 text-amber-700 border-amber-200">élettartamon túl</DORMV_Chip>}
                              </div>
                            ) : <DORMV_Chip icon="Trash2" cls="bg-slate-100 text-slate-500 border-slate-200">Selejtezve</DORMV_Chip>}
                          </td>
                          <td className="px-4 py-3 text-[13px] text-slate-500 whitespace-nowrap">
                            {DORMV_d(a.acquired_on)}
                            {a.acquired_value != null && <div className="text-[11px] text-slate-400">{DORMV_huf(a.acquired_value, a.currency)}</div>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => setDetail(a)}
                              className="min-h-[36px] px-3 rounded-lg text-[13px] font-bold text-slate-600 bg-slate-50 hover:bg-slate-100">
                              Részletek
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <DORMV_AssetModal asset={detail} room={rooms[detail.room_id]} canWrite={canWrite}
          onClose={() => setDetail(null)} onSaved={() => { setDetail(null); load(); }} />
      )}
      {adding && (
        <DORMV_AssetAddModal buildings={buildings} building={building}
          onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />
      )}
    </div>
  );
}

function DORMV_AssetModal({ asset, room, canWrite, onClose, onSaved }) {
  const [grade, setGrade] = useState(asset.condition_grade || '');
  const [note, setNote] = useState(asset.note || '');
  const [moves, setMoves] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const m = await DORMV_sel('asset_move', q => q.eq('asset_id', asset.id).order('moved_at', { ascending: false }).limit(20));
      setMoves(m.rows);
    })();
  }, [asset.id]);

  const save = async (patch, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setErr('');
    try { await DORMV_update('asset', asset.id, patch); onSaved(); }
    catch (e) { setErr(DORMV_msg(e)); setBusy(false); }
  };

  const age = DORMV_assetAge(asset);

  return (
    <UModal open onClose={onClose} max="max-w-xl" title={asset.name}
      subtitle={(asset.inventory_no ? asset.inventory_no + ' · ' : '') + (room ? room.full_code : 'nincs szobához rendelve')}
      icon={<DORMV_Ic n="Package" size={20} />}>
      <DORMV_Err msg={err} onClose={() => setErr('')} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DORMV_KV label="Típus">{asset.asset_type}</DORMV_KV>
        <DORMV_KV label="Gyári szám">{asset.serial_number}</DORMV_KV>
        <DORMV_KV label="Beszerzés">{DORMV_d(asset.acquired_on)}</DORMV_KV>
        <DORMV_KV label="Beszerzési érték">{DORMV_huf(asset.acquired_value, asset.currency)}</DORMV_KV>
        <DORMV_KV label="Várható élettartam">
          {asset.expected_life_years ? asset.expected_life_years + ' év' : '—'}
          {age && <span className={'block text-[11px] font-black ' + (age.over ? 'text-amber-600' : 'text-slate-400')}>
            {age.years.toFixed(1)} éves{age.over ? ' — élettartamon túl' : ''}
          </span>}
        </DORMV_KV>
        <DORMV_KV label="Garancia">{DORMV_d(asset.warranty_until)}</DORMV_KV>
      </div>

      {canWrite && asset.is_active && (
        <div className="mt-5 space-y-4">
          <UField label="Állapot minősítése">
            <select className={U_input + ' min-h-[48px]'} value={grade} onChange={e => setGrade(e.target.value)}>
              <option value="">Nincs minősítés</option>
              {[1, 2, 3, 4, 5].map(g => <option key={g} value={g}>{g} — {DORMV_COND[g]}</option>)}
            </select>
          </UField>
          <UField label="Megjegyzés">
            <textarea className={U_input + ' min-h-[80px] resize-y'} value={note} onChange={e => setNote(e.target.value)} />
          </UField>
        </div>
      )}

      <div className="mt-5">
        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Mozgásnapló</div>
        {moves.length === 0 ? (
          <p className="text-sm text-slate-400">Nincs rögzített mozgás.</p>
        ) : (
          <ol className="space-y-1.5">
            {moves.map(m => (
              <li key={m.id} className="text-[13px] text-slate-600 flex flex-wrap gap-2">
                <span className="text-slate-400 tabular-nums">{DORMV_d(m.moved_at)}</span>
                <span className="font-semibold">{m.reason || 'áthelyezés'}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {canWrite && (
        <div className="mt-6 flex flex-col sm:flex-row gap-3">
          {asset.is_active ? (
            <>
              <button disabled={busy} onClick={() => save({ condition_grade: grade === '' ? null : Number(grade), note: note || null })}
                className={U_btnPrimary + ' min-h-[48px] w-full sm:w-auto'}>Mentés</button>
              <button disabled={busy}
                onClick={() => save({ is_active: false, note: note || null },
                  'Biztosan selejtezed? A tétel a leltárból kikerül, de az előzménye megmarad.')}
                className="min-h-[48px] w-full sm:w-auto px-5 rounded-xl font-bold bg-red-50 text-red-600 hover:bg-red-100 inline-flex items-center justify-center gap-2">
                <DORMV_Ic n="Trash2" size={15} /> Selejtezés
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={() => save({ is_active: true })} className={U_btnGhost + ' min-h-[48px] w-full sm:w-auto'}>
              Visszavétel a leltárba
            </button>
          )}
          <button onClick={onClose} className={U_btnGhost + ' min-h-[48px] w-full sm:w-auto'}>Bezár</button>
        </div>
      )}
    </UModal>
  );
}

function DORMV_AssetAddModal({ buildings, building, onClose, onSaved }) {
  const [bid, setBid] = useState(building || (buildings[0] && buildings[0].id) || '');
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState('');
  const [form, setForm] = useState({ inventory_no: '', name: '', asset_type: 'Bútor', acquired_on: '', acquired_value: '', expected_life_years: '', condition_grade: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      if (!bid) { setRooms([]); return; }
      const r = await DORMV_sel('room', q => q.eq('building_id', bid).order('full_code', { ascending: true }).limit(1000));
      setRooms(r.rows);
    })();
  }, [bid]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) { setErr('A megnevezés kötelező.'); return; }
    setBusy(true); setErr('');
    try {
      await DORMV_insert('asset', {
        inventory_no: form.inventory_no || null,
        asset_type: form.asset_type || 'Egyéb',
        name: form.name.trim(),
        building_id: bid || null,
        room_id: roomId || null,
        acquired_on: form.acquired_on || null,
        acquired_value: form.acquired_value === '' ? null : Number(form.acquired_value),
        expected_life_years: form.expected_life_years === '' ? null : Number(form.expected_life_years),
        condition_grade: form.condition_grade === '' ? null : Number(form.condition_grade),
      });
      onSaved();
    } catch (e) { setErr(DORMV_msg(e)); setBusy(false); }
  };

  return (
    <UModal open onClose={onClose} max="max-w-lg" title="Új leltári tétel" icon={<DORMV_Ic n="Plus" size={20} />}>
      <DORMV_Err msg={err} onClose={() => setErr('')} />
      <div className="space-y-4">
        <UField label="Épület">
          <select className={U_input + ' min-h-[48px]'} value={bid} onChange={e => { setBid(e.target.value); setRoomId(''); }}>
            {buildings.map(b => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
          </select>
        </UField>
        <UField label="Szoba">
          <select className={U_input + ' min-h-[48px]'} value={roomId} onChange={e => setRoomId(e.target.value)}>
            <option value="">Nincs szobához rendelve</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.full_code}</option>)}
          </select>
        </UField>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UField label="Leltári szám"><input className={U_input + ' min-h-[48px]'} value={form.inventory_no} onChange={e => set('inventory_no', e.target.value)} /></UField>
          <UField label="Típus"><input className={U_input + ' min-h-[48px]'} value={form.asset_type} onChange={e => set('asset_type', e.target.value)} placeholder="Bútor / Háztartási gép / Egyéb" /></UField>
        </div>
        <UField label="Megnevezés"><input className={U_input + ' min-h-[48px]'} value={form.name} onChange={e => set('name', e.target.value)} placeholder="pl. Íróasztal, tölgy, 120×60" /></UField>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <UField label="Beszerzés"><input type="date" className={U_input + ' min-h-[48px]'} value={form.acquired_on} onChange={e => set('acquired_on', e.target.value)} /></UField>
          <UField label="Érték (Ft)"><input type="number" inputMode="numeric" className={U_input + ' min-h-[48px]'} value={form.acquired_value} onChange={e => set('acquired_value', e.target.value)} /></UField>
          <UField label="Élettartam (év)"><input type="number" inputMode="numeric" className={U_input + ' min-h-[48px]'} value={form.expected_life_years} onChange={e => set('expected_life_years', e.target.value)} /></UField>
        </div>
      </div>
      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <button disabled={busy} onClick={save} className={U_btnPrimary + ' min-h-[48px] w-full sm:w-auto'}>{busy ? 'Mentés…' : 'Felvétel'}</button>
        <button onClick={onClose} className={U_btnGhost + ' min-h-[48px] w-full sm:w-auto'}>Mégsem</button>
      </div>
    </UModal>
  );
}

/* ============================================================
   9. KARBANTARTÁS · 4. fül — IDŐSZAKOS FELADATOK
   ------------------------------------------------------------
   Tűzvédelem, kazánellenőrzés, rovarirtás, ágyneműcsere: ismétlődő,
   határidős feladatok, LEJÁRAT SZERINT KIEMELVE. Ezekhez BIZONYLAT tartozik,
   amit hatósági ellenőrzéskor elő kell venni; a hiánya bírság, súlyos
   esetben a biztosítási helytállás megtagadása.

   Bérelt épületnél a feladat nem marad el, hanem ÁTALAKUL: ha a mátrix
   szerint a bizonylatot a bérbeadó szolgáltatja, a teendő "bizonylat bekérése
   a bérbeadótól" — mert a lakóért akkor is mi felelünk, ha az épület nem a miénk.
   ============================================================ */

function DORMV_pmBucket(plan) {
  const d = DORMV_daysTo(plan.next_due_on);
  if (d == null) return { key: 'none', rank: 3, label: 'Nincs esedékesség', cls: 'bg-slate-50 text-slate-500 border-slate-200' };
  if (d < 0) return { key: 'late', rank: 0, label: 'Lejárt', cls: 'bg-red-50 text-red-700 border-red-200' };
  if (d <= 30) return { key: 'soon', rank: 1, label: '30 napon belül', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { key: 'later', rank: 2, label: 'Későbbi', cls: 'bg-slate-50 text-slate-500 border-slate-200' };
}

function DORMV_PmPanel({ buildings, building, respRows, canWrite }) {
  const [rows, setRows] = useState(null);
  const [lastRun, setLastRun] = useState({});
  const [err, setErr] = useState('');
  const [onlyLegal, setOnlyLegal] = useState(false);
  const [running, setRunning] = useState(null);

  const load = async () => {
    setRows(null); setErr('');
    const a = await DORMV_sel('pm_plan', q => {
      let x = q.eq('is_active', true).order('next_due_on', { ascending: true, nullsFirst: false }).limit(500);
      if (building) x = x.or('building_id.eq.' + building + ',building_id.is.null');
      return x;
    });
    if (a.error) setErr(a.error);
    setRows(a.rows);
    const ids = a.rows.map(r => r.id);
    if (ids.length) {
      const runs = await DORMV_sel('pm_run', q => q.in('plan_id', ids).order('done_on', { ascending: false }).limit(500));
      const map = {};
      runs.rows.forEach(r => { if (!map[r.plan_id]) map[r.plan_id] = r; });
      setLastRun(map);
    } else setLastRun({});
  };
  useEffect(() => { load(); }, [building]);

  if (rows === null) return <DORMV_Loading text="Időszakos feladatok betöltése…" />;

  const bMap = {}; buildings.forEach(b => { bMap[b.id] = b; });
  const list = rows.filter(p => (!onlyLegal || p.is_legal_requirement));
  const sorted = list.slice().sort((a, b) => {
    const ra = DORMV_pmBucket(a).rank, rb = DORMV_pmBucket(b).rank;
    if (ra !== rb) return ra - rb;
    return String(a.next_due_on || '9999').localeCompare(String(b.next_due_on || '9999'));
  });

  const late = rows.filter(p => (DORMV_daysTo(p.next_due_on) || 0) < 0 && p.next_due_on).length;
  const soon = rows.filter(p => { const d = DORMV_daysTo(p.next_due_on); return d != null && d >= 0 && d <= 30; }).length;
  const legalLate = rows.filter(p => p.is_legal_requirement && p.next_due_on && DORMV_daysTo(p.next_due_on) < 0).length;

  return (
    <div>
      <DORMV_Err msg={err} onClose={() => setErr('')} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <DORMV_Stat label="Aktív feladat" value={rows.length} icon="CalendarClock" />
        <DORMV_Stat label="Lejárt" value={late} tone={late ? 'red' : 'slate'} icon="AlertTriangle" />
        <DORMV_Stat label="30 napon belül" value={soon} tone={soon ? 'amber' : 'slate'} icon="Clock" />
        <DORMV_Stat label="Lejárt kötelező" value={legalLate} tone={legalLate ? 'red' : 'slate'} icon="Scale"
          hint="jogszabályi kötelezettség — bírságkockázat" />
      </div>

      {legalLate > 0 && (
        <div className="mt-5 flex items-start gap-3 text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
          <DORMV_Ic n="AlertTriangle" size={16} className="mt-0.5 flex-none" />
          <span>
            {legalLate} jogszabályi kötelezettség határideje lejárt. Hatósági ellenőrzésnél
            a hiányzó bizonylat bírságot, súlyos esetben a biztosítási helytállás
            megtagadását jelenti.
          </span>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button onClick={() => setOnlyLegal(v => !v)}
          className={'min-h-[44px] px-4 rounded-xl text-sm font-black transition-colors ' +
            (onlyLegal ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50')}>
          Csak jogszabályi kötelezettség
        </button>
        <button onClick={load}
          className="min-h-[44px] px-4 rounded-xl text-sm font-bold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-2 sm:ml-auto">
          <DORMV_Ic n="RefreshCw" size={15} /> Frissítés
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="mt-5">
          <DORMV_Empty icon="CalendarClock" title="Nincs ütemezett feladat"
            subtitle="A tűzvédelmi, gépészeti és higiéniai ciklusok felvétele a bevezetés első lépése — enélkül a bizonylattár nem tud felépülni." />
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {sorted.map(p => {
            const bucket = DORMV_pmBucket(p);
            const b = bMap[p.building_id];
            const leased = b && DORMV_isLeased(b.tenure);
            const landlordSupplies = p.responsible_party === 'LANDLORD';
            const run = lastRun[p.id];
            return (
              <div key={p.id}
                className={'bg-white rounded-3xl border p-4 sm:p-5 ' +
                  (bucket.key === 'late' ? 'border-red-200' : bucket.key === 'soon' ? 'border-amber-200' : 'border-slate-100')}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <DORMV_Chip cls={bucket.cls} icon="Clock">
                        {bucket.label}{p.next_due_on ? ' · ' + DORMV_dueText(p.next_due_on) : ''}
                      </DORMV_Chip>
                      {p.is_legal_requirement && (
                        <DORMV_Chip icon="Scale" cls="bg-red-50 text-red-700 border-red-200">Jogszabályi kötelezettség</DORMV_Chip>
                      )}
                      {p.certificate_required && <DORMV_Chip icon="FileCheck">Bizonylatköteles</DORMV_Chip>}
                      {b && <DORMV_TenureChip tenure={b.tenure} />}
                    </div>
                    <h3 className="text-lg font-black text-slate-900 mt-2 break-words">{p.title}</h3>
                    <p className="text-[13px] text-slate-400 font-bold mt-0.5">
                      {p.code}{b ? ' · ' + b.name : ' · minden épület'}
                      {p.legal_reference ? ' · ' + p.legal_reference : ''}
                    </p>
                  </div>
                  {canWrite && (
                    <button onClick={() => setRunning(p)}
                      className="min-h-[44px] px-4 rounded-xl text-sm font-black bg-primary text-white hover:bg-primary/90 inline-flex items-center gap-2 flex-none">
                      <DORMV_Ic n="CheckCircle2" size={15} /> Elvégzés rögzítése
                    </button>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4">
                  <DORMV_KV label="Ciklus">
                    {p.interval_months ? p.interval_months + ' hónap' : p.interval_days ? p.interval_days + ' nap' : '—'}
                  </DORMV_KV>
                  <DORMV_KV label="Felelős">{DORMV_PM_RESP[p.responsible_party] || p.responsible_party}</DORMV_KV>
                  <DORMV_KV label="Szolgáltató">{p.vendor_name || p.service_contract_ref || '—'}</DORMV_KV>
                  <DORMV_KV label="Utolsó elvégzés">
                    {DORMV_d(p.last_done_on)}
                    {run && <span className="block text-[11px] font-black text-slate-400">{DORMV_PM_RESULT[run.result] || run.result}</span>}
                  </DORMV_KV>
                  <DORMV_KV label="Következő esedékesség">
                    <span className={bucket.key === 'late' ? 'text-red-600' : bucket.key === 'soon' ? 'text-amber-600' : ''}>
                      {DORMV_d(p.next_due_on)}
                    </span>
                  </DORMV_KV>
                </div>

                {/* Bérelt épület + bérbeadói felelősség: a feladat ÁTALAKUL. */}
                {leased && landlordSupplies && (
                  <div className="mt-4 rounded-2xl border-2 border-violet-200 bg-violet-50/60 px-4 py-3 flex items-start gap-3">
                    <DORMV_Ic n="Building2" size={16} className="mt-0.5 flex-none text-violet-700" />
                    <div className="min-w-0 text-[13px] text-violet-900 font-semibold leading-relaxed">
                      <b>A bizonylatot a bérbeadó szolgáltatja.</b> A feladat itt nem elmarad,
                      hanem átalakul: <b>bizonylat bekérése a bérbeadótól</b>, ugyanerre a
                      határidőre. A lakóért akkor is mi felelünk, ha az épület nem a miénk.
                      {run && run.certificate_file && <div className="mt-1 font-black">Utolsó bizonylat: {run.certificate_file}</div>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {running && (
        <DORMV_PmRunModal plan={running} onClose={() => setRunning(null)} onSaved={() => { setRunning(null); load(); }} />
      )}
    </div>
  );
}

function DORMV_PmRunModal({ plan, onClose, onSaved }) {
  const today = new Date().toISOString().slice(0, 10);
  const nextDefault = () => {
    const d = new Date();
    if (plan.interval_months) d.setMonth(d.getMonth() + Number(plan.interval_months));
    else if (plan.interval_days) d.setDate(d.getDate() + Number(plan.interval_days));
    else return '';
    return d.toISOString().slice(0, 10);
  };
  const [doneOn, setDoneOn] = useState(today);
  const [by, setBy] = useState(plan.vendor_name || '');
  const [result, setResult] = useState('OK');
  const [findings, setFindings] = useState('');
  const [cert, setCert] = useState('');
  const [next, setNext] = useState(nextDefault());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await DORMV_insert('pm_run', {
        plan_id: plan.id, done_on: doneOn, performed_by: by || null,
        result, findings: findings || null, certificate_file: cert || null,
        next_due_on: next || null,
      });
      // A terv esedékessége a rögzítés következménye, nem külön adminisztráció.
      try { await DORMV_update('pm_plan', plan.id, { last_done_on: doneOn, next_due_on: next || null }); }
      catch (e) { /* a run rögzült; a terv frissítéséhez szélesebb jog kell */ }
      onSaved();
    } catch (e) { setErr(DORMV_msg(e)); setBusy(false); }
  };

  return (
    <UModal open onClose={onClose} max="max-w-lg" title="Elvégzés rögzítése" subtitle={plan.title}
      icon={<DORMV_Ic n="CheckCircle2" size={20} />}>
      <DORMV_Err msg={err} onClose={() => setErr('')} />
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UField label="Elvégzés dátuma">
            <input type="date" className={U_input + ' min-h-[48px]'} value={doneOn} onChange={e => setDoneOn(e.target.value)} />
          </UField>
          <UField label="Ki végezte">
            <input className={U_input + ' min-h-[48px]'} value={by} onChange={e => setBy(e.target.value)} />
          </UField>
        </div>
        <UField label="Eredmény">
          <select className={U_input + ' min-h-[48px]'} value={result} onChange={e => setResult(e.target.value)}>
            {Object.keys(DORMV_PM_RESULT).map(k => <option key={k} value={k}>{DORMV_PM_RESULT[k]}</option>)}
          </select>
        </UField>
        {result !== 'OK' && (
          <UField label="Feltárt hiányosság" hint="A hiányosságból az üzemeltetés hibajegyet nyithat.">
            <textarea className={U_input + ' min-h-[90px] resize-y'} value={findings} onChange={e => setFindings(e.target.value)} />
          </UField>
        )}
        <UField label="Jegyzőkönyv / bizonylat azonosítója"
          hint={plan.certificate_required ? 'Ehhez a feladathoz bizonylat kötelező — hatósági ellenőrzéskor ezt kell elővenni.' : ''}>
          <input className={U_input + ' min-h-[48px]'} value={cert} onChange={e => setCert(e.target.value)} />
        </UField>
        <UField label="Következő esedékesség">
          <input type="date" className={U_input + ' min-h-[48px]'} value={next} onChange={e => setNext(e.target.value)} />
        </UField>
      </div>
      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <button disabled={busy} onClick={save} className={U_btnPrimary + ' min-h-[48px] w-full sm:w-auto'}>{busy ? 'Mentés…' : 'Rögzítés'}</button>
        <button onClick={onClose} className={U_btnGhost + ' min-h-[48px] w-full sm:w-auto'}>Mégsem</button>
      </div>
    </UModal>
  );
}

/* ============================================================
   10. DORM_MaintenanceView — a "Karbantartás" menüpont
   ------------------------------------------------------------
   Négy fül. A jogosultság NEM a profiles.role enumból jön (azt bővíteni a
   filteredMenuItems 'return false' ága miatt kockázatos volna), hanem a
   dorm.role_grant hatókörös dimenziójából, amit a dorm_my_roles() ad vissza.
   ============================================================ */

const DORMV_MAINT_TABS = [
  { id: 'issues', label: 'Bejelentések',       icon: 'AlertTriangle' },
  { id: 'orders', label: 'Munkalapok',         icon: 'ClipboardList' },
  { id: 'assets', label: 'Eszközök / leltár',  icon: 'Package' },
  { id: 'pm',     label: 'Időszakos feladatok', icon: 'CalendarClock' },
];

function DORM_MaintenanceView({ user }) {
  const [tab, setTab] = useState('issues');
  const [roles, setRoles] = useState(null);
  const [buildings, setBuildings] = useState([]);
  const [respRows, setRespRows] = useState([]);
  const [landlords, setLandlords] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [transitions, setTransitions] = useState([]);
  const [building, setBuilding] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      let r = {};
      try { r = (await DORM_api.myRoles()) || {}; }
      catch (e) { setErr(DORMV_msg(e)); }
      setRoles(r);

      // Egy kör lekérdezés, a fülek ebből dolgoznak. A listákat az RLS szűri:
      // aki csak egy épületre kapott grantot, csak azt az egyet kapja vissza.
      const [b, resp, ll, st, tr] = await Promise.all([
        DORMV_sel('building', q => q.order('code', { ascending: true })),
        DORMV_sel('responsibility', q => q.limit(1000)),
        DORMV_sel('landlord', q => q.limit(200)),
        DORMV_sel('issue_status', q => q.order('sort_order', { ascending: true })),
        DORMV_sel('issue_status_transition', q => q.limit(400)),
      ]);
      // Ha a tábla nem olvasható (pl. a landlord a KARBANTARTO-nak nem az),
      // az ÜRES lista a helyes válasz — nem hiba, és nem is kell jelezni.
      let list = b.rows;
      if (!list.length && Array.isArray(r.epuletek)) list = r.epuletek;
      setBuildings(list);
      setRespRows(resp.rows);
      setLandlords(ll.rows);
      const map = {}; st.rows.forEach(s => { map[s.code] = s; });
      setStatuses(map);
      setTransitions(tr.rows);
    })();
  }, []);

  if (roles === null) return <DORMV_Loading text="Kollégiumi jogosultságok betöltése…" />;

  const rolesList = Array.isArray(roles.szerepkorok) ? roles.szerepkorok : [];
  const isAdminUser = !!user && (user.role === 'ADMIN' || user.role === 'SUPERADMIN');
  const canWrite = isAdminUser || rolesList.some(r => ['GONDNOK', 'KARBANTARTO', 'KOLI_ADMIN', 'KOLI_SYSADMIN'].includes(r));
  const noAccess = !isAdminUser && rolesList.length === 0;

  const tabs = DORMV_MAINT_TABS;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl 2xl:max-w-[1600px]" data-echo-noi18n>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-black text-primary uppercase tracking-widest">Kollégium- és ingatlanüzemeltetés</p>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight mt-1">Karbantartás</h1>
          <p className="text-slate-500 mt-2 max-w-2xl leading-relaxed text-sm sm:text-base">
            Hibabejelentések, munkalapok, leltár és időszakos feladatok. Bérelt épületnél
            a felelősségi mátrix mondja meg, <b>kihez</b> megy a hiba, <b>mi a határidő</b>
            {' '}és <b>melyik szerződéspont</b> alapján — a szerződést nem kell előkeresni.
          </p>
        </div>
        <div className="w-full sm:w-auto flex flex-wrap items-center gap-2">
          {rolesList.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {rolesList.map(r => <DORMV_Chip key={r} icon="ShieldCheck" cls="bg-primary/10 text-primary border-primary/20">{r}</DORMV_Chip>)}
            </div>
          )}
          <DORMV_BuildingPicker buildings={buildings} value={building} onChange={setBuilding} />
        </div>
      </div>

      <DORMV_Err msg={err} onClose={() => setErr('')} />

      {noAccess ? (
        <div className="mt-7">
          <DORMV_Empty icon="ShieldAlert" title="Nincs kollégiumi üzemeltetői jogosultságod"
            subtitle="A karbantartási nézethez GONDNOK, KARBANTARTO, KOLI_ADMIN vagy KOLI_SYSADMIN felhatalmazás kell, épület-hatókörrel. A felhatalmazást a Kollégium menüpont Szerepkörök fülén osztják ki." />
        </div>
      ) : (
        <div className="mt-7">
          <DORMV_Tabs tabs={tabs} tab={tab} setTab={setTab} />
          {tab === 'issues' && <DORMV_IssuesPanel buildings={buildings} building={building} respRows={respRows} landlords={landlords} canWrite={canWrite} />}
          {tab === 'orders' && <DORMV_WorkOrdersPanel buildings={buildings} building={building} respRows={respRows} landlords={landlords} statuses={statuses} transitions={transitions} canWrite={canWrite} />}
          {tab === 'assets' && <DORMV_AssetsPanel buildings={buildings} building={building} canWrite={canWrite} />}
          {tab === 'pm' && <DORMV_PmPanel buildings={buildings} building={building} respRows={respRows} canWrite={canWrite} />}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   11. SZÁLLÁSOM — a LAKÓ saját nézete
   ------------------------------------------------------------
   Alap: dorm_my_placement(). Ez a függvény SZEMÉLY-PARAMÉTERT NEM FOGAD —
   a lakó a sajátját mindig látja, máséhoz semmilyen paraméterrel nem fér
   hozzá. A többi adatot (szerződés, kaució, díjtételek, saját bejelentések)
   közvetlenül a dorm sémából olvassuk, person_id-re szűrve; az RLS ugyanezt
   a szűkítést amúgy is elvégzi — az explicit szűrő csak azért van, hogy egy
   pénzügyes vagy admin fiók se lássa itt véletlenül mások tételeit.
   ============================================================ */

/* Oszinte ures allapot a meg meg nem irt hallgatoi fulekhez. Inkabb mondjuk
   ki, hogy nincs kesz, mint hogy a nezet osszeomoljon — vagy hogy a fulet
   csendben eltuntessuk, es senki ne tudja, hogy tervben van. */
function DORMV_Keszul({ cim, szoveg, ikon }) {
  return (
    <div className="bg-white rounded-3xl border border-slate-100 p-8 text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-50 mb-3">
        <DORMV_Ic n={ikon || 'Construction'} size={22} className="text-slate-300" />
      </div>
      <h3 className="font-black text-slate-800">{cim}</h3>
      <p className="text-sm text-slate-400 font-medium mt-1.5 max-w-md mx-auto leading-relaxed">{szoveg}</p>
    </div>
  );
}

const DORMV_STUDENT_TABS = [
  { id: 'contract', label: 'Szerződésem',    icon: 'FileSignature' },
  { id: 'room',     label: 'Szobám',         icon: 'DoorOpen' },
  { id: 'report',   label: 'Hibabejelentés', icon: 'AlertTriangle' },
  { id: 'bills',    label: 'Számláim',       icon: 'Wallet' },
];

/* Az aktuális elhelyezés: az, ami MA tart. Ha nincs ilyen, a legfrissebb —
   a kiköltözött lakónak is látnia kell az elszámolását. */
function DORMV_currentPlacement(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const active = list.find(p => String(p.tol || '') <= today && (!p.ig || String(p.ig) > today) && p.allapot !== 'CANCELLED');
  return active || list[0];
}

function DORM_StudentView({ user }) {
  const [tab, setTab] = useState('contract');
  const [placement, setPlacement] = useState(null);   // null = tölt, false = hiba
  const [err, setErr] = useState('');
  const [ctx, setCtx] = useState({ building: null, room: null });

  const load = async () => {
    setErr('');
    try {
      const p = await DORM_api.myPlacement();
      setPlacement(p || { lako: false, elhelyezesek: [] });
    } catch (e) { setErr(DORMV_msg(e)); setPlacement(false); }
  };
  useEffect(() => { load(); }, []);

  const current = placement && placement.elhelyezesek ? DORMV_currentPlacement(placement.elhelyezesek) : null;

  // Az épület és a szoba azonosítója a bejelentő űrlaphoz kell. A lakó
  // pontosan a SAJÁT épületét és szobáját kapja vissza (RLS) — másét nem.
  useEffect(() => {
    (async () => {
      if (!current) return;
      const b = await DORMV_sel('building', q => q.eq('code', current.epulet_kod).limit(1));
      const bid = b.rows[0] && b.rows[0].id;
      let room = null;
      if (bid && current.szoba) {
        const r = await DORMV_sel('room', q => q.eq('building_id', bid).eq('full_code', current.szoba).limit(1));
        room = r.rows[0] || null;
      }
      setCtx({ building: b.rows[0] || null, room });
    })();
  }, [current && current.occupancy_id]);

  if (placement === null) return <DORMV_Loading text="Kollégiumi adatok betöltése…" />;

  const hasPlacement = !!(placement && placement.lako && current);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl 2xl:max-w-[1200px]" data-echo-noi18n>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-black text-primary uppercase tracking-widest">Kollégium</p>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight mt-1">Szállásom</h1>
          {hasPlacement && (
            <p className="text-slate-500 mt-2 leading-relaxed text-sm sm:text-base">
              <b className="text-slate-800">{current.epulet}</b> · {current.szoba}
              {current.ferohely ? ' · ' + current.ferohely : ''} ·{' '}
              {DORMV_d(current.tol)} – {current.ig ? DORMV_d(current.ig) : 'határozatlan ideig'}
            </p>
          )}
        </div>
        {hasPlacement && (
          <div className="flex flex-wrap gap-2">
            <DORMV_Chip icon="BedDouble" cls="bg-primary/10 text-primary border-primary/20">
              {DORMV_OCC_STATE[current.allapot] || current.allapot}
            </DORMV_Chip>
            <DORMV_TenureChip tenure={current.jogcim} />
            {current.nyitott_hibak > 0 && (
              <DORMV_Chip icon="AlertTriangle" cls="bg-amber-50 text-amber-700 border-amber-200">
                {current.nyitott_hibak} nyitott hiba a szobában
              </DORMV_Chip>
            )}
          </div>
        )}
      </div>

      <DORMV_Err msg={err} onClose={() => setErr('')} />

      {!hasPlacement ? (
        <div className="mt-7">
          <DORMV_Empty icon="BedDouble" title="Jelenleg nincs kollégiumi helyed"
            subtitle="Ez nem hiba: a rendszer egyszerűen nem talált hozzád tartozó, élő elhelyezést." />
          <div className="mt-4 bg-white rounded-3xl border border-slate-100 p-5 sm:p-6">
            <h3 className="font-black text-slate-800">Hol tudsz jelentkezni?</h3>
            <ul className="mt-3 space-y-3 text-sm text-slate-600 leading-relaxed">
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-none text-[11px] font-black">1</span>
                <span>A <b>felvételi jelentkezés</b> során jelezd, hogy kérsz kollégiumot. A jelzés a felvételi ügyintézőhöz fut be, és a felvételi döntéssel együtt kerül elbírálásra.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-none text-[11px] font-black">2</span>
                <span>Ha már hallgató vagy, a <b>kollégiumi ügyintézőnél</b> tudsz kérelmet benyújtani. A helyek elbírálása pontozás és kvóta alapján történik.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-none text-[11px] font-black">3</span>
                <span>Ha úgy tudod, hogy <b>már van helyed</b>, de itt mégsem látszik, akkor a kollégiumi nyilvántartásban a fiókod még nincs összekötve a kollégista-ói törzsadatoddal. Szólj a kollégiumi ügyintézőnek — egy kattintással összekötik.</span>
              </li>
            </ul>
            <button onClick={load} className={U_btnGhost + ' mt-5 min-h-[48px] w-full sm:w-auto'}>
              <DORMV_Ic n="RefreshCw" size={15} /> Újra megnézem
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-7">
          <DORMV_Tabs tabs={DORMV_STUDENT_TABS} tab={tab} setTab={setTab} />
          {tab === 'contract' && <DORMV_MyContract placement={placement} current={current} />}
          {tab === 'room' && <DORMV_MyRoom placement={placement} current={current} ctx={ctx} />}
          {/* KIADOTT HIBA VOLT: ez a ket ful a DORMV_MyReport / DORMV_MyBills
              komponensre hivatkozott, amiket SOHA senki nem irt meg — a
              hallgato ReferenceError-t es feher kepernyot kapott, amint
              rakattintott. A ful megmarad (a funkcio tervezett), de mostantol
              kimondja, hogy meg nincs kesz, ahelyett hogy osszeomlana. */}
          {tab === 'report' && (
            <DORMV_Keszul
              cim="Hibabejelentés"
              szoveg="Ez a felület még nem készült el. Addig a hibát a gondnoknak jelezd — a
                      kollégiumi ügyintézők a Karbantartás menüpontban rögzítik és követik."
              ikon="AlertTriangle" />
          )}
          {tab === 'bills' && (
            <DORMV_Keszul
              cim="Számláim"
              szoveg="Ez a felület még nem készült el. A díjaidról és a kaucióról a kollégiumi
                      ügyintéző tud felvilágosítást adni."
              ikon="Wallet" />
          )}
        </div>
      )}
    </div>
  );
}

/* --- 11.1 Szerződésem ----------------------------------------------------- */

function DORMV_MyContract({ placement, current }) {
  const [contracts, setContracts] = useState(null);
  const [deposits, setDeposits] = useState([]);
  const [err, setErr] = useState('');
  const [dl, setDl] = useState('');

  useEffect(() => {
    (async () => {
      const pid = placement.person_id;
      const [c, d] = await Promise.all([
        DORMV_sel('contract', q => (pid ? q.eq('person_id', pid) : q).order('starts_on', { ascending: false }).limit(20)),
        DORMV_sel('deposit', q => (pid ? q.eq('person_id', pid) : q).eq('direction', 'HELD_FROM_RESIDENT').limit(20)),
      ]);
      if (c.error) setErr(c.error);
      setContracts(c.rows); setDeposits(d.rows);
    })();
  }, [placement.person_id]);

  if (contracts === null) return <DORMV_Loading text="Szerződés betöltése…" />;

  const active = contracts.find(c => current.szerzodes && c.iktatoszam === current.szerzodes) || contracts[0] || null;

  const download = async () => {
    if (!active || !active.file_path) return;
    setDl('…');
    const url = await DORMV_photoUrl({ path: active.file_path });
    setDl('');
    if (url) window.open(url, '_blank', 'noopener');
    else setErr('A szerződés fájlja most nem érhető el. Kérd a kollégiumi ügyintézőtől.');
  };

  return (
    <div>
      <DORMV_Err msg={err} onClose={() => setErr('')} />

      {!active ? (
        <DORMV_Empty icon="FileSignature" title="Nincs rögzített szerződés"
          subtitle="Az elhelyezésed él, de szerződés még nincs hozzákötve. Ez tipikusan a beköltözés előtti napokban fordul elő — a kollégiumi ügyintéző tudja pótolni." />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <DORMV_Stat label="Havi díj" value={DORMV_huf(active.monthly_fee, active.fee_currency)} icon="Wallet" tone="primary" />
            <DORMV_Stat label="Kaució" value={DORMV_huf(active.deposit_amount, active.deposit_currency)} icon="PiggyBank"
              hint="a kiköltözés után visszajár" />
            <DORMV_Stat label="Szerződés típusa" value={DORMV_CONTRACT_KIND[active.contract_kind] || active.contract_kind} icon="FileSignature" />
            <DORMV_Stat label="Hátralévő idő"
              value={active.ends_on ? Math.max(0, DORMV_daysTo(active.ends_on)) + ' nap' : 'határozatlan'} icon="CalendarClock" />
          </div>

          <div className="mt-5 bg-white rounded-3xl border border-slate-100 p-5 sm:p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              <DORMV_KV label="Iktatószám">{active.iktatoszam}</DORMV_KV>
              <DORMV_KV label="Időszak">{DORMV_d(active.starts_on)} – {active.ends_on ? DORMV_d(active.ends_on) : 'határozatlan'}</DORMV_KV>
              <DORMV_KV label="Szoba">{current.szoba}{current.ferohely ? ' · ' + current.ferohely : ''}</DORMV_KV>
              <DORMV_KV label="Épület">{current.epulet}</DORMV_KV>
              <DORMV_KV label="Aláírva">
                {DORMV_dt(active.signed_at)}
                {active.signature_mode && (
                  <span className="block text-[11px] font-black text-slate-400">
                    {active.signature_mode === 'ELECTRONIC' ? 'elektronikusan' : 'papíron, beszkennelve'}
                  </span>
                )}
              </DORMV_KV>
              <DORMV_KV label="Házirend verziója">{active.house_rules_version}</DORMV_KV>
            </div>

            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              {active.file_path ? (
                <button onClick={download} className={U_btnPrimary + ' min-h-[48px] w-full sm:w-auto'}>
                  <DORMV_Ic n="Download" size={16} /> {dl ? 'Megnyitás…' : 'Szerződés letöltése'}
                </button>
              ) : (
                <div className="text-sm text-slate-400 font-semibold flex items-center gap-2">
                  <DORMV_Ic n="Info" size={15} /> A szerződés elektronikus példánya még nincs feltöltve.
                </div>
              )}
            </div>
          </div>

          {deposits.length > 0 && (
            <div className="mt-5 bg-white rounded-3xl border border-slate-100 p-5 sm:p-6">
              <h3 className="font-black text-slate-800">Kaució</h3>
              <p className="text-sm text-slate-500 mt-1 leading-relaxed">
                A kaució nem díj, hanem <b>letét</b>: a kiköltözés és a kárelszámolás után visszajár.
              </p>
              <div className="mt-4 space-y-3">
                {deposits.map(d => (
                  <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-50 pt-3 first:border-0 first:pt-0">
                    <div className="min-w-0">
                      <div className="font-black text-slate-800">{DORMV_huf(d.amount, d.currency)}</div>
                      <div className="text-[12px] text-slate-400 font-bold">
                        Befizetve: {DORMV_d(d.received_on)}{d.due_back_on ? ' · visszajár: ' + DORMV_d(d.due_back_on) : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <DORMV_Chip>{DORMV_DEPOSIT_STATUS[d.status] || d.status}</DORMV_Chip>
                      {Number(d.deductions) > 0 && (
                        <DORMV_Chip cls="bg-amber-50 text-amber-700 border-amber-200">
                          Levonás: {DORMV_huf(d.deductions, d.currency)}
                        </DORMV_Chip>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {deposits.some(d => d.settlement_blocked_reason) && (
                <div className="mt-4 text-[13px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  A visszafizetés jelenleg akadályozott: {deposits.filter(d => d.settlement_blocked_reason).map(d => d.settlement_blocked_reason).join(' · ')}
                </div>
              )}
            </div>
          )}

          {placement.elhelyezesek.length > 1 && (
            <div className="mt-5 bg-white rounded-3xl border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 font-black text-slate-800">Korábbi elhelyezéseim</div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px]">
                  <thead>
                    <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                      <th className="text-left px-5 py-2.5">Épület</th>
                      <th className="text-left px-5 py-2.5">Szoba</th>
                      <th className="text-left px-5 py-2.5">Időszak</th>
                      <th className="text-left px-5 py-2.5">Állapot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {placement.elhelyezesek.map(p => (
                      <tr key={p.occupancy_id} className="border-b border-slate-50 last:border-0">
                        <td className="px-5 py-3 text-[13px] font-bold text-slate-700">{p.epulet}</td>
                        <td className="px-5 py-3 text-[13px] text-slate-600">{p.szoba}</td>
                        <td className="px-5 py-3 text-[13px] text-slate-500 whitespace-nowrap">
                          {DORMV_d(p.tol)} – {p.ig ? DORMV_d(p.ig) : '…'}
                        </td>
                        <td className="px-5 py-3"><DORMV_Chip>{DORMV_OCC_STATE[p.allapot] || p.allapot}</DORMV_Chip></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* --- 11.2 Szobám ---------------------------------------------------------- */

function DORMV_MyRoom({ placement, current, ctx }) {
  const [mates, setMates] = useState(null);
  const [assets, setAssets] = useState([]);
  const [assetErr, setAssetErr] = useState(false);

  useEffect(() => {
    (async () => {
      // SZOBATÁRSAK: csak akkor jelennek meg, ha az adatbázis visszaadja őket.
      // A dorm.v_room_occupancy nézet a can_see_residents() körre szűr, amiben
      // a lakó NINCS benne — tehát üres választ várunk, és ez a HELYES
      // viselkedés. A felület nem próbál más úton a nevekhez jutni.
      const m = await DORMV_sel('v_room_occupancy', q =>
        (ctx.room ? q.eq('room_id', ctx.room.id) : q).limit(20));
      const others = m.rows.filter(r => r.person_id !== placement.person_id);
      setMates(others);

      if (ctx.room) {
        const a = await DORMV_sel('asset', q => q.eq('room_id', ctx.room.id).eq('is_active', true).limit(100));
        setAssets(a.rows);
        setAssetErr(!!a.error || (!a.rows.length));
      } else { setAssets([]); setAssetErr(true); }
    })();
  }, [ctx.room && ctx.room.id, placement.person_id]);

  const room = ctx.room;

  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <DORMV_Stat label="Szoba" value={current.szoba} icon="DoorOpen" />
        <DORMV_Stat label="Szint" value={current.szint == null ? '—' : (current.szint === 0 ? 'földszint' : current.szint + '.')} icon="Layers" />
        <DORMV_Stat label="Férőhelyem" value={current.ferohely || '—'} icon="BedDouble" />
        <DORMV_Stat label="Nyitott hiba" value={current.nyitott_hibak || 0}
          tone={current.nyitott_hibak ? 'amber' : 'slate'} icon="AlertTriangle" />
      </div>

      {room && (
        <div className="mt-5 bg-white rounded-3xl border border-slate-100 p-5 sm:p-6">
          <h3 className="font-black text-slate-800">A szoba felszereltsége</h3>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <DORMV_KV label="Típus">{room.room_type}</DORMV_KV>
            <DORMV_KV label="Alapterület">{room.area_sqm ? room.area_sqm + ' m²' : '—'}</DORMV_KV>
            <DORMV_KV label="Fürdő">{DORMV_BATHROOM[room.bathroom] || room.bathroom}</DORMV_KV>
            <DORMV_KV label="Konyha">{DORMV_KITCHEN[room.kitchen] || room.kitchen}</DORMV_KV>
            <DORMV_KV label="Internet">{room.internet === 'NONE' ? 'nincs' : room.internet}</DORMV_KV>
            <DORMV_KV label="Egyéb">
              {[room.has_fridge && 'hűtő', room.has_balcony && 'erkély', room.has_aircon && 'klíma',
                room.is_accessible && 'akadálymentes', room.quiet_room && 'csendes szoba']
                .filter(Boolean).join(' · ') || '—'}
            </DORMV_KV>
          </div>
        </div>
      )}

      <div className="mt-5 bg-white rounded-3xl border border-slate-100 p-5 sm:p-6">
        <h3 className="font-black text-slate-800">Szobatársak</h3>
        {mates === null ? (
          <p className="text-sm text-slate-400 mt-2">Betöltés…</p>
        ) : mates.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {mates.map(m => (
              <li key={m.occupancy_id} className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-50 pt-3 first:border-0 first:pt-0">
                <div className="min-w-0">
                  <div className="font-bold text-slate-800 break-words">{m.display_name}</div>
                  <div className="text-[12px] text-slate-400 font-bold">{m.bed_code}</div>
                </div>
                <DORMV_Chip>{DORMV_OCC_STATE[m.state] || m.state}</DORMV_Chip>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3">
            <DORMV_Hidden label="Szobatársak"
              reason="A „ki hol lakik” a modul legérzékenyebb adata: a szobatársak nevét az adatbázis nem adja ki más lakónak. Ha meg szeretnétek ismerni egymást, a gondnok tud segíteni." />
            <p className="text-sm text-slate-500 mt-3 leading-relaxed">
              A szobatársak neve <b>adatvédelmi okból rejtett</b>. Ezt nem a felület dönti el:
              a szűrés az adatbázisban történik, és rád ugyanígy vonatkozik — a te nevedet
              sem látja más lakó.
            </p>
          </div>
        )}
      </div>

      <div className="mt-5 bg-white rounded-3xl border border-slate-100 p-5 sm:p-6">
        <h3 className="font-black text-slate-800">Szobaleltár</h3>
        {assets.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[420px]">
              <thead>
                <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                  <th className="text-left px-0 py-2">Megnevezés</th>
                  <th className="text-left px-3 py-2">Típus</th>
                  <th className="text-left px-3 py-2">Állapot</th>
                </tr>
              </thead>
              <tbody>
                {assets.map(a => (
                  <tr key={a.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-0 py-2.5 text-[13px] font-bold text-slate-700">{a.name}</td>
                    <td className="px-3 py-2.5 text-[13px] text-slate-500">{a.asset_type}</td>
                    <td className="px-3 py-2.5 text-[13px] text-slate-500">{DORMV_COND[a.condition_grade] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500 mt-2 leading-relaxed">
            A szoba leltárát az üzemeltetés vezeti, és a beköltözési jegyzőkönyv tartalmazza.
            Ha eltérést látsz a jegyzőkönyvhöz képest, jelezd a gondnoknak — a kiköltözéskori
            kárelszámolás alapja ez a lista.
          </p>
        )}
      </div>

      <div className="mt-5 bg-white rounded-3xl border border-slate-100 p-5 sm:p-6">
        <h3 className="font-black text-slate-800">Házirend</h3>
        <p className="text-sm text-slate-500 mt-2 leading-relaxed">
          A rád vonatkozó házirend verziója a szerződésedhez van rögzítve — később sem
          változik visszamenőleg. A hatályos szöveget a kollégiumi ügyintézőnél és a
          faliújságon találod meg.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-slate-600">
          {[
            'Csendes idő és vendégfogadás rendje',
            'A közös helyiségek használata és takarítási rend',
            'Tűzvédelem: mit tilos a szobában használni',
            'Kulcs, beléptetőkártya, elvesztés esetén a teendő',
            'Kárfelelősség és a kaució elszámolása',
          ].map(t => (
            <li key={t} className="flex items-start gap-2.5">
              <DORMV_Ic n="Dot" size={16} className="text-primary mt-0.5 flex-none" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
