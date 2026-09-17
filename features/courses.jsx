/* ===========================================================================
   courses.jsx — KURZUSNYILVÁNTARTÁS
   ---------------------------------------------------------------------------
   Az adat nagy része már régóta megvolt: echo.course (kód, név, félév, nyelv,
   szervezeti egység, létszám, órarendi info, vizsgakurzus), echo.course_teacher
   (ki tanítja, milyen óraaránnyal) és echo.enrollment (KI vette fel MELYIK
   kurzust — a félév a kurzuson van). Erre épül az alkalmassági motor és a
   kampányok célközönség-választója is. Ami hiányzott, az a felület, a
   kurzusleírás és a fájlok — ezt adja ez a modul (43_course_registry.sql).

   KI LÁTJA: ügyintéző (is_staff) és a kurzus OKTATÓJA. A hallgató NEM — ez
   belső nyilvántartás, nem oktatási platform. A szűrés a SZERVEREN történik:
   az echo_course_list() az oktatónak csak a saját kurzusait adja vissza.

   SZERKESZTENI csak ügyintéző tud; az oktató olvas és fájlt tölthet fel a
   saját kurzusához.
   =========================================================================== */

const CRS_PGERR = {
  ECHO_NOT_AUTHENTICATED: 'Nincs bejelentkezve.',
  ECHO_FORBIDDEN:         'Ehhez nincs jogosultságod.',
  ECHO_COURSE_NOT_FOUND:  'Ez a kurzus nem található.',
  ECHO_TEACHER_NOT_FOUND: 'Ez az oktató nem található.',
  ECHO_DOC_NOT_FOUND:     'Ez a dokumentum már nincs meg.',
};

function CRS_msg(e) {
  const raw = (e && (e.message || e.hint || e.details)) || String(e || '');
  const kod = (raw.match(/^([A-Z_]{4,})/) || [])[1];
  if (kod && CRS_PGERR[kod]) return CRS_PGERR[kod];
  // A szerver üzenetei szándékosan elmondják az OKOT is (pl. hogy a törlés
  // miért veszélyes) — a kódot levágjuk, a magyarázatot meghagyjuk.
  return raw.replace(/^[A-Z_]{4,}:\s*/, '') || 'Ismeretlen hiba.';
}

async function CRS_rpc(fn, args) {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const { data, error } = await window.sb.rpc(fn, args || {});
  if (error) throw error;
  return data;
}

const CRS_api = {
  list:     (term, q)        => CRS_rpc('echo_course_list', { p_term: term || null, p_q: q || null }),
  get:      (id)             => CRS_rpc('echo_course_get', { p_course: id }),
  students: (id, q, mind)    => CRS_rpc('echo_course_students',
                                  { p_course: id, p_q: q || null, p_all_terms: !!mind }),
  history:  (id)             => CRS_rpc('echo_course_history', { p_course: id }),
  options:  (kind, id, q)    => CRS_rpc('echo_course_options',
                                  { p_kind: kind, p_course: id || null, p_q: q || null, p_limit: 60 }),
  save:     (p)              => CRS_rpc('echo_course_save', p),
  del:      (id)             => CRS_rpc('echo_course_delete', { p_course: id }),
  teacher:  (id, t, sh, r, rm) => CRS_rpc('echo_course_teacher_set',
                                  { p_course: id, p_teacher: t, p_share: sh ?? null,
                                    p_role: r || null, p_remove: !!rm }),
  enroll:   (id, profiles, group, action) => CRS_rpc('echo_course_enroll',
                                  { p_course: id, p_profiles: profiles || null,
                                    p_group: group || null, p_action: action || 'add' }),
  docAdd:   (id, cim, fajlnev, path, mime, meret, fajta) => CRS_rpc('echo_course_document_add',
                                  { p_course: id, p_cim: cim, p_fajlnev: fajlnev, p_path: path,
                                    p_mime: mime || null, p_meret: meret ?? null, p_fajta: fajta || 'egyeb' }),
  docDel:   (doc)            => CRS_rpc('echo_course_document_remove', { p_doc: doc }),
  mine:     ()               => CRS_rpc('echo_my_enrollments'),
};

// A változásnapló mezőnevei emberi alakban. Ami nincs a listán, az nyersen
// jelenik meg — jobb egy ismeretlen oszlopnév, mint egy hazug címke.
// Az oktatoi szerep az echo.course_teacher.role zart ertekkeszlete. Nyersen
// "oktato"/"kurzusfelelos" alakban jelent meg a hallgatoi nezetben — ami nem
// hibas, csak nem magyar. Ami nincs a listan, az nyersen marad.
const CRS_OKT_ROLE = {
  kurzusfelelos: 'kurzusfelelős',
  oktato:        'oktató',
  gyakvezeto:    'gyakorlatvezető',
  vendeg:        'vendégoktató',
};

const CRS_MEZO = {
  letrehozas: 'létrehozás', code: 'kurzuskód', name_hu: 'megnevezés',
  name_en: 'angol megnevezés', term: 'félév', lang: 'nyelv',
  org_unit_id: 'szervezeti egység', letszam: 'létszám',
  van_orarendi_info: 'órarendi információ', vizsgakurzus: 'vizsgakurzus',
  leiras: 'leírás', leiras_en: 'angol leírás', oktato: 'oktató',
};

const CRS_FAJTA = {
  tanterv:  'Tanterv',
  tananyag: 'Tananyag',
  leiras:   'Leírás',
  egyeb:    'Egyéb',
};

