/* ===========================================================================
   groups.jsx — Felhasználói csoportok és csoport-jogosultság

   A Regisztrációk negyedik füleként él, mert a csoportok ugyanarról a
   névsorról szólnak, mint a másik három fül.

   KÉTFÉLE CSOPORT
     kézi     — kézzel összeválogatott névsor
     szabály  — a besorolásból következik (pl. "minden nappali
                mérnökinformatikus"); a tagság magától frissül, ha valakinek
                megváltozik a besorolása

   A JOGOSULTSÁG CSAK ADHAT
     A menüszűrő utolsó ága `return false`, és a csoportos ág közvetlenül
     ELŐTTE fut le. Egy csoport tehát megnyithat egy felületet, de elvenni
     nem tud semmit — egy elrontott szabály nem zárhat ki senkit a saját
     munkájából. Ezt a felület ki is írja, hogy ne kelljen kitalálni.

   Adatbázis: 38_student_groups.sql
   =========================================================================== */

const GRP_PGERR = {
  '42501':   'Ehhez a művelethez nincs jogosultsága.',
  'PGRST301':'A munkamenet lejárt. Jelentkezzen be újra.',
  '23505':   'Ilyen nevű csoport már van.',
  '42P01':   'A modul táblái hiányoznak — a 38_student_groups.sql még nem futott le.',
  '42883':   'A modul függvényei hiányoznak — a 38_student_groups.sql még nem futott le.',
  'PGRST205':'A modul táblái hiányoznak — a 38_student_groups.sql még nem futott le.',
  'PGRST202':'A modul függvényei hiányoznak — a 38_student_groups.sql még nem futott le.',
};

function GRP_msg(e) {
  if (!e) return 'Ismeretlen hiba.';
  const raw = String(e.message || e.details || e.hint || e);
  const code = e.code || (e.error && e.error.code);
  /* A szerver saját magyar mondata a legjobb üzenet — ha van, azt adjuk. */
  if (/[őűáéíóöúüÁÉÍÓÖŐÚÜŰ]/.test(raw) && raw.length > 12) return raw;
  if (code && GRP_PGERR[code]) return GRP_PGERR[code];
  for (const k in GRP_PGERR) { if (raw.indexOf(k) >= 0) return GRP_PGERR[k]; }
  if (/Could not find the (table|function)|schema cache/i.test(raw)) {
    return 'A modul még nem érhető el — a 38_student_groups.sql nem futott le.';
  }
  if (/Failed to fetch|NetworkError/i.test(raw)) return 'Nincs kapcsolat a kiszolgálóval.';
  return raw || 'Ismeretlen hiba.';
}

async function GRP_rpc(name, args) {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const { data, error } = await window.sb.rpc(name, args || {});
  if (error) throw error;
  return data;
}

const GRP_api = {
  list: async () => {
    if (!window.sb) return [];
    const { data, error } = await window.sb.from('user_group').select('*').order('nev');
    if (error) throw error;
    return data || [];
  },
  permissions: async () => {
    if (!window.sb) return [];
    const { data, error } = await window.sb.from('group_permission').select('*');
    if (error) throw error;
    return data || [];
  },
  members: (id) => GRP_rpc('group_members', { p_group: id }),
  save: (id, nev, leiras, tipus, szabaly, szin) =>
    GRP_rpc('group_save', {
      p_id: id || null, p_nev: nev, p_leiras: leiras || null,
      p_tipus: tipus, p_szabaly: szabaly || null, p_szin: szin || null }),
  setMember: (group, profile, tag) =>
    GRP_rpc('group_member_set', { p_group: group, p_profile: profile, p_tag: tag }),
  setPermission: (group, permission, ad) =>
    GRP_rpc('group_permission_set', { p_group: group, p_permission: permission, p_ad: ad }),
  remove: async (id) => {
    if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
    const { error } = await window.sb.from('user_group').delete().eq('id', id);
    if (error) throw error;
  },
};

/* A szabály mezőit a data-layer.jsx ATTR_RULE_FIELDS-e adja. Egy lista, mert a
   kampányszerkesztő és a hírfolyam ugyanezt a szabályt állítja össze — három
   külön lista előbb-utóbb elcsúszna a szerver zárt mezőlistájától. */

