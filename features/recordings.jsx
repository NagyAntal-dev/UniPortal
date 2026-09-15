/* ============================================================
   UniPortal — Interjúfelvételek (63_letter_log_recordings.sql)
   ------------------------------------------------------------
   A rögzített interjú videó- (vagy hang-) fájlja feltölthető és a böngészőben
   lejátszható. Hol:
     • Interjúnaptár → egy interjú részletei (REC_Lista);
     • Jelentkezés és felvételi → Részletek / részletes nézet interjú-kártyája;
     • Interjú foglalás → „Felvételek” fül: minden felvétel, kereséssel.
   Tárolás: privát 'interview-recordings' tároló, rec/<eljárás>/… útvonal;
   metaadat: public.interview_recordings. Csak a felvételi iroda és az
   interjúztatók férnek hozzá; a jelentkező nem. Lejátszás aláírt, lejáró
   hivatkozással.
   DEFENZÍV: a 63-as migráció nélkül magyarázó üzenet jelenik meg.
   ============================================================ */

const REC_BUCKET = 'interview-recordings';
const REC_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const REC_URL_CACHE = new Map();

async function REC_url(path) {
  if (!path || !window.sb) return '';
  const hit = REC_URL_CACHE.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await window.sb.storage.from(REC_BUCKET).createSignedUrl(path, 3 * 3600);
  if (error || !data) return '';
  REC_URL_CACHE.set(path, { url: data.signedUrl, until: Date.now() + 2.5 * 3600 * 1000 });
  return data.signedUrl;
}
const REC_ido = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let loc = 'hu-HU';
  try { if (localStorage.getItem('nje_lang') === 'en') loc = 'en-GB'; } catch (e) {}
  return d.toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
};

