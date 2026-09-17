/* ============================================================
   UniPortal — Interjúnaptár (61_interview_calendar.sql felülete)

   • IV_Calendar          — az ügyintéző / interjúztató heti naptára. Az interjú
                            húzással áthelyezhető, az alsó szélénél húzva
                            hosszabbítható, üres helyre kattintva jelentkező
                            rendelhető egy időponthoz. A kártyára kattintva:
                            áthelyezés dátummal, elutasítás új időpont
                            javaslatával, lemondás.
   • IV_ProcessInterview  — a jelentkező interjú-lépése a felvételi folyamatban:
                            foglalás a szabad sávokból, lemondás, az iroda által
                            javasolt időpont elfogadása vagy elutasítása.

   DEFENZÍV: ha a 61-es migráció még nem futott le, az IV_Calendar magyarázó
   állapotot mutat, az IV_ProcessInterview pedig a hívó által adott régi
   (`fallback`) felületet rendereli — a mostani működés nem romlik el.

   IDŐZÓNA: a rács a böngésző helyi idejében rajzol (mint az IV_toIso). Az
   intézmény és a munkatársak gépe ugyanabban a zónában van; a szerver a
   beállított időzónában ellenőrzi az elérhetőséget.
   ============================================================ */

const IV_nincsFuggveny = (error) => !!error && (
  error.code === 'PGRST202' || error.code === '02000' ||
  /function .* does not exist|Could not find the function|Nincs adatbázis-kapcsolat/i.test(String(error.message || ''))
);

