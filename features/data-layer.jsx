/* ============================================================
   UniPortal Pro — New features shared data layer
   (concatenated into app.jsx's module — NO imports here;
    React, hooks, Lucide, ICONS, sb, uid, todayStr, nowTs are in scope)

   Storage strategy: prefer the live Supabase table; if it does not
   exist yet (migration 05 not run), transparently fall back to a
   seeded localStorage store so every new feature works immediately
   in preview and "upgrades" to shared storage once the SQL is run.
   ============================================================ */

const DL_PROBE = {}; // table -> 'sb' | 'ls'

async function dlEnsure(table) {
  if (DL_PROBE[table]) return DL_PROBE[table];
  if (window.sb) {
    try {
      const { error } = await window.sb.from(table).select('id').limit(1);
      if (error && !dlNincsTabla(error)) throw dlTiltasHiba(error, 'betöltés');
      DL_PROBE[table] = error ? 'ls' : 'sb';
    } catch (e) {
      if (!dlNincsTabla(e)) throw dlTiltasHiba(e, 'betöltés');
      DL_PROBE[table] = 'ls';
    }
  } else {
    DL_PROBE[table] = 'ls';
  }
  return DL_PROBE[table];
}

function dlLocalLoad(lsKey, seedFn) {
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  const seed = seedFn ? seedFn() : [];
  try { localStorage.setItem(lsKey, JSON.stringify(seed)); } catch (e) {}
  return seed;
}
function dlLocalSave(lsKey, arr) {
  try { localStorage.setItem(lsKey, JSON.stringify(arr)); } catch (e) {}
}

async function dlSelect(table, lsKey, seedFn, orderCol, ascending = true) {
  const mode = await dlEnsure(table);
  if (mode === 'sb') {
    try {
      let qb = window.sb.from(table).select('*');
      if (orderCol) qb = qb.order(orderCol, { ascending });
      const valasz = await qb;
      const { data, error } = valasz;
      // Sebességkorlát: NEM váltunk localStorage-módra. A DL_PROBE[table]='ls'
      // az egész munkamenetre átállítaná a táblát a helyi másolatra, és a
      // felhasználó egy múló 429 után végig elavult adatot látna. Csak most
      // adjuk vissza a helyi másolatot, és megkérjük a háttérfrissítéseket,
      // hogy várjanak.
      if (POLL_nezdKorlat(valasz)) return dlLocalLoad(lsKey, seedFn);
      if (!error && Array.isArray(data)) {
        // Empty live tables are intentional after an administrative reset.
        // Seeds belong only to the local preview; refresh its cache as well.
        dlLocalSave(lsKey, data);
        return data;
      }
      if (error) throw error;
      throw new Error('A betöltés nem sikerült.');
    } catch (e) {
      // Olvasási hiba sem állíthatja át a következő írást helyi mentésre.
      if (!dlNincsTabla(e)) throw dlTiltasHiba(e, 'betöltés');
      DL_PROBE[table] = 'ls';
    }
  }
  return dlLocalLoad(lsKey, seedFn);
}

/* ===========================================================================
   ÍRÁS — és a „csendes siker" hiba megszüntetése

   MI VOLT A BAJ (a 11_rbac_additive.sql fejléce, D pont, szó szerint):
     „A features/data-layer.jsx dlInsert/dlUpdate minden hibát elkap és
      localStorage-ra vált: egy megtagadott írás a felületen SIKERESNEK
      látszik."
   A dlDelete ennél is tovább ment: a hibát meg sem nézte.

   MIÉRT KRITIKUS EZ MOST: a 72/73-as migrációval a jogosultság-megtagadás
   NORMÁLIS, várható válasz lesz — nem ritka hiba. Ha a felület ilyenkor
   „elmentve"-t mutat, a felhasználó abban a hitben megy tovább, hogy a munkája
   megvan, pedig az adatbázisban nincs semmi. Ez rosszabb, mint egy hibaüzenet.

   A MEGKÜLÖNBÖZTETÉS, amin az egész múlik:
     • HIÁNYZÓ TÁBLA (42P01 / PGRST205) — a migráció még nem futott le.
       Itt a localStorage-tartalék a HELYES viselkedés: a funkció működjön
       előnézetben is. Ez volt az eredeti cél, és ez marad.
     • MEGTAGADOTT ÍRÁS (42501, RLS, 0 érintett sor) — az adatbázis ELUTASÍTOTTA.
       Itt DOBUNK. Nem váltunk localStorage-ra, és a DL_PROBE-ot sem állítjuk
       át: egy megtagadás nem jelenti azt, hogy a tábla nem létezik, és nem
       szabad az egész munkamenetre helyi másolatra váltani miatta.
   =========================================================================== */

