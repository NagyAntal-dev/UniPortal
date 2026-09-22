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
  const [kepI, setKepI] = useState(0);
  const [valaszt, setValaszt] = useState({});   // tulajdonság -> érték
  useEffect(() => { setAdatok({}); setMenny(1); setHiba(''); setKepI(0); setValaszt({}); }, [termek && termek.id]);
  if (!termek) return null;
  const mezok = Array.isArray(termek.mezok) ? termek.mezok : [];
  const valt = Array.isArray(termek.valtozatok) ? termek.valtozatok : [];
  const kepek = (Array.isArray(termek.kepek) && termek.kepek.length) ? termek.kepek : (termek.kep_url ? [{ url: termek.kep_url }] : []);
  // A tulajdonságok és értékeik a változatokból
  const tul = {}; valt.forEach(v => Object.entries(v.tulajdonsagok || {}).forEach(([k, e]) => { (tul[k] = tul[k] || []).includes(e) || tul[k].push(e); }));
  const tulKulcsok = Object.keys(tul);
  const illik = (v, extra) => Object.entries({ ...valaszt, ...(extra || {}) }).every(([k, e]) => (v.tulajdonsagok || {})[k] === e);
  const kivalasztott = valt.length === 0 ? null
    : (tulKulcsok.length ? (tulKulcsok.every(k => valaszt[k]) ? valt.find(v => illik(v)) : null) : valt.find(v => v.id === valaszt.__id));
  const ar = kivalasztott && kivalasztott.ar_huf != null ? kivalasztott.ar_huf : termek.ar_huf;
  const keszlet = kivalasztott ? kivalasztott.keszlet : termek.keszlet;
  const max = Math.min(termek.max_rendelesenkent || 99, keszlet == null ? 99 : keszlet);
  const r = termek.reszletek || {};
  const reszletSorok = [['Szerző', r.szerzo], ['Kiadás', r.kiadas], ['Oldalszám', r.oldalszam], ['ISBN', r.isbn], ['Időpont', r.datum],
    ['Helyszín', r.helyszin], ['Telephely', r.telephely], ['Érvényes', r.ervenyes_tol || r.ervenyes_ig ? (r.ervenyes_tol || '…') + ' – ' + (r.ervenyes_ig || '…') : null],
    ['Érvényesség', r.ervenyesseg], ['Anyag', r.anyag], ['Mérettáblázat', r.merettablazat]].filter(x => x[1]);

  const kosarba = () => {
    if (valt.length && !kivalasztott) { setHiba('Válaszd ki a változatot' + (tulKulcsok.length ? ' (' + tulKulcsok.join(', ').toLowerCase() + ')' : '') + '.'); return; }
    if (kivalasztott && kivalasztott.elfogyott) { setHiba('Ez a változat elfogyott.'); return; }
    const hianyzik = mezok.find(m => m.kotelezo && !String(adatok[m.kulcs] || '').trim());
    if (hianyzik) { setHiba('Hiányzó adat: ' + (hianyzik.cimke || hianyzik.kulcs) + '.'); return; }
    onKosarba({ product_id: termek.id, variant_id: kivalasztott ? kivalasztott.id : null, variant_nev: kivalasztott ? kivalasztott.nev : null,
                egysegar: ar, mennyiseg: menny, adatok });
  };
  return (
    <UModal open={!!termek} onClose={onClose} max="max-w-3xl" title={termek.nev}
      subtitle={(SHOP_SABLONOK[termek.sablon] || {}).cimke || (SHOP_TIPUS[termek.tipus] || SHOP_TIPUS.fizikai)[0]} icon={<SHOP_SablonIkon sablon={termek.sablon} size={20} />}>
      <div className="grid md:grid-cols-2 gap-5" data-shop-termek-modal={termek.id}>
        <div className="space-y-2">
          <div className="aspect-[4/3] rounded-2xl overflow-hidden bg-slate-50 flex items-center justify-center text-slate-300">
            {kepek[kepI] && typeof FEED_img === 'function' ? FEED_img(kepek[kepI].url, 'w-full h-full object-cover', kepek[kepI].alt || termek.nev) : <SHOP_SablonIkon sablon={termek.sablon} size={48} />}
          </div>
          {kepek.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {kepek.map((k, i) => (
                <button key={i} type="button" onClick={() => setKepI(i)} className={'w-14 h-14 rounded-xl overflow-hidden border-2 flex-none ' + (i === kepI ? 'border-primary' : 'border-transparent')}>
                  {typeof FEED_img === 'function' ? FEED_img(k.url, 'w-full h-full object-cover') : null}
                </button>
              ))}
            </div>
          )}
          {termek.leiras && <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-line">{termek.leiras}</p>}
          {reszletSorok.length > 0 && (
            <div className="rounded-2xl border border-slate-100 p-3 text-[12px] space-y-1">
              {reszletSorok.map(([c, v]) => <p key={c} className="flex justify-between gap-3"><span className="text-slate-400 font-bold">{c}</span><span className="text-slate-700 font-bold text-right">{v}</span></p>)}
            </div>
          )}
        </div>
        <div className="space-y-4">
          <div>
            <p className="text-2xl font-black text-slate-900 tabular-nums" data-shop-modal-ar="1">{SHOP_ft(ar)}</p>
            {termek.kurzusodhoz && termek.kurzus && <p className="text-[11px] font-bold text-sky-700 mt-1">A felvett kurzusodhoz: {termek.kurzus.kod} · {termek.kurzus.nev}</p>}
          </div>
          {tulKulcsok.map(k => (
            <div key={k}>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">{k}</p>
              <div className="flex flex-wrap gap-1.5">
                {tul[k].map(e => {
                  // Az érték elérhető, ha van hozzá (a többi választással összeférő) nem elfogyott változat
                  const van = valt.some(v => (v.tulajdonsagok || {})[k] === e && !v.elfogyott && Object.entries(valaszt).every(([k2, e2]) => k2 === k || (v.tulajdonsagok || {})[k2] === e2));
                  const on = valaszt[k] === e;
                  return (
                    <button key={e} type="button" disabled={!van && !on} onClick={() => setValaszt(p => ({ ...p, [k]: on ? undefined : e }))}
                      data-shop-valaszto={k + ':' + e}
                      className={'px-3 py-1.5 rounded-xl border text-[12px] font-bold transition-all disabled:opacity-35 disabled:line-through '
                        + (on ? 'border-primary bg-primary/10 text-primary' : 'border-slate-200 text-slate-600 hover:border-slate-400')}>{e}</button>
                  );
                })}
              </div>
            </div>
          ))}
          {valt.length > 0 && tulKulcsok.length === 0 && (
            <div className="flex flex-wrap gap-1.5">
              {valt.map(v => (
                <button key={v.id} type="button" disabled={v.elfogyott} onClick={() => setValaszt({ __id: v.id })}
                  className={'px-3 py-1.5 rounded-xl border text-[12px] font-bold disabled:opacity-35 ' + (valaszt.__id === v.id ? 'border-primary bg-primary/10 text-primary' : 'border-slate-200 text-slate-600')}>{v.nev}</button>
              ))}
            </div>
          )}
          {kivalasztott && kivalasztott.keszlet != null && kivalasztott.keszlet <= 5 && !kivalasztott.elfogyott && (
            <p className="text-[11px] font-bold text-red-600">Ebből a változatból már csak {kivalasztott.keszlet} db van.</p>
          )}
          {termek.jovahagyas_kell && (
            <p className="text-[12px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              Ez a tétel jóváhagyáshoz kötött: fizetni csak az ügyintéző jóváhagyása után kell.
            </p>
          )}
          {mezok.map(m => (
            <UField key={m.kulcs} label={(m.cimke || m.kulcs) + (m.kotelezo ? ' *' : '')}>
              <input className={U_input} value={adatok[m.kulcs] || ''} data-shop-mezo={m.kulcs}
                type={m.tipus === 'datum' ? 'date' : 'text'} placeholder={m.tipus === 'rendszam' ? 'pl. ABC-123' : ''}
                onChange={e => setAdatok(p => ({ ...p, [m.kulcs]: e.target.value }))} />
            </UField>
          ))}
          {max > 1 && (
            <UField label="Mennyiség">
              <input type="number" min="1" max={max} className={U_input + ' w-28'} value={menny}
                onChange={e => setMenny(Math.max(1, Math.min(max, Number(e.target.value) || 1)))} />
            </UField>
          )}
          {termek.teljesites === 'atvetel' && termek.atveteli_hely && (
            <p className="text-[12px] text-slate-600 flex items-start gap-2"><Lucide.MapPin size={14} className="flex-none mt-0.5 text-slate-400" /> Átvétel: {termek.atveteli_hely}</p>
          )}
          {termek.teljesites === 'letoltes' && <p className="text-[12px] text-slate-600 flex items-start gap-2"><Lucide.Download size={14} className="flex-none mt-0.5 text-slate-400" /> Letölthető a fizetés után, a Rendeléseim alatt.</p>}
          {termek.ertekesites_ig && <p className="text-[11px] font-bold text-slate-400">Rendelhető eddig: {SHOP_ido(termek.ertekesites_ig)}</p>}
          {hiba && <p className="text-[12px] font-bold text-red-600" role="alert">{hiba}</p>}
          <div className="flex justify-end gap-2">
            <button className={U_btnGhost} onClick={onClose}>Mégse</button>
            <button className={U_btnPrimary} onClick={kosarba} disabled={termek.elfogyott} data-shop-kosarba-gomb="1">
              <Lucide.ShoppingCart size={16} /> Kosárba
            </button>
          </div>
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
  const osszeg = kosar.reduce((s, t) => s + (t.egysegar != null ? t.egysegar : ((termekMap[t.product_id] || {}).ar_huf || 0)) * t.mennyiseg, 0);
  const leadas = async () => {
    if (!szaml.nev.trim()) { setHiba('A számlázási név kötelező.'); return; }
    setBusy(true); setHiba('');
    try {
      const r = await SHOP_rpc('shop_order_create', {
        p_items: kosar.map(t => ({ product_id: t.product_id, variant_id: t.variant_id || null, mennyiseg: t.mennyiseg, adatok: t.adatok || {} })),
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
              <p className="text-[12px] font-bold text-slate-700 truncate">{t.mennyiseg > 1 ? t.mennyiseg + ' × ' : ''}{t.nev}{t.variant_nev ? ' — ' + t.variant_nev : ''}</p>
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
    setKosar(k => k.filter(t => {
      const tm = termekMap[t.product_id];
      if (!tm) return false;
      if (t.variant_id) return (tm.valtozatok || []).some(v => v.id === t.variant_id);
      return !(tm.valtozatok || []).length;
    }));
  }, [kat]);

  if (nincs) {
    return <div className="p-8 max-w-3xl mx-auto"><UEmpty icon={<Lucide.ShoppingBag size={26} />} title="A webshop még nincs telepítve"
      subtitle="Futtatni kell a supabase/74_webshop.sql migrációt." /></div>;
  }

  const termekek = ((kat && kat.termekek) || []).filter(t =>
    (!szuro || (szuro === '__neked' ? t.neked : t.category_id === szuro)) &&
    (!q.trim() || (t.nev + ' ' + (t.leiras || '')).toLowerCase().includes(q.trim().toLowerCase())));
  const kosarDb = kosar.reduce((s, t) => s + t.mennyiseg, 0);
  const tetelAr = (t) => (t.egysegar != null ? t.egysegar : ((termekMap[t.product_id] || {}).ar_huf || 0));
  const kosarOssz = kosar.reduce((s, t) => s + tetelAr(t) * t.mennyiseg, 0);
  const vanNeked = ((kat && kat.termekek) || []).some(t => t.neked);
  const kosarba = (tetel) => {
    setKosar(k => {
      const t = termekMap[tetel.product_id];
      const vanMezo = t && Array.isArray(t.mezok) && t.mezok.length > 0;
      // Adatos tétel (pl. rendszám) mindig külön sor; a többi összevonódik.
      if (!vanMezo) {
        const i = k.findIndex(x => x.product_id === tetel.product_id && (x.variant_id || null) === (tetel.variant_id || null));
        if (i >= 0) {
          const v = (t.valtozatok || []).find(x => x.id === tetel.variant_id);
          const kesz = v ? v.keszlet : t.keszlet;
          const max = Math.min(t.max_rendelesenkent || 99, kesz == null ? 99 : kesz);
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
              {[['', 'Összes']].concat(vanNeked ? [['__neked', 'Neked']] : []).concat(((kat && kat.kategoriak) || []).map(c => [c.id, c.nev])).map(([id, nev]) => (
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
                      {t.kep_url && typeof FEED_img === 'function' ? FEED_img(t.kep_url, 'w-full h-full object-cover') : <SHOP_SablonIkon sablon={t.sablon} size={40} />}
                    </div>
                    <div className="p-4">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{(SHOP_SABLONOK[t.sablon] || {}).cimke || (SHOP_TIPUS[t.tipus] || SHOP_TIPUS.fizikai)[0]}{t.kurzus ? ' · ' + t.kurzus.kod : ''}</p>
                      <p className="text-[15px] font-black text-slate-900 leading-snug mt-0.5">{t.nev}</p>
                      <div className="flex items-center justify-between gap-2 mt-3">
                        <span className="text-lg font-black text-slate-900 tabular-nums">{SHOP_ft(t.ar_tol != null ? t.ar_tol : t.ar_huf)}{(t.valtozatok || []).some(v => v.ar_huf != null && v.ar_huf !== t.ar_tol) ? '-tól' : ''}</span>
                        {t.elfogyott ? <UBadge tone="slate">elfogyott</UBadge>
                          : t.kurzusodhoz ? <UBadge tone="blue">kurzusodhoz</UBadge>
                          : t.jovahagyas_kell ? <UBadge tone="amber">jóváhagyással</UBadge>
                          : (t.valtozatok || []).length > 1 ? <UBadge tone="slate">{(t.valtozatok || []).length + ' változat'}</UBadge>
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
                        <p className="text-[12px] font-bold text-slate-700 truncate">{k.mennyiseg > 1 ? k.mennyiseg + ' × ' : ''}{t.nev}{k.variant_nev ? ' — ' + k.variant_nev : ''}</p>
                        {k.adatok && Object.keys(k.adatok).length > 0 && (
                          <p className="text-[10px] text-slate-400 font-mono truncate">{Object.values(k.adatok).join(' · ')}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-none">
                        <span className="text-[12px] font-black text-slate-600 tabular-nums">{SHOP_ft(tetelAr(k) * k.mennyiseg)}</span>
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
                    <p className="text-[13px] font-black text-slate-800">{t.mennyiseg > 1 ? t.mennyiseg + ' × ' : ''}{t.nev}{t.variant_nev ? ' — ' + t.variant_nev : ''}</p>
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

/* ------------------------------------------------------------------ */
/* TERMÉK-SABLONOK (75_webshop_editor.sql)                              */
/* A sablon a jó kiindulás: előtölti a bekért adatokat, a teljesítést,  */
/* a jóváhagyást és a sablonfüggő részleteket. Minden átírható; a       */
/* közzétételkor a SZERVER ellenőrzi a sablon kötelező adatait.         */
/* ------------------------------------------------------------------ */
const SHOP_SABLONOK = {
  digitalis_jegyzet: { cimke: 'Digitális jegyzet', ikon: 'FileDown', leiras: 'PDF letöltés fizetés után, kurzushoz köthető.',
    alap: { afa_kulcs: '5', teljesites: 'letoltes', max_rendelesenkent: '1', jovahagyas_kell: false, mezok: [] },
    reszletek: [['szerzo', 'Szerző'], ['kiadas', 'Kiadás / év'], ['oldalszam', 'Oldalszám']] },
  nyomtatott: { cimke: 'Nyomtatott termék', ikon: 'Package', leiras: 'Jegyzet, tankönyv, bögre — készlettel, átvétellel.',
    alap: { afa_kulcs: '27', teljesites: 'atvetel', jovahagyas_kell: false, mezok: [] },
    reszletek: [['isbn', 'ISBN (könyvnél)'], ['kiadas', 'Kiadás / év']] },
  ruhazat: { cimke: 'Ruházat', ikon: 'Shirt', leiras: 'Méret × szín változatok, saját készlettel.',
    alap: { afa_kulcs: '27', teljesites: 'atvetel', jovahagyas_kell: false, mezok: [], tulajdonsagok: [['Méret', 'S, M, L, XL'], ['Szín', '']] },
    reszletek: [['merettablazat', 'Mérettáblázat (pl. M: mellbőség 100 cm)'], ['anyag', 'Anyag']] },
  parkolokartya: { cimke: 'Parkolókártya', ikon: 'Car', leiras: 'Rendszám, jóváhagyás a fizetés előtt.',
    alap: { afa_kulcs: '27', teljesites: 'automatikus', max_rendelesenkent: '1', jovahagyas_kell: true,
            mezok: [{ kulcs: 'rendszam', cimke: 'Rendszám', kotelezo: true, tipus: 'rendszam' }] },
    reszletek: [['telephely', 'Telephely'], ['ervenyes_tol', 'Érvényes ettől (dátum)'], ['ervenyes_ig', 'Érvényes eddig (dátum)']] },
  rendezvenyjegy: { cimke: 'Rendezvényjegy', ikon: 'Ticket', leiras: 'Dátum, helyszín, létszámkeret, névre szóló jegy.',
    alap: { afa_kulcs: '27', teljesites: 'kezi', max_rendelesenkent: '2', jovahagyas_kell: false,
            mezok: [{ kulcs: 'nev_a_jegyre', cimke: 'Név a jegyre', kotelezo: true, tipus: 'szoveg' }] },
    reszletek: [['datum', 'Időpont (pl. 2026-10-10 20:00)'], ['helyszin', 'Helyszín']] },
  berlet: { cimke: 'Bérlet', ikon: 'CalendarRange', leiras: 'Időszakos jogosultság (edzőterem, tároló).',
    alap: { afa_kulcs: '27', teljesites: 'kezi', max_rendelesenkent: '1', jovahagyas_kell: false,
            mezok: [{ kulcs: 'kezdo_nap', cimke: 'Érvényesség kezdete', kotelezo: true, tipus: 'datum' }] },
    reszletek: [['ervenyesseg', 'Érvényesség hossza (pl. 1 hónap)'], ['helyszin', 'Létesítmény']] },
  szolgaltatas: { cimke: 'Szolgáltatás', ikon: 'Sparkles', leiras: 'Szabadon definiálható, kézi teljesítés.',
    alap: { afa_kulcs: '27', teljesites: 'kezi', jovahagyas_kell: false, mezok: [] }, reszletek: [] },
};
const SHOP_TELJESITES = { letoltes: 'Letöltés fizetés után', atvetel: 'Személyes átvétel', automatikus: 'Automatikus (pl. kártya aktiválása)', kezi: 'Kézi teljesítés (ügyintéző jelöli)' };
const SHOP_STATUSZ = { vazlat: ['Vázlat', 'amber'], kozzetett: ['Közzétéve', 'green'], archivalt: ['Archivált', 'slate'] };
const SHOP_HIANY_NEV = { nev: 'név', ar: 'ár', letoltheto_fajl: 'letölthető fájl', valtozatok: 'legalább egy változat', kep: 'kép',
  datum_helyszin: 'időpont és helyszín', rendszam_mezo: 'rendszám-mező', atveteli_hely: 'átvételi hely' };
const SHOP_SablonIkon = ({ sablon, size }) => {
  const I = Lucide[(SHOP_SABLONOK[sablon] || SHOP_SABLONOK.szolgaltatas).ikon] || Lucide.Package;
  return <I size={size || 18} />;
};

/* A közzététel akadályai a felületen is — ugyanaz a szabály, mint a
   szerver shop.kozzetetel_hianyok() függvényéé, hogy az ügyintéző MENTÉS
   előtt lássa, mi hiányzik. A végső szót a szerver mondja. */
function SHOP_hianyok(f) {
  const h = [];
  if (!String(f.nev || '').trim()) h.push('nev');
  if (f.ar_huf === '' || f.ar_huf == null) h.push('ar');
  if (f.sablon === 'digitalis_jegyzet' && !f.fajl_utvonal) h.push('letoltheto_fajl');
  if (f.sablon === 'ruhazat' && !(f.valtozatok || []).some(v => v.aktiv !== false && String(v.nev || '').trim())) h.push('valtozatok');
  if ((f.sablon === 'ruhazat' || f.sablon === 'nyomtatott') && !(f.kepek || []).some(k => String(k.url || '').trim())) h.push('kep');
  if (f.sablon === 'rendezvenyjegy' && (!(f.reszletek || {}).datum || !(f.reszletek || {}).helyszin)) h.push('datum_helyszin');
  if (f.sablon === 'parkolokartya' && !(f.mezok || []).some(m => m.tipus === 'rendszam')) h.push('rendszam_mezo');
  if (f.teljesites === 'atvetel' && !String(f.atveteli_hely || '').trim()) h.push('atveteli_hely');
  return h;
}

const SHOP_URES_TERMEK = { nev: '', sku: '', leiras: '', category_id: '', sablon: 'nyomtatott', ar_huf: '', afa_kulcs: '27', keszlet: '',
  max_rendelesenkent: '', jovahagyas_kell: false, mezok: [], kepek: [], valtozatok: [], reszletek: {}, fajl_utvonal: '', teljesites: 'atvetel',
  atveteli_hely: '', ertekesites_tol: '', ertekesites_ig: '', kurzus_id: '', kurzus: null, statusz: 'vazlat', sorrend: 100, celkozonseg: null };

/* A tárolt célközönség-JSON visszaalakítása a hírfolyam választójának állapotává. */
function SHOP_celAllapot(aud) {
  const u = typeof FEED_celUres === 'function' ? FEED_celUres() : { mod: 'mindenki' };
  if (!aud || typeof aud !== 'object') return u;
  const tet = (k) => (Array.isArray(aud[k]) ? aud[k] : []).map(id => ({ ref: id, cimke: String(id).slice(0, 8) + '…', kind: k }));
  return { ...u, mod: 'celzott', szerep: aud.szerep || [], tagozat: aud.tagozat || [], kepzesi_szint: aud.kepzesi_szint || [],
           kar: aud.kar || [], szak: aud.szak || [], kurzus: tet('kurzus'), csoport: tet('csoport'), szemely: tet('szemely') };
}
const SHOP_helyiIdo = (iso) => { if (!iso) return ''; try { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); } catch (e) { return ''; } };

/* A változatmátrix: a tulajdonságok értékeinek minden kombinációja egy sor.
   A meglévő sorok (azonos tulajdonságokkal) megtartják a cikkszámukat,
   árukat és készletüket — újragenerálás nem töröl adatot. */
function SHOP_valtozatMatrix(tulajdonsagok, meglevo) {
  const tul = (tulajdonsagok || []).map(([nev, ertekek]) => [String(nev || '').trim(),
    String(ertekek || '').split(',').map(x => x.trim()).filter(Boolean)]).filter(([n, e]) => n && e.length);
  if (!tul.length) return meglevo || [];
  let kombok = [{}];
  tul.forEach(([nev, ertekek]) => { kombok = kombok.flatMap(k => ertekek.map(e => ({ ...k, [nev]: e }))); });
  const kulcs = (t) => JSON.stringify(Object.keys(t).sort().map(k => [k, t[k]]));
  const regi = {}; (meglevo || []).forEach(v => { regi[kulcs(v.tulajdonsagok || {})] = v; });
  return kombok.map((t, i) => regi[kulcs(t)] ? { ...regi[kulcs(t)], sorrend: i + 1 }
    : { nev: Object.values(t).join(' · '), tulajdonsagok: t, sku: '', ar_huf: '', keszlet: '', aktiv: true, sorrend: i + 1 });
}

/* Élő előnézet: pontosan az a kártya és termékoldal-fej, amit a hallgató lát. */
function SHOP_Elonezet({ f, kategoriak }) {
  const kep = (f.kepek || []).find(k => String(k.url || '').trim());
  const aktivValt = (f.valtozatok || []).filter(v => v.aktiv !== false && String(v.nev || '').trim());
  const arak = [Number(f.ar_huf) || 0].concat(aktivValt.map(v => v.ar_huf === '' || v.ar_huf == null ? Number(f.ar_huf) || 0 : Number(v.ar_huf)));
  const tol = aktivValt.length ? Math.min.apply(null, arak.slice(1)) : Number(f.ar_huf) || 0;
  const r = f.reszletek || {};
  return (
    <div className="space-y-3" data-shop-elonezet="1">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Élő előnézet — így látja a hallgató</p>
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="aspect-[4/3] bg-slate-50 flex items-center justify-center text-slate-300 overflow-hidden">
          {kep && typeof FEED_img === 'function' ? FEED_img(kep.url, 'w-full h-full object-cover') : <SHOP_SablonIkon sablon={f.sablon} size={40} />}
        </div>
        <div className="p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{(SHOP_SABLONOK[f.sablon] || {}).cimke}{f.kurzus ? ' · ' + (f.kurzus.kod || '') : ''}</p>
          <p className="text-[15px] font-black text-slate-900 leading-snug mt-0.5">{f.nev || 'Névtelen termék'}</p>
          <div className="flex items-center justify-between gap-2 mt-3">
            <span className="text-lg font-black text-slate-900 tabular-nums">{SHOP_ft(tol)}{aktivValt.length > 1 && new Set(arak.slice(1)).size > 1 ? '-tól' : ''}</span>
            {f.jovahagyas_kell ? <UBadge tone="amber">jóváhagyással</UBadge> : aktivValt.length > 1 ? <UBadge tone="blue">{aktivValt.length + ' változat'}</UBadge> : null}
          </div>
        </div>
      </div>
      {(r.datum || r.helyszin || r.szerzo || r.telephely) && (
        <div className="text-[11px] text-slate-500 font-medium space-y-0.5">
          {r.datum && <p><b>Időpont:</b> {r.datum}</p>}{r.helyszin && <p><b>Helyszín:</b> {r.helyszin}</p>}
          {r.szerzo && <p><b>Szerző:</b> {r.szerzo}</p>}{r.telephely && <p><b>Telephely:</b> {r.telephely}</p>}
        </div>
      )}
      {f.teljesites === 'atvetel' && f.atveteli_hely && <p className="text-[11px] text-slate-500"><b>Átvétel:</b> {f.atveteli_hely}</p>}
    </div>
  );
}

function SHOP_TermekSzerkeszto({ termek, kategoriak, onClose, onMentve }) {
  const [f, setF] = useState(SHOP_URES_TERMEK);
  const [tul, setTul] = useState([]);
  const [cel, setCel] = useState(() => SHOP_celAllapot(null));
  const [ful, setFul] = useState('alap');
  const [busy, setBusy] = useState(false);
  const [hiba, setHiba] = useState('');
  const [ok, setOk] = useState('');
  const [feltolt, setFeltolt] = useState('');
  const [valaszt, setValaszt] = useState(false);   // új terméknél: sablonválasztó
  const [kurzQ, setKurzQ] = useState('');
  const [kurzOpc, setKurzOpc] = useState(null);

  useEffect(() => {
    if (!termek) return;
    const uj = !termek.id;
    const valt = Array.isArray(termek.valtozatok) ? termek.valtozatok.map(v => ({ ...v,
      ar_huf: v.ar_huf == null ? '' : String(v.ar_huf), keszlet: v.keszlet == null ? '' : String(v.keszlet) })) : [];
    setF({ ...SHOP_URES_TERMEK, ...termek,
      ar_huf: termek.ar_huf == null ? '' : String(termek.ar_huf), keszlet: termek.keszlet == null ? '' : String(termek.keszlet),
      max_rendelesenkent: termek.max_rendelesenkent == null ? '' : String(termek.max_rendelesenkent),
      category_id: termek.category_id || '', kurzus_id: termek.kurzus_id || '', mezok: Array.isArray(termek.mezok) ? termek.mezok : [],
      kepek: Array.isArray(termek.kepek) && termek.kepek.length ? termek.kepek : (termek.kep_url ? [{ url: termek.kep_url }] : []),
      valtozatok: valt, reszletek: termek.reszletek || {}, ertekesites_tol: SHOP_helyiIdo(termek.ertekesites_tol),
      ertekesites_ig: SHOP_helyiIdo(termek.ertekesites_ig), atveteli_hely: termek.atveteli_hely || '', fajl_utvonal: termek.fajl_utvonal || '' });
    // A tulajdonságok a meglévő változatokból olvashatók vissza.
    const kulcsok = {}; valt.forEach(v => Object.entries(v.tulajdonsagok || {}).forEach(([k, e]) => { (kulcsok[k] = kulcsok[k] || []).includes(e) || kulcsok[k].push(e); }));
    setTul(Object.keys(kulcsok).length ? Object.entries(kulcsok).map(([k, e]) => [k, e.join(', ')]) : []);
    setCel(SHOP_celAllapot(termek.celkozonseg)); setHiba(''); setOk(''); setFeltolt(''); setFul('alap'); setValaszt(uj);
  }, [termek]);

  useEffect(() => {
    if (!termek || ful !== 'alap') return;
    let el = true;
    const t = setTimeout(() => {
      SHOP_rpc('shop_course_options', { p_q: kurzQ || null }).then(d => { if (el) setKurzOpc(Array.isArray(d) ? d : []); }).catch(() => { if (el) setKurzOpc([]); });
    }, 300);
    return () => { el = false; clearTimeout(t); };
  }, [kurzQ, ful, termek]);

  if (!termek) return null;
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const setR = (k, v) => setF(p => ({ ...p, reszletek: { ...(p.reszletek || {}), [k]: v } }));
  const sablon = SHOP_SABLONOK[f.sablon] || SHOP_SABLONOK.szolgaltatas;
  const hianyok = SHOP_hianyok(f);

  const sablonValaszt = (k) => {
    const s = SHOP_SABLONOK[k];
    setF(p => ({ ...p, sablon: k, ...s.alap, max_rendelesenkent: s.alap.max_rendelesenkent || '', mezok: s.alap.mezok.map(m => ({ ...m })) }));
    setTul(s.alap.tulajdonsagok ? s.alap.tulajdonsagok.map(x => x.slice()) : []);
    setValaszt(false);
  };
  const matrix = () => setF(p => ({ ...p, valtozatok: SHOP_valtozatMatrix(tul, p.valtozatok) }));
  const setV = (i, k, v) => setF(p => ({ ...p, valtozatok: p.valtozatok.map((x, j) => j === i ? { ...x, [k]: v } : x) }));

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

  const ment = async (statusz) => {
    setBusy(true); setHiba(''); setOk('');
    try {
      const aud = typeof FEED_celNormal === 'function' ? FEED_celNormal(cel) : null;
      const szam = (x) => (x === '' || x == null ? null : Number(x));
      const d = await SHOP_rpc('shop_product_save', { p: {
        id: f.id || null, nev: f.nev, sku: f.sku, leiras: f.leiras, category_id: f.category_id || null, sablon: f.sablon,
        ar_huf: szam(f.ar_huf), afa_kulcs: f.afa_kulcs, keszlet: szam(f.keszlet), max_rendelesenkent: szam(f.max_rendelesenkent),
        jovahagyas_kell: !!f.jovahagyas_kell, fajl_utvonal: f.fajl_utvonal || null, celkozonseg: aud, sorrend: szam(f.sorrend) || 100,
        reszletek: f.reszletek || {}, teljesites: f.teljesites, atveteli_hely: f.atveteli_hely || null, kurzus_id: f.kurzus_id || null,
        ertekesites_tol: f.ertekesites_tol ? new Date(f.ertekesites_tol).toISOString() : null,
        ertekesites_ig: f.ertekesites_ig ? new Date(f.ertekesites_ig).toISOString() : null,
        statusz,
        mezok: (f.mezok || []).filter(m => m.cimke).map(m => ({ ...m, kulcs: m.kulcs || m.cimke.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_') })),
        kepek: (f.kepek || []).filter(k => String(k.url || '').trim()).map(k => ({ url: k.url.trim(), alt: k.alt || null })),
        valtozatok: (f.valtozatok || []).map(v => ({ id: v.id || null, nev: v.nev, tulajdonsagok: v.tulajdonsagok || {}, sku: v.sku || null,
          ar_huf: szam(v.ar_huf), keszlet: szam(v.keszlet), aktiv: v.aktiv !== false, sorrend: v.sorrend || 100 })) } });
      setOk(statusz === 'kozzetett' ? 'Közzétéve — a hallgatók már látják.' : statusz === 'archivalt' ? 'Archiválva.' : 'Vázlat mentve.');
      onMentve(d, statusz === 'vazlat');
      if (d && d.id) setF(p => ({ ...p, id: d.id, statusz: d.statusz,
        valtozatok: (d.valtozatok || []).map(v => ({ ...v, ar_huf: v.ar_huf == null ? '' : String(v.ar_huf), keszlet: v.keszlet == null ? '' : String(v.keszlet) })) }));
    } catch (e) {
      const m = (e && e.message) || '';
      const t = m.match(/SHOP_PUBLISH_MISSING: (.+)/);
      setHiba(t ? 'A közzétételhez még hiányzik: ' + t[1].split(', ').map(x => SHOP_HIANY_NEV[x] || x).join(', ') + '.' : SHOP_msg(e));
    } finally { setBusy(false); }
  };

  const fulek = [['alap', 'Alapadatok'], ['ar', 'Ár és ÁFA'], ['valtozat', 'Változatok és készlet'], ['adatok', 'Bekért adatok'],
                 ['teljesites', 'Teljesítés'], ['lathatosag', 'Láthatóság']];
  const [stC, stT] = SHOP_STATUSZ[f.statusz] || SHOP_STATUSZ.vazlat;

  return (
    <UModal open={!!termek} onClose={onClose} max="max-w-6xl" icon={<SHOP_SablonIkon sablon={f.sablon} size={20} />}
      title={f.id ? 'Termék szerkesztése' : 'Új termék'} subtitle={sablon.cimke + ' sablon'}>
      {valaszt ? (
        <div className="space-y-4" data-shop-sablonvalaszto="1">
          <p className="text-sm text-slate-500">Válaszd ki, milyen terméket viszel fel. A sablon előtölti a szükséges mezőket — minden átírható.</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(SHOP_SABLONOK).map(([k, s]) => (
              <button key={k} type="button" onClick={() => sablonValaszt(k)} data-shop-sablon={k}
                className="text-left rounded-2xl border border-slate-100 p-4 hover:border-primary hover:bg-primary/5 transition-all">
                <span className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-2"><SHOP_SablonIkon sablon={k} size={17} /></span>
                <span className="block text-sm font-black text-slate-800">{s.cimke}</span>
                <span className="block text-[11px] text-slate-400 mt-0.5">{s.leiras}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
      <div className="space-y-4" data-shop-termek-szerkeszto="1">
        <div className="flex flex-wrap items-center gap-2">
          <span data-shop-statusz={f.statusz}><UBadge tone={stT}>{stC}</UBadge></span>
          <span className="flex-1" />
          <button className={U_btnGhost + ' py-2 text-[12px]'} disabled={busy} onClick={() => ment('vazlat')} data-shop-ment-vazlat="1"><Lucide.Save size={14} /> Mentés vázlatként</button>
          {f.id && f.statusz === 'kozzetett' && (
            <button className={U_btnGhost + ' py-2 text-[12px]'} disabled={busy} onClick={() => ment('archivalt')}><Lucide.Archive size={14} /> Archiválás</button>
          )}
          <button className={U_btnPrimary + ' py-2 text-[12px]'} disabled={busy} onClick={() => ment('kozzetett')} data-shop-kozzetesz="1">
            <Lucide.Send size={14} /> {f.statusz === 'kozzetett' ? 'Mentés és közzétéve marad' : 'Közzététel'}
          </button>
        </div>
        {hiba && <p className="text-[12px] font-bold text-red-600" role="alert" data-shop-szerk-hiba="1">{hiba}</p>}
        {ok && <p className="text-[12px] font-bold text-emerald-700" data-shop-szerk-ok="1">{ok}</p>}

        <div className="flex flex-wrap gap-1 border-b border-slate-100">
          {fulek.map(([k, c]) => (
            <button key={k} type="button" onClick={() => setFul(k)} data-shop-szerk-ful={k}
              className={'px-3 py-2 text-[12px] font-black border-b-2 transition-colors ' + (ful === k ? 'border-primary text-primary' : 'border-transparent text-slate-400 hover:text-slate-600')}>{c}</button>
          ))}
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr),300px] gap-6">
          <div className="space-y-4 min-w-0">
            {ful === 'alap' && (<>
              <div className="grid sm:grid-cols-2 gap-3">
                <UField label="Név *"><input className={U_input} value={f.nev} onChange={e => set('nev', e.target.value)} data-shop-f-nev="1" /></UField>
                <UField label="Cikkszám (SKU)"><input className={U_input} value={f.sku || ''} onChange={e => set('sku', e.target.value)} /></UField>
              </div>
              <UField label="Leírás"><textarea className={U_input + ' min-h-[90px]'} value={f.leiras || ''} onChange={e => set('leiras', e.target.value)} /></UField>
              <div className="grid sm:grid-cols-3 gap-3">
                <UField label="Sablon">
                  <select className={U_input} value={f.sablon} onChange={e => set('sablon', e.target.value)}>
                    {Object.entries(SHOP_SABLONOK).map(([k, s]) => <option key={k} value={k}>{s.cimke}</option>)}
                  </select>
                </UField>
                <UField label="Kategória">
                  <select className={U_input} value={f.category_id} onChange={e => set('category_id', e.target.value)}>
                    <option value="">— nincs —</option>
                    {(kategoriak || []).map(c => <option key={c.id} value={c.id}>{c.nev}</option>)}
                  </select>
                </UField>
                <UField label="Sorrend a boltban"><input type="number" className={U_input} value={f.sorrend} onChange={e => set('sorrend', e.target.value)} /></UField>
              </div>
              {sablon.reszletek.length > 0 && (
                <div className="grid sm:grid-cols-2 gap-3">
                  {sablon.reszletek.map(([k, c]) => (
                    <UField key={k} label={c}><input className={U_input} value={(f.reszletek || {})[k] || ''} onChange={e => setR(k, e.target.value)} data-shop-r={k} /></UField>
                  ))}
                </div>
              )}
              <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-black text-slate-800">Képek <span className="text-slate-400 font-bold">— az első a borítókép</span></p>
                  <button type="button" className="text-[11px] font-black text-primary hover:underline" onClick={() => set('kepek', (f.kepek || []).concat([{ url: '' }]))} data-shop-uj-kep="1">+ Kép</button>
                </div>
                {(f.kepek || []).length === 0 && <p className="text-[11px] text-slate-300 font-bold italic">nincs kép</p>}
                {(f.kepek || []).map((k, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input className={U_input + ' py-1.5 text-[12px] flex-1'} value={k.url} placeholder="https://…" data-shop-kep={i}
                      onChange={e => set('kepek', f.kepek.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
                    <button type="button" disabled={i === 0} className="text-slate-300 hover:text-slate-600 disabled:opacity-30" title="Előre"
                      onClick={() => set('kepek', [f.kepek[i]].concat(f.kepek.filter((_, j) => j !== i)))}><Lucide.ArrowUpToLine size={14} /></button>
                    <button type="button" className="text-slate-300 hover:text-red-500" onClick={() => set('kepek', f.kepek.filter((_, j) => j !== i))}><Lucide.X size={14} /></button>
                  </div>
                ))}
              </div>
              <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
                <p className="text-[12px] font-black text-slate-800">Kurzus <span className="text-slate-400 font-bold">— a kurzus hallgatóinak „Neked” ajánlás</span></p>
                {f.kurzus_id ? (
                  <div className="flex items-center gap-2">
                    <UBadge tone="blue">{f.kurzus ? (f.kurzus.kod || f.kurzus.cimke) + (f.kurzus.nev ? ' · ' + f.kurzus.nev : '') : f.kurzus_id.slice(0, 8)}</UBadge>
                    <button type="button" className="text-[11px] font-black text-slate-400 hover:text-red-500" onClick={() => setF(p => ({ ...p, kurzus_id: '', kurzus: null }))}>eltávolítás</button>
                  </div>
                ) : (<>
                  <input className={U_input + ' py-1.5 text-[12px]'} value={kurzQ} onChange={e => setKurzQ(e.target.value)} placeholder="Keresés kurzuskód vagy név szerint…" />
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {(kurzOpc || []).slice(0, 8).map(k => (
                      <button key={k.id} type="button" className="w-full text-left px-3 py-1.5 rounded-xl border border-slate-100 hover:border-primary text-[12px] font-bold text-slate-600"
                        onClick={() => setF(p => ({ ...p, kurzus_id: k.id, kurzus: { kod: k.cimke.split(' · ')[0], nev: k.cimke.split(' · ').slice(1).join(' · ') } }))}>
                        {k.cimke} <span className="text-slate-400 font-medium">· {k.reszlet}</span>
                      </button>
                    ))}
                  </div>
                </>)}
              </div>
            </>)}

            {ful === 'ar' && (
              <div className="grid sm:grid-cols-3 gap-3">
                <UField label="Bruttó ár (Ft) *"><input type="number" min="0" className={U_input} value={f.ar_huf} onChange={e => set('ar_huf', e.target.value)} data-shop-f-ar="1" /></UField>
                <UField label="ÁFA-kulcs" hint="a Pénzügy határozza meg">
                  <select className={U_input} value={f.afa_kulcs} onChange={e => set('afa_kulcs', e.target.value)}>
                    {['27', '18', '5', '0', 'AAM', 'TAM'].map(k => <option key={k} value={k}>{/^\d+$/.test(k) ? k + '%' : k}</option>)}
                  </select>
                </UField>
                <UField label="Max / rendelés"><input type="number" min="1" className={U_input} value={f.max_rendelesenkent} onChange={e => set('max_rendelesenkent', e.target.value)} /></UField>
              </div>
            )}

            {ful === 'valtozat' && (<>
              <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-black text-slate-800">Tulajdonságok</p>
                  <button type="button" className="text-[11px] font-black text-primary hover:underline" onClick={() => setTul(tul.concat([['', '']]))}>+ Tulajdonság</button>
                </div>
                {tul.length === 0 && <p className="text-[11px] text-slate-400">Nincs változat — a termék egy darabban árulható, a készlet lent állítható.</p>}
                {tul.map(([n, e], i) => (
                  <div key={i} className="grid grid-cols-[140px,1fr,auto] gap-2 items-center">
                    <input className={U_input + ' py-1.5 text-[12px]'} value={n} placeholder="pl. Méret" onChange={x => setTul(tul.map((t, j) => j === i ? [x.target.value, t[1]] : t))} />
                    <input className={U_input + ' py-1.5 text-[12px]'} value={e} placeholder="értékek vesszővel: S, M, L" data-shop-tul={i} onChange={x => setTul(tul.map((t, j) => j === i ? [t[0], x.target.value] : t))} />
                    <button type="button" className="text-slate-300 hover:text-red-500" onClick={() => setTul(tul.filter((_, j) => j !== i))}><Lucide.X size={14} /></button>
                  </div>
                ))}
                {tul.length > 0 && (
                  <button type="button" className={U_btnGhost + ' py-1.5 text-[12px]'} onClick={matrix} data-shop-matrix="1"><Lucide.Grid3x3 size={14} /> Változatok létrehozása / frissítése</button>
                )}
              </div>
              {(f.valtozatok || []).length > 0 ? (
                <div className="rounded-2xl border border-slate-100 overflow-x-auto" data-shop-valtozatok="1">
                  <table className="w-full text-left text-[12px]">
                    <thead><tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      <th className="px-3 py-2">Változat</th><th className="px-3 py-2">Cikkszám</th><th className="px-3 py-2">Ár (üres = alapár)</th><th className="px-3 py-2">Készlet (üres = ∞)</th><th className="px-3 py-2">Árulva</th>
                    </tr></thead>
                    <tbody>
                      {f.valtozatok.map((v, i) => (
                        <tr key={i} className={'border-t border-slate-50 ' + (v.aktiv === false ? 'opacity-50' : '')}>
                          <td className="px-3 py-2 font-bold text-slate-700">{v.nev}</td>
                          <td className="px-3 py-2"><input className={U_input + ' py-1 text-[12px] font-mono'} value={v.sku || ''} onChange={e => setV(i, 'sku', e.target.value)} /></td>
                          <td className="px-3 py-2"><input type="number" min="0" className={U_input + ' py-1 text-[12px] w-28'} value={v.ar_huf} onChange={e => setV(i, 'ar_huf', e.target.value)} /></td>
                          <td className="px-3 py-2"><input type="number" min="0" className={U_input + ' py-1 text-[12px] w-24'} value={v.keszlet} onChange={e => setV(i, 'keszlet', e.target.value)} data-shop-v-keszlet={i} /></td>
                          <td className="px-3 py-2"><input type="checkbox" checked={v.aktiv !== false} onChange={e => setV(i, 'aktiv', e.target.checked)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <UField label="Készlet" hint="üres = korlátlan"><input type="number" min="0" className={U_input + ' w-40'} value={f.keszlet} onChange={e => set('keszlet', e.target.value)} /></UField>
              )}
              <p className="text-[11px] text-slate-400">A már megrendelt változat nem törlődik, csak kikerül az árulásból — a régi rendelések így hiánytalanok maradnak.</p>
            </>)}

            {ful === 'adatok' && (
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
                <label className="flex items-center gap-2.5 text-sm font-bold text-slate-600 cursor-pointer pt-2">
                  <input type="checkbox" checked={!!f.jovahagyas_kell} onChange={e => set('jovahagyas_kell', e.target.checked)} className="w-4 h-4 accent-primary" />
                  Jóváhagyáshoz kötött — a vevő csak jóváhagyás után fizet
                </label>
              </div>
            )}

            {ful === 'teljesites' && (<>
              <UField label="Teljesítés módja">
                <select className={U_input} value={f.teljesites} onChange={e => set('teljesites', e.target.value)} data-shop-f-teljesites="1">
                  {Object.entries(SHOP_TELJESITES).map(([k, c]) => <option key={k} value={k}>{c}</option>)}
                </select>
              </UField>
              {f.teljesites === 'atvetel' && (
                <UField label="Átvételi hely és nyitvatartás *"><input className={U_input} value={f.atveteli_hely} onChange={e => set('atveteli_hely', e.target.value)}
                  placeholder="pl. Jegyzetbolt, A épület földszint · H–Cs 9–15" data-shop-f-atvetel="1" /></UField>
              )}
              {(f.sablon === 'digitalis_jegyzet' || f.teljesites === 'letoltes') && (
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
            </>)}

            {ful === 'lathatosag' && (<>
              <div className="grid sm:grid-cols-2 gap-3">
                <UField label="Árulás kezdete" hint="üres = azonnal"><input type="datetime-local" className={U_input} value={f.ertekesites_tol} onChange={e => set('ertekesites_tol', e.target.value)} /></UField>
                <UField label="Árulás vége" hint="üres = visszavonásig"><input type="datetime-local" className={U_input} value={f.ertekesites_ig} onChange={e => set('ertekesites_ig', e.target.value)} /></UField>
              </div>
              {typeof FEED_CelkozonsegValaszto === 'function' && <FEED_CelkozonsegValaszto ertek={cel} onValt={setCel} />}
            </>)}
          </div>

          <div className="space-y-4">
            <SHOP_Elonezet f={f} kategoriak={kategoriak} />
            <div className={'rounded-2xl p-3 text-[12px] font-bold ' + (hianyok.length ? 'bg-amber-50 text-amber-800 border border-amber-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100')} data-shop-hianyok={hianyok.join(',')}>
              {hianyok.length ? 'Közzétételhez még hiányzik: ' + hianyok.map(x => SHOP_HIANY_NEV[x] || x).join(', ') + '.' : 'Közzétehető.'}
            </div>
          </div>
        </div>
      </div>
      )}
    </UModal>
  );
}

function SHOP_Katalogus({ adat, onFrissit }) {
  const [szerk, setSzerk] = useState(null);
  const [ujKat, setUjKat] = useState('');
  const [err, setErr] = useState('');
  const [szuro, setSzuro] = useState('');
  const kategoriak = (adat && adat.kategoriak) || [];
  const katNev = (id) => (kategoriak.find(c => c.id === id) || {}).nev || '—';
  const termekek = ((adat && adat.termekek) || []).filter(t => !szuro || t.statusz === szuro);
  const db = (s) => ((adat && adat.termekek) || []).filter(t => t.statusz === s).length;
  const katMent = async (p) => { try { setErr(''); await SHOP_rpc('shop_category_save', { p }); setUjKat(''); onFrissit(); } catch (e) { setErr(SHOP_msg(e)); } };
  const masol = async (t) => { try { setErr(''); const d = await SHOP_rpc('shop_product_copy', { p_id: t.id }); onFrissit(); setSzerk(d); } catch (e) { setErr(SHOP_msg(e)); } };
  const keszletSzoveg = (t) => {
    const v = (t.valtozatok || []).filter(x => x.aktiv);
    if (!v.length) return t.keszlet == null ? '∞' : String(t.keszlet);
    if (v.some(x => x.keszlet == null)) return '∞';
    return String(v.reduce((s, x) => s + (x.keszlet || 0), 0)) + ' (' + v.length + ' vált.)';
  };
  return (
    <div className="grid lg:grid-cols-[1fr,300px] gap-4 mt-5" data-shop-admin-katalogus="1">
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <p className="text-sm font-black text-slate-800">Termékek <span className="text-slate-400">({((adat && adat.termekek) || []).length})</span></p>
          <div className="flex flex-wrap gap-1.5">
            {[['', 'Mind'], ['vazlat', 'Vázlat · ' + db('vazlat')], ['kozzetett', 'Közzétéve · ' + db('kozzetett')], ['archivalt', 'Archivált · ' + db('archivalt')]].map(([k, c]) => (
              <button key={k || 'mind'} onClick={() => setSzuro(k)} data-shop-statusz-szuro={k || 'mind'}
                className={'px-2.5 py-1 rounded-xl border text-[11px] font-bold ' + (szuro === k ? 'border-primary bg-primary/10 text-primary' : 'border-slate-100 text-slate-500 hover:border-slate-300')}>{c}</button>
            ))}
          </div>
          <button className={U_btnPrimary + ' py-2 text-[12px]'} onClick={() => setSzerk({ ...SHOP_URES_TERMEK })} data-shop-uj-termek="1"><Lucide.Plus size={14} /> Új termék</button>
        </div>
        {err && <p className="px-5 pt-3 text-[12px] font-bold text-red-600">{err}</p>}
        {termekek.length === 0 ? <UEmpty icon={<Lucide.Package size={26} />} title="Nincs ilyen termék" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                <th className="px-5 py-2">Termék</th><th className="px-3 py-2">Kategória</th><th className="px-3 py-2 text-right">Ár</th>
                <th className="px-3 py-2 text-right">Készlet</th><th className="px-3 py-2 text-right">Eladva</th><th className="px-3 py-2">Állapot</th><th className="px-3 py-2"></th>
              </tr></thead>
              <tbody>
                {termekek.map(t => {
                  const [c, tone] = SHOP_STATUSZ[t.statusz] || SHOP_STATUSZ.vazlat;
                  return (
                    <tr key={t.id} className="border-t border-slate-50 hover:bg-slate-50/70" data-shop-admin-termek={t.id}>
                      <td className="px-5 py-3 cursor-pointer" onClick={() => setSzerk(t)}>
                        <p className="text-[13px] font-black text-slate-800 flex items-center gap-2"><SHOP_SablonIkon sablon={t.sablon} size={14} /> {t.nev}</p>
                        <p className="text-[10px] font-bold text-slate-400">{(SHOP_SABLONOK[t.sablon] || {}).cimke || t.tipus}{t.kurzus ? ' · ' + t.kurzus.kod : ''}{t.jovahagyas_kell ? ' · jóváhagyással' : ''}{t.celkozonseg ? ' · célzott' : ''}</p>
                      </td>
                      <td className="px-3 py-3 text-[12px] text-slate-600">{katNev(t.category_id)}</td>
                      <td className="px-3 py-3 text-right text-[13px] font-black text-slate-800 tabular-nums">{SHOP_ft(t.ar_huf)}</td>
                      <td className="px-3 py-3 text-right text-[12px] font-bold text-slate-600 tabular-nums">{keszletSzoveg(t)}</td>
                      <td className="px-3 py-3 text-right text-[12px] font-bold text-slate-600 tabular-nums">{t.eladott_db || 0}</td>
                      <td className="px-3 py-3">
                        <UBadge tone={tone}>{c}</UBadge>
                        {t.statusz === 'vazlat' && (t.hianyok || []).length > 0 && <p className="text-[10px] font-bold text-amber-700 mt-1">hiányzik: {(t.hianyok || []).map(x => SHOP_HIANY_NEV[x] || x).join(', ')}</p>}
                        {t.statusz === 'kozzetett' && !t.arusithato && <p className="text-[10px] font-bold text-slate-400 mt-1">időablakon kívül</p>}
                      </td>
                      <td className="px-3 py-3"><button onClick={() => masol(t)} className="text-slate-300 hover:text-primary" title="Másolat vázlatként" data-shop-masol={t.id}><Lucide.Copy size={14} /></button></td>
                    </tr>
                  );
                })}
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
      <SHOP_TermekSzerkeszto termek={szerk} kategoriak={kategoriak} onClose={() => setSzerk(null)}
        onMentve={() => { onFrissit(); }} />
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
