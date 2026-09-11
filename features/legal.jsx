/* ============================================================
   Jogi dokumentumok, elfogadások és hozzájárulások — 59_legal_consents.sql
   ------------------------------------------------------------
   • LEG_Gate          belépés után: ha egy KÖTELEZŐ dokumentum jelenlegi
                       verzióját a felhasználó még nem fogadta el, blokkoló ablak
                       kéri. A választható hozzájárulásokat (alapból ÜRESEN)
                       ugyanitt felkínálja — külön-külön, nem összecsomagolva.
   • LEG_ProfileSection a Profilom oldalon: elfogadások verzióval és dátummal,
                       hozzájárulások megadása és visszavonása (ugyanolyan
                       könnyen, mint a megadás — GDPR 7. cikk (3)), előzmények.
   • LEG_AdminLog      Rendszer → Hozzájárulási napló: keresés, szűrés, CSV.

   Minden adatvezérelt: a dokumentumlista a legal_document táblából jön, így új
   hozzájárulás vagy új verzió kiadásához nem kell kódot módosítani.

   Ha a migráció még nem futott le (az RPC hiányzik), a kapu NEM zár ki senkit,
   csak a konzolba jelez: egy hiányzó migráció ne zárja ki a teljes
   felhasználói kört.
   ============================================================ */