/* Egy felvétel: adatok, lejátszás, letöltés, törlés. */
function REC_Sor({ rec, canEdit, onDeleted, fejlec }) {
  const [url, setUrl] = useState('');
  const [nyitva, setNyitva] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hiba, setHiba] = useState('');
  const hang = String(rec.mime || '').indexOf('audio/') === 0;

  const lejatszas = async () => {
    if (nyitva) { setNyitva(false); return; }
    setHiba('');
    const u = url || await REC_url(rec.path);
    if (!u) { setHiba('A felvétel most nem nyitható meg.'); return; }
    setUrl(u); setNyitva(true);
  };
  const letoltes = async () => {
    const u = url || await REC_url(rec.path);
    if (u) window.open(u, '_blank', 'noopener'); else setHiba('A felvétel most nem nyitható meg.');
  };
  const torles = async () => {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('Biztosan törlöd a felvételt? Ez nem vonható vissza.')) return;
    setBusy(true); setHiba('');
    const { data, error } = await MSG_rpc('interview_recording_delete', { p_id: rec.id });
    if (error) { setBusy(false); setHiba(MSG_hiba(error)); return; }
    try { await window.sb.storage.from(REC_BUCKET).remove([data || rec.path]); } catch (e) {}
    setBusy(false);
    onDeleted && onDeleted(rec);
  };

  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-3 space-y-2" data-rec-sor={rec.id}>
      {fejlec}
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-9 h-9 rounded-xl bg-slate-900 text-white flex items-center justify-center flex-none">{hang ? <Lucide.Mic size={16} /> : <Lucide.Film size={16} />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-slate-800 truncate">{rec.file_name}</div>
          <div className="text-[11px] text-slate-400">{[rec.size_bytes ? DOC_fmtSize(rec.size_bytes) : '', REC_ido(rec.uploaded_at), rec.uploaded_by_name || ''].filter(Boolean).join(' · ')}</div>
          {rec.note && <div className="text-[12px] text-slate-500 mt-0.5">{rec.note}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={lejatszas} data-rec-lejatszas={rec.id} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-white hover:bg-primary/90 inline-flex items-center gap-1.5">
            {nyitva ? <><Lucide.X size={13} /> Lejátszás bezárása</> : <><Lucide.Play size={13} /> Lejátszás</>}
          </button>
          <button type="button" onClick={letoltes} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 inline-flex items-center gap-1.5"><Lucide.Download size={13} /> Letöltés</button>
          {canEdit && <button type="button" onClick={torles} disabled={busy} data-rec-torles={rec.id} className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 hover:bg-red-50 inline-flex items-center gap-1.5 disabled:opacity-50"><Lucide.Trash2 size={13} /> Törlés</button>}
        </div>
      </div>
      {hiba && <div role="alert" className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-[12px] font-semibold text-red-700">{hiba}</div>}
      {nyitva && url && (
        hang
          ? <audio controls src={url} className="w-full" data-rec-lejatszo={rec.id} />
          : <video controls playsInline preload="metadata" src={url} className="w-full max-h-[420px] rounded-xl bg-black" data-rec-lejatszo={rec.id} />
      )}
    </div>
  );
}

/* Egy interjúhoz / felvételi eljáráshoz tartozó felvételek, feltöltéssel. */
function REC_Lista({ processId, slotId, canEdit }) {
  const [lista, setLista] = useState(null);
  const [allapot, setAllapot] = useState('tolt');
  const [hiba, setHiba] = useState('');
  const [feltoltes, setFeltoltes] = useState(null);   // { nev, meret }
  const fajlRef = useRef(null);

  const betolt = React.useCallback(async () => {
    if (!processId && !slotId) { setLista([]); setAllapot('kesz'); return; }
    const { data, error, hianyzik } = await MSG_rpc('interview_recordings_list', { p_process_id: processId || null, p_slot_id: processId ? null : (slotId || null) });
    if (error) { setAllapot(hianyzik ? 'hianyzik' : 'hiba'); if (!hianyzik) setHiba(MSG_hiba(error)); return; }
    setLista(Array.isArray(data) ? data : []); setAllapot('kesz');
  }, [processId, slotId]);
  useEffect(() => { betolt(); }, [betolt]);

  const feltolt = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    setHiba('');
    if (!/^(video|audio)\//.test(file.type || '')) { setHiba('Csak videó- vagy hangfájl tölthető fel.'); return; }
    if (file.size > REC_MAX_BYTES) { setHiba('A fájl túl nagy — legfeljebb 2 GB lehet.'); return; }
    if (!window.sb) { setHiba('Nincs kapcsolat a tárolóval.'); return; }
    setFeltoltes({ nev: file.name, meret: file.size });
    const cel = processId || ('slot-' + slotId);
    const path = ['rec', cel, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '-' + DOC_safeName(file.name)].join('/');
    try {
      const { error: tErr } = await window.sb.storage.from(REC_BUCKET).upload(path, file, { upsert: false, contentType: file.type });
      if (tErr) throw tErr;
      const { error } = await MSG_rpc('interview_recording_add', {
        p_path: path, p_file_name: file.name, p_size: file.size, p_mime: file.type,
        p_process_id: processId || null, p_slot_id: slotId || null, p_note: null,
      });
      if (error) {
        try { await window.sb.storage.from(REC_BUCKET).remove([path]); } catch (x) {}
        throw error;
      }
      await betolt();
    } catch (err) {
      const m = MSG_hiba(err);
      setHiba(/exceeded|too large|maximum allowed size|413|Payload too large/i.test(m) ? 'A fájl túl nagy a tároló beállított korlátjához.' : ('A felvétel feltöltése nem sikerült. ' + m));
    } finally {
      setFeltoltes(null);
    }
  };

  if (allapot === 'hianyzik') {
    return <p className="text-[12px] text-slate-400" data-rec-hianyzik="1">Az interjúfelvételek a 63-as adatbázis-migráció után érhetők el.</p>;
  }
  return (
    <div className="space-y-2" data-rec-lista={processId || slotId || ''}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Lucide.Film size={15} className="text-primary" /><span className="text-xs font-bold text-slate-400 uppercase tracking-wide">Interjúfelvétel</span></div>
        {canEdit && (
          <>
            <input ref={fajlRef} type="file" accept="video/*,audio/*" className="hidden" onChange={feltolt} data-rec-fajlvalaszto="1" />
            <button type="button" disabled={!!feltoltes} onClick={() => fajlRef.current && fajlRef.current.click()}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50">
              {feltoltes ? <Lucide.Loader2 size={13} className="animate-spin" /> : <Lucide.Upload size={13} />} Felvétel feltöltése
            </button>
          </>
        )}
      </div>
      {feltoltes && (
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-[12px] text-slate-600 flex items-center gap-2" role="status" data-rec-feltoltes="1">
          <Lucide.Loader2 size={14} className="animate-spin flex-none" />
          <span className="font-semibold">Feltöltés folyamatban…</span>
          <span className="truncate">{feltoltes.nev + ' · ' + DOC_fmtSize(feltoltes.meret)}</span>
        </div>
      )}
      {hiba && <div role="alert" className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-[12px] font-semibold text-red-700">{hiba}</div>}
      {allapot === 'tolt' && <p className="text-[12px] text-slate-400">Betöltés...</p>}
      {allapot === 'kesz' && lista.length === 0 && !feltoltes && <p className="text-[12px] text-slate-400">Még nincs feltöltött felvétel.</p>}
      {(lista || []).map(r => <REC_Sor key={r.id} rec={r} canEdit={canEdit} onDeleted={() => betolt()} />)}
    </div>
  );
}

/* „Felvételek” fül: minden interjúfelvétel, kereséssel. */
function REC_Felvetelek({ ctx, programName }) {
  const [lista, setLista] = useState(null);
  const [allapot, setAllapot] = useState('tolt');
  const [hiba, setHiba] = useState('');
  const [q, setQ] = useState('');
  const canEdit = !!(ctx && (ctx.admin || ctx.can_manage));

  const betolt = React.useCallback(async () => {
    const { data, error, hianyzik } = await MSG_rpc('interview_recordings_list', { p_process_id: null, p_slot_id: null });
    if (error) { setAllapot(hianyzik ? 'hianyzik' : 'hiba'); if (!hianyzik) setHiba(MSG_hiba(error)); return; }
    setLista(Array.isArray(data) ? data : []); setAllapot('kesz');
  }, []);
  useEffect(() => { betolt(); }, [betolt]);

  if (allapot === 'hianyzik') {
    return (
      <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 flex items-start gap-2" data-rec-hianyzik="1">
        <Lucide.Info size={16} className="flex-none mt-0.5" /><span>Az interjúfelvételek a 63-as adatbázis-migráció után érhetők el.</span>
      </div>
    );
  }
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const azon = (r) => r.ref_no ? 'FV-' + String(r.ref_no).padStart(5, '0') : '';
  const kepzesek = (r) => {
    const ids = Array.isArray(r.program_ids) && r.program_ids.length ? r.program_ids : (r.program_id ? [r.program_id] : []);
    return ids.map(id => (programName ? programName(id) : id));
  };
  const qn = norm(q.trim());
  const szurt = (lista || []).filter(r => !qn || norm([r.applicant_name, r.owner_email, azon(r), r.file_name, ...kepzesek(r)].join(' ')).includes(qn));

  return (
    <div className="space-y-4" data-rec-felvetelek="1">
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-black text-slate-900 flex items-center gap-2"><Lucide.Film size={18} className="text-primary" /> Interjúfelvételek</h3>
            <p className="text-xs text-slate-400 mt-0.5 max-w-[70ch]">Új felvételt az interjú részleteinél (Naptár) vagy a jelentkező Részletek ablakában tölthetsz fel.</p>
            <p className="text-xs text-slate-400 max-w-[70ch]">A felvételek csak a felvételi iroda és az interjúztatók számára láthatók.</p>
          </div>
          <div className="relative sm:w-72">
            <Lucide.Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Keresés: név, azonosító, fájl…" aria-label="Keresés: név, azonosító, fájl…"
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
          </div>
        </div>
      </div>
      {allapot === 'tolt' && <p className="text-sm text-slate-400">Betöltés...</p>}
      {allapot === 'hiba' && <div role="alert" className="rounded-2xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">{hiba}</div>}
      {allapot === 'kesz' && (lista || []).length === 0 && <div className="bg-white rounded-3xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">Még nincs feltöltött felvétel.</div>}
      {allapot === 'kesz' && (lista || []).length > 0 && szurt.length === 0 && <p className="text-sm text-slate-400">Nincs a keresésnek megfelelő felvétel.</p>}
      <div className="grid lg:grid-cols-2 gap-3">
        {szurt.map(r => (
          <REC_Sor key={r.id} rec={r} canEdit={canEdit} onDeleted={() => betolt()}
            fejlec={(
              <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-slate-50">
                <span className="text-sm font-black text-slate-800">{r.applicant_name || '—'}</span>
                {azon(r) && <span className="font-mono text-[11px] font-bold text-slate-400">{azon(r)}</span>}
                {kepzesek(r).length > 0 && <span className="text-[11px] text-slate-500 truncate">{kepzesek(r).join(' · ')}</span>}
              </div>
            )} />
        ))}
      </div>
    </div>
  );
}