/* Igaz, ha a hiba JOGOSULTSÁGI megtagadás (nem hiányzó tábla, nem hálózat). */
function dlMegtagadva(error) {
  if (!error) return false;
  const kod = String(error.code || '');
  const uzenet = String(error.message || error.details || error.hint || '');
  if (kod === '42501' || kod === 'PGRST301') return true;
  return /permission denied|row-level security|violates row-level|insufficient privilege/i.test(uzenet);
}

/* Igaz, ha a tábla maga hiányzik — ilyenkor a helyi tartalék a helyes válasz. */
function dlNincsTabla(error) {
  if (!error) return false;
  const kod = String(error.code || '');
  if (kod === '42P01' || kod === 'PGRST205') return true;
  return !kod && /Could not find the table\b/i.test(String(error.message || ''));
}

/* A megtagadásból a felület által megjeleníthető hiba. A kódot MEGTARTJUK,
   hogy a modulok saját PGERR-fordítói (ROLE_PGERR és társai) felismerjék. */
function dlTiltasHiba(error, muvelet) {
  const e = new Error(
    (error && error.message) ||
    ('Ehhez a művelethez nincs jogosultsága (' + muvelet + ').'));
  e.code = error && error.code;
  e.dlDenied = dlMegtagadva(error) || e.code === 'PGRST116';
  return e;
}

async function dlInsert(table, row, lsKey) {
  const mode = await dlEnsure(table);
  if (mode === 'sb') {
    let valasz;
    try {
      valasz = await window.sb.from(table).insert(row).select().single();
    } catch (e) {
      if (!dlNincsTabla(e)) throw dlTiltasHiba(e, 'létrehozás');
      valasz = { error: e };
    }
    if (valasz) {
      const { data, error } = valasz;
      if (!error && data) return data;
      // MEGTAGADÁS: dobunk. Se tartalék, se DL_PROBE-váltás.
      if (dlMegtagadva(error)) throw dlTiltasHiba(error, 'létrehozás');
      // Bármi más, ami NEM hiányzó tábla: szintén dobunk. Egy megsértett
      // megszorítás vagy egy elírt oszlopnév se látsszon sikeres mentésnek.
      if (error && !dlNincsTabla(error)) throw dlTiltasHiba(error, 'létrehozás');
      if (!error) throw new Error('A létrehozás nem igazolható.');
    }
    if (!valasz) throw new Error('A létrehozás nem igazolható.');
    DL_PROBE[table] = 'ls';
  }
  const arr = dlLocalLoad(lsKey, () => []);
  arr.unshift(row);
  dlLocalSave(lsKey, arr);
  return row;
}

