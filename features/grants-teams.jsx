/* ============================================================================
   grants-teams.jsx — bevonási dashboard, illesztés arculatokra, csapatajánlás
   ----------------------------------------------------------------------------
   Migrációk: 88 (felkérési napló + bevonási méltányosság), 89 (szemantikus
   illesztés, arculatok), 90 (csapatajánlás lefedéssel).

   HÁROM NÉZET, HÁROM KÖZÖNSÉG:
     GRTT_BevonasView      — az iroda és a kari vezető: ki hol tart, kit nem
                             vontunk be még. Ez a modul lényege.
     GRTT_CsapatView       — egy felhívás: arculatok, illesztés, 2–3
                             csapatváltozat, felkérés a javaslatból.
     GRTT_SajatFelkeresek  — a kollégáé: a saját felkérései és a válasza.

   AMIT SZÁNDÉKOSAN NEM MUTATUNK: kollégák egymáshoz mért rangsorát és egyéni
   sikerarányt. A felkérési napló nem teljesítményértékelés — azért van, hogy
   több embert vonjunk be.

   A grants.jsx UTÁN kell állnia a bundle-ban: onnan veszi a GRT_msg-et és a
   közös U_* atomokat.
   ========================================================================= */

async function GRTT_rpc(fn, args) {
  if (!window.sb) throw new Error('Nincs kapcsolat a háttérrendszerrel.');
  const { data, error } = await window.sb.rpc(fn, args || {});
  if (error) throw error;
  return data;
}

const GRTT_api = {
  stats:      (ev)              => GRTT_rpc('grants_participation_stats', { p_ev: ev || null }),
  sosem:      (kar, q, n)       => GRTT_rpc('grants_never_invited', {
                                     p_kar: kar || null, p_kereses: q || null, p_limit: n || 50 }),
  invites:    (p)               => GRTT_rpc('grants_invite_list', {
                                     p_call: p.call || null, p_researcher: p.researcher || null,
                                     p_allapot: p.allapot || null, p_kar: p.kar || null,
                                     p_limit: p.limit || 200 }),
  callView:   (id)              => GRTT_rpc('grants_invite_call_view', { p_call: id }),
  inviteNew:  (adat)            => GRTT_rpc('grants_invite_create', { p_adat: adat }),
  inviteSet:  (id, a, m)        => GRTT_rpc('grants_invite_set', {
                                     p_id: id, p_allapot: a, p_megjegyzes: m || null }),
  inviteUpd:  (adat)            => GRTT_rpc('grants_invite_update', { p_adat: adat }),
  expire:     ()                => GRTT_rpc('grants_invite_expire'),
  history:    (id)              => GRTT_rpc('grants_invite_history', { p_id: id }),
  mine:       ()                => GRTT_rpc('grants_my_invites'),
  respond:    (id, v, m)        => GRTT_rpc('grants_invite_respond', {
                                     p_id: id, p_valasz: v, p_megjegyzes: m || null }),
  calls:      (q)               => GRTT_rpc('grants_calls', {
                                     p_q: q || null, p_allapot: 'nyitott', p_program: null,
                                     p_source: null, p_napon_belul: null, p_limit: 40, p_offset: 0 }),
  facets:     (id)              => GRTT_rpc('grants_call_facets', { p_call: id }),
  facetsSave: (id, items)       => GRTT_rpc('grants_facets_save', { p_call: id, p_items: items }),
  match:      (id, csak)        => GRTT_rpc('grants_call_match', {
                                     p_call: id, p_csak_nyitott: !!csak }),
  matches:    (id, n)           => GRTT_rpc('grants_call_matches', {
                                     p_call: id, p_facet: null, p_limit: n || 8 }),
  resMatches: (id, n)           => GRTT_rpc('grants_researcher_matches', { p_researcher: id, p_limit: n || 5 }),
  teams:      (id)              => GRTT_rpc('grants_teams', { p_call: id }),
  overview:   (q, n)            => GRTT_rpc('grants_team_overview', {
                                     p_q: q || null, p_limit: n || 40, p_csak_javaslattal: false }),
  suggest:    (id, csak)        => GRTT_rpc('grants_team_suggest', {
                                     p_call: id, p_csak_nyitott: !!csak }),
  teamInvite: (id)              => GRTT_rpc('grants_team_invite', { p_id: id }),
  teamDelete: (id)              => GRTT_rpc('grants_team_delete', { p_id: id }),
  semantic:   ()                => GRTT_rpc('grants_semantic_stats'),
  rebuild:    (mit)             => GRTT_rpc('grants_semantic_rebuild', { p_mit: mit || 'mind' }),
  gaps:       (n)               => GRTT_rpc('grants_coauthor_gaps', { p_limit: n || 20 }),
  partnerCalls:(q, n, hiany)    => GRTT_rpc('grants_partner_calls', {
                                     p_q: q || null, p_limit: n || 40, p_csak_hiany: !!hiany }),
  scoringGet: ()                => GRTT_rpc('grants_scoring_get'),
  scoringSave:(ertekek, ujra)   => GRTT_rpc('grants_scoring_save', {
                                     p_ertekek: ertekek, p_ujraszamol: !!ujra }),
};

/* Az állapotsor. A 'visszalepett' és a 'lejart' KÜLÖN állapot: az első döntés,
   a második elmaradt ügyintézés — és a kettő mást jelent az irodának. */
const GRTT_ALLAPOT = {
  javasolt:     { cim: 'Javasolt',      o: 'bg-slate-100 text-slate-600' },
  felkerve:     { cim: 'Felkérve',      o: 'bg-sky-100 text-sky-700' },
  elfogadta:    { cim: 'Elfogadta',     o: 'bg-emerald-100 text-emerald-700' },
  visszalepett: { cim: 'Visszalépett',  o: 'bg-rose-100 text-rose-700' },
  lejart:       { cim: 'Lejárt',        o: 'bg-amber-100 text-amber-700' },
  beadva:       { cim: 'Beadva',        o: 'bg-indigo-100 text-indigo-700' },
  nyert:        { cim: 'Nyert',         o: 'bg-emerald-600 text-white' },
  nem_nyert:    { cim: 'Nem nyert',     o: 'bg-slate-200 text-slate-600' },
  visszavonva:  { cim: 'Visszavonva',   o: 'bg-slate-100 text-slate-400' },
};

/* Milyen állapotba lehet innen lépni — ugyanaz a szabály, mint a szerveren
   (grants.invite_atmenet_ok). A szerver dönt; ez csak nem kínál fel olyat,
   amit a szerver elutasítana. */
const GRTT_ATMENET = {
  javasolt:     ['felkerve', 'visszavonva'],
  felkerve:     ['elfogadta', 'visszalepett', 'lejart', 'visszavonva'],
  elfogadta:    ['beadva', 'visszalepett', 'visszavonva'],
  lejart:       ['felkerve', 'visszavonva'],
  visszalepett: ['felkerve', 'visszavonva'],
  beadva:       ['nyert', 'nem_nyert', 'visszavonva'],
  nyert:        [],
  nem_nyert:    [],
  visszavonva:  [],
};