// pxPerMin: kompakt nézet; pxPerMinReszletes: a részletes kártyákhoz (egy 15 perces interjú is két sort kap).
const IV_CAL = { pxPerMin: 1.1, pxPerMinReszletes: 2.4, snap: 5, dayStart: 7 * 60, dayEnd: 19 * 60 };
const IV_pad2 = (n) => String(n).padStart(2, '0');
const IV_ymd = (d) => d.getFullYear() + '-' + IV_pad2(d.getMonth() + 1) + '-' + IV_pad2(d.getDate());
const IV_hm = (d) => IV_pad2(d.getHours()) + ':' + IV_pad2(d.getMinutes());
const IV_mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (IV_isoDow(x) - 1)); return x; };
const IV_addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const IV_minOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const IV_sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const IV_hmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const IV_locale = () => { try { return localStorage.getItem('nje_lang') === 'en' ? 'en-GB' : 'hu-HU'; } catch (e) { return 'hu-HU'; } };
const IV_fmtDay = (d) => d.toLocaleDateString(IV_locale(), { weekday: 'short', month: 'short', day: 'numeric' });
const IV_fmtRange = (s, e) => {
  const a = new Date(s), b = new Date(e);
  return a.toLocaleDateString(IV_locale(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) + ' · ' + IV_hm(a) + '–' + IV_hm(b);
};
const IV_ref = (n) => n ? 'FV-' + String(n).padStart(5, '0') : '';
const IV_norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const IV_STATUS = {
  Booked:    { label: 'Foglalt',           badge: 'primary', cls: 'bg-primary text-white border-primary' },
  Proposed:  { label: 'Javasolt időpont',  badge: 'amber',   cls: 'bg-amber-50 text-amber-900 border-amber-400 border-dashed border-2' },
  Completed: { label: 'Lezajlott',         badge: 'slate',   cls: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const IV_SRAF = { backgroundImage: 'repeating-linear-gradient(135deg, rgba(100,116,139,.16) 0 6px, transparent 6px 12px)' };

/* Egy nap sávjai percben: munkaidő, ismétlődő szünet, távollét. */
function IV_dayBlocks(cal, day) {
  const dow = IV_isoDow(day), ymd = IV_ymd(day);
  const avail = ((cal && cal.availability) || [])
    .filter(a => a.active && Number(a.weekday) === dow && (!a.valid_from || a.valid_from <= ymd) && (!a.valid_to || a.valid_to >= ymd))
    .map(a => ({ from: IV_hmToMin(a.start_time), to: IV_hmToMin(a.end_time) }))
    .filter(x => x.from != null && x.to != null && x.to > x.from);
  const breaks = ((cal && cal.breaks) || [])
    .filter(b => b.active && (b.weekday == null || Number(b.weekday) === dow))
    .map(b => ({ from: IV_hmToMin(b.start_time), to: IV_hmToMin(b.end_time), label: b.label || '' }))
    .filter(x => x.from != null && x.to != null && x.to > x.from);
  const d0 = new Date(day); d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime(), t1 = IV_addDays(d0, 1).getTime();
  const absences = ((cal && cal.absences) || [])
    .map(ab => ({ s: new Date(ab.starts_at).getTime(), e: new Date(ab.ends_at).getTime() }))
    .filter(x => x.s < t1 && x.e > t0)
    .map(x => ({ from: Math.max(0, Math.round((x.s - t0) / 60000)), to: Math.min(1440, Math.round((x.e - t0) / 60000)) }));
  return { avail, breaks, absences };
}

/* Figyelmeztetés (nem tiltás): az ügyintéző a munkaidőn kívülre is tehet interjút. */
function IV_outsideReason(cal, start, end) {
  if (!cal) return '';
  const s = new Date(start), e = new Date(end);
  const day = new Date(s); day.setHours(0, 0, 0, 0);
  const b = IV_dayBlocks(cal, day);
  const sm = IV_minOfDay(s), em = sm + Math.round((e - s) / 60000);
  if (!b.avail.some(a => sm >= a.from && em <= a.to)) return 'Az időpont kívül esik az interjúztató munkaidején.';
  const br = b.breaks.find(x => sm < x.to && em > x.from);
  if (br) return 'Az időpont szünetre esik: ' + (br.label || 'szünet') + '.';
  if (b.absences.some(x => sm < x.to && em > x.from)) return 'Az interjúztató ekkor távol van.';
  return '';
}

/* ============================================================
   NAPTÁR
   ============================================================ */
function IV_Calendar({ ctx, processes, programName, programCode, historyFor, onChanged }) {
  const roster = ((ctx && ctx.interviewers) || []).filter(i => i.active);
  const canManage = !!(ctx && (ctx.can_manage || ctx.admin));
  const [target, setTarget] = useState(null);
  useEffect(() => {
    if (!ctx || target) return;
    setTarget(ctx.interviewer_id || (roster[0] && roster[0].id) || null);
  }, [ctx, target]);

  const [weekStart, setWeekStart] = useState(() => IV_mondayOf(new Date()));
  const [weekend, setWeekend] = useState(false);
  const [events, setEvents] = useState([]);
  const [cal, setCal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState(null);
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [creating, setCreating] = useState(null);
  const colsRef = useRef(null);
  /* A jelentkező METAADATAI a naptárban: részletes kártya (név, képzéskódok,
     azonosító, ország, félév), rámutatásra teljes adatlap, és egy heti lista-
     nézet táblázatban. A választott nézet és sűrűség megmarad. */
  const [suruseg, setSuruseg] = useState(() => { try { return localStorage.getItem('iv_naptar_suruseg') || 'reszletes'; } catch (e) { return 'reszletes'; } });
  const [nezet, setNezet] = useState(() => { try { return localStorage.getItem('iv_naptar_nezet') || 'het'; } catch (e) { return 'het'; } });
  const [hover, setHover] = useState(null);   // { ev, rect }
  useEffect(() => { try { localStorage.setItem('iv_naptar_suruseg', suruseg); localStorage.setItem('iv_naptar_nezet', nezet); } catch (e) {} }, [suruseg, nezet]);
  useEffect(() => {
    if (!hover) return;
    const f = () => setHover(null);
    window.addEventListener('scroll', f, true);
    return () => window.removeEventListener('scroll', f, true);
  }, [!!hover]);

  const nDays = weekend ? 7 : 5;
  const days = Array.from({ length: nDays }, (_, i) => IV_addDays(weekStart, i));
  const mine = !!(target && ctx && target === ctx.interviewer_id);
  const canEdit = canManage || mine;

  const load = React.useCallback(async () => {
    if (!target) { setLoading(false); return; }
    setLoading(true);
    const [ev, c] = await Promise.all([
      IV_rpc('interview_calendar_events', { p_interviewer: target, p_from: weekStart.toISOString(), p_to: IV_addDays(weekStart, 7).toISOString() }),
      IV_rpc('interview_calendar', { p_interviewer: target }),
    ]);
    setLoading(false);
    if (ev.error) {
      if (IV_nincsFuggveny(ev.error)) { setMissing(true); setEvents([]); }
      else setErr(IV_msg(ev.error));
    } else {
      setMissing(false); setErr('');
      setEvents(Array.isArray(ev.data) ? ev.data : []);
    }
    setCal(c.error ? null : (c.data || null));
  }, [target, weekStart]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = POLL_idozit(() => { if (!dragRef.current) load(); }, 60000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!drag) return;
    const esc = (e) => { if (e.key === 'Escape') { dragRef.current = null; setDrag(null); } };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [!!drag]);

  if (!ctx) return null;
  if (!roster.length) {
    return (
      <div className="bg-white rounded-3xl border border-slate-100">
        <UEmpty icon={<Lucide.CalendarOff size={28} />} title="Még nincs interjúztató"
                subtitle="A rendszergazda az Elérhetőség fülön veheti fel a munkatársakat az interjúztatók közé." />
      </div>
    );
  }

  /* ---- a rács magassága: a munkaidő és az interjúk mind látsszanak ---- */
  let rangeStart = IV_CAL.dayStart, rangeEnd = IV_CAL.dayEnd;
  days.forEach(d => {
    IV_dayBlocks(cal, d).avail.forEach(a => {
      rangeStart = Math.min(rangeStart, Math.floor(a.from / 60) * 60);
      rangeEnd = Math.max(rangeEnd, Math.ceil(a.to / 60) * 60);
    });
  });
  events.forEach(e => {
    const s = new Date(e.start), en = new Date(e.end);
    rangeStart = Math.min(rangeStart, Math.floor(IV_minOfDay(s) / 60) * 60);
    rangeEnd = Math.max(rangeEnd, IV_sameDay(s, en) ? Math.ceil(IV_minOfDay(en) / 60) * 60 : 1440);
  });
  rangeStart = Math.max(0, rangeStart); rangeEnd = Math.min(1440, rangeEnd);
  const PX = suruseg === 'kompakt' ? IV_CAL.pxPerMin : IV_CAL.pxPerMinReszletes;
  const height = (rangeEnd - rangeStart) * PX;
  const yOf = (min) => (min - rangeStart) * PX;
  const clip = (x) => ({ from: Math.max(x.from, rangeStart), to: Math.min(x.to, rangeEnd) });
  const hours = [];
  for (let m = Math.ceil(rangeStart / 60) * 60; m <= rangeEnd; m += 60) hours.push(m);
  const today = new Date();

  /* ---- húzás és átméretezés ---- */
  const colWidth = () => { const el = colsRef.current; return el ? el.getBoundingClientRect().width / nDays : 140; };
  const startDrag = (e, ev, mode, card) => {
    if (e.button > 0) return;
    e.stopPropagation();
    try { (card || e.currentTarget).setPointerCapture(e.pointerId); } catch (x) {}
    const st = { id: ev.id, mode, x0: e.clientX, y0: e.clientY, s0: new Date(ev.start), e0: new Date(ev.end), ps: new Date(ev.start), pe: new Date(ev.end), moved: false, cw: colWidth() };
    dragRef.current = st; setDrag(st);
  };
  const moveDrag = (e) => {
    const st = dragRef.current;
    if (!st) return;
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
    if (!st.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    const dMin = Math.round(dy / PX / IV_CAL.snap) * IV_CAL.snap;
    let ps, pe;
    if (st.mode === 'resize') {
      ps = st.s0;
      pe = new Date(Math.max(st.e0.getTime() + dMin * 60000, st.s0.getTime() + IV_CAL.snap * 60000));
    } else {
      const dDay = Math.max(-IV_isoDow(st.s0) + 1, Math.min(nDays - IV_isoDow(st.s0), Math.round(dx / st.cw)));
      ps = new Date(IV_addDays(st.s0, dDay).getTime() + dMin * 60000);
      pe = new Date(ps.getTime() + (st.e0 - st.s0));
    }
    const nst = { ...st, moved: true, ps, pe };
    dragRef.current = nst; setDrag(nst);
  };
  const endDrag = async (ev) => {
    const st = dragRef.current;
    dragRef.current = null; setDrag(null);
    if (!st) return;
    if (!st.moved) { setDetail(ev); return; }
    if (st.ps.getTime() === st.s0.getTime() && st.pe.getTime() === st.e0.getTime()) return;
    await moveEvent(ev, st.ps, st.pe);
  };

  const moveEvent = async (ev, ps, pe) => {
    const elotte = events;
    setEvents(list => list.map(x => x.id === ev.id ? { ...x, start: ps.toISOString(), end: pe.toISOString() } : x));
    const { error } = await IV_rpc('interview_move', { p_slot: ev.id, p_start: ps.toISOString(), p_end: pe.toISOString() });
    if (error) { setEvents(elotte); setErr(IV_msg(error)); return false; }
    const ertesitve = !!ev.process_id && ps.getTime() !== new Date(ev.start).getTime();
    setToast({ warn: IV_outsideReason(cal, ps, pe), ok: ertesitve ? 'Áthelyezve — a jelentkező értesítést kapott.' : 'Mentve.' });
    load(); onChanged && onChanged();
    return true;
  };

  const newAt = (day, min) => {
    const s = new Date(day); s.setHours(0, 0, 0, 0); s.setMinutes(min);
    const len = (ctx && ctx.slot_minutes) || 15;
    setCreating({ start: s, end: new Date(s.getTime() + len * 60000) });
  };
  const onColumnClick = (e, day) => {
    if (!canManage || missing || dragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const min = Math.floor(((e.clientY - rect.top) / PX + rangeStart) / 15) * 15;
    newAt(day, Math.max(0, Math.min(1440 - 15, min)));
  };

  const weekLabel = days[0].toLocaleDateString(IV_locale(), { year: 'numeric', month: 'short', day: 'numeric' })
    + ' – ' + days[nDays - 1].toLocaleDateString(IV_locale(), { month: 'short', day: 'numeric' });

  const renderEvent = (ev) => {
    const s = new Date(ev.start), en = new Date(ev.end);
    const meta = IV_STATUS[ev.status] || IV_STATUS.Booked;
    const editable = canEdit && (ev.status === 'Booked' || ev.status === 'Proposed');
    const top = yOf(IV_minOfDay(s));
    const h = Math.max(20, ((en - s) / 60000) * PX);
    const huzott = drag && drag.moved && drag.id === ev.id;
    const elozmeny = ev.process_id && historyFor ? historyFor(ev.process_id) : [];
    const nev = ev.applicant_name || ev.student_name || '—';
    const ids = Array.isArray(ev.program_ids) && ev.program_ids.length ? ev.program_ids : (ev.program_id ? [ev.program_id] : []);
    const kodok = ids.map(id => (programCode ? programCode(id) : id));
    const felev = ev.term && typeof PROG_termLabel === 'function' ? PROG_termLabel(ev.term, true) : '';
    const sor2 = [kodok.join(', '), IV_ref(ev.ref_no), ev.country || ''].filter(Boolean).join(' · ');
    const sor3 = [felev, ev.status === 'Proposed' ? 'Javasolt' : '', ev.decided ? 'Döntés született' : ''].filter(Boolean).join(' · ');
    return (
      <div key={ev.id} role="button" tabIndex={0} data-iv-esemeny={ev.id}
        aria-label={[nev, IV_hm(s) + '–' + IV_hm(en), sor2, sor3].filter(Boolean).join(', ')}
        onMouseEnter={(e) => { if (!dragRef.current) setHover({ ev, rect: e.currentTarget.getBoundingClientRect() }); }}
        onMouseLeave={() => setHover(x => (x && x.ev.id === ev.id ? null : x))}
        onFocus={(e) => setHover({ ev, rect: e.currentTarget.getBoundingClientRect() })}
        onBlur={() => setHover(null)}
        onPointerDown={editable ? (e) => { setHover(null); startDrag(e, ev, 'move'); } : undefined}
        onPointerMove={editable ? moveDrag : undefined}
        onPointerUp={editable ? () => endDrag(ev) : undefined}
        onPointerCancel={editable ? () => { dragRef.current = null; setDrag(null); } : undefined}
        onClick={(e) => { e.stopPropagation(); if (!editable) setDetail(ev); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(ev); } }}
        className={'absolute left-1 right-1 rounded-xl border px-2 py-1 overflow-hidden shadow-sm select-none focus:outline-none focus:ring-2 focus:ring-primary/40 z-[5] '
          + meta.cls + (editable ? ' cursor-grab active:cursor-grabbing' : ' cursor-pointer') + (huzott ? ' opacity-30' : '')}
        style={{ top, height: h, touchAction: editable ? 'none' : 'auto' }}>
        <div className="flex items-baseline gap-1.5 min-w-0 pr-4 leading-tight">
          <span className="text-[11px] font-black tabular-nums flex-none">{IV_hm(s) + (h >= 48 ? '–' + IV_hm(en) : '')}</span>
          <span className="text-[11px] font-bold truncate" data-iv-nev="1">{nev}</span>
        </div>
        {h >= 30 && sor2 && <div className="text-[10px] font-semibold leading-tight truncate opacity-90" data-iv-meta="1">{sor2}</div>}
        {h >= 44 && sor3 && <div className="text-[10px] leading-tight truncate opacity-80" data-iv-meta2="1">{sor3}</div>}
        {elozmeny.length > 0 && (
          <span title="Korábban elutasított felvételi" className="absolute top-1 right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center">
            <Lucide.AlertTriangle size={10} />
          </span>
        )}
        {editable && (
          <div data-iv-atmeretez="1" aria-hidden="true"
               onPointerDown={(e) => startDrag(e, ev, 'resize', e.currentTarget.parentElement)}
               className="absolute left-0 right-0 bottom-0 h-2.5 cursor-ns-resize" />
        )}
      </div>
    );
  };

  const renderPreview = () => {
    const s = drag.ps, en = drag.pe;
    const top = yOf(IV_minOfDay(s));
    const h = Math.max(20, ((en - s) / 60000) * PX);
    const figy = IV_outsideReason(cal, s, en);
    return (
      <div className={'absolute left-1 right-1 rounded-xl border-2 px-2 py-1 pointer-events-none z-10 ' + (figy ? 'border-amber-500 bg-amber-100/80' : 'border-primary bg-primary/15')} style={{ top, height: h }}>
        <div className={'text-[11px] font-black tabular-nums ' + (figy ? 'text-amber-800' : 'text-primary')}>{IV_hm(s) + '–' + IV_hm(en)}</div>
      </div>
    );
  };

  return (
    <div className="space-y-4" data-iv-naptar="1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-label="Előző hét" onClick={() => setWeekStart(w => IV_addDays(w, -7))} className={U_btnGhost + ' !px-3 !py-2'}><Lucide.ChevronLeft size={16} /></button>
          <button type="button" onClick={() => setWeekStart(IV_mondayOf(new Date()))} className={U_btnGhost + ' !px-4 !py-2 text-sm'}>Ma</button>
          <button type="button" aria-label="Következő hét" onClick={() => setWeekStart(w => IV_addDays(w, 7))} className={U_btnGhost + ' !px-3 !py-2'}><Lucide.ChevronRight size={16} /></button>
          <div className="ml-1 text-lg font-black text-slate-900 tabular-nums" data-iv-het="1">{weekLabel}</div>
          {loading && <Lucide.Loader2 size={16} className="animate-spin text-slate-400" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex p-0.5 rounded-xl bg-slate-100" role="group" aria-label="Nézet">
            {[['het', 'Hét'], ['lista', 'Lista']].map(([k, c]) => (
              <button key={k} type="button" aria-pressed={nezet === k} data-iv-nezet={k} onClick={() => { setHover(null); setNezet(k); }}
                className={'px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ' + (nezet === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>{c}</button>
            ))}
          </div>
          {nezet === 'het' && (
            <div className="inline-flex p-0.5 rounded-xl bg-slate-100" role="group" aria-label="Kártyák">
              {[['reszletes', 'Részletes'], ['kompakt', 'Kompakt']].map(([k, c]) => (
                <button key={k} type="button" aria-pressed={suruseg === k} data-iv-suruseg={k} onClick={() => { setHover(null); setSuruseg(k); }}
                  className={'px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ' + (suruseg === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>{c}</button>
              ))}
            </div>
          )}
          <UBadge tone="primary">{'Idősáv: ' + ctx.slot_minutes + ' perc'}</UBadge>
          <UBadge>{'Szünet: ' + (ctx.break_minutes != null ? ctx.break_minutes : 0) + ' perc'}</UBadge>
          <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-500 cursor-pointer px-2">
            <input type="checkbox" checked={weekend} onChange={e => setWeekend(e.target.checked)} className="w-4 h-4 accent-primary" /> Hétvége
          </label>
          {roster.length > 1 && (
            <select aria-label="Kinek a naptára" className={U_input + ' !py-2 !w-auto min-w-[200px]'} value={target || ''} onChange={e => setTarget(e.target.value || null)}>
              {roster.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          )}
          {canManage && !missing && (
            <button type="button" onClick={() => {
              const alap = IV_sameDay(today, weekStart) || (today > weekStart && today < IV_addDays(weekStart, nDays)) ? today : days[0];
              const min = IV_sameDay(alap, today) ? Math.min(1440 - 15, Math.ceil((IV_minOfDay(today) + 1) / 15) * 15) : 9 * 60;
              newAt(alap, min);
            }} className={U_btnPrimary + ' !py-2 !px-4 text-sm'}><Lucide.Plus size={16} /> Új interjú</button>
          )}
        </div>
      </div>

      {missing && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <Lucide.Info size={16} className="flex-none mt-0.5" />
          <span>A naptár a 61-es adatbázis-migráció lefuttatása után érhető el. Addig az Elérhetőség fülön kezelhető a munkarend.</span>
        </div>
      )}
      {err && (
        <div className="rounded-2xl bg-red-50 border border-red-100 text-red-700 text-sm px-4 py-3 flex items-start gap-2" role="alert">
          <Lucide.AlertTriangle size={16} className="mt-0.5 flex-none" />
          <span className="min-w-0 flex-1">{err}</span>
          <button type="button" aria-label="Bezárás" onClick={() => setErr('')} className="text-red-400 hover:text-red-600"><Lucide.X size={14} /></button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-primary" /> Foglalt</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2 border-dashed border-amber-400 bg-amber-50" /> Javasolt, elfogadásra vár</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-100" /> Munkaidő</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-100" style={IV_SRAF} /> Szünet / távollét</span>
        {canEdit && <span className="text-slate-400 font-semibold">Húzással áthelyezhető, az alsó szélénél hosszabbítható.</span>}
        {canManage && <span className="text-slate-400 font-semibold">Üres helyre kattintva jelentkezőt rendelhetsz hozzá.</span>}
        {nezet === 'het' && <span className="text-slate-400 font-semibold">Rámutatva a jelentkező teljes adatlapja látszik.</span>}
      </div>

      {nezet === 'lista' ? (
        <IV_HetLista days={days} events={events} programName={programName} programCode={programCode} historyFor={historyFor} onOpen={setDetail} />
      ) : (
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <div style={{ minWidth: 64 + nDays * 150 }}>
            <div className="flex border-b border-slate-100 bg-slate-50/60">
              <div className="w-16 flex-none" />
              {days.map(d => {
                const ma = IV_sameDay(d, today);
                return (
                  <div key={IV_ymd(d)} className={'flex-1 px-2 py-2.5 text-center border-l border-slate-100 ' + (ma ? 'text-primary' : 'text-slate-600')}>
                    <div className="text-[11px] font-black uppercase tracking-wider">{IV_fmtDay(d)}</div>
                  </div>
                );
              })}
            </div>
            <div className="flex relative" style={{ height }}>
              <div className="w-16 flex-none relative">
                {hours.map(m => (
                  <div key={m} className="absolute right-2 -translate-y-2 text-[10px] font-bold text-slate-400 tabular-nums" style={{ top: yOf(m) }}>{IV_pad2(Math.floor(m / 60)) + ':00'}</div>
                ))}
              </div>
              <div ref={colsRef} className="flex-1 flex relative">
                {hours.map(m => <div key={'l' + m} className="absolute left-0 right-0 border-t border-slate-100 pointer-events-none" style={{ top: yOf(m) }} />)}
                {days.map(d => {
                  const b = IV_dayBlocks(cal, d);
                  const napi = events.filter(e => IV_sameDay(new Date(e.start), d));
                  const maiNap = IV_sameDay(d, today);
                  return (
                    <div key={IV_ymd(d)} data-iv-nap={IV_ymd(d)} onClick={(e) => onColumnClick(e, d)}
                         className={'flex-1 relative border-l border-slate-100 ' + (canManage && !missing ? 'cursor-copy' : '')}>
                      {b.avail.map((a, i) => { const c = clip(a); return c.to > c.from && <div key={'a' + i} className="absolute inset-x-0 bg-emerald-50/80 pointer-events-none" style={{ top: yOf(c.from), height: (c.to - c.from) * PX }} />; })}
                      {b.breaks.map((x, i) => { const c = clip(x); return c.to > c.from && (
                        <div key={'b' + i} className="absolute inset-x-0 bg-slate-50 pointer-events-none flex justify-center overflow-hidden" style={{ top: yOf(c.from), height: (c.to - c.from) * PX, ...IV_SRAF }}>
                          {x.label && <span className="text-[9px] font-bold text-slate-400 mt-0.5 truncate px-1">{x.label}</span>}
                        </div>
                      ); })}
                      {b.absences.map((x, i) => { const c = clip(x); return c.to > c.from && (
                        <div key={'t' + i} className="absolute inset-x-0 bg-violet-50/90 pointer-events-none flex justify-center overflow-hidden" style={{ top: yOf(c.from), height: (c.to - c.from) * PX, ...IV_SRAF }}>
                          <span className="text-[9px] font-bold text-violet-500 mt-0.5">Távollét</span>
                        </div>
                      ); })}
                      {maiNap && IV_minOfDay(today) >= rangeStart && IV_minOfDay(today) <= rangeEnd && (
                        <div className="absolute inset-x-0 h-0.5 bg-red-500 z-20 pointer-events-none" style={{ top: yOf(IV_minOfDay(today)) }} />
                      )}
                      {napi.map(renderEvent)}
                      {drag && drag.moved && IV_sameDay(drag.ps, d) && renderPreview()}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {hover && !drag && nezet === 'het' && (() => {
        const r = hover.rect, w = 300;
        const vw = window.innerWidth, vh = window.innerHeight;
        const left = r.right + 8 + w <= vw - 8 ? r.right + 8 : Math.max(8, r.left - w - 8);
        const top = Math.max(8, Math.min(r.top, vh - 320));
        return <IV_EsemenyAdatlap ev={hover.ev} programName={programName} programCode={programCode}
          elozmeny={hover.ev.process_id && historyFor ? historyFor(hover.ev.process_id) : []} style={{ left, top, width: w }} />;
      })()}

      {!loading && !missing && events.length === 0 && (
        <p className="text-sm text-slate-400 font-semibold">Ezen a héten nincs interjú ebben a naptárban.</p>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] max-w-[92vw] bg-slate-900 text-white text-sm font-bold px-5 py-3 rounded-2xl shadow-2xl flex items-start gap-2" role="status">
          <Lucide.CheckCircle2 size={16} className="text-emerald-400 flex-none mt-0.5" />
          <span className="flex flex-col gap-0.5">
            {toast.warn && <span className="text-amber-300">{toast.warn}</span>}
            <span>{toast.ok}</span>
          </span>
        </div>
      )}

      {detail && (
        <IV_EventModal ev={detail} ctx={ctx} cal={cal} roster={roster} canManage={canManage}
          canEdit={canEdit && (detail.status === 'Booked' || detail.status === 'Proposed')}
          historyFor={historyFor} programName={programName}
          onClose={() => setDetail(null)}
          onDone={(uz) => { setDetail(null); setToast({ ok: uz }); load(); onChanged && onChanged(); }} />
      )}
      {creating && (
        <IV_AssignModal slot={creating} ctx={ctx} cal={cal} roster={roster} target={target}
          processes={processes} programName={programName} historyFor={historyFor}
          onClose={() => setCreating(null)}
          onDone={(uz) => { setCreating(null); setToast({ ok: uz }); load(); onChanged && onChanged(); }} />
      )}
    </div>
  );
}

/* ---- a jelentkező adatlapja rámutatáskor (a heti rács fölött) ---- */
function IV_EsemenyAdatlap({ ev, programName, programCode, elozmeny, style }) {
  const meta = IV_STATUS[ev.status] || { label: ev.status, badge: 'slate' };
  const ids = Array.isArray(ev.program_ids) && ev.program_ids.length ? ev.program_ids : (ev.program_id ? [ev.program_id] : []);
  const lbl = 'text-[10px] font-black text-slate-400 uppercase tracking-widest';
  return (
    <div role="tooltip" data-iv-adatlap={ev.id} style={style}
      className="fixed z-[90] pointer-events-none bg-white rounded-2xl shadow-2xl border border-slate-100 p-4 space-y-2.5">
      <div>
        <div className="text-sm font-black text-slate-900 leading-snug">{ev.applicant_name || ev.student_name || '—'}</div>
        {ev.applicant_email && <div className="text-[11px] text-slate-400 break-all">{ev.applicant_email}</div>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <UBadge tone={meta.badge}>{meta.label}</UBadge>
        {ev.ref_no && <UBadge>{IV_ref(ev.ref_no)}</UBadge>}
        {ev.country && <UBadge tone="blue">{ev.country}</UBadge>}
        {ev.term && typeof PROG_termLabel === 'function' && <UBadge tone="violet">{PROG_termLabel(ev.term, true)}</UBadge>}
      </div>
      <div className="text-[12px] font-bold text-slate-700 tabular-nums">{IV_fmtRange(ev.start, ev.end)}</div>
      {ids.length > 0 && (
        <div>
          <div className={lbl}>Megjelölt képzések</div>
          <ol className="mt-0.5 space-y-0.5">
            {ids.map((id, i) => {
              const kod = programCode ? programCode(id) : id;
              const nev = programName ? programName(id) : '';
              return <li key={id} className="text-[12px] text-slate-700"><span className="font-black text-slate-500">{(ids.length > 1 ? (i + 1) + '. ' : '') + kod}</span>{nev && nev !== kod ? <span>{' — ' + nev}</span> : null}</li>;
            })}
          </ol>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <div className="min-w-0"><div className={lbl}>Interjúztató</div><div className="font-bold text-slate-700 truncate">{ev.interviewer_name || '—'}</div></div>
        <div><div className={lbl}>Platform</div><div className="font-bold text-slate-700">{ev.teams_url ? 'Microsoft Teams' : '—'}</div></div>
      </div>
      {ev.note && <div className="text-[12px] text-slate-500 whitespace-pre-line">{ev.note}</div>}
      {ev.decided && <div className="text-[11px] font-bold text-emerald-700">Döntés született</div>}
      {elozmeny && elozmeny.length > 0 && <div className="text-[11px] font-bold text-red-600 flex items-center gap-1"><Lucide.AlertTriangle size={12} /> Korábban elutasított felvételi</div>}
    </div>
  );
}

/* ---- heti lista: minden interjú a jelentkező adataival, táblázatban ---- */
function IV_HetLista({ days, events, programName, programCode, historyFor, onOpen }) {
  const th = 'px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-400 whitespace-nowrap';
  return (
    <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden" data-iv-lista="1">
      {days.map(d => {
        const napi = events.filter(e => IV_sameDay(new Date(e.start), d)).sort((a, b) => new Date(a.start) - new Date(b.start));
        return (
          <div key={IV_ymd(d)} className="border-b border-slate-100 last:border-b-0">
            <div className="px-5 py-2.5 bg-slate-50/70 flex items-center justify-between gap-3">
              <span className={'text-[11px] font-black uppercase tracking-wider ' + (IV_sameDay(d, new Date()) ? 'text-primary' : 'text-slate-600')}>{IV_fmtDay(d)}</span>
              <span className="text-[11px] font-bold text-slate-400">{`${napi.length} interjú`}</span>
            </div>
            {napi.length === 0 ? <div className="px-5 py-3 text-sm text-slate-400">Nincs interjú.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm min-w-[900px]">
                  <thead>
                    <tr>
                      <th className={th + ' pl-5'}>Időpont</th><th className={th}>Jelentkező</th><th className={th}>Azonosító</th><th className={th}>Származás</th>
                      <th className={th}>Képzések</th><th className={th}>Félév</th><th className={th}>Állapot</th><th className={th}>Interjúztató</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {napi.map(ev => {
                      const meta = IV_STATUS[ev.status] || { label: ev.status, badge: 'slate' };
                      const ids = Array.isArray(ev.program_ids) && ev.program_ids.length ? ev.program_ids : (ev.program_id ? [ev.program_id] : []);
                      const hist = ev.process_id && historyFor ? historyFor(ev.process_id) : [];
                      return (
                        <tr key={ev.id} data-iv-lista-sor={ev.id} tabIndex={0} onClick={() => onOpen(ev)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(ev); } }}
                          className="align-top hover:bg-slate-50 cursor-pointer focus:outline-none focus-visible:bg-primary/5">
                          <td className="pl-5 pr-3 py-3 font-black text-slate-800 tabular-nums whitespace-nowrap">{IV_hm(new Date(ev.start)) + '–' + IV_hm(new Date(ev.end))}</td>
                          <td className="px-3 py-3">
                            <div className="font-bold text-slate-800">{ev.applicant_name || ev.student_name || '—'}</div>
                            {ev.applicant_email && <div className="text-[11px] text-slate-400">{ev.applicant_email}</div>}
                            {hist.length > 0 && <span className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 text-red-600 text-[10px] font-bold"><Lucide.AlertTriangle size={10} /> Korábban elutasítva</span>}
                          </td>
                          <td className="px-3 py-3 font-mono text-[11px] font-bold text-slate-500 whitespace-nowrap">{IV_ref(ev.ref_no) || '—'}</td>
                          <td className="px-3 py-3 text-[12px] font-semibold text-slate-600 whitespace-nowrap">{ev.country || '—'}</td>
                          <td className="px-3 py-3 text-[12px] text-slate-700">
                            {ids.length ? ids.map((id, i) => {
                              const kod = programCode ? programCode(id) : id;
                              const nev = programName ? programName(id) : '';
                              return <div key={id}><span className="font-black text-slate-500">{(ids.length > 1 ? (i + 1) + '. ' : '') + kod}</span>{nev && nev !== kod ? <span className="text-slate-500">{' ' + nev}</span> : null}</div>;
                            }) : '—'}
                          </td>
                          <td className="px-3 py-3 text-[12px] font-semibold text-violet-700 whitespace-nowrap">{ev.term && typeof PROG_termLabel === 'function' ? PROG_termLabel(ev.term, true) : '—'}</td>
                          <td className="px-3 py-3"><UBadge tone={meta.badge}>{meta.label}</UBadge>{ev.decided && <div className="text-[10px] font-bold text-emerald-700 mt-1">Döntés született</div>}</td>
                          <td className="px-3 py-3 text-[12px] font-semibold text-slate-600 whitespace-nowrap">{ev.interviewer_name || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---- korábbi sikertelen felvételi (figyelmeztető doboz) ---- */
function IV_HistoryWarning({ items }) {
  if (!items || !items.length) return null;
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3" role="note">
      <div className="flex items-center gap-2 text-sm font-black text-red-700"><Lucide.AlertTriangle size={16} /> Korábban elutasított felvételi</div>
      <ul className="mt-1.5 space-y-1">
        {items.map((h, i) => (
          <li key={i} className="text-[12px] text-red-700">
            <span className="font-bold">{h.azon || '—'}</span>
            {h.datum ? <span>{' · ' + ADM_datum(h.datum)}</span> : null}
            {h.leiras ? <span>{' · ' + h.leiras}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ============================================================
   INTERJÚ RÉSZLETEI — áthelyezés, elutasítás + javaslat, lemondás
   ============================================================ */
function IV_EventModal({ ev, ctx, cal, roster, canManage, canEdit, historyFor, programName, onClose, onDone }) {
  const s0 = new Date(ev.start), e0 = new Date(ev.end);
  const hossz = e0 - s0;
  const [mod, setMod] = useState('');
  const [form, setForm] = useState({
    date: IV_ymd(s0), start: IV_hm(s0), end: IV_hm(e0), interviewer: ev.interviewer || '',
    reason: '', csakElutasit: false,
    nDate: IV_ymd(s0), nStart: IV_hm(new Date(s0.getTime() + 60 * 60000)), nInterviewer: ev.interviewer || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const meta = IV_STATUS[ev.status] || { label: ev.status, badge: 'slate' };
  const hist = ev.process_id && historyFor ? historyFor(ev.process_id) : [];
  const ids = Array.isArray(ev.program_ids) && ev.program_ids.length ? ev.program_ids : (ev.program_id ? [ev.program_id] : []);
  const progs = ids.map(id => (programName ? programName(id) : id));

  const run = async (fn, args, uzenet) => {
    setBusy(true); setErr('');
    const { error } = await IV_rpc(fn, args);
    setBusy(false);
    if (error) { setErr(IV_msg(error)); return; }
    onDone(uzenet);
  };

  const mStart = IV_toIso(form.date, form.start), mEnd = IV_toIso(form.date, form.end);
  const mOk = mStart && mEnd && new Date(mEnd) > new Date(mStart);
  const mWarn = mOk ? IV_outsideReason(cal, mStart, mEnd) : '';
  const nStart = IV_toIso(form.nDate, form.nStart);
  const nWarn = !form.csakElutasit && nStart ? IV_outsideReason(cal, nStart, new Date(new Date(nStart).getTime() + hossz)) : '';
  const lbl = 'text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1';

  return (
    <UModal open onClose={onClose} max="max-w-xl" title={ev.applicant_name || ev.student_name || 'Interjú'} subtitle={IV_fmtRange(ev.start, ev.end)} icon={<Lucide.Video size={20} />}>
      <div className="space-y-5" data-iv-reszlet={ev.id}>
        <div className="flex flex-wrap gap-2">
          <UBadge tone={meta.badge}>{meta.label}</UBadge>
          {ev.ref_no && <UBadge>{IV_ref(ev.ref_no)}</UBadge>}
          {ev.country && <UBadge tone="blue">{ev.country}</UBadge>}
          {ev.term && <UBadge tone="violet">{typeof PROG_termLabel === 'function' ? PROG_termLabel(ev.term, true) : ev.term}</UBadge>}
          {ev.decided && <UBadge tone="green">Döntés született</UBadge>}
        </div>
        <IV_HistoryWarning items={hist} />
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div><dt className={lbl}>Interjúztató</dt><dd className="font-bold text-slate-700">{ev.interviewer_name || '—'}</dd></div>
          <div><dt className={lbl}>E-mail</dt><dd className="font-bold text-slate-700 break-all">{ev.applicant_email || '—'}</dd></div>
          <div className="sm:col-span-2"><dt className={lbl}>Megjelölt képzések</dt><dd className="font-bold text-slate-700">{progs.length ? progs.join(' · ') : '—'}</dd></div>
          {ev.note && <div className="sm:col-span-2"><dt className={lbl}>Megjegyzés</dt><dd className="text-slate-600 whitespace-pre-line">{ev.note}</dd></div>}
          {ev.teams_url && <div className="sm:col-span-2"><dt className={lbl}>Microsoft Teams</dt><dd><a href={ev.teams_url} target="_blank" rel="noopener noreferrer" className="text-primary font-bold break-all hover:underline">{ev.teams_url}</a></dd></div>}
        </dl>

        {/* A rögzített interjú feltöltése és lejátszása (63). */}
        {canManage && (
          <div className="pt-3 border-t border-slate-100">
            <REC_Lista processId={ev.process_id || null} slotId={ev.process_id ? null : ev.id} canEdit={canManage} />
          </div>
        )}

        <IV_Err>{err}</IV_Err>

        {canEdit && !mod && (
          <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
            <button type="button" className={U_btnGhost + ' !py-2.5 text-sm'} onClick={() => setMod('move')}><Lucide.CalendarClock size={15} /> Időpont módosítása</button>
            {ev.status === 'Booked' && <button type="button" className={U_btnGhost + ' !py-2.5 text-sm'} onClick={() => setMod('decline')}><Lucide.CalendarX2 size={15} /> Elutasítás, új időpont javaslata</button>}
            <button type="button" className={U_btnGhost + ' !py-2.5 text-sm !text-red-600 hover:!bg-red-50'} onClick={() => setMod('cancel')}><Lucide.XCircle size={15} /> Lemondás</button>
          </div>
        )}

        {mod === 'move' && (
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <UField label="Nap"><input type="date" className={U_input} value={form.date} onChange={e => set('date', e.target.value)} /></UField>
              <UField label="Kezdés"><input type="time" step="300" className={U_input} value={form.start} onChange={e => set('start', e.target.value)} /></UField>
              <UField label="Befejezés"><input type="time" step="300" className={U_input} value={form.end} onChange={e => set('end', e.target.value)} /></UField>
            </div>
            {canManage && roster.length > 1 && (
              <UField label="Interjúztató">
                <select className={U_input} value={form.interviewer} onChange={e => set('interviewer', e.target.value)}>
                  {roster.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </UField>
            )}
            {mWarn && <p className="text-[12px] font-bold text-amber-700">{mWarn}</p>}
            <p className="text-[12px] text-slate-400">Ha az időpont változik, a jelentkező üzenetet kap róla.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={U_btnGhost} onClick={() => setMod('')}>Mégse</button>
              <button type="button" className={U_btnPrimary} disabled={busy || !mOk}
                onClick={() => run('interview_move', { p_slot: ev.id, p_start: mStart, p_end: mEnd, p_interviewer: form.interviewer || null }, 'Az interjú új időpontja elmentve.')}>
                {busy ? 'Mentés…' : 'Mentés'}
              </button>
            </div>
          </div>
        )}

        {mod === 'decline' && (
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <UField label="Indoklás a jelentkezőnek" hint="Ezt a mondatot a jelentkező is látja.">
              <textarea rows={2} className={U_input + ' resize-y'} value={form.reason} placeholder="pl. Az interjúztató ekkor nem ér rá." onChange={e => set('reason', e.target.value)} />
            </UField>
            <label className="flex items-center gap-2.5 text-sm font-bold text-slate-600 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 accent-primary" checked={form.csakElutasit} onChange={e => set('csakElutasit', e.target.checked)} />
              Nem javaslok időpontot — a jelentkező maga választ újat
            </label>
            {!form.csakElutasit && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <UField label="Javasolt nap"><input type="date" className={U_input} value={form.nDate} onChange={e => set('nDate', e.target.value)} /></UField>
                  <UField label="Javasolt kezdés"><input type="time" step="300" className={U_input} value={form.nStart} onChange={e => set('nStart', e.target.value)} /></UField>
                </div>
                {canManage && roster.length > 1 && (
                  <UField label="Interjúztató">
                    <select className={U_input} value={form.nInterviewer} onChange={e => set('nInterviewer', e.target.value)}>
                      {roster.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                  </UField>
                )}
                {nWarn && <p className="text-[12px] font-bold text-amber-700">{nWarn}</p>}
              </>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={U_btnGhost} onClick={() => setMod('')}>Mégse</button>
              <button type="button" className={U_btnPrimary} disabled={busy || (!form.csakElutasit && !nStart)}
                onClick={() => run('interview_decline', {
                  p_slot: ev.id, p_reason: form.reason.trim() || null,
                  p_new_start: form.csakElutasit ? null : nStart,
                  p_new_interviewer: form.csakElutasit ? null : (form.nInterviewer || null),
                }, form.csakElutasit ? 'A foglalást elutasítottuk — a jelentkező új időpontot választ.' : 'Elutasítva, az új időpontot javasoltuk. A jelentkező értesítést kapott.')}>
                {busy ? 'Küldés…' : (form.csakElutasit ? 'Elutasítás' : 'Elutasítás és javaslat küldése')}
              </button>
            </div>
          </div>
        )}

        {mod === 'cancel' && (
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <UField label="Indoklás (nem kötelező)" hint="A jelentkező üzenetet kap a lemondásról.">
              <input className={U_input} value={form.reason} onChange={e => set('reason', e.target.value)} />
            </UField>
            <div className="flex justify-end gap-2">
              <button type="button" className={U_btnGhost} onClick={() => setMod('')}>Mégse</button>
              <button type="button" className={U_btnPrimary + ' !bg-red-600 hover:!bg-red-700'} disabled={busy}
                onClick={() => run('interview_cancel', { p_slot: ev.id, p_reason: form.reason.trim() || null }, 'Az interjút lemondtuk.')}>
                {busy ? 'Lemondás…' : 'Interjú lemondása'}
              </button>
            </div>
          </div>
        )}
      </div>
    </UModal>
  );
}

/* ============================================================
   ÚJ INTERJÚ — jelentkező hozzárendelése egy időponthoz
   ============================================================ */
function IV_AssignModal({ slot, ctx, cal, roster, target, processes, programName, historyFor, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState('');
  const [form, setForm] = useState({ date: IV_ymd(slot.start), start: IV_hm(slot.start), end: IV_hm(slot.end), interviewer: target || '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const lista = (processes || []).filter(p => p && p.id && !(p.data && p.data._cancelled)).map(p => {
    const d = p.data || {};
    const nev = (d.extracted && d.extracted.name) || (d.personal && d.personal.name) || (d.account && d.account.fullName) || p.applicantName || p._owner || 'Jelentkező';
    const iv = d.interview || {};
    const elo = String(iv.slotId || '').indexOf('IV') === 0 && (iv.status === 'Booked' || iv.status === 'Proposed');
    const ids = Array.isArray(d.program_ids) && d.program_ids.length ? d.program_ids : (p.programId ? [p.programId] : (d.programs || []));
    return {
      p, nev, elo,
      email: p._owner || (d.account && d.account.email) || '',
      azon: IV_ref(p.refNo),
      orszag: (d.extracted && d.extracted.country) || (d.personal && d.personal.country) || (d.account && d.account.country) || '',
      progs: ids.map(id => (programName ? programName(id) : id)),
      dontes: !!d.decision,
      hist: historyFor ? historyFor(p.id) : [],
    };
  });
  const qn = IV_norm(q.trim());
  const szurt = lista
    .filter(x => !qn || IV_norm([x.nev, x.email, x.azon, x.orszag, ...x.progs].join(' ')).includes(qn))
    .sort((a, b) => (Number(a.elo || a.dontes) - Number(b.elo || b.dontes)) || String(a.nev).localeCompare(String(b.nev), 'hu'))
    .slice(0, 60);

  const sIso = IV_toIso(form.date, form.start), eIso = IV_toIso(form.date, form.end);
  const idoOk = sIso && eIso && new Date(eIso) > new Date(sIso);
  const warn = idoOk ? IV_outsideReason(cal, sIso, eIso) : '';

  const save = async () => {
    if (!pick) { setErr('Válaszd ki a jelentkezőt.'); return; }
    if (!idoOk) { setErr('Adj meg érvényes kezdést és befejezést.'); return; }
    setBusy(true); setErr('');
    const { error } = await IV_rpc('interview_assign', {
      p_process_id: pick, p_interviewer: form.interviewer || target,
      p_start: sIso, p_end: eIso, p_note: form.note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(IV_msg(error)); return; }
    onDone('Az interjút rögzítettük — a jelentkező értesítést kapott.');
  };

  return (
    <UModal open onClose={onClose} max="max-w-2xl" title="Új interjú" subtitle="Jelentkező hozzárendelése egy időponthoz" icon={<Lucide.CalendarPlus size={20} />}>
      <div className="space-y-5" data-iv-uj="1">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <UField label="Nap"><input type="date" className={U_input} value={form.date} onChange={e => set('date', e.target.value)} /></UField>
          <UField label="Kezdés"><input type="time" step="300" className={U_input} value={form.start} onChange={e => set('start', e.target.value)} /></UField>
          <UField label="Befejezés"><input type="time" step="300" className={U_input} value={form.end} onChange={e => set('end', e.target.value)} /></UField>
        </div>
        {roster.length > 1 && (
          <UField label="Interjúztató">
            <select className={U_input} value={form.interviewer} onChange={e => set('interviewer', e.target.value)}>
              {roster.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </UField>
        )}
        {warn && (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-[13px] px-4 py-3 flex items-start gap-2">
            <Lucide.AlertTriangle size={16} className="flex-none mt-0.5" />
            <span className="flex flex-col"><span className="font-bold">{warn}</span><span>Ügyintézőként ide is teheted az interjút.</span></span>
          </div>
        )}
        <UField label="Jelentkező">
          <div className="relative">
            <Lucide.Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className={U_input + ' pl-10'} placeholder="Név, e-mail, azonosító, ország, képzés…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          </div>
        </UField>
        <div className="max-h-72 overflow-y-auto rounded-2xl border border-slate-100 divide-y divide-slate-50" role="listbox" aria-label="Jelentkezők">
          {szurt.length === 0 && <div className="p-6 text-center text-sm text-slate-400">Nincs a keresésnek megfelelő jelentkező.</div>}
          {szurt.map(x => {
            const tiltott = x.elo || x.dontes;
            const on = pick === x.p.id;
            return (
              <button type="button" role="option" aria-selected={on} key={x.p.id} disabled={tiltott} onClick={() => setPick(x.p.id)}
                className={'w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ' + (on ? 'bg-primary/10' : 'hover:bg-slate-50') + (tiltott ? ' opacity-50 cursor-not-allowed' : '')}>
                <span className={'w-5 h-5 mt-0.5 rounded-full border-2 flex-none ' + (on ? 'border-primary bg-primary' : 'border-slate-300')} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-slate-800">{x.nev}</span>
                    {x.azon && <span className="text-[10px] font-black text-slate-400 tabular-nums">{x.azon}</span>}
                    {x.orszag && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">{x.orszag}</span>}
                    {x.hist.length > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-600">Korábban elutasítva</span>}
                    {x.elo && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Már van interjúja</span>}
                    {x.dontes && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Döntés született</span>}
                  </span>
                  <span className="block text-[12px] text-slate-400 truncate">{[x.email, x.progs.join(', ')].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
            );
          })}
        </div>
        <UField label="Belső megjegyzés (nem kötelező)">
          <input className={U_input} value={form.note} onChange={e => set('note', e.target.value)} />
        </UField>
        <IV_Err>{err}</IV_Err>
        <div className="flex justify-end gap-2">
          <button type="button" className={U_btnGhost} onClick={onClose}>Mégse</button>
          <button type="button" className={U_btnPrimary} disabled={busy || !pick} onClick={save}>{busy ? 'Mentés…' : 'Interjú rögzítése'}</button>
        </div>
      </div>
    </UModal>
  );
}

/* ============================================================
   JELENTKEZŐ — az interjú lépés a felvételi folyamatban
   ============================================================ */
/* ===================== INTERJÚ ÉRTÉKELŐ SZEMPONTRENDSZER =====================
   A korábbi „Interjú értékelő.xlsx” helyett: a szempontokat a rendszergazda a
   felületen bővíti (interview_criterion), a kitöltött lap a jelentkezéshez
   kötődik (interview_evaluation, 66-os migráció). Az összeget és az értékelő
   személyét a szerver számolja — a kliens csak a pontokat küldi.            */
const IVE_KAT = 'interview_criterion';
const IVE_LAP = 'interview_evaluation';
const IVE_nincsTabla = (error) => !!error && (
  error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202' ||
  /does not exist|Could not find the table|schema cache/i.test(String(error.message || ''))
);
const IVE_HIANY = 'Az interjú értékelése a 66-os adatbázis-migráció lefuttatása után érhető el.';
const IVE_EREDMENY = { yes: 'Megfelelt', no: 'Nem felelt meg', pending: 'Nincs eldöntve' };
// Kulcs a megnevezésből: ékezet nélkül, kisbetűvel — a szerver mintája ^[a-z0-9_]{2,60}$.
const IVE_kulcs = (nev) => {
  const alap = String(nev || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return alap.length >= 2 ? alap : ('szempont_' + Math.random().toString(36).slice(2, 8));
};
const IVE_hiba = (error) => {
  if (!error) return '';
  if (error.code === '23505') return 'Ilyen nevű szempont már van.';
  return String(error.message || error.details || 'Ismeretlen hiba.');
};
async function IVE_katalogus(mind) {
  if (!window.sb) return { rows: [], hiba: 'Nincs adatbázis-kapcsolat.' };
  let q = window.sb.from(IVE_KAT).select('*').order('sort_order', { ascending: true });
  if (!mind) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return { rows: [], hiba: IVE_nincsTabla(error) ? IVE_HIANY : IVE_hiba(error) };
  return { rows: Array.isArray(data) ? data : [], hiba: '' };
}
const IVE_cimke = (c) => (typeof localStorage !== 'undefined' && localStorage.getItem('nje_lang') === 'en' && c.label_en) ? c.label_en : c.label_hu;

/* A kitöltő lap a jelentkezés interjúkártyáján. Csak ügyintéző látja (RLS is ezt mondja ki). */
function IVE_Panel({ processId, slotId, interviewerName, canEdit }) {
  const [kat, setKat] = useState(null);
  const [lap, setLap] = useState(null);
  const [pontok, setPontok] = useState({});
  const [eredmeny, setEredmeny] = useState('pending');
  const [megjegyzes, setMegjegyzes] = useState('');
  const [hiba, setHiba] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [nyitva, setNyitva] = useState(false);

  const betolt = React.useCallback(async () => {
    const k = await IVE_katalogus(false);
    setKat(k.rows); if (k.hiba) { setHiba(k.hiba); return; }
    if (!window.sb || !processId) return;
    const { data, error } = await window.sb.from(IVE_LAP).select('*').eq('process_id', processId).maybeSingle();
    if (error) { setHiba(IVE_nincsTabla(error) ? IVE_HIANY : IVE_hiba(error)); return; }
    setHiba('');
    setLap(data || null);
    setPontok((data && data.scores) || {});
    setEredmeny((data && data.result) || 'pending');
    setMegjegyzes((data && data.note) || '');
  }, [processId]);
  useEffect(() => { betolt(); }, [betolt]);

  if (hiba && !kat) return <p className="text-[12px] text-amber-700 font-semibold">{hiba}</p>;
  if (!kat) return <p className="text-sm text-slate-400">Betöltés...</p>;
  if (!kat.length) return <p className="text-[12px] text-slate-500">Még nincs értékelési szempont. A rendszergazda az Interjú foglalás → Értékelés fülön veheti fel őket.</p>;

  const max = kat.reduce((a, c) => a + (Number(c.max_score) || 0), 0);
  const ossz = kat.reduce((a, c) => a + (Number(pontok[c.key]) || 0), 0);
  const ment = async () => {
    if (!window.sb) { setHiba('Nincs adatbázis-kapcsolat.'); return; }
    setBusy(true); setHiba(''); setOk('');
    const tiszta = {};
    kat.forEach(c => { const v = Number(pontok[c.key]); if (Number.isFinite(v) && v > 0) tiszta[c.key] = v; });
    const sor = { process_id: processId, slot_id: slotId || null, scores: tiszta, result: eredmeny,
      note: megjegyzes.trim() || null, interviewer_name: interviewerName || null };
    const res = (lap && lap.id)
      ? await window.sb.from(IVE_LAP).update(sor).eq('id', lap.id).select().maybeSingle()
      : await window.sb.from(IVE_LAP).insert(sor).select().maybeSingle();
    setBusy(false);
    if (res.error) { setHiba(IVE_nincsTabla(res.error) ? IVE_HIANY : IVE_hiba(res.error)); return; }
    if (res.data) { setLap(res.data); setPontok(res.data.scores || tiszta); }
    setOk('Az értékelés elmentve.');
    setNyitva(false);
  };

  const skala = (c) => {
    const ertek = Number(pontok[c.key]) || 0;
    const max1 = Math.max(1, Math.min(10, Number(c.max_score) || 5));
    return (
      <div className="flex flex-wrap items-center gap-1">
        {Array.from({ length: max1 + 1 }, (_, i) => i).map(i => (
          <button key={i} type="button" disabled={!canEdit || !nyitva} data-ive-pont={c.key + ':' + i}
            onClick={() => setPontok(p => ({ ...p, [c.key]: i }))}
            className={'w-8 h-8 rounded-lg text-[12px] font-bold border transition-colors ' +
              (ertek === i ? 'bg-slate-900 text-white border-slate-900'
                           : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400 disabled:hover:border-slate-200 disabled:opacity-60')}>
            {i}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-3" data-ive-panel={processId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Lucide.ClipboardList size={16} className="text-primary" />
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wide">Interjú értékelése</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-black text-slate-800" data-ive-osszesen={ossz}>{ossz + ' / ' + max + ' pont'}</span>
          {lap && <UBadge tone={lap.result === 'yes' ? 'emerald' : lap.result === 'no' ? 'red' : 'slate'}>{IVE_EREDMENY[lap.result] || IVE_EREDMENY.pending}</UBadge>}
        </div>
      </div>
      {lap && lap.evaluated_at && !nyitva && (
        <p className="text-[11px] text-slate-400">{'Utolsó mentés: ' + new Date(lap.evaluated_at).toLocaleString(IV_locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + (lap.interviewer_name ? ' · ' + lap.interviewer_name : '')}</p>
      )}
      <div className="space-y-2">
        {kat.map(c => (
          <div key={c.key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold text-slate-700 min-w-0">{IVE_cimke(c)}</span>
            <div className="flex items-center gap-3">
              {nyitva ? skala(c) : <span className="text-sm font-black text-slate-800">{(Number(pontok[c.key]) || 0) + ' / ' + c.max_score}</span>}
            </div>
          </div>
        ))}
      </div>
      {nyitva && (
        <div className="space-y-3">
          <UField label="Eredmény">
            <select className={U_input} value={eredmeny} onChange={e => setEredmeny(e.target.value)} data-ive-eredmeny="1">
              <option value="pending">Nincs eldöntve</option>
              <option value="yes">Megfelelt</option>
              <option value="no">Nem felelt meg</option>
            </select>
          </UField>
          <UField label="Megjegyzés (nem kötelező)">
            <textarea className={U_input + ' min-h-[72px]'} value={megjegyzes} onChange={e => setMegjegyzes(e.target.value)} />
          </UField>
        </div>
      )}
      {lap && lap.note && !nyitva && <p className="text-[12px] text-slate-500 whitespace-pre-line">{lap.note}</p>}
      <IV_Err>{hiba}</IV_Err>
      <IV_Ok>{ok}</IV_Ok>
      {canEdit && (
        <div className="flex justify-end gap-2">
          {nyitva && <button type="button" className={U_btnGhost + ' !py-2 text-sm'} onClick={() => { setNyitva(false); betolt(); }}>Mégse</button>}
          <button type="button" className={(nyitva ? U_btnPrimary : U_btnGhost) + ' !py-2 text-sm'} disabled={busy}
            onClick={() => (nyitva ? ment() : setNyitva(true))} data-ive-mentes="1">
            {nyitva ? (busy ? 'Mentés…' : 'Értékelés mentése') : (lap ? 'Értékelés szerkesztése' : 'Értékelés kitöltése')}
          </button>
        </div>
      )}
    </div>
  );
}

/* Rendszergazdai fül: a szempontrendszer bővítése és a kitöltött lapok listája. */
function IVE_Szempontok({ ctx }) {
  const admin = !!(ctx && ctx.admin);
  const URES = { key: null, hu: '', en: '', max: 5, sort: 100, active: true, busy: false, hiba: '' };
  const [rows, setRows] = useState(null);
  const [hiba, setHiba] = useState('');
  const [f, setF] = useState(URES);
  const [lapok, setLapok] = useState([]);

  const betolt = React.useCallback(async () => {
    const k = await IVE_katalogus(true);
    setRows(k.rows); setHiba(k.hiba);
    if (!window.sb || k.hiba) return;
    const { data } = await window.sb.from('interview_evaluation_list').select('*').order('evaluated_at', { ascending: false }).limit(500);
    setLapok(Array.isArray(data) ? data : []);
  }, []);
  useEffect(() => { betolt(); }, [betolt]);

  const ment = async () => {
    const hu = f.hu.trim();
    if (hu.length < 2) { setF(x => ({ ...x, hiba: 'A megnevezés legalább 2 karakter.' })); return; }
    if (!window.sb) { setF(x => ({ ...x, hiba: 'Nincs adatbázis-kapcsolat.' })); return; }
    setF(x => ({ ...x, busy: true, hiba: '' }));
    const mezok = { label_hu: hu, label_en: f.en.trim() || null, max_score: Number(f.max) || 5, sort_order: Number(f.sort) || 100, active: !!f.active };
    const res = f.key
      ? await window.sb.from(IVE_KAT).update(mezok).eq('key', f.key).select().maybeSingle()
      : await window.sb.from(IVE_KAT).insert({ key: IVE_kulcs(hu), ...mezok }).select().maybeSingle();
    if (res.error) { setF(x => ({ ...x, busy: false, hiba: IVE_nincsTabla(res.error) ? IVE_HIANY : IVE_hiba(res.error) })); return; }
    setF(URES); betolt();
  };
  const rejt = async (c) => {
    if (!window.sb) return;
    await window.sb.from(IVE_KAT).update({ active: !c.active }).eq('key', c.key).select().maybeSingle();
    betolt();
  };
  const csv = () => {
    const kulcsok = (rows || []).map(c => c.key);
    const fej = ['Dátum', 'Név', 'Azonosító', 'Szak', ...(rows || []).map(c => c.label_hu), 'Összesen', 'Maximum', 'Eredmény', 'Interjúztató', 'Megjegyzés'];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const sorok = (lapok || []).map(r => [
      (r.evaluated_at || '').slice(0, 10), r.personal_name || r.applicant_name || '',
      r.ref_no ? 'FV-' + String(r.ref_no).padStart(5, '0') : '', r.program_id || '',
      ...kulcsok.map(k => (r.scores && r.scores[k] != null ? r.scores[k] : '')),
      r.total, r.max_total, IVE_EREDMENY[r.result] || '', r.interviewer_name || r.slot_interviewer || '', r.note || '',
    ].map(esc).join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + [fej.map(esc).join(','), ...sorok].join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'interju-ertekeles-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const max = (rows || []).filter(c => c.active).reduce((a, c) => a + (Number(c.max_score) || 0), 0);
  return (
    <div className="space-y-6" data-ive-szempontok="1">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-800 text-lg">Értékelési szempontok</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-[75ch]">Ezeket a szempontokat kapja az interjúztató a jelentkezés interjúkártyáján. A sor bármikor bővíthető; a már kitöltött értékelések a régi szempontokkal együtt megmaradnak, ezért törölni nem lehet, csak elrejteni.</p>
          </div>
          <span className="text-sm font-black text-slate-800 whitespace-nowrap">{'Összesen ' + max + ' pont'}</span>
        </div>
        {hiba && <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] font-semibold text-amber-800">{hiba}</div>}
        {rows === null ? <p className="text-sm text-slate-400">Betöltés...</p> : (
          <div className="space-y-2">
            {rows.map(c => (
              <div key={c.key} className={'flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 ' + (c.active ? 'border-slate-100' : 'border-slate-100 bg-slate-50 opacity-70')}>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-700">{c.label_hu}{!c.active && <span className="ml-2 text-[10px] font-bold uppercase text-slate-400">rejtett</span>}</div>
                  {c.label_en && <div className="text-[11px] text-slate-400">{c.label_en}</div>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[12px] font-bold text-slate-500">{'max. ' + c.max_score}</span>
                  {admin && (
                    <>
                      <button type="button" className="text-[12px] font-bold text-primary hover:underline" onClick={() => setF({ key: c.key, hu: c.label_hu, en: c.label_en || '', max: c.max_score, sort: c.sort_order, active: c.active, busy: false, hiba: '' })}>Szerkesztés</button>
                      <button type="button" className="text-[12px] font-bold text-slate-400 hover:text-slate-700" onClick={() => rejt(c)}>{c.active ? 'Elrejtés' : 'Visszaállítás'}</button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {!rows.length && <p className="text-sm text-slate-500">Még nincs felvett szempont.</p>}
          </div>
        )}
        {admin ? (
          <div className="rounded-2xl border border-slate-100 p-4 space-y-3" data-ive-urlap="1">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{f.key ? 'Szempont szerkesztése' : 'Új szempont'}</div>
            <div className="grid sm:grid-cols-2 gap-3">
              <UField label="Megnevezés (magyar)"><input className={U_input} value={f.hu} onChange={e => setF(x => ({ ...x, hu: e.target.value }))} data-ive-uj-hu="1" /></UField>
              <UField label="Megnevezés (angol, nem kötelező)"><input className={U_input} value={f.en} onChange={e => setF(x => ({ ...x, en: e.target.value }))} /></UField>
              <UField label="Maximális pontszám"><input type="number" min="1" max="100" className={U_input} value={f.max} onChange={e => setF(x => ({ ...x, max: e.target.value }))} /></UField>
              <UField label="Sorrend"><input type="number" className={U_input} value={f.sort} onChange={e => setF(x => ({ ...x, sort: e.target.value }))} /></UField>
            </div>
            {f.hiba && <p className="text-[12px] font-semibold text-red-600">{f.hiba}</p>}
            <div className="flex justify-end gap-2">
              {f.key && <button type="button" className={U_btnGhost + ' !py-2 text-sm'} onClick={() => setF(URES)}>Mégse</button>}
              <button type="button" className={U_btnPrimary + ' !py-2 text-sm'} disabled={f.busy} onClick={ment} data-ive-uj-mentes="1">{f.busy ? 'Mentés…' : (f.key ? 'Mentés' : 'Szempont hozzáadása')}</button>
            </div>
          </div>
        ) : <p className="text-[12px] text-slate-400">A szempontokat rendszergazda bővítheti.</p>}
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold text-slate-800 text-lg">Kitöltött értékelések</h3>
          <button type="button" className={U_btnGhost + ' !py-2 text-sm'} onClick={csv} disabled={!lapok.length}><Lucide.Download size={15} /> CSV export</button>
        </div>
        {!lapok.length ? <p className="text-sm text-slate-500">Még nincs kitöltött értékelés.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <tr><th className="py-2 pr-3">Dátum</th><th className="py-2 pr-3">Jelentkező</th><th className="py-2 pr-3">Azonosító</th><th className="py-2 pr-3">Pont</th><th className="py-2 pr-3">Eredmény</th><th className="py-2">Interjúztató</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {lapok.map(r => (
                  <tr key={r.id} data-ive-sor={r.process_id}>
                    <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{(r.evaluated_at || '').slice(0, 10)}</td>
                    <td className="py-2 pr-3 font-semibold text-slate-700">{r.personal_name || r.applicant_name || '—'}</td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-slate-500">{r.ref_no ? 'FV-' + String(r.ref_no).padStart(5, '0') : '—'}</td>
                    <td className="py-2 pr-3 font-bold text-slate-800 whitespace-nowrap">{r.total + ' / ' + r.max_total}</td>
                    <td className="py-2 pr-3">{IVE_EREDMENY[r.result] || '—'}</td>
                    <td className="py-2 text-slate-500">{r.interviewer_name || r.slot_interviewer || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function IV_ProcessInterview({ processId, readOnly, fallback, onState }) {
  const { ctx } = IV_useContext();
  const [st, setSt] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  const load = React.useCallback(async () => {
    if (!processId) { setMissing(true); setLoaded(true); return; }
    const { data, error } = await IV_rpc('interview_process_state', { p_process_id: processId });
    setLoaded(true);
    if (error) {
      if (IV_nincsFuggveny(error)) setMissing(true);
      else setErr(IV_msg(error));
      return;
    }
    setMissing(false); setSt(data || null);
    if (onStateRef.current) onStateRef.current(data || null);
  }, [processId]);

  useEffect(() => {
    load();
    const t = POLL_idozit(load, 45000);
    return () => clearInterval(t);
  }, [load]);

  if (missing) return fallback || null;
  if (!loaded) return <div className="text-sm text-slate-400">Betöltés...</div>;

  const cur = st && st.current;
  const dec = st && st.declined;
  const act = async (fn, args, uzenet) => {
    setBusy(true); setErr(''); setOk('');
    const { error } = await IV_rpc(fn, args);
    setBusy(false);
    if (error) { setErr(IV_msg(error)); load(); return false; }
    setOk(uzenet); load();
    return true;
  };

  return (
    <div className="space-y-4" data-iv-folyamat={processId}>
      <IV_Err>{err}</IV_Err>
      <IV_Ok>{ok}</IV_Ok>

      {cur && cur.status === 'Booked' && (
        <div className="rounded-3xl border border-emerald-100 bg-emerald-50/60 p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-12 h-12 rounded-2xl bg-emerald-500 text-white flex items-center justify-center flex-none"><Lucide.CalendarCheck size={24} /></span>
            <div className="min-w-0">
              <div className="font-black text-slate-800 text-lg">Interjú lefoglalva</div>
              <div className="text-sm text-slate-600 font-semibold">{IV_fmtRange(cur.start, cur.end)}</div>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div><div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Interjúztató</div><div className="font-bold text-slate-700">{cur.interviewer_name || '—'}</div></div>
            <div><div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Platform</div><div className="font-bold text-slate-700 inline-flex items-center gap-1.5"><Lucide.Video size={15} /> Microsoft Teams</div></div>
          </div>
          {cur.teams_url && (
            <a href={cur.teams_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl bg-white border border-slate-100 p-3 hover:border-primary transition-colors">
              <Lucide.Link size={16} className="text-slate-400 flex-none" />
              <span className="font-mono text-xs text-slate-500 truncate flex-1">{cur.teams_url}</span>
            </a>
          )}
          {!readOnly && (
            <button type="button" disabled={busy} onClick={async () => {
              if (typeof window !== 'undefined' && window.confirm && !window.confirm('Biztosan lemondod az interjút? Utána új időpontot választhatsz.')) return;
              await act('interview_cancel', { p_slot: cur.id }, 'Az interjút lemondtad — válassz új időpontot.');
            }} className="text-xs font-bold text-slate-500 hover:text-red-600 disabled:opacity-50">Lemondás és új időpont választása</button>
          )}
        </div>
      )}

      {cur && cur.status === 'Proposed' && (
        <div className="rounded-3xl border-2 border-dashed border-amber-300 bg-amber-50 p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-12 h-12 rounded-2xl bg-amber-500 text-white flex items-center justify-center flex-none"><Lucide.CalendarClock size={24} /></span>
            <div className="min-w-0">
              <div className="font-black text-amber-900 text-lg">Új időpontot javasoltunk</div>
              <div className="text-sm text-amber-800 font-semibold">{IV_fmtRange(cur.start, cur.end)}</div>
            </div>
          </div>
          {dec && (
            <p className="text-sm text-amber-900">
              <span>Az általad választott időpontot nem tudtuk fogadni.</span>
              {dec.note ? <span className="font-semibold">{' ' + dec.note}</span> : null}
            </p>
          )}
          <div className="text-sm text-amber-900"><span className="font-bold">Interjúztató: </span><span>{cur.interviewer_name || '—'}</span></div>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={U_btnPrimary} disabled={busy}
                onClick={() => act('interview_proposal_respond', { p_slot: cur.id, p_accept: true }, 'Elfogadtad az időpontot — az interjú le van foglalva.')}>
                <Lucide.Check size={16} /> Elfogadom
              </button>
              <button type="button" className={U_btnGhost} disabled={busy}
                onClick={() => act('interview_proposal_respond', { p_slot: cur.id, p_accept: false }, 'Rendben — válassz másik időpontot.')}>
                Másik időpontot választok
              </button>
            </div>
          )}
        </div>
      )}

      {!cur && st && st.decided && (
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-600 flex items-start gap-2">
          <Lucide.Info size={16} className="flex-none mt-0.5" />
          <span>A jelentkezésedről döntés született, interjú-időpont már nem foglalható.</span>
        </div>
      )}

      {!cur && !(st && st.decided) && (
        <>
          {dec && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
              <div className="font-black flex items-center gap-2"><Lucide.CalendarX2 size={16} /> A korábbi foglalásodat nem tudtuk fogadni</div>
              <div className="mt-1">
                <span>{IV_fmtRange(dec.start, dec.end)}</span>
                {dec.note ? <span>{' — ' + dec.note}</span> : null}
              </div>
              <div className="mt-1 font-semibold">Kérjük, válassz másik időpontot.</div>
            </div>
          )}
          {readOnly
            ? <p className="text-sm text-slate-400 font-semibold">Még nincs lefoglalt interjú-időpont.</p>
            : <IV_SlotPicker ctx={ctx} processId={processId} compact
                onBooked={() => { setOk('Sikeres foglalás! Az időpontot rögzítettük, a Teams-link elkészült.'); load(); }} />}
        </>
      )}
    </div>
  );
}

/* ============================================================
   ÜGYINTÉZŐ — a felvételi eljárás interjúja a „Részletek” ablakban
   ------------------------------------------------------------
   Az admin a Részletek ablakban és a részletes nézetben is látja és
   szerkesztheti az interjú időpontját: élő interjúnál interview_move (a
   jelentkező üzenetet kap), interjú nélkül interview_assign. Ügyintézőként az
   elérhetőségen és a szüneteken kívülre is tehető (61-es szabály), csak
   ütközés nem lehet — hiba esetén a szerver mondatát mutatjuk.
   ============================================================ */
function IV_AdminProcessInterview({ processId, canEdit, fallback, onChanged }) {
  const { ctx } = IV_useContext();
  const [st, setSt] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const load = React.useCallback(async () => {
    if (!processId) { setMissing(true); setLoaded(true); return; }
    const { data, error } = await IV_rpc('interview_process_state', { p_process_id: processId });
    setLoaded(true);
    if (error) { if (IV_nincsFuggveny(error)) setMissing(true); else setErr(IV_msg(error)); return; }
    setMissing(false); setSt(data || null);
  }, [processId]);
  useEffect(() => { setForm(null); setOk(''); setErr(''); load(); }, [load]);

  if (missing) return fallback || null;
  const cur = st && st.current;
  const dec = st && st.declined;
  const roster = ((ctx && ctx.interviewers) || []).filter(i => i && i.id && i.active !== false);
  const perc = Number((st && st.slot_minutes) || (ctx && ctx.slot_minutes) || 15);
  const meta = cur ? (IV_STATUS[cur.status] || { label: cur.status, badge: 'slate' }) : null;

  const szerkeszt = () => {
    let s;
    if (cur) s = new Date(cur.start);
    else {
      s = new Date(); s.setDate(s.getDate() + 1);
      while (s.getDay() === 0 || s.getDay() === 6) s.setDate(s.getDate() + 1);
      s.setHours(10, 0, 0, 0);
    }
    const e = cur ? new Date(cur.end) : new Date(s.getTime() + perc * 60000);
    setErr(''); setOk('');
    setForm({ date: IV_ymd(s), start: IV_hm(s), end: IV_hm(e), interviewer: (cur && cur.interviewer) || (roster[0] && roster[0].id) || '', note: '' });
  };
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const sIso = form ? IV_toIso(form.date, form.start) : null;
  const eIso = form ? IV_toIso(form.date, form.end) : null;
  const idoOk = !!(sIso && eIso && new Date(eIso) > new Date(sIso));
  const ment = async () => {
    if (!idoOk) { setErr('Adj meg érvényes napot, kezdést és befejezést.'); return; }
    if (!cur && !form.interviewer) { setErr('Válaszd ki az interjúztatót.'); return; }
    setBusy(true); setErr('');
    const note = form.note.trim() || null;
    const { error } = cur
      ? await IV_rpc('interview_move', { p_slot: cur.id, p_start: sIso, p_end: eIso, p_interviewer: form.interviewer || null, p_note: note })
      : await IV_rpc('interview_assign', { p_process_id: processId, p_interviewer: form.interviewer, p_start: sIso, p_end: eIso, p_note: note });
    setBusy(false);
    if (error) { setErr(IV_msg(error)); return; }
    setForm(null);
    setOk(cur ? 'Az interjú új időpontja elmentve — a jelentkező értesítést kapott.' : 'Az interjút rögzítettük — a jelentkező értesítést kapott.');
    await load();
    if (onChanged) onChanged();
  };
  const lbl = 'text-[10px] font-black text-slate-400 uppercase tracking-widest';

  return (
    <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-5 space-y-3" data-iv-admin={processId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Lucide.Video size={16} className="text-primary" /><span className="text-xs font-bold text-slate-400 uppercase tracking-wide">Interjú</span></div>
        {meta && <UBadge tone={meta.badge}>{meta.label}</UBadge>}
      </div>
      {!loaded ? <p className="text-sm text-slate-400">Betöltés...</p> : (
        <>
          {cur ? (
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div><div className={lbl}>Időpont</div><div className="font-bold text-slate-700" data-iv-admin-ido="1">{IV_fmtRange(cur.start, cur.end)}</div></div>
              <div><div className={lbl}>Interjúztató</div><div className="font-bold text-slate-700">{cur.interviewer_name || '—'}</div></div>
              {cur.status === 'Proposed' && <div className="sm:col-span-2 text-[12px] font-bold text-amber-700">Javasolt időpont — a jelentkező még nem fogadta el.</div>}
              {cur.teams_url && <div className="sm:col-span-2"><a href={cur.teams_url} target="_blank" rel="noopener noreferrer" className="text-primary text-[12px] font-bold break-all hover:underline">{cur.teams_url}</a></div>}
              {cur.note && <div className="sm:col-span-2 text-[12px] text-slate-500 whitespace-pre-line">{cur.note}</div>}
            </div>
          ) : <p className="text-sm text-slate-500">Még nincs interjú-időpont ehhez a jelentkezéshez.</p>}
          {dec && <p className="text-[12px] text-slate-500"><span className="font-bold">Korábban elutasított foglalás:</span> <span>{IV_fmtRange(dec.start, dec.end)}</span>{dec.note ? <span>{' — ' + dec.note}</span> : null}</p>}
        </>
      )}
      {canEdit && loaded && (
        <div className="pt-3 border-t border-slate-100">
          <REC_Lista processId={processId} canEdit={canEdit} />
        </div>
      )}
      {canEdit && loaded && (
        <div className="pt-3 border-t border-slate-100">
          <IVE_Panel processId={processId} slotId={cur && cur.id} interviewerName={(cur && cur.interviewer_name) || (ctx && ctx.my_name) || null} canEdit={canEdit} />
        </div>
      )}
      <IV_Err>{err}</IV_Err>
      <IV_Ok>{ok}</IV_Ok>
      {canEdit && loaded && !form && (
        <div className="pt-1">
          <button type="button" className={U_btnGhost + ' !py-2 text-sm'} onClick={szerkeszt} data-iv-admin-szerkeszt="1">
            <Lucide.CalendarClock size={15} /> {cur ? 'Időpont módosítása' : 'Interjú-időpont megadása'}
          </button>
        </div>
      )}
      {form && (
        <div className="space-y-3 pt-3 border-t border-slate-100" data-iv-admin-urlap="1">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <UField label="Nap"><input type="date" className={U_input} value={form.date} onChange={e => set('date', e.target.value)} /></UField>
            <UField label="Kezdés"><input type="time" step="300" className={U_input} value={form.start} onChange={e => set('start', e.target.value)} /></UField>
            <UField label="Befejezés"><input type="time" step="300" className={U_input} value={form.end} onChange={e => set('end', e.target.value)} /></UField>
          </div>
          {roster.length > 0 && (
            <UField label="Interjúztató">
              <select className={U_input} value={form.interviewer} onChange={e => set('interviewer', e.target.value)}>
                {!form.interviewer && <option value="">Válassz…</option>}
                {roster.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </UField>
          )}
          <UField label="Belső megjegyzés (nem kötelező)"><input className={U_input} value={form.note} onChange={e => set('note', e.target.value)} /></UField>
          <p className="text-[12px] text-slate-400">Ha az időpont változik, a jelentkező üzenetet kap róla. Ügyintézőként munkaidőn kívülre is teheted, de más interjúval nem ütközhet.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={U_btnGhost} onClick={() => { setForm(null); setErr(''); }}>Mégse</button>
            <button type="button" className={U_btnPrimary} disabled={busy || !idoOk} onClick={ment}>{busy ? 'Mentés…' : 'Mentés'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
