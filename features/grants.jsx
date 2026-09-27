/* ============================================================================
   UniPortal — Pályázatfigyelő (77_grants_core.sql)

   MIT AD: a pályázati iroda képernyője. Három fül:
     • Felhívások     — a katalógus szűrőkkel, határidő-visszaszámlálóval,
                        részletekkel és változásnaplóval; kézi felvitel
     • Adatforrások   — melyik csatorna mikor adott adatot, betöltés indítása
     • Beállítások    — modellszolgáltató, napi plafon, határidő-figyelmeztetés

   AMI SZÁNDÉKOSAN NINCS ITT: kutatói nézet. A 2026-09-23-i döntés szerint a
   modult egyelőre csak az admin és a pályázati iroda kezeli; a kutatói radar
   későbbi fázis, és akkor kap saját fájlt (features/grants-researcher.jsx).

   A JOGOSULTSÁGOT NEM EZ A FÁJL DÖNTI EL: minden RPC a szerveren ellenőrzi a
   'grants_office' kulcsot (szerepkör / csoport / egyéni szinten), a felület
   csak megjeleníti, ha nincs meg.
   ============================================================================ */

async function GRT_rpc(fn, args) {
  if (!window.sb) throw new Error('Nincs kapcsolat a háttérrendszerrel.');
  const { data, error } = await window.sb.rpc(fn, args || {});
  if (error) throw error;
  return data;
}

const GRT_api = {
  context:     ()            => GRT_rpc('grants_context'),
  calls:       (p)           => GRT_rpc('grants_calls', {
                                  p_q: p.q || null, p_allapot: p.allapot || null,
                                  p_program: p.program || null, p_source: p.forras || null,
                                  p_napon_belul: p.napon || null,
                                  p_limit: p.limit || 100, p_offset: p.offset || 0 }),
  callGet:     (id)          => GRT_rpc('grants_call_get', { p_call: id }),
  // Beadandó dokumentumok és elvárt eredmények (99_grants_call_details.sql).
  callDetails: (id)          => GRT_rpc('grants_call_details', { p_call: id }),
  callSave:    (adat)        => GRT_rpc('grants_call_save', { p_adat: adat }),
  callArchive: (id, arch)    => GRT_rpc('grants_call_archive', { p_call: id, p_archivalt: arch !== false }),
  options:     ()            => GRT_rpc('grants_call_options'),
  etlRuns:     (n)           => GRT_rpc('grants_etl_runs', { p_limit: n || 30 }),
  deadlines:   (p)           => GRT_rpc('grants_deadlines', {
                                  p_tol: p.tol, p_ig: p.ig,
                                  p_allapot: p.allapot || null, p_program: p.program || null,
                                  p_forras: p.forras || null, p_limit: p.limit || 2000 }),
  deadlineMonths: ()         => GRT_rpc('grants_deadline_months', {}),
  sourceSave:  (adat)        => GRT_rpc('grants_source_save', { p_adat: adat }),
  settingSave: (key, value)  => GRT_rpc('grants_setting_save', { p_key: key, p_value: value }),
  // A betöltés Edge Functionben fut: a service_role kulcs nem lehet a böngészőben.
  fetchCalls: async (opts) => {
    if (!window.sb || !window.sb.functions) throw new Error('A betöltő szolgáltatás nem elérhető.');
    const { data, error } = await window.sb.functions.invoke('grants-fetch-calls', { body: opts || {} });
    if (error) {
      // A supabase-js a nem-2xx választ „Edge Function returned a non-2xx status
      // code"-ra fordítja, és a TÖRZSET eldobja — pedig épp abban van a pontos
      // ok és a szakasz. Ezért kiolvassuk belőle.
      let reszletes = '';
      try {
        const v = error.context;
        if (v && typeof v.text === 'function') {
          const sz = await v.text();
          try {
            const t = JSON.parse(sz);
            reszletes = t.hiba || t.message || t.error || '';
            if (t.szakasz) reszletes += ' [szakasz: ' + t.szakasz + ']';
            if (typeof t.masodperc === 'number') reszletes += ' [' + t.masodperc + ' s]';
          } catch (e2) { reszletes = String(sz).slice(0, 300); }
        }
      } catch (e3) { /* ha a törzs már elfogyott, marad az általános üzenet */ }
      throw new Error(reszletes || error.message || 'A betöltés hibára futott.');
    }
    if (data && data.ok === false) {
      throw new Error((data.hiba || 'A betöltés hibára futott.')
        + (data.szakasz ? ' [szakasz: ' + data.szakasz + ']' : ''));
    }
    return data;
  },
};

function GRT_msg(e) {
  const raw = (e && (e.message || e.error_description || e.hint)) || '';
  if (/GRANTS_FORBIDDEN/.test(raw)) return 'Ehhez pályázati irodai jogosultság kell (grants_office). A Jogosultságok képernyőn adható meg.';
  if (/GRANTS_NOT_AUTHENTICATED/.test(raw)) return 'Nincs bejelentkezve.';
  if (/GRANTS_NOT_EDITABLE/.test(raw)) return 'Ez a felhívás gépi forrásból származik, ezért kézzel nem szerkeszthető — a következő betöltés visszaírná.';
  if (/GRANTS_BAD_INPUT/.test(raw)) return raw.replace(/.*GRANTS_BAD_INPUT:\s*/, '');
  if (/GRANTS_BAD_SETTING/.test(raw)) return raw.replace(/.*GRANTS_BAD_SETTING:\s*/, '');
  if (/GRANTS_CALL_NOT_FOUND/.test(raw)) return 'Ez a felhívás már nem létezik.';
  if (/GRANTS_SOURCE_NOT_FOUND/.test(raw)) return 'Nincs ilyen adatforrás.';
  if (/function .*grants_/i.test(raw) || /schema cache/i.test(raw)) {
    return 'A pályázati modul adatbázis-része még nincs telepítve (supabase/77_grants_core.sql).';
  }
  return raw || 'Ismeretlen hiba.';
}

const GRT_ALLAPOT = {
  nyitott:    { cimke: 'Nyitott',    tone: 'green' },
  hamarosan:  { cimke: 'Hamarosan',  tone: 'blue' },
  zart:       { cimke: 'Zárt',       tone: 'slate' },
  ismeretlen: { cimke: 'Ismeretlen', tone: 'slate' },
};

function GRT_dt(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch (e) { return String(s).slice(0, 10); }
}

/* A visszaszámláló színe a sürgősséget mondja meg, nem csak a számot: a
   háromnapos és a harmincnapos határidő nem ugyanaz a feladat. */
