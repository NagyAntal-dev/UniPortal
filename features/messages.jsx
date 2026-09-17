/* ============================================================
   UniPortal — Üzenetváltás a felvételi eljárásban (62_admission_chat.sql)
   ------------------------------------------------------------
   Az ügyintéző és a jelentkező egy felvételi eljáráshoz kötött
   beszélgetésben ír egymásnak, fájlokat is küldhetnek. Ugyanaz a
   beszélgetés látszik:
     • az ügyintézőnél a Jelentkezés és felvételi → Részletek ablakban és a
       részletes nézetben („Beszélgetés a jelentkezővel”), valamint a
       Kommunikáció és CRM → Jelentkezői üzenetek fülön;
     • a jelentkezőnél az Üzenetek fülön és a jelentkezés nézetében.

   Értesítés: a fejléc csengője, az oldalsáv és a fülek jelvénye az
   olvasatlan üzenetek számát mutatja; új üzenetnél felugró jelzés is jön.
   Frissítés: realtime (a tábla a supabase_realtime publikációban), tartalékul
   időzített lekérdezés.

   Fájlok: a 'documents' tároló chat/<eljárás>/… mappájába kerülnek; ezt a
   62-es tárolási szabály az eljárás résztvevőinek nyitja meg. Megnyitás aláírt
   hivatkozással (DOC_src), mint a dokumentumoknál.

   DEFENZÍV: ha a 62-es migráció még nem futott le, az RPC-k hiányoznak — a
   beszélgetés helyén magyarázó üzenet jelenik meg, a csengő nem számol.
   ============================================================ */

const MSG_MAX_FAJL = 10;
const MSG_MAX_BYTES = 20 * 1024 * 1024;

const MSG_nincsFuggveny = (e) => !!e && (e.code === 'PGRST202' || e.code === '42883'
  || /Could not find the function|function .* does not exist/i.test(String(e.message || '')));
const MSG_hiba = (e) => String((e && (e.message || e.details || e.error)) || e || 'Ismeretlen hiba.');

async function MSG_rpc(name, args) {
  if (!window.sb) return { data: null, error: { message: 'Nincs adatbázis-kapcsolat.' }, hianyzik: false };
  try {
    const valasz = await window.sb.rpc(name, args || {});
    const { data, error } = valasz;
    // Sebességkorlát: a háttérfrissítések álljanak le egy időre, különben a
    // 429-re azonnal újabb kérésekkel válaszolnánk.
    if (POLL_nezdKorlat(valasz)) {
      return { data: null, error: { message: 'Túl sok kérés — néhány másodperc múlva újra.' }, hianyzik: false, korlat: true };
    }
    if (error) return { data: null, error, hianyzik: MSG_nincsFuggveny(error) };
    return { data, error: null, hianyzik: false };
  } catch (e) {
    return { data: null, error: { message: MSG_hiba(e) }, hianyzik: false };
  }
}

function MSG_ido(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let loc = 'hu-HU';
  try { if (localStorage.getItem('nje_lang') === 'en') loc = 'en-GB'; } catch (e) {}
  const most = new Date();
  const ora = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === most.toDateString()) return ora;
  const opt = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== most.getFullYear()) opt.year = 'numeric';
  return d.toLocaleDateString(loc, opt) + ' ' + ora;
}