/* Milyen értékek fordulnak elő ténylegesen — a már betöltött névsorból.
   Nem kérdezzük külön a szervertől: a Regisztrációk úgyis behúzta. */
function GRP_options(rows, mezo) {
  const m = new Map();
  for (const r of rows || []) {
    const v = r[mezo];
    if (v) m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const GRP_Chip = ({ text, tone, onClick, active }) => (
  <button type="button" onClick={onClick} disabled={!onClick}
    className={'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-colors ' +
      (active ? 'bg-primary text-white border-primary'
              : (tone || 'bg-white text-slate-600 border-slate-200')) +
      (onClick ? ' hover:border-primary cursor-pointer' : ' cursor-default')}>
    {text}
  </button>
);

const GRP_Err = ({ text, onClose }) => !text ? null : (
  <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
    <Lucide.AlertCircle size={16} className="mt-0.5 flex-none" />
    <span className="flex-1">{text}</span>
    {onClose && <button onClick={onClose} className="text-red-400 hover:text-red-700"><Lucide.X size={14} /></button>}
  </div>
);

/* ---------------------------------------------------------------------------
   GRP_RuleBuilder — a szabály összeállítása kattintással

   MIÉRT NEM SZABAD SZÖVEG: a szerver zárt mezőlistán értékel (elgépelt
   mezőnév SENKIRE nem illeszkedik, nem mindenkire). A felület ugyanezt a
   listát kínálja, tehát elgépelni sincs mit.

   Az élő találatszám azért kell, mert egy szabály következménye nem
   nyilvánvaló: "nappali + mesterképzés" simán lehet nulla ember.
   --------------------------------------------------------------------------- */
function GRP_RuleBuilder({ rows, szabaly, onChange }) {
  /* Az értékkészlet a MÁR BETÖLTÖTT névsorból — a Regisztrációk úgyis behúzta,
     nem kérünk érte külön kört a szervertől. A kártya {ertek, db} alakot vár. */
  const opciok = React.useMemo(() => {
    const ki = {};
    ATTR_RULE_FIELDS.forEach(([k]) => {
      ki[k] = GRP_options(rows, k).map(([ertek, db]) => ({ ertek, db }));
    });
    return ki;
  }, [rows]);

  /* Hány emberre illeszkedik MOST — ugyanazzal a logikával, amit a szerver
     használ: a mezők ÉS, a listán belüli értékek VAGY kapcsolatban. Itt
     kliensoldalon fut, mert a névsor már a kezünkben van. */
  const szamol = React.useCallback((sz) => (rows || []).filter(r =>
    Object.entries(sz).every(([m, v]) =>
      Array.isArray(v) ? v.includes(r[m]) : r[m] === v)).length, [rows]);

  /* EGY kártya: a csoport szabálya egyetlen objektum (user_group.szabaly). A
     kampány és a hírfolyam ugyanebből a kártyából többet is felvehet. */
  return (
    <div className="space-y-2.5">
      <AttrRuleCard ertek={szabaly || {}} opciok={opciok} szamol={szamol} cim={null}
        onChange={(sz) => onChange(Object.keys(sz).length ? sz : null)} />
      {szabaly && Object.keys(szabaly).length > 0 && (
        <button type="button" onClick={() => onChange(null)}
          className="text-[11px] font-bold text-slate-400 hover:text-slate-700">
          Szabály törlése
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   GRP_Editor — egy csoport szerkesztése
   --------------------------------------------------------------------------- */
function GRP_Editor({ csoport, rows, jogok, onClose, onSaved, isSuper }) {
  const uj = !csoport || !csoport.id;
  const [nev, setNev]         = useState((csoport && csoport.nev) || '');
  const [leiras, setLeiras]   = useState((csoport && csoport.leiras) || '');
  const [tipus, setTipus]     = useState((csoport && csoport.tipus) || 'kezi');
  const [szabaly, setSzabaly] = useState((csoport && csoport.szabaly) || null);
  const [tagok, setTagok]     = useState(null);
  const [perm, setPerm]       = useState(new Set(jogok || []));
  const [err, setErr]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [kereses, setKereses] = useState('');

  const betolt = React.useCallback(async () => {
    if (uj) { setTagok([]); return; }
    try { setTagok(await GRP_api.members(csoport.id)); }
    catch (e) { setErr(GRP_msg(e)); setTagok([]); }
  }, [uj, csoport]);
  useEffect(() => { betolt(); }, [betolt]);

  const ment = async () => {
    if (!nev.trim()) { setErr('A csoportnak kell név.'); return; }
    if (tipus === 'szabaly' && (!szabaly || !Object.keys(szabaly).length)) {
      setErr('Szabály alapú csoporthoz állíts össze legalább egy feltételt.'); return;
    }
    setBusy(true); setErr('');
    try {
      const g = await GRP_api.save(csoport && csoport.id, nev.trim(), leiras, tipus,
                                   tipus === 'szabaly' ? szabaly : null,
                                   (csoport && csoport.szin) || null);
      onSaved && onSaved(g);
    } catch (e) { setErr(GRP_msg(e)); }
    finally { setBusy(false); }
  };

  const tagValt = async (profileId, be) => {
    try { await GRP_api.setMember(csoport.id, profileId, be); await betolt(); onSaved && onSaved(null); }
    catch (e) { setErr(GRP_msg(e)); }
  };

  const jogValt = async (id, be) => {
    try {
      await GRP_api.setPermission(csoport.id, id, be);
      setPerm(p => { const n = new Set(p); be ? n.add(id) : n.delete(id); return n; });
      onSaved && onSaved(null);
    } catch (e) { setErr(GRP_msg(e)); }
  };

  const tagIds = new Set((tagok || []).map(t => t.profile_id));
  const jeloltek = (rows || [])
    .filter(r => r.approval_status === 'approved')
    .filter(r => !kereses.trim() ||
      [r.name, r.email, r.szak].some(v => String(v || '').toLowerCase().includes(kereses.toLowerCase())))
    .slice(0, 60);

  return (
    <div className="bg-white border border-slate-200 rounded-3xl shadow-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
        <h3 className="font-black text-slate-800">{uj ? 'Új csoport' : nev}</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><Lucide.X size={18} /></button>
      </div>

      <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
        <GRP_Err text={err} onClose={() => setErr('')} />

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">Név</label>
            <input value={nev} onChange={e => setNev(e.target.value)} className={U_input + ' mt-1'}
              placeholder="pl. Nappali mérnökinformatikus" />
          </div>
          <div>
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">Leírás</label>
            <input value={leiras} onChange={e => setLeiras(e.target.value)} className={U_input + ' mt-1'}
              placeholder="Mire való ez a csoport?" />
          </div>
        </div>

        <div>
          <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">Hogyan áll össze</label>
          <div className="flex gap-2 mt-1.5">
            {[['kezi', 'Kézzel válogatva'], ['szabaly', 'Besorolás szerint']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTipus(k)} disabled={!uj}
                className={'px-4 py-2 rounded-xl text-sm font-bold border transition-colors disabled:opacity-50 ' +
                  (tipus === k ? 'bg-primary text-white border-primary'
                               : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400')}>
                {label}
              </button>
            ))}
          </div>
          {!uj && (
            <p className="text-[11px] text-slate-400 mt-1.5">
              A típus utólag nem váltható: a tagság másképp keletkezik a két esetben.
            </p>
          )}
        </div>

        {tipus === 'szabaly' && (
          <div>
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">
              Szabály — a mezők ÉS, az értékek VAGY kapcsolatban
            </label>
            <div className="mt-2">
              <GRP_RuleBuilder rows={rows} szabaly={szabaly} onChange={setSzabaly} />
            </div>
          </div>
        )}

        {/* TAGSÁG. Szabály alapú csoportnál a névsor a szabályból következik,
            ezért csak megmutatjuk — a szerver kézi módosítást el sem fogad. */}
        {!uj && (
          <div>
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">
              Tagok {tagok !== null && <span className="text-slate-300">· {tagok.length} fő</span>}
            </label>

            {tipus === 'szabaly' ? (
              <div className="mt-2 bg-slate-50 border border-slate-100 rounded-2xl p-3 max-h-48 overflow-y-auto">
                <p className="text-[11px] text-slate-400 mb-2">
                  A tagság a szabályból következik, és magától frissül, ha valakinek
                  megváltozik a besorolása. Kézzel nem szerkeszthető.
                </p>
                {(tagok || []).slice(0, 80).map(t => (
                  <div key={t.profile_id} className="text-[13px] text-slate-600 py-0.5">
                    <span className="font-semibold text-slate-700">{t.nev || t.email}</span>
                    {t.szak && <span className="text-slate-400"> — {t.szak}</span>}
                  </div>
                ))}
                {(tagok || []).length > 80 && (
                  <p className="text-[11px] text-slate-400 mt-1">…és további {tagok.length - 80} fő.</p>
                )}
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                <input value={kereses} onChange={e => setKereses(e.target.value)}
                  className={U_input} placeholder="Keresés név, e-mail vagy szak szerint…" />
                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-2 max-h-56 overflow-y-auto">
                  {jeloltek.map(r => {
                    const benne = tagIds.has(r.id);
                    return (
                      <button key={r.id} type="button" onClick={() => tagValt(r.id, !benne)}
                        className={'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors ' +
                          (benne ? 'bg-emerald-50' : 'hover:bg-white')}>
                        <span className={'w-4 h-4 rounded flex-none flex items-center justify-center border ' +
                          (benne ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 bg-white')}>
                          {benne && <Lucide.Check size={11} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold text-slate-700 truncate">{r.name || r.email}</span>
                          {r.szak && <span className="block text-[11px] text-slate-400 truncate">{r.szak}</span>}
                        </span>
                      </button>
                    );
                  })}
                  {jeloltek.length === 0 && (
                    <p className="text-[12px] text-slate-400 px-2 py-3">Nincs találat.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* JOGOSULTSÁG. Csak szuperadmin állíthatja — a szerver is ezt kéri. */}
        {!uj && (
          <div>
            <label className="text-[11px] font-black text-slate-400 uppercase tracking-wide">
              Mit lásson a csoport
            </label>
            <p className="text-[11px] text-slate-400 mt-1 mb-2">
              A csoport <strong>csak megnyithat</strong> egy felületet — elvenni nem tud
              semmit. Amit a szerepkör már megad, azt ez nem befolyásolja.
              {!isSuper && ' Beállítani csak szuperadmin tud.'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(typeof MENU_ITEMS !== 'undefined' ? MENU_ITEMS : []).map(mi => (
                <GRP_Chip key={mi.id} text={mi.label} active={perm.has(mi.id)}
                  onClick={isSuper ? () => jogValt(mi.id, !perm.has(mi.id)) : null} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-slate-100 bg-slate-50">
        <button onClick={onClose} className={U_btnGhost}>Mégse</button>
        <button onClick={ment} disabled={busy} className={U_btnPrimary}>
          {busy ? 'Mentés…' : uj ? 'Csoport létrehozása' : 'Mentés'}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   GRP_Tab — a Regisztrációk negyedik füle
   --------------------------------------------------------------------------- */
function GRP_Tab({ rows, user }) {
  const [csoportok, setCsoportok] = useState(null);
  const [jogok, setJogok]         = useState([]);
  const [szerkeszt, setSzerkeszt] = useState(null);   // null | {} | csoport
  const [err, setErr]             = useState('');
  const isSuper = !!(user && user.role === 'SUPERADMIN');

  const betolt = React.useCallback(async () => {
    try {
      setErr('');
      const [g, p] = await Promise.all([GRP_api.list(), GRP_api.permissions()]);
      setCsoportok(g); setJogok(p);
    } catch (e) { setErr(GRP_msg(e)); setCsoportok([]); }
  }, []);
  useEffect(() => { betolt(); }, [betolt]);

  const torol = async (g) => {
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm('Biztosan törlöd a(z) „' + g.nev + '" csoportot? '
                        + 'A tagságok és a hozzá tartozó jogosultságok is megszűnnek.')) return;
    try { await GRP_api.remove(g.id); await betolt(); }
    catch (e) { setErr(GRP_msg(e)); }
  };

  /* Hány emberre illeszkedik egy szabály — ugyanaz a logika, mint a szerveren.
     Kézi csoportnál a szervertől kérnénk, de a listában elég a szabályos. */
  const talalat = (g) => {
    if (g.tipus !== 'szabaly' || !g.szabaly) return null;
    return (rows || []).filter(r =>
      Object.entries(g.szabaly).every(([m, v]) =>
        Array.isArray(v) ? v.includes(r[m]) : r[m] === v)).length;
  };

  const jogaiCsoportnak = (id) => jogok.filter(j => j.group_id === id).map(j => j.permission);

  if (szerkeszt) {
    return (
      <div className="mt-6 max-w-3xl">
        <GRP_Editor
          csoport={szerkeszt.id ? szerkeszt : null}
          rows={rows} jogok={szerkeszt.id ? jogaiCsoportnak(szerkeszt.id) : []}
          isSuper={isSuper}
          onClose={() => { setSzerkeszt(null); betolt(); }}
          onSaved={(g) => { betolt(); if (g && g.id && !szerkeszt.id) setSzerkeszt(g); }} />
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      <GRP_Err text={err} onClose={() => setErr('')} />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[12px] text-slate-400 max-w-2xl">
          A csoport <strong>megnyithat</strong> felületeket a tagjainak, elvenni viszont
          nem tud semmit. A besorolás szerinti csoport tagsága magától frissül.
        </p>
        <button onClick={() => setSzerkeszt({})} className={U_btnPrimary + ' !py-2 !px-4 text-sm'}>
          <Lucide.Plus size={15} /> Új csoport
        </button>
      </div>

      {csoportok === null && <div className="text-sm text-slate-400 py-6">Betöltés…</div>}

      {csoportok !== null && csoportok.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-slate-50 text-slate-300 flex items-center justify-center mx-auto mb-3">
            <Lucide.Users size={26} />
          </div>
          <p className="font-bold text-slate-700">Még nincs csoport</p>
          <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
            Hozz létre egyet: kézzel válogatva, vagy a besorolás szerint —
            például „minden nappali tagozatos mérnökinformatikus".
          </p>
        </div>
      )}

      <div className="grid gap-3">
        {(csoportok || []).map(g => {
          const n = talalat(g);
          const j = jogaiCsoportnak(g.id);
          return (
            <div key={g.id} className="bg-white border border-slate-100 rounded-2xl p-4 flex items-start gap-4">
              <div className={'w-10 h-10 rounded-xl flex-none flex items-center justify-center ' +
                (g.tipus === 'szabaly' ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-500')}>
                <Lucide.Users size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-black text-slate-800">{g.nev}</span>
                  <GRP_Chip text={g.tipus === 'szabaly' ? 'besorolás szerint' : 'kézi'}
                    tone={g.tipus === 'szabaly'
                      ? 'bg-indigo-50 text-indigo-700 border-indigo-100'
                      : 'bg-slate-50 text-slate-500 border-slate-200'} />
                  {n !== null && <span className="text-[11px] font-bold text-slate-400">{n} fő</span>}
                </div>
                {g.leiras && <p className="text-[13px] text-slate-500 mt-0.5">{g.leiras}</p>}
                {j.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {j.map(x => {
                      const mi = (typeof MENU_ITEMS !== 'undefined' ? MENU_ITEMS : []).find(m => m.id === x);
                      return <GRP_Chip key={x} text={mi ? mi.label : x}
                        tone="bg-emerald-50 text-emerald-700 border-emerald-100" />;
                    })}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-none">
                <button onClick={() => setSzerkeszt(g)} className={U_btnGhost + ' !py-2 !px-3 text-xs'}>
                  <Lucide.Pencil size={14} /> Szerkesztés
                </button>
                <button onClick={() => torol(g)}
                  className={U_btnGhost + ' !py-2 !px-2.5 text-xs !text-red-600 hover:!bg-red-50'}>
                  <Lucide.Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
