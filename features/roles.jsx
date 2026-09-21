/* ===========================================================================
   roles.jsx — Szerepkörök és a jogosultsági mátrix (szuperadmin)

   MI VOLT EDDIG
     Egy lapos chipsor: „Mit lásson a menüben". Egy szerepkör vagy látott egy
     modult, vagy nem — azon belül mindent tehetett, amit a kódba égetett
     szerepkör-listák és a régi rbac_ RLS-policy-k engedtek.

   MI LESZ
     Modul × művelet MÁTRIX: minden modulon külön kapcsolható a
     VIEW / USE / CREATE / EDIT / DELETE. A menü-láthatóság innentől a VIEW.

   AMIT A FELÜLETNEK KI KELL MONDANIA, ÉS EZÉRT KI IS MOND
     1. A SUPERADMIN hozzáférése nem szerkeszthető. Nem óvatoskodásból: ha
        elvehető lenne, a szuperadmin ki tudná zárni magát abból a képernyőből
        is, amivel visszaállítaná. A szerver is elutasítja, nem csak a felület
        rejti el.
     2. A mátrix és a menü KÉT KÜLÖN TENGELY. Van olyan cella, ami szándékosan
        be van pipálva olyan modulon, ami az adott szerepkör menüjében nem
        szerepel — mert a mai adatbázis-szabály úgy engedi. A legfeltűnőbb: a
        Pénzügy megkapja a „Jelentkezés és Felvételi" írási jogait, VIEW nélkül,
        mert a rbac_students_insert policy is_staff()-ot kér, és az is_staff()
        tartalmazza a FINANCE-t. Ez nem elírás, és nem szabad „kijavítani".
     3. Ha a kikényszerítés ki van kapcsolva (vészkapcsoló), azt LÁTNI kell.
        Különben valaki hetekig abban a hitben él, hogy a mátrix működik.

   Adatbázis: 72_rbac_actions.sql
   =========================================================================== */

const ROLE_PGERR = {
  '42501':   'Ehhez a művelethez nincs jogosultsága.',
  '23505':   'Ilyen kódú szerepkör már van.',
  '22023':   'Érvénytelen érték.',
  '02000':   'A hivatkozott elem nem létezik.',
  '42P01':   'A modul táblái hiányoznak — a 72_rbac_actions.sql még nem futott le.',
  '42883':   'A modul függvényei hiányoznak — a 72_rbac_actions.sql még nem futott le.',
  'PGRST205':'A modul táblái hiányoznak — a 72_rbac_actions.sql még nem futott le.',
  'PGRST202':'A modul függvényei hiányoznak — a 72_rbac_actions.sql még nem futott le.',
};

function ROLE_msg(e) {
  if (!e) return 'Ismeretlen hiba.';
  const raw = String(e.message || e.details || e.hint || e);
  const code = e.code || (e.error && e.error.code);
  if (/[őűáéíóöúüÁÉÍÓÖŐÚÜŰ]/.test(raw) && raw.length > 12) return raw;
  if (code && ROLE_PGERR[code]) return ROLE_PGERR[code];
  for (const k in ROLE_PGERR) { if (raw.indexOf(k) >= 0) return ROLE_PGERR[k]; }
  if (/Could not find the (table|function)|schema cache/i.test(raw)) {
    return 'A modul még nem érhető el — a 72_rbac_actions.sql nem futott le.';
  }
  return raw || 'Ismeretlen hiba.';
}

async function ROLE_rpc(name, args) {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const { data, error } = await window.sb.rpc(name, args || {});
  if (error) throw error;
  return data;
}

