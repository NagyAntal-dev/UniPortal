/* ============================================================
   UniPortal — Interjú-elérhetőség és idősáv-foglalás
   (28_interview_availability.sql felülete)

   MIÉRT KÜLÖN FÁJL: az app.jsx 11 000 sor, és az InterviewScheduler
   nézet ott mindössze ~160 sor. A naptárszerkesztő ennél nagyobb, és
   önálló életet él (RPC-halmaz, saját állapotgép) — a features/ minta
   pontosan erre való. Az app.jsx-be csak a BEKÖTÉS kerül.

   DEFENZÍV, az echo/dorm minta szerint: ha a 28-as migráció még nem
   futott le, minden RPC hibát ad vissza, a panel pedig egy magyarázó
   üresség-állapotot mutat — a régi felület viselkedése nem változik.
   ============================================================ */

/* ---------- RPC-réteg ----------
   Egyetlen helyen kezeljük a "nincs ilyen függvény" esetet, mert a
   supabase-js NEM dob: hibát AD VISSZA. A hívók így elég egy
   { data, error } párra figyelni. */
/* A useCallback/useMemo SZÁNDÉKOSAN React.-előtaggal szerepel ebben a fájlban:
   az app.jsx feje csak a { useState, useEffect, useRef, Fragment } hookokat
   emeli be név szerint, és a feature-modulok ugyanabban a modul-hatókörben
   futnak. MÉRVE: előtag nélkül a nézet megnyitásakor
   "ReferenceError: useCallback is not defined" dobódott, és az app kifehéredett. */
async function IV_rpc(name, args) {
  if (!window.sb) return { data: null, error: { message: 'Nincs adatbázis-kapcsolat.' } };
  try {
    const { data, error } = await window.sb.rpc(name, args || {});
    if (error) return { data: null, error };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: { message: (e && e.message) || String(e) } };
  }
}

/* A szerver magyar mondatot ad vissza (28-as: interview_slot_blocked_reason).
   Azt mutatjuk meg, nem egy általános "Hiba történt"-et — a tesztelők
   kifejezetten ezt kérték: derüljön ki, MIÉRT nem foglalható. */
const IV_msg = (error, fallback) => {
  if (!error) return fallback || '';
  const m = error.message || error.details || error.hint || '';
  if (/function .* does not exist|Could not find the function/i.test(m)) {
    return 'Ez a funkció még nincs élesítve ebben a környezetben (28-as migráció).';
  }
  return m || fallback || 'Ismeretlen hiba.';
};

const IV_DAYS = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat', 'Vasárnap'];
const IV_dayName = (n) => IV_DAYS[(Number(n) || 1) - 1] || '—';

/* A JS getDay() vasárnapja 0, az ISO szerinti (és a 28-as tábla) 7.
   Egyetlen helyen váltunk, hogy a felület és az SQL ugyanazt értse. */
const IV_isoDow = (d) => { const n = d.getDay(); return n === 0 ? 7 : n; };

const IV_hhmm = (iso, tz) => {
  try {
    return new Date(iso).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined });
  } catch (e) { return ''; }
};
const IV_dayLabel = (iso, tz) => {
  try {
    return new Date(iso).toLocaleDateString('hu-HU', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz || undefined });
  } catch (e) { return ''; }
};
const IV_dateInput = (iso) => {
  if (!iso) return '';
  try { const d = new Date(iso); return d.toISOString().slice(0, 10); } catch (e) { return ''; }
};

/* Helyi dátum+idő → ISO. A böngésző időzónáját használja, ami a
   gyakorlatban megegyezik az intézményével; a szerver ettől függetlenül
   a beállított időzónában értelmezi a sávokat. */
const IV_toIso = (dateStr, timeStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T' + (timeStr || '00:00') + ':00');
  return isNaN(d) ? null : d.toISOString();
};

