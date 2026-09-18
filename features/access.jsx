/* ============================================================
   JOGOSULTSÁGOK — ki mit lát, mihez van joga, milyen munkakörben
   (73_user_access.sql, 39_role_admin.sql, 38_student_groups.sql)

   HÁROM SZINT, EGY KÉPERNYŐN
     Szerepkör → mindenkire hat, aki azt a szerepkört viseli;
     Csoport   → a csoport tagjaira (kézi tagság vagy szabály);
     Egyéni    → egyetlen emberre, kivételként.
   Mindhárom CSAK ADHAT menüpontot. Elvenni egyik sem tud: a menüszűrő utolsó
   szava a tiltás. Ezért nincs „letiltás” gomb — az a látszat, hogy egy jogot
   elvettünk, veszélyesebb, mint a hiánya.

   A SZUPERADMIN hozzáférése nem állítható. Ha elvehető lenne, ki lehetne zárni
   magunkat abból a képernyőből is, amivel visszaállítanánk.
   ============================================================ */

const ACC_rpc = async (nev, args) => {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const { data, error } = await window.sb.rpc(nev, args || {});
  if (error) throw error;
  return data;
};
const ACC_nincsMigracio = (e) => {
  const m = ((e && e.message) || '') + ((e && e.code) || '');
  return /access_user_|my_user_permissions|schema cache|PGRST202/i.test(m);
};
const ACC_msg = (e) => {
  const m = (e && e.message) || '';
  if (/ACC_SUPERADMIN_FIX/.test(m)) return 'A szuperadmin hozzáférése szándékosan nem állítható.';
  if (/ACC_FORBIDDEN: egyeni/.test(m)) return 'Egyéni jogot csak szuperadmin adhat.';
  if (/ACC_FORBIDDEN/.test(m)) return 'Ehhez a művelethez nincs jogosultságod.';
  if (/ACC_NOT_FOUND/.test(m)) return 'Ez a fiók nem található.';
  if (/ACC_BAD_PERMISSION/.test(m)) return 'Ismeretlen menüpont-azonosító.';
  return m || 'Ismeretlen hiba.';
};

const ACC_menuk = () => (typeof MENU_ITEMS !== 'undefined' ? MENU_ITEMS : []);
const ACC_menuNev = (id) => {
  const mi = ACC_menuk().find(m => m.id === id);
  return mi ? mi.label : id;
};

/* Honnan kapja a menüpontot: szerepkör, csoport (melyik), egyéni. Ugyanaz a
   menüpont több helyről is jöhet — mindegyiket kiírjuk, mert enélkül a
   felhasználó feleslegesen ad újat, vagy hiába vesz el. */
function ACC_forrasok(d, id) {
  const ki = [];
  if ((d.szerep_jogok || []).indexOf(id) >= 0) ki.push({ tipus: 'szerep', cimke: 'szerepkör' });
  (d.csoportok || []).forEach(g => {
    if ((g.jogok || []).indexOf(id) >= 0) ki.push({ tipus: 'csoport', cimke: g.nev });
  });
  if ((d.egyeni_jogok || []).indexOf(id) >= 0) ki.push({ tipus: 'egyeni', cimke: 'egyéni' });
  return ki;
}