const LEG_isEn = () => { try { return localStorage.getItem('nje_lang') === 'en'; } catch (e) { return false; } };
const LEG_t = (d, k) => (LEG_isEn() ? d[k + '_en'] : d[k + '_hu']) || d[k + '_hu'] || '';
const LEG_ido = (s) => {
  const d = new Date(s);
  if (!s || isNaN(d.getTime())) return '—';
  return d.toLocaleString(LEG_isEn() ? 'en-GB' : 'hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const LEG_hianyzik = (e) => !!e && (e.code === 'PGRST202' || e.code === '42883' || e.code === 'PGRST205' || /legal_status|legal_record|consent_log|legal_document/.test(e.message || ''));

async function LEG_status() {
  if (!window.sb) return { ok: false, hianyzik: true };
  try {
    const { data, error } = await window.sb.rpc('legal_status');
    if (error) return { ok: false, hianyzik: LEG_hianyzik(error), hiba: error };
    return { ok: true, docs: Array.isArray(data) ? data : [] };
  } catch (e) { return { ok: false, hiba: e }; }
}
async function LEG_record(items, context) {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.slice(0, 300) : null;
  const { data, error } = await window.sb.rpc('legal_record', { p_items: items, p_context: context, p_user_agent: ua });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
const LEG_hibaSzoveg = (e) => {
  const m = String((e && e.message) || e || '');
  if (/LEGAL_STALE_VERSION/.test(m)) return 'Közben a dokumentum új verziója jelent meg. Frissítsd az oldalt, és nézd át újra.';
  if (/NOT_AUTHENTICATED/.test(m)) return 'A munkameneted lejárt. Jelentkezz be újra.';
  return 'A mentés nem sikerült: ' + m;
};

const LEG_AKCIO = { accept: 'Elfogadva', grant: 'Megadva', withdraw: 'Visszavonva' };
const LEG_HELY = { signup: 'Regisztráció', login: 'Belépés', profile: 'Profil' };
const LEG_TONE = { accept: 'green', grant: 'blue', withdraw: 'red' };

/* ---------- belépéskori kapu ---------- */
function LEG_Gate({ user, onLogout }) {
  const [docs, setDocs] = useState(null);       // null = betöltés / kihagyva
  const [pipa, setPipa] = useState({});
  const [busy, setBusy] = useState(false);
  const [hiba, setHiba] = useState('');
  const uid = user && user.id;
  useEffect(() => {
    let el = false;
    setDocs(null); setPipa({}); setHiba('');
    LEG_status().then(r => {
      if (el) return;
      if (!r.ok) { if (!r.hianyzik) console.warn('LEG_Gate: a jogi állapot nem tölthető be', r.hiba); return; }
      setDocs(r.docs);
    });
    return () => { el = true; };
  }, [uid]);

  if (!docs) return null;
  const kotelezo = docs.filter(d => d.required && !d.current);
  if (!kotelezo.length) return null;
  // Csak azokat a hozzájárulásokat kínáljuk, amelyekről még sosem döntött — alapból üresen.
  const valaszthato = docs.filter(d => d.kind === 'consent' && !d.last_action);
  const frissult = kotelezo.some(d => d.last_version && d.last_version !== d.version);
  const mindKesz = kotelezo.every(d => pipa[d.id]);

  const kuld = async () => {
    setBusy(true); setHiba('');
    try {
      const items = [
        ...kotelezo.map(d => ({ id: d.id, version: d.version, action: 'accept' })),
        ...valaszthato.filter(d => pipa[d.id]).map(d => ({ id: d.id, version: d.version, action: 'grant' })),
      ];
      setDocs(await LEG_record(items, 'login'));
    } catch (e) { setHiba(LEG_hibaSzoveg(e)); }
    finally { setBusy(false); }
  };

  const sor = (d, kot) => (
    <label key={d.id} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 hover:border-slate-200 cursor-pointer">
      <input type="checkbox" className="mt-0.5 w-4 h-4 accent-primary flex-none" checked={!!pipa[d.id]} onChange={e => { const v = e.target.checked; setPipa(p => ({ ...p, [d.id]: v })); }} />
      <span className="min-w-0 text-sm text-slate-700 leading-relaxed">
        <span data-no-i18n="1">{LEG_t(d, 'label')}</span>
        {kot && <span className="text-red-500 font-bold"> *</span>}
        {d.url && <> {' '}<a href={d.url} target="_blank" rel="noopener" className="font-bold text-primary hover:underline whitespace-nowrap" onClick={e => e.stopPropagation()}>Elolvasom</a></>}
        {d.last_version && d.last_version !== d.version && <span className="block text-[11px] font-bold text-amber-700 mt-0.5">{`Frissült: ${d.last_version} → ${d.version}`}</span>}
      </span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="leg-gate-cim">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-xl max-h-[92vh] overflow-y-auto p-6 sm:p-8">
        <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-4"><Lucide.ShieldCheck size={24} /></div>
        <h2 id="leg-gate-cim" className="text-xl font-black text-slate-900">{frissult ? 'Frissültek a feltételek' : 'Feltételek és adatkezelés'}</h2>
        <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">{frissult ? 'A legutóbbi elfogadásod óta új verzió jelent meg. A folytatáshoz nézd át és fogadd el.' : 'A platform használatához el kell fogadnod az alábbiakat.'}</p>
        <div className="mt-5 space-y-2">{kotelezo.map(d => sor(d, true))}</div>
        {valaszthato.length > 0 && (
          <div className="mt-6">
            <div className="text-[11px] font-black uppercase tracking-widest text-slate-400">Választható hozzájárulások</div>
            <p className="text-xs text-slate-400 mt-1 mb-2">Nem kötelezők; a Profilom oldalon bármikor megadhatod vagy visszavonhatod őket.</p>
            <div className="space-y-2">{valaszthato.map(d => sor(d, false))}</div>
          </div>
        )}
        {hiba && <div role="alert" className="mt-4 text-[12px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">{hiba}</div>}
        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
          {onLogout ? <button type="button" onClick={onLogout} className="text-xs font-bold text-slate-400 hover:text-slate-600">Nem fogadom el — kijelentkezés</button> : <span />}
          <button type="button" disabled={!mindKesz || busy} onClick={kuld} className={U_btnPrimary + ' justify-center'}>{busy ? 'Mentés…' : 'Elfogadom és folytatom'}</button>
        </div>
        <p className="mt-4 text-[11px] text-slate-400"><span className="text-red-500 font-bold">*</span> A csillaggal jelölt pontok a használat feltételei. Az elfogadást a rendszer időbélyeggel és verzióval naplózza.</p>
      </div>
    </div>
  );
}

/* ---------- Profilom → Adatvédelem és hozzájárulások ---------- */
function LEG_ProfileSection({ user }) {
  const [docs, setDocs] = useState(null);
  const [hianyzik, setHianyzik] = useState(false);
  const [elozmeny, setElozmeny] = useState([]);
  const [busy, setBusy] = useState('');
  const [uzenet, setUzenet] = useState(null);

  const tolt = async () => {
    const r = await LEG_status();
    if (!r.ok) { setHianyzik(!!r.hianyzik); setDocs([]); return; }
    setDocs(r.docs);
    try {
      const { data } = await window.sb.from('consent_log').select('id,document_id,document_version,action,context,created_at').order('created_at', { ascending: false }).limit(30);
      setElozmeny(Array.isArray(data) ? data : []);
    } catch (e) { setElozmeny([]); }
  };
  useEffect(() => { tolt(); }, [user && user.id]);

  const valt = async (d, action) => {
    setBusy(d.id); setUzenet(null);
    try {
      setDocs(await LEG_record([{ id: d.id, version: d.version, action }], 'profile'));
      setUzenet({ tone: 'ok', text: action === 'withdraw' ? 'A hozzájárulást visszavontad.' : 'A hozzájárulást megadtad.' });
      tolt();
    } catch (e) { setUzenet({ tone: 'error', text: LEG_hibaSzoveg(e) }); }
    finally { setBusy(''); }
  };

  const cim = (id) => { const d = (docs || []).find(x => x.id === id); return d ? LEG_t(d, 'title') : id; };

  return (
    <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-7 mt-6" data-leg-profil="1">
      <h4 className="font-bold text-slate-800 mb-1 flex items-center gap-2"><Lucide.ShieldCheck size={18} className="text-primary" /> Adatvédelem és hozzájárulások</h4>
      <p className="text-xs text-slate-400 mb-5 max-w-[75ch]">Itt látod, mit fogadtál el, és itt adhatod meg vagy vonhatod vissza a választható hozzájárulásokat. A visszavonás nem érinti a korábbi, jogszerű adatkezelést.</p>
      {docs === null ? <div className="h-24 rounded-2xl bg-slate-50 animate-pulse" /> : hianyzik ? (
        <p className="text-sm text-slate-500">A hozzájárulás-kezelés az 59-es adatbázis-migráció lefuttatása után érhető el.</p>
      ) : (
        <div className="grid lg:grid-cols-2 gap-6">
          <div>
            <div className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Elfogadott dokumentumok</div>
            <div className="space-y-2">
              {docs.filter(d => d.kind !== 'consent').map(d => (
                <div key={d.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-slate-100">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-700" data-no-i18n="1">{LEG_t(d, 'title')}</div>
                    <div className="text-[11px] text-slate-400">{d.current ? `Elfogadva: ${LEG_ido(d.last_at)} · ${d.version}` : (d.last_version ? `Korábbi verzió elfogadva (${d.last_version}) — a jelenlegi: ${d.version}` : 'Még nincs elfogadva')}</div>
                  </div>
                  {d.url && <a href={d.url} target="_blank" rel="noopener" className="text-xs font-bold text-primary hover:underline whitespace-nowrap">Megnyitás</a>}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Választható hozzájárulások</div>
            <div className="space-y-2">
              {docs.filter(d => d.kind === 'consent').map(d => {
                const megadva = !!d.current;
                return (
                  <div key={d.id} className={'p-3 rounded-xl border ' + (megadva ? 'border-emerald-100 bg-emerald-50/40' : 'border-slate-100')} data-leg-hozzajarulas={d.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-700" data-no-i18n="1">{LEG_t(d, 'title')}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5" data-no-i18n="1">{LEG_t(d, 'label')}</div>
                        <div className="text-[11px] font-bold mt-1 text-slate-400">{megadva ? `Megadva: ${LEG_ido(d.last_at)}` : (d.last_action === 'withdraw' ? `Visszavonva: ${LEG_ido(d.last_at)}` : 'Nincs megadva')}</div>
                      </div>
                      <button type="button" disabled={busy === d.id} onClick={() => valt(d, megadva ? 'withdraw' : 'grant')}
                        className={'flex-none px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 ' + (megadva ? 'text-red-600 bg-red-50 hover:bg-red-100' : 'text-white bg-primary hover:bg-primary/90')}>
                        {busy === d.id ? 'Mentés…' : megadva ? 'Visszavonás' : 'Hozzájárulok'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {uzenet && <div role={uzenet.tone === 'error' ? 'alert' : 'status'} className={'mt-3 text-[12px] font-semibold rounded-xl px-3 py-2.5 border ' + (uzenet.tone === 'error' ? 'text-red-700 bg-red-50 border-red-100' : 'text-emerald-700 bg-emerald-50 border-emerald-100')}>{uzenet.text}</div>}
          </div>
          <div className="lg:col-span-2">
            <details className="rounded-xl border border-slate-100 p-3">
              <summary className="text-xs font-bold text-slate-600 cursor-pointer">Előzmények ({elozmeny.length})</summary>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <tbody>
                    {elozmeny.map(r => (
                      <tr key={r.id} className="border-b border-slate-50 last:border-0">
                        <td className="py-1.5 pr-3 text-slate-500 whitespace-nowrap tabular-nums">{LEG_ido(r.created_at)}</td>
                        <td className="py-1.5 pr-3 font-semibold text-slate-700" data-no-i18n="1">{cim(r.document_id)}</td>
                        <td className="py-1.5 pr-3 text-slate-400 font-mono">{r.document_version}</td>
                        <td className="py-1.5 pr-3"><UBadge tone={LEG_TONE[r.action] || 'slate'}>{LEG_AKCIO[r.action] || r.action}</UBadge></td>
                        <td className="py-1.5 text-slate-400">{LEG_HELY[r.context] || r.context}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
          <div className="lg:col-span-2 rounded-xl bg-slate-50 p-4 text-[12px] text-slate-600 leading-relaxed">
            <span className="font-bold text-slate-700">Jogaid:</span> <span>hozzáférés, helyesbítés, törlés, az adatkezelés korlátozása, adathordozhatóság és tiltakozás.</span> <span>Részletek és elérhetőségek:</span> <a href="privacy.html#jogok" target="_blank" rel="noopener" className="font-bold text-primary hover:underline">Adatkezelési tájékoztató</a>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Rendszer → Hozzájárulási napló (admin) ---------- */
function LEG_AdminLog({ user }) {
  const [katalogus, setKatalogus] = useState([]);
  const [sorok, setSorok] = useState(null);
  const [hiba, setHiba] = useState('');
  const [q, setQ] = useState('');
  const [dok, setDok] = useState('');
  const [akcio, setAkcio] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await window.sb.from('legal_document').select('*').order('sort_order');
        if (error) { setHiba(LEG_hianyzik(error) ? 'A hozzájárulási napló az 59-es adatbázis-migráció lefuttatása után érhető el.' : error.message); return; }
        setKatalogus(data || []);
      } catch (e) { setHiba(String(e.message || e)); }
    })();
  }, []);

  const tolt = async () => {
    setSorok(null);
    try {
      let lek = window.sb.from('consent_log').select('*').order('created_at', { ascending: false }).limit(500);
      if (q.trim()) lek = lek.ilike('email', '%' + q.trim() + '%');
      if (dok) lek = lek.eq('document_id', dok);
      if (akcio) lek = lek.eq('action', akcio);
      const { data, error } = await lek;
      if (error) { setHiba(LEG_hianyzik(error) ? 'A hozzájárulási napló az 59-es adatbázis-migráció lefuttatása után érhető el.' : error.message); setSorok([]); return; }
      setSorok(data || []);
    } catch (e) { setHiba(String(e.message || e)); setSorok([]); }
  };
  useEffect(() => { const t = setTimeout(tolt, 250); return () => clearTimeout(t); }, [q, dok, akcio]);

  const cim = (id) => { const d = katalogus.find(x => x.id === id); return d ? LEG_t(d, 'title') : id; };
  const csv = () => {
    const fej = ['created_at', 'email', 'user_id', 'document_id', 'document_version', 'action', 'context', 'user_agent'];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const tartalom = [fej.join(','), ...(sorok || []).map(r => fej.map(k => esc(r[k])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + tartalom], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'hozzajarulasi-naplo-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const felhasznalok = new Set((sorok || []).map(r => r.user_id)).size;

  return (
    <div className="max-w-6xl xl:max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-in fade-in duration-500">
      <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">Rendszer</p>
      <h1 className="text-3xl font-black text-slate-900 tracking-tight">Hozzájárulási napló</h1>
      <p className="text-slate-400 mt-1 font-medium max-w-[75ch]">Ki, mikor, melyik dokumentum melyik verzióját fogadta el, illetve melyik hozzájárulást adta meg vagy vonta vissza. A napló nem módosítható és nem törölhető.</p>
      {hiba && <div className="mt-5 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm font-semibold text-amber-800">{hiba}</div>}
      {katalogus.length > 0 && (
        <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {katalogus.map(d => (
            <div key={d.id} className="bg-white rounded-2xl border border-slate-100 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-800 text-sm" data-no-i18n="1">{LEG_t(d, 'title')}</span>
                {d.required ? <UBadge tone="red">Kötelező</UBadge> : <UBadge tone="blue">Választható</UBadge>}
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">{d.id} · {d.version}{d.roles && d.roles.length ? ' · ' + d.roles.join(', ') : ''}</div>
              {d.url && <a href={d.url} target="_blank" rel="noopener" className="text-xs font-bold text-primary hover:underline mt-2 inline-block">Megnyitás</a>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-6 bg-white rounded-2xl border border-slate-100 p-4 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1"><Lucide.Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Keresés e-mail-címre…" className={U_input + ' pl-10'} /></div>
        <select aria-label="Dokumentum" value={dok} onChange={e => setDok(e.target.value)} className={U_input + ' lg:max-w-[16rem]'}><option value="">Minden dokumentum</option>{katalogus.map(d => <option key={d.id} value={d.id}>{LEG_t(d, 'title')}</option>)}</select>
        <select aria-label="Művelet" value={akcio} onChange={e => setAkcio(e.target.value)} className={U_input + ' lg:max-w-[12rem]'}><option value="">Minden művelet</option><option value="accept">Elfogadva</option><option value="grant">Megadva</option><option value="withdraw">Visszavonva</option></select>
        <button type="button" onClick={csv} disabled={!sorok || !sorok.length} className={U_btnGhost + ' whitespace-nowrap'}><Lucide.Download size={15} /> CSV</button>
      </div>
      <p className="text-[12px] font-semibold text-slate-500 mt-3">{sorok ? `${sorok.length} bejegyzés · ${felhasznalok} felhasználó` : 'Betöltés…'}</p>
      <div className="mt-2 bg-white rounded-2xl border border-slate-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100"><th className="px-4 py-3">Időpont</th><th className="px-4 py-3">E-mail</th><th className="px-4 py-3">Dokumentum</th><th className="px-4 py-3">Verzió</th><th className="px-4 py-3">Művelet</th><th className="px-4 py-3">Hol</th></tr></thead>
          <tbody>
            {(sorok || []).map(r => (
              <tr key={r.id} className="border-b border-slate-50 last:border-0">
                <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap tabular-nums">{LEG_ido(r.created_at)}</td>
                <td className="px-4 py-2.5 font-semibold text-slate-700" title={r.user_agent || ''}>{r.email || r.user_id}</td>
                <td className="px-4 py-2.5 text-slate-600" data-no-i18n="1">{cim(r.document_id)}</td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-slate-400">{r.document_version}</td>
                <td className="px-4 py-2.5"><UBadge tone={LEG_TONE[r.action] || 'slate'}>{LEG_AKCIO[r.action] || r.action}</UBadge></td>
                <td className="px-4 py-2.5 text-slate-500">{LEG_HELY[r.context] || r.context}</td>
              </tr>
            ))}
            {sorok && !sorok.length && !hiba && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Nincs a szűrésnek megfelelő bejegyzés.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