/* ---------- oldalszintű olvasatlan-számláló (egy lekérdező mindenkinek) ---------- */
const MSG_STORE = { szam: 0, elerheto: null, elozo: null, fut: false, feliratkozok: new Set() };
function MSG_ertesit() { MSG_STORE.feliratkozok.forEach(f => { try { f(); } catch (e) {} }); }
async function MSG_frissitSzam() {
  const { data, error, hianyzik } = await MSG_rpc('msg_unread_count');
  if (error) {
    if (hianyzik && MSG_STORE.elerheto !== false) { MSG_STORE.elerheto = false; MSG_STORE.szam = 0; MSG_ertesit(); }
    return;
  }
  const uj = Number(data) || 0;
  const elozo = MSG_STORE.elozo;
  MSG_STORE.elerheto = true;
  MSG_STORE.szam = uj;
  MSG_STORE.elozo = uj;
  if (elozo !== null && uj > elozo) {
    try { window.dispatchEvent(new CustomEvent('msg:uj', { detail: { szam: uj, kulonbseg: uj - elozo } })); } catch (e) {}
  }
  MSG_ertesit();
}
// Küldés vagy olvasottnak jelölés után: a számlálók és a listák frissüljenek.
function MSG_valtozott() { try { window.dispatchEvent(new Event('msg:valtozas')); } catch (e) {} }
function MSG_inditas() {
  if (MSG_STORE.fut) return;
  MSG_STORE.fut = true;
  POLL_idozit(MSG_frissitSzam, 30000);
  window.addEventListener('msg:valtozas', MSG_frissitSzam);
  try {
    if (window.sb && window.sb.channel) {
      let idozito = null;
      window.sb.channel('msg_ertesito')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'admission_messages' }, () => {
          clearTimeout(idozito);
          idozito = setTimeout(() => { MSG_frissitSzam(); try { window.dispatchEvent(new Event('msg:tavoli')); } catch (e) {} }, 400);
        })
        .subscribe();
    }
  } catch (e) {}
}
function MSG_useOlvasatlan() {
  const [, setV] = useState(0);
  useEffect(() => {
    const f = () => setV(v => v + 1);
    MSG_STORE.feliratkozok.add(f);
    MSG_inditas();
    return () => { MSG_STORE.feliratkozok.delete(f); };
  }, []);
  return { szam: MSG_STORE.szam, elerheto: MSG_STORE.elerheto };
}

// Eljárásonkénti összesítő (olvasatlan, összes) — a listák jelvényeihez.
function MSG_useInboxTerkep() {
  const [terkep, setTerkep] = useState({});
  useEffect(() => {
    let el = true;
    const f = async () => {
      const { data, error } = await MSG_rpc('msg_inbox', { p_mind: false });
      if (!el || error || !Array.isArray(data)) return;
      const t = {};
      data.forEach(x => { t[x.process_id] = x; });
      setTerkep(t);
    };
    f();
    const i = POLL_idozit(f, 30000);
    window.addEventListener('msg:tavoli', f);
    window.addEventListener('msg:valtozas', f);
    return () => { el = false; clearInterval(i); window.removeEventListener('msg:tavoli', f); window.removeEventListener('msg:valtozas', f); };
  }, []);
  return terkep;
}

/* ---------- fájlok ---------- */
async function MSG_feltolt(processId, file) {
  if (!window.sb) throw new Error('Nincs kapcsolat a tárolóval.');
  if (file.size > MSG_MAX_BYTES) throw new Error('A fájl túl nagy — legfeljebb 20 MB lehet.');
  const veletlen = Math.random().toString(36).slice(2, 10);
  const path = ['chat', processId, Date.now().toString(36) + '-' + veletlen + '-' + DOC_safeName(file.name)].join('/');
  // A típust nem a böngészőtől vesszük át vakon: az ismeretlen fájl
  // letöltendő bájthalmazként megy fel, nem futtatható dokumentumként.
  const tipus = FELT_dokumentumTipus(file);
  const { error } = await window.sb.storage.from(DOC_BUCKET).upload(path, file, { upsert: false, contentType: tipus });
  if (error) throw error;
  return { path, name: file.name, size: file.size, type: tipus };
}
async function MSG_megnyit(f, docs) {
  const bejegyzes = f.path ? { path: f.path } : (f.ref && docs ? docs[f.ref] : null);
  if (!bejegyzes) return false;
  const url = await DOC_src(bejegyzes);
  if (!url) return false;
  window.open(url, '_blank', 'noopener');
  return true;
}

const MSG_Jelveny = ({ szam, menu }) => {
  if (!szam) return null;
  return (
    <span data-msg-jelveny={szam} className={'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black tabular-nums '
      + (menu ? 'bg-white text-primary ml-auto' : 'bg-primary text-white ml-2')}>{szam > 99 ? '99+' : szam}</span>
  );
};
// Az olvasatlan összes szám jelvénye (oldalsáv, fülek).
function MSG_OlvasatlanJelveny({ menu }) {
  const { szam } = MSG_useOlvasatlan();
  return <MSG_Jelveny szam={szam} menu={menu} />;
}
// Melyik menüpont kapja az olvasatlan-jelvényt.
function MSG_menuJelvenyKell(user, id) {
  if (!user) return false;
  if (user.role === 'STUDENT') return id === AppView.STUDENT_PORTAL;
  return id === AppView.ENGAGEMENT_CRM || id === AppView.ADMISSIONS_CORE;
}