const ROLE_api = {
  /* A teljes mátrix EGY hívásból: műveletek, modulok, szerepkörök, jogok.
     Tartalék a 72-es előtti állapotra: a 39-es két táblája. */
  matrix: async () => {
    try { return await ROLE_rpc('role_matrix'); }
    catch (e) {
      const raw = String(e.message || e);
      if (!/Could not find the function|42883|PGRST202/i.test(raw)) throw e;
      return null;   // a 72-es nem futott le — a hívó régi nézetre esik vissza
    }
  },
  regiLista: async () => {
    const { data, error } = await window.sb.from('role_definition').select('*').order('sorrend');
    if (error) throw error;
    return data || [];
  },
  regiJogok: async () => {
    const { data, error } = await window.sb.from('role_permission').select('*');
    if (error) throw error;
    return data || [];
  },
  kapcsolo: async () => {
    try { return await ROLE_rpc('rbac_enforce_state'); } catch (e) { return null; }
  },
  save: (kod, nev, leiras, szin, sorrend, aktiv) =>
    ROLE_rpc('role_save', { p_kod: kod, p_nev: nev ?? null, p_leiras: leiras ?? null,
                            p_szin: szin ?? null, p_sorrend: sorrend ?? null,
                            p_aktiv: aktiv ?? null }),
  setSor: (kod, modul, muveletek) =>
    ROLE_rpc('role_module_actions_set',
             { p_role: kod, p_module: modul, p_actions: muveletek }),
  setPerm: (kod, permission, ad) =>
    ROLE_rpc('role_permission_set', { p_kod: kod, p_permission: permission, p_ad: ad }),
  remove: (kod) => ROLE_rpc('role_delete', { p_kod: kod }),
};

/* ---------------------------------------------------------------------------
   Csoportfeliratok. A MENU_GROUPS-ból jönnek, hogy a mátrix ugyanabban a
   rendben és ugyanazokkal a fejlécekkel álljon, mint az oldalsáv.
   --------------------------------------------------------------------------- */
const ROLE_CSOPORT_NEV = (kulcs) => {
  const g = (typeof MENU_GROUPS !== 'undefined' ? MENU_GROUPS : []).find(x => x.key === kulcs);
  return (g && g.label) || 'Egyéb';
};
const ROLE_CSOPORT_SORREND = (kulcs) => {
  const i = (typeof MENU_GROUPS !== 'undefined' ? MENU_GROUPS : []).findIndex(x => x.key === kulcs);
  return i < 0 ? 999 : i;
};

/* Egy cella. Külön komponens, hogy a 26 × 5 = 130 checkbox ne egy
   áttekinthetetlen JSX-blokkban éljen. */
function ROLE_Cella({ be, ertelmes, tiltva, onClick, cim }) {
  if (!ertelmes) {
    return <td className="px-2 py-1.5 text-center text-slate-200 select-none" title="Ezen a modulon ennek a műveletnek nincs értelme">–</td>;
  }
  return (
    <td className="px-2 py-1.5 text-center">
      <input type="checkbox" checked={!!be} disabled={tiltva} onChange={onClick}
             title={cim}
             className="w-4 h-4 accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-40" />
    </td>
  );
}

/* ---------------------------------------------------------------------------
   ROLE_Matrix — a mátrix egy szerepkörre

   A mentés SORONKÉNT megy (role_module_actions_set), nem cellánként: így egy
   modulsor öt kapcsolója EGY körútban mentődik, és nem fordulhat elő, hogy egy
   félúton megszakadt mentés után a sor felében új, felében régi jog van.
   --------------------------------------------------------------------------- */