function CRS_meret(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' kB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

// A fájlnév az útvonalba kerül: ami nem betű, szám, pont vagy kötőjel, az
// kiesik. Enélkül egy ékezetes vagy szóközös név aláírt URL-nél megbicsaklik.
function CRS_safeName(n) {
  return String(n || 'fajl')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'fajl';
}


/* --- Kereső legördülő egy típushoz (oktató / hallgató / csoport) --------- */
function CRS_Picker({ kind, courseId, cimke, onPick, gomb }) {
  const [nyit, setNyit] = useState(false);
  const [q, setQ]       = useState('');
  const [opts, setOpts] = useState(null);
  const [err, setErr]   = useState('');

  useEffect(() => {
    if (!nyit) return;
    let el = true;
    const t = setTimeout(() => {
      CRS_api.options(kind, courseId, q)
        .then(d => { if (el) { setOpts(Array.isArray(d) ? d : []); setErr(''); } })
        .catch(e => { if (el) { setOpts([]); setErr(CRS_msg(e)); } });
    }, 250);
    return () => { el = false; clearTimeout(t); };
  }, [nyit, q, kind, courseId]);

  return (
    <div className="relative">
      <button type="button" onClick={() => { setNyit(v => !v); setQ(''); }}
        className="text-[11px] font-black text-primary hover:underline">
        {nyit ? 'Kész' : (gomb || '+ ' + cimke)}
      </button>
      {nyit && (
        <div className="absolute right-0 z-20 mt-2 w-80 bg-white border border-slate-200
                        rounded-2xl shadow-xl p-3">
          <input className={U_input + ' text-sm'} value={q} autoFocus
            onChange={e => setQ(e.target.value)} placeholder="Keresés…" />
          {err && <p className="text-[11px] text-red-500 font-bold mt-2">{err}</p>}
          <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
            {opts === null ? <SkeletonBar h={32} /> : opts.length === 0 ? (
              <p className="text-[11px] text-slate-300 font-bold italic py-2">nincs találat</p>
            ) : opts.map(o => (
              <button key={o.id} type="button"
                onClick={() => { onPick(o); setNyit(false); }}
                className="w-full text-left px-3 py-2 rounded-xl border border-slate-100
                           hover:border-primary hover:bg-orange-50/40 transition">
                <span className="block text-xs font-bold text-slate-700 truncate">{o.cimke}</span>
                <span className="block text-[10px] text-slate-400 font-bold truncate">{o.reszlet}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


/* --- Kurzus-űrlap (új / szerkesztés) ------------------------------------ */
function CRS_Form({ open, kurzus, onClose, onDone }) {
  const uj = !kurzus;
  const [f, setF]     = useState({});
  const [orgs, setOrgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  useEffect(() => {
    if (!open) return;
    setErr(''); setBusy(false);
    setF({
      code: (kurzus && kurzus.code) || '',
      name_hu: (kurzus && kurzus.name_hu) || '',
      name_en: (kurzus && kurzus.name_en) || '',
      term: (kurzus && kurzus.term) || '',
      lang: (kurzus && kurzus.lang) || 'hu',
      org_unit_id: (kurzus && kurzus.org_unit_id) || '',
      letszam: (kurzus && kurzus.letszam != null) ? String(kurzus.letszam) : '',
      van_orarendi_info: kurzus ? !!kurzus.van_orarendi_info : true,
      vizsgakurzus: kurzus ? !!kurzus.vizsgakurzus : false,
      leiras: (kurzus && kurzus.leiras) || '',
      leiras_en: (kurzus && kurzus.leiras_en) || '',
    });
    CRS_api.options('org_unit').then(d => setOrgs(Array.isArray(d) ? d : [])).catch(() => setOrgs([]));
  }, [open, kurzus && kurzus.id]);

  const set = (k) => (v) => setF(p => ({ ...p, [k]: v }));
  const ok  = f.code && f.code.trim() && f.name_hu && f.name_hu.trim() && f.term && f.term.trim() && !busy;

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      const clear = [];
      if (!f.name_en.trim())   clear.push('name_en');
      if (!f.org_unit_id)      clear.push('org_unit');
      if (f.letszam === '')    clear.push('letszam');
      if (!f.leiras.trim())    clear.push('leiras');
      if (!f.leiras_en.trim()) clear.push('leiras_en');
      await CRS_api.save({
        p_id: kurzus ? kurzus.id : null,
        p_code: f.code.trim(), p_name_hu: f.name_hu.trim(),
        p_name_en: f.name_en.trim() || null,
        p_term: f.term.trim(), p_lang: f.lang,
        p_org_unit_id: f.org_unit_id || null,
        p_letszam: f.letszam === '' ? null : Number(f.letszam),
        p_van_orarendi_info: !!f.van_orarendi_info,
        p_vizsgakurzus: !!f.vizsgakurzus,
        p_leiras: f.leiras.trim() || null,
        p_leiras_en: f.leiras_en.trim() || null,
        p_clear: clear.length ? clear : null,
      });
      onDone();
    } catch (e) { setErr(CRS_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <UModal open={open} onClose={busy ? () => {} : onClose} max="max-w-3xl"
      icon={<Lucide.BookOpen size={20} />} title={uj ? 'Új kurzus' : 'Kurzus szerkesztése'}
      subtitle={uj ? 'A kurzuskód félévenként egyedi' : (kurzus && kurzus.code) || ''}>
      {err && (
        <div className="mb-5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <UField label="Kurzuskód" hint="Neptun-kód. Félévenként egyedi.">
          <input className={U_input} value={f.code || ''} onChange={e => set('code')(e.target.value)} maxLength={80} />
        </UField>
        <UField label="Félév" hint="Formátum: 2025/26/2">
          <input className={U_input} value={f.term || ''} onChange={e => set('term')(e.target.value)}
            placeholder="2026/27/1" maxLength={20} />
        </UField>
        <UField label="Megnevezés (magyar)">
          <input className={U_input} value={f.name_hu || ''} onChange={e => set('name_hu')(e.target.value)} maxLength={200} />
        </UField>
        <UField label="Megnevezés (angol)" hint="Nem kötelező.">
          <input className={U_input} value={f.name_en || ''} onChange={e => set('name_en')(e.target.value)} maxLength={200} />
        </UField>
        <UField label="Oktatás nyelve">
          <select className={U_input} value={f.lang || 'hu'} onChange={e => set('lang')(e.target.value)}>
            <option value="hu">magyar</option><option value="en">angol</option>
            <option value="de">német</option><option value="other">egyéb</option>
          </select>
        </UField>
        <UField label="Szervezeti egység" hint="Kar vagy tanszék. A jelentések eszerint csoportosítanak.">
          <select className={U_input} value={f.org_unit_id || ''} onChange={e => set('org_unit_id')(e.target.value)}>
            <option value="">—</option>
            {orgs.map(o => <option key={o.id} value={o.id}>{o.cimke}</option>)}
          </select>
        </UField>
        <UField label="Létszám a forrásrendszer szerint"
          hint="Ha üres, az alkalmassági motor a beiratkozási sorok számát használja.">
          <input className={U_input} type="number" min="0" value={f.letszam ?? ''}
            onChange={e => set('letszam')(e.target.value)} />
        </UField>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
            <input type="checkbox" checked={!!f.van_orarendi_info}
              onChange={e => set('van_orarendi_info')(e.target.checked)} />
            Van órarendi információ
          </label>
          <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
            <input type="checkbox" checked={!!f.vizsgakurzus}
              onChange={e => set('vizsgakurzus')(e.target.checked)} />
            Vizsgakurzus
          </label>
          <p className="text-[10px] text-slate-400 font-bold leading-relaxed">
            Mindkettő KIZÁRÁSI ok az OMHV-ben: órarendi információ nélkül és
            vizsgakurzuson nincs véleményezés.
          </p>
        </div>
        <div className="sm:col-span-2">
          <UField label="Leírás (magyar)" hint="Rövid tárgyleírás, tematika.">
            <textarea className={U_input + ' min-h-24'} value={f.leiras || ''}
              onChange={e => set('leiras')(e.target.value)} rows={4} />
          </UField>
        </div>
        <div className="sm:col-span-2">
          <UField label="Leírás (angol)">
            <textarea className={U_input + ' min-h-20'} value={f.leiras_en || ''}
              onChange={e => set('leiras_en')(e.target.value)} rows={3} />
          </UField>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 mt-6 pt-5 border-t border-slate-100">
        <button onClick={onClose} disabled={busy} className={U_btnGhost + ' py-2.5 px-5'}>Mégse</button>
        <button onClick={ment} disabled={!ok}
          className={U_btnPrimary + ' py-2.5 px-5 disabled:opacity-40 disabled:cursor-not-allowed'}>
          {busy ? 'Mentés…' : 'Mentés'}
        </button>
      </div>
    </UModal>
  );
}


/* --- CRS_Tab — a kurzusnyilvántartás fő képernyője ----------------------- */
function CRS_Tab({ user }) {
  const [rows, setRows]     = useState(null);
  const [term, setTerm]     = useState('');
  const [terms, setTerms]   = useState([]);
  const [q, setQ]           = useState('');
  const [sel, setSel]       = useState(null);     // a kiválasztott kurzus id-ja
  const [det, setDet]       = useState(null);     // echo_course_get()
  const [detBusy, setDetBusy] = useState(false);
  const [detFrissit, setDetFrissit] = useState(false);
  const [nevsor, setNevsor] = useState(null);
  const [nq, setNq]         = useState('');
  const [mind, setMind]     = useState(false);   // a nevsor a tantargy MINDEN felevet mutassa
  const [hist, setHist]     = useState(null);    // echo_course_history()
  const [formOpen, setFormOpen] = useState(false);
  const [formKurzus, setFormKurzus] = useState(null);
  const [err, setErr]       = useState('');
  const [uzenet, setUzenet] = useState('');
  const [torles, setTorles] = useState(null);     // megerősítésre váró törlés
  const [feltolt, setFeltolt] = useState(false);

  const load = async () => {
    setErr('');
    try {
      const d = await CRS_api.list(term, q);
      const arr = Array.isArray(d) ? d : [];
      setRows(arr);
      if (!arr.some(k => k.id === sel)) setSel(arr.length ? arr[0].id : null);
    } catch (e) { setRows([]); setErr(CRS_msg(e)); }
  };
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [term, q]);
  useEffect(() => {
    CRS_api.options('term').then(d => setTerms(Array.isArray(d) ? d : [])).catch(() => setTerms([]));
  }, []);

  /* csendes = művelet (pl. oktató hozzáadása) utáni frissítés: a meglévő tartalom
     a helyén marad, csak a frissítésjelző forog. Korábban ilyenkor is a váz-animáció
     jelent meg, a panel összeesett, és az oldal fel-le ugrott (hibajelentés). */
  const loadDet = async (id, csendes) => {
    if (!id) { setDet(null); setNevsor(null); setHist(null); return; }
    CRS_api.history(id).then(setHist).catch(() => setHist(null));
    if (csendes) setDetFrissit(true); else setDetBusy(true);
    try { setDet(await CRS_api.get(id)); }
    catch (e) { if (!csendes) setDet(null); setErr(CRS_msg(e)); }
    finally { setDetBusy(false); setDetFrissit(false); }
  };
  useEffect(() => { loadDet(sel); setNq(''); setMind(false); }, [sel]);
  useEffect(() => {
    if (!sel) return;
    let el = true;
    const t = setTimeout(() => {
      CRS_api.students(sel, nq, mind)
        .then(d => { if (el) setNevsor(Array.isArray(d) ? d : []); })
        .catch(() => { if (el) setNevsor([]); });
    }, nq ? 300 : 0);
    return () => { el = false; clearTimeout(t); };
  }, [sel, nq, mind]);

  const szol = (m) => { setUzenet(m); setTimeout(() => setUzenet(''), 4000); };
  const ujra = async () => { await loadDet(sel, true); await load();
                             CRS_api.students(sel, nq, mind).then(d => setNevsor(Array.isArray(d) ? d : [])); };

  const tesz = async (fn, sikerUzenet) => {
    setErr('');
    try { const r = await fn(); await ujra(); if (sikerUzenet) szol(sikerUzenet(r)); }
    catch (e) { setErr(CRS_msg(e)); }
  };

  // --- fájlfeltöltés ---
  // Az útvonal KÖTÖTT: <saját-uid>/kurzus/<kurzus-id>/<fájl>. Ezt a tárolópolicy
  // (a mappa első szintje a feltöltő) ÉS az echo_course_document_add() is
  // megköveteli — a kettő így nem tud elcsúszni egymástól.
  const feltoltes = async (file) => {
    if (!file || !window.sb) return;
    setErr(''); setFeltolt(true);
    try {
      const { data: u } = await window.sb.auth.getUser();
      const uid = u && u.user && u.user.id;
      if (!uid) throw new Error('ECHO_NOT_AUTHENTICATED');
      const nev  = CRS_safeName(file.name);
      const path = `${uid}/kurzus/${sel}/${Date.now().toString(36)}-${nev}`;
      const { error } = await window.sb.storage.from('documents')
        .upload(path, file, { cacheControl: '3600', upsert: false, contentType: FELT_dokumentumTipus(file) });
      if (error) throw error;
      await CRS_api.docAdd(sel, file.name, file.name, path, file.type || null, file.size, 'tananyag');
      await ujra();
      szol('Feltöltve: ' + file.name);
    } catch (e) { setErr(CRS_msg(e)); }
    finally { setFeltolt(false); }
  };

  const letoltes = async (d) => {
    if (!window.sb) return;
    try {
      const { data, error } = await window.sb.storage.from('documents')
        .createSignedUrl(d.path, 3600);
      if (error) throw error;
      window.open(data.signedUrl, '_blank', 'noopener');
    } catch (e) { setErr(CRS_msg(e)); }
  };

  const szerk = !!(det && det.szerkesztheto);

  return (
    <div className="space-y-5">
      {err && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}
      {uzenet && (
        <div className="bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-3 text-sm font-bold text-emerald-700 flex gap-2">
          <Lucide.CheckCircle2 size={16} className="flex-none mt-0.5" /> {uzenet}
        </div>
      )}

      {/* --- szűrősor --- */}
      <div className="bg-white rounded-3xl border border-slate-100 p-4 flex flex-wrap items-center gap-3">
        <select className={U_input + ' w-auto min-w-44'} value={term} onChange={e => setTerm(e.target.value)}>
          <option value="">Minden félév</option>
          {terms.map(t => <option key={t.id} value={t.id}>{t.cimke} · {t.reszlet}</option>)}
        </select>
        <input className={U_input + ' flex-1 min-w-52'} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Keresés kód vagy megnevezés szerint…" />
        <span className="text-[11px] font-black text-slate-400">
          {rows === null ? '' : rows.length + ' kurzus'}
        </span>
        <button onClick={() => { setFormKurzus(null); setFormOpen(true); }}
          className={U_btnPrimary + ' py-2.5 px-4 text-sm'}>
          <Lucide.Plus size={15} /> Új kurzus
        </button>
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
        {/* --- bal: kurzuslista --- */}
        <div className="xl:col-span-4 bg-white rounded-3xl border border-slate-100 overflow-hidden">
          <div className="max-h-[36rem] overflow-y-auto divide-y divide-slate-50">
            {rows === null ? <div className="p-4"><SkeletonRows n={6} /></div>
             : rows.length === 0 ? (
              <UEmpty icon={<Lucide.BookOpen size={22} />} title="Nincs kurzus"
                text="Ezzel a szűréssel nincs találat. Vegyél fel újat az „Új kurzus” gombbal." />
            ) : rows.map(k => {
              const on = k.id === sel;
              return (
                <button key={k.id} onClick={() => setSel(k.id)}
                  className={'w-full text-left px-4 py-3 transition ' +
                    (on ? 'bg-orange-50/60 border-l-2 border-primary' : 'hover:bg-slate-50 border-l-2 border-transparent')}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-black text-slate-700 truncate">{k.name_hu}</span>
                    <span className="text-[10px] font-black text-slate-300 flex-none">{k.term}</span>
                  </div>
                  <div className="text-[10px] font-bold text-slate-400 truncate mt-0.5">{k.code}</div>
                  <div className="flex items-center gap-2.5 mt-1.5 text-[10px] font-black text-slate-400">
                    <span className="flex items-center gap-1"><Lucide.Users size={10} />{k.hallgato}</span>
                    <span className="flex items-center gap-1"><Lucide.GraduationCap size={10} />{k.oktato}</span>
                    {k.dokumentum > 0 && (
                      <span className="flex items-center gap-1 text-primary">
                        <Lucide.Paperclip size={10} />{k.dokumentum}
                      </span>
                    )}
                    {k.vizsgakurzus && <UBadge tone="amber">vizsgakurzus</UBadge>}
                    {!k.van_orarendi_info && <UBadge tone="slate">nincs órarend</UBadge>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* --- jobb: részletek --- */}
        <div className="xl:col-span-8 space-y-5">
          {!det ? (
            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              {detBusy ? <SkeletonRows n={5} /> : (
                <UEmpty icon={<Lucide.MousePointerClick size={22} />} title="Válassz kurzust"
                  text="A bal oldali listából." />
              )}
            </div>
          ) : (
            <React.Fragment>
              {/* metaadatok */}
              <div className="bg-white rounded-3xl border border-slate-100 p-6">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="min-w-0">
                    <h3 className="font-black text-slate-900 truncate">{det.name_hu}</h3>
                    {det.name_en && <p className="text-xs text-slate-400 font-bold truncate">{det.name_en}</p>}
                    <p className="text-[11px] text-slate-400 font-bold mt-1">
                      {det.code} · {det.term} · {det.org_unit || 'nincs szervezeti egység'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-none">
                    <RefreshingBadge on={detBusy || detFrissit} />
                    {szerk && (
                      <React.Fragment>
                        <button onClick={() => { setFormKurzus(det); setFormOpen(true); }}
                          className={U_btnGhost + ' py-2 px-3 text-xs'}>
                          <Lucide.Pencil size={13} /> Szerkesztés
                        </button>
                        <button onClick={() => setTorles(det)}
                          className={U_btnGhost + ' py-2 px-3 text-xs text-red-500'}>
                          <Lucide.Trash2 size={13} />
                        </button>
                      </React.Fragment>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  {[['Hallgató', det.hallgato_szam], ['Oktató', (det.oktatok || []).length],
                    ['Dokumentum', (det.dokumentumok || []).length], ['Kampányban', det.kampanyban]].map(([c, v]) => (
                    <div key={c} className="border border-slate-100 rounded-2xl px-3 py-2.5">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{c}</div>
                      <div className="text-lg font-black text-slate-800">{v}</div>
                    </div>
                  ))}
                </div>

                {/* A KIZARAS KIMONDVA. A jelzok eddig is latszottak (jelvenykent a
                    listaban), de a KOVETKEZMENYUK nem: hogy a kurzus emiatt
                    kimarad a velemenyezesbol. Valos bejelentesbol: egy hallgato
                    harom kurzusra jart, a kampany kettot mutatott, es a
                    kulonbseget csak a kizarasi naplobol lehetett kideriteni. */}
                {(() => {
                  const okok = [];
                  if (!det.van_orarendi_info)
                    okok.push('nincs órarendi információ');
                  if (det.vizsgakurzus)
                    okok.push('vizsgakurzus');
                  if ((det.oktatok || []).length === 0)
                    okok.push('nincs rögzített oktató');
                  if (det.hallgato_szam < 3 && (det.letszam == null || det.letszam < 3))
                    okok.push('a létszám a küszöb alatt van (3 fő)');
                  if (okok.length === 0) return null;
                  return (
                    <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 flex gap-2.5 mb-4">
                      <Lucide.AlertTriangle size={15} className="text-amber-500 flex-none mt-0.5" />
                      <div className="text-[11px] text-amber-700 font-medium leading-relaxed">
                        <b>Ez a kurzus kimarad a véleményezésből.</b> Oka:{' '}
                        {okok.join(', ')}. A hallgatói oldalon tehát a kurzus látszik
                        a saját kurzusai között, de <b>nem kap rá kérdőívet</b> — ezért
                        térhet el a két szám.
                        {!det.van_orarendi_info && det.szerkesztheto !== false && (
                          <span> Ha a jelölés téves, a Szerkesztés alatt javítható; utána
                          a kampánynál újra kell építeni a jogosultsági listát.</span>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {det.leiras && (
                  <div className="border-t border-slate-100 pt-4">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Leírás</div>
                    <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{det.leiras}</p>
                    {det.leiras_en && (
                      <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap mt-2">{det.leiras_en}</p>
                    )}
                  </div>
                )}
              </div>

              {/* oktatók */}
              <div className="bg-white rounded-3xl border border-slate-100 p-6">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Oktatók</h4>
                  {szerk && (
                    <CRS_Picker kind="teacher" courseId={det.id} cimke="Oktató"
                      onPick={o => tesz(() => CRS_api.teacher(det.id, o.id, 100, 'oktato', false),
                                        () => 'Oktató hozzárendelve: ' + o.cimke)} />
                  )}
                </div>
                {(det.oktatok || []).length === 0 ? (
                  <p className="text-[11px] text-slate-300 font-bold italic">
                    Nincs oktató. Oktató nélkül a kurzus KIZÁRÓDIK az OMHV-ből.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {det.oktatok.map(o => (
                      <div key={o.teacher_id}
                        className="flex items-center gap-3 border border-slate-100 rounded-2xl px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-slate-700 truncate">
                            {o.title ? o.title + ' ' : ''}{o.nev}
                          </div>
                          <div className="text-[10px] font-bold text-slate-400 truncate">{o.email || '—'} · {o.role}</div>
                        </div>
                        {szerk ? (
                          <React.Fragment>
                            <input type="number" min="0" max="100" defaultValue={o.share_pct}
                              onBlur={e => { const v = Number(e.target.value);
                                if (v !== Number(o.share_pct))
                                  tesz(() => CRS_api.teacher(det.id, o.teacher_id, v, null, false),
                                       () => 'Óraarány mentve.'); }}
                              className="w-16 text-xs font-black text-slate-700 border border-slate-100
                                         rounded-xl px-2 py-1.5 text-right" />
                            <span className="text-[10px] font-black text-slate-400">%</span>
                            <button onClick={() => tesz(() => CRS_api.teacher(det.id, o.teacher_id, null, null, true),
                                                        () => 'Oktató levéve.')}
                              className="text-slate-300 hover:text-red-500"><Lucide.X size={14} /></button>
                          </React.Fragment>
                        ) : (
                          <span className="text-xs font-black text-slate-500">{o.share_pct}%</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 font-bold leading-relaxed mt-3">
                  Az óraarány az órarendi órák százaléka. A 28/2023. határozat küszöbe alatt
                  az oktató nem véleményezhető ezen a kurzuson.
                </p>
              </div>

              {/* dokumentumok */}
              <div className="bg-white rounded-3xl border border-slate-100 p-6">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    Tananyagok és dokumentumok
                  </h4>
                  <label className={U_btnGhost + ' py-2 px-3 text-xs cursor-pointer ' + (feltolt ? 'opacity-50' : '')}>
                    <Lucide.Upload size={13} /> {feltolt ? 'Feltöltés…' : 'Feltöltés'}
                    <input type="file" className="hidden" disabled={feltolt}
                      onChange={e => { const f = e.target.files && e.target.files[0];
                                       e.target.value = ''; feltoltes(f); }} />
                  </label>
                </div>
                {(det.dokumentumok || []).length === 0 ? (
                  <p className="text-[11px] text-slate-300 font-bold italic">nincs feltöltött fájl</p>
                ) : (
                  <div className="space-y-2">
                    {det.dokumentumok.map(d => (
                      <div key={d.id} className="flex items-center gap-3 border border-slate-100 rounded-2xl px-3 py-2.5">
                        <Lucide.FileText size={15} className="text-slate-300 flex-none" />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-slate-700 truncate">{d.cim}</div>
                          <div className="text-[10px] font-bold text-slate-400 truncate">
                            {CRS_FAJTA[d.fajta] || d.fajta}
                            {d.meret != null ? ' · ' + CRS_meret(d.meret) : ''}
                            {d.feltolto ? ' · ' + d.feltolto : ''}
                          </div>
                        </div>
                        <button onClick={() => letoltes(d)}
                          className="text-slate-400 hover:text-primary" title="Megnyitás">
                          <Lucide.Download size={14} />
                        </button>
                        <button onClick={() => tesz(() => CRS_api.docDel(d.id),
                                                    r => r && r.sajat_feltoltes
                                                      ? 'Dokumentum levéve.'
                                                      : 'Dokumentum levéve. A fájlt a tárolóból csak a feltöltője tudja törölni.')}
                          className="text-slate-300 hover:text-red-500"><Lucide.X size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 font-bold leading-relaxed mt-3">
                  A fájlokat csak ügyintéző és a kurzus oktatója éri el. A hallgatók nem
                  látják — ez belső nyilvántartás.
                </p>
              </div>

              {/* hallgatói névsor */}
              <div className="bg-white rounded-3xl border border-slate-100 p-6">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    Hallgatói névsor · {det.term}
                  </h4>
                  {szerk && (
                    <div className="flex items-center gap-3">
                      <CRS_Picker kind="group" courseId={det.id} cimke="Csoport" gomb="+ Csoport"
                        onPick={g => tesz(() => CRS_api.enroll(det.id, null, g.id, 'add'),
                                          r => (r && r.erintett) + ' hallgató beiratkoztatva a(z) „' + g.cimke + '” csoportból.')} />
                      <CRS_Picker kind="student" courseId={det.id} cimke="Hallgató" gomb="+ Hallgató"
                        onPick={p => tesz(() => CRS_api.enroll(det.id, [p.id], null, 'add'),
                                          () => 'Beiratkoztatva: ' + p.cimke)} />
                    </div>
                  )}
                </div>
                {/* A TANTARGY tobb feleve ugyanazt a kurzuskodot viseli — az
                    echo.course egy sora tantargy EGY FELEVBEN. A kapcsolo ezt
                    fuzi ossze, es minden sor mellett AZ A FELEV oktatoja all,
                    nem a mai. */}
                {hist && hist.felev_szam > 1 && (
                  <div className="flex items-center gap-1 mb-3">
                    {[[false, 'Csak ' + det.term], [true, 'Minden félév (' + hist.felev_szam + ')']].map(([v, c]) => (
                      <button key={String(v)} onClick={() => setMind(v)}
                        className={'text-[11px] font-black px-3 py-1.5 rounded-xl transition ' +
                          (mind === v ? 'bg-primary text-white' : 'text-slate-400 hover:bg-slate-50')}>
                        {c}
                      </button>
                    ))}
                  </div>
                )}
                <input className={U_input + ' text-sm mb-3'} value={nq} onChange={e => setNq(e.target.value)}
                  placeholder="Szűrés névre vagy e-mailre…" />
                {nevsor === null ? <SkeletonRows n={4} /> : nevsor.length === 0 ? (
                  <p className="text-[11px] text-slate-300 font-bold italic">
                    {nq ? 'Nincs találat.' : 'Erre a kurzusra még senki nincs beiratkozva.'}
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto divide-y divide-slate-50">
                    {nevsor.map(h => (
                      <div key={h.course_id + '|' + h.profile_id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-slate-700 truncate">{h.nev}</div>
                          <div className="text-[10px] font-bold text-slate-400 truncate">
                            {h.email}
                            {h.tagozat ? ' · ' + h.tagozat : ''}
                            {h.szak ? ' · ' + h.szak : ''}
                          </div>
                          <div className="text-[10px] font-bold text-slate-500 truncate mt-0.5">
                            <span className="text-primary">{h.term}</span>
                            {h.oktatok ? ' · ' + h.oktatok : ''}
                          </div>
                        </div>
                        {h.status !== 'active' && <UBadge tone="slate">leadta</UBadge>}
                        {szerk && h.ez_a_felev && (
                          <button onClick={() => tesz(() => CRS_api.enroll(det.id, [h.profile_id], null, 'remove'),
                                                      () => 'Törölve a névsorból: ' + h.nev)}
                            className="text-slate-300 hover:text-red-500 flex-none"><Lucide.X size={14} /></button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 font-bold leading-relaxed mt-3">
                  Ez a névsor mondja meg, kit ér el a kampány: célközönség-szűkítés nélkül
                  a kérdőívet a félév kurzusaira beiratkozott hallgatók kapják meg.
                </p>
              </div>

              {/* --- a kurzus története --- */}
              {hist && (
                <div className="bg-white rounded-3xl border border-slate-100 p-6">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                    A kurzus története
                  </h4>
                  <p className="text-[11px] text-slate-400 leading-relaxed mb-4">
                    Az azonos <b>kurzuskódú</b> félévek egy tantárgy egymást követő futásai.
                    Minden félév a saját akkori oktatóját és létszámát mutatja.
                    {hist.teljes_felev_szam > hist.felev_szam && (
                      <span className="text-amber-600">
                        {' '}Ebből {hist.teljes_felev_szam - hist.felev_szam} félév nem látszik,
                        mert azoknak nem te vagy az oktatója.
                      </span>
                    )}
                  </p>

                  {(hist.felevek || []).length <= 1 ? (
                    <p className="text-[11px] text-slate-300 font-bold italic">
                      Ez a tantárgy egyelőre egyetlen félévvel szerepel. Amint ugyanezzel a
                      kurzuskóddal létrejön a következő félév, itt egymás alatt fognak állni.
                    </p>
                  ) : (
                    <div className="space-y-2 mb-5">
                      {hist.felevek.map(f => (
                        <button key={f.course_id} onClick={() => setSel(f.course_id)}
                          className={'w-full text-left border rounded-2xl px-4 py-3 transition ' +
                            (f.ez_a_felev ? 'border-primary bg-orange-50/40'
                                          : 'border-slate-100 hover:border-slate-200')}>
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-xs font-black text-slate-800">{f.term}</span>
                            <span className="text-[10px] font-black text-slate-400">
                              {f.hallgato} hallgató
                              {f.letszam != null && f.letszam !== f.hallgato
                                ? ' · forrás szerint ' + f.letszam : ''}
                              {f.kampany > 0 ? ' · ' + f.kampany + ' kampány' : ''}
                            </span>
                          </div>
                          <div className="text-[11px] font-bold text-slate-500 mt-0.5 truncate">
                            {f.name_hu}
                          </div>
                          <div className="text-[10px] font-bold text-slate-400 mt-1 truncate">
                            {(f.oktatok || []).length === 0 ? 'nincs rögzített oktató'
                              : f.oktatok.map(o => o.nev + ' (' + Math.round(o.share_pct) + '%)').join(', ')}
                            {f.vizsgakurzus ? ' · vizsgakurzus' : ''}
                            {!f.van_orarendi_info ? ' · nincs órarendi info' : ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="border-t border-slate-100 pt-4">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
                      Változásnapló
                    </div>
                    {(hist.valtozasok || []).length === 0 ? (
                      <p className="text-[11px] text-slate-300 font-bold italic">
                        Még nincs bejegyzés. A napló a 44-es migráció óta gyűjt — az az előtti
                        módosításokra visszamenőleg nincs nyom.
                      </p>
                    ) : (
                      <div className="max-h-72 overflow-y-auto space-y-1.5">
                        {hist.valtozasok.map((v, i) => (
                          <div key={i} className="flex items-baseline gap-2 text-[11px] leading-relaxed">
                            <span className="text-slate-300 font-black flex-none tabular-nums">
                              {ECHO_date(v.at)}
                            </span>
                            <span className="text-slate-400 font-black flex-none">{v.term}</span>
                            <span className="font-black text-slate-600 flex-none">
                              {CRS_MEZO[v.mezo] || v.mezo}
                            </span>
                            <span className="text-slate-500 truncate">
                              {v.regi ? <span className="line-through text-slate-300">{v.regi}</span> : null}
                              {v.regi && v.uj ? ' → ' : ''}
                              {v.uj || (v.regi ? ' (törölve)' : '')}
                            </span>
                            <span className="text-slate-300 font-bold ml-auto flex-none truncate max-w-40">
                              {v.ki}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </React.Fragment>
          )}
        </div>
      </div>

      <CRS_Form open={formOpen} kurzus={formKurzus}
        onClose={() => setFormOpen(false)}
        onDone={() => { setFormOpen(false); load(); loadDet(sel); szol('Mentve.'); }} />

      <UModal open={!!torles} onClose={() => setTorles(null)} max="max-w-md"
        icon={<Lucide.AlertTriangle size={20} />} title="Kurzus törlése"
        subtitle={torles ? torles.code : ''}>
        <p className="text-sm text-slate-600 leading-relaxed">
          A törlés a beiratkozási sorokat is elviszi. Ha a kurzus bármelyik kampányban
          szerepel, a rendszer <b>elutasítja</b> — ilyenkor a törlés kampánytörténetet
          semmisítene meg.
        </p>
        <div className="flex items-center justify-end gap-2 mt-6">
          <button onClick={() => setTorles(null)} className={U_btnGhost + ' py-2.5 px-5'}>Mégse</button>
          <button onClick={() => { const t = torles; setTorles(null);
                                   tesz(() => CRS_api.del(t.id), r => 'Törölve: ' + r.code +
                                        ' (' + r.torolt_beiratkozas + ' beiratkozással együtt)'); }}
            className={U_btnPrimary + ' py-2.5 px-5 !bg-red-500'}>Törlés</button>
        </div>
      </UModal>
    </div>
  );
}


/* --- CRS_View — a Kurzusok FŐ MENÜPONT nézete --------------------------- 
   Külön komponens a CRS_Tab köré: a fül változatában a fejlécet az ECHO
   adta, itt viszont a nézet a sajátja. A kettő szétválasztva marad, mert a
   CRS_Tab bárhova beágyazható — ha később egy másik képernyő is meg akarja
   mutatni a kurzusokat, nem kell fejlécet cipelnie hozzá. */
/* --- CRS_StudentView — "A kurzusaim" ------------------------------------
   A hallgatoi valtozat. NEM ugyanaz a kepernyo kevesebb gombbal: mas kerdesre
   valaszol. Az ugyintezoi nyilvantartas azt kerdezi, "ki jar erre a kurzusra";
   ez azt, "en mire jarok".

   AMIT SZANDEKOSAN NEM MUTAT: tananyagokat es fajlokat (a 43-as migracional
   kimondott dontes szerint azok belso nyilvantartasnak keszultek,
   ugyintezonek es a kurzus oktatojanak), kurzustarsakat, es letszamot. A
   szures a SZERVEREN van: az echo_my_enrollments() PARAMETER NELKULI, tehat
   mas hallgatora nem is lehet kerdezni. */
function CRS_StudentView({ user }) {
  const [d, setD]     = useState(null);
  const [err, setErr] = useState('');
  const [nyit, setNyit] = useState({});

  useEffect(() => {
    CRS_api.mine().then(r => { setD(r); setErr(''); })
      .catch(e => { setD(null); setErr(CRS_msg(e)); });
  }, []);

  const felevek = (d && Array.isArray(d.felevek)) ? d.felevek : [];

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <div className="mb-7">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
          A kurzusaim
        </h1>
        <p className="text-sm text-slate-400 font-medium mt-1">
          Amikre félévről félévre beiratkoztál · oktatókkal és tárgyleírással
        </p>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2 mb-5">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {d === null && !err ? (
        <div className="bg-white rounded-3xl border border-slate-100 p-6"><SkeletonRows n={5} /></div>
      ) : felevek.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 p-6">
          <UEmpty icon={<Lucide.BookOpen size={22} />} title="Még nincs kurzusod"
            text="Amint a tanulmányi rendszerből felkerülnek a kurzusfelvételeid, itt fognak megjelenni." />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-3 text-[11px] font-black text-slate-400">
            <span>{d.kurzus_szam} kurzus</span>
            <span className="text-slate-200">·</span>
            <span>{d.felev_szam} félév</span>
          </div>

          {felevek.map(f => (
            <div key={f.term} className="bg-white rounded-3xl border border-slate-100 p-6">
              <div className="flex items-baseline justify-between gap-3 mb-4">
                <h2 className="text-lg font-black text-slate-900">{f.term}</h2>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {f.kurzus_szam} kurzus
                </span>
              </div>

              <div className="space-y-2">
                {(f.kurzusok || []).map(k => {
                  const ki = !!nyit[k.course_id];
                  const van = k.leiras || (k.oktatok || []).length > 0;
                  return (
                    <div key={k.course_id} className="border border-slate-100 rounded-2xl overflow-hidden">
                      <button type="button" disabled={!van}
                        onClick={() => setNyit(p => ({ ...p, [k.course_id]: !p[k.course_id] }))}
                        className={'w-full text-left px-4 py-3 transition ' +
                          (van ? 'hover:bg-slate-50' : 'cursor-default')}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-black text-slate-800 truncate">
                              <ECHO_Src>{k.name_hu}</ECHO_Src>
                            </div>
                            <div className="text-[11px] font-bold text-slate-400 truncate mt-0.5">
                              {k.code}
                              {k.org_unit ? ' · ' + k.org_unit : ''}
                              {k.lang && k.lang !== 'hu' ? ' · ' + k.lang : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-none">
                            {k.status !== 'active' && <UBadge tone="slate">leadva</UBadge>}
                            {k.vizsgakurzus && <UBadge tone="amber">vizsgakurzus</UBadge>}
                            {van && (
                              <Lucide.ChevronDown size={14}
                                className={'text-slate-300 transition-transform ' + (ki ? 'rotate-180' : '')} />
                            )}
                          </div>
                        </div>
                      </button>

                      {ki && (
                        <div className="px-4 pb-4 pt-1 border-t border-slate-50 space-y-3">
                          {(k.oktatok || []).length > 0 && (
                            <div>
                              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                Oktatók
                              </div>
                              {k.oktatok.map((o, i) => (
                                <div key={i} className="text-xs font-bold text-slate-600">
                                  {o.title ? o.title + ' ' : ''}{o.nev}
                                  <span className="text-slate-400 font-medium">
                                    {' · '}{CRS_OKT_ROLE[o.role] || o.role}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                          {k.leiras && (
                            <div>
                              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                Tárgyleírás
                              </div>
                              <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">
                                <ECHO_Src>{k.leiras}</ECHO_Src>
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <p className="text-[11px] text-slate-400 leading-relaxed">
            Ez a lista a tanulmányi nyilvántartásból származik. Ha valami hiányzik vagy
            tévesen szerepel benne, a tanulmányi osztály tudja javítani — ezen a felületen
            nem szerkeszthető.
          </p>
        </div>
      )}
    </div>
  );
}


/* --- CRS_View — a "Kurzusok" menupont, szerepkor szerint ---------------- */
function CRS_View({ user }) {
  // UGYANAZ a menupont, ket kulonbozo kepernyo. A hallgato nem a
  // nyilvantartast latja kevesebb gombbal, hanem a sajat kurzusait — mas
  // kerdesre valaszol a ketto. A szerver mindket agat kulon vedi: az
  // echo_course_list() is_staff()-ot vagy elo oktatoi sort kovetel, az
  // echo_my_enrollments() pedig parameter nelkul csak auth.uid() sorait adja.
  const hallgato = user && user.role === 'STUDENT';
  if (hallgato) return <CRS_StudentView user={user} />;

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <div className="mb-7">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
          Kurzusnyilvántartás
        </h1>
        <p className="text-sm text-slate-400 font-medium mt-1">
          Kurzusok, oktatók, hallgatói névsor és tananyagok · törzsadat, amire az
          ECHO kampányok célközönsége is épül
        </p>
      </div>
      <CRS_Tab user={user} />
    </div>
  );
}