function ACC_Szemelyek({ user }) {
  const [q, setQ]           = useState('');
  const [keres, setKeres]   = useState('');
  const [szerep, setSzerep] = useState('');
  const [lista, setLista]   = useState(null);
  const [opciok, setOpciok] = useState(null);
  const [kivalasztott, setKiv] = useState(null);
  const [d, setD]           = useState(null);
  const [err, setErr]       = useState('');
  const [ok, setOk]         = useState('');
  const [busy, setBusy]     = useState(false);
  const [nincs, setNincs]   = useState(false);
  const [munkakor, setMunkakor] = useState({ munkakor: '', szervezeti_egyseg: '', megjegyzes: '' });
  const isSuper = !!(user && user.role === 'SUPERADMIN');

  useEffect(() => { const t = setTimeout(() => setKeres(q), 350); return () => clearTimeout(t); }, [q]);

  const tolts = React.useCallback(() => {
    ACC_rpc('access_user_list', { p_q: keres || null, p_szerep: szerep || null, p_limit: 200, p_offset: 0 })
      .then(r => { setLista(r); setErr(''); })
      .catch(e => { setLista(null); if (ACC_nincsMigracio(e)) setNincs(true); else setErr(ACC_msg(e)); });
  }, [keres, szerep]);
  useEffect(() => { tolts(); }, [tolts]);

  useEffect(() => {
    ACC_rpc('access_job_options').then(setOpciok).catch(() => setOpciok(null));
  }, []);

  useEffect(() => {
    if (!kivalasztott) { setD(null); return; }
    let el = true;
    ACC_rpc('access_user_get', { p_profile: kivalasztott })
      .then(r => { if (!el) return; setD(r); setErr('');
        setMunkakor({ munkakor: (r.munkakor && r.munkakor.munkakor) || '',
                      szervezeti_egyseg: (r.munkakor && r.munkakor.szervezeti_egyseg) || '',
                      megjegyzes: (r.munkakor && r.munkakor.megjegyzes) || '' }); })
      .catch(e => { if (el) { setD(null); setErr(ACC_msg(e)); } });
    return () => { el = false; };
  }, [kivalasztott]);

  const muvelet = async (fn, siker) => {
    setBusy(true); setErr(''); setOk('');
    try { const r = await fn(); if (r) setD(r); setOk(siker || ''); tolts(); }
    catch (e) { setErr(ACC_msg(e)); }
    finally { setBusy(false); }
  };

  const jogValt = (id, van) => muvelet(
    () => ACC_rpc('access_user_permission_set', { p_profile: kivalasztott, p_permission: id, p_ad: !van }),
    van ? 'Az egyéni jog visszavonva.' : 'Egyéni jog hozzáadva.');

  const munkakorMent = () => muvelet(
    () => ACC_rpc('access_user_job_set', {
      p_profile: kivalasztott, p_munkakor: munkakor.munkakor,
      p_szervezeti_egyseg: munkakor.szervezeti_egyseg, p_megjegyzes: munkakor.megjegyzes }),
    'A munkakör elmentve.');

  if (nincs) {
    return <UEmpty icon={<Lucide.KeyRound size={26} />} title="Az egyéni jogosultság még nincs telepítve"
             subtitle="Futtatni kell a supabase/73_user_access.sql migrációt. A Szerepkörök és a Csoportok fül addig is működik." />;
  }

  const sorok = (lista && lista.sorok) || [];

  return (
    <div className="mt-6 grid lg:grid-cols-[minmax(0,380px),1fr] gap-4" data-acc-szemelyek="1">
      {/* bal: névsor */}
      <div className="space-y-3">
        <div className="relative">
          <Lucide.Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
          <input className={U_input + ' pl-11'} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Név, e-mail vagy munkakör…" data-acc-kereso="1" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[['', 'Mind']].concat(((opciok && opciok.szerep) || []).map(x => [x.ertek, x.ertek + ' · ' + x.db]))
            .map(([k, cimke]) => (
            <button key={k || 'mind'} onClick={() => setSzerep(k)} data-acc-szerep={k || 'mind'}
              className={'px-2.5 py-1 rounded-xl border text-[11px] font-bold transition-all ' +
                (szerep === k ? 'border-primary bg-primary/10 text-primary' : 'border-slate-100 bg-white text-slate-500 hover:border-slate-300')}>
              {cimke}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden max-h-[70vh] overflow-y-auto">
          {lista === null ? <div className="p-5 space-y-2">{[0, 1, 2].map(i => <SkeletonBar key={i} h={30} />)}</div>
            : sorok.length === 0 ? <UEmpty icon={<Lucide.SearchX size={22} />} title="Nincs találat" />
            : sorok.map(r => (
              <button key={r.id} onClick={() => setKiv(r.id)} data-acc-sor={r.id}
                className={'w-full text-left px-4 py-3 border-b border-slate-50 last:border-0 transition-colors '
                  + (kivalasztott === r.id ? 'bg-primary/5' : 'hover:bg-slate-50')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-black text-slate-800 truncate">{r.nev}</span>
                  <span className="text-[10px] font-black text-slate-400 flex-none">{r.szerep}</span>
                </div>
                <div className="text-[11px] font-bold text-slate-400 truncate">{r.email}</div>
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                  {r.munkakor && <UBadge tone="blue">{r.munkakor}</UBadge>}
                  {(r.csoportok || []).length > 0 && <UBadge tone="slate">{(r.csoportok || []).length} csoport</UBadge>}
                  {Number(r.egyeni_jog_db) > 0 && <UBadge tone="violet">{r.egyeni_jog_db} egyéni jog</UBadge>}
                </div>
              </button>
            ))}
        </div>
        {lista && lista.ossz > sorok.length && (
          <p className="text-[11px] text-slate-400">{sorok.length} / {lista.ossz} — szűkíts a kereséssel.</p>
        )}
      </div>

      {/* jobb: a kiválasztott ember */}
      <div className="space-y-4">
        {err && <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600">{err}</div>}
        {ok && <div className="bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-3 text-sm font-bold text-emerald-700">{ok}</div>}

        {!kivalasztott ? (
          <UEmpty icon={<Lucide.UserCog size={26} />} title="Válassz valakit a listából"
            subtitle="Itt látszik majd, honnan kapja a jogosultságait, és itt adható meg a munkaköre." />
        ) : !d ? <SkeletonBar h={160} /> : (
          <>
            <div className="bg-white rounded-3xl border border-slate-100 p-5" data-acc-lap={kivalasztott}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-lg font-black text-slate-900">{d.profil.nev}</h3>
                  <p className="text-[12px] font-bold text-slate-400">{d.profil.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <UBadge tone="slate">{d.profil.szerep}</UBadge>
                  {d.mindent_lat && <UBadge tone="amber">mindent lát</UBadge>}
                </div>
              </div>
              {d.mindent_lat && (
                <p className="text-[11px] text-amber-700 font-bold mt-2">
                  A szuperadmin minden képernyőt lát, és ez szándékosan nem állítható — enélkül ki
                  lehetne zárni magát abból a felületből is, amivel visszaállítaná.
                </p>
              )}
            </div>

            {/* munkakör */}
            <div className="bg-white rounded-3xl border border-slate-100 p-5 space-y-3" data-acc-munkakor="1">
              <div>
                <h4 className="text-sm font-black text-slate-800">Munkakör</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Adminisztratív adat: leírja, mit csinál az illető. Önmagában egyetlen képernyőt sem nyit meg —
                  a hozzáférést a szerepkör, a csoport vagy az egyéni jog adja.
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <UField label="Beosztás">
                  <input className={U_input} value={munkakor.munkakor} list="acc-munkakorok"
                    onChange={e => setMunkakor(p => ({ ...p, munkakor: e.target.value }))}
                    placeholder="pl. felvételi ügyintéző" />
                </UField>
                <UField label="Szervezeti egység">
                  <input className={U_input} value={munkakor.szervezeti_egyseg} list="acc-egysegek"
                    onChange={e => setMunkakor(p => ({ ...p, szervezeti_egyseg: e.target.value }))}
                    placeholder="pl. Nemzetközi Iroda" />
                </UField>
              </div>
              <datalist id="acc-munkakorok">
                {((opciok && opciok.munkakor) || []).map(x => <option key={x.ertek} value={x.ertek} />)}
              </datalist>
              <datalist id="acc-egysegek">
                {((opciok && opciok.szervezeti_egyseg) || []).map(x => <option key={x.ertek} value={x.ertek} />)}
              </datalist>
              <UField label="Megjegyzés">
                <input className={U_input} value={munkakor.megjegyzes}
                  onChange={e => setMunkakor(p => ({ ...p, megjegyzes: e.target.value }))}
                  placeholder="pl. helyettesít nyáron" />
              </UField>
              <div className="flex justify-end">
                <button className={U_btnPrimary} onClick={munkakorMent} disabled={busy}>
                  <Lucide.Save size={15} /> Munkakör mentése
                </button>
              </div>
            </div>

            {/* hozzáférés */}
            <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden" data-acc-hozzaferes="1">
              <div className="px-5 py-4 border-b border-slate-100">
                <h4 className="text-sm font-black text-slate-800">Mit lát a menüben</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Minden sornál ott áll, HONNAN kapja: szerepkörből, csoportból vagy egyénileg.
                  Az egyéni jog csak ad — elvenni sem a szerepkörtől, sem a csoporttól nem tud.
                  {!isSuper && ' Az egyéni jogokat szuperadmin állítja.'}
                </p>
              </div>
              <div className="divide-y divide-slate-50 max-h-[60vh] overflow-y-auto">
                {ACC_menuk().map(mi => {
                  const f = ACC_forrasok(d, mi.id);
                  const egyeni = f.some(x => x.tipus === 'egyeni');
                  const lat = d.mindent_lat || f.length > 0;
                  return (
                    <div key={mi.id} data-acc-menu={mi.id}
                      className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <div className="min-w-0 flex items-center gap-2.5">
                        <span className={'w-6 h-6 rounded-lg flex items-center justify-center flex-none '
                          + (lat ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-300')}>
                          {lat ? <Lucide.Check size={13} /> : <Lucide.Minus size={13} />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[13px] font-bold text-slate-700 truncate">{mi.label}</p>
                          <p className="text-[10px] font-bold text-slate-400 truncate">
                            {d.mindent_lat ? 'szuperadmin — mindent lát'
                              : f.length === 0 ? 'nincs hozzáférése'
                              : f.map(x => x.tipus === 'csoport' ? 'csoport: ' + x.cimke : x.cimke).join(' · ')}
                          </p>
                        </div>
                      </div>
                      {!d.mindent_lat && (
                        <button onClick={() => jogValt(mi.id, egyeni)} disabled={busy || !isSuper}
                          data-acc-egyeni={mi.id}
                          className={'flex-none px-2.5 py-1 rounded-xl border text-[11px] font-black transition-all disabled:opacity-40 '
                            + (egyeni ? 'border-violet-200 bg-violet-50 text-violet-700'
                                      : 'border-slate-100 text-slate-400 hover:border-primary hover:text-primary')}>
                          {egyeni ? 'egyéni jog · vissza' : '+ egyéni jog'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* csoportok */}
            <div className="bg-white rounded-3xl border border-slate-100 p-5">
              <h4 className="text-sm font-black text-slate-800">Csoportjai</h4>
              {(d.csoportok || []).length === 0 ? (
                <p className="text-[12px] font-bold text-slate-300 italic mt-2">egyetlen csoportnak sem tagja</p>
              ) : (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {d.csoportok.map(g => (
                    <span key={g.id} className="px-2.5 py-1 rounded-xl bg-slate-50 border border-slate-100 text-[11px] font-bold text-slate-600">
                      {g.nev}<span className="ml-1 opacity-50">{g.tipus === 'szabaly' ? 'szabály' : 'kézi'}</span>
                      {(g.jogok || []).length > 0 && <span className="ml-1 text-primary">+{g.jogok.length}</span>}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-slate-400 mt-2">
                A csoporttagságot és a csoport jogait a „Csoportok” fülön lehet szerkeszteni.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ACC_View({ user }) {
  const [ful, setFul]   = useState('szemelyek');
  const [rows, setRows] = useState([]);

  // A Szerepkörök és a Csoportok fül a REGISZTRÁCIÓK képernyőről ismert
  // komponens — ugyanaz a kód, csak itt is elérhető. Mindkettő a profilok
  // listáját várja (tagság és szabály-építés).
  useEffect(() => {
    if (typeof REG_loadProfiles !== 'function') return;
    REG_loadProfiles().then(r => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([]));
  }, []);

  const fulek = [
    ['szemelyek', 'Személyek', Lucide.UserCog],
    ['szerepkorok', 'Szerepkörök', Lucide.Shield],
    ['csoportok', 'Csoportok', Lucide.Users],
  ];

  return (
    <div className="p-4 sm:p-8 max-w-[1500px] mx-auto animate-in fade-in duration-300" data-acc-nezet="1">
      <div className="mb-5">
        <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">Rendszer</p>
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Jogosultságok</h1>
        <p className="text-slate-400 mt-1 font-medium text-sm max-w-3xl">
          Ki mit lát a menüben, és milyen munkakörben. Három szinten állítható: szerepkörönként,
          csoportonként és egyénenként. Mindhárom csak ad hozzáférést — elvenni egyik sem tud.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-2">
        {fulek.map(([k, cimke, I]) => (
          <button key={k} onClick={() => setFul(k)} data-acc-ful={k}
            className={'inline-flex items-center gap-2 px-4 py-2 rounded-2xl border text-[13px] font-bold transition-all '
              + (ful === k ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 bg-white text-slate-500 hover:border-slate-300')}>
            <I size={15} /> {cimke}
          </button>
        ))}
      </div>

      {ful === 'szemelyek' && <ACC_Szemelyek user={user} />}
      {ful === 'szerepkorok' && (typeof ROLE_Tab === 'function'
        ? <ROLE_Tab rows={rows} user={user} />
        : <UEmpty icon={<Lucide.Shield size={26} />} title="A szerepkör-kezelés nem érhető el" />)}
      {ful === 'csoportok' && (typeof GRP_Tab === 'function'
        ? <GRP_Tab rows={rows} user={user} />
        : <UEmpty icon={<Lucide.Users size={26} />} title="A csoportkezelés nem érhető el" />)}
    </div>
  );
}
