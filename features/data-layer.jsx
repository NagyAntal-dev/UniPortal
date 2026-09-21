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
