/* ============================================================
   UniPortal Pro — Regisztráció-jóváhagyás (superadmin)
   (az app.jsx moduljába fűzve — NINCS import; React, hookok,
    Lucide, sb, todayStr a scope-ban vannak)

   Minden új regisztráció `pending` státusszal jön létre
   (07_registration_approval.sql), és a superadmin dönt róla. A
   jogosultságot nem ez a felület adja: a profiles UPDATE-et RLS +
   a profiles_protect_privileges trigger engedi vagy tiltja, tehát
   más fiókból ugyanez a hívás elbukik.
   ============================================================ */

/* A KIOSZTHATÓ SZEREPKÖRÖK — a role_definition táblából, nem kódba égetve.
   MI VOLT A BAJ: a lista kódba égetett volt:
       const REG_ASSIGNABLE_ROLES = ['STUDENT','AGENT','ADMISSIONS','FINANCE','ADMIN'];
   A 39-es migráció óta a szuperadmin LÉTREHOZHAT saját szerepkört, a 72-es óta
   jogot is adhat neki — de kiosztani senkinek nem tudta, mert ez a választó nem
   ismerte. Egy szerepkör, amit senki nem viselhet, nem szerepkör.

   A SUPERADMIN szándékosan kimarad: azt nem ebből a felületről kell adni
   (deploy/make-superadmin.sh), és a profiles_protect_privileges trigger is
   csak szuperadminnak engedi a role írását.

   Tartalék: ha a role_definition nem érhető el (a 39-es nem futott le), a
   listánk BETŰRE a régi, kódba égetett lista — a képernyő attól még működik. */
const REG_ROLES_TARTALEK = ['STUDENT', 'AGENT', 'ADMISSIONS', 'FINANCE', 'ADMIN'];
const REG_LABEL_TARTALEK = {
  STUDENT: 'Hallgató', AGENT: 'Ügynök', ADMISSIONS: 'Felvételi',
  FINANCE: 'Pénzügy', ADMIN: 'Admin', SUPERADMIN: 'Superadmin',
};

async function REG_loadRoles() {
  if (!window.sb) return null;
  try {
    const { data, error } = await window.sb
      .from('role_definition').select('kod, nev, aktiv, szin').order('sorrend');
    if (error || !Array.isArray(data) || !data.length) return null;
    return data;
  } catch (e) { return null; }
}

/* A REG_ROLE_LABEL és a REG_ASSIGNABLE_ROLES a betöltött listából képződik.
   Modul-szintű `let`, mert a RegistrationsView töltéskor beállítja, és a
   render-függvények (nem komponensek) is hivatkoznak rá. */
let REG_ROLE_DEFS = null;
const REG_ROLE_LABEL = new Proxy({}, {
  get: (_t, kod) => {
    if (typeof kod !== 'string') return undefined;
    const d = REG_ROLE_DEFS && REG_ROLE_DEFS.find(x => x.kod === kod);
    return (d && d.nev) || REG_LABEL_TARTALEK[kod] || kod;
  },
});
const REG_assignableRoles = () => REG_ROLE_DEFS
  ? REG_ROLE_DEFS.filter(d => d.aktiv && d.kod !== 'SUPERADMIN').map(d => d.kod)
  : REG_ROLES_TARTALEK;