async function dlUpdate(table, id, patch, lsKey) {
  const mode = await dlEnsure(table);
  if (mode === 'sb') {
    let valasz;
    try {
      valasz = await window.sb.from(table).update(patch).eq('id', id).select();
    } catch (e) {
      if (!dlNincsTabla(e)) throw dlTiltasHiba(e, 'szerkesztés');
      valasz = { error: e };
    }
    if (valasz) {
      const { data, error } = valasz;
      if (!error && Array.isArray(data) && data.length) return data[0];
      if (dlMegtagadva(error)) throw dlTiltasHiba(error, 'szerkesztés');
      if (error && !dlNincsTabla(error)) throw dlTiltasHiba(error, 'szerkesztés');
      // NULLA ÉRINTETT SOR, hiba nélkül. Ez a restriktív RLS TIPIKUS válasza:
      // a PostgREST ilyenkor nem hibát ad, hanem üres eredményt — a sor vagy
      // nem létezik, vagy a szabály nem engedte írni. A kettőt a kliens nem
      // tudja megkülönböztetni, de MINDKETTŐ azt jelenti, hogy a mentés NEM
      // történt meg. A régi kód itt esett vissza localStorage-ra, és ettől
      // látszott sikeresnek egy megtagadott írás.
      if (!error) {
        throw dlTiltasHiba(
          { code: '42501',
            message: 'A módosítás nem történt meg: vagy nincs rá jogosultsága, '
                   + 'vagy a rekord időközben megszűnt.' }, 'szerkesztés');
      }
    }
    if (!valasz) throw new Error('A módosítás nem igazolható.');
    DL_PROBE[table] = 'ls';
  }
  const arr = dlLocalLoad(lsKey, () => []);
  const i = arr.findIndex(x => x.id === id);
  if (i >= 0) { arr[i] = { ...arr[i], ...patch }; dlLocalSave(lsKey, arr); return arr[i]; }
  return null;
}

async function dlDelete(table, id, lsKey) {
  const mode = await dlEnsure(table);
  if (mode === 'sb') {
    let valasz;
    try {
      // A .select() nélkül a PostgREST nem mondja meg, hány sort törölt —
      // a régi kód ezért nem is tudta, hogy a törlés megtörtént-e.
      valasz = await window.sb.from(table).delete().eq('id', id).select();
    } catch (e) {
      if (!dlNincsTabla(e)) throw dlTiltasHiba(e, 'törlés');
      valasz = { error: e };
    }
    if (valasz) {
      const { data, error } = valasz;
      if (!error && Array.isArray(data) && data.length) return true;
      if (dlMegtagadva(error)) throw dlTiltasHiba(error, 'törlés');
      if (error && !dlNincsTabla(error)) throw dlTiltasHiba(error, 'törlés');
      if (!error) {
        throw dlTiltasHiba(
          { code: '42501',
            message: 'A törlés nem történt meg: vagy nincs rá jogosultsága, '
                   + 'vagy a rekord már nem létezik.' }, 'törlés');
      }
    }
    if (!valasz) throw new Error('A törlés nem igazolható.');
    DL_PROBE[table] = 'ls';
  }
  const arr = dlLocalLoad(lsKey, () => []).filter(x => x.id !== id);
  dlLocalSave(lsKey, arr);
  return true;
}

/* ---------- formatting helpers ---------- */
const DL_money = (n, cur = 'EUR') => {
  if (n === 0 || n === '0') return 'Free';
  if (n == null || n === '') return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(Number(n)); }
  catch (e) { return n + ' ' + cur; }
};
const DL_date = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const DL_dateLong = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
};
const DL_daysLeft = (s) => {
  if (!s) return null;
  const d = new Date(s); if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
};

/* ---------- shared UI atoms (U*) ---------- */
const UBadge = ({ children, tone = 'slate', className = '' }) => {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    primary: 'bg-primary/10 text-primary',
    green: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
    blue: 'bg-sky-50 text-sky-600',
    violet: 'bg-violet-50 text-violet-600',
  };
  return <span className={'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ' + (tones[tone] || tones.slate) + ' ' + className}>{children}</span>;
};

