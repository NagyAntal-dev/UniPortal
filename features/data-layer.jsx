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
      DL_PROBE[table] = error ? 'ls' : 'sb';
    } catch (e) { DL_PROBE[table] = 'ls'; }
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
    } catch (e) {}
    DL_PROBE[table] = 'ls';
  }
  return dlLocalLoad(lsKey, seedFn);
}

async function dlInsert(table, row, lsKey) {
  const mode = await dlEnsure(table);
  if (mode === 'sb') {
    try {
      const { data, error } = await window.sb.from(table).insert(row).select().single();
      if (!error && data) return data;
    } catch (e) {}
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
    try {
      const { data, error } = await window.sb.from(table).update(patch).eq('id', id).select().single();
      if (!error && data) return data;
    } catch (e) {}
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
    try { await window.sb.from(table).delete().eq('id', id); return true; } catch (e) {}
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

/* who can author feed / manage programs & KB */
const isAdmin = (user) => user && user.role === 'ADMIN';
const isStaff = (user) => user && ['ADMIN', 'ADMISSIONS', 'FINANCE'].includes(user.role);