const REG_STATUS_STYLE = {
  pending:  { label: 'Jóváhagyásra vár', cls: 'bg-amber-50 text-amber-700 border-amber-100' },
  approved: { label: 'Jóváhagyva',       cls: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  rejected: { label: 'Elutasítva',       cls: 'bg-red-50 text-red-600 border-red-100' },
};

/* A registration_directory nézet a profilt ÉS a hallgatói besorolást
   (tagozat, képzési szint, szak, kar) meg a csoporttagságot is hozza — egy
   lekérdezésben. Ha a 38-as migráció még nem futott le, visszaesünk a puszta
   profiles táblára, hogy a képernyő attól még használható maradjon. */
async function REG_loadProfiles() {
  if (!window.sb) return [];
  const v = await window.sb.from('registration_directory').select('*')
    .order('created_at', { ascending: false });
  if (!v.error && Array.isArray(v.data)) return v.data;
  const { data, error } = await window.sb.from('profiles').select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/* Mi szerint lehet csoportosítani. A kulcs a nézet oszlopneve. */
const REG_GROUP_BY = [
  ['', 'Nincs csoportosítás'],
  ['tagozat', 'Tagozat'],
  ['kepzesi_szint', 'Képzési szint'],
  ['szak', 'Szak'],
  ['kar', 'Kar'],
  ['role', 'Szerepkör'],
];

// A superadmin döntése. `role` csak jóváhagyáskor számít.
async function REG_decide(row, status, role, reason) {
  const patch = { approval_status: status };
  if (status === 'approved' && role) patch.role = role;
  if (status === 'rejected') patch.rejected_reason = reason || null;
  const { error } = await window.sb.from('profiles').update(patch).eq('id', row.id);
  if (error) throw error;
}

// Meglévő felhasználó szerepkörének átállítása. Ugyanaz az RLS + trigger
// engedélyezi, mint a jóváhagyást: a profiles_protect_privileges csak akkor
// engedi át a `role` mezőt, ha superadmin írja.
async function REG_setRole(row, role) {
  const { error } = await window.sb.from('profiles').update({ role }).eq('id', row.id);
  if (error) throw error;
}

/* Hány regisztráció vár döntésre? A belépéskori kezdőnézethez is ezt hívjuk. */
async function REG_pendingCount() {
  if (!window.sb) return 0;
  try {
    const { count, error } = await window.sb
      .from('profiles').select('id', { count: 'exact', head: true }).eq('approval_status', 'pending');
    return error ? 0 : (count || 0);
  } catch (e) { return 0; }
}

function REG_fmtDate(v) {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return String(v).slice(0, 16); }
}

/* A hallgatói besorolás egy cellában. Csak azt mutatja, ami VAN — a
   k-küszöb miatt egyes mezők szándékosan üresek maradhatnak, és az üres
   mező nem hiba, hanem adatvédelmi döntés. */
const REG_Chip = ({ text, tone }) => !text ? null : (
  <span className={'inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold whitespace-nowrap ' +
    (tone || 'bg-slate-50 text-slate-600 border-slate-200')}>{text}</span>
);

/* A besorolás szerkesztése. Legördülőkkel, nem szabad szöveggel: egy kézzel
   beírt "Levelezõ" némán külön kategóriát csinálna, a csoportszabályok pedig
   pontos egyezésre mennek. Az értékkészlet a ténylegesen előforduló
   értékekből jön, darabszámmal.

   Az üres választás TÖRLI a mezőt — ez értelmes művelet, mert a k-küszöb
   miatt egyes hallgatóknál szándékosan nincs kar megadva. */
const REG_ATTR_MEZOK = [
  ['tagozat',       'Tagozat'],
  ['kepzesi_szint', 'Képzési szint'],
  ['szak',          'Szak'],
  ['kar',           'Kar'],
];

function REG_BesorolasSzerk({ r, opciok, onSaved, onClose }) {
  const [ertek, setErtek] = useState({
    tagozat: r.tagozat || '', kepzesi_szint: r.kepzesi_szint || '',
    szak: r.szak || '', kar: r.kar || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      const { error } = await window.sb.rpc('student_attributes_save', {
        p_profile: r.id,
        p_tagozat: ertek.tagozat, p_kepzesi_szint: ertek.kepzesi_szint,
        p_szak: ertek.szak, p_kar: ertek.kar,
      });
      if (error) throw error;
      onSaved && await onSaved();
      onClose && onClose();
    } catch (e) {
      setErr((e && (e.message || e.details)) || 'A mentés nem sikerült.');
    } finally { setBusy(false); }
  };

  return (
    <div className="min-w-[260px] space-y-2">
      {REG_ATTR_MEZOK.map(([k, cimke]) => (
        <div key={k}>
          <label className="text-[10px] font-bold text-slate-400 uppercase">{cimke}</label>
          <select value={ertek[k]} onChange={e => setErtek(v => ({ ...v, [k]: e.target.value }))}
            className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[13px] text-slate-700 mt-0.5">
            <option value="">— nincs megadva —</option>
            {((opciok && opciok[k]) || []).map(o => (
              <option key={o.ertek} value={o.ertek}>{o.ertek} ({o.db})</option>
            ))}
            {/* A jelenlegi érték akkor is választható maradjon, ha a
                listában nem szerepel — különben mentéskor némán elveszne. */}
            {ertek[k] && !((opciok && opciok[k]) || []).some(o => o.ertek === ertek[k]) && (
              <option value={ertek[k]}>{ertek[k]}</option>
            )}
          </select>
        </div>
      ))}
      {err && <div className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">{err}</div>}
      <div className="flex gap-2 pt-1">
        <button onClick={ment} disabled={busy}
          className="flex-1 rounded-lg bg-primary text-white text-xs font-bold py-1.5 disabled:opacity-50">
          {busy ? 'Mentés…' : 'Mentés'}
        </button>
        <button onClick={onClose} className="rounded-lg border border-slate-200 text-slate-500 text-xs font-bold px-3 py-1.5">
          Mégse
        </button>
      </div>
    </div>
  );
}

function REG_Besorolas({ r, szerkesztheto, opciok, onSaved }) {
  const [nyit, setNyit] = useState(false);
  if (nyit) return <REG_BesorolasSzerk r={r} opciok={opciok} onSaved={onSaved} onClose={() => setNyit(false)} />;

  const van = r.tagozat || r.kepzesi_szint || r.szak || r.kar;
  if (!van) return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-slate-300">—</span>
      {szerkesztheto && (
        <button onClick={() => setNyit(true)} title="Besorolás megadása"
          className="text-[11px] font-bold text-primary hover:underline">megadom</button>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-1 min-w-[190px] group">
      <div className="flex items-start gap-1.5">
        {r.szak && <span className="text-[13px] font-bold text-slate-700 leading-tight flex-1">{r.szak}</span>}
        {szerkesztheto && (
          <button onClick={() => setNyit(true)} title="Besorolás módosítása"
            className="flex-none text-slate-300 hover:text-primary transition-colors">
            <Lucide.Pencil size={13} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <REG_Chip text={r.tagozat} tone="bg-indigo-50 text-indigo-700 border-indigo-100" />
        <REG_Chip text={r.kepzesi_szint} />
      </div>
      {r.kar && <span className="text-[10px] text-slate-400 leading-tight">{r.kar}</span>}
      {Array.isArray(r.csoportok) && r.csoportok.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {r.csoportok.map(g => (
            <REG_Chip key={g} text={g} tone="bg-emerald-50 text-emerald-700 border-emerald-100" />
          ))}
        </div>
      )}
    </div>
  );
}

function RegistrationsView({ user, onCountChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('pending');
  const [busyId, setBusyId] = useState('');
  const [roleDraft, setRoleDraft] = useState({});   // profileId -> role
  const [rejecting, setRejecting] = useState(null); // profile row
  const [reason, setReason] = useState('');
  const [q, setQ] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [attrOpciok, setAttrOpciok] = useState(null);

  const load = async () => {
    setErr('');
    try {
      // A szerepkör-definíciók a kiosztható lista és a feliratok forrása.
      // Nem blokkoló: ha nem jön, a kódba égetett tartalék dönt.
      const defs = await REG_loadRoles();
      if (defs) REG_ROLE_DEFS = defs;
      const data = await REG_loadProfiles();
      setRows(data);
      onCountChange && onCountChange(data.filter(r => r.approval_status === 'pending').length);
    } catch (e) {
      setRows([]);
      setErr(e && e.message ? e.message : 'A regisztrációk betöltése nem sikerült.');
    }
  };
  useEffect(() => { load(); }, []);

  /* A besorolás legördülőinek értékkészlete. Külön hívás, mert a
     registration_directory csak a MEGLÉVŐ értékeket hozza soronként — a
     választható halmazhoz az összes előforduló érték kell. */
  useEffect(() => {
    if (!window.sb) return;
    window.sb.rpc('student_attribute_options')
      .then(({ data, error }) => { if (!error && data) setAttrOpciok(data); })
      .catch(() => {});   /* a 40-es migráció még nem futott le */
  }, []);

  const changeRole = async (row, role) => {
    setBusyId(row.id); setErr('');
    try { await REG_setRole(row, role); await load(); }
    catch (e) { setErr((e && e.message) || 'A szerepkör módosítása nem sikerült.'); }
    finally { setBusyId(''); }
  };

  const decide = async (row, status, role, why) => {
    setBusyId(row.id); setErr('');
    try { await REG_decide(row, status, role, why); await load(); }
    catch (e) { setErr((e && e.message) || 'A módosítás nem sikerült.'); }
    finally { setBusyId(''); setRejecting(null); setReason(''); }
  };

  if (rows === null) {
    return (
      <div className="p-8 flex items-center gap-3 text-slate-400">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
        Regisztrációk betöltése…
      </div>
    );
  }

  /* A keresés a besorolásra is illeszkedik: "gépész" vagy "levelező"
     beírásával közvetlenül lehet szűrni, csoportosítás nélkül is. */
  const match = (r) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return ['email', 'name', 'szak', 'tagozat', 'kepzesi_szint', 'kar']
      .some(k => String(r[k] || '').toLowerCase().includes(needle));
  };
  const pending  = rows.filter(r => r.approval_status === 'pending').filter(match);
  const active   = rows.filter(r => r.approval_status === 'approved').filter(match);
  const rejected = rows.filter(r => r.approval_status === 'rejected').filter(match);
  const list = tab === 'pending' ? pending : tab === 'users' ? active : rejected;

  /* Csoportosítás. A csoport nélküli sorok a végére kerülnek, saját
     "Nincs megadva" szakaszba — így látszik, kinél hiányzik a besorolás.

     SZÁNDÉKOSAN NEM useMemo: ez a függvény a `rows === null` korai
     visszatérés MÖGÖTT áll, tehát hookként töltés közben nem futna le, utána
     viszont igen — a hook-sorrend megváltozna, és React eldobná a fát.
     Fehér képernyőt okozott. Néhány száz soron a memoizálás úgysem számít. */
  const csoportok = (() => {
    if (!groupBy) return null;
    const m = new Map();
    for (const r of list) {
      const k = r[groupBy] || '__nincs__';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.entries()].sort((a, b) => {
      if (a[0] === '__nincs__') return 1;
      if (b[0] === '__nincs__') return -1;
      return b[1].length - a[1].length;      // a legnépesebb elöl
    });
  })();

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl 2xl:max-w-[1500px]">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <p className="text-[11px] font-black text-primary uppercase tracking-widest">Hozzáférés-kezelés</p>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight mt-1">Regisztrációk</h1>
          <p className="text-slate-500 mt-2 max-w-2xl leading-relaxed">
            Minden új fiók jóváhagyásra vár. A jóváhagyásig a felhasználó be tud lépni,
            de egyetlen adatot sem lát — ezt az adatbázis érvényesíti, nem csak a felület.
          </p>
        </div>
        <button onClick={load} className="px-4 py-2.5 rounded-xl text-sm font-bold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors flex items-center gap-2">
          <Lucide.RefreshCw size={15} /> Frissítés
        </button>
      </div>

      {err && (
        <div className="mt-6 text-sm font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">{err}</div>
      )}

      <div className="flex items-center gap-2 mt-7 flex-wrap">
        {[['pending', 'Jóváhagyásra vár', pending.length], ['users', 'Felhasználók', active.length], ['rejected', 'Elutasítva', rejected.length], ['groups', 'Csoportok', null], ['roles', 'Szerepkörök', null]].map(([k, label, n]) => (
          <button key={k} onClick={() => setTab(k)}
            className={'px-4 py-2 rounded-xl text-sm font-bold transition-colors ' +
              (tab === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50')}>
            {label}{n !== null && <span className={'ml-1 ' + (tab === k ? 'text-white/60' : 'text-slate-400')}>{n}</span>}
          </button>
        ))}
        {!['groups','roles'].includes(tab) && <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
                title="Csoportosítás"
                className="ml-auto bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm font-semibold text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/20">
          {REG_GROUP_BY.map(([k, label]) => (
            <option key={k || 'none'} value={k}>{k ? 'Csoportosítás: ' + label : label}</option>
          ))}
        </select>}
        {!['groups','roles'].includes(tab) && <div className="relative">
          <Lucide.Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Keresés név, e-mail vagy szak szerint…"
            className="w-64 bg-white border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>}
      </div>

      {tab === 'groups' ? (
        <GRP_Tab rows={rows || []} user={user} />
      ) : tab === 'roles' ? (
        <ROLE_Tab rows={rows || []} user={user} />
      ) : list.length === 0 ? (
        <div className="mt-6 bg-white rounded-3xl border border-slate-100 p-14 text-center">
          <div className="w-14 h-14 rounded-2xl bg-slate-50 text-slate-300 flex items-center justify-center mx-auto mb-4">
            <Lucide.UserCheck size={26} />
          </div>
          <p className="font-bold text-slate-700">
            {q.trim() ? 'Nincs találat' : tab === 'pending' ? 'Nincs függő regisztráció' : tab === 'users' ? 'Még nincs jóváhagyott felhasználó' : 'Nincs elutasított regisztráció'}
          </p>
          <p className="text-sm text-slate-400 mt-1">
            {q.trim() ? 'Próbálj más nevet vagy e-mail-címet.'
              : tab === 'pending' ? 'Az új jelentkezők és ügyintézők itt fognak megjelenni.'
              : tab === 'users' ? 'A jóváhagyott fiókok itt jelennek meg, szerepkörrel együtt.'
              : 'Az elutasított fiókok itt gyűlnek.'}
          </p>
        </div>
      ) : (
        <div className="mt-6 bg-white rounded-3xl border border-slate-100 overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                <th className="text-left px-5 py-3">Felhasználó</th>
                <th className="text-left px-5 py-3">{tab === 'users' ? 'Szerepkör' : 'Kért szerepkör'}</th>
                <th className="text-left px-5 py-3">Besorolás</th>
                <th className="text-left px-5 py-3">Regisztrált</th>
                <th className="text-left px-5 py-3">Állapot</th>
                <th className="text-right px-5 py-3">Döntés</th>
              </tr>
            </thead>
            <tbody>
              {/* Csoportosításnál a táblát NEM bontjuk szét: a csoport
                  fejléce egy teljes szélességű sor. Így a fejléc, a
                  vízszintes görgetés és az oszlopszélességek egyben maradnak. */}
              {(csoportok
                ? csoportok.flatMap(([kulcs, sorok]) => [{ __fejlec: kulcs, __db: sorok.length }, ...sorok])
                : list
               ).map(r => {
                if (r.__fejlec) return (
                  <tr key={'h-' + r.__fejlec} className="bg-slate-50/80 border-b border-slate-100">
                    <td colSpan={6} className="px-5 py-2.5">
                      <span className="text-[11px] font-black text-slate-600 uppercase tracking-wide">
                        {r.__fejlec === '__nincs__' ? 'Nincs megadva' : r.__fejlec}
                      </span>
                      <span className="ml-2 text-[11px] font-bold text-slate-400">{r.__db} fő</span>
                    </td>
                  </tr>
                );
                const st = REG_STATUS_STYLE[r.approval_status] || REG_STATUS_STYLE.pending;
                // A legördülő ALAPÉRTÉKE szándékosan NEM a kért szerepkör.
                // A requested_role a regisztráció beküldője által megadott,
                // ellenőrizetlen érték (auth.signUp options.data) — a 68-as
                // migráció óta a profiles.role-ba már nem kerülhet be, de a
                // kérés maga itt látszik. Ha ez lenne az alapérték, a sort
                // végigkattintó superadmin észrevétlenül osztana ki magasabb
                // jogot. A kért szerepkör külön, jelölve jelenik meg.
                const chosen = roleDraft[r.id] || r.role || 'STUDENT';
                const busy = busyId === r.id;
                const isSelf = !!(user && (user.id === r.id || user.email === r.email));
                return (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-5 py-4">
                      <div className="font-bold text-slate-800">{r.name || '—'}</div>
                      <div className="text-[13px] text-slate-400">{r.email}</div>
                    </td>
                    <td className="px-5 py-4">
                      {/* A besorolás (tagozat, szint, szak, kar) szerkesztése a
                          `registrations` modul EDIT joga. A szerveroldali pár a
                          student_attributes_save (40_attributes_edit.sql). */}
                      <REG_Besorolas r={r} opciok={attrOpciok}
                        szerkesztheto={!!attrOpciok && PERM_can(user, 'registrations', 'EDIT',
                          !!(user && ['SUPERADMIN','ADMIN'].includes(user.role)))}
                        onSaved={load} />
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-600">
                      {tab === 'users' ? (
                        isSelf ? (
                          // A saját sorát senki nem írhatja át — különben a superadmin
                          // egy félrekattintással kizárná magát a jóváhagyásból.
                          <span className="inline-flex items-center gap-1.5 text-slate-400">
                            <Lucide.Lock size={13} /> {REG_ROLE_LABEL[r.role] || r.role}
                          </span>
                        ) : r.role === 'SUPERADMIN' ? (
                          <span className="inline-flex items-center gap-1.5 text-primary font-bold">
                            <Lucide.ShieldCheck size={13} /> Superadmin
                          </span>
                        ) : (
                          <select
                            value={r.role || 'STUDENT'}
                            disabled={busy}
                            onChange={e => changeRole(r, e.target.value)}
                            className="text-[13px] font-semibold bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                          >
                            {REG_assignableRoles().map(role => (
                              <option key={role} value={role}>{REG_ROLE_LABEL[role]}</option>
                            ))}
                          </select>
                        )
                      ) : (
                        <>
                          {REG_ROLE_LABEL[r.role] || r.role || '—'}
                          {/* A KÉRT szerepkör külön, jelölve: ez a beküldő
                              ellenőrizetlen kívánsága, nem a tényleges jog. */}
                          {r.requested_role && r.requested_role !== r.role && (
                            <span className="ml-2 text-[11px] font-bold text-amber-600" title="A regisztráló ezt kérte — nem a tényleges szerepkör.">
                              kért: {REG_ROLE_LABEL[r.requested_role] || r.requested_role}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-5 py-4 text-[13px] text-slate-500">{REG_fmtDate(r.created_at)}</td>
                    <td className="px-5 py-4">
                      <span className={'inline-block px-2.5 py-1 rounded-lg text-[11px] font-black border ' + st.cls}>{st.label}</span>
                      {r.approval_status === 'approved' && r.role && (
                        <div className="text-[11px] text-slate-400 mt-1">mint {REG_ROLE_LABEL[r.role] || r.role}</div>
                      )}
                      {r.approval_status === 'rejected' && r.rejected_reason && (
                        <div className="text-[11px] text-slate-400 mt-1">{r.rejected_reason}</div>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      {r.approval_status === 'pending' ? (
                        <div className="flex items-center gap-2 justify-end">
                          <select
                            value={chosen}
                            onChange={e => setRoleDraft(d => ({ ...d, [r.id]: e.target.value }))}
                            className="text-[13px] font-semibold bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
                            title="Szerepkör a jóváhagyáskor"
                          >
                            {REG_assignableRoles().map(role => (
                              <option key={role} value={role}>{REG_ROLE_LABEL[role]}</option>
                            ))}
                          </select>
                          <button disabled={busy} onClick={() => decide(r, 'approved', chosen)}
                            className="px-3 py-2 rounded-xl text-[13px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center gap-1.5">
                            <Lucide.Check size={15} /> {busy ? '…' : 'Jóváhagyás'}
                          </button>
                          <button disabled={busy} onClick={() => { setRejecting(r); setReason(''); }}
                            className="px-3 py-2 rounded-xl text-[13px] font-bold text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 transition-colors">
                            Elutasítás
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 justify-end">
                          {r.approval_status === 'rejected' && (
                            <button disabled={busy} onClick={() => decide(r, 'approved', r.role || 'STUDENT')}
                              className="px-3 py-2 rounded-xl text-[13px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 transition-colors">
                              Mégis jóváhagyom
                            </button>
                          )}
                          {r.approval_status === 'approved' && !isSelf && r.role !== 'SUPERADMIN' && (
                            <button disabled={busy} onClick={() => decide(r, 'pending')}
                              className="px-3 py-2 rounded-xl text-[13px] font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 disabled:opacity-50 transition-colors">
                              Hozzáférés visszavonása
                            </button>
                          )}
                          {busy && <Lucide.Loader2 size={15} className="animate-spin text-slate-400" />}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6" onClick={() => setRejecting(null)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-5 sm:p-7 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-black text-slate-900">Regisztráció elutasítása</h3>
            <p className="text-sm text-slate-500 mt-1.5">{rejecting.email}</p>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mt-6 mb-2">Indoklás (opcionális)</label>
            <input value={reason} onChange={e => setReason(e.target.value)} autoFocus
              placeholder="pl. nem azonosítható jelentkező"
              className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
            <div className="flex items-center gap-2 justify-end mt-6">
              <button onClick={() => setRejecting(null)} className="px-4 py-2.5 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-50 transition-colors">Mégsem</button>
              <button onClick={() => decide(rejecting, 'rejected', null, reason)}
                className="px-4 py-2.5 rounded-xl text-sm font-bold text-white bg-red-600 hover:bg-red-700 transition-colors">Elutasítás</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- a jóváhagyásra váró felhasználó képernyője ---------- */
function PendingApprovalScreen({ user, onLogout }) {
  // `user` here is the app-level currentUser, which normalises the profile's
  // approval_status onto `status`.
  const rejected = user.status === 'rejected';
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6 font-sans">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-2xl p-10 text-center">
        <div className={'w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 ' +
          (rejected ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-500')}>
          {rejected ? <Lucide.UserX size={30} /> : <Lucide.Clock size={30} />}
        </div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">
          {rejected ? 'A regisztrációt elutasítottuk' : 'Jóváhagyásra vár'}
        </h1>
        <p className="text-slate-500 text-sm mt-3 leading-relaxed">
          {rejected ? (
            <>A(z) <span className="font-bold text-slate-700">{user.email}</span> fiókhoz tartozó
            hozzáférési kérelmet a rendszergazda elutasította.
            {user.rejected_reason ? <> Indoklás: <span className="font-semibold text-slate-600">{user.rejected_reason}</span></> : null}</>
          ) : (
            <>Köszönjük a regisztrációt! A(z) <span className="font-bold text-slate-700">{user.email}</span> fiókot
            a rendszergazdának jóvá kell hagynia, mielőtt beléphetsz. Erről e-mailben nem küldünk
            értesítést — próbáld meg később újra a bejelentkezést.</>
          )}
        </p>
        <div className="mt-8 space-y-2">
          <button onClick={() => window.location.reload()}
            className="w-full py-3.5 rounded-2xl text-sm font-bold text-white bg-primary hover:bg-primary/90 transition-colors">
            Állapot frissítése
          </button>
          <button onClick={onLogout}
            className="w-full py-3.5 rounded-2xl text-sm font-bold text-slate-500 hover:bg-slate-50 transition-colors">
            Kijelentkezés
          </button>
        </div>
      </div>
    </div>
  );
}