/* ---------- a felvételi levél értesítője (63/64) ----------
   A szerver (letter_log_send) „Felvételi leveled elkészült” rendszerüzenetet ír;
   a 64-es migráció óta a levél PDF-je is csatolmánya (kind = 'letter'). A régebbi,
   PDF nélküli értesítőt a tárgyáról ismerjük fel. */
const MSG_LEVEL_TARGY = 'Felvételi leveled elkészült';
const MSG_levelUzenet = (m) => !!m && m.sender_role === 'system'
  && ((Array.isArray(m.files) && m.files.some(f => f && f.kind === 'letter')) || m.subject === MSG_LEVEL_TARGY);
/* A jelentkezőnél a levél megnyitása: a StudentPortal a Felvételi folyamat fülre vált,
   az AdmissionsHub a levél lépésén nyitja meg az eljárást (window.__njeLevel). */
function MSG_levelMegnyitas(processId) {
  if (!processId) return;
  try {
    window.__njeLevel = { processId };
    window.dispatchEvent(new CustomEvent('nje:level', { detail: { processId } }));
  } catch (e) {}
}

/* ============================================================
   Beszélgetés egy felvételi eljárásban
   role: 'staff' | 'applicant'
   docs: az eljárás data.docs-a (a dokumentum-hivatkozások megnyitásához)
   hivatkozasok / onHivatkozasTorles: az ügyintéző a dokumentumlistából
     jelölhet ki hivatkozott dokumentumot (a régi „Hivatkozás” gomb)
   ============================================================ */