const GRTT_SZEREP = { vezeto: 'vezető', tag: 'tag', tanacsado: 'tanácsadó' };

function GRTT_Badge({ allapot }) {
  const a = GRTT_ALLAPOT[allapot] || { cim: allapot, o: 'bg-slate-100 text-slate-500' };
  return <span className={'px-2 py-0.5 rounded-full text-[10px] font-black ' + a.o}>{a.cim}</span>;
}

function GRTT_Szam({ cim, ertek, alcim, tone }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4">
      <p className={'text-2xl font-black ' + (tone || 'text-slate-800')}>{ertek}</p>
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-0.5">{cim}</p>
      {alcim && <p className="text-[11px] text-slate-400 mt-1">{alcim}</p>}
    </div>
  );
}

/* Komponensenkénti pontszám. Egy találat így mindig megmagyarázható: nem
   „87 pont", hanem friss, központi téma, közepes tekintély, szűk kapacitás. */
function GRTT_Komponensek({ m }) {
  const sorok = [
    { c: 'tartalom', v: m.tartalom }, { c: 'frissesség', v: m.frissesseg },
    { c: 'súlypont', v: m.sulypont }, { c: 'tekintély', v: m.tekintely },
    { c: 'kapacitás', v: m.kapacitas }, { c: 'nyitottság', v: m.nyitottsag },
    { c: 'bevonás', v: m.bevonas },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
      {sorok.map(s => (
        <div key={s.c}>
          <div className="flex items-center justify-between text-[10px] font-bold text-slate-400">
            <span>{s.c}</span><span>{Math.round(Number(s.v) || 0)}</span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-primary/70" style={{ width: Math.max(0, Math.min(100, Number(s.v) || 0)) + '%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Illeszkedő felhívások egy kollégához — és felkérés egy kattintással.
   Ez a „még soha nem kértük fel" lista párja: a lista megmondja, KIT, ez pedig,
   hogy MIRE.
   ------------------------------------------------------------------------- */
function GRTT_IlleszkedesModal({ open, kutato, onClose, onFelkerve }) {
  const [lista, setLista] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!open || !kutato) { setLista(null); return; }
    setErr('');
    GRTT_api.resMatches(kutato.id, 8).then(setLista).catch(e => setErr(GRT_msg(e)));
  }, [open, kutato && kutato.id]);

  const felker = async (sor) => {
    setBusy(sor.call_id); setErr('');
    try {
      await GRTT_api.inviteNew({ call_id: sor.call_id, researcher_id: kutato.id,
                                 arculat: sor.arculat || null, szerep: 'tag', allapot: 'javasolt' });
      if (onFelkerve) onFelkerve();
      const friss = await GRTT_api.resMatches(kutato.id, 8);
      setLista(friss);
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  return (
    <UModal open={open} onClose={onClose} max="max-w-2xl"
      icon={<Lucide.Target size={18} />}
      title={kutato ? kutato.nev : 'Illeszkedő felhívások'}
      subtitle="Melyik nyitott felhívás melyik arculatához illeszkedik">
      {err && <p className="text-xs text-rose-600 font-bold mb-3">{err}</p>}
      {!lista && !err && <p className="text-sm text-slate-400">Betöltés…</p>}
      {lista && lista.length === 0 && (
        <p className="text-sm text-slate-500">
          {'Ehhez a kollégához egyelőre nincs illesztési találat. Ez nem jelenti, hogy nem alkalmas: '
           + 'vagy nincs még publikációs adata, vagy a nyitott felhívásokat még nem bontottuk arculatokra.'}
        </p>
      )}
      <div className="space-y-2">
        {(lista || []).map(s => (
          <div key={s.call_id + (s.arculat || '')} className="bg-slate-50 rounded-xl p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">{s.felhivas}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {`arculat: ${s.arculat || '—'} · illeszkedés ${Math.round(Number(s.ossz) || 0)} pont · `
                   + `${s.ut === 'vektor' ? 'beágyazás alapján' : 'szóegyezés alapján'}`}
                </p>
              </div>
              {s.felkerve
                ? <span className="text-[10px] font-black text-emerald-600 whitespace-nowrap">már felkérve</span>
                : <button className={U_btnGhost + ' !px-3 !py-1.5 text-xs whitespace-nowrap'}
                    disabled={busy === s.call_id} onClick={() => felker(s)}>
                    <Lucide.UserPlus size={13} /> Javaslatba
                  </button>}
            </div>
          </div>
        ))}
      </div>
    </UModal>
  );
}

/* ----------------------------------------------------------------------------
   A bevonási dashboard
   ------------------------------------------------------------------------- */

/* ----------------------------------------------------------------------------
   A pontozás hangolása (100_grants_pontozas_ui.sql)
   ----------------------------------------------------------------------------
   MIÉRT A FELÜLETEN: hogy a tekintély vagy a méltányosság mennyit nyomjon a
   latban, az irodai döntés, nem fejlesztői. A két kiemelt szám azt mutatja meg,
   amit a súlyokból önmagában nehéz kiolvasni: melyik komponens dönt valójában.
   ------------------------------------------------------------------------- */
const GRTT_CSOPORT = {
  suly:    { cim: 'Pontszám-súlyok', leiras: 'A hét komponens aránya az összesített pontszámban.' },
  kuszob:  { cim: 'Küszöbök', leiras: 'Ki kerül listára, és mikor tekintünk egy elvárást lefedettnek.' },
  csapat:  { cim: 'Csapatösszeállítás', leiras: 'Méret, döntetlen-sáv, kapacitás alsó határa.' },
  bevonas: { cim: 'Bevonási méltányosság', leiras: 'Mennyivel hozza előre a kevesebbet szerepelt kollégát.' },
};

function GRTT_PontozasBeallitas() {
  const [d, setD] = useState(null);
  const [mod, setMod] = useState({});
  const [ujra, setUjra] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');

  const [nincsTelepitve, setNincsTelepitve] = useState(false);
  const betolt = () => GRTT_api.scoringGet().then(x => { setD(x); setMod({}); })
    .catch(e => { if (GRT_hianyzoFuggveny(e)) setNincsTelepitve(true); else setErr(GRT_msg(e)); });
  useEffect(() => { betolt(); }, []);

  // A migráció még nem futott le: ilyenkor a panel egyszerűen nincs ott, nem
  // pedig hibaüzenetet mutat egy olyan képernyőn, ami egyébként működik.
  if (nincsTelepitve) return null;
  if (err && !d) return <p className="text-xs text-rose-600 font-bold">{err}</p>;
  if (!d) return <p className="text-sm text-slate-400">Betöltés…</p>;

  const ertekek = d.ertekek || [];
  const ertek = (k) => (mod[k] !== undefined ? mod[k] : String(
    (ertekek.find(x => x.kulcs === k) || {}).ertek ?? ''));
  const valtozott = Object.keys(mod).length > 0;

  // A két arány élőben, a beírt értékekből — hogy ne mentés után derüljön ki,
  // mit csinált a módosítás.
  const suly = (k) => Number(ertek(k) || 0);
  const sulyOssz = ertekek.filter(x => x.csoport === 'suly')
    .reduce((a, x) => a + suly(x.kulcs), 0);
  const egySzoras = sulyOssz > 0 ? Math.round(12.5 * suly('pont_suly_tartalom') / sulyOssz * 10) / 10 : 0;
  const bevKileng = sulyOssz > 0 ? Math.round(92 * suly('pont_suly_bevonas') / sulyOssz * 10) / 10 : 0;

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      const r = await GRTT_api.scoringSave(mod, ujra);
      setToast(ujra
        ? `${(r && r.mentve) || 0} beállítás mentve — a találatok a következő gépi körben újraszámolnak.`
        : `${(r && r.mentve) || 0} beállítás mentve.`);
      await betolt();
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 space-y-4">
      {toast && <UToast msg={toast} onDone={() => setToast('')} />}
      <div>
        <h3 className="text-sm font-black text-slate-800">Pontozás és csapatösszeállítás</h3>
        <p className="text-[11px] text-slate-400 font-medium mt-0.5 leading-relaxed">
          {'Ezek a számok döntik el, kit ajánl a rendszer egy felhívásra. A hangolás irodai döntés — '
           + 'a mentés után a találatok a következő gépi körben újraszámolnak.'}
        </p>
      </div>

      <div className={'rounded-2xl p-4 ' + (bevKileng > egySzoras ? 'bg-amber-50 border border-amber-100' : 'bg-slate-50')}>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
          Mi dönt valójában
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xl font-black text-slate-800">{egySzoras}</p>
            <p className="text-[11px] text-slate-500">
              {'pont · egy szórásnyi témakülönbség'}
            </p>
          </div>
          <div>
            <p className={'text-xl font-black ' + (bevKileng > egySzoras ? 'text-amber-600' : 'text-slate-800')}>
              {bevKileng}
            </p>
            <p className="text-[11px] text-slate-500">
              {'pont · a bevonás teljes kilengése'}
            </p>
          </div>
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          {bevKileng > egySzoras
            ? 'A méltányosság jelenleg többet mozdít, mint a szakmai illeszkedés — a kevesebbet szerepelt kolléga megelőzi a témában erősebbet. Ha ezt nem akarod, csökkentsd a bevonás súlyát.'
            : 'A téma dönt, a méltányosság döntetlennél billent. Ez a szándékolt arány.'}
        </p>
      </div>

      {Object.keys(GRTT_CSOPORT).map(cs => (
        <div key={cs}>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
            {GRTT_CSOPORT[cs].cim}
          </p>
          <p className="text-[11px] text-slate-400 mb-2">{GRTT_CSOPORT[cs].leiras}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {ertekek.filter(x => x.csoport === cs).map(x => (
              <label key={x.kulcs} className="flex items-center justify-between gap-3 bg-slate-50 rounded-xl px-3 py-2">
                <span className="text-[12px] font-bold text-slate-600 min-w-0">
                  {x.cimke}
                  <span className="block text-[10px] font-medium text-slate-400">
                    {`alap: ${x.alap} · ${x.min}–${x.max}`}
                  </span>
                </span>
                <input type="number" min={x.min} max={x.max} step={x.tizedes ? 0.1 : 1}
                  className={U_input + ' !w-24 !py-1.5 !px-2 text-sm text-right'}
                  value={ertek(x.kulcs)}
                  onChange={e => setMod({ ...mod, [x.kulcs]: e.target.value })} />
              </label>
            ))}
          </div>
        </div>
      ))}

      {err && <p className="text-xs text-rose-600 font-bold">{err}</p>}

      <div className="flex items-center justify-between gap-3 flex-wrap border-t border-slate-100 pt-3">
        <label className="inline-flex items-center gap-2 text-[11px] font-bold text-slate-500">
          <input type="checkbox" checked={ujra} onChange={e => setUjra(e.target.checked)} />
          {`a ${d.felhivas_db || 0} felhívás találatai számoljanak újra`}
        </label>
        <div className="flex items-center gap-2">
          {valtozott && (
            <button className={U_btnGhost + ' !px-3 !py-2 text-xs'} onClick={() => setMod({})}>
              Elvetés
            </button>
          )}
          <button className={U_btnPrimary + ' !px-4 !py-2 text-xs'} disabled={busy || !valtozott} onClick={ment}>
            <Lucide.Save size={14} /> Mentés
          </button>
        </div>
      </div>
      {d.valtozott && (
        <p className="text-[11px] text-slate-400">
          {`A súlyokat utoljára ekkor állították át: ${String(d.valtozott).slice(0, 16).replace('T', ' ')}.`}
        </p>
      )}
    </div>
  );
}


/* ----------------------------------------------------------------------------
   Konzorciumkeresés (106)
   ----------------------------------------------------------------------------
   MÉRVE 2026-09-27: az EU partnerkereső HIRDETÉSEIT — hogy melyik külföldi
   szervezet keres partnert — nyilvános API-n nem lehet lekérni; a portál
   kereső-API-ja minden szűrt lekérdezésre hibát ad, a modul pedig bejelentkezés
   mögött van. Ezért ez a képernyő azt mutatja, amit rajtunk kívül senki nem tud
   megmondani: MIRE kell nekünk partner, kiket vinnénk mi, és hol lehet
   meghirdetni a kiírónál.
   ------------------------------------------------------------------------- */
function GRTT_KonzorciumView() {
  const [lista, setLista] = useState(null);
  const [q, setQ] = useState('');
  const [csakHiany, setCsakHiany] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let el = true;
    const t = setTimeout(() => {
      GRTT_api.partnerCalls(q, 40, csakHiany)
        .then(d => { if (el) setLista(Array.isArray(d) ? d : []); })
        .catch(e => { if (el) setErr(GRT_msg(e)); });
    }, 300);
    return () => { el = false; clearTimeout(t); };
  }, [q, csakHiany]);

  return (
    <div>
      {err && <p className="text-xs text-rose-600 font-bold mb-3">{err}</p>}

      <div className="bg-white border border-slate-100 rounded-2xl p-4 mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-black text-slate-800">Konzorciumkeresés</p>
            <p className="text-[11px] text-slate-400 mt-0.5 max-w-2xl">
              {'Azok a nyitott felhívások, ahol a kiíró engedi a partnerkeresést. Minden sor megmondja, '
               + 'MIRE kell partner — vagyis melyik elvárásra nincs házon belüli jelöltünk —, és kiket '
               + 'vinnénk mi a konzorciumba.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input className={U_input + ' !py-2 !px-3 text-xs w-56'} value={q}
              onChange={e => setQ(e.target.value)} placeholder="Keresés a felhívás címére…" />
            <label className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
              <input type="checkbox" checked={csakHiany} onChange={e => setCsakHiany(e.target.checked)} />
              csak ahol hiányzik valaki
            </label>
          </div>
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          {'A külföldi szervezetek partnerkereső hirdetései nyilvános felületen nem érhetők el — azokat a '
           + 'kiíró oldalán, bejelentkezve lehet böngészni. A soronkénti gomb oda visz.'}
        </p>
      </div>

      {!lista && <p className="text-sm text-slate-400">Betöltés…</p>}
      {lista && lista.length === 0 && (
        <div className="bg-white border border-slate-100 rounded-2xl p-6">
          <p className="text-sm text-slate-500">
            {csakHiany
              ? 'Nincs olyan partnerkeresésre nyitott felhívás, ahol valamelyik elvárásra ne lenne emberünk. Vedd ki a pipát, és látod az összeset.'
              : 'Nincs partnerkeresésre nyitott felhívás a szűrésben.'}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {(lista || []).map(c => {
          const hianyzo = c.hianyzo || [];
          const csapat = c.sajat_csapat || [];
          return (
            <div key={c.call_id} className="bg-white border border-slate-100 rounded-2xl p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-800">{c.cim}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {`${c.program || '—'}${c.hatarido ? ' · határidő: ' + String(c.hatarido).slice(0, 10) : ''}`
                     + `${c.arculat_db ? ' · ' + c.arculat_db + ' elvárás' : ''}`
                     + `${c.felkert_db ? ' · ' + c.felkert_db + ' kollégát felkértünk' : ''}`}
                  </p>
                </div>
                {c.partner_url && (
                  <a href={c.partner_url} target="_blank" rel="noopener noreferrer"
                    className={U_btnGhost + ' !px-3 !py-1.5 text-xs whitespace-nowrap'}>
                    <Lucide.ExternalLink size={13} /> Partnerkeresés a kiírónál
                  </a>
                )}
              </div>

              {hianyzo.length > 0 ? (
                <div className="mt-3 bg-amber-50 border border-amber-100 rounded-xl p-3">
                  <p className="text-[11px] font-black text-amber-700 uppercase tracking-wider mb-1">
                    {`Ehhez partner kell (${hianyzo.length} elvárás)`}
                  </p>
                  {hianyzo.map((h, i) => (
                    <p key={i} className="text-[11px] text-amber-800">
                      <span className="font-bold">{h.arculat}</span>
                      {h.szoveg ? <span className="text-amber-700/80">{` — ${h.szoveg}`}</span> : null}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-emerald-600 font-bold mt-3">
                  {'Minden elvárásra van házon belüli jelöltünk — partner nem feltétlenül kell.'}
                </p>
              )}

              {csapat.length > 0 && (
                <div className="mt-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">
                    Amit mi hozunk
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {csapat.map((t, i) => (
                      <span key={i}
                        className={'px-2 py-0.5 rounded-lg text-[11px] font-bold '
                                   + (t.szerep === 'vezeto' ? 'bg-primary/10 text-primary'
                                                            : 'bg-slate-50 text-slate-600')}>
                        {`${t.nev}${t.szerep === 'vezeto' ? ' · vezető' : ''}${t.arculat ? ' · ' + t.arculat : ''}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GRTT_BevonasView() {
  const [stat, setStat] = useState(null);
  const [sosem, setSosem] = useState(null);
  const [felk, setFelk] = useState(null);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [q, setQ] = useState('');
  const [kar, setKar] = useState('');
  const [allapot, setAllapot] = useState('');
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState('');

  const betolt = () => {
    GRTT_api.stats().then(setStat).catch(e => setErr(GRT_msg(e)));
    GRTT_api.invites({ allapot: allapot || null, kar: kar || null, limit: 200 })
      .then(setFelk).catch(e => setErr(GRT_msg(e)));
  };

  useEffect(() => { betolt(); }, [allapot, kar]);
  useEffect(() => {
    let el = true;
    const t = setTimeout(() => {
      GRTT_api.sosem(kar || null, q || null, 60)
        .then(d => { if (el) setSosem(d); }).catch(e => { if (el) setErr(GRT_msg(e)); });
    }, 300);
    return () => { el = false; clearTimeout(t); };
  }, [q, kar]);

  const leptet = async (sor, ujAllapot) => {
    setBusy(sor.id); setErr('');
    try {
      await GRTT_api.inviteSet(sor.id, ujAllapot);
      setToast(`${sor.nev}: ${(GRTT_ALLAPOT[ujAllapot] || {}).cim || ujAllapot}.`);
      betolt();
      GRTT_api.sosem(kar || null, q || null, 60).then(setSosem).catch(() => {});
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const lejaratas = async () => {
    setBusy('lejar'); setErr('');
    try {
      const r = await GRTT_api.expire();
      setToast(`${(r && r.lejart) || 0} megválaszolatlan felkérés lejáratva.`);
      betolt();
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const karok = stat && Array.isArray(stat.karonkent) ? stat.karonkent : [];

  return (
    <div>
      {toast && <UToast msg={toast} onDone={() => setToast('')} />}
      {err && <p className="text-xs text-rose-600 font-bold mb-3">{err}</p>}

      {/* Mind a négy szám a BEVONÁSRÓL szól, nem a teljesítményről. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <GRTT_Szam cim="Bevont kolléga" tone="text-primary"
          ertek={`${(stat && stat.bevont) || 0} / ${(stat && stat.torzstag) || 0}`}
          alcim={`a törzstagok ${(stat && stat.bevont_arany) || 0}%-a, ${(stat && stat.ev) || ''}`} />
        <GRTT_Szam cim="Érintett kar" ertek={(stat && stat.karok) || 0} tone="text-sky-600" />
        <GRTT_Szam cim="Első pályázatuk" ertek={(stat && stat.elso_palyazo) || 0} tone="text-emerald-600"
          alcim="ebben az évben kérték fel először" />
        <GRTT_Szam cim="Átlagos felkérés / bevont fő" ertek={(stat && stat.atlag_felkeres) || 0}
          tone={Number((stat && stat.atlag_felkeres) || 0) > 2 ? 'text-amber-600' : 'text-slate-800'}
          alcim="a túlterhelés korai jelzője" />
      </div>

      {karok.length > 0 && (
        <div className="bg-white border border-slate-100 rounded-2xl p-4 mb-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-wider mb-3">Bevonás kar szerint</p>
          <div className="space-y-2">
            {karok.map(k => (
              <div key={k.kar}>
                <div className="flex items-center justify-between text-[11px] font-bold text-slate-500">
                  <span>{k.kar}</span>
                  <span>{`${k.bevont} / ${k.torzstag} (${k.arany}%)`}</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className={'h-full ' + (Number(k.arany) < 10 ? 'bg-rose-400' : Number(k.arany) < 25 ? 'bg-amber-400' : 'bg-emerald-500')}
                    style={{ width: Math.max(2, Math.min(100, Number(k.arany) || 0)) + '%' }} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-3">
            {'Az alacsony arány nem a kar hibája: azt jelenti, hogy onnan rendszeresen kimaradnak a kollégák.'}
          </p>
        </div>
      )}

      {/* EZ A MODUL LÉNYEGE: az egyetlen lista, ami cselekvésre hív. */}
      <div className="bg-white border border-slate-100 rounded-2xl p-4 mb-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <p className="text-sm font-black text-slate-800">Még soha nem kértük fel</p>
            <p className="text-[11px] text-slate-400">
              {'Aki még egyetlen pályázatban sem szerepelt. A bevonási pontszám nála a legmagasabb.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input className={U_input + ' !py-2 !px-3 text-xs w-44'} value={q}
              onChange={e => setQ(e.target.value)} placeholder="Név vagy intézet…" />
            <select className={U_input + ' !py-2 !px-3 text-xs w-40'} value={kar} onChange={e => setKar(e.target.value)}>
              <option value="">Minden kar</option>
              {karok.map(k => <option key={k.kar} value={k.kar}>{k.kar}</option>)}
            </select>
          </div>
        </div>
        {!sosem && <p className="text-sm text-slate-400">Betöltés…</p>}
        {sosem && sosem.length === 0 && (
          <p className="text-sm text-emerald-600 font-bold">
            {'Ebben a körben minden kollégát felkértünk már legalább egyszer.'}
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {(sosem || []).map(s => (
            <div key={s.id} className="bg-slate-50 rounded-xl p-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 truncate">{s.nev}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {`${s.kar || '—'}${s.intezet ? ' · ' + s.intezet : ''} · ${s.mu_db} mű`
                   + `${s.utolso_ev ? ', legutóbb ' + s.utolso_ev : ''} · kapacitás ${s.kapacitas_pont}`}
                </p>
                {s.mu_db === 0 && (
                  <p className="text-[11px] text-amber-600 font-bold mt-1">
                    {'Nincs publikációs adat — a kézi kompetencia viszi tovább.'}
                  </p>
                )}
              </div>
              <button className={U_btnGhost + ' !px-3 !py-1.5 text-xs whitespace-nowrap'}
                onClick={() => setModal(s)}>
                <Lucide.Search size={13} /> Mihez illik
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Felkérések: ki melyik felhívásra, hol tart. */}
      <div className="bg-white border border-slate-100 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <p className="text-sm font-black text-slate-800">Felkérések</p>
            <p className="text-[11px] text-slate-400">
              {'Minden állapotváltás naplózva: ki léptette és mikor. A rendszer senkit nem kér fel automatikusan.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select className={U_input + ' !py-2 !px-3 text-xs w-40'} value={allapot}
              onChange={e => setAllapot(e.target.value)}>
              <option value="">Minden állapot</option>
              {Object.keys(GRTT_ALLAPOT).map(k => <option key={k} value={k}>{GRTT_ALLAPOT[k].cim}</option>)}
            </select>
            <button className={U_btnGhost + ' !px-3 !py-2 text-xs'} disabled={busy === 'lejar'} onClick={lejaratas}>
              <Lucide.Clock size={13} /> Lejáratás
            </button>
          </div>
        </div>
        {!felk && <p className="text-sm text-slate-400">Betöltés…</p>}
        {felk && felk.length === 0 && (
          <p className="text-sm text-slate-500">{'Ebben a szűrésben nincs felkérés.'}</p>
        )}
        <div className="space-y-2">
          {(felk || []).map(s => (
            <div key={s.id} className="bg-slate-50 rounded-xl p-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-bold text-slate-800">{s.nev}</p>
                    <GRTT_Badge allapot={s.allapot} />
                    {s.szerep === 'vezeto' && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-primary/10 text-primary">vezető</span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">{s.felhivas}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {`${s.kar || '—'} · arculat: ${s.arculat || '—'} · bevonási pontszám ${s.bevonas_pont}`
                     + `${s.valasz_hatarido ? ' · válasz eddig: ' + s.valasz_hatarido : ''}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(GRTT_ATMENET[s.allapot] || []).map(a => (
                    <button key={a} className={U_btnGhost + ' !px-2.5 !py-1 text-[11px]'}
                      disabled={busy === s.id} onClick={() => leptet(s, a)}>
                      {(GRTT_ALLAPOT[a] || {}).cim || a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <GRTT_IlleszkedesModal open={!!modal} kutato={modal} onClose={() => setModal(null)}
        onFelkerve={() => { setToast('Bekerült a javaslatok közé.'); betolt(); }} />
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Egy felhívás: arculatok → illesztés → csapatváltozatok → felkérés
   ------------------------------------------------------------------------- */
function GRTT_ArculatSzerkeszto({ open, call, arculatok, onClose, onKesz }) {
  const [szoveg, setSzoveg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    setSzoveg((arculatok || []).map(a => `${a.nev} | ${a.szoveg || ''}`).join('\n'));
  }, [open, arculatok]);

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      const items = szoveg.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
        const i = s.indexOf('|');
        return i < 0 ? { nev: s, szoveg: '' }
                     : { nev: s.slice(0, i).trim(), szoveg: s.slice(i + 1).trim() };
      }).filter(x => x.nev);
      if (items.length < 2) throw new Error('Legalább két arculatot adj meg — egyetlen elvárásból nincs mit lefedni.');
      await GRTT_api.facetsSave(call.id, items);
      if (onKesz) onKesz();
      onClose();
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <UModal open={open} onClose={onClose} max="max-w-2xl" icon={<Lucide.SlidersHorizontal size={18} />}
      title="Arculatok" subtitle="A felhívás elvárásai, egy sor egy elvárás">
      <p className="text-[11px] text-slate-500 mb-2">
        {'Soronként egy arculat: NÉV | a felhívás saját szövege erre az elvárásra. A szöveg az illesztés alapja, '
         + 'ezért érdemes a felhívásból idemásolni — így ellenőrizhető is, hogy valóban ezt kéri.'}
      </p>
      <textarea className={U_input + ' font-mono text-xs'} rows={8} value={szoveg}
        onChange={e => setSzoveg(e.target.value)}
        placeholder={'szenzoradat-gyűjtés | wireless sensor network, calibration, telemetry\ngépi tanulási modell | machine learning, predictive maintenance'} />
      {err && <p className="text-xs text-rose-600 font-bold mt-2">{err}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button className={U_btnGhost} onClick={onClose}>Mégsem</button>
        <button className={U_btnPrimary} disabled={busy} onClick={ment}>
          <Lucide.Save size={14} /> Mentés
        </button>
      </div>
    </UModal>
  );
}

function GRTT_Jelolt({ j, callId, onFelkerve }) {
  const [nyit, setNyit] = useState(false);
  const [busy, setBusy] = useState(false);
  const biz = Array.isArray(j.bizonyitek) ? j.bizonyitek : [];

  const felker = async (arculat) => {
    setBusy(true);
    try {
      await GRTT_api.inviteNew({ call_id: callId, researcher_id: j.researcher_id,
                                 arculat: arculat || null, szerep: 'tag', allapot: 'javasolt' });
      if (onFelkerve) onFelkerve();
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-slate-50 rounded-xl p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-slate-800">{j.nev}</p>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-primary/10 text-primary">
              {`${Math.round(Number(j.ossz) || 0)} pont`}
            </span>
            {j.ut === 'token' && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-200 text-slate-600">
                szóegyezés
              </span>
            )}
            {!j.van_angol && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-700">
                nincs angol kimenet
              </span>
            )}
            {!j.nyitott && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-500">
                még nem jelezte, hogy kérhető
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">{`${j.kar || '—'}${j.intezet ? ' · ' + j.intezet : ''}`}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button className={U_btnGhost + ' !px-2.5 !py-1 text-[11px]'} onClick={() => setNyit(!nyit)}>
            {nyit ? 'Kevesebb' : 'Miért ő'}
          </button>
          {j.felkerve
            ? <span className="text-[10px] font-black text-emerald-600">már felkérve</span>
            : <button className={U_btnGhost + ' !px-2.5 !py-1 text-[11px]'} disabled={busy}
                onClick={() => felker(j.__arculat)}>
                <Lucide.UserPlus size={13} /> Javaslatba
              </button>}
        </div>
      </div>
      {nyit && (
        <>
          <GRTT_Komponensek m={j} />
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-3 mb-1">
            Mire alapozzuk
          </p>
          {biz.length === 0 && <p className="text-[11px] text-slate-400">Nincs megnevezhető mű.</p>}
          <ul className="space-y-1">
            {biz.map((b, i) => (
              <li key={i} className="text-[11px] text-slate-600">
                {`${b.cim || '—'}${b.ev ? ' (' + b.ev + ')' : ''}`
                 + `${b.hasonlosag !== undefined && b.hasonlosag !== null ? ' · hasonlóság ' + b.hasonlosag + '%' : ''}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function GRTT_CsapatKartya({ t, onFelker, onTorol, busy }) {
  const ures = Array.isArray(t.ures_arculat) ? t.ures_arculat : [];
  const nincsJelolt = ures.filter(u => !u.van_jelolt);
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div>
          <p className="text-sm font-black text-slate-800">{t.nev}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">{t.indoklas}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button className={U_btnGhost + ' !px-3 !py-1.5 text-xs'} disabled={busy}
            onClick={() => onFelker(t)}>
            <Lucide.Send size={13} /> Felkérés a javaslatból
          </button>
          <button className={U_btnGhost + ' !px-2.5 !py-1.5 text-xs'} disabled={busy} onClick={() => onTorol(t)}>
            <Lucide.Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        {(t.tagok || []).map(m => (
          <div key={m.researcher_id} className="flex items-center justify-between gap-2 bg-slate-50 rounded-xl px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-800">
                {`${m.nev} — ${GRTT_SZEREP[m.szerep] || m.szerep}`}
              </p>
              <p className="text-[11px] text-slate-400">
                {`${m.kar || '—'} · arculat: ${m.arculat || '—'} · ${Math.round(Number(m.ossz) || 0)} pont`}
              </p>
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              {m.ujonnan && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-700">
                  első pályázata
                </span>
              )}
              {m.felkerve && <span className="text-[10px] font-black text-slate-400">felkérve</span>}
            </div>
          </div>
        ))}
      </div>
      {nincsJelolt.length > 0 && (
        <div className="mt-3 bg-amber-50 border border-amber-100 rounded-xl p-3">
          <p className="text-[11px] font-black text-amber-700 uppercase tracking-wider mb-1">
            Külső partner kell
          </p>
          <p className="text-[11px] text-amber-800">
            {`Ezekre az elvárásokra házon belül nincs jelölt: ${nincsJelolt.map(u => u.nev).join(', ')}. `
             + 'Ez nem hibaüzenet: ez mondja meg, mire kell konzorciumi partnert keresni.'}
          </p>
        </div>
      )}
    </div>
  );
}

/* A felhívás kártyája a listán: NEVEKKEL. A lényeg, hogy az iroda a listán
   lássa, kit javaslunk — ne kelljen minden felhívást megnyitnia ahhoz, hogy
   megtudja, van-e egyáltalán emberünk rá. */
function GRTT_FelhivasKartya({ c, aktiv, onNyit }) {
  const cs = c.csapat;
  const tagok = (cs && cs.tagok) || [];
  const ures = ((cs && cs.ures_arculat) || []).filter(u => !u.van_jelolt);
  return (
    <button type="button" onClick={onNyit}
      className={'text-left rounded-xl p-3 border transition-all w-full '
                 + (aktiv ? 'border-primary bg-primary/5' : 'border-slate-100 bg-slate-50 hover:border-slate-200')}>
      <p className="text-xs font-bold text-slate-800 line-clamp-2">{c.cim}</p>
      <p className="text-[11px] text-slate-400 mt-0.5">
        {`${c.program || '—'}${c.hatarido ? ' · határidő: ' + String(c.hatarido).slice(0, 10) : ''}`
         + `${c.arculat_db ? ' · ' + c.arculat_db + ' arculat' : ''}`
         + `${c.felkert_db ? ' · ' + c.felkert_db + ' felkérve' : ''}`}
      </p>

      {!cs && (
        <p className="text-[11px] text-slate-400 mt-2">
          {c.arculat_db > 0
            ? 'Még nincs csapatjavaslat — megnyitva egy kattintással elkészül.'
            : 'Még nincs arculatokra bontva: a gépi kör hamarosan sorra veszi.'}
        </p>
      )}

      {cs && tagok.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1 mt-2">
            {tagok.map(t => (
              <span key={t.researcher_id}
                className={'px-2 py-0.5 rounded-lg text-[11px] font-bold '
                           + (t.szerep === 'vezeto'
                              ? 'bg-primary/10 text-primary'
                              : t.ujonnan ? 'bg-emerald-50 text-emerald-700' : 'bg-white text-slate-600 border border-slate-100')}>
                {`${t.nev}${t.szerep === 'vezeto' ? ' · vezető' : ''}${t.felkerve ? ' ✓' : ''}`}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-1.5">
            {`${cs.lefedett}/${cs.arculat_db} arculat lefedve · ${cs.kar_db} kar`
             + `${cs.ujonnan_db ? ' · ' + cs.ujonnan_db + ' első pályázata' : ''}`}
          </p>
        </>
      )}

      {cs && tagok.length === 0 && (
        <p className="text-[11px] font-bold text-amber-600 mt-2">
          {'Egyetlen kolléga sem emelkedik ki a mezőnyből — ezt a csapatot kívülről kell építeni.'}
        </p>
      )}

      {ures.length > 0 && (
        <p className="text-[11px] text-amber-600 mt-1">
          {`Külső partner kell: ${ures.map(u => u.nev).join(', ')}`}
        </p>
      )}
    </button>
  );
}

function GRTT_CsapatView() {
  const [q, setQ] = useState('');
  const [calls, setCalls] = useState(null);
  const [call, setCall] = useState(null);
  const [arc, setArc] = useState(null);
  const [talalat, setTalalat] = useState(null);
  const [teams, setTeams] = useState(null);
  const [sum, setSum] = useState(null);
  const [sem, setSem] = useState(null);
  const [csakNyitott, setCsakNyitott] = useState(false);
  const [szerk, setSzerk] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => { GRTT_api.semantic().then(setSem).catch(() => {}); }, []);
  const attekintoBetolt = (kereses) =>
    GRTT_api.overview(kereses, 40).then(d => setCalls(Array.isArray(d) ? d : []))
      .catch(e => setErr(GRT_msg(e)));

  useEffect(() => {
    let el = true;
    const t = setTimeout(() => { if (el) attekintoBetolt(q); }, 300);
    return () => { el = false; clearTimeout(t); };
  }, [q]);

  const callBetolt = (c) => {
    setCall(c); setTalalat(null); setSum(null);
    if (!c) { setArc(null); setTeams(null); return; }
    GRTT_api.facets(c.id).then(setArc).catch(e => setErr(GRT_msg(e)));
    GRTT_api.teams(c.id).then(setTeams).catch(() => {});
    GRTT_api.matches(c.id, 8).then(setTalalat).catch(() => {});
  };

  const parosit = async () => {
    setBusy('match'); setErr('');
    try {
      const r = await GRTT_api.match(call.id, csakNyitott);
      setSum(r);
      const t = await GRTT_api.matches(call.id, 8);
      setTalalat(t);
      setToast(`${(r && r.talalat_db) || 0} találat, ${(r && r.ido_ms) || 0} ms.`);
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const javasol = async () => {
    setBusy('team'); setErr('');
    try {
      const r = await GRTT_api.suggest(call.id, csakNyitott);
      setTeams(r);
      attekintoBetolt(q);
      setToast((r || []).length
        ? `${(r || []).length} csapatváltozat készült.`
        : 'Erre a felhívásra egyetlen kolléga sem emelkedik ki a mezőnyből — a csapatot kívülről kell építeni.');
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const felker = async (t) => {
    setBusy('inv'); setErr('');
    try {
      const r = await GRTT_api.teamInvite(t.id);
      setToast(`${(r && r.uj) || 0} új javaslat, ${(r && r.meglevo) || 0} már bent volt.`);
      GRTT_api.teams(call.id).then(setTeams).catch(() => {});
      attekintoBetolt(q);
      GRTT_api.matches(call.id, 8).then(setTalalat).catch(() => {});
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const torol = async (t) => {
    setBusy('del');
    try { await GRTT_api.teamDelete(t.id); setTeams(await GRTT_api.teams(call.id)); }
    catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const ujraepit = async () => {
    setBusy('rebuild');
    try {
      const r = await GRTT_api.rebuild('mind');
      setToast(`Szöveges profil: ${(r && r.szoveges_profil) || 0} kutató, társszerzőségi él: ${(r && r.el) || 0}.`);
      GRTT_api.semantic().then(setSem).catch(() => {});
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const lista = Array.isArray(calls) ? calls : [];

  return (
    <div>
      {toast && <UToast msg={toast} onDone={() => setToast('')} />}
      {err && <p className="text-xs text-rose-600 font-bold mb-3">{err}</p>}

      {/* Az iroda lássa, mennyi adat van egyáltalán: e nélkül nem tudja
          megítélni, miért gyenge egy találat. */}
      {sem && (
        <div className="bg-white border border-slate-100 rounded-2xl p-4 mb-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Adatlefedettség</p>
              <p className="text-[11px] text-slate-600">
                {`${sem.mu_db} mű, ebből ${sem.absztrakt_db} absztrakttal · ${sem.vektor_db} beágyazott mű · `
                 + `${sem.klaszterezett}/${sem.kutato_db} kutatónak van témakör-vektora · `
                 + `${sem.szoveges_profil} szöveges profil · ${sem.arculatos_felhivas} felhívás bontva arculatokra`}
              </p>
              {sem.vektor_db === 0 && (
                <p className="text-[11px] text-amber-600 font-bold mt-1">
                  {'Beágyazás még nincs: az illesztés egyelőre szóegyezéssel dolgozik. Ez működik, de a magyar '
                   + 'nyelvű művet nem köti össze az angol felhívással — ahhoz kell a beágyazás.'}
                </p>
              )}
            </div>
            <button className={U_btnGhost + ' !px-3 !py-1.5 text-xs'} disabled={busy === 'rebuild'} onClick={ujraepit}>
              <Lucide.RefreshCw size={13} /> Profil és gráf újraépítése
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-100 rounded-2xl p-4 mb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <p className="text-sm font-black text-slate-800">Nyitott felhívások és a javasolt csapat</p>
            <p className="text-[11px] text-slate-400">
              {'A javaslatok gépi körben készülnek, minden felhívásra — a kártyán látod a neveket, '
               + 'kattintásra a részleteket.'}
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Lucide.Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300" />
            <input className={U_input + ' pl-10 !py-2 text-xs'} value={q} onChange={e => setQ(e.target.value)}
              placeholder="Keresés a felhívás címére…" />
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-2 max-h-[30rem] overflow-auto">
          {lista.map(c => <GRTT_FelhivasKartya key={c.call_id} c={c} aktiv={call && call.id === c.call_id}
                            onNyit={() => callBetolt({ id: c.call_id, cim: c.cim })} />)}
          {lista.length === 0 && <p className="text-sm text-slate-400">Nincs találat.</p>}
        </div>
      </div>

      {call && (
        <>
          <div className="bg-white border border-slate-100 rounded-2xl p-4 mb-4">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
              <div>
                <p className="text-sm font-black text-slate-800">{call.cim}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {`${(arc || []).length} arculat · a felhívás elvárásai, amelyeket le kell fedni`}
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button className={U_btnGhost + ' !px-3 !py-1.5 text-xs'} onClick={() => setSzerk(true)}>
                  <Lucide.Pencil size={13} /> Arculatok
                </button>
                <label className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-500 px-2">
                  <input type="checkbox" checked={csakNyitott} onChange={e => setCsakNyitott(e.target.checked)} />
                  csak akik jelezték
                </label>
                <button className={U_btnGhost + ' !px-3 !py-1.5 text-xs'} disabled={busy === 'match' || !(arc || []).length}
                  onClick={parosit}>
                  <Lucide.Wand2 size={13} /> Illesztés
                </button>
                <button className={U_btnPrimary + ' !px-3 !py-1.5 text-xs'} disabled={busy === 'team'} onClick={javasol}>
                  <Lucide.Users size={13} /> Csapatjavaslat
                </button>
              </div>
            </div>

            {(arc || []).length === 0 && (
              <p className="text-sm text-slate-500">
                {'Ez a felhívás még nincs arculatokra bontva. Az illesztés csak arculatokkal működik: a csapat azért '
                 + 'áll össze lefedéssel, hogy minden elvárásra legyen ember.'}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {(arc || []).map(a => (
                <span key={a.id}
                  className={'px-2.5 py-1 rounded-xl text-[11px] font-bold '
                             + (a.talalat_db > 0 ? 'bg-slate-100 text-slate-600' : 'bg-rose-50 text-rose-600')}>
                  {`${a.nev} · ${a.talalat_db} jelölt`}
                </span>
              ))}
            </div>

            {sum && (
              <p className="text-[11px] text-slate-500 mt-3">
                {`${sum.kutato_db} kutató, ${sum.arculat_db} arculat, ${sum.talalat_db} találat `
                 + `(${sum.vektor_par} beágyazás alapján, ${sum.token_par} szóegyezéssel), ${sum.ido_ms} ms.`}
                {Array.isArray(sum.ures_arculatok) && sum.ures_arculatok.length > 0
                  ? ` Nincs házon belüli jelölt erre: ${sum.ures_arculatok.join(', ')}.`
                  : ''}
              </p>
            )}
          </div>

          {Array.isArray(teams) && teams.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2 mb-4">
              {teams.map(t => (
                <GRTT_CsapatKartya key={t.id} t={t} busy={!!busy} onFelker={felker} onTorol={torol} />
              ))}
            </div>
          )}

          {Array.isArray(talalat) && talalat.length > 0 && (
            <div className="space-y-3">
              {talalat.map(f => (
                <div key={f.facet_id} className="bg-white border border-slate-100 rounded-2xl p-4">
                  <div className="mb-2">
                    <p className="text-sm font-black text-slate-800">{f.arculat}</p>
                    {f.szoveg && <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">{f.szoveg}</p>}
                  </div>
                  {(f.jeloltek || []).length === 0 && (
                    <p className="text-[11px] font-bold text-rose-600">
                      {'Erre az elvárásra házon belül nincs jelölt — ide külső partner kell.'}
                    </p>
                  )}
                  <div className="space-y-2">
                    {(f.jeloltek || []).map(j => (
                      <GRTT_Jelolt key={j.researcher_id} j={{ ...j, __arculat: f.arculat }} callId={call.id}
                        onFelkerve={() => {
                          setToast('Bekerült a javaslatok közé.');
                          GRTT_api.matches(call.id, 8).then(setTalalat).catch(() => {});
                        }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <GRTT_ArculatSzerkeszto open={szerk} call={call} arculatok={arc || []}
            onClose={() => setSzerk(false)}
            onKesz={() => { GRTT_api.facets(call.id).then(setArc).catch(() => {}); setToast('Arculatok mentve.'); }} />
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   A kollégáé: a saját felkérései. Ehhez nem kell irodai jogosultság — ezért
   nem érheti váratlanul, hogy négy pályázatban szerepel.
   ------------------------------------------------------------------------- */
function GRTT_SajatFelkeresek({ user }) {
  const [adat, setAdat] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');

  const betolt = () => GRTT_api.mine().then(setAdat).catch(e => setErr(GRT_msg(e)));
  useEffect(() => { betolt(); }, []);

  const valasz = async (sor, v) => {
    if (v === 'visszalepett'
        && !window.confirm('Visszalépsz ettől a felkéréstől? A pályázati iroda értesítést kap róla.')) return;
    setBusy(sor.id); setErr('');
    try {
      await GRTT_api.respond(sor.id, v);
      setToast(v === 'elfogadta' ? 'Elfogadtad a felkérést.' : 'Visszaléptél.');
      betolt();
    } catch (e) { setErr(GRT_msg(e)); }
    finally { setBusy(''); }
  };

  const st = (adat && adat.stat) || {};
  const sorok = (adat && adat.felkeresek) || [];

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      {toast && <UToast msg={toast} onDone={() => setToast('')} />}
      <h1 className="text-2xl font-black text-slate-800 mb-1">Pályázati felkéréseim</h1>
      <p className="text-sm text-slate-500 mb-6">
        {'Itt látod, mely pályázatokba hívtak, milyen szerepre, és mit válaszoltál. A pályázati iroda ugyanezt látja.'}
      </p>
      {err && <p className="text-xs text-rose-600 font-bold mb-3">{err}</p>}

      {adat && !adat.kutato && (
        <div className="bg-white border border-slate-100 rounded-2xl p-6">
          <p className="text-sm text-slate-600">
            {'Nem szerepelsz a kutatói törzsben, ezért felkérés sem tartozik hozzád. Ha kutatóként dolgozol az '
             + 'egyetemen, a pályázati iroda fel tudja venni a törzsbe.'}
          </p>
        </div>
      )}

      {adat && adat.kutato && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <GRTT_Szam cim="Idei felkérés" ertek={st.idei_felkeres || 0} />
            <GRTT_Szam cim="Futó részvétel" ertek={st.futo || 0} tone="text-sky-600" />
            <GRTT_Szam cim="Elfogadott" ertek={st.elfogadott || 0} tone="text-emerald-600" />
            <GRTT_Szam cim="Összes felkérés" ertek={st.osszes_felkeres || 0} />
          </div>

          {sorok.length === 0 && (
            <div className="bg-white border border-slate-100 rounded-2xl p-6">
              <p className="text-sm text-slate-600">
                {'Egyelőre nincs kiküldött felkérésed. Ha szeretnél pályázatban dolgozni, szólj a pályázati '
                 + 'irodának — a rendszer külön jelzi azokat a kollégákat, akiket még soha nem kértünk fel.'}
              </p>
            </div>
          )}

          <div className="space-y-2">
            {sorok.map(s => (
              <div key={s.id} className="bg-white border border-slate-100 rounded-2xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-slate-800">{s.felhivas}</p>
                      <GRTT_Badge allapot={s.allapot} />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      {`szerep: ${GRTT_SZEREP[s.szerep] || s.szerep} · arculat: ${s.arculat || '—'}`
                       + `${s.valasz_hatarido ? ' · válasz eddig: ' + s.valasz_hatarido : ''}`}
                    </p>
                    {s.megjegyzes && <p className="text-[11px] text-slate-400 mt-1">{s.megjegyzes}</p>}
                  </div>
                  {s.valaszolhat && (
                    <div className="flex items-center gap-1.5">
                      <button className={U_btnPrimary + ' !px-3 !py-1.5 text-xs'} disabled={busy === s.id}
                        onClick={() => valasz(s, 'elfogadta')}>
                        <Lucide.Check size={13} /> Elfogadom
                      </button>
                      <button className={U_btnGhost + ' !px-3 !py-1.5 text-xs'} disabled={busy === s.id}
                        onClick={() => valasz(s, 'visszalepett')}>
                        Nem vállalom
                      </button>
                    </div>
                  )}
                  {s.url && (
                    <a href={s.url} target="_blank" rel="noopener noreferrer"
                      className="text-[11px] font-bold text-primary">A felhívás oldala</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