function GRT_Hatarido({ nap, datum }) {
  if (nap === null || nap === undefined) {
    return <span className="text-xs font-bold text-slate-400">nincs határidő</span>;
  }
  const tone = nap <= 3 ? 'red' : nap <= 14 ? 'amber' : nap <= 30 ? 'blue' : 'slate';
  const szin = { red: 'text-red-600', amber: 'text-amber-600', blue: 'text-sky-600', slate: 'text-slate-500' }[tone];
  return (
    <div className="text-right flex-none">
      <p className={'text-sm font-black ' + szin}>
        {nap === 0 ? 'ma jár le' : nap + ' nap'}
      </p>
      <p className="text-[11px] text-slate-400 font-bold">{GRT_dt(datum)}</p>
    </div>
  );
}

function GRT_CallCard({ sor, onNyit }) {
  const a = GRT_ALLAPOT[sor.allapot] || GRT_ALLAPOT.ismeretlen;
  return (
    <button type="button" onClick={() => onNyit(sor.id)}
      className="w-full text-left bg-white border border-slate-100 rounded-2xl p-4 hover:border-primary/40
                 hover:shadow-sm transition-all">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <UBadge tone={a.tone}>{a.cimke}</UBadge>
            {sor.program && <UBadge tone="primary">{sor.program}</UBadge>}
            {sor.partnerkereses && <UBadge tone="violet">partnerkeresés</UBadge>}
            {sor.valtozott && <UBadge tone="amber">módosult</UBadge>}
          </div>
          <p className="text-sm font-black text-slate-800 leading-snug">{sor.cim}</p>
          <p className="text-[11px] text-slate-400 font-bold mt-1 truncate">
            {sor.azonosito}{sor.alprogram ? ' · ' + sor.alprogram : ''}
          </p>
          {sor.kivonat && (
            <p className="text-[11px] text-slate-400 font-medium mt-1 line-clamp-2">{sor.kivonat}</p>
          )}
        </div>
        <GRT_Hatarido nap={sor.hatralevo_nap === null || sor.hatralevo_nap === undefined
                            ? null : Number(sor.hatralevo_nap)} datum={sor.hatarido} />
      </div>
    </button>
  );
}

/* --- felhívás részletei --------------------------------------------------- */
const GRT_DOK_TIPUS = {
  urlap: 'pályázati űrlap', koltsegvetes: 'költségvetés', ertekelo: 'értékelőlap',
  szerzodes: 'szerződésminta', munkaprogram: 'munkaprogram', utmutato: 'útmutató', egyeb: 'egyéb',
};

/* Beadandó dokumentumok és elvárt eredmények. A felhívás szövegéből gépi körben
   készül; amíg nincs meg, ezt ki is írjuk — nem hagyjuk üresen a szakaszt. */