function MSG_Thread({ processId, role, docs, hivatkozasok, onHivatkozasTorles, magassag, onLevelMegnyit }) {
  const [adat, setAdat] = useState(null);
  const [allapot, setAllapot] = useState('tolt');   // tolt | kesz | hianyzik | hiba
  const [hiba, setHiba] = useState('');
  const [szoveg, setSzoveg] = useState('');
  const [targy, setTargy] = useState('');
  const [fajlok, setFajlok] = useState([]);         // [{ id, file }]
  const [kuld, setKuld] = useState(false);
  const [levelNezet, setLevelNezet] = useState(null);   // az irodánál: a kiküldött levél megtekintése
  const listaRef = useRef(null);
  const fajlRef = useRef(null);
  const refs = hivatkozasok || [];

  const betolt = React.useCallback(async (csendes) => {
    if (!processId) return;
    const { data, error, hianyzik } = await MSG_rpc('msg_thread', { p_process_id: processId });
    if (error) {
      if (hianyzik) setAllapot('hianyzik');
      else if (!csendes) { setAllapot('hiba'); setHiba(MSG_hiba(error)); }
      return;
    }
    setAdat(data || null);
    setAllapot('kesz');
    const uz = (data && data.messages) || [];
    const olvasatlan = uz.some(m => role === 'staff'
      ? (m.sender_role === 'applicant' && !m.read_by_staff_at)
      : (m.sender_role !== 'applicant' && !m.read_by_applicant_at));
    if (olvasatlan && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
      const r = await MSG_rpc('msg_mark_read', { p_process_id: processId });
      if (!r.error) MSG_valtozott();
    }
  }, [processId, role]);

  useEffect(() => {
    setAdat(null); setAllapot('tolt'); setHiba('');
    betolt();
    const t = POLL_idozit(() => betolt(true), 20000);
    const f = () => betolt(true);
    window.addEventListener('msg:tavoli', f);
    return () => { clearInterval(t); window.removeEventListener('msg:tavoli', f); };
  }, [betolt]);

  const uzenetek = (adat && adat.messages) || [];
  useEffect(() => {
    const el = listaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [uzenetek.length, allapot]);

  const fajlValaszt = (e) => {
    const lista = Array.from((e.target && e.target.files) || []);
    if (e.target) e.target.value = '';
    setHiba('');
    const uj = [];
    for (const file of lista) {
      if (fajlok.length + uj.length >= MSG_MAX_FAJL) { setHiba('Egy üzenethez legfeljebb 10 fájl csatolható.'); break; }
      if (file.size > MSG_MAX_BYTES) { setHiba('A fájl túl nagy — legfeljebb 20 MB lehet.'); continue; }
      uj.push({ id: Math.random().toString(36).slice(2), file });
    }
    if (uj.length) setFajlok(f => [...f, ...uj]);
  };

  const kuldheto = !kuld && (szoveg.trim() || fajlok.length || refs.length);
  const kuldes = async () => {
    if (!kuldheto) return;
    setKuld(true); setHiba('');
    try {
      const feltoltott = [];
      for (const f of fajlok) feltoltott.push(await MSG_feltolt(processId, f.file));
      const csatolt = [...feltoltott, ...refs.map(a => ({ ref: a.id, name: a.label || a.fileName || a.id }))];
      const { error } = await MSG_rpc('msg_send', { p_process_id: processId, p_body: szoveg.trim(), p_subject: targy.trim() || null, p_files: csatolt });
      if (error) throw error;
      setSzoveg(''); setTargy(''); setFajlok([]);
      if (onHivatkozasTorles) onHivatkozasTorles();
      await betolt(true);
      MSG_valtozott();
    } catch (e) {
      const m = MSG_hiba(e);
      setHiba(/row-level security|violates|unauthorized|403/i.test(m)
        ? 'A fájl feltöltése nem engedélyezett. Jelentkezz ki és be újra; ha így sem megy, szólj az ügyintézőnek.'
        : /exceeded|too large|maximum allowed size|413/i.test(m) ? 'A fájl túl nagy — legfeljebb 20 MB lehet.' : m);
    } finally {
      setKuld(false);
    }
  };

  if (allapot === 'hianyzik') {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2" data-msg-hianyzik="1">
        <Lucide.Info size={16} className="flex-none mt-0.5" />
        <span>{role === 'staff' ? 'Az üzenetküldéshez le kell futtatni a 62-es adatbázis-migrációt (62_admission_chat.sql).' : 'Az üzenetküldés hamarosan elérhető.'}</span>
      </div>
    );
  }

  const sajatOldal = (m) => role === 'staff' ? m.sender_role === 'staff' : m.sender_role === 'applicant';
  const utolsoSajat = [...uzenetek].reverse().find(m => sajatOldal(m));
  const fajlChip = (f, i, sajat) => (
    <button key={(f.path || f.ref || '') + i} type="button" data-msg-fajl={f.name}
      onClick={async () => { const ok = await MSG_megnyit(f, docs); if (!ok) setHiba('A fájl most nem nyitható meg.'); }}
      title={f.ref ? 'dokumentum-hivatkozás' : f.name}
      className={'max-w-full inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold transition-colors ' + (sajat ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-white border border-slate-200 hover:border-primary text-slate-700')}>
      {f.ref ? <Lucide.FileCheck size={12} className="flex-none" /> : f.kind === 'letter' ? <Lucide.FileText size={12} className="flex-none" /> : <Lucide.Paperclip size={12} className="flex-none" />}
      <span className="truncate">{f.name}</span>
      {f.size ? <span className={sajat ? 'text-white/70' : 'text-slate-400'}>{DOC_fmtSize(f.size)}</span> : null}
    </button>
  );

  return (
    <div className="space-y-3" data-msg-szal={processId}>
      {levelNezet && <LEVEL_Megtekinto processId={processId} letterId={levelNezet.letterId} onClose={() => setLevelNezet(null)} />}
      <div ref={listaRef} className={'space-y-3 overflow-y-auto pr-1 ' + (magassag || 'max-h-[420px]')} aria-live="polite">
        {allapot === 'tolt' && <div className="text-center py-8 text-slate-400 text-sm">Betöltés...</div>}
        {allapot === 'hiba' && <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-sm text-red-700">{hiba}</div>}
        {allapot === 'kesz' && uzenetek.length === 0 && <div className="text-center py-8 text-slate-400 text-sm">Még nincs üzenet ebben a beszélgetésben.</div>}
        {uzenetek.map(m => {
          if (m.sender_role === 'system') {
            const levelE = MSG_levelUzenet(m);
            const levelFajl = levelE && Array.isArray(m.files) ? m.files.find(f => f && f.kind === 'letter') : null;
            return (
              <div key={m.id} className="flex justify-center" data-msg-uzenet="system">
                <div className={'max-w-[92%] rounded-2xl border px-4 py-2.5 text-center ' + (levelE ? 'border-emerald-100 bg-emerald-50/60' : 'border-slate-100 bg-slate-50')}>
                  <div className="text-[10px] font-bold text-slate-400">{[m.sender_name, MSG_ido(m.created_at)].filter(Boolean).join(' · ')}</div>
                  {m.subject && <div className="text-sm font-bold text-slate-700">{m.subject}</div>}
                  {m.body && <div className="text-sm text-slate-600 whitespace-pre-wrap">{m.body}</div>}
                  {Array.isArray(m.files) && m.files.length > 0 && <div className="flex flex-wrap justify-center gap-1.5 mt-2">{m.files.map((f, i) => fajlChip(f, i, false))}</div>}
                  {levelE && (
                    <div className="mt-2 flex justify-center" data-msg-level={m.id}>
                      {role === 'applicant' ? (
                        <button type="button" data-msg-level-megnyit={processId} onClick={() => (onLevelMegnyit ? onLevelMegnyit() : MSG_levelMegnyitas(processId))}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-bold text-white hover:bg-primary/90 transition-colors">
                          <Lucide.ExternalLink size={13} /> Megnyitás a Felvételi folyamatban
                        </button>
                      ) : (
                        <button type="button" data-msg-level-megnyit={processId} onClick={() => setLevelNezet({ letterId: (levelFajl && levelFajl.letter_id) || null })}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-700 hover:border-primary transition-colors">
                          <Lucide.Eye size={13} /> Kiküldött levél megtekintése
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          const sajat = sajatOldal(m);
          const latta = m === utolsoSajat && (role === 'staff' ? m.read_by_applicant_at : m.read_by_staff_at);
          return (
            <div key={m.id} className={'flex flex-col ' + (sajat ? 'items-end' : 'items-start')} data-msg-uzenet={m.sender_role}>
              <div className={'max-w-[88%] rounded-2xl px-4 py-2.5 ' + (sajat ? 'bg-primary text-white rounded-br-md' : 'bg-white border border-slate-100 text-slate-800 rounded-bl-md')}>
                <div className={'text-[10px] font-bold mb-0.5 ' + (sajat ? 'text-white/75' : 'text-slate-400')}>{[m.sender_name || (m.sender_role === 'staff' ? 'Külügyi Iroda' : 'Jelentkező'), MSG_ido(m.created_at)].filter(Boolean).join(' · ')}</div>
                {m.subject && <div className="text-sm font-bold">{m.subject}</div>}
                {m.body && <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>}
                {Array.isArray(m.files) && m.files.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{m.files.map((f, i) => fajlChip(f, i, sajat))}</div>}
              </div>
              {latta && <span className="text-[10px] font-bold text-slate-400 mt-0.5">{role === 'staff' ? 'Látta' : 'Olvasva'}</span>}
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-100 pt-3 space-y-2" data-msg-uzenetiro="1">
        {role === 'staff' && (
          <input value={targy} onChange={e => setTargy(e.target.value)} placeholder="Tárgy (nem kötelező)" maxLength={200}
            className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none" />
        )}
        <textarea value={szoveg} onChange={e => setSzoveg(e.target.value)} rows={2} maxLength={8000}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); kuldes(); } }}
          placeholder={role === 'staff' ? 'Írj üzenetet a jelentkezőnek…' : 'Írj üzenetet a felvételi irodának…'}
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none resize-y min-h-[64px]" />
        {(fajlok.length > 0 || refs.length > 0) && (
          <div className="flex flex-wrap gap-1.5" data-msg-csatolt={fajlok.length + refs.length}>
            {fajlok.map(f => (
              <span key={f.id} className="max-w-full text-[11px] font-bold px-2 py-1 rounded-lg bg-primary/10 text-primary inline-flex items-center gap-1">
                <Lucide.Paperclip size={11} className="flex-none" /><span className="truncate">{f.file.name}</span><span className="text-primary/60">{DOC_fmtSize(f.file.size)}</span>
                <button type="button" aria-label="Csatolmány eltávolítása" title="Csatolmány eltávolítása" onClick={() => setFajlok(x => x.filter(y => y.id !== f.id))} className="ml-0.5 hover:text-primary/70"><Lucide.X size={11} /></button>
              </span>
            ))}
            {refs.map(a => (
              <span key={'ref-' + a.id} className="max-w-full text-[11px] font-bold px-2 py-1 rounded-lg bg-slate-100 text-slate-600 inline-flex items-center gap-1">
                <Lucide.FileCheck size={11} className="flex-none" /><span className="truncate">{a.label || a.id}</span>
              </span>
            ))}
          </div>
        )}
        {hiba && allapot !== 'hiba' && <div role="alert" className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-[12px] font-semibold text-red-700">{hiba}</div>}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <input ref={fajlRef} type="file" multiple className="hidden" onChange={fajlValaszt} data-msg-fajlvalaszto="1" />
            <button type="button" onClick={() => fajlRef.current && fajlRef.current.click()} disabled={kuld}
              className="px-3 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 inline-flex items-center gap-1.5 disabled:opacity-50">
              <Lucide.Paperclip size={14} /> Fájl csatolása
            </button>
            <span className="hidden sm:inline text-[11px] text-slate-400">Ctrl + Enter: küldés</span>
          </div>
          <button type="button" onClick={kuldes} disabled={!kuldheto} data-msg-kuldes="1"
            className="bg-primary text-white px-5 py-2 rounded-xl font-bold text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2">
            {kuld ? <Lucide.Loader2 size={15} className="animate-spin" /> : <Lucide.Send size={15} />} {kuld ? 'Küldés…' : 'Küldés'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Beszélgetéslista + beszélgetés (két panel)
   role: 'staff' — Kommunikáció és CRM; 'applicant' — a jelentkező Üzenetek füle
   ============================================================ */
function MSG_Inbox({ role }) {
  const [lista, setLista] = useState(null);
  const [allapot, setAllapot] = useState('tolt');
  const [hiba, setHiba] = useState('');
  const [valasztott, setValasztott] = useState(null);
  const [q, setQ] = useState('');
  const [csakOlvasatlan, setCsakOlvasatlan] = useState(false);
  const [mind, setMind] = useState(false);
  const [kat, setKat] = useState([]);

  useEffect(() => {
    let el = true;
    if (typeof PROG_loadPrograms === 'function') PROG_loadPrograms().then(p => { if (el) setKat(p || []); }).catch(() => {});
    return () => { el = false; };
  }, []);

  const betolt = React.useCallback(async () => {
    const { data, error, hianyzik } = await MSG_rpc('msg_inbox', { p_mind: role === 'staff' && mind });
    if (error) { setAllapot(hianyzik ? 'hianyzik' : 'hiba'); setHiba(MSG_hiba(error)); return; }
    setLista(Array.isArray(data) ? data : []);
    setAllapot('kesz');
  }, [role, mind]);

  useEffect(() => {
    betolt();
    const t = POLL_idozit(betolt, 30000);
    window.addEventListener('msg:tavoli', betolt);
    window.addEventListener('msg:valtozas', betolt);
    return () => { clearInterval(t); window.removeEventListener('msg:tavoli', betolt); window.removeEventListener('msg:valtozas', betolt); };
  }, [betolt]);

  // Széles kijelzőn (és a jelentkezőnél) az első beszélgetés rögtön nyitva van.
  useEffect(() => {
    if (valasztott || !lista || !lista.length) return;
    if (role === 'applicant' || (typeof window !== 'undefined' && window.innerWidth >= 1024)) setValasztott(lista[0].process_id);
  }, [lista]);

  const kepzesNevek = (x) => {
    const ids = Array.isArray(x.program_ids) && x.program_ids.length ? x.program_ids : (x.program_id ? [x.program_id] : []);
    return ids.map(id => { const k = kat.find(p => p.id === id); return k ? k.name : id; });
  };
  const azon = (x) => x.ref_no ? 'FV-' + String(x.ref_no).padStart(5, '0') : '';
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const qn = norm(q.trim());
  const szurt = (lista || []).filter(x => (!csakOlvasatlan || x.unread > 0)
    && (!qn || norm([x.applicant_name, x.owner_email, azon(x), ...kepzesNevek(x)].join(' ')).includes(qn)));
  const akt = (lista || []).find(x => x.process_id === valasztott) || null;

  if (allapot === 'hianyzik') {
    return (
      <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 flex items-start gap-3" data-msg-hianyzik="1">
        <Lucide.Info size={18} className="flex-none mt-0.5" />
        <span>{role === 'staff' ? 'Az üzenetküldéshez le kell futtatni a 62-es adatbázis-migrációt (62_admission_chat.sql).' : 'Az üzenetküldés hamarosan elérhető.'}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden min-h-[560px] lg:h-[calc(100vh-280px)]" data-msg-inbox={role}>
      <div className={'w-full lg:w-80 xl:w-96 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-100 flex-col ' + (akt ? 'hidden lg:flex' : 'flex')}>
        <div className="p-4 border-b border-slate-100 space-y-2">
          <div className="relative">
            <Lucide.Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Beszélgetés keresése…" aria-label="Beszélgetés keresése…"
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" aria-pressed={!csakOlvasatlan} onClick={() => setCsakOlvasatlan(false)} className={'px-3 py-1 rounded-full text-[11px] font-bold ' + (!csakOlvasatlan ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500')}>Mind</button>
            <button type="button" aria-pressed={csakOlvasatlan} onClick={() => setCsakOlvasatlan(true)} className={'px-3 py-1 rounded-full text-[11px] font-bold ' + (csakOlvasatlan ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500')}>Olvasatlan</button>
            {role === 'staff' && (
              <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-500 cursor-pointer">
                <input type="checkbox" className="accent-primary" checked={mind} onChange={e => setMind(e.target.checked)} /> Új beszélgetés: minden eljárás
              </label>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto max-h-[60vh] lg:max-h-none" role="list">
          {allapot === 'tolt' && <div className="p-6 text-center text-sm text-slate-400">Betöltés...</div>}
          {allapot === 'hiba' && <div className="m-4 rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-sm text-red-700">{hiba}</div>}
          {allapot === 'kesz' && szurt.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-400">
              {(lista || []).length === 0
                ? (role === 'staff' ? 'Még nincs üzenetváltás a jelentkezőkkel.' : 'Még nincs felvételi eljárásod. Üzenetet a felvételi irodának egy jelentkezésből küldhetsz.')
                : 'Nincs találat.'}
            </div>
          )}
          {szurt.map(x => {
            const nevek = kepzesNevek(x);
            const cim = role === 'staff' ? (x.applicant_name || x.owner_email) : (nevek.join(' · ') || 'Felvételi eljárás');
            const sajatUtolso = x.last_role && (role === 'staff' ? x.last_role === 'staff' : x.last_role === 'applicant');
            return (
              <button key={x.process_id} type="button" role="listitem" data-msg-beszelgetes={x.process_id} onClick={() => setValasztott(x.process_id)}
                className={'w-full text-left p-4 border-l-4 border-b border-b-slate-50 transition-colors ' + (valasztott === x.process_id ? 'bg-primary/5 border-l-primary' : 'border-l-transparent hover:bg-slate-50')}>
                <div className="flex items-start justify-between gap-2">
                  <span className={'text-sm truncate ' + (x.unread > 0 ? 'font-black text-slate-900' : 'font-bold text-slate-700')}>{cim}</span>
                  <span className="text-[10px] text-slate-400 font-semibold whitespace-nowrap tabular-nums">{MSG_ido(x.last_at)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                  {azon(x) && <span className="font-mono text-[10px] font-bold text-slate-400">{azon(x)}</span>}
                  {role === 'staff' && nevek.length > 0 && <span className="text-[10px] font-semibold text-slate-400 truncate">{nevek.join(' · ')}</span>}
                  {x.cancelled && <span className="text-[10px] font-bold px-1.5 rounded bg-slate-100 text-slate-500">Megszakítva</span>}
                </div>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <span className={'text-xs truncate ' + (x.unread > 0 ? 'text-slate-700 font-semibold' : 'text-slate-400')}>
                    {x.total > 0
                      ? <>{sajatUtolso && <span>Te: </span>}{x.last_files > 0 && <Lucide.Paperclip size={11} className="inline -mt-0.5 mr-0.5" />}<span>{x.last_body || (x.last_files > 0 ? 'Csatolmány' : '')}</span></>
                      : <span>Még nincs üzenet</span>}
                  </span>
                  <MSG_Jelveny szam={x.unread} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className={'flex-1 min-w-0 flex-col bg-slate-50/40 ' + (akt ? 'flex' : 'hidden lg:flex')}>
        {!akt ? (
          <div className="flex-1 flex items-center justify-center p-8 text-sm text-slate-400">Válassz beszélgetést.</div>
        ) : (
          <>
            <div className="p-4 bg-white border-b border-slate-100 flex items-center gap-3">
              <button type="button" onClick={() => setValasztott(null)} className="lg:hidden w-9 h-9 rounded-xl hover:bg-slate-100 flex items-center justify-center text-slate-500" aria-label="Vissza a beszélgetésekhez" title="Vissza a beszélgetésekhez"><Lucide.ChevronLeft size={18} /></button>
              <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-black flex-none">
                {role === 'staff' ? (String(akt.applicant_name || akt.owner_email || '?')[0] || '?').toUpperCase() : <Lucide.Building2 size={18} />}
              </div>
              <div className="min-w-0">
                <div className="font-bold text-slate-800 text-sm truncate">{role === 'staff' ? (akt.applicant_name || akt.owner_email) : 'Felvételi iroda'}</div>
                <div className="text-[11px] text-slate-400 truncate">{[azon(akt), role === 'staff' ? akt.owner_email : '', kepzesNevek(akt).join(' · '), akt.term && typeof PROG_termLabel === 'function' ? PROG_termLabel(akt.term, true) : ''].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div className="flex-1 min-h-0 p-4 flex flex-col">
              <MSG_Thread key={akt.process_id} processId={akt.process_id} role={role} magassag="max-h-[50vh] lg:max-h-none lg:flex-1" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Fejléc: csengő az olvasatlan számmal + felugró jelzés új üzenetnél
   ============================================================ */
function MSG_Csengo({ user, onOpen }) {
  const { szam } = MSG_useOlvasatlan();
  const [jelzes, setJelzes] = useState(null);
  const alapCim = useRef(typeof document !== 'undefined' ? document.title.replace(/^\(\d+\+?\)\s*/, '') : '');

  // Felhasználóváltáskor elölről számolunk (az első betöltés nem „új üzenet”).
  useEffect(() => { MSG_STORE.elozo = null; MSG_frissitSzam(); }, [user && user.id]);
  useEffect(() => {
    const f = (e) => setJelzes({ at: Date.now(), n: (e && e.detail && e.detail.kulonbseg) || 1 });
    window.addEventListener('msg:uj', f);
    return () => window.removeEventListener('msg:uj', f);
  }, []);
  useEffect(() => {
    if (!jelzes) return;
    const t = setTimeout(() => setJelzes(null), 8000);
    return () => clearTimeout(t);
  }, [jelzes]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = szam > 0 ? '(' + (szam > 99 ? '99+' : szam) + ') ' + alapCim.current : alapCim.current;
  }, [szam]);

  const cimke = szam > 0 ? `${szam} olvasatlan üzenet` : 'Nincs olvasatlan üzenet';
  return (
    <>
      <button type="button" onClick={onOpen} title={cimke} aria-label={cimke} data-msg-csengo={szam}
        className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-slate-50 transition-colors text-slate-500 relative">
        <Lucide.Bell size={20} />
        {szam > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center border-2 border-white tabular-nums">{szam > 99 ? '99+' : szam}</span>}
      </button>
      {jelzes && (
        <div role="status" aria-live="polite" data-msg-jelzes="1"
          className="fixed top-20 right-4 z-[120] w-[calc(100%-2rem)] max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-100 p-4 flex items-start gap-3">
          <span className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-none"><Lucide.MessageSquare size={18} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-slate-800">Új üzenet érkezett</div>
            <div className="text-xs text-slate-500">{cimke}</div>
            {onOpen && <button type="button" onClick={() => { setJelzes(null); onOpen(); }} className="mt-2 text-xs font-bold text-primary hover:underline">Megnyitás</button>}
          </div>
          <button type="button" onClick={() => setJelzes(null)} aria-label="Bezárás" title="Bezárás" className="text-slate-300 hover:text-slate-500"><Lucide.X size={16} /></button>
        </div>
      )}
    </>
  );
}
