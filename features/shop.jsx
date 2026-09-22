/* ============================================================
   WEBSHOP (74_webshop.sql)

   HALLGATÓI OLDAL — SHOP_StudentView
     Katalógus kategóriákkal és kereséssel, kosár, rendelés leadása, fizetési
     útmutató (MBH-s számla + NJE-WS közlemény), rendeléseim, letöltés.

   KEZELŐI OLDAL — SHOP_AdminView (SUPERADMIN, ADMIN, FINANCE)
     Rendelések (jóváhagyás, fizetés rögzítése, státusz, számlaszám,
     visszatérítés, napló), termékek, kategóriák, beállítások.

   AMI SZÁNDÉKOSAN A SZERVEREN VAN
     Az ár, a készlet, a jóváhagyás és a „fizetett” állapot. A kosár csak
     termékazonosítót és mennyiséget küld; minden összeget a szerver számol.
     Online (kártyás / qvik) fizetést böngészőből nem lehet sem bekapcsolni,
     sem visszaigazolni — ahhoz szolgáltatói szerződés és szerveroldali
     visszaigazolás kell (lásd a migráció fejlécét).
   ============================================================ */

const SHOP_rpc = async (nev, args) => {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const { data, error } = await window.sb.rpc(nev, args || {});
  if (error) throw error;
  return data;
};
const SHOP_nincsMigracio = (e) => {
  const m = ((e && e.message) || '') + ((e && e.code) || '');
  return /shop_catalog|shop_admin|schema cache|PGRST202/i.test(m);
};
const SHOP_HIBAK = [
  [/SHOP_NO_BANK_DETAILS/, 'A banki átutaláshoz még nincs megadva az egyetem számlaszáma. Szólj a Pénzügynek.'],
  [/SHOP_PAYMENT_METHOD_OFF/, 'Ez a fizetési mód még nincs bekapcsolva.'],
  [/SHOP_PAYMENT_SETUP/, 'Az online fizetést a szolgáltatói bekötés kapcsolja be, nem ez a kapcsoló.'],
  [/SHOP_OUT_OF_STOCK: (.+)/, 'Elfogyott: $1.'],
  [/SHOP_LIMIT: (.+?) — legfeljebb (\d+) db rendelheto\./, '$1: rendelésenként legfeljebb $2 db.'],
  [/SHOP_FIELD_REQUIRED: (.+)/, 'Hiányzó adat: $1.'],
  [/SHOP_FIELD_INVALID: (.+)/, 'Érvénytelen adat: $1.'],
  [/SHOP_PRODUCT_UNAVAILABLE/, 'Egy termék már nem érhető el. Frissítsd a kosarat.'],
  [/SHOP_EMPTY_CART/, 'A kosár üres.'],
  [/SHOP_BAD_STATE: (.+)/, 'Ebben az állapotban ez nem lehetséges ($1).'],
  [/SHOP_BAD_TRANSITION: (.+)/, 'Ez az állapotváltás nem megengedett ($1).'],
  [/SHOP_NOT_DOWNLOADABLE/, 'Ez a tétel még nem tölthető le.'],
  [/SHOP_FORBIDDEN: (.+)/, '$1'],
  [/SHOP_FORBIDDEN/, 'Ehhez nincs jogosultságod.'],
  [/SHOP_NOT_FOUND/, 'A rendelés nem található.'],
];
const SHOP_msg = (e) => {
  const m = (e && e.message) || '';
  for (const [re, szoveg] of SHOP_HIBAK) {
    const t = m.match(re);
    if (t) return szoveg.replace(/\$(\d)/g, (_, i) => t[Number(i)] || '');
  }
  return m || 'Ismeretlen hiba.';
};
const SHOP_ft = (n) => (Math.round(Number(n) || 0)).toLocaleString('hu-HU').replace(/ /g, ' ') + ' Ft';
const SHOP_datum = (d) => { try { return d ? new Date(d).toLocaleDateString('hu-HU') : '—'; } catch (e) { return '—'; } };
const SHOP_ido = (d) => { try { return d ? new Date(d).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' }) : '—'; } catch (e) { return '—'; } };

const SHOP_ALLAPOT = {
  jovahagyasra_var: ['Jóváhagyásra vár', 'amber'],
  fizetesre_var:    ['Fizetésre vár', 'blue'],
  fizetve:          ['Fizetve', 'green'],
  teljesitve:       ['Teljesítve', 'green'],
  lemondva:         ['Lemondva', 'slate'],
  elutasitva:       ['Elutasítva', 'red'],
  visszaterites:    ['Visszatérítés alatt', 'violet'],
  visszateritve:    ['Visszatérítve', 'slate'],
};
const SHOP_FIZMOD = { atutalas: 'banki átutalás', kartya: 'bankkártya', qvik: 'qvik', kezi: 'kézi / ingyenes' };
const SHOP_TIPUS = {
  fizikai:       ['Termék', 'Package'],
  digitalis:     ['Digitális jegyzet', 'FileDown'],
  parkolokartya: ['Parkolókártya', 'Car'],
  szolgaltatas:  ['Szolgáltatás', 'Sparkles'],
};
const SHOP_Ikon = ({ tipus, size }) => {
  const I = Lucide[(SHOP_TIPUS[tipus] || SHOP_TIPUS.fizikai)[1]] || Lucide.Package;
  return <I size={size || 18} />;
};
const SHOP_Allapot = ({ a }) => {
  const [c, t] = SHOP_ALLAPOT[a] || [a, 'slate'];
  return <span data-shop-allapot={a}><UBadge tone={t}>{c}</UBadge></span>;
};

/* A bankkivonat közlemény rovatából kiolvassa a rendelés azonosítóját
   (NJE-WS-00012-cc), az ellenőrző számmal együtt. */
const SHOP_ellenorzo = (n) => String(98 - ((Number(n) * 100) % 97)).padStart(2, '0');
const SHOP_felismer = (szoveg) => {
  const m = String(szoveg || '').toUpperCase().match(/NJE[\s\-_.\/]*WS[\s\-_.\/]*(\d{5,})[\s\-_.\/]*(\d{2})(?!\d)/);
  if (!m) return null;
  const n = Number(m[1]);
  return { refNo: n, ervenyes: n > 0 && SHOP_ellenorzo(n) === m[2], rendelesszam: 'WS-' + String(n).padStart(5, '0') };
};

/* A kosár a böngészőfülhöz és a FELHASZNÁLÓHOZ kötött (sessionStorage,
   felhasználónkénti kulccsal) — közös gépen a következő hallgató ne örökölje. */
const SHOP_kosarKulcs = (uid) => 'shop_kosar:' + (uid || 'anon');
const SHOP_kosarBetolt = (uid) => { try { const v = JSON.parse(sessionStorage.getItem(SHOP_kosarKulcs(uid)) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
const SHOP_kosarMent = (uid, k) => { try { sessionStorage.setItem(SHOP_kosarKulcs(uid), JSON.stringify(k)); } catch (e) {} };

/* ------------------------------------------------------------------ */
/* Fizetési útmutató — a rendelés után és a „Rendeléseim” alatt is      */
/* ------------------------------------------------------------------ */
function SHOP_FizetesiUtmutato({ rendeles, fizetes }) {
  const [masolva, setMasolva] = useState('');
  if (!rendeles) return null;
  if (rendeles.allapot === 'jovahagyasra_var') {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[12px] text-amber-900 font-medium leading-relaxed" data-shop-jovahagyas-info="1">
        A rendelésed egy tétele jóváhagyáshoz kötött (pl. parkolókártya). Amint az ügyintéző döntött,
        itt megjelenik a fizetési lehetőség. Addig nem kell fizetned.
      </div>
    );
  }
  if (rendeles.allapot !== 'fizetesre_var') return null;
  const b = (fizetes && fizetes.bank) || {};
  const masol = async (mit, szoveg) => {
    if (typeof FIZ_masol === 'function' && await FIZ_masol(szoveg)) { setMasolva(mit); setTimeout(() => setMasolva(''), 1600); }
  };
  if (rendeles.fizetesi_mod !== 'atutalas') {
    return (
      <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-[12px] text-blue-900 font-medium">
        A fizetés az online fizetési oldalon történik. Ha megszakadt, próbáld újra, vagy válassz banki átutalást.
      </div>
    );
  }
  const sor = (cimke, ertek, kulcs) => (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-amber-100 last:border-0">
      <span className="text-[11px] font-bold text-amber-700">{cimke}</span>
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-[13px] font-black text-slate-900 font-mono break-all text-right">{ertek || '—'}</span>
        {ertek && kulcs && (
          <button type="button" onClick={() => masol(kulcs, ertek)} className="text-amber-700 hover:text-amber-900 flex-none" title="Másolás">
            {masolva === kulcs ? <Lucide.Check size={13} /> : <Lucide.Copy size={13} />}
          </button>
        )}
      </span>
    </div>
  );
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4" data-shop-fizetes={rendeles.fizetesi_kozlemeny}>
      <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2">Fizetés banki átutalással</p>
      {sor('Kedvezményezett', b.kedvezmenyezett, 'k')}
      {sor('Bank', b.bank, null)}
      {sor('Számlaszám', b.szamlaszam, 'sz')}
      {b.iban && sor('IBAN', b.iban, 'i')}
      {sor('Összeg', SHOP_ft(rendeles.osszeg_huf), null)}
      {sor('Közlemény', rendeles.fizetesi_kozlemeny, 'kz')}
      {sor('Határidő', SHOP_datum(rendeles.fizetesi_hatarido), null)}
      <p className="text-[11px] text-amber-800 mt-2 leading-relaxed">
        A közleményt pontosan így írd be — ebből tudjuk a befizetést a rendelésedhez rendelni.
        A határidő után a rendelés automatikusan lemondásra kerülhet.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* HALLGATÓI NÉZET                                                     */
/* ------------------------------------------------------------------ */
function SHOP_TermekModal({ termek, onClose, onKosarba }) {
  const [adatok, setAdatok] = useState({});
  const [menny, setMenny] = useState(1);
  const [hiba, setHiba] = useState('');
  useEffect(() => { setAdatok({}); setMenny(1); setHiba(''); }, [termek && termek.id]);
  if (!termek) return null;
  const mezok = Array.isArray(termek.mezok) ? termek.mezok : [];
  const max = Math.min(termek.max_rendelesenkent || 99, termek.keszlet == null ? 99 : termek.keszlet);
  const kosarba = () => {
    const hianyzik = mezok.find(m => m.kotelezo && !String(adatok[m.kulcs] || '').trim());
    if (hianyzik) { setHiba('Hiányzó adat: ' + (hianyzik.cimke || hianyzik.kulcs) + '.'); return; }
    onKosarba({ product_id: termek.id, mennyiseg: menny, adatok });
  };
  return (
    <UModal open={!!termek} onClose={onClose} max="max-w-xl" title={termek.nev}
      subtitle={(SHOP_TIPUS[termek.tipus] || SHOP_TIPUS.fizikai)[0] + ' · ' + SHOP_ft(termek.ar_huf)} icon={<SHOP_Ikon tipus={termek.tipus} size={20} />}>
      <div className="space-y-4" data-shop-termek-modal={termek.id}>
        {termek.kep_url && typeof FEED_img === 'function' && (
          <div className="aspect-[16/9] rounded-2xl overflow-hidden bg-slate-100">{FEED_img(termek.kep_url, 'w-full h-full object-cover')}</div>
        )}
        {termek.leiras && <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-line">{termek.leiras}</p>}
        {termek.jovahagyas_kell && (
          <p className="text-[12px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
            Ez a tétel jóváhagyáshoz kötött: fizetni csak az ügyintéző jóváhagyása után kell.
          </p>
        )}
        {mezok.map(m => (
          <UField key={m.kulcs} label={(m.cimke || m.kulcs) + (m.kotelezo ? ' *' : '')}>
            <input className={U_input} value={adatok[m.kulcs] || ''} data-shop-mezo={m.kulcs}
              type={m.tipus === 'datum' ? 'date' : 'text'}
              placeholder={m.tipus === 'rendszam' ? 'pl. ABC-123' : ''}
              onChange={e => setAdatok(p => ({ ...p, [m.kulcs]: e.target.value }))} />
          </UField>
        ))}
        {max > 1 && (
          <UField label="Mennyiség">
            <input type="number" min="1" max={max} className={U_input + ' w-28'} value={menny}
              onChange={e => setMenny(Math.max(1, Math.min(max, Number(e.target.value) || 1)))} />
          </UField>
        )}
        {hiba && <p className="text-[12px] font-bold text-red-600" role="alert">{hiba}</p>}
        <div className="flex justify-end gap-2">
          <button className={U_btnGhost} onClick={onClose}>Mégse</button>
          <button className={U_btnPrimary} onClick={kosarba} disabled={termek.elfogyott} data-shop-kosarba-gomb="1">
            <Lucide.ShoppingCart size={16} /> Kosárba
          </button>
        </div>
      </div>
    </UModal>
  );
}

function SHOP_Penztar({ open, onClose, kosar, termekMap, fizetes, user, onKesz }) {
  const [mod, setMod] = useState('atutalas');
  const [szaml, setSzaml] = useState({ nev: '', cim: '', adoszam: '' });
  const [megj, setMegj] = useState('');
  const [busy, setBusy] = useState(false);
  const [hiba, setHiba] = useState('');
  useEffect(() => {
    if (!open) return;
    setHiba(''); setMegj('');
    setSzaml(p => ({ ...p, nev: p.nev || (user && user.name) || '' }));
    const bankVan = !!(fizetes && fizetes.bank && (fizetes.bank.szamlaszam || fizetes.bank.iban));
    setMod(bankVan ? 'atutalas' : (fizetes && fizetes.kartya ? 'kartya' : 'atutalas'));
  }, [open]);
  const bankVan = !!(fizetes && fizetes.bank && (fizetes.bank.szamlaszam || fizetes.bank.iban));
  const osszeg = kosar.reduce((s, t) => s + ((termekMap[t.product_id] || {}).ar_huf || 0) * t.mennyiseg, 0);
  const leadas = async () => {
    if (!szaml.nev.trim()) { setHiba('A számlázási név kötelező.'); return; }
    setBusy(true); setHiba('');
    try {
      const r = await SHOP_rpc('shop_order_create', {
        p_items: kosar.map(t => ({ product_id: t.product_id, mennyiseg: t.mennyiseg, adatok: t.adatok || {} })),
        p_szamlazas: { nev: szaml.nev.trim(), cim: szaml.cim.trim() || null, adoszam: szaml.adoszam.trim() || null },
        p_fizetesi_mod: mod, p_megjegyzes: megj || null });
      onKesz(r);
    } catch (e) { setHiba(SHOP_msg(e)); }
    finally { setBusy(false); }
  };
  const modok = [
    ['atutalas', 'Banki átutalás', 'Az MBH-s számlánkra, közleménnyel.', bankVan, bankVan ? '' : 'a számlaszám még nincs megadva'],
    ['kartya', 'Bankkártya', 'Online fizetési oldalon.', !!(fizetes && fizetes.kartya), 'hamarosan'],
    ['qvik', 'qvik (azonnali fizetés)', 'QR-kóddal vagy linkkel a mobilbankból.', !!(fizetes && fizetes.qvik), 'hamarosan'],
  ];
  return (
    <UModal open={open} onClose={onClose} max="max-w-2xl" title="Rendelés leadása" subtitle={'Fizetendő: ' + SHOP_ft(osszeg) + ' (a végleges összeget a szerver számolja)'}
      icon={<Lucide.CreditCard size={20} />}>
      <div className="space-y-5" data-shop-penztar="1">
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Számlázási adatok</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <UField label="Név *"><input className={U_input} value={szaml.nev} onChange={e => setSzaml(p => ({ ...p, nev: e.target.value }))} /></UField>
            <UField label="Adószám (cégnek)"><input className={U_input} value={szaml.adoszam} onChange={e => setSzaml(p => ({ ...p, adoszam: e.target.value }))} /></UField>
          </div>
          <UField label="Cím"><input className={U_input} value={szaml.cim} placeholder="irányítószám, település, utca, házszám" onChange={e => setSzaml(p => ({ ...p, cim: e.target.value }))} /></UField>
        </div>
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Fizetési mód</p>
          <div className="grid gap-2">
            {modok.map(([k, cimke, leiras, elerheto, miert]) => (
              <button key={k} type="button" disabled={!elerheto} onClick={() => setMod(k)} data-shop-fizmod={k}
                className={'flex items-center justify-between gap-3 text-left rounded-2xl border px-4 py-3 transition-all disabled:opacity-50 disabled:cursor-not-allowed '
                  + (mod === k && elerheto ? 'border-primary bg-primary/5' : 'border-slate-100 hover:border-slate-200')}>
                <span>
                  <span className="block text-sm font-black text-slate-800">{cimke}</span>
                  <span className="block text-[11px] text-slate-400 font-medium">{leiras}</span>
                </span>
                {!elerheto && <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{miert}</span>}
              </button>
            ))}
          </div>
        </div>
        <UField label="Megjegyzés a rendeléshez"><input className={U_input} value={megj} onChange={e => setMegj(e.target.value)} /></UField>
        {hiba && <p className="text-[12px] font-bold text-red-600" role="alert" data-shop-hiba="1">{hiba}</p>}
        <div className="flex justify-end gap-2">
          <button className={U_btnGhost} onClick={onClose}>Vissza a kosárhoz</button>
          <button className={U_btnPrimary} onClick={leadas} disabled={busy || kosar.length === 0} data-shop-leadas="1">
            {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.Check size={16} />} Rendelés leadása
          </button>
        </div>
      </div>
    </UModal>
  );
}

function SHOP_RendelesKartya({ r, fizetes, onFrissit }) {
  const [busy, setBusy] = useState(false);
  const [hiba, setHiba] = useState('');
  const lemond = async () => {
    if (!window.confirm('Lemondod a(z) ' + r.rendelesszam + ' rendelést?')) return;
    setBusy(true); setHiba('');
    try { await SHOP_rpc('shop_order_cancel', { p_order: r.id }); onFrissit(); }
    catch (e) { setHiba(SHOP_msg(e)); } finally { setBusy(false); }
  };
  const letolt = async (tetel) => {
    setHiba('');
    try {
      const ut = await SHOP_rpc('shop_download_path', { p_item: tetel.id });
      const { data, error } = await window.sb.storage.from('shop-files').createSignedUrl(ut, 120);
      if (error || !data) throw error || new Error('A letöltési link nem készült el.');
      window.open(data.signedUrl, '_blank', 'noopener');
    } catch (e) { setHiba(SHOP_msg(e)); }
  };
  return (
    <div className="bg-white rounded-3xl border border-slate-100 p-5 space-y-3" data-shop-rendeles={r.rendelesszam}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[13px] font-black text-slate-900">{r.rendelesszam}</p>
          <p className="text-[11px] font-bold text-slate-400">{SHOP_ido(r.created_at)} · {SHOP_ft(r.osszeg_huf)}</p>
        </div>
        <SHOP_Allapot a={r.allapot} />
      </div>
      <div className="space-y-1.5">
        {(r.tetelek || []).map(t => (
          <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-50 bg-slate-50/60 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-bold text-slate-700 truncate">{t.mennyiseg > 1 ? t.mennyiseg + ' × ' : ''}{t.nev}</p>
              {t.adatok && Object.keys(t.adatok).length > 0 && (
                <p className="text-[11px] text-slate-400 font-mono">{Object.entries(t.adatok).map(([k, v]) => k + ': ' + v).join(' · ')}</p>
              )}
              {t.jovahagyas === 'var' && <p className="text-[11px] font-bold text-amber-700">jóváhagyásra vár</p>}
              {t.jovahagyas === 'jovahagyva' && <p className="text-[11px] font-bold text-emerald-700">jóváhagyva</p>}
              {t.jovahagyas === 'elutasitva' && <p className="text-[11px] font-bold text-red-600">elutasítva{t.indoklas ? ': ' + t.indoklas : ''}</p>}
            </div>
            <div className="flex items-center gap-2 flex-none">
              <span className="text-[12px] font-black text-slate-600 tabular-nums">{SHOP_ft(t.egysegar_huf * t.mennyiseg)}</span>
              {t.letoltheto && (
                <button onClick={() => letolt(t)} className={U_btnGhost + ' py-1.5 px-3 text-[12px]'} data-shop-letoltes={t.id}>
                  <Lucide.Download size={14} /> Letöltés
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <SHOP_FizetesiUtmutato rendeles={r} fizetes={fizetes} />
      {r.szamla_szam && (
        <p className="text-[12px] font-bold text-slate-600">
          Számla: {r.szamla_url ? <a href={r.szamla_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{r.szamla_szam}</a> : r.szamla_szam}
        </p>
      )}
      {hiba && <p className="text-[12px] font-bold text-red-600">{hiba}</p>}
      {['jovahagyasra_var', 'fizetesre_var'].includes(r.allapot) && (
        <div className="flex justify-end">
          <button onClick={lemond} disabled={busy} className="text-[12px] font-bold text-slate-400 hover:text-red-600">Rendelés lemondása</button>
        </div>
      )}
    </div>
  );
}

function SHOP_StudentView({ user }) {
  const uid = user && user.id;
  const [kat, setKat] = useState(null);
  const [rendelesek, setRendelesek] = useState([]);
  const [ful, setFul] = useState('termekek');
  const [szuro, setSzuro] = useState('');
  const [q, setQ] = useState('');
  const [kosar, setKosar] = useState(() => SHOP_kosarBetolt(uid));
  const [nyitott, setNyitott] = useState(null);
  const [penztar, setPenztar] = useState(false);
  const [kesz, setKesz] = useState(null);
  const [err, setErr] = useState('');
  const [nincs, setNincs] = useState(false);

  const tolts = React.useCallback(() => {
    SHOP_rpc('shop_catalog').then(d => { setKat(d); setErr(''); })
      .catch(e => { setKat({ termekek: [], kategoriak: [] }); if (SHOP_nincsMigracio(e)) setNincs(true); else setErr(SHOP_msg(e)); });
    SHOP_rpc('shop_my_orders').then(d => setRendelesek(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);
  useEffect(() => { tolts(); }, [tolts]);
  useEffect(() => { SHOP_kosarMent(uid, kosar); }, [uid, kosar]);

  const termekMap = React.useMemo(() => {
    const m = {}; ((kat && kat.termekek) || []).forEach(t => { m[t.id] = t; }); return m;
  }, [kat]);
  // A kosárból kiesik, ami közben eltűnt a katalógusból (inaktív lett, elfogyott a láthatóság).
  useEffect(() => {
    if (!kat) return;
    setKosar(k => k.filter(t => termekMap[t.product_id]));
  }, [kat]);

  if (nincs) {
    return <div className="p-8 max-w-3xl mx-auto"><UEmpty icon={<Lucide.ShoppingBag size={26} />} title="A webshop még nincs telepítve"
      subtitle="Futtatni kell a supabase/74_webshop.sql migrációt." /></div>;
  }

  const termekek = ((kat && kat.termekek) || []).filter(t =>
    (!szuro || t.category_id === szuro) &&
    (!q.trim() || (t.nev + ' ' + (t.leiras || '')).toLowerCase().includes(q.trim().toLowerCase())));
  const kosarDb = kosar.reduce((s, t) => s + t.mennyiseg, 0);
  const kosarOssz = kosar.reduce((s, t) => s + ((termekMap[t.product_id] || {}).ar_huf || 0) * t.mennyiseg, 0);
  const kosarba = (tetel) => {
    setKosar(k => {
      const t = termekMap[tetel.product_id];
      const vanMezo = t && Array.isArray(t.mezok) && t.mezok.length > 0;
      // Adatos tétel (pl. rendszám) mindig külön sor; a többi összevonódik.
      if (!vanMezo) {
        const i = k.findIndex(x => x.product_id === tetel.product_id);
        if (i >= 0) {
          const max = Math.min(t.max_rendelesenkent || 99, t.keszlet == null ? 99 : t.keszlet);
          return k.map((x, j) => j === i ? { ...x, mennyiseg: Math.min(max, x.mennyiseg + tetel.mennyiseg) } : x);
        }
      }
      return k.concat([{ ...tetel, kulcs: Date.now() + '-' + Math.random().toString(36).slice(2, 6) }]);
    });
    setNyitott(null);
  };
  const nyitottak = rendelesek.filter(r => ['jovahagyasra_var', 'fizetesre_var'].includes(r.allapot)).length;

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto animate-in fade-in duration-300" data-shop-hallgato="1">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">Webshop</p>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Egyetemi bolt</h1>
          <p className="text-slate-400 mt-1 font-medium text-sm">Jegyzetek, parkolókártya, egyetemi termékek — fizetés az egyetem MBH-s számlájára.</p>
        </div>
        <div className="flex gap-2">
          {[['termekek', 'Termékek', Lucide.Store], ['rendelesek', 'Rendeléseim' + (nyitottak ? ' (' + nyitottak + ')' : ''), Lucide.Receipt]].map(([k, c, I]) => (
            <button key={k} onClick={() => setFul(k)} data-shop-ful={k}
              className={'inline-flex items-center gap-2 px-4 py-2 rounded-2xl border text-[13px] font-bold transition-all '
                + (ful === k ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 bg-white text-slate-500 hover:border-slate-300')}>
              <I size={15} /> {c}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 mb-4">{err}</div>}

      {kesz && (
        <div className="bg-white rounded-3xl border border-emerald-200 p-5 mb-6 space-y-3" data-shop-kesz={kesz.rendelesszam}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Rendelés leadva</p>
              <p className="text-lg font-black text-slate-900">{kesz.rendelesszam} · {SHOP_ft(kesz.osszeg_huf)}</p>
            </div>
            <button onClick={() => setKesz(null)} className="text-slate-300 hover:text-slate-500"><Lucide.X size={18} /></button>
          </div>
          <SHOP_FizetesiUtmutato rendeles={kesz} fizetes={kat && kat.fizetes} />
        </div>
      )}

      {ful === 'termekek' ? (
        <div className="grid lg:grid-cols-[1fr,320px] gap-6">
          <div>
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="relative flex-1">
                <Lucide.Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
                <input className={U_input + ' pl-11'} value={q} onChange={e => setQ(e.target.value)} placeholder="Keresés a termékek között…" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mb-4">
              {[['', 'Összes']].concat(((kat && kat.kategoriak) || []).map(c => [c.id, c.nev])).map(([id, nev]) => (
                <button key={id || 'mind'} onClick={() => setSzuro(id)}
                  className={'px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-all ' + (szuro === id ? 'bg-slate-900 text-white' : 'bg-white border border-slate-100 text-slate-500 hover:border-slate-300')}>
                  {nev}
                </button>
              ))}
            </div>
            {kat === null ? <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">{[0, 1, 2].map(i => <SkeletonBar key={i} h={200} />)}</div>
              : termekek.length === 0 ? <div className="bg-white rounded-3xl border border-slate-100"><UEmpty icon={<Lucide.PackageSearch size={26} />} title="Nincs ilyen termék" subtitle="Válassz másik kategóriát, vagy keress másra." /></div>
              : (
              <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {termekek.map(t => (
                  <button key={t.id} onClick={() => setNyitott(t)} disabled={t.elfogyott} data-shop-termek={t.id}
                    className="text-left bg-white rounded-3xl border border-slate-100 overflow-hidden hover:border-slate-200 hover:shadow-sm transition-all disabled:opacity-60">
                    <div className="aspect-[4/3] bg-slate-50 flex items-center justify-center text-slate-300 overflow-hidden">
                      {t.kep_url && typeof FEED_img === 'function' ? FEED_img(t.kep_url, 'w-full h-full object-cover') : <SHOP_Ikon tipus={t.tipus} size={40} />}
                    </div>
                    <div className="p-4">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{(SHOP_TIPUS[t.tipus] || SHOP_TIPUS.fizikai)[0]}</p>
                      <p className="text-[15px] font-black text-slate-900 leading-snug mt-0.5">{t.nev}</p>
                      <div className="flex items-center justify-between gap-2 mt-3">
                        <span className="text-lg font-black text-slate-900 tabular-nums">{SHOP_ft(t.ar_huf)}</span>
                        {t.elfogyott ? <UBadge tone="slate">elfogyott</UBadge>
                          : t.jovahagyas_kell ? <UBadge tone="amber">jóváhagyással</UBadge>
                          : t.keszlet != null && t.keszlet <= 5 ? <UBadge tone="red">{'még ' + t.keszlet + ' db'}</UBadge> : null}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* kosár */}
          <div className="lg:sticky lg:top-24 self-start bg-white rounded-3xl border border-slate-100 p-5" data-shop-kosar="1">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-black text-slate-800 flex items-center gap-2"><Lucide.ShoppingCart size={16} /> Kosár</p>
              <span className="text-[11px] font-bold text-slate-400">{kosarDb} tétel</span>
            </div>
            {kosar.length === 0 ? <p className="text-[12px] text-slate-300 font-bold italic py-4">A kosár üres.</p> : (
              <div className="space-y-2">
                {kosar.map(k => {
                  const t = termekMap[k.product_id] || {};
                  return (
                    <div key={k.kulcs || k.product_id} className="flex items-start justify-between gap-2 border-b border-slate-50 pb-2">
                      <div className="min-w-0">
                        <p className="text-[12px] font-bold text-slate-700 truncate">{k.mennyiseg > 1 ? k.mennyiseg + ' × ' : ''}{t.nev}</p>
                        {k.adatok && Object.keys(k.adatok).length > 0 && (
                          <p className="text-[10px] text-slate-400 font-mono truncate">{Object.values(k.adatok).join(' · ')}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-none">
                        <span className="text-[12px] font-black text-slate-600 tabular-nums">{SHOP_ft((t.ar_huf || 0) * k.mennyiseg)}</span>
                        <button onClick={() => setKosar(x => x.filter(y => y !== k))} className="text-slate-300 hover:text-red-500" title="Törlés"><Lucide.X size={14} /></button>
                      </div>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[12px] font-bold text-slate-500">Összesen</span>
                  <span className="text-lg font-black text-slate-900 tabular-nums" data-shop-kosar-ossz="1">{SHOP_ft(kosarOssz)}</span>
                </div>
                <button onClick={() => setPenztar(true)} className={U_btnPrimary + ' w-full'} data-shop-penztar-gomb="1">
                  Tovább a rendeléshez <Lucide.ArrowRight size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 max-w-3xl">
          {rendelesek.length === 0 ? <div className="bg-white rounded-3xl border border-slate-100"><UEmpty icon={<Lucide.Receipt size={26} />} title="Még nincs rendelésed" /></div>
            : rendelesek.map(r => <SHOP_RendelesKartya key={r.id} r={r} fizetes={kat && kat.fizetes} onFrissit={tolts} />)}
        </div>
      )}

      <SHOP_TermekModal termek={nyitott} onClose={() => setNyitott(null)} onKosarba={kosarba} />
      <SHOP_Penztar open={penztar} onClose={() => setPenztar(false)} kosar={kosar} termekMap={termekMap}
        fizetes={kat && kat.fizetes} user={user}
        onKesz={(r) => { setPenztar(false); setKosar([]); setKesz(r); setFul('termekek'); tolts(); }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KEZELŐI NÉZET                                                       */
/* ------------------------------------------------------------------ */
function SHOP_RendelesReszlet({ id, onClose, onValtozott }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [hivatkozas, setHivatkozas] = useState('');
  const [indok, setIndok] = useState({});
  const [szamla, setSzamla] = useState({ szam: '', url: '' });
  const [megj, setMegj] = useState('');
  const [statuszMegj, setStatuszMegj] = useState('');

  useEffect(() => {
    if (!id) { setR(null); return; }
    let el = true; setErr(''); setOk('');
    SHOP_rpc('shop_order_get', { p_order: id })
      .then(d => { if (!el) return; setR(d); setSzamla({ szam: d.szamla_szam || '', url: d.szamla_url || '' }); setMegj(d.megjegyzes || ''); })
      .catch(e => { if (el) setErr(SHOP_msg(e)); });
    return () => { el = false; };
  }, [id]);

  const muvelet = async (fn, siker) => {
    setBusy(true); setErr(''); setOk('');
    try { const d = await fn(); setR(d); setOk(siker); onValtozott && onValtozott(); }
    catch (e) { setErr(SHOP_msg(e)); } finally { setBusy(false); }
  };

  return (
    <UModal open={!!id} onClose={onClose} max="max-w-3xl" icon={<Lucide.Receipt size={20} />}
      title={r ? r.rendelesszam : 'Rendelés'} subtitle={r ? (r.vevo_nev + ' · ' + r.vevo_email) : ''}>
      {!r ? (err ? <p className="text-sm font-bold text-red-600">{err}</p> : <SkeletonBar h={160} />) : (
        <div className="space-y-5" data-shop-reszlet={r.rendelesszam}>
          <div className="flex flex-wrap items-center gap-3">
            <SHOP_Allapot a={r.allapot} />
            <span className="text-lg font-black text-slate-900 tabular-nums">{SHOP_ft(r.osszeg_huf)}</span>
            <span className="text-[11px] font-bold text-slate-400">{SHOP_FIZMOD[r.fizetesi_mod] || r.fizetesi_mod} · {r.fizetesi_kozlemeny}</span>
            <span className="text-[11px] font-bold text-slate-400">leadva {SHOP_ido(r.created_at)}</span>
          </div>
          {err && <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-2.5 text-[13px] font-bold text-red-600">{err}</div>}
          {ok && <div className="bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-2.5 text-[13px] font-bold text-emerald-700">{ok}</div>}

          <div className="grid sm:grid-cols-2 gap-3 text-[12px]">
            <div className="rounded-2xl border border-slate-100 p-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Számlázási adatok</p>
              <p className="font-bold text-slate-700">{(r.szamlazasi_adatok || {}).nev || '—'}</p>
              <p className="text-slate-500">{(r.szamlazasi_adatok || {}).cim || ''}</p>
              {(r.szamlazasi_adatok || {}).adoszam && <p className="text-slate-500">Adószám: {r.szamlazasi_adatok.adoszam}</p>}
            </div>
            <div className="rounded-2xl border border-slate-100 p-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Fizetés</p>
              <p className="text-slate-600">Határidő: <b>{SHOP_datum(r.fizetesi_hatarido)}</b></p>
              <p className="text-slate-600">Fizetve: <b>{SHOP_ido(r.fizetve_at)}</b></p>
              {r.kulso_azonosito && <p className="text-slate-600">Hivatkozás: <b>{r.kulso_azonosito}</b></p>}
              {r.vevo_megjegyzes && <p className="text-slate-600 mt-1">Vevő megjegyzése: {r.vevo_megjegyzes}</p>}
            </div>
          </div>

          {/* tételek + jóváhagyás */}
          <div className="space-y-2">
            {(r.tetelek || []).map(t => (
              <div key={t.id} className="rounded-2xl border border-slate-100 p-3" data-shop-tetel={t.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-black text-slate-800">{t.mennyiseg > 1 ? t.mennyiseg + ' × ' : ''}{t.nev}</p>
                    <p className="text-[11px] text-slate-400">{(SHOP_TIPUS[t.tipus] || [t.tipus])[0]} · ÁFA {t.afa_kulcs}{/^\d+$/.test(t.afa_kulcs) ? '%' : ''}</p>
                    {t.adatok && Object.keys(t.adatok).length > 0 && (
                      <p className="text-[12px] font-mono font-bold text-slate-600 mt-1">{Object.entries(t.adatok).map(([k, v]) => k + ': ' + v).join(' · ')}</p>
                    )}
                    {t.jovahagyas && t.jovahagyas !== 'var' && (
                      <p className={'text-[11px] font-bold mt-1 ' + (t.jovahagyas === 'jovahagyva' ? 'text-emerald-700' : 'text-red-600')}>
                        {t.jovahagyas === 'jovahagyva' ? 'jóváhagyva' : 'elutasítva'}{t.dontes_at ? ' ' + SHOP_ido(t.dontes_at) : ''}{t.indoklas ? ' — ' + t.indoklas : ''}
                      </p>
                    )}
                  </div>
                  <span className="text-[13px] font-black text-slate-700 tabular-nums flex-none">{SHOP_ft(t.egysegar_huf * t.mennyiseg)}</span>
                </div>
                {t.jovahagyas === 'var' && r.allapot === 'jovahagyasra_var' && (
                  <div className="flex flex-col sm:flex-row gap-2 mt-3">
                    <input className={U_input + ' py-2 text-[12px] flex-1'} placeholder="Indoklás (elutasításnál kötelező, a vevő látja)"
                      value={indok[t.id] || ''} onChange={e => setIndok(p => ({ ...p, [t.id]: e.target.value }))} />
                    <button disabled={busy} data-shop-jovahagy={t.id}
                      onClick={() => muvelet(() => SHOP_rpc('shop_item_decide', { p_item: t.id, p_dontes: 'jovahagyva', p_indoklas: indok[t.id] || null }), 'Tétel jóváhagyva.')}
                      className={U_btn + ' bg-emerald-600 text-white hover:bg-emerald-700 py-2 px-3 text-[12px]'}><Lucide.Check size={14} /> Jóváhagyás</button>
                    <button disabled={busy} data-shop-elutasit={t.id}
                      onClick={() => muvelet(() => SHOP_rpc('shop_item_decide', { p_item: t.id, p_dontes: 'elutasitva', p_indoklas: indok[t.id] || null }), 'Tétel elutasítva.')}
                      className={U_btn + ' bg-red-500 text-white hover:bg-red-600 py-2 px-3 text-[12px]'}><Lucide.X size={14} /> Elutasítás</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* fizetés rögzítése */}
          {r.allapot === 'fizetesre_var' && (
            <div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4 space-y-2" data-shop-fizetes-rogzites="1">
              <p className="text-[12px] font-black text-slate-800">Befizetés rögzítése</p>
              <p className="text-[11px] text-slate-500">Az MBH-s kivonat alapján: a közlemény <b className="font-mono">{r.fizetesi_kozlemeny}</b>, az összeg <b>{SHOP_ft(r.osszeg_huf)}</b>.</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input className={U_input + ' py-2 text-[12px] flex-1'} value={hivatkozas} onChange={e => setHivatkozas(e.target.value)} placeholder="Banki hivatkozás / kivonat tétel (ajánlott)" />
                <button disabled={busy} className={U_btnPrimary + ' py-2 text-[12px]'} data-shop-fizetve-gomb="1"
                  onClick={() => muvelet(() => SHOP_rpc('shop_order_mark_paid', { p_order: r.id, p_kulso_azonosito: hivatkozas || null, p_megjegyzes: null }), 'Befizetés rögzítve.')}>
                  <Lucide.BadgeCheck size={14} /> Fizetettnek jelölöm
                </button>
              </div>
            </div>
          )}

          {/* státusz */}
          {['fizetve', 'teljesitve', 'visszaterites'].includes(r.allapot) && (
            <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
              <p className="text-[12px] font-black text-slate-800">Teljesítés és visszatérítés</p>
              <input className={U_input + ' py-2 text-[12px]'} value={statuszMegj} onChange={e => setStatuszMegj(e.target.value)}
                placeholder="Megjegyzés (visszatérítésnél kötelező: ok / banki hivatkozás)" />
              <div className="flex flex-wrap gap-2">
                {r.allapot === 'fizetve' && (
                  <button disabled={busy} className={U_btnPrimary + ' py-2 text-[12px]'} data-shop-teljesitve="1"
                    onClick={() => muvelet(() => SHOP_rpc('shop_order_set_status', { p_order: r.id, p_allapot: 'teljesitve', p_megjegyzes: statuszMegj || null }), 'Teljesítettnek jelölve.')}>
                    <Lucide.PackageCheck size={14} /> Átadva / teljesítve
                  </button>
                )}
                {['fizetve', 'teljesitve'].includes(r.allapot) && (
                  <button disabled={busy} className={U_btnGhost + ' py-2 text-[12px]'}
                    onClick={() => muvelet(() => SHOP_rpc('shop_order_set_status', { p_order: r.id, p_allapot: 'visszaterites', p_megjegyzes: statuszMegj || null }), 'Visszatérítés elindítva.')}>
                    <Lucide.Undo2 size={14} /> Visszatérítés indítása
                  </button>
                )}
                {r.allapot === 'visszaterites' && (
                  <button disabled={busy} className={U_btnGhost + ' py-2 text-[12px]'}
                    onClick={() => muvelet(() => SHOP_rpc('shop_order_set_status', { p_order: r.id, p_allapot: 'visszateritve', p_megjegyzes: statuszMegj || null }), 'Visszatérítés lezárva.')}>
                    <Lucide.CheckCheck size={14} /> Visszautalva
                  </button>
                )}
              </div>
            </div>
          )}

          {/* számla */}
          {['fizetve', 'teljesitve', 'visszaterites', 'visszateritve'].includes(r.allapot) && (
            <div className="rounded-2xl border border-slate-100 p-4 space-y-2" data-shop-szamla="1">
              <p className="text-[12px] font-black text-slate-800">Számla</p>
              <p className="text-[11px] text-slate-400">A számlát a gazdasági rendszer / számlázó állítja ki (NAV Online Számla). Itt a számát és a hivatkozását rögzítjük — a vevő a „Rendeléseim” alatt látja.</p>
              <div className="grid sm:grid-cols-[1fr,1.4fr,auto] gap-2">
                <input className={U_input + ' py-2 text-[12px]'} value={szamla.szam} onChange={e => setSzamla(p => ({ ...p, szam: e.target.value }))} placeholder="Számlaszám" />
                <input className={U_input + ' py-2 text-[12px]'} value={szamla.url} onChange={e => setSzamla(p => ({ ...p, url: e.target.value }))} placeholder="https://… (opcionális)" />
                <button disabled={busy} className={U_btnGhost + ' py-2 text-[12px]'}
                  onClick={() => muvelet(() => SHOP_rpc('shop_order_set_invoice', { p_order: r.id, p_szamla_szam: szamla.szam, p_szamla_url: szamla.url || null }), 'Számla rögzítve.')}>
                  <Lucide.Save size={14} /> Mentés
                </button>
              </div>
            </div>
          )}

          {/* belső megjegyzés */}
          <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
            <p className="text-[12px] font-black text-slate-800">Belső megjegyzés <span className="text-slate-400 font-bold">(a vevő nem látja)</span></p>
            <div className="flex gap-2">
              <input className={U_input + ' py-2 text-[12px] flex-1'} value={megj} onChange={e => setMegj(e.target.value)} />
              <button disabled={busy} className={U_btnGhost + ' py-2 text-[12px]'}
                onClick={() => muvelet(() => SHOP_rpc('shop_order_note', { p_order: r.id, p_megjegyzes: megj }), 'Megjegyzés mentve.')}><Lucide.Save size={14} /></button>
            </div>
          </div>

          {['jovahagyasra_var', 'fizetesre_var'].includes(r.allapot) && (
            <div className="flex justify-end">
              <button disabled={busy} className="text-[12px] font-bold text-slate-400 hover:text-red-600"
                onClick={() => { if (window.confirm('Lemondod ezt a rendelést? A készlet visszakerül.')) muvelet(() => SHOP_rpc('shop_order_cancel', { p_order: r.id }), 'Rendelés lemondva.'); }}>
                Rendelés lemondása
              </button>
            </div>
          )}

          {/* napló */}
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Eseménynapló</p>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {(r.esemenyek || []).map((e, i) => (
                <div key={i} className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="font-bold text-slate-600">{e.tipus.replace(/_/g, ' ')}{e.reszletek && e.reszletek.megjegyzes ? ' — ' + e.reszletek.megjegyzes : ''}{e.reszletek && e.reszletek.indoklas ? ' — ' + e.reszletek.indoklas : ''}</span>
                  <span className="text-slate-400 flex-none">{e.ki ? e.ki + ' · ' : ''}{SHOP_ido(e.mikor)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </UModal>
  );
}

function SHOP_Rendelesek() {
  const [q, setQ] = useState(''); const [keres, setKeres] = useState('');
  const [allapot, setAllapot] = useState('');
  const [lista, setLista] = useState(null);
  const [kiv, setKiv] = useState(null);
  const [err, setErr] = useState(''); const [ok, setOk] = useState('');
  const [kivonat, setKivonat] = useState('');

  useEffect(() => { const t = setTimeout(() => setKeres(q), 350); return () => clearTimeout(t); }, [q]);
  const tolts = React.useCallback(() => {
    SHOP_rpc('shop_admin_orders', { p_q: keres || null, p_allapot: allapot || null, p_limit: 100, p_offset: 0 })
      .then(d => { setLista(d); setErr(''); }).catch(e => setErr(SHOP_msg(e)));
  }, [keres, allapot]);
  useEffect(() => { tolts(); }, [tolts]);

  const st = (lista && lista.stat) || {};
  const al = st.allapotok || {};
  const felismert = SHOP_felismer(kivonat);
  const lejartak = async () => {
    if (!window.confirm('Lemondod az összes lejárt fizetési határidejű rendelést? A készlet visszakerül.')) return;
    try { const n = await SHOP_rpc('shop_expire_unpaid'); setOk(n + ' rendelés lemondva.'); tolts(); } catch (e) { setErr(SHOP_msg(e)); }
  };

  return (
    <div className="space-y-4 mt-5" data-shop-admin-rendelesek="1">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[['Bevétel összesen', SHOP_ft(st.bevetel_huf || 0)], ['Elmúlt 30 nap', SHOP_ft(st.bevetel_30_nap_huf || 0)],
          ['Jóváhagyásra vár', st.jovahagyasra_var || 0], ['Fizetve, számla nélkül', st.szamla_nelkul || 0], ['Lejárt fizetés', st.lejart_fizetes || 0]]
          .map(([c, v]) => (
          <div key={c} className="bg-white rounded-2xl border border-slate-100 px-4 py-3">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{c}</p>
            <p className="text-xl font-black text-slate-900 mt-0.5 tabular-nums">{v}</p>
          </div>
        ))}
      </div>

      {/* kivonat-összevetés */}
      <div className="bg-white rounded-2xl border border-slate-100 p-4">
        <p className="text-[12px] font-black text-slate-800 mb-1">Bankkivonat-tétel felismerése</p>
        <p className="text-[11px] text-slate-400 mb-2">Másold be az MBH-s kivonat közlemény rovatát: a rendszer kiolvassa a rendelésszámot, és ellenőrzi az ellenőrző számot.</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input className={U_input + ' py-2 text-[12px] flex-1'} value={kivonat} onChange={e => setKivonat(e.target.value)} placeholder="pl. UTALAS NJE-WS-00012-43 KISS ANNA" data-shop-kivonat="1" />
          {felismert && (
            <button className={U_btnGhost + ' py-2 text-[12px]'} onClick={() => setQ(felismert.rendelesszam)} data-shop-kivonat-talalat="1">
              {felismert.ervenyes ? <Lucide.Check size={14} className="text-emerald-600" /> : <Lucide.AlertTriangle size={14} className="text-amber-600" />}
              {felismert.rendelesszam}{felismert.ervenyes ? '' : ' — hibás ellenőrző szám!'}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
        <div className="relative flex-1">
          <Lucide.Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
          <input className={U_input + ' pl-11'} value={q} onChange={e => setQ(e.target.value)} placeholder="Név, e-mail, WS-szám, közlemény, rendszám, számlaszám…" data-shop-admin-kereso="1" />
        </div>
        <button onClick={lejartak} className={U_btnGhost + ' text-[12px]'}><Lucide.TimerOff size={15} /> Lejártak lemondása</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[['', 'Mind']].concat(Object.keys(SHOP_ALLAPOT).map(k => [k, SHOP_ALLAPOT[k][0] + (al[k] ? ' · ' + al[k] : '')])).map(([k, c]) => (
          <button key={k || 'mind'} onClick={() => setAllapot(k)} data-shop-allapot-szuro={k || 'mind'}
            className={'px-2.5 py-1 rounded-xl border text-[11px] font-bold transition-all ' + (allapot === k ? 'border-primary bg-primary/10 text-primary' : 'border-slate-100 bg-white text-slate-500 hover:border-slate-300')}>{c}</button>
        ))}
      </div>
      {err && <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600">{err}</div>}
      {ok && <div className="bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-3 text-sm font-bold text-emerald-700">{ok}</div>}

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        {lista === null ? <div className="p-6"><SkeletonBar h={120} /></div>
          : (lista.sorok || []).length === 0 ? <UEmpty icon={<Lucide.Receipt size={26} />} title="Nincs rendelés" />
          : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                <th className="px-5 py-2">Rendelés</th><th className="px-3 py-2">Vevő</th><th className="px-3 py-2">Tételek</th>
                <th className="px-3 py-2">Állapot</th><th className="px-3 py-2 text-right">Összeg</th><th className="px-3 py-2">Számla</th>
              </tr></thead>
              <tbody>
                {lista.sorok.map(r => (
                  <tr key={r.id} onClick={() => setKiv(r.id)} data-shop-admin-sor={r.rendelesszam}
                    className="border-t border-slate-50 hover:bg-slate-50/70 cursor-pointer">
                    <td className="px-5 py-3"><p className="text-[13px] font-black text-slate-800">{r.rendelesszam}</p><p className="text-[10px] font-bold text-slate-400">{SHOP_ido(r.created_at)}</p></td>
                    <td className="px-3 py-3"><p className="text-[12px] font-bold text-slate-700 truncate max-w-[20ch]">{r.vevo_nev}</p><p className="text-[10px] text-slate-400 truncate max-w-[24ch]">{r.vevo_email}</p></td>
                    <td className="px-3 py-3 text-[12px] text-slate-600 max-w-[28ch] truncate">{(r.tetelek || []).map(t => t.nev).join(', ')}</td>
                    <td className="px-3 py-3"><SHOP_Allapot a={r.allapot} /></td>
                    <td className="px-3 py-3 text-right text-[13px] font-black text-slate-800 tabular-nums">{SHOP_ft(r.osszeg_huf)}</td>
                    <td className="px-3 py-3 text-[11px] font-bold text-slate-500">{r.szamla_szam || (['fizetve', 'teljesitve'].includes(r.allapot) ? <span className="text-amber-600">hiányzik</span> : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <SHOP_RendelesReszlet id={kiv} onClose={() => setKiv(null)} onValtozott={tolts} />
    </div>
  );
}

const SHOP_URES_TERMEK = { nev: '', sku: '', leiras: '', category_id: '', tipus: 'fizikai', ar_huf: '', afa_kulcs: '27', keszlet: '',
  max_rendelesenkent: '', jovahagyas_kell: false, mezok: [], kep_url: '', fajl_utvonal: '', aktiv: true, sorrend: 100, celkozonseg: null };

/* A tárolt célközönség-JSON visszaalakítása a hírfolyam választójának állapotává. */
function SHOP_celAllapot(aud) {
  const u = typeof FEED_celUres === 'function' ? FEED_celUres() : { mod: 'mindenki' };
  if (!aud || typeof aud !== 'object') return u;
  const tet = (k) => (Array.isArray(aud[k]) ? aud[k] : []).map(id => ({ ref: id, cimke: String(id).slice(0, 8) + '…', kind: k }));
  return { ...u, mod: 'celzott', szerep: aud.szerep || [], tagozat: aud.tagozat || [], kepzesi_szint: aud.kepzesi_szint || [],
           kar: aud.kar || [], szak: aud.szak || [], kurzus: tet('kurzus'), csoport: tet('csoport'), szemely: tet('szemely') };
}

function SHOP_TermekSzerkeszto({ termek, kategoriak, onClose, onMentve }) {
  const [f, setF] = useState(SHOP_URES_TERMEK);
  const [cel, setCel] = useState(() => SHOP_celAllapot(null));
  const [busy, setBusy] = useState(false);
  const [hiba, setHiba] = useState('');
  const [feltolt, setFeltolt] = useState('');
  useEffect(() => {
    if (!termek) return;
    setF({ ...SHOP_URES_TERMEK, ...termek, ar_huf: termek.ar_huf == null ? '' : String(termek.ar_huf),
           keszlet: termek.keszlet == null ? '' : String(termek.keszlet),
           max_rendelesenkent: termek.max_rendelesenkent == null ? '' : String(termek.max_rendelesenkent),
           category_id: termek.category_id || '', mezok: Array.isArray(termek.mezok) ? termek.mezok : [] });
    setCel(SHOP_celAllapot(termek.celkozonseg)); setHiba(''); setFeltolt('');
  }, [termek]);
  if (!termek) return null;
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const tipusValt = (t) => {
    setF(p => {
      const uj = { ...p, tipus: t };
      // A parkolókártyánál a rendszám és a jóváhagyás az észszerű kiindulás.
      if (t === 'parkolokartya' && !(p.mezok || []).length) {
        uj.mezok = [{ kulcs: 'rendszam', cimke: 'Rendszám', kotelezo: true, tipus: 'rendszam' }];
        uj.jovahagyas_kell = true; uj.max_rendelesenkent = p.max_rendelesenkent || '1';
      }
      return uj;
    });
  };
  const fajlFeltolt = async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setFeltolt('Feltöltés…');
    try {
      const ut = 'termek/' + Date.now() + '-' + file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
      const { error } = await window.sb.storage.from('shop-files').upload(ut, file, { upsert: false });
      if (error) throw error;
      set('fajl_utvonal', ut); setFeltolt('Feltöltve.');
    } catch (err) { setFeltolt('A feltöltés nem sikerült: ' + ((err && err.message) || '')); }
  };
  const ment = async () => {
    setBusy(true); setHiba('');
    try {
      const aud = typeof FEED_celNormal === 'function' ? FEED_celNormal(cel) : null;
      const d = await SHOP_rpc('shop_product_save', { p: { ...f,
        ar_huf: f.ar_huf === '' ? null : Number(f.ar_huf), keszlet: f.keszlet === '' ? null : Number(f.keszlet),
        max_rendelesenkent: f.max_rendelesenkent === '' ? null : Number(f.max_rendelesenkent),
        category_id: f.category_id || null, celkozonseg: aud,
        mezok: (f.mezok || []).filter(m => m.cimke).map(m => ({ ...m, kulcs: m.kulcs || m.cimke.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_') })) } });
      onMentve(d);
    } catch (e) { setHiba(SHOP_msg(e)); } finally { setBusy(false); }
  };
  return (
    <UModal open={!!termek} onClose={onClose} max="max-w-3xl" icon={<Lucide.Package size={20} />}
      title={termek.id ? 'Termék szerkesztése' : 'Új termék'} subtitle={termek.id ? termek.nev : ''}>
      <div className="space-y-4" data-shop-termek-szerkeszto="1">
        <div className="grid sm:grid-cols-2 gap-3">
          <UField label="Név *"><input className={U_input} value={f.nev} onChange={e => set('nev', e.target.value)} /></UField>
          <UField label="Cikkszám (SKU)"><input className={U_input} value={f.sku || ''} onChange={e => set('sku', e.target.value)} /></UField>
        </div>
        <UField label="Leírás"><textarea className={U_input + ' min-h-[80px]'} value={f.leiras || ''} onChange={e => set('leiras', e.target.value)} /></UField>
        <div className="grid sm:grid-cols-3 gap-3">
          <UField label="Típus">
            <select className={U_input} value={f.tipus} onChange={e => tipusValt(e.target.value)}>
              {Object.keys(SHOP_TIPUS).map(k => <option key={k} value={k}>{SHOP_TIPUS[k][0]}</option>)}
            </select>
          </UField>
          <UField label="Kategória">
            <select className={U_input} value={f.category_id} onChange={e => set('category_id', e.target.value)}>
              <option value="">— nincs —</option>
              {(kategoriak || []).map(c => <option key={c.id} value={c.id}>{c.nev}</option>)}
            </select>
          </UField>
          <UField label="Sorrend"><input type="number" className={U_input} value={f.sorrend} onChange={e => set('sorrend', e.target.value)} /></UField>
        </div>
        <div className="grid sm:grid-cols-4 gap-3">
          <UField label="Bruttó ár (Ft) *"><input type="number" min="0" className={U_input} value={f.ar_huf} onChange={e => set('ar_huf', e.target.value)} /></UField>
          <UField label="ÁFA">
            <select className={U_input} value={f.afa_kulcs} onChange={e => set('afa_kulcs', e.target.value)}>
              {['27', '18', '5', '0', 'AAM', 'TAM'].map(k => <option key={k} value={k}>{/^\d+$/.test(k) ? k + '%' : k}</option>)}
            </select>
          </UField>
          <UField label="Készlet" hint="üres = korlátlan"><input type="number" min="0" className={U_input} value={f.keszlet} onChange={e => set('keszlet', e.target.value)} /></UField>
          <UField label="Max / rendelés"><input type="number" min="1" className={U_input} value={f.max_rendelesenkent} onChange={e => set('max_rendelesenkent', e.target.value)} /></UField>
        </div>
        <label className="flex items-center gap-2.5 text-sm font-bold text-slate-600 cursor-pointer">
          <input type="checkbox" checked={!!f.jovahagyas_kell} onChange={e => set('jovahagyas_kell', e.target.checked)} className="w-4 h-4 accent-primary" />
          Jóváhagyáshoz kötött (a vevő csak jóváhagyás után fizet — pl. parkolókártya)
        </label>

        {/* bekérendő adatok */}
        <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-black text-slate-800">Vásárláskor bekérendő adatok</p>
            <button type="button" className="text-[11px] font-black text-primary hover:underline"
              onClick={() => set('mezok', (f.mezok || []).concat([{ kulcs: '', cimke: '', kotelezo: true, tipus: 'szoveg' }]))}>+ Mező</button>
          </div>
          {(f.mezok || []).length === 0 && <p className="text-[11px] text-slate-300 font-bold italic">nincs — a vevőtől nem kérünk külön adatot</p>}
          {(f.mezok || []).map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr,auto,auto,auto] gap-2 items-center">
              <input className={U_input + ' py-1.5 text-[12px]'} value={m.cimke} placeholder="pl. Rendszám"
                onChange={e => set('mezok', f.mezok.map((x, j) => j === i ? { ...x, cimke: e.target.value } : x))} />
              <select className={U_input + ' py-1.5 text-[12px]'} value={m.tipus || 'szoveg'}
                onChange={e => set('mezok', f.mezok.map((x, j) => j === i ? { ...x, tipus: e.target.value } : x))}>
                <option value="szoveg">szöveg</option><option value="rendszam">rendszám</option><option value="datum">dátum</option>
              </select>
              <label className="text-[11px] font-bold text-slate-500 flex items-center gap-1">
                <input type="checkbox" checked={!!m.kotelezo} onChange={e => set('mezok', f.mezok.map((x, j) => j === i ? { ...x, kotelezo: e.target.checked } : x))} /> kötelező
              </label>
              <button type="button" className="text-slate-300 hover:text-red-500" onClick={() => set('mezok', f.mezok.filter((_, j) => j !== i))}><Lucide.X size={14} /></button>
            </div>
          ))}
        </div>

        <UField label="Kép URL"><input className={U_input} value={f.kep_url || ''} onChange={e => set('kep_url', e.target.value)} placeholder="https://…" /></UField>
        {f.tipus === 'digitalis' && (
          <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
            <p className="text-[12px] font-black text-slate-800">Letölthető fájl</p>
            <p className="text-[11px] text-slate-400">Privát tárolóba kerül; csak a kifizetett rendelés vevője töltheti le, rövid lejáratú linkkel.</p>
            <div className="flex items-center gap-3 flex-wrap">
              <label className={U_btnGhost + ' cursor-pointer text-[12px]'}><Lucide.Upload size={14} /> Fájl feltöltése<input type="file" className="hidden" onChange={fajlFeltolt} /></label>
              <span className="text-[11px] font-mono text-slate-500 break-all">{f.fajl_utvonal || 'nincs fájl'}</span>
              {feltolt && <span className="text-[11px] font-bold text-slate-500">{feltolt}</span>}
            </div>
          </div>
        )}
        {typeof FEED_CelkozonsegValaszto === 'function' && (
          <FEED_CelkozonsegValaszto ertek={cel} onValt={setCel} />
        )}
        <label className="flex items-center gap-2.5 text-sm font-bold text-slate-600 cursor-pointer">
          <input type="checkbox" checked={!!f.aktiv} onChange={e => set('aktiv', e.target.checked)} className="w-4 h-4 accent-primary" /> Aktív (látszik a boltban)
        </label>
        {hiba && <p className="text-[12px] font-bold text-red-600" role="alert">{hiba}</p>}
        <div className="flex justify-end gap-2">
          <button className={U_btnGhost} onClick={onClose}>Mégse</button>
          <button className={U_btnPrimary} onClick={ment} disabled={busy} data-shop-termek-ment="1"><Lucide.Save size={15} /> Mentés</button>
        </div>
      </div>
    </UModal>
  );
}

function SHOP_Katalogus({ adat, onFrissit }) {
  const [szerk, setSzerk] = useState(null);
  const [ujKat, setUjKat] = useState('');
  const [err, setErr] = useState('');
  const kategoriak = (adat && adat.kategoriak) || [];
  const katNev = (id) => (kategoriak.find(c => c.id === id) || {}).nev || '—';
  const katMent = async (p) => { try { setErr(''); await SHOP_rpc('shop_category_save', { p }); setUjKat(''); onFrissit(); } catch (e) { setErr(SHOP_msg(e)); } };
  const aktivValt = async (t) => { try { setErr(''); await SHOP_rpc('shop_product_save', { p: { ...t, aktiv: !t.aktiv } }); onFrissit(); } catch (e) { setErr(SHOP_msg(e)); } };
  return (
    <div className="grid lg:grid-cols-[1fr,300px] gap-4 mt-5" data-shop-admin-katalogus="1">
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <p className="text-sm font-black text-slate-800">Termékek <span className="text-slate-400">({((adat && adat.termekek) || []).length})</span></p>
          <button className={U_btnPrimary + ' py-2 text-[12px]'} onClick={() => setSzerk({ ...SHOP_URES_TERMEK })} data-shop-uj-termek="1"><Lucide.Plus size={14} /> Új termék</button>
        </div>
        {err && <p className="px-5 pt-3 text-[12px] font-bold text-red-600">{err}</p>}
        {((adat && adat.termekek) || []).length === 0 ? <UEmpty icon={<Lucide.Package size={26} />} title="Még nincs termék" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                <th className="px-5 py-2">Termék</th><th className="px-3 py-2">Kategória</th><th className="px-3 py-2 text-right">Ár</th>
                <th className="px-3 py-2 text-right">Készlet</th><th className="px-3 py-2 text-right">Eladva</th><th className="px-3 py-2">Állapot</th>
              </tr></thead>
              <tbody>
                {adat.termekek.map(t => (
                  <tr key={t.id} className="border-t border-slate-50 hover:bg-slate-50/70" data-shop-admin-termek={t.id}>
                    <td className="px-5 py-3 cursor-pointer" onClick={() => setSzerk(t)}>
                      <p className="text-[13px] font-black text-slate-800 flex items-center gap-2"><SHOP_Ikon tipus={t.tipus} size={14} /> {t.nev}</p>
                      <p className="text-[10px] font-bold text-slate-400">{(SHOP_TIPUS[t.tipus] || [t.tipus])[0]}{t.jovahagyas_kell ? ' · jóváhagyással' : ''}{t.celkozonseg ? ' · célzott' : ''}{t.sku ? ' · ' + t.sku : ''}</p>
                    </td>
                    <td className="px-3 py-3 text-[12px] text-slate-600">{katNev(t.category_id)}</td>
                    <td className="px-3 py-3 text-right text-[13px] font-black text-slate-800 tabular-nums">{SHOP_ft(t.ar_huf)}</td>
                    <td className="px-3 py-3 text-right text-[12px] font-bold text-slate-600 tabular-nums">{t.keszlet == null ? '∞' : t.keszlet}</td>
                    <td className="px-3 py-3 text-right text-[12px] font-bold text-slate-600 tabular-nums">{t.eladott_db || 0}</td>
                    <td className="px-3 py-3">
                      <button onClick={() => aktivValt(t)} title="Kattintásra váltás">{t.aktiv ? <UBadge tone="green">aktív</UBadge> : <UBadge tone="slate">rejtve</UBadge>}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="bg-white rounded-3xl border border-slate-100 p-5 self-start space-y-3">
        <p className="text-sm font-black text-slate-800">Kategóriák</p>
        {kategoriak.map(c => (
          <div key={c.id} className="flex items-center justify-between gap-2">
            <span className={'text-[13px] font-bold ' + (c.aktiv ? 'text-slate-700' : 'text-slate-300 line-through')}>{c.nev} <span className="text-slate-400 font-medium">· {c.termek_db}</span></span>
            <button onClick={() => katMent({ ...c, aktiv: !c.aktiv })} className="text-[11px] font-black text-primary hover:underline">{c.aktiv ? 'elrejt' : 'mutat'}</button>
          </div>
        ))}
        <div className="flex gap-2 pt-1">
          <input className={U_input + ' py-2 text-[12px]'} value={ujKat} onChange={e => setUjKat(e.target.value)} placeholder="Új kategória neve" />
          <button className={U_btnGhost + ' py-2 text-[12px]'} disabled={!ujKat.trim()} onClick={() => katMent({ nev: ujKat.trim() })}><Lucide.Plus size={14} /></button>
        </div>
      </div>
      <SHOP_TermekSzerkeszto termek={szerk} kategoriak={kategoriak} onClose={() => setSzerk(null)} onMentve={() => { setSzerk(null); onFrissit(); }} />
    </div>
  );
}

function SHOP_Beallitasok({ adat, onFrissit }) {
  const b0 = ((adat && adat.beallitasok) || {}).bank || {};
  const f0 = ((adat && adat.beallitasok) || {}).fizetes || {};
  const k0 = ((adat && adat.beallitasok) || {}).kartya || {};
  const q0 = ((adat && adat.beallitasok) || {}).qvik || {};
  const [bank, setBank] = useState(b0);
  const [nap, setNap] = useState(String(f0.hatarido_nap || 8));
  const [ok, setOk] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { setBank(b0); setNap(String(f0.hatarido_nap || 8)); }, [adat]);
  const ment = async () => {
    setOk(''); setErr('');
    try {
      await SHOP_rpc('shop_setting_save', { p_kulcs: 'bank', p_ertek: { kedvezmenyezett: bank.kedvezmenyezett || null, bank: bank.bank || null,
        szamlaszam: bank.szamlaszam || null, iban: bank.iban || null } });
      await SHOP_rpc('shop_setting_save', { p_kulcs: 'fizetes', p_ertek: { hatarido_nap: Math.max(1, Math.min(60, Number(nap) || 8)) } });
      setOk('Beállítások mentve.'); onFrissit();
    } catch (e) { setErr(SHOP_msg(e)); }
  };
  return (
    <div className="grid lg:grid-cols-2 gap-4 mt-5" data-shop-admin-beallitasok="1">
      <div className="bg-white rounded-3xl border border-slate-100 p-5 space-y-3">
        <p className="text-sm font-black text-slate-800">Banki átutalás — az egyetem MBH-s számlája</p>
        <p className="text-[11px] text-slate-400">Ezt látja a vevő a fizetési útmutatóban. Amíg a számlaszám üres, átutalással nem lehet rendelni.</p>
        <UField label="Kedvezményezett"><input className={U_input} value={bank.kedvezmenyezett || ''} onChange={e => setBank(p => ({ ...p, kedvezmenyezett: e.target.value }))} placeholder="Neumann János Egyetem" /></UField>
        <UField label="Bank"><input className={U_input} value={bank.bank || ''} onChange={e => setBank(p => ({ ...p, bank: e.target.value }))} /></UField>
        <UField label="Számlaszám"><input className={U_input + ' font-mono'} value={bank.szamlaszam || ''} onChange={e => setBank(p => ({ ...p, szamlaszam: e.target.value }))} placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx" /></UField>
        <UField label="IBAN (opcionális)"><input className={U_input + ' font-mono'} value={bank.iban || ''} onChange={e => setBank(p => ({ ...p, iban: e.target.value }))} /></UField>
        <UField label="Fizetési határidő (nap)"><input type="number" min="1" max="60" className={U_input + ' w-28'} value={nap} onChange={e => setNap(e.target.value)} /></UField>
        {err && <p className="text-[12px] font-bold text-red-600">{err}</p>}
        {ok && <p className="text-[12px] font-bold text-emerald-700">{ok}</p>}
        <div className="flex justify-end"><button className={U_btnPrimary} onClick={ment} data-shop-beallitas-ment="1"><Lucide.Save size={15} /> Mentés</button></div>
      </div>
      <div className="space-y-4">
        <div className="bg-white rounded-3xl border border-slate-100 p-5 space-y-2">
          <p className="text-sm font-black text-slate-800">Online fizetés</p>
          {[['Bankkártya', k0], ['qvik (azonnali fizetés)', q0]].map(([c, v]) => (
            <div key={c} className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-bold text-slate-700">{c}</span>
              {v.aktiv ? <UBadge tone="green">bekapcsolva{v.szolgaltato ? ' · ' + v.szolgaltato : ''}</UBadge> : <UBadge tone="slate">nincs bekötve</UBadge>}
            </div>
          ))}
          <p className="text-[11px] text-slate-400 leading-relaxed pt-1">
            Bekapcsolni itt szándékosan nem lehet: ehhez szolgáltatói szerződés (pl. MBH virtuális POS, SimplePay vagy Barion),
            titkos kulcs és szerveroldali visszaigazolás kell. A bekötés után a pénz az egyetem MBH-s számlájára érkezik.
          </p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-5 space-y-1.5" data-shop-elesites="1">
          <p className="text-sm font-black text-amber-900">Élesítés előtt</p>
          {['A webshop vásárlási feltételei (ÁSZF) — jogi iroda',
            'Adatkezelési tájékoztató kiegészítése (rendelés, számlázási adat, rendszám)',
            'Számlázás folyamata: ki állítja ki a számlát és mikor (NAV Online Számla)',
            'Az egyetem MBH-s számlaszáma a fenti mezőben',
            'Online fizetéshez: szolgáltatói szerződés és bekötés'].map(x => (
            <p key={x} className="text-[12px] text-amber-900 font-medium flex items-start gap-2"><Lucide.Square size={13} className="flex-none mt-0.5" /> {x}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function SHOP_AdminView({ user }) {
  const [ful, setFul] = useState('rendelesek');
  const [adat, setAdat] = useState(null);
  const [nincs, setNincs] = useState(false);
  const [err, setErr] = useState('');
  const tolts = React.useCallback(() => {
    SHOP_rpc('shop_admin_catalog').then(d => { setAdat(d); setErr(''); })
      .catch(e => { if (SHOP_nincsMigracio(e)) setNincs(true); else setErr(SHOP_msg(e)); });
  }, []);
  useEffect(() => { tolts(); }, [tolts]);
  if (nincs) {
    return <div className="p-8 max-w-3xl mx-auto"><UEmpty icon={<Lucide.Store size={26} />} title="A webshop még nincs telepítve"
      subtitle="Futtatni kell a supabase/74_webshop.sql migrációt." /></div>;
  }
  return (
    <div className="p-4 sm:p-8 max-w-[1500px] mx-auto animate-in fade-in duration-300" data-shop-admin="1">
      <div className="mb-4">
        <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">Pénzügy</p>
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Webshop kezelése</h1>
        <p className="text-slate-400 mt-1 font-medium text-sm">Rendelések, jóváhagyások, befizetések, számlák, termékek és beállítások.</p>
      </div>
      {err && <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 mb-4">{err}</div>}
      <div className="flex flex-wrap gap-2">
        {[['rendelesek', 'Rendelések', Lucide.Receipt], ['katalogus', 'Termékek és kategóriák', Lucide.Package], ['beallitasok', 'Beállítások', Lucide.Settings]].map(([k, c, I]) => (
          <button key={k} onClick={() => setFul(k)} data-shop-admin-ful={k}
            className={'inline-flex items-center gap-2 px-4 py-2 rounded-2xl border text-[13px] font-bold transition-all '
              + (ful === k ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 bg-white text-slate-500 hover:border-slate-300')}>
            <I size={15} /> {c}
          </button>
        ))}
      </div>
      {ful === 'rendelesek' && <SHOP_Rendelesek />}
      {ful === 'katalogus' && <SHOP_Katalogus adat={adat} onFrissit={tolts} />}
      {ful === 'beallitasok' && <SHOP_Beallitasok adat={adat} onFrissit={tolts} />}
    </div>
  );
}