function GRT_Reszletek({ r }) {
  if (!r) return null;
  const dok = r.dokumentumok || [];
  const nincsSemmi = !r.elvart_eredmeny && !r.hatokor && dok.length === 0;
  if (nincsSemmi) {
    return (
      <div className="bg-slate-50 rounded-2xl p-4">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
          Beadandó dokumentumok és elvárt eredmények
        </p>
        <p className="text-sm text-slate-500">
          {r.hiba
            ? `A kiíró oldaláról nem sikerült betölteni: ${r.hiba}`
            : r.frissitve
              ? 'A kiíró oldalán ehhez a felhíváshoz nem szerepel dokumentumlista és elvárt eredmény.'
              : 'Még nem töltöttük le a kiíró oldaláról — a gépi kör hamarosan sorra veszi.'}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {r.elvart_eredmeny && (
        <div className="bg-emerald-50/60 border border-emerald-100 rounded-2xl p-4">
          <p className="text-[10px] font-black text-emerald-700 uppercase tracking-widest mb-2">
            Elvárt eredmények — ezen mérnek minket
          </p>
          <p className="text-sm text-slate-700 whitespace-pre-line">{r.elvart_eredmeny}</p>
        </div>
      )}
      {r.hatokor && (
        <div className="bg-slate-50 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Hatókör</p>
          <p className="text-sm text-slate-600 whitespace-pre-line">{r.hatokor}</p>
        </div>
      )}
      {dok.length > 0 && (
        <div className="bg-slate-50 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
            {`Beadandó és kapcsolódó dokumentumok (${dok.length})`}
          </p>
          <ul className="space-y-1.5">
            {dok.map((x, i) => (
              <li key={i} className="flex items-start gap-2">
                <Lucide.FileText size={13} className="flex-none mt-1 text-slate-400" />
                <span className="min-w-0">
                  {x.url
                    ? <a href={x.url} target="_blank" rel="noopener noreferrer"
                        className="text-sm font-bold text-primary hover:underline break-words">{x.nev}</a>
                    : <span className="text-sm font-bold text-slate-600">{x.nev}</span>}
                  <span className="text-[11px] text-slate-400 ml-1.5">
                    {`${GRT_DOK_TIPUS[x.tipus] || x.tipus}${x.fajl ? '' : ' · hivatkozás, nem fájl'}`}
                  </span>
                  {x.megjegyzes && <span className="block text-[11px] text-slate-400">{x.megjegyzes}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(r.oldalkorlat || r.ertekeles) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {r.oldalkorlat && (
            <div className="bg-slate-50 rounded-2xl p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Formai korlát</p>
              <p className="text-[13px] text-slate-600">{r.oldalkorlat}</p>
            </div>
          )}
          {r.ertekeles && (
            <div className="bg-slate-50 rounded-2xl p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Értékelés és küszöbök</p>
              <p className="text-[13px] text-slate-600">{r.ertekeles}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GRT_CallModal({ open, id, onClose, onValtozott }) {
  const [d, setD] = useState(null);
  const [reszlet, setReszlet] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !id) { setD(null); setReszlet(null); setErr(''); return; }
    let el = true;
    setD(null); setReszlet(null); setErr('');
    GRT_api.callGet(id).then(x => { if (el) setD(x); }).catch(e => { if (el) setErr(GRT_msg(e)); });
    // A részletek külön kérésben: ha nincs jogosultság hozzá, a felhívás
    // adatlapja attól még megjelenik.
    GRT_api.callDetails(id).then(x => { if (el) setReszlet(x); }).catch(() => {});
    return () => { el = false; };
  }, [open, id]);

  const archival = async () => {
    if (!window.confirm('Archiváljuk ezt a felhívást? A katalógusból eltűnik, de a hivatkozások megmaradnak.')) return;
    setBusy(true);
    try { await GRT_api.callArchive(id, true); onValtozott && onValtozott(); onClose(); }
    catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(false); }
  };

  const a = d ? (GRT_ALLAPOT[d.allapot] || GRT_ALLAPOT.ismeretlen) : null;

  return (
    <UModal open={open} onClose={onClose} max="max-w-3xl"
      icon={<Lucide.FileText size={20} />} title={d ? d.cim : 'Felhívás'}
      subtitle={d ? (d.azonosito + (d.forras_nev ? ' · ' + d.forras_nev : '')) : ''}>
      {err && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2 mb-4">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}
      {!err && !d && <div className="space-y-3"><SkeletonBar h={20} /><SkeletonBar /><SkeletonBar w="70%" /></div>}
      {d && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 flex-wrap">
            <UBadge tone={a.tone}>{a.cimke}</UBadge>
            {d.program && <UBadge tone="primary">{d.program}</UBadge>}
            {d.tipus && <UBadge tone="slate">{d.tipus}</UBadge>}
            {d.partnerkereses && <UBadge tone="violet">partnerkeresés engedett</UBadge>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-slate-50 rounded-2xl p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Határidők</p>
              {(d.hataridok || []).length === 0 ? (
                <p className="text-sm font-bold text-slate-400">Nincs megadott határidő.</p>
              ) : (
                <ul className="space-y-1">
                  {d.hataridok.map(h => (
                    <li key={h.sorszam} className="text-sm font-bold text-slate-700">
                      {h.sorszam}. {GRT_dt(h.hatarido)}
                      {h.megjegyzes && <span className="text-slate-400 font-medium"> — {h.megjegyzes}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {d.nyitas && <p className="text-[11px] text-slate-400 font-bold mt-2">Nyitás: {GRT_dt(d.nyitas)}</p>}
            </div>

            <div className="bg-slate-50 rounded-2xl p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Adatok</p>
              <dl className="space-y-1 text-sm">
                {d.felhivas_azonosito && (
                  <div><dt className="inline text-slate-400 font-medium">Felhívás: </dt>
                    <dd className="inline font-bold text-slate-700">{d.felhivas_azonosito}</dd></div>
                )}
                {d.alprogram && (
                  <div><dt className="inline text-slate-400 font-medium">Alprogram: </dt>
                    <dd className="inline font-bold text-slate-700">{d.alprogram}</dd></div>
                )}
                {d.keret_eur && (
                  <div><dt className="inline text-slate-400 font-medium">Keret: </dt>
                    <dd className="inline font-bold text-slate-700">{Number(d.keret_eur).toLocaleString('hu-HU')} EUR</dd></div>
                )}
                {d.kedvezmenyezett && (
                  <div><dt className="inline text-slate-400 font-medium">Kinek: </dt>
                    <dd className="inline font-bold text-slate-700">{d.kedvezmenyezett}</dd></div>
                )}
                <div><dt className="inline text-slate-400 font-medium">Először láttuk: </dt>
                  <dd className="inline font-bold text-slate-700">{GRT_dt(d.first_seen)}</dd></div>
              </dl>
            </div>
          </div>

          {d.kivonat && (
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Kivonat</p>
              <p className="text-sm text-slate-600 leading-relaxed">{d.kivonat}</p>
            </div>
          )}

          {/* Mit kell kitölteni és mit mérnek rajtunk — a kiíró oldaláról
              betöltve. A részletes szövegeket idézzük, a teljes felhívást nem. */}
          <GRT_Reszletek r={reszlet} />

          {/* A teljes felhívásszöveget nem közöljük újra — mindig az eredetire
              hivatkozunk, és ez jogi döntés, nem kényelmi. */}
          {d.url && (
            <a href={d.url} target="_blank" rel="noopener noreferrer"
              className={U_btnPrimary + ' w-full justify-center'}>
              <Lucide.ExternalLink size={16} /> A felhívás teljes szövege a kiíró oldalán
            </a>
          )}

          {(d.valtozasok || []).length > 0 && (
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                Változásnapló
              </p>
              <div className="space-y-1.5">
                {d.valtozasok.map((v, i) => (
                  <div key={i} className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 text-[11px]">
                    <span className="font-black text-amber-700">{v.mi}</span>
                    <span className="text-amber-600/80 font-medium"> · {GRT_dt(v.mikor)}: </span>
                    <span className="text-slate-500">{(v.regi || '—')} → </span>
                    <span className="font-bold text-slate-700">{v.uj || '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-4 border-t border-slate-100">
            <p className="text-[11px] text-slate-400 font-medium">
              {d.szerkesztheto ? 'Kézi felvitel — szerkeszthető.' : 'Gépi forrásból: a betöltés frissíti.'}
            </p>
            <button onClick={archival} disabled={busy} className={U_btnGhost + ' py-2 px-4 text-sm'}>
              <Lucide.Archive size={15} /> Archiválás
            </button>
          </div>
        </div>
      )}
    </UModal>
  );
}

/* --- kézi felvitel -------------------------------------------------------- */
function GRT_CallEditor({ open, onClose, onKesz }) {
  const [f, setF] = useState({ cim: '', program: '', tipus: '', allapot: 'nyitott', url: '', kivonat: '',
                               keret_eur: '', kedvezmenyezett: '', hatarido: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (open) {
      setF({ cim: '', program: '', tipus: '', allapot: 'nyitott', url: '', kivonat: '',
             keret_eur: '', kedvezmenyezett: '', hatarido: '' });
      setErr('');
    }
  }, [open]);

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      await GRT_api.callSave({
        cim: f.cim.trim(), program: f.program.trim() || null, tipus: f.tipus.trim() || null,
        allapot: f.allapot, url: f.url.trim() || null, kivonat: f.kivonat.trim() || null,
        keret_eur: f.keret_eur || null, kedvezmenyezett: f.kedvezmenyezett.trim() || null,
        hataridok: f.hatarido ? [{ hatarido: new Date(f.hatarido).toISOString() }] : [],
      });
      onKesz();
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <UModal open={open} onClose={busy ? () => {} : onClose} max="max-w-2xl"
      icon={<Lucide.FilePlus size={20} />} title="Felhívás rögzítése kézzel"
      subtitle="Amit hírlevélben, NCP-levélben vagy partneri megkeresésben kapunk">
      {err && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2 mb-4">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}
      <div className="space-y-4">
        <UField label="A felhívás címe" hint="Ez látszik a katalógusban.">
          <input className={U_input} value={f.cim} onChange={e => setF({ ...f, cim: e.target.value })} maxLength={400} />
        </UField>
        <div className="grid gap-3 sm:grid-cols-2">
          <UField label="Program" hint="Például NKFI, Erasmus+, Visegrad Fund.">
            <input className={U_input} value={f.program} onChange={e => setF({ ...f, program: e.target.value })} />
          </UField>
          <UField label="Típus" hint="Kutatási pályázat, ösztöndíj, mobilitás…">
            <input className={U_input} value={f.tipus} onChange={e => setF({ ...f, tipus: e.target.value })} />
          </UField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <UField label="Állapot">
            <select className={U_input} value={f.allapot} onChange={e => setF({ ...f, allapot: e.target.value })}>
              <option value="nyitott">Nyitott</option>
              <option value="hamarosan">Hamarosan nyílik</option>
              <option value="zart">Zárt</option>
            </select>
          </UField>
          <UField label="Beadási határidő">
            <input type="date" className={U_input} value={f.hatarido}
              onChange={e => setF({ ...f, hatarido: e.target.value })} />
          </UField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <UField label="Keret (EUR)" hint="Nem kötelező.">
            <input type="number" min="0" className={U_input} value={f.keret_eur}
              onChange={e => setF({ ...f, keret_eur: e.target.value })} />
          </UField>
          <UField label="Kinek szól" hint="Egyetem, konzorcium, egyéni kutató…">
            <input className={U_input} value={f.kedvezmenyezett}
              onChange={e => setF({ ...f, kedvezmenyezett: e.target.value })} />
          </UField>
        </div>
        <UField label="Hivatkozás a kiírásra" hint="A teljes szöveget nem tároljuk, csak ide hivatkozunk.">
          <input className={U_input} value={f.url} onChange={e => setF({ ...f, url: e.target.value })}
            placeholder="https://" />
        </UField>
        <UField label="Rövid kivonat" hint="Két-három mondat arról, mire szól.">
          <textarea className={U_input + ' min-h-[90px]'} value={f.kivonat}
            onChange={e => setF({ ...f, kivonat: e.target.value })} maxLength={1200} />
        </UField>
      </div>
      <div className="flex items-center justify-end gap-2 mt-6 pt-5 border-t border-slate-100">
        <button onClick={onClose} disabled={busy} className={U_btnGhost + ' py-2.5 px-5'}>Mégse</button>
        <button onClick={ment} disabled={busy || !f.cim.trim()}
          className={U_btnPrimary + ' py-2.5 px-5 disabled:opacity-40'}>
          {busy ? 'Mentés…' : 'Rögzítés'}
        </button>
      </div>
    </UModal>
  );
}

/* --- adatforrás kártya ---------------------------------------------------- */
function GRT_SourceCard({ f, onMent, onBetolt, betoltBusy, betoltAllas }) {
  const [nyit, setNyit] = useState(false);
  const [utem, setUtem] = useState(String(f.utem_ora || 24));
  const tipusCimke = { api: 'gépi végpont', html: 'HTML-értelmező', rss: 'hírcsatorna', kezi: 'kézi rögzítés' }[f.tipus] || f.tipus;

  return (
    <div className={'bg-white border rounded-2xl p-4 ' + (f.elavult ? 'border-amber-200' : 'border-slate-100')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <p className="text-sm font-black text-slate-800">{f.nev}</p>
            <UBadge tone="slate">{tipusCimke}</UBadge>
            {!f.aktiv && <UBadge tone="slate">kikapcsolva</UBadge>}
            {f.gepi_gyujtes ? <UBadge tone="green">gépi gyűjtés</UBadge> : <UBadge tone="amber">csak kézi</UBadge>}
            {f.elavult && <UBadge tone="amber">elavult</UBadge>}
          </div>
          <p className="text-[11px] text-slate-400 font-bold">
            {f.felhivas_db} felhívás · utolsó sikeres betöltés: {f.utolso_siker ? GRT_dt(f.utolso_siker) : 'még nem futott'}
          </p>
          {f.utolso_hiba && (
            <p className="text-[11px] text-red-500 font-bold mt-1">Hiba: {f.utolso_hiba}</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5 flex-none">
          {f.kod === 'eu_portal' && f.gepi_gyujtes && (
            <>
              <button onClick={() => onBetolt(f.kod, false)} disabled={betoltBusy}
                className={U_btnGhost + ' py-2 px-3 text-xs'}>
                {betoltBusy ? <Lucide.Loader2 size={14} className="animate-spin" /> : <Lucide.DownloadCloud size={14} />}
                {betoltBusy && betoltAllas ? betoltAllas : 'Betöltés most'}
              </button>
              {/* Próbamenet: letölt és feldolgoz, de NEM ír — üzemzavar
                  kivizsgálásához ez mondja meg, a forrás vagy az adatbázis
                  oldalán van-e a baj. */}
              <button onClick={() => onBetolt(f.kod, true)} disabled={betoltBusy}
                className={U_btnGhost + ' py-2 px-3 text-[11px]'}>
                <Lucide.FlaskConical size={13} /> Próbamenet
              </button>
            </>
          )}
          <button onClick={() => setNyit(!nyit)} className={U_btnGhost + ' py-2 px-3 text-xs'}>
            <Lucide.Settings2 size={14} /> Beállítás
          </button>
        </div>
      </div>

      {nyit && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
          <p className="text-[11px] text-slate-500 font-medium leading-relaxed">{f.leiras || '—'}</p>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
              <input type="checkbox" checked={!!f.aktiv}
                onChange={e => onMent({ kod: f.kod, aktiv: e.target.checked })} /> aktív
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
              <input type="checkbox" checked={!!f.gepi_gyujtes}
                onChange={e => onMent({ kod: f.kod, gepi_gyujtes: e.target.checked })} /> gépi gyűjtés engedélyezve
            </label>
            <span className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
              ütem:
              <input type="number" min="1" max="720" value={utem} onChange={e => setUtem(e.target.value)}
                onBlur={() => onMent({ kod: f.kod, utem_ora: Number(utem) || 24 })}
                className="w-16 bg-slate-50 border border-slate-100 rounded-lg px-2 py-1 text-xs" /> óra
            </span>
          </div>
          {/* A jogi állapot ADATKÉNT látszik: nem fejlesztői döntés, hanem
              megnyitható, módosítható mező. */}
          <p className="text-[11px] text-slate-400 font-medium leading-relaxed">
            <b>Jogi megjegyzés:</b> {f.jogi_megjegyzes || 'nincs rögzítve'}
          </p>
        </div>
      )}
    </div>
  );
}

/* --- határidő-naptár ------------------------------------------------------ */
/* A hónap- és napneveket NEM a szótár fordítja: azok összetett szövegek
   („2026. szeptember"), és a napnevek egybetűs csomópontjai máshol is
   előfordulhatnának. A meglévő CAL_angol() mintát követjük (app.jsx). */
const GRT_HONAP_HU = ['január', 'február', 'március', 'április', 'május', 'június',
                      'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
const GRT_HONAP_EN = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
const GRT_NAP_HU = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];
const GRT_NAP_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const GRT_iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
                     + '-' + String(d.getDate()).padStart(2, '0');

/* A sürgősség színe egy helyen: a naptár és a kártyák ugyanazt mondják. */
function GRT_surgosseg(hatra) {
  if (hatra === null || hatra === undefined) return 'slate';
  if (hatra < 0) return 'lejart';
  if (hatra <= 3) return 'piros';
  if (hatra <= 14) return 'sarga';
  if (hatra <= 30) return 'kek';
  return 'slate';
}
const GRT_SURGOSSEG_OSZTALY = {
  lejart: 'bg-slate-100 text-slate-400 line-through',
  piros:  'bg-red-50 text-red-700',
  sarga:  'bg-amber-50 text-amber-700',
  kek:    'bg-sky-50 text-sky-700',
  slate:  'bg-slate-50 text-slate-600',
};

function GRT_Naptar({ onNyit }) {
  const angol = (typeof CAL_angol === 'function' ? CAL_angol() : false);
  const HONAP = angol ? GRT_HONAP_EN : GRT_HONAP_HU;
  const NAPOK = angol ? GRT_NAP_EN : GRT_NAP_HU;
  const ma = new Date();
  const [ev, setEv] = useState(ma.getFullYear());
  const [ho, setHo] = useState(ma.getMonth());        // 0-11
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [valasztott, setValasztott] = useState(null); // kiválasztott nap (ISO)
  const [allapot, setAllapot] = useState('');
  const [program, setProgram] = useState('');
  const [opts, setOpts] = useState(null);
  const [honapok, setHonapok] = useState(null);

  useEffect(() => {
    GRT_api.options().then(setOpts).catch(() => {});
    GRT_api.deadlineMonths().then(setHonapok).catch(() => {});
  }, []);

  const tol = new Date(ev, ho, 1);
  const ig = new Date(ev, ho + 1, 0);

  useEffect(() => {
    let el = true;
    setD(null); setErr(''); setValasztott(null);
    GRT_api.deadlines({ tol: GRT_iso(tol), ig: GRT_iso(ig), allapot, program })
      .then(x => { if (el) setD(x); })
      .catch(e => { if (el) setErr(GRT_msg(e)); });
    return () => { el = false; };
  }, [ev, ho, allapot, program]);

  const leptet = (n) => {
    const uj = new Date(ev, ho + n, 1);
    setEv(uj.getFullYear()); setHo(uj.getMonth());
  };

  /* A rács hétfővel indul (magyar szokás), és a hónap előtti-utáni napokat
     halványan megjeleníti, hogy a hetek ne csúszkáljanak. */
  const racs = React.useMemo(() => {
    const elso = new Date(ev, ho, 1);
    const kezdoEltolas = (elso.getDay() + 6) % 7;      // hétfő = 0
    const napok = [];
    const start = new Date(ev, ho, 1 - kezdoEltolas);
    for (let i = 0; i < 42; i++) {
      const nap = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      napok.push(nap);
      if (i >= 34 && nap.getMonth() !== ho && (nap.getDay() + 6) % 7 === 6) break;
    }
    return napok;
  }, [ev, ho]);

  const naponta = (d && d.naponta) || {};
  const sorok = (d && d.sorok) || [];
  const napSorok = React.useMemo(() => {
    const m = {};
    sorok.forEach(s => { (m[s.nap] = m[s.nap] || []).push(s); });
    return m;
  }, [sorok]);

  const maIso = GRT_iso(ma);
  const valasztottSorok = valasztott ? (napSorok[valasztott] || []) : [];

  /* A legsűrűbb hónapok: tervezéshez ez mondja meg, hol lesz dömping. */
  const surus = React.useMemo(() => (honapok || [])
    .filter(h => h.honap >= GRT_iso(ma).slice(0, 7))
    .sort((a, b) => b.db - a.db).slice(0, 3), [honapok]);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-100 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <button onClick={() => leptet(-1)} className={U_btnGhost + ' py-2 px-3'} aria-label="Előző hónap">
              <Lucide.ChevronLeft size={16} />
            </button>
            <p className="text-sm font-black text-slate-800 min-w-[170px] text-center">
              {angol ? HONAP[ho] + ' ' + ev : ev + '. ' + HONAP[ho]}
            </p>
            <button onClick={() => leptet(1)} className={U_btnGhost + ' py-2 px-3'} aria-label="Következő hónap">
              <Lucide.ChevronRight size={16} />
            </button>
            <button onClick={() => { setEv(ma.getFullYear()); setHo(ma.getMonth()); }}
              className={U_btnGhost + ' py-2 px-3 text-xs'}>Ma</button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select className={U_input + ' py-2 w-auto text-xs'} value={allapot}
              onChange={e => setAllapot(e.target.value)}>
              <option value="">Minden állapot</option>
              <option value="nyitott">Nyitott</option>
              <option value="hamarosan">Hamarosan nyílik</option>
              <option value="zart">Zárt</option>
            </select>
            <select className={U_input + ' py-2 w-auto text-xs'} value={program}
              onChange={e => setProgram(e.target.value)}>
              <option value="">Minden program</option>
              {((opts && opts.program) || []).map(p => (
                <option key={p.ertek} value={p.ertek}>{p.ertek} ({p.db})</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <p className="text-[11px] font-bold text-slate-400">
            {d === null ? 'betöltés…' : `${d.ossz} határidő ebben a hónapban`}
            {d && Number(d.ossz) > Number(d.mutatva) ? ` (${d.mutatva} megjelenítve)` : ''}
          </p>
          {surus.length > 0 && (
            <p className="text-[11px] font-medium text-slate-400">
              Legsűrűbb hónapok:{' '}
              {surus.map((h, i) => (
                <button key={h.honap} onClick={() => { const [y, m] = h.honap.split('-');
                                                       setEv(Number(y)); setHo(Number(m) - 1); }}
                  className="font-black text-primary hover:underline">
                  {h.honap} ({h.db}){i < surus.length - 1 ? ', ' : ''}
                </button>
              ))}
            </p>
          )}
        </div>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      <div className="bg-white border border-slate-100 rounded-2xl p-3 sm:p-4 overflow-x-auto">
        <div className="grid grid-cols-7 gap-1 sm:gap-2 min-w-[640px]">
          {NAPOK.map((n, i) => (
            <div key={n} className={'text-[10px] font-black uppercase tracking-wider text-center pb-1 '
                                    + (i >= 5 ? 'text-slate-300' : 'text-slate-400')}>{n}</div>
          ))}
          {racs.map(nap => {
            const iso = GRT_iso(nap);
            const ebbenAHoban = nap.getMonth() === ho;
            const db = naponta[iso] || 0;
            const tetelek = napSorok[iso] || [];
            const hetvege = nap.getDay() === 0 || nap.getDay() === 6;
            return (
              <button key={iso} type="button" onClick={() => setValasztott(db ? iso : null)}
                className={'text-left rounded-xl border p-1.5 min-h-[86px] align-top transition-all '
                  + (valasztott === iso ? 'border-primary bg-primary/5 ' : 'border-slate-100 ')
                  + (ebbenAHoban ? (hetvege ? 'bg-slate-50/60 ' : 'bg-white ') : 'bg-slate-50/40 opacity-50 ')
                  + (db ? 'hover:border-primary/40 cursor-pointer' : 'cursor-default')}>
                <div className="flex items-center justify-between">
                  <span className={'text-[11px] font-black '
                    + (iso === maIso ? 'bg-primary text-white rounded-full w-5 h-5 inline-flex items-center justify-center'
                                     : ebbenAHoban ? 'text-slate-600' : 'text-slate-400')}>
                    {nap.getDate()}
                  </span>
                  {db > 0 && <span className="text-[10px] font-black text-slate-400">{db}</span>}
                </div>
                <div className="mt-1 space-y-0.5">
                  {tetelek.slice(0, 2).map((t, i) => (
                    <div key={t.call_id + '-' + t.sorszam + '-' + i}
                      className={'text-[9px] font-bold rounded px-1 py-0.5 truncate '
                                 + GRT_SURGOSSEG_OSZTALY[GRT_surgosseg(Number(t.hatralevo_nap))]}>
                      {t.program || t.forras}{Number(t.hatarido_db) > 1 ? ` · ${t.sorszam}/${t.hatarido_db}` : ''}
                    </div>
                  ))}
                  {tetelek.length > 2 && (
                    <div className="text-[9px] font-black text-slate-400 px-1">
                      +{tetelek.length - 2} további
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {valasztott && (
        <div className="bg-white border border-slate-100 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-black text-slate-800">
              {valasztott} · {valasztottSorok.length} határidő
            </h3>
            <button onClick={() => setValasztott(null)} className={U_btnGhost + ' py-1.5 px-3 text-xs'}>
              <Lucide.X size={14} /> Bezárás
            </button>
          </div>
          <div className="space-y-2">
            {valasztottSorok.map((t, i) => {
              const a = GRT_ALLAPOT[t.allapot] || GRT_ALLAPOT.ismeretlen;
              return (
                <button key={t.call_id + '-' + t.sorszam + '-' + i} type="button"
                  onClick={() => onNyit(t.call_id)}
                  className="w-full text-left border border-slate-100 rounded-xl px-3 py-2 hover:border-primary/40 transition-all">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <UBadge tone={a.tone}>{a.cimke}</UBadge>
                    {t.program && <UBadge tone="primary">{t.program}</UBadge>}
                    {Number(t.hatarido_db) > 1 && (
                      <UBadge tone="violet">{t.sorszam}. forduló / {t.hatarido_db}</UBadge>
                    )}
                    {t.partnerkereses && <UBadge tone="slate">partnerkeresés</UBadge>}
                  </div>
                  <p className="text-sm font-black text-slate-800 leading-snug">{t.cim}</p>
                  <p className="text-[11px] text-slate-400 font-bold">{t.azonosito}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!valasztott && d && Number(d.ossz) > 0 && (
        <p className="text-[11px] text-slate-400 font-medium text-center">
          Kattints egy napra a határidők listájához. A kétszakaszos felhívásoknál
          a fordulók száma is látszik (például 2/3).
        </p>
      )}
      {d && Number(d.ossz) === 0 && (
        <UEmpty icon={<Lucide.CalendarOff size={28} />} title="Ebben a hónapban nincs határidő"
          subtitle="Lépj másik hónapra, vagy engedd fel a szűrőket." />
      )}
    </div>
  );
}

/* ============================================================================
   A fő nézet
   ============================================================================ */
function GRT_OfficeView({ user }) {
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  const [ful, setFul] = useState('felhivasok');
  const [toast, setToast] = useState('');

  // szűrők
  const [q, setQ] = useState('');
  const [allapot, setAllapot] = useState('nyitott');
  const [program, setProgram] = useState('');
  const [napon, setNapon] = useState('');
  const [lista, setLista] = useState(null);
  const [opts, setOpts] = useState(null);
  const [listaBusy, setListaBusy] = useState(false);

  const [nyitottId, setNyitottId] = useState(null);
  const [ujOpen, setUjOpen] = useState(false);
  const [runs, setRuns] = useState(null);
  const [betoltBusy, setBetoltBusy] = useState(false);
  const [betoltAllas, setBetoltAllas] = useState('');

  const ctxBetolt = () => GRT_api.context().then(setCtx).catch(e => setErr(GRT_msg(e)));

  useEffect(() => { ctxBetolt(); GRT_api.options().then(setOpts).catch(() => {}); }, []);

  // A listát késleltetve kérjük: gépelés közben ne menjen kérés minden leütésre.
  useEffect(() => {
    let el = true;
    setListaBusy(true);
    const t = setTimeout(() => {
      GRT_api.calls({ q, allapot, program, napon: napon ? Number(napon) : null, limit: 60 })
        .then(d => { if (el) { setLista(d); setListaBusy(false); } })
        .catch(e => { if (el) { setErr(GRT_msg(e)); setListaBusy(false); } });
    }, 300);
    return () => { el = false; clearTimeout(t); };
  }, [q, allapot, program, napon]);

  useEffect(() => { if (ful === 'forrasok') GRT_api.etlRuns(20).then(setRuns).catch(() => {}); }, [ful]);

  const forrasMent = async (adat) => {
    try { await GRT_api.sourceSave(adat); await ctxBetolt(); setToast('Beállítás mentve.'); }
    catch (e) { setErr(GRT_msg(e)); }
  };

  /* A betöltés SZELETEKBEN megy. Egy Edge Function-invokáció nem tudja
     végigolvasni a 124 MB-os forrást (mérve: erőforrás-korlátba fut), ezért a
     függvény byte-range szeletet dolgoz fel, és megmondja, mi a következő. A
     felület jár végig rajtuk, és közben kiírja, hol tart. A naplóban ez EGY
     futás marad: a run azonosítóját visszaadjuk a következő szeletnek. */
  const betolt = async (kod, dry) => {
    setBetoltBusy(true); setErr(''); setBetoltAllas('');
    const ossz = { uj: 0, modosult: 0, valtozatlan: 0, kivalasztott: 0, masodperc: 0 };
    try {
      let szelet = 0;
      let run = null;
      let szeletek = null;
      let kor = 0;
      while (szelet !== null && szelet !== undefined && kor < 64) {
        kor++;
        const r = await GRT_api.fetchCalls({
          ...(dry ? { dry: true } : {}),
          szelet,
          ...(run !== null && run !== undefined ? { run } : {}),
        });
        if (r && r.run !== null && r.run !== undefined) run = r.run;
        szeletek = (r && r.szeletek) || szeletek;
        ossz.uj += (r && r.uj) || 0;
        ossz.modosult += (r && r.modosult) || 0;
        ossz.valtozatlan += (r && r.valtozatlan) || 0;
        ossz.kivalasztott += (r && r.kivalasztott) || 0;
        ossz.masodperc += (r && r.masodperc) || 0;
        setBetoltAllas(`${(r && typeof r.szelet === 'number' ? r.szelet : szelet) + 1}/${szeletek || '?'} szelet`);
        szelet = (r && r.kovetkezo !== undefined) ? r.kovetkezo : null;
      }
      setToast(dry
        ? `Próbamenet kész: ${ossz.kivalasztott} tétel jött volna be (${ossz.masodperc} s), írás nem történt.`
        : `Betöltés kész: ${ossz.uj} új, ${ossz.modosult} módosult, ${ossz.valtozatlan} változatlan (${ossz.masodperc} s).`);
      await ctxBetolt();
      GRT_api.etlRuns(20).then(setRuns).catch(() => {});
      GRT_api.calls({ q, allapot, program, napon: napon ? Number(napon) : null, limit: 60 }).then(setLista).catch(() => {});
    } catch (e) {
      // A részeredmény megmarad: ami már betöltődött, az bent van. Ezt ki is írjuk,
      // hogy ne tűnjön úgy, mintha az egész futás kárba ment volna.
      setErr(GRT_msg(e) + (ossz.uj || ossz.modosult
        ? ` — a megszakadásig ${ossz.uj} új és ${ossz.modosult} módosult felhívás betöltődött.`
        : ''));
    }
    finally { setBetoltBusy(false); setBetoltAllas(''); }
  };

  const beallitasMent = async (key, value) => {
    try { await GRT_api.settingSave(key, value); await ctxBetolt(); setToast('Beállítás mentve.'); }
    catch (e) { setErr(GRT_msg(e)); }
  };

  if (ctx === null && !err) {
    return (
      <div className="p-4 sm:p-8 max-w-6xl mx-auto">
        <SkeletonBar w="260px" h={22} className="mb-2" />
        <SkeletonBar w="420px" h={13} className="mb-7" />
        <div className="grid gap-3 sm:grid-cols-4 mb-6">
          {[0, 1, 2, 3].map(i => <SkeletonBar key={i} h={76} />)}
        </div>
        <div className="space-y-3">{[0, 1, 2, 3].map(i => <SkeletonBar key={i} h={92} />)}</div>
      </div>
    );
  }

  if (ctx && !ctx.kezelo) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto">
        <UEmpty icon={<Lucide.Lock size={28} />} title="Ehhez pályázati irodai jogosultság kell"
          subtitle="A hozzáférést a Jogosultságok képernyőn lehet megadni (grants_office) — szerepkörre, csoportra vagy egyénileg." />
      </div>
    );
  }

  const sz = (ctx && ctx.szamok) || {};
  const forrasok = (ctx && ctx.forrasok) || [];
  const elavultDb = forrasok.filter(f => f.elavult).length;

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-1 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">Pályázatfigyelő</h1>
          <p className="text-sm text-slate-400 font-medium mt-0.5">
            Hazai és nemzetközi felhívások egy helyen · a teljes szöveg mindig a kiíró oldalán
          </p>
        </div>
        <button onClick={() => setUjOpen(true)} className={U_btnPrimary + ' py-2.5 px-4 text-sm'}>
          <Lucide.FilePlus size={16} /> Felhívás rögzítése
        </button>
      </div>

      {err && (
        <div className="mt-4 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {/* Számok: a "közeli" a lényeg — az, amivel dolgozni kell. */}
      <div className="grid gap-3 sm:grid-cols-4 mt-6 mb-6">
        {[
          { c: 'Nyitott', v: sz.nyitott, tone: 'text-emerald-600' },
          { c: '30 napon belül lejár', v: sz.kozeli, tone: 'text-amber-600' },
          { c: 'Hamarosan nyílik', v: sz.hamarosan, tone: 'text-sky-600' },
          { c: 'Program', v: sz.program_db, tone: 'text-slate-700' },
        ].map(k => (
          <div key={k.c} className="bg-white border border-slate-100 rounded-2xl p-4">
            <p className={'text-2xl font-black ' + k.tone}>{k.v ?? 0}</p>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-0.5">{k.c}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {[
          { id: 'felhivasok', cim: 'Felhívások', ikon: <Lucide.List size={14} /> },
          { id: 'naptar', cim: 'Határidőnaptár', ikon: <Lucide.CalendarDays size={14} /> },
          { id: 'kutatok', cim: 'Kutatók', ikon: <Lucide.Users size={14} /> },
          // Bevonás és csapat (88+89+90). A bevonás áll előbb: a modul célja nem
          // a legjobb csapat, hanem a legjobb csapat, amelyik a legtöbb
          // kollégát vonja be.
          { id: 'bevonas', cim: 'Bevonás', ikon: <Lucide.HeartHandshake size={14} /> },
          { id: 'csapat', cim: 'Csapatajánló', ikon: <Lucide.Sparkles size={14} /> },
          { id: 'forrasok', cim: 'Adatforrások', ikon: <Lucide.Database size={14} />, jel: elavultDb },
          { id: 'beallitas', cim: 'Beállítások', ikon: <Lucide.Settings size={14} /> },
        ].map(t => (
          <button key={t.id} onClick={() => setFul(t.id)}
            className={'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all '
                       + (ful === t.id ? 'bg-primary text-white' : 'bg-white border border-slate-100 text-slate-500 hover:border-slate-200')}>
            {t.ikon} {t.cim}
            {t.jel > 0 && (
              <span className={'ml-1 px-1.5 rounded-full ' + (ful === t.id ? 'bg-white/20' : 'bg-amber-100 text-amber-700')}>
                {t.jel}
              </span>
            )}
          </button>
        ))}
      </div>

      {ful === 'felhivasok' && (
        <>
          <div className="bg-white border border-slate-100 rounded-2xl p-4 mb-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="relative sm:col-span-2">
                <Lucide.Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300" />
                <input className={U_input + ' pl-10'} value={q} onChange={e => setQ(e.target.value)}
                  placeholder="Keresés címre, azonosítóra, címkére…" />
              </div>
              <select className={U_input} value={allapot} onChange={e => setAllapot(e.target.value)}>
                <option value="">Minden állapot</option>
                <option value="nyitott">Nyitott</option>
                <option value="hamarosan">Hamarosan nyílik</option>
                <option value="zart">Zárt</option>
              </select>
              <select className={U_input} value={program} onChange={e => setProgram(e.target.value)}>
                <option value="">Minden program</option>
                {((opts && opts.program) || []).map(p => (
                  <option key={p.ertek} value={p.ertek}>{p.ertek} ({p.db})</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">Határidő:</span>
              {[{ v: '', c: 'mindegy' }, { v: '7', c: '7 napon belül' }, { v: '30', c: '30 napon belül' },
                { v: '90', c: '90 napon belül' }].map(h => (
                <button key={h.v} onClick={() => setNapon(h.v)}
                  className={'px-3 py-1.5 rounded-lg text-[11px] font-black transition-all '
                             + (napon === h.v ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100')}>
                  {h.c}
                </button>
              ))}
              <div className="flex-1" />
              {lista && (
                <span className="text-[11px] font-bold text-slate-400 flex items-center gap-2">
                  {lista.mutatva} / {lista.ossz} felhívás <RefreshingBadge on={listaBusy} />
                </span>
              )}
            </div>
          </div>

          {lista === null ? (
            <div className="space-y-3">{[0, 1, 2, 3, 4].map(i => <SkeletonBar key={i} h={92} />)}</div>
          ) : (lista.sorok || []).length === 0 ? (
            <UEmpty icon={<Lucide.SearchX size={28} />} title="Nincs találat"
              subtitle={Number(lista.ossz) === 0 && !q
                ? 'A katalógus még üres. Indíts betöltést az Adatforrások fülön, vagy rögzíts felhívást kézzel.'
                : 'Próbáld szűkebb szűrőkkel.'} />
          ) : (
            <div className="space-y-3">
              {lista.sorok.map(s => <GRT_CallCard key={s.id} sor={s} onNyit={setNyitottId} />)}
              {Number(lista.ossz) > Number(lista.mutatva) && (
                <p className="text-center text-[11px] font-bold text-slate-400 py-2">
                  {lista.ossz - lista.mutatva} további találat — szűkíts a szűrőkkel.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {ful === 'naptar' && <GRT_Naptar onNyit={setNyitottId} />}

      {ful === 'kutatok' && <GRTR_KutatokView />}

      {ful === 'bevonas' && <GRTT_BevonasView />}

      {ful === 'csapat' && <GRTT_CsapatView />}

      {ful === 'forrasok' && (
        <div className="space-y-4">
          {elavultDb > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 flex gap-2.5">
              <Lucide.AlertTriangle size={15} className="text-amber-500 flex-none mt-0.5" />
              <p className="text-[11px] text-amber-700 font-medium leading-relaxed">
                <b>{elavultDb} forrás elavult:</b> az ütemnél régebben futott utolszor. Ez a képernyő
                azért van, hogy egy elnémult csatorna ne maradjon észrevétlen — a felhívások csendben
                tűnnének el, nem hibaüzenettel.
              </p>
            </div>
          )}
          <div className="space-y-3">
            {forrasok.map(f => (
              <GRT_SourceCard key={f.kod} f={f} onMent={forrasMent} onBetolt={betolt}
                betoltBusy={betoltBusy} betoltAllas={betoltAllas} />
            ))}
          </div>

          <div className="bg-white border border-slate-100 rounded-2xl p-4">
            <h3 className="text-sm font-black text-slate-800 mb-1">Betöltési napló</h3>
            <p className="text-[11px] text-slate-400 font-medium mb-3">
              Forrásonként, futásonként egy sor. Egy forrás hibája nem állítja meg a többit.
            </p>
            {runs === null ? <SkeletonBar h={60} /> : runs.length === 0 ? (
              <p className="text-sm font-bold text-slate-400">Még nem futott betöltés.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-wider">
                      <th className="py-2">Forrás</th><th className="py-2">Indult</th>
                      <th className="py-2">Állapot</th><th className="py-2 text-right">Új</th>
                      <th className="py-2 text-right">Módosult</th><th className="py-2 text-right">Változatlan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map(r => (
                      <tr key={r.id} className="border-t border-slate-50">
                        <td className="py-2 font-bold text-slate-700">{r.forras_nev || r.forras}</td>
                        <td className="py-2 text-slate-500">{GRT_dt(r.indult)}</td>
                        <td className="py-2">
                          <UBadge tone={r.allapot === 'ok' ? 'green' : r.allapot === 'hiba' ? 'red' : 'slate'}>
                            {r.allapot}
                          </UBadge>
                          {r.hiba && <span className="text-red-500 font-bold ml-1">{String(r.hiba).slice(0, 60)}</span>}
                        </td>
                        <td className="py-2 text-right font-black text-slate-700">{r.uj_db}</td>
                        <td className="py-2 text-right text-slate-500">{r.modosult_db}</td>
                        <td className="py-2 text-right text-slate-400">{r.valtozatlan_db}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {ful === 'beallitas' && (
        <div className="space-y-4 max-w-2xl">
          {/* A pontozás hangolása (100): irodai döntés, ezért itt van és nem
              migrációban. A grants-teams.jsx viszi. */}
          <GRTT_PontozasBeallitas />

          <div className="bg-white border border-slate-100 rounded-2xl p-5 space-y-4">
            <div>
              <h3 className="text-sm font-black text-slate-800">Modellszolgáltató</h3>
              <p className="text-[11px] text-slate-400 font-medium mt-0.5 leading-relaxed">
                Az indoklásokat és a kutatói összefoglalókat ez a szolgáltató adja. A csere itt
                egyetlen beállítás — a kulcs viszont <b>soha nem itt</b>, hanem Supabase secretben él
                (GEMINI_API_KEY / ANTHROPIC_API_KEY).
              </p>
            </div>
            <UField label="Szolgáltató">
              <select className={U_input} value={(ctx.beallitas || {}).ai_provider || 'gemini'}
                onChange={e => beallitasMent('ai_provider', e.target.value)}>
                <option value="gemini">Gemini</option>
                <option value="anthropic">Claude (Anthropic)</option>
                <option value="nincs">Nincs — csak számított pontszám</option>
              </select>
            </UField>
            <UField label="Modell" hint="Üresen a betöltő függvény alapértelmezését használja.">
              <input className={U_input} defaultValue={(ctx.beallitas || {}).ai_model || ''}
                onBlur={e => beallitasMent('ai_model', e.target.value)} placeholder="alapértelmezés" />
            </UField>
            <UField label="Napi költségplafon (USD)"
              hint="Elérése után a modul nem hív modellt, de működik tovább a számított pontszámmal.">
              <input type="number" min="0" step="0.5" className={U_input}
                defaultValue={(ctx.beallitas || {}).ai_daily_cap_usd || '2'}
                onBlur={e => beallitasMent('ai_daily_cap_usd', e.target.value)} />
            </UField>
          </div>

          <div className="bg-white border border-slate-100 rounded-2xl p-5">
            <h3 className="text-sm font-black text-slate-800 mb-1">Határidő-figyelmeztetés</h3>
            <p className="text-[11px] text-slate-400 font-medium mb-3">
              Hány nappal a határidő előtt jelezzen a rendszer. Vesszővel elválasztva.
            </p>
            <input className={U_input} defaultValue={(ctx.beallitas || {}).deadline_warn_days || '30,14,3'}
              onBlur={e => beallitasMent('deadline_warn_days', e.target.value)} />
          </div>

          <div className="bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5">
            <Lucide.Info size={15} className="text-slate-400 flex-none mt-0.5" />
            <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
              A kutatói profil, az illesztés és az indoklás a következő fázisokban jön (78-as és
              79-es migráció). Addig ez a képernyő a felhívás-katalógust és a betöltést kezeli.
            </p>
          </div>
        </div>
      )}

      <GRT_CallModal open={!!nyitottId} id={nyitottId} onClose={() => setNyitottId(null)}
        onValtozott={() => GRT_api.calls({ q, allapot, program, napon: napon ? Number(napon) : null, limit: 60 })
                            .then(setLista).catch(() => {})} />
      <GRT_CallEditor open={ujOpen} onClose={() => setUjOpen(false)}
        onKesz={() => {
          setUjOpen(false);
          setToast('A felhívás rögzítve.');
          GRT_api.calls({ q, allapot, program, napon: napon ? Number(napon) : null, limit: 60 })
            .then(setLista).catch(() => {});
          ctxBetolt();
        }} />
      <UToast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