function ROLE_Matrix({ adat, szerep, jogok, onMent, mentes, olvasoMod }) {
  const csoportok = {};
  (adat.modules || []).forEach(m => {
    if (!m.aktiv) return;
    const k = m.csoport || 'egyeb';
    (csoportok[k] = csoportok[k] || []).push(m);
  });
  const kulcsok = Object.keys(csoportok)
    .sort((a, b) => ROLE_CSOPORT_SORREND(a) - ROLE_CSOPORT_SORREND(b));
  const muveletek = adat.actions || [];

  const sorJogai = (modul) => (jogok && jogok[modul]) || [];
  const van = (modul, m) => sorJogai(modul).indexOf(m) >= 0;

  const kapcsol = (modulObj, m) => {
    const mostani = sorJogai(modulObj.kod);
    const uj = van(modulObj.kod, m) ? mostani.filter(x => x !== m) : mostani.concat([m]);
    onMent(modulObj, uj);
  };
  const sorMind = (modulObj, be) =>
    onMent(modulObj, be ? (modulObj.actions || []).slice() : []);

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <table className="w-full text-left min-w-[560px]">
        <thead className="bg-slate-50/80 text-slate-400 text-[10px] font-black uppercase tracking-wider">
          <tr>
            <th className="px-4 py-3">Modul</th>
            {muveletek.map(a => (
              <th key={a.kod} className="px-2 py-3 text-center whitespace-nowrap" title={a.leiras || ''}>
                {a.nev}
              </th>
            ))}
            <th className="px-3 py-3 text-right">Mind</th>
          </tr>
        </thead>
        <tbody className="text-sm">
          {kulcsok.map(k => (
            <React.Fragment key={k}>
              <tr className="bg-slate-50/60">
                <td colSpan={muveletek.length + 2}
                    className="px-4 py-1.5 text-[10px] font-black text-slate-400 uppercase tracking-[0.14em]">
                  {ROLE_CSOPORT_NEV(k)}
                </td>
              </tr>
              {csoportok[k].map(m => {
                const db = sorJogai(m.kod).length;
                return (
                  <tr key={m.kod} className="border-t border-slate-50 hover:bg-slate-50/40">
                    <td className="px-4 py-1.5">
                      <span className="font-bold text-slate-700" data-no-i18n="1">{m.nev}</span>
                      <code className="ml-2 text-[10px] font-bold text-slate-300">{m.kod}</code>
                      {!van(m.kod, 'VIEW') && db > 0 && (
                        <span className="ml-2 text-[10px] font-bold text-amber-600"
                              title="Van joga a modulon, de a menüben nem látja. Ez lehet szándékos — lásd a magyarázatot a mátrix alatt.">
                          menüben nem látszik
                        </span>
                      )}
                    </td>
                    {muveletek.map(a => (
                      <ROLE_Cella key={a.kod}
                        be={van(m.kod, a.kod)}
                        ertelmes={(m.actions || []).indexOf(a.kod) >= 0}
                        tiltva={olvasoMod || mentes === m.kod}
                        cim={a.nev + ' — ' + m.nev}
                        onClick={() => kapcsol(m, a.kod)} />
                    ))}
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <button type="button" disabled={olvasoMod || mentes === m.kod}
                        onClick={() => sorMind(m, db < (m.actions || []).length)}
                        className="text-[10px] font-bold text-slate-400 hover:text-primary disabled:opacity-40">
                        {db < (m.actions || []).length ? 'mind' : 'semmi'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   ROLE_Tab — a Regisztrációk ötödik füle (és a Rendszerkezelés RBAC füle)
   --------------------------------------------------------------------------- */
function ROLE_Tab({ rows, user }) {
  const [adat, setAdat]         = useState(undefined);  // undefined = betöltés
  const [regiSzerepek, setRegi] = useState(null);       // tartalék a 72-es előtt
  const [regiJogok, setRegiJogok] = useState([]);
  const [kapcsolo, setKapcsolo] = useState(null);
  const [nyitott, setNyitott]   = useState('');
  const [mentes, setMentes]     = useState('');
  const [err, setErr]           = useState('');
  const [ok, setOk]             = useState('');
  const [ujKod, setUjKod]       = useState('');
  const [ujNev, setUjNev]       = useState('');
  const isSuper = !!(user && user.role === 'SUPERADMIN');

  const betolt = React.useCallback(async () => {
    try {
      setErr('');
      const [m, k] = await Promise.all([ROLE_api.matrix(), ROLE_api.kapcsolo()]);
      setKapcsolo(k);
      if (m) { setAdat(m); setRegi(null); return; }
      // A 72-es nem futott le: a 39-es nézetére esünk vissza, hogy a fül
      // ne fehér lapot mutasson, hanem a mai, menüpont-szintű beállítást.
      const [r, p] = await Promise.all([ROLE_api.regiLista(), ROLE_api.regiJogok()]);
      setAdat(null); setRegi(r); setRegiJogok(p);
    } catch (e) { setErr(ROLE_msg(e)); setAdat(null); setRegi([]); }
  }, []);
  useEffect(() => { betolt(); }, [betolt]);

  /* A fiókszám csak akkor jelenik meg, ha a hívó tényleg átadta a profilokat.
     A Rendszerkezelés füle nem tölt profil-listát: ott a szám elhagyása
     helyesebb, mint minden szerepkörre hamis nullát írni. */
  const viselok = (kod) => Array.isArray(rows)
    ? rows.filter(r => r.role === kod).length : null;

  const muvelet = async (fn, siker, kulcs) => {
    try { setErr(''); setOk(''); setMentes(kulcs || ''); await fn(); setOk(siker || ''); await betolt(); }
    catch (e) { setErr(ROLE_msg(e)); }
    finally { setMentes(''); }
  };

  /* ---- a 72-es előtti, menüpont-szintű nézet (változatlan viselkedés) ---- */
  const regiNezet = () => (
    <div className="space-y-3">
      <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 text-sm">
        <strong>A művelet-szintű jogosultság még nincs bekapcsolva.</strong> A
        {' '}<code>72_rbac_actions.sql</code> migráció lefutása után itt modulonként
        kapcsolható lesz a megtekintés, használat, létrehozás, szerkesztés és törlés.
        Addig a régi, menüpont-szintű beállítás látszik — és pontosan úgy működik, ahogy eddig.
      </div>
      {(regiSzerepek || []).map(sz => {
        const j = regiJogok.filter(x => x.role_kod === sz.kod).map(x => x.permission);
        const zarolt = sz.kod === 'SUPERADMIN';
        return (
          <div key={sz.kod} className="bg-white border border-slate-100 rounded-2xl p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-black text-slate-800" data-no-i18n="1">{sz.nev}</span>
              <code className="text-[10px] font-bold text-slate-400 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5">{sz.kod}</code>
              {zarolt && <span className="text-[10px] font-bold text-primary inline-flex items-center gap-1"><Lucide.Lock size={10} /> nem szerkeszthető</span>}
              <span className="ml-auto text-[11px] font-bold text-slate-400">{zarolt ? 'Minden felület' : j.length + ' menüpont'}</span>
            </div>
            {!zarolt && isSuper && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {(typeof MENU_ITEMS !== 'undefined' ? MENU_ITEMS : []).map(mi => {
                  const be = j.includes(mi.id);
                  return (
                    <button key={mi.id} type="button"
                      onClick={() => muvelet(() => ROLE_api.setPerm(sz.kod, mi.id, !be),
                        (be ? 'Elvéve: ' : 'Hozzáadva: ') + mi.label)}
                      className={'px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-colors ' +
                        (be ? 'bg-primary text-white border-primary'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-primary')}>
                      {mi.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  /* ---- a mátrix-nézet ---- */
  const jogokSzerepnek = (kod) => (adat && adat.grants && adat.grants[kod]) || {};

  return (
    <div className="mt-6 space-y-4">
      <p className="text-[12px] text-slate-400 max-w-3xl">
        Itt állítható be, melyik szerepkör mely modulon mit tehet. A menüben az jelenik meg,
        amire a szerepkörnek <strong>Megtekintés</strong> joga van. A <strong>Superadmin</strong>
        {' '}hozzáférése szándékosan nem szerkeszthető — enélkül ki lehetne zárni magadat abból
        a képernyőből is, amivel visszaállítanád.
      </p>

      {kapcsolo && kapcsolo.enforce === false && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-300 text-amber-900 rounded-xl px-4 py-3 text-sm font-semibold">
          <Lucide.AlertTriangle size={16} className="mt-0.5 flex-none" />
          <span className="flex-1">
            <strong>A jogosultsági kikényszerítés KI VAN KAPCSOLVA.</strong> A vészkapcsoló
            nyitva van, tehát az itt beállított tiltások nem érvényesülnek. Visszakapcsolás:
            {' '}<code>select public.rbac_enforce_set(true);</code>
          </span>
        </div>
      )}

      {err && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
          <Lucide.AlertCircle size={16} className="mt-0.5 flex-none" />
          <span className="flex-1">{err}</span>
          <button onClick={() => setErr('')} className="text-red-400 hover:text-red-700"><Lucide.X size={14} /></button>
        </div>
      )}
      {ok && (
        <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-4 py-3 text-sm font-semibold">
          <Lucide.CheckCircle2 size={16} className="mt-0.5 flex-none" />
          <span className="flex-1">{ok}</span>
          <button onClick={() => setOk('')} className="text-emerald-500 hover:text-emerald-700"><Lucide.X size={14} /></button>
        </div>
      )}

      {adat === undefined && <div className="text-sm text-slate-400 py-6">Betöltés…</div>}
      {adat === null && regiSzerepek && regiNezet()}

      {adat && (
        <div className="space-y-3">
          {(adat.roles || []).map(sz => {
            const jogok  = jogokSzerepnek(sz.kod);
            const nyit   = nyitott === sz.kod;
            const zarolt = !!sz.superadmin;
            const db     = Object.keys(jogok).reduce((n, k) => n + (jogok[k] || []).length, 0);
            const lathato = Object.keys(jogok).filter(k => (jogok[k] || []).indexOf('VIEW') >= 0).length;
            return (
              <div key={sz.kod} className={'bg-white border rounded-2xl overflow-hidden ' +
                (sz.aktiv ? 'border-slate-100' : 'border-slate-200 bg-slate-50/60')}>
                <div className="flex items-start gap-4 p-4">
                  <div className={'w-10 h-10 rounded-xl flex-none flex items-center justify-center ' +
                    (zarolt ? 'bg-primary/10 text-primary' : 'bg-slate-100 text-slate-500')}>
                    <Lucide.Shield size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-black text-slate-800" data-no-i18n="1">{sz.nev}</span>
                      <code className="text-[10px] font-bold text-slate-400 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5">{sz.kod}</code>
                      {zarolt && <span className="text-[10px] font-bold text-primary inline-flex items-center gap-1"><Lucide.Lock size={10} /> nem szerkeszthető</span>}
                      {!sz.aktiv && <span className="text-[10px] font-bold text-slate-400">kikapcsolva</span>}
                      {viselok(sz.kod) !== null && (
                        <span className="text-[11px] font-bold text-slate-400">{viselok(sz.kod)} fiók</span>
                      )}
                    </div>
                    {sz.leiras && <p className="text-[13px] text-slate-500 mt-0.5" data-no-i18n="1">{sz.leiras}</p>}
                    <p className="text-[11px] text-slate-400 mt-1">
                      {zarolt ? 'Minden modul, minden művelet'
                              : lathato + ' menüpont · ' + db + ' jog'}
                    </p>
                  </div>
                  {!zarolt && isSuper && (
                    <button onClick={() => setNyitott(nyit ? '' : sz.kod)}
                      className={U_btnGhost + ' !py-2 !px-3 text-xs flex-none'}>
                      <Lucide.Sliders size={14} /> {nyit ? 'Bezár' : 'Beállítás'}
                    </button>
                  )}
                </div>

                {nyit && !zarolt && (
                  <div className="border-t border-slate-100 p-4 space-y-4 bg-slate-50/50">
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">Megnevezés</label>
                        <input defaultValue={sz.nev} className={U_input + ' mt-1'}
                          onBlur={e => e.target.value.trim() && e.target.value !== sz.nev &&
                            muvelet(() => ROLE_api.save(sz.kod, e.target.value.trim()), 'Megnevezés mentve.')} />
                      </div>
                      <div>
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">Leírás</label>
                        <input defaultValue={sz.leiras || ''} className={U_input + ' mt-1'}
                          onBlur={e => e.target.value !== (sz.leiras || '') &&
                            muvelet(() => ROLE_api.save(sz.kod, null, e.target.value), 'Leírás mentve.')} />
                      </div>
                    </div>

                    <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
                      <ROLE_Matrix
                        adat={adat}
                        szerep={sz.kod}
                        jogok={jogok}
                        mentes={mentes}
                        olvasoMod={!isSuper}
                        onMent={(modulObj, muveletek) =>
                          muvelet(() => ROLE_api.setSor(sz.kod, modulObj.kod, muveletek),
                                  modulObj.nev + ': mentve.', modulObj.kod)} />
                    </div>

                    {/* A KÉT TENGELY. Ezt ki kell mondani, különben valaki „kijavítja". */}
                    <div className="text-[11px] text-slate-500 space-y-1.5 max-w-3xl">
                      <p>
                        <strong>A menü és a műveletek két külön tengely.</strong> A menüben az
                        látszik, amire <em>Megtekintés</em> jog van. Van olyan sor, ahol
                        szándékosan van írási jog <em>Megtekintés</em> nélkül: a mai
                        adatbázis-szabály úgy engedi. Például a <strong>Pénzügy</strong> írhatja
                        a jelentkezői sort (a befizetés rögzítése a jelentkező státuszát is
                        állítja), de a Felvételi menüpontot nem látja. Ez nem hiba.
                      </p>
                      <p>
                        {/* Egyetlen szövegcsomópont, szándékosan: egy beékelt <strong>
                            három darabra vágná, és az i18n-szótár szavanként kellene. */}
                        Néhány képernyőnek saját szabálya is van (Regisztrációk, ECHO- és
                        kollégiumi jogosultságok) — azt ez a mátrix nem írja felül.
                      </p>
                      <p>
                        A <code>–</code> jel azt jelenti: azon a modulon annak a műveletnek nincs
                        értelme, ezért nem is kapcsolható.
                      </p>
                    </div>

                    <div className="flex items-center gap-3 pt-2 border-t border-slate-200">
                      <button onClick={() => muvelet(() => ROLE_api.save(sz.kod, null, null, null, null, !sz.aktiv),
                          sz.aktiv ? 'Kikapcsolva.' : 'Bekapcsolva.')}
                        className={U_btnGhost + ' !py-2 !px-3 text-xs'}>
                        {sz.aktiv ? 'Kikapcsolás' : 'Bekapcsolás'}
                      </button>
                      {!sz.beepitett && (
                        <button onClick={() => muvelet(() => ROLE_api.remove(sz.kod), 'Szerepkör törölve.')}
                          className={U_btnGhost + ' !py-2 !px-3 text-xs !text-red-600 hover:!bg-red-50'}>
                          <Lucide.Trash2 size={14} /> Törlés
                        </button>
                      )}
                      <span className="ml-auto text-[11px] text-slate-400">
                        {sz.beepitett ? 'Beépített szerepkör — törölni nem, kikapcsolni lehet.' : 'Saját szerepkör.'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isSuper && (adat || regiSzerepek) && (
        <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-4">
          <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">Új szerepkör</label>
          <div className="flex gap-2 mt-2 flex-wrap">
            <input value={ujKod} onChange={e => setUjKod(e.target.value.toUpperCase())}
              placeholder="KÓD (pl. KOORDINATOR)" className={U_input + ' flex-1 min-w-[180px]'} />
            <input value={ujNev} onChange={e => setUjNev(e.target.value)}
              placeholder="Megnevezés" className={U_input + ' flex-1 min-w-[180px]'} />
            <button disabled={!ujKod.trim() || !ujNev.trim()}
              onClick={() => muvelet(() => ROLE_api.save(ujKod.trim(), ujNev.trim()), 'Szerepkör létrehozva.')
                .then(() => { setUjKod(''); setUjNev(''); })}
              className={U_btnPrimary + ' !py-2 !px-4 text-sm'}>Létrehozás</button>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            Az új szerepkör kezdetben egyetlen jogot sem kap — a Beállítás alatt add hozzá,
            amit szeretnél. A Felhasználók fülön utána hozzárendelhető egy fiókhoz.
          </p>
        </div>
      )}
    </div>
  );
}