const UModal = ({ open, onClose, children, max = 'max-w-2xl', title, subtitle, icon }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 sm:p-8 overflow-y-auto bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div className={'w-full ' + max + ' bg-white rounded-3xl shadow-2xl my-auto animate-in zoom-in-95 duration-200'} onClick={e => e.stopPropagation()}>
        {(title || icon) && (
          <div className="flex items-start justify-between gap-4 p-5 sm:p-6 border-b border-slate-100">
            <div className="flex items-center gap-3 min-w-0">
              {icon && <div className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center flex-none">{icon}</div>}
              <div className="min-w-0">
                <h3 className="text-lg font-black text-slate-900 tracking-tight truncate">{title}</h3>
                {subtitle && <p className="text-xs text-slate-400 font-medium mt-0.5">{subtitle}</p>}
              </div>
            </div>
            <button onClick={onClose} className="w-9 h-9 flex-none flex items-center justify-center rounded-xl hover:bg-slate-100 text-slate-400 transition-colors"><Lucide.X size={18} /></button>
          </div>
        )}
        <div className="p-5 sm:p-6">{children}</div>
      </div>
    </div>
  );
};

const UEmpty = ({ icon, title, subtitle, action }) => (
  <div className="flex flex-col items-center justify-center text-center py-16 px-6">
    <div className="w-16 h-16 rounded-3xl bg-slate-50 text-slate-300 flex items-center justify-center mb-4">{icon || <Lucide.Inbox size={28} />}</div>
    <h4 className="font-black text-slate-700">{title}</h4>
    {subtitle && <p className="text-sm text-slate-400 mt-1 max-w-sm">{subtitle}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

const UField = ({ label, children, hint }) => (
  <label className="block">
    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1.5">{label}</span>
    {children}
    {hint && <span className="text-[11px] text-slate-400 mt-1 block">{hint}</span>}
  </label>
);

const U_input = 'w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all';
const U_btn = 'inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none';
const U_btnPrimary = U_btn + ' bg-primary text-white px-5 py-3 shadow-lg shadow-primary/10 hover:bg-primary/90';
const U_btnGhost = U_btn + ' bg-slate-50 text-slate-600 px-5 py-3 hover:bg-slate-100';

// tiny toast
function UToast({ msg, onDone }) {
  useEffect(() => { if (!msg) return; const t = setTimeout(onDone, 2600); return () => clearTimeout(t); }, [msg]);
  if (!msg) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] bg-slate-900 text-white text-sm font-bold px-5 py-3 rounded-2xl shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-200 flex items-center gap-2">
      <Lucide.CheckCircle2 size={16} className="text-emerald-400" /> {msg}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Ki szerkeszthet hírfolyamot, programot, tudásbázist

   MI VOLT A BAJ, KÉT DOLOG:
     1. Kódba égetett szerepkör-lista — egy szerepkör átszabásához kód kellett.
     2. EGYIK SEM TARTALMAZTA A SUPERADMIN-T. Ez latens hiba volt: a
        programs.jsx:1684 kommentje már ki is mondta, hogy „a közös isAdmin()
        csak az ADMIN szerepkört nézi, ezért a SUPERADMIN eddig a hallgatói
        katalógust kapta kezelőtábla helyett", és külön ágban javította.
        A PERM_can elsőként a SUPERADMIN-t engedi át, tehát ez megszűnik.

   A HARMADIK PARAMÉTER a MAI érték: ha a 72-es migráció még nem futott le, az
   dönt — így a bevezetés nem vesz el semmit (lásd features/perm.jsx).
   --------------------------------------------------------------------------- */
const isAdmin = (user) => PERM_can(user, 'system_admin', 'EDIT',
  !!(user && user.role === 'ADMIN'));
const isStaff = (user) => PERM_can(user, 'admissions_core', 'EDIT',
  !!(user && ['ADMIN', 'ADMISSIONS', 'FINANCE'].includes(user.role)));

/* ---------------------------------------------------------------------------
   Tulajdonság-szűrő kártyák (80_audience_attribute_filter.sql)

   MIÉRT ITT: a kampányszerkesztő (echo.jsx), a hírfolyam (feed.jsx) és a
   csoportszerkesztő (groups.jsx) UGYANAZT a szabályt állítja össze. Három
   külön felület előbb-utóbb háromféleképp viselkedne, és a felhasználónak
   kellene kitalálnia, melyik a helyes. A data-layer a bundle-ben mindhárom
   ELŐTT töltődik (build.mjs), tehát innen mindenki látja.

   A SZABÁLY ALAKJA  { mező: [értékek] }  — a mezők ÉS, az értékek VAGY
   kapcsolatban. Ezt a szerveren a public.group_rule_matches() értékeli ki; a
   kulcsok BETŰRE egyeznek annak zárt mezőlistájával. Ami itt nincs felsorolva,
   arra a szerver úgysem illeszkedik, tehát felkínálni is félrevezető lenne.

   TÖBB KÁRTYA = VAGY. Egy kártyán belül ÉS. Így írható le a "nappali BSc
   GAMF-os VAGY levelező MSc KVK-s" közönség, ami egyetlen szabállyal nem menne.
   --------------------------------------------------------------------------- */
const ATTR_RULE_FIELDS = [
  ['tagozat',       'Tagozat'],
  ['kepzesi_szint', 'Képzési szint'],
  ['szak',          'Szak'],
  ['kar',           'Kar'],
  ['nyelv',         'Nyelv'],
  ['telephely',     'Telephely'],
];

/* Az értékkészlet a student_directory_options() alakjában: [{ertek, db}, …].
   Üres lista nem hiba — a nyelv mezőt például a Neptun-import szándékosan nem
   tölti (a nyelv a KURZUSÉ, nem a hallgatóé), ezért ott tényleg nincs mit
   felkínálni. Ezt a felület ki is mondja, hogy ne tűnjön elromlottnak. */
const ATTR_ertekek = (opciok, mezo) =>
  (opciok && Array.isArray(opciok[mezo])) ? opciok[mezo] : [];

const ATTR_uid = () => 'f_' + Math.random().toString(36).slice(2, 10);

const ATTR_ujKartya = () => ({ ref: ATTR_uid(), szabaly: {} });

/* Olvasható összefoglaló egy szabályról — ugyanaz a sorrend, mint amit a
   szerver attr_rule_label() függvénye ad, hogy a mentés előtt és után
   ugyanaz a szöveg álljon a képernyőn. */
function ATTR_cimke(szabaly) {
  const rang = { tagozat: 1, kepzesi_szint: 2, kar: 3, szak: 4, nyelv: 5, telephely: 6 };
  const reszek = Object.entries(szabaly || {})
    .filter(([, v]) => Array.isArray(v) && v.length)
    .sort((a, b) => (rang[a[0]] || 9) - (rang[b[0]] || 9))
    .map(([, v]) => v.join(', '));
  return reszek.length ? reszek.join(' · ') : 'üres szűrő';
}

const ATTR_Chip = ({ text, active, onClick }) => (
  <button type="button" onClick={onClick} disabled={!onClick}
    className={'inline-flex items-center px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-colors ' +
      (active ? 'bg-primary text-white border-primary'
              : 'bg-white text-slate-600 border-slate-200') +
      (onClick ? ' hover:border-primary cursor-pointer' : ' cursor-default')}>
    {text}
  </button>
);

/* Egy feltételcsoport. A találatszám azért kell, mert egy szabály
   következménye nem nyilvánvaló: "nappali + mesterképzés" simán lehet nulla
   ember, és ezt a mentés ELŐTT kell megtudni, nem utána. */
function AttrRuleCard({ ertek, opciok, onChange, onRemove, ro, cim, szamol }) {
  const [nyitott, setNyitott] = useState(ATTR_RULE_FIELDS[0][0]);
  const [db, setDb]           = useState(null);
  const sz    = ertek || {};
  const kulcs = JSON.stringify(sz);

  useEffect(() => {
    if (!szamol || !Object.keys(sz).length) { setDb(null); return; }
    let el = true;
    // Kesleltetve: chipek gyors egymas utani kattintgatasanal ne inditsunk
    // minden kattintasra lekerest.
    const t = setTimeout(() => {
      Promise.resolve(szamol(sz))
        .then(n => { if (el) setDb(typeof n === 'number' ? n : null); })
        .catch(() => { if (el) setDb(null); });
    }, 300);
    return () => { el = false; clearTimeout(t); };
  }, [kulcs]);

  const toggle = (mezo, v) => {
    const cur = Array.isArray(sz[mezo]) ? sz[mezo] : [];
    const uj  = cur.includes(v) ? cur.filter(x => x !== v) : cur.concat([v]);
    const ki  = { ...sz };
    if (uj.length) ki[mezo] = uj; else delete ki[mezo];
    onChange(ki);
  };

  const lista = ATTR_ertekek(opciok, nyitott);

  return (
    <div className="border border-slate-100 rounded-2xl p-3 space-y-2.5">
      {(cim || onRemove) && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{cim}</span>
          {onRemove && !ro && (
            <button type="button" onClick={onRemove}
              className="text-slate-300 hover:text-red-500" title="Feltételcsoport törlése">
              <Lucide.X size={14} />
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {ATTR_RULE_FIELDS.map(([k, label]) => {
          const n = Array.isArray(sz[k]) ? sz[k].length : 0;
          return (
            <button key={k} type="button" onClick={() => setNyitott(k)}
              className={'px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ' +
                (nyitott === k ? 'bg-slate-900 text-white border-slate-900'
                               : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400')}>
              {label}{n > 0 && <span className="ml-1.5 opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="bg-slate-50 border border-slate-100 rounded-xl p-2.5 max-h-44 overflow-y-auto">
        <div className="flex flex-wrap gap-1.5">
          {lista.map(o => (
            <ATTR_Chip key={o.ertek} text={o.ertek + (o.db != null ? ' · ' + o.db : '')}
              active={Array.isArray(sz[nyitott]) && sz[nyitott].includes(o.ertek)}
              onClick={ro ? null : () => toggle(nyitott, o.ertek)} />
          ))}
          {lista.length === 0 && (
            <span className="text-[11px] text-slate-400">
              Ehhez a mezőhöz nincs adat a besorolásban — nincs mire szűrni.
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="font-bold text-slate-500 truncate">{ATTR_cimke(sz)}</span>
        {db !== null && (
          <span className={'ml-auto font-black ' + (db === 0 ? 'text-amber-600' : 'text-emerald-700')}>
            {db} fő
          </span>
        )}
      </div>
      {db === 0 && (
        <p className="text-[11px] text-amber-600">
          Erre a feltételcsoportra most senki nem illeszkedik — érdemes tágítani.
        </p>
      )}
    </div>
  );
}

/* N feltételcsoport, egymással VAGY kapcsolatban.
   A `szurok` elemei: { ref, szabaly } — a ref csak a kliensé (React-kulcs és
   törlés), a szerver nem látja. */
function AttrRuleCards({ szurok, opciok, onChange, ro, szamol }) {
  const lista = Array.isArray(szurok) ? szurok : [];

  const allit = (ref, szabaly) =>
    onChange(lista.map(x => (x.ref === ref ? { ...x, szabaly } : x)));

  return (
    <div className="space-y-2.5">
      {lista.length === 0 && (
        <p className="text-[11px] text-slate-300 font-bold italic">nincs szűrő</p>
      )}

      {lista.map((x, i) => (
        <React.Fragment key={x.ref}>
          {i > 0 && (
            <div className="flex items-center gap-2">
              <span className="h-px flex-1 bg-slate-100" />
              <span className="text-[10px] font-black text-slate-400 tracking-widest">VAGY</span>
              <span className="h-px flex-1 bg-slate-100" />
            </div>
          )}
          <AttrRuleCard
            cim={lista.length > 1 ? (i + 1) + '. feltételcsoport' : 'Feltételek'}
            ertek={x.szabaly} opciok={opciok} ro={ro} szamol={szamol}
            onChange={(sz) => allit(x.ref, sz)}
            onRemove={() => onChange(lista.filter(y => y.ref !== x.ref))} />
        </React.Fragment>
      ))}

      {!ro && (
        <button type="button" onClick={() => onChange(lista.concat([ATTR_ujKartya()]))}
          className="text-[11px] font-black text-primary hover:underline">
          + feltételcsoport
        </button>
      )}
    </div>
  );
}