/* ---------- közös apró elemek ---------- */
const IV_Card = ({ title, subtitle, icon, action, children }) => (
  <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-3 p-5 sm:p-6 border-b border-slate-100">
      <div className="flex items-center gap-3 min-w-0">
        {icon && <div className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center flex-none">{icon}</div>}
        <div className="min-w-0">
          <h3 className="text-lg font-black text-slate-900 tracking-tight">{title}</h3>
          {subtitle && <p className="text-xs text-slate-400 font-medium mt-0.5 max-w-[70ch]">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
    <div className="p-5 sm:p-6">{children}</div>
  </div>
);

const IV_Row = ({ children, tone }) => (
  <div className={'flex flex-wrap items-center gap-3 justify-between rounded-2xl border px-4 py-3 ' +
    (tone === 'muted' ? 'bg-slate-50 border-slate-100' : 'bg-white border-slate-100')}>
    {children}
  </div>
);

const IV_Err = ({ children }) => !children ? null : (
  <div className="rounded-2xl bg-red-50 border border-red-100 text-red-700 text-sm px-4 py-3 flex items-start gap-2">
    <Lucide.AlertTriangle size={16} className="mt-0.5 flex-none" />
    <span className="min-w-0">{children}</span>
  </div>
);

const IV_Ok = ({ children }) => !children ? null : (
  <div className="rounded-2xl bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm px-4 py-3 flex items-start gap-2">
    <Lucide.CheckCircle2 size={16} className="mt-0.5 flex-none" />
    <span className="min-w-0">{children}</span>
  </div>
);

/* ---------- a modul közös állapota ----------
   Egy hívás, ami megmondja: admin vagyok-e, interjúztató vagyok-e, mekkora
   a sávhossz, kik az interjúztatók. Ugyanaz a minta, mint az echo_my_roles /
   dorm_my_roles: ha nincs meg az RPC, üres jogosultsággal megyünk tovább. */
function IV_useContext() {
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    const { data, error } = await IV_rpc('interview_my_context');
    if (error) { setError(IV_msg(error)); setCtx(null); }
    else { setError(''); setCtx(data || null); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  return { ctx, loading, error, reload: load };
}

/* ---------- heti ismétlődő elérhetőség ---------- */
const IV_WeekdaySelect = ({ value, onChange, allowAny }) => (
  <select value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className={U_input}>
    {allowAny && <option value="">Minden nap</option>}
    {IV_DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
  </select>
);

const IV_AvailabilityList = ({ cal, target, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ id: null, weekday: 2, start: '10:00', end: '12:00', valid_from: '', valid_to: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const rows = (cal && cal.availability) || [];
  const canEdit = !!(cal && cal.can_edit);

  const openNew = () => { setForm({ id: null, weekday: 2, start: '10:00', end: '12:00', valid_from: '', valid_to: '', note: '' }); setErr(''); setOpen(true); };
  const openEdit = (r) => {
    setForm({ id: r.id, weekday: r.weekday, start: r.start_time, end: r.end_time,
              valid_from: r.valid_from || '', valid_to: r.valid_to || '', note: r.note || '' });
    setErr(''); setOpen(true);
  };

  const save = async () => {
    setBusy(true); setErr('');
    const { error } = await IV_rpc('interview_availability_save', {
      p_id: form.id, p_interviewer: target, p_weekday: form.weekday,
      p_start: form.start, p_end: form.end,
      p_valid_from: form.valid_from || null, p_valid_to: form.valid_to || null,
      p_active: true, p_note: form.note || null,
    });
    setBusy(false);
    if (error) { setErr(IV_msg(error)); return; }
    setOpen(false); onChanged();
  };

  const remove = async (r) => {
    const { error } = await IV_rpc('interview_availability_delete', { p_id: r.id });
    if (error) { setErr(IV_msg(error)); return; }
    onChanged();
  };

  return (
    <IV_Card
      title="Heti elérhetőség"
      subtitle="Ismétlődő sávok, amelyekből a foglalható időpontok generálódnak. Ami nincs itt, azt nem lehet lefoglalni."
      icon={<Lucide.CalendarRange size={20} />}
      action={canEdit && <button onClick={openNew} className={U_btnPrimary + ' !py-2.5 !px-4 text-sm'}><Lucide.Plus size={16} /> Új sáv</button>}
    >
      <div className="space-y-3">
        <IV_Err>{err}</IV_Err>
        {rows.length === 0 && (
          <UEmpty icon={<Lucide.CalendarOff size={28} />} title="Nincs felvett elérhetőség"
                  subtitle="Amíg nincs egyetlen sáv sem, a jelentkezők nem látnak foglalható időpontot." />
        )}
        {rows.map(r => (
          <IV_Row key={r.id} tone={r.active ? undefined : 'muted'}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-none">
                <Lucide.Clock size={18} />
              </span>
              <div className="min-w-0">
                <div className="font-black text-slate-800">{IV_dayName(r.weekday)} · {r.start_time}–{r.end_time}</div>
                <div className="text-xs text-slate-400">
                  {(r.valid_from || r.valid_to)
                    ? ('Érvényes: ' + (r.valid_from || '…') + ' – ' + (r.valid_to || '…'))
                    : 'Érvényes: visszavonásig'}
                  {r.note ? ' · ' + r.note : ''}
                </div>
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-2">
                <button onClick={() => openEdit(r)} className={U_btnGhost + ' !py-2 !px-3 text-xs'}><Lucide.Pencil size={14} /> Szerkesztés</button>
                <button onClick={() => remove(r)} className={U_btnGhost + ' !py-2 !px-3 text-xs !text-red-600 hover:!bg-red-50'}><Lucide.Trash2 size={14} /> Törlés</button>
              </div>
            )}
          </IV_Row>
        ))}
      </div>

      <UModal open={open} onClose={() => setOpen(false)} max="max-w-lg"
              title={form.id ? 'Elérhetőségi sáv szerkesztése' : 'Új elérhetőségi sáv'}
              subtitle="A sávot a rendszer a beállított idősáv-hosszra bontja fel."
              icon={<Lucide.CalendarRange size={20} />}>
        <div className="space-y-4">
          <IV_Err>{err}</IV_Err>
          <UField label="Nap"><IV_WeekdaySelect value={form.weekday} onChange={(v) => setForm({ ...form, weekday: v || 1 })} /></UField>
          <div className="grid grid-cols-2 gap-3">
            <UField label="Kezdés"><input type="time" className={U_input} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></UField>
            <UField label="Befejezés"><input type="time" className={U_input} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></UField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <UField label="Érvényes ettől" hint="Üresen hagyva: azonnal">
              <input type="date" className={U_input} value={form.valid_from} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} />
            </UField>
            <UField label="Érvényes eddig" hint="Üresen hagyva: visszavonásig">
              <input type="date" className={U_input} value={form.valid_to} onChange={(e) => setForm({ ...form, valid_to: e.target.value })} />
            </UField>
          </div>
          <UField label="Megjegyzés"><input className={U_input} value={form.note} placeholder="pl. csak online" onChange={(e) => setForm({ ...form, note: e.target.value })} /></UField>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setOpen(false)} className={U_btnGhost}>Mégse</button>
            <button onClick={save} disabled={busy} className={U_btnPrimary}>{busy ? 'Mentés…' : 'Mentés'}</button>
          </div>
        </div>
      </UModal>
    </IV_Card>
  );
};

/* ---------- ismétlődő kizárás (ebédszünet) ----------
   A GLOBÁLIS sor (minden interjúztatóra) külön jelölést kap: az
   interjúztatónak látnia kell, mi vág bele a napjába akkor is, ha nem ő
   vette fel — de csak az admin írhatja át. */
const IV_BreakList = ({ cal, ctx, target, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ id: null, weekday: null, start: '12:00', end: '13:00', label: 'Ebédszünet', global: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const rows = (cal && cal.breaks) || [];
  const isAdmin = !!(ctx && ctx.admin);
  const canAdd = !!(cal && cal.can_edit) || isAdmin;

  const openNew = () => { setForm({ id: null, weekday: null, start: '12:00', end: '13:00', label: 'Ebédszünet', global: isAdmin }); setErr(''); setOpen(true); };
  const openEdit = (r) => {
    setForm({ id: r.id, weekday: r.weekday, start: r.start_time, end: r.end_time, label: r.label || '', global: !!r.global });
    setErr(''); setOpen(true);
  };

  const save = async () => {
    setBusy(true); setErr('');
    const { error } = await IV_rpc('interview_break_save', {
      p_id: form.id, p_interviewer: form.global ? null : target,
      p_weekday: form.weekday, p_start: form.start, p_end: form.end,
      p_label: form.label || null, p_active: true, p_global: !!form.global,
    });
    setBusy(false);
    if (error) { setErr(IV_msg(error)); return; }
    setOpen(false); onChanged();
  };

  const remove = async (r) => {
    const { error } = await IV_rpc('interview_break_delete', { p_id: r.id });
    if (error) { setErr(IV_msg(error)); return; }
    onChanged();
  };

  return (
    <IV_Card
      title="Ismétlődő kizárás"
      subtitle="Az ebédszünet és minden más visszatérő szünet. A kizárt időre a szerver sem enged foglalni, nem csak a felület rejti el."
      icon={<Lucide.Coffee size={20} />}
      action={canAdd && <button onClick={openNew} className={U_btnPrimary + ' !py-2.5 !px-4 text-sm'}><Lucide.Plus size={16} /> Új kizárás</button>}
    >
      <div className="space-y-3">
        <IV_Err>{err}</IV_Err>
        {rows.length === 0 && (
          <UEmpty icon={<Lucide.Coffee size={28} />} title="Nincs ismétlődő kizárás"
                  subtitle="Az ebédszünetet a rendszergazda veszi fel, és mindenkire vonatkozik." />
        )}
        {rows.map(r => (
          <IV_Row key={r.id} tone={r.active ? undefined : 'muted'}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center flex-none">
                <Lucide.Coffee size={18} />
              </span>
              <div className="min-w-0">
                <div className="font-black text-slate-800 flex items-center gap-2 flex-wrap">
                  {r.label || 'Kizárt idősáv'}
                  {r.global && <UBadge tone="amber">Mindenkire</UBadge>}
                </div>
                <div className="text-xs text-slate-400">
                  {r.weekday == null ? 'Minden nap' : IV_dayName(r.weekday)} · {r.start_time}–{r.end_time}
                </div>
              </div>
            </div>
            {r.can_edit && (
              <div className="flex items-center gap-2">
                <button onClick={() => openEdit(r)} className={U_btnGhost + ' !py-2 !px-3 text-xs'}><Lucide.Pencil size={14} /> Szerkesztés</button>
                <button onClick={() => remove(r)} className={U_btnGhost + ' !py-2 !px-3 text-xs !text-red-600 hover:!bg-red-50'}><Lucide.Trash2 size={14} /> Törlés</button>
              </div>
            )}
          </IV_Row>
        ))}
      </div>

      <UModal open={open} onClose={() => setOpen(false)} max="max-w-lg"
              title={form.id ? 'Kizárás szerkesztése' : 'Új ismétlődő kizárás'}
              subtitle="Az itt megadott időre senki nem tud interjút foglalni."
              icon={<Lucide.Coffee size={20} />}>
        <div className="space-y-4">
          <IV_Err>{err}</IV_Err>
          <UField label="Megnevezés"><input className={U_input} value={form.label} placeholder="Ebédszünet" onChange={(e) => setForm({ ...form, label: e.target.value })} /></UField>
          <UField label="Nap" hint="Üresen hagyva a hét minden napjára vonatkozik.">
            <IV_WeekdaySelect value={form.weekday} onChange={(v) => setForm({ ...form, weekday: v })} allowAny />
          </UField>
          <div className="grid grid-cols-2 gap-3">
            <UField label="Kezdés"><input type="time" className={U_input} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></UField>
            <UField label="Befejezés"><input type="time" className={U_input} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></UField>
          </div>
          {isAdmin && (
            <label className="flex items-center gap-3 rounded-2xl bg-slate-50 border border-slate-100 px-4 py-3 cursor-pointer">
              <input type="checkbox" checked={!!form.global} onChange={(e) => setForm({ ...form, global: e.target.checked })} className="w-4 h-4" />
              <span className="text-sm text-slate-700 font-bold">Mindenkire vonatkozik</span>
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setOpen(false)} className={U_btnGhost}>Mégse</button>
            <button onClick={save} disabled={busy} className={U_btnPrimary}>{busy ? 'Mentés…' : 'Mentés'}</button>
          </div>
        </div>
      </UModal>
    </IV_Card>
  );
};

/* ---------- eseti kizárás (szabadság) ----------
   Az INDOKLÁS érzékeny adat: a 28-as RLS szerint csak az érintett és az
   admin látja, a jelentkező soha. A felület ezt nem is kéri máshonnan. */
const IV_AbsenceList = ({ cal, target, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ id: null, from: '', to: '', fromTime: '00:00', toTime: '23:59', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const rows = (cal && cal.absences) || [];
  const canEdit = !!(cal && cal.can_edit);

  const openNew = () => {
    const t = new Date().toISOString().slice(0, 10);
    setForm({ id: null, from: t, to: t, fromTime: '00:00', toTime: '23:59', reason: '' });
    setErr(''); setOpen(true);
  };
  const openEdit = (r) => {
    setForm({ id: r.id, from: IV_dateInput(r.starts_at), to: IV_dateInput(r.ends_at),
              fromTime: IV_hhmm(r.starts_at), toTime: IV_hhmm(r.ends_at), reason: r.reason || '' });
    setErr(''); setOpen(true);
  };

  const save = async () => {
    setBusy(true); setErr('');
    const { error } = await IV_rpc('interview_absence_save', {
      p_id: form.id, p_interviewer: target,
      p_starts_at: IV_toIso(form.from, form.fromTime),
      p_ends_at: IV_toIso(form.to, form.toTime),
      p_reason: form.reason || null,
    });
    setBusy(false);
    if (error) { setErr(IV_msg(error)); return; }
    setOpen(false); onChanged();
  };

  const remove = async (r) => {
    const { error } = await IV_rpc('interview_absence_delete', { p_id: r.id });
    if (error) { setErr(IV_msg(error)); return; }
    onChanged();
  };

  return (
    <IV_Card
      title="Szabadság és távollét"
      subtitle="Egyszeri kizárás dátumtartománnyal. Az indoklást csak te és a rendszergazda látja — a jelentkező nem."
      icon={<Lucide.Plane size={20} />}
      action={canEdit && <button onClick={openNew} className={U_btnPrimary + ' !py-2.5 !px-4 text-sm'}><Lucide.Plus size={16} /> Új távollét</button>}
    >
      <div className="space-y-3">
        <IV_Err>{err}</IV_Err>
        {rows.length === 0 && (
          <UEmpty icon={<Lucide.Plane size={28} />} title="Nincs bejelentett távollét"
                  subtitle="Szabadság, kiküldetés vagy betegség idejére vedd fel a tartományt." />
        )}
        {rows.map(r => (
          <IV_Row key={r.id}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center flex-none">
                <Lucide.Plane size={18} />
              </span>
              <div className="min-w-0">
                <div className="font-black text-slate-800">
                  {IV_dateInput(r.starts_at)} {IV_hhmm(r.starts_at)} – {IV_dateInput(r.ends_at)} {IV_hhmm(r.ends_at)}
                </div>
                <div className="text-xs text-slate-400">{r.reason || 'Nincs megadva indoklás'}</div>
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-2">
                <button onClick={() => openEdit(r)} className={U_btnGhost + ' !py-2 !px-3 text-xs'}><Lucide.Pencil size={14} /> Szerkesztés</button>
                <button onClick={() => remove(r)} className={U_btnGhost + ' !py-2 !px-3 text-xs !text-red-600 hover:!bg-red-50'}><Lucide.Trash2 size={14} /> Törlés</button>
              </div>
            )}
          </IV_Row>
        ))}
      </div>

      <UModal open={open} onClose={() => setOpen(false)} max="max-w-lg"
              title={form.id ? 'Távollét szerkesztése' : 'Új távollét'}
              subtitle="A tartományba eső időpontokra nem lehet interjút foglalni."
              icon={<Lucide.Plane size={20} />}>
        <div className="space-y-4">
          <IV_Err>{err}</IV_Err>
          <div className="grid grid-cols-2 gap-3">
            <UField label="Kezdő dátum"><input type="date" className={U_input} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></UField>
            <UField label="Kezdés időpontja"><input type="time" className={U_input} value={form.fromTime} onChange={(e) => setForm({ ...form, fromTime: e.target.value })} /></UField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <UField label="Záró dátum"><input type="date" className={U_input} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></UField>
            <UField label="Befejezés időpontja"><input type="time" className={U_input} value={form.toTime} onChange={(e) => setForm({ ...form, toTime: e.target.value })} /></UField>
          </div>
          <UField label="Indoklás" hint="Belső mező — a jelentkezők nem látják.">
            <input className={U_input} value={form.reason} placeholder="pl. Szabadság" onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </UField>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setOpen(false)} className={U_btnGhost}>Mégse</button>
            <button onClick={save} disabled={busy} className={U_btnPrimary}>{busy ? 'Mentés…' : 'Mentés'}</button>
          </div>
        </div>
      </UModal>
    </IV_Card>
  );
};

/* ---------- beállítások (csak admin) ----------
   A sávhossz azért él BEÁLLÍTÁSBAN, mert a megrendelő szerint változni fog
   (15 → 20 → 10). Az átállítás a MÁR KIADOTT időpontokat nem érinti: azok
   saját kezdet–vég párt hordoznak, a hossz csak az ezután generált sávokra hat. */
const IV_SettingsCard = ({ ctx, onChanged }) => {
  const settings = (ctx && ctx.settings) || [];
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  if (!ctx || !ctx.admin) return null;

  const val = (k) => (draft[k] != null ? draft[k] : (settings.find(s => s.key === k) || {}).value || '');

  const save = async (k) => {
    setBusy(k); setErr(''); setOk('');
    const { error } = await IV_rpc('interview_setting_save', { p_key: k, p_value: String(val(k)) });
    setBusy('');
    if (error) { setErr(IV_msg(error)); return; }
    setOk('A beállítás elmentve. A már kiadott időpontok hossza nem változik.');
    onChanged();
  };

  return (
    <IV_Card title="Foglalási beállítások"
             subtitle="Az idősáv hossza itt állítható — nincs hozzá se migráció, se telepítés."
             icon={<Lucide.Settings2 size={20} />}>
      <div className="space-y-3">
        <IV_Err>{err}</IV_Err>
        <IV_Ok>{ok}</IV_Ok>
        {settings.map(s => (
          <div key={s.key} className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-100 px-4 py-3">
            <div className="flex-1 min-w-[200px]">
              <UField label={s.label || s.key}>
                <input className={U_input} value={val(s.key)} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
              </UField>
            </div>
            <button onClick={() => save(s.key)} disabled={busy === s.key} className={U_btnPrimary + ' !py-2.5 !px-4 text-sm'}>
              {busy === s.key ? 'Mentés…' : 'Mentés'}
            </button>
          </div>
        ))}
      </div>
    </IV_Card>
  );
};

/* ---------- interjúztató-névsor (csak admin) ----------
   NEM profiles.role: a menüszűrő utolsó ága `return false`, egy új szerepkör
   nulla menüpontot adna. Ezért hatókörös névsor (28-as, 4. döntés). */
const IV_RosterCard = ({ ctx, onChanged }) => {
  const [pick, setPick] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!ctx || !ctx.admin) return null;
  const list = (ctx.interviewers) || [];
  const candidates = (ctx.candidates) || [];

  const add = async () => {
    if (!pick) return;
    setBusy(true); setErr('');
    const { error } = await IV_rpc('interview_roster_save', { p_interviewer: pick, p_active: true });
    setBusy(false);
    if (error) { setErr(IV_msg(error)); return; }
    setPick(''); onChanged();
  };
  const toggle = async (r) => {
    const { error } = await IV_rpc('interview_roster_save', { p_interviewer: r.id, p_active: !r.active });
    if (error) { setErr(IV_msg(error)); return; }
    onChanged();
  };

  return (
    <IV_Card title="Interjúztatók"
             subtitle="Aki itt aktív, annak a naptárából generálódnak a foglalható időpontok."
             icon={<Lucide.Users size={20} />}>
      <div className="space-y-3">
        <IV_Err>{err}</IV_Err>
        {list.map(r => (
          <IV_Row key={r.id} tone={r.active ? undefined : 'muted'}>
            <div className="min-w-0">
              <div className="font-black text-slate-800">{r.name}</div>
              <div className="text-xs text-slate-400">{r.email}</div>
            </div>
            <button onClick={() => toggle(r)} className={U_btnGhost + ' !py-2 !px-3 text-xs'}>
              {r.active ? <><Lucide.UserMinus size={14} /> Inaktiválás</> : <><Lucide.UserCheck size={14} /> Aktiválás</>}
            </button>
          </IV_Row>
        ))}
        {candidates.length > 0 && (
          <div className="flex flex-wrap items-end gap-3 pt-2">
            <div className="flex-1 min-w-[220px]">
              <UField label="Munkatárs hozzáadása">
                <select className={U_input} value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Válassz…</option>
                  {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </UField>
            </div>
            <button onClick={add} disabled={!pick || busy} className={U_btnPrimary + ' !py-2.5 !px-4 text-sm'}><Lucide.Plus size={16} /> Hozzáadás</button>
          </div>
        )}
      </div>
    </IV_Card>
  );
};

/* ---------- az ELÉRHETŐSÉG fül ---------- */
const IV_AvailabilityPanel = ({ ctx, reloadCtx }) => {
  const [target, setTarget] = useState(null);
  const [cal, setCal] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // Az interjúztató a SAJÁTJÁT látja; az admin bárkiét, listából választva.
  useEffect(() => {
    if (!ctx) return;
    if (target) return;
    const own = ctx.interviewer_id;
    const first = (ctx.interviewers || [])[0];
    setTarget(own || (first && first.id) || null);
  }, [ctx, target]);

  const load = React.useCallback(async () => {
    if (!target) { setCal(null); return; }
    setLoading(true);
    const { data, error } = await IV_rpc('interview_calendar', { p_interviewer: target });
    setLoading(false);
    if (error) { setErr(IV_msg(error)); setCal(null); return; }
    setErr(''); setCal(data || null);
  }, [target]);

  useEffect(() => { load(); }, [load]);

  const onChanged = () => { load(); reloadCtx && reloadCtx(); };

  if (!ctx) return null;
  const canPick = !!ctx.admin && (ctx.interviewers || []).length > 0;

  if (!ctx.admin && !ctx.interviewer) {
    return (
      <UEmpty icon={<Lucide.ShieldAlert size={28} />} title="Nincs saját interjú-naptárad"
              subtitle="Az elérhetőségi naptárat az interjúztatók és a rendszergazda szerkeszti. Ha interjúztatnál, szólj a rendszergazdának." />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {/* Egyetlen szövegcsomópont, hogy a HU_EN_PHRASES mintája
              („Idősáv: 15 perc") rá tudjon illeszkedni angol módban. */}
          <UBadge tone="primary">{'Idősáv: ' + ctx.slot_minutes + ' perc'}</UBadge>
          <UBadge>{'Időzóna: ' + ctx.timezone}</UBadge>
          <UBadge>{'Előre foglalható: ' + ctx.horizon_days + ' nap'}</UBadge>
        </div>
        {canPick && (
          <div className="min-w-[240px]">
            <UField label="Kinek a naptára">
              <select className={U_input} value={target || ''} onChange={(e) => setTarget(e.target.value || null)}>
                {(ctx.interviewers || []).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </UField>
          </div>
        )}
      </div>

      <IV_Err>{err}</IV_Err>
      {loading && <div className="text-sm text-slate-400">Betöltés...</div>}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <IV_AvailabilityList cal={cal} target={target} onChanged={onChanged} />
        <IV_BreakList cal={cal} ctx={ctx} target={target} onChanged={onChanged} />
        <IV_AbsenceList cal={cal} target={target} onChanged={onChanged} />
        <div className="space-y-6">
          <IV_RosterCard ctx={ctx} onChanged={onChanged} />
          <IV_SettingsCard ctx={ctx} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
};

/* ---------- a FOGLALHATÓ sávok ----------
   A lista a szerverről jön (interview_free_slots), nem a felület szűr:
   így az ebédszünet, a szabadság és a már kiadott időpontok EGYSZER,
   egy helyen esnek ki — és ugyanaz a szabály áll a foglalás útján is. */
function IV_useFreeSlots(ctx, interviewer) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    const { data, error } = await IV_rpc('interview_free_slots', {
      p_from: null, p_to: null, p_interviewer: interviewer || null,
    });
    setLoading(false);
    if (error) { setError(IV_msg(error)); setRows([]); return; }
    setError(''); setRows(Array.isArray(data) ? data : []);
  }, [interviewer]);

  useEffect(() => { load(); }, [load]);
  return { rows, loading, error, reload: load };
}

/* `processId`: a felvételi folyamathoz kötött foglalás (61-es migráció) —
   ilyenkor az interview_book_process fut, amely a szünetet is tartja. */
const IV_SlotPicker = ({ ctx, studentId, processId, onBooked, compact }) => {
  const [interviewer, setInterviewer] = useState('');
  const { rows, loading, error, reload } = IV_useFreeSlots(ctx, interviewer);
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const tz = (ctx && ctx.timezone) || undefined;

  // Napokra bontva: a jelentkező előbb napot választ, utána idősávot.
  // 15 perces bontásnál egy nap 28 sávot is adhat — egyben olvashatatlan lenne.
  const days = React.useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      const k = r.slot_day;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return Array.from(m.entries()).map(([k, v]) => ({ day: k, slots: v }));
  }, [rows]);

  useEffect(() => {
    if (!days.length) { setDay(''); return; }
    if (!days.find(d => d.day === day)) setDay(days[0].day);
  }, [days, day]);

  const current = days.find(d => d.day === day);

  const book = async (slot) => {
    setBusy(slot.slot_start); setErr(''); setOk('');
    const { data, error } = processId
      ? await IV_rpc('interview_book_process', { p_process_id: processId, p_interviewer: slot.iv_id, p_start: slot.slot_start })
      : await IV_rpc('interview_book', { p_interviewer: slot.iv_id, p_start: slot.slot_start, p_student_id: studentId || null });
    setBusy('');
    if (error) { setErr(IV_msg(error)); reload(); return; }
    setOk('Sikeres foglalás! Az időpontot rögzítettük, a Teams-link elkészült.');
    reload();
    onBooked && onBooked(data);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <UBadge tone="primary">{'Idősáv: ' + ((ctx && ctx.slot_minutes) || 15) + ' perc'}</UBadge>
          <UBadge>{rows.length + ' szabad időpont'}</UBadge>
        </div>
        {(ctx && (ctx.interviewers || []).length > 1) && (
          <div className="min-w-[220px]">
            <UField label="Interjúztató">
              <select className={U_input} value={interviewer} onChange={(e) => setInterviewer(e.target.value)}>
                <option value="">Mindegy, aki ráér</option>
                {(ctx.interviewers || []).filter(i => i.active).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </UField>
          </div>
        )}
      </div>

      <IV_Err>{error}</IV_Err>
      <IV_Err>{err}</IV_Err>
      <IV_Ok>{ok}</IV_Ok>

      {loading && <div className="text-sm text-slate-400">Betöltés...</div>}

      {!loading && days.length === 0 && (
        <UEmpty icon={<Lucide.CalendarOff size={28} />} title="Jelenleg nincs szabad időpont."
                subtitle="Az interjúztatók még nem adtak meg elérhetőséget, vagy minden sáv foglalt. Nézz vissza később." />
      )}

      {days.length > 0 && (
        <>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
            {days.map(d => (
              <button key={d.day} onClick={() => setDay(d.day)}
                className={'flex-none px-4 py-3 rounded-2xl border text-left transition-all ' +
                  (d.day === day ? 'bg-primary text-white border-primary shadow-lg shadow-primary/10' : 'bg-white border-slate-100 text-slate-700 hover:border-primary/40')}>
                <div className="text-[10px] font-black uppercase tracking-widest opacity-70">{IV_dayLabel(d.slots[0].slot_start, tz)}</div>
                <div className="text-sm font-black">{d.slots.length + ' szabad sáv'}</div>
              </button>
            ))}
          </div>

          <div className={'grid gap-3 ' + (compact ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6')}>
            {(current ? current.slots : []).map(s => (
              <button key={s.slot_start + s.iv_id} onClick={() => book(s)} disabled={!!busy}
                className="p-4 rounded-2xl border border-slate-100 bg-white hover:border-primary hover:bg-primary/5 transition-all text-left disabled:opacity-50">
                <div className="text-lg font-black text-slate-800">{IV_hhmm(s.slot_start, tz)}</div>
                <div className="text-[11px] text-slate-400 truncate">{s.iv_name}</div>
                <div className="mt-2 text-[10px] font-black uppercase tracking-widest text-primary">
                  {busy === s.slot_start ? 'Foglalás…' : 'Foglalás'}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

/* ---------- ÜGYINTÉZŐI foglalás: sáv + jelentkező ---------- */
const IV_StaffBooking = ({ ctx, students, onBooked }) => {
  const [studentId, setStudentId] = useState('');
  const list = students || [];
  return (
    <div className="space-y-5">
      <div className="max-w-md">
        <UField label="Jelentkező" hint="Interjú-időpontot csak a dokumentum-ellenőrzésen túljutott jelentkező kaphat.">
          <select className={U_input} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            <option value="">Válasszon diákot...</option>
            {list.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </UField>
      </div>
      <IV_SlotPicker ctx={ctx} studentId={studentId || null} onBooked={onBooked} />
    </div>
  );
};

/* ---------- JELENTKEZŐI foglalás ---------- */
const IV_ApplicantBooking = ({ ctx, onBooked }) => (
  <IV_SlotPicker ctx={ctx} studentId={null} onBooked={onBooked} compact />
);

/* ---------- kiadott időpontok (ügyintézői lista) ----------
   A generált sávokból KELETKEZETT sorok az "interviewSlots"-ban élnek, együtt
   a régi, magvetett sorokkal. A lista mindkettőt mutatja: az ügyintézőnek egy
   naptára van, nem kettő. */
const IV_BookedList = ({ slots, tz }) => {
  const rows = (slots || []).filter(s => s.status === 'Booked')
    .slice().sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  return (
    <IV_Card title="Kiadott időpontok" subtitle="Minden lefoglalt interjú, a régi és az újonnan generált sávokból egyaránt."
             icon={<Lucide.CalendarCheck size={20} />}>
      {rows.length === 0
        ? <UEmpty icon={<Lucide.CalendarCheck size={28} />} title="Még nincs kiadott időpont" />
        : (
          <div className="space-y-3">
            {rows.map(s => (
              <IV_Row key={s.id}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center flex-none">
                    <Lucide.Video size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="font-black text-slate-800">{IV_dayLabel(s.startTime, tz)} · {IV_hhmm(s.startTime, tz)}–{IV_hhmm(s.endTime, tz)}</div>
                    <div className="text-xs text-slate-400 truncate">{s.studentName || '—'} · {s.interviewerName || '—'}</div>
                  </div>
                </div>
                <UBadge tone="green">Foglalt</UBadge>
              </IV_Row>
            ))}
          </div>
        )}
    </IV_Card>
  );
};

/* ---------- fülsáv ---------- */
const IV_Tabs = ({ tabs, value, onChange }) => (
  <div className="flex gap-2 overflow-x-auto bg-slate-100 p-1.5 rounded-2xl">
    {tabs.map(t => (
      <button key={t.id} onClick={() => onChange(t.id)}
        className={'flex-none px-5 py-2.5 rounded-xl text-sm font-bold transition-all inline-flex items-center gap-2 ' +
          (value === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
        {t.icon}{t.label}
      </button>
    ))}
  </div>
);
