/* ============================================================
   HALLGATÓI NYILVÁNTARTÁS — ügyintézői képernyő (71_student_directory.sql)

   MIT VÁLASZOL MEG
     „Ki a hallgatónk, mi a besorolása, hol tart?” — kereshető névsor,
     szűrők, összesítő számok és egyéni adatlap egy helyen.

   HONNAN JÖN AZ ADAT
     Kizárólag a 71-es migráció négy függvényéből. Azok maguk ellenőrzik, hogy
     a hívó ügyintéző-e; a felület nem az egyetlen védvonal. Ha a migráció még
     nem futott le, a képernyő ezt KIMONDJA, nem üres listával fogad.

   MI NINCS ITT — SZÁNDÉKOSAN
     ECHO-kitöltöttség (a kérdőív névtelen), kollégiumi elhelyezés (ott van
     „védett lakó”, akinek a tartózkodási helye szűk körnek látszik) és
     pénzügyi adat. Ezeket a saját képernyőik kezelik.
   ============================================================ */

const STU_MEZOK = [
  ['tagozat',       'Tagozat'],
  ['kepzesi_szint', 'Képzési szint'],
  ['kar',           'Kar'],
  ['szak',          'Szak'],
  ['nyelv',         'Nyelv'],
  ['telephely',     'Telephely'],
  ['szerep',        'Szerepkör'],
  ['allapot',       'Fiókállapot'],
];
const STU_JELOLOK = [
  ['van_besorolas',   'Van Neptun-besorolása'],
  ['nincs_besorolas', 'Nincs besorolása'],
  ['van_kurzus',      'Van aktív kurzusa'],
  ['van_felveteli',   'Van felvételi folyamata'],
];
const STU_URES = { szerep: [], allapot: [], tagozat: [], kepzesi_szint: [], kar: [], szak: [], nyelv: [], telephely: [], csoport: [], jelolo: [] };
const STU_LAP = 50;

const STU_rpc = async (nev, args) => {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const { data, error } = await window.sb.rpc(nev, args || {});
  if (error) throw error;
  return data;
};
const STU_nincsMigracio = (e) => {
  const m = ((e && e.message) || '') + ((e && e.code) || '');
  return /student_directory|student_card|schema cache|PGRST202/i.test(m);
};
const STU_hiba = (e) => {
  const m = (e && e.message) || '';
  if (/DIR_FORBIDDEN/.test(m)) return 'Ehhez a képernyőhöz ügyintézői jogosultság kell.';
  if (/DIR_NOT_FOUND/.test(m)) return 'Ez a fiók nem található.';
  return m || 'Ismeretlen hiba.';
};
const STU_datum = (d) => { try { return d ? new Date(d).toLocaleDateString('hu-HU') : '—'; } catch (e) { return '—'; } };

const STU_ALLAPOT = {
  approved: ['Jóváhagyva', 'green'],
  pending:  ['Függőben', 'amber'],
  rejected: ['Elutasítva', 'red'],
};

function STU_Chipek({ cimke, opciok, valasztott, onValt }) {
  if (!opciok || opciok.length === 0) return null;
  return (
    <div>
      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1.5">
        {cimke}{valasztott.length > 0 && <span className="text-primary ml-1.5">{valasztott.length}</span>}
      </span>
      <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
        {opciok.map(o => {
          const ertek = String(o.ertek);
          const on = valasztott.indexOf(ertek) >= 0;
          return (
            <button key={ertek} type="button" data-stu-chip={ertek}
              onClick={() => onValt(on ? valasztott.filter(x => x !== ertek) : valasztott.concat([ertek]))}
              className={'px-2.5 py-1 rounded-xl border text-[11px] font-bold transition-all ' +
                (on ? 'border-primary bg-primary/10 text-primary' : 'border-slate-100 text-slate-500 hover:border-slate-300')}>
              {o.cimke || ertek}{o.db != null && <span className="ml-1 font-medium opacity-60">{o.db}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function STU_Szam({ cimke, ertek, sug }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 px-4 py-3" title={sug || ''}>
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{cimke}</p>
      <p className="text-2xl font-black text-slate-900 mt-0.5 tabular-nums">{ertek == null ? '—' : ertek}</p>
    </div>
  );
}

/* Egy hallgató adatlapja. A lista sorára kattintva nyílik. */
function STU_Adatlap({ open, profileId, onClose }) {
  const [adat, setAdat] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || !profileId) { setAdat(null); setErr(''); return; }
    let el = true;
    STU_rpc('student_card', { p_profile: profileId })
      .then(d => { if (el) { setAdat(d); setErr(''); } })
      .catch(e => { if (el) { setAdat(null); setErr(STU_hiba(e)); } });
    return () => { el = false; };
  }, [open, profileId]);

  const p = (adat && adat.profil) || {};
  const j = (adat && adat.jellemzok) || {};
  const sor = (cimke, ertek) => (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-[11px] font-bold text-slate-400">{cimke}</span>
      <span className="text-[13px] font-bold text-slate-800 text-right break-words">{ertek || '—'}</span>
    </div>
  );

  return (
    <UModal open={open} onClose={onClose} max="max-w-3xl" icon={<Lucide.User size={20} />}
      title={p.nev || 'Hallgatói adatlap'} subtitle={p.email || ''}>
      {err ? (
        <p className="text-sm font-bold text-red-600">{err}</p>
      ) : !adat ? (
        <SkeletonBar h={140} />
      ) : (
        <div className="space-y-5" data-stu-adatlap={profileId}>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-slate-100 p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Fiók</p>
              {sor('Szerepkör', p.szerep)}
              {sor('Állapot', (STU_ALLAPOT[p.allapot] || [p.allapot])[0])}
              {sor('Regisztrált', STU_datum(p.regisztralt))}
            </div>
            <div className="rounded-2xl border border-slate-100 p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Neptun-besorolás</p>
              {sor('Neptun-kód', j.neptun)}
              {sor('Tagozat', j.tagozat)}
              {sor('Képzési szint', j.kepzesi_szint)}
              {sor('Szak', j.szak)}
              {sor('Kar', j.kar)}
              {(j.nyelv || j.telephely) && sor('Nyelv · telephely', [j.nyelv, j.telephely].filter(Boolean).join(' · '))}
            </div>
          </div>

          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Csoportok</p>
            {(adat.csoportok || []).length === 0 ? (
              <p className="text-[12px] font-bold text-slate-300 italic">egyetlen csoportnak sem tagja</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {adat.csoportok.map(g => (
                  <span key={g.id} className="px-2.5 py-1 rounded-xl bg-slate-50 border border-slate-100 text-[11px] font-bold text-slate-600">
                    {g.nev}<span className="ml-1 opacity-50">{g.tipus === 'szabaly' ? 'szabály' : 'kézi'}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
              Kurzusok <span className="text-slate-300">{(adat.kurzusok || []).length}</span>
            </p>
            {(adat.kurzusok || []).length === 0 ? (
              <p className="text-[12px] font-bold text-slate-300 italic">nincs kurzusfelvétele</p>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {adat.kurzusok.map(k => (
                  <div key={k.id + k.felev} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2">
                    <span className="text-[12px] font-bold text-slate-700 truncate">{k.kod} · {k.nev}</span>
                    <span className="text-[11px] font-bold text-slate-400 flex-none">
                      {k.felev}{k.allapot !== 'active' ? ' · leadva' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
              Felvételi folyamatok <span className="text-slate-300">{(adat.felveteli || []).length}</span>
            </p>
            {(adat.felveteli || []).length === 0 ? (
              <p className="text-[12px] font-bold text-slate-300 italic">nincs felvételi folyamata</p>
            ) : (
              <div className="space-y-1.5">
                {adat.felveteli.map(f => (
                  <div key={f.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2">
                    <span className="text-[12px] font-bold text-slate-700 truncate">
                      {f.ref_no ? 'FV-' + String(f.ref_no).padStart(5, '0') + ' · ' : ''}{f.program_id || '—'}
                    </span>
                    <span className="text-[11px] font-bold text-slate-400 flex-none">
                      {f.kesz ? 'lezárt' : (f.szakasz === 'student' ? 'hallgatónál' : 'ügyintézőnél')} · {STU_datum(f.frissitve)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            A kurzusértékelés (ECHO) kitöltöttsége szándékosan nem szerepel itt: a kérdőív névtelen.
            A kollégiumi elhelyezést a Kollégium, a fizetéseket a Pénzügy képernyő mutatja.
          </p>
        </div>
      )}
    </UModal>
  );
}

function STU_View({ user }) {
  const [q, setQ] = useState('');
  const [keres, setKeres] = useState('');
  const [szuro, setSzuro] = useState(STU_URES);
  const [opciok, setOpciok] = useState(null);
  const [lista, setLista] = useState(null);
  const [stat, setStat] = useState(null);
  const [eltolas, setEltolas] = useState(0);
  const [nyitva, setNyitva] = useState(false);
  const [kivalasztott, setKivalasztott] = useState(null);
  const [err, setErr] = useState('');
  const [nincs, setNincs] = useState(false);
  const [busy, setBusy] = useState(false);

  // Gépelés közben ne induljon minden leütésre lekérdezés.
  useEffect(() => { const t = setTimeout(() => { setKeres(q); setEltolas(0); }, 350); return () => clearTimeout(t); }, [q]);

  useEffect(() => {
    let el = true;
    STU_rpc('student_directory_options')
      .then(d => { if (el) setOpciok(d || {}); })
      .catch(e => { if (el) { setOpciok({}); if (STU_nincsMigracio(e)) setNincs(true); } });
    return () => { el = false; };
  }, []);

  const szuroKulcs = JSON.stringify(szuro);
  useEffect(() => {
    let el = true; setBusy(true);
    const p = { p_q: keres || null, p_szuro: szuro };
    Promise.all([
      STU_rpc('student_directory', { ...p, p_limit: STU_LAP, p_offset: eltolas }),
      STU_rpc('student_directory_stats', p),
    ])
      .then(([l, s]) => { if (el) { setLista(l); setStat(s); setErr(''); setBusy(false); } })
      .catch(e => {
        if (!el) return;
        setBusy(false); setLista(null); setStat(null);
        if (STU_nincsMigracio(e)) setNincs(true); else setErr(STU_hiba(e));
      });
    return () => { el = false; };
  }, [keres, szuroKulcs, eltolas]);

  const valt = (mezo) => (v) => { setSzuro(prev => ({ ...prev, [mezo]: v })); setEltolas(0); };
  const szurDb = Object.keys(STU_URES).reduce((n, k) => n + (szuro[k] || []).length, 0);
  const sorok = (lista && lista.sorok) || [];
  const bontas = (stat && stat.bontas) || {};

  /* A szűrt névsor letöltése. Személyes adat: azt viszi, ami a képernyőn
     amúgy is látszik, és csak azt a lapot, amit a szerver kiadott. */
  const letolt = () => {
    const fej = ['Név', 'E-mail', 'Szerepkör', 'Állapot', 'Neptun', 'Tagozat', 'Képzési szint', 'Szak', 'Kar', 'Csoportok', 'Kurzus', 'Felvételi'];
    const ido = (t) => '"' + String(t == null ? '' : t).replace(/"/g, '""') + '"';
    const sor = (r) => [r.nev, r.email, r.szerep, r.allapot, r.neptun, r.tagozat, r.kepzesi_szint, r.szak, r.kar,
                        (r.csoportok || []).join(' | '), r.kurzus_db, r.felveteli_db].map(ido).join(';');
    const csv = '﻿' + [fej.map(ido).join(';')].concat(sorok.map(sor)).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'hallgatok_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  if (nincs) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <UEmpty icon={<Lucide.Users size={26} />} title="A hallgatói nyilvántartás még nincs telepítve"
          subtitle="Futtatni kell a supabase/71_student_directory.sql migrációt, utána ez a képernyő azonnal működik." />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto animate-in fade-in duration-300" data-stu-nezet="1">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">Képzés és oktatás</p>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Hallgatók</h1>
          <p className="text-slate-400 mt-1 font-medium text-sm">
            Névsor, besorolás, csoportok, kurzusok és felvételi folyamatok — kereséssel és szűrőkkel.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setNyitva(v => !v)} className={U_btnGhost}>
            <Lucide.SlidersHorizontal size={16} /> Szűrők{szurDb > 0 ? ' (' + szurDb + ')' : ''}
          </button>
          <button onClick={letolt} disabled={sorok.length === 0} className={U_btnGhost}>
            <Lucide.Download size={16} /> CSV
          </button>
        </div>
      </div>

      <div className="relative mb-4">
        <Lucide.Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
        <input className={U_input + ' pl-11'} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Keresés név, e-mail vagy Neptun-kód szerint…" data-stu-kereso="1" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4" data-stu-szamok="1">
        <STU_Szam cimke="Találat" ertek={stat && stat.ossz} sug="A szűrésnek megfelelő fiókok száma." />
        <STU_Szam cimke="Besorolással" ertek={stat && stat.besorolassal} sug="Akinek van Neptun-besorolása (tagozat, szint, szak, kar)." />
        <STU_Szam cimke="Kurzussal" ertek={stat && stat.kurzussal} sug="Akinek van aktív kurzusfelvétele." />
        <STU_Szam cimke="Felvételivel" ertek={stat && stat.felvetelivel} sug="Akinek van felvételi folyamata." />
        <STU_Szam cimke="Új (30 nap)" ertek={stat && stat.uj_30_nap} sug="Az elmúlt 30 napban regisztrált fiókok." />
      </div>

      {nyitva && (
        <div className="bg-white rounded-3xl border border-slate-100 p-5 mb-4 space-y-4" data-stu-szurok="1">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {STU_MEZOK.map(([k, cimke]) => (
              <STU_Chipek key={k} cimke={cimke} opciok={(opciok && opciok[k]) || []}
                valasztott={szuro[k] || []} onValt={valt(k)} />
            ))}
            <STU_Chipek cimke="Csoport" opciok={(opciok && opciok.csoport) || []}
              valasztott={szuro.csoport} onValt={valt('csoport')} />
            <STU_Chipek cimke="Jelölők" opciok={STU_JELOLOK.map(([k, v]) => ({ ertek: k, cimke: v }))}
              valasztott={szuro.jelolo} onValt={valt('jelolo')} />
          </div>
          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[11px] text-slate-400">
              A különböző szempontok együtt szűkítenek, egy szemponton belül bármelyik érték elég.
            </p>
            <button onClick={() => { setSzuro(STU_URES); setEltolas(0); }} className="text-[11px] font-black text-primary hover:underline">
              Szűrők törlése
            </button>
          </div>
        </div>
      )}

      {/* Bontás: a leggyakoribb értékek kattintással szűrővé válnak. */}
      {stat && (
        <div className="flex flex-wrap gap-4 mb-4" data-stu-bontas="1">
          {['tagozat', 'kepzesi_szint', 'kar'].map(k => (
            (bontas[k] || []).length === 0 ? null : (
              <div key={k} className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-1">
                  {(STU_MEZOK.find(m => m[0] === k) || [k, k])[1]}
                </span>
                {(bontas[k] || []).slice(0, 5).map(b => (
                  <button key={b.ertek} onClick={() => {
                      if (String(b.ertek).startsWith('—')) return;
                      const most = szuro[k] || [];
                      valt(k)(most.indexOf(b.ertek) >= 0 ? most.filter(x => x !== b.ertek) : most.concat([b.ertek]));
                    }}
                    className={'px-2.5 py-1 rounded-xl border text-[11px] font-bold transition-all ' +
                      ((szuro[k] || []).indexOf(b.ertek) >= 0
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-slate-100 bg-white text-slate-500 hover:border-slate-300')}>
                    {b.ertek} <span className="opacity-60">{b.db}</span>
                  </button>
                ))}
              </div>
            )
          ))}
        </div>
      )}

      {err && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 mb-4">{err}</div>
      )}

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-50">
          <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest">
            {lista ? (eltolas + 1) + '–' + (eltolas + sorok.length) + ' / ' + lista.ossz : 'Betöltés…'}
          </p>
          <RefreshingBadge on={busy} />
        </div>

        {lista === null ? (
          <div className="p-6 space-y-2">{[0, 1, 2, 3].map(i => <SkeletonBar key={i} h={36} />)}</div>
        ) : sorok.length === 0 ? (
          <UEmpty icon={<Lucide.SearchX size={26} />} title="Nincs találat"
            subtitle="Próbáld meg más kereséssel, vagy törölj a szűrőkből." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  <th className="px-5 py-2">Név</th>
                  <th className="px-3 py-2">Besorolás</th>
                  <th className="px-3 py-2">Szak · kar</th>
                  <th className="px-3 py-2">Csoportok</th>
                  <th className="px-3 py-2 text-right">Kurzus</th>
                  <th className="px-3 py-2 text-right">Felvételi</th>
                </tr>
              </thead>
              <tbody>
                {sorok.map(r => {
                  const all = STU_ALLAPOT[r.allapot] || [r.allapot, 'slate'];
                  return (
                    <tr key={r.id} data-stu-sor={r.id} onClick={() => setKivalasztott(r.id)}
                      className="border-t border-slate-50 hover:bg-slate-50/70 cursor-pointer transition-colors">
                      <td className="px-5 py-3">
                        <p className="text-[13px] font-black text-slate-800 truncate max-w-[22ch]">{r.nev}</p>
                        <p className="text-[11px] font-bold text-slate-400 truncate max-w-[26ch]">{r.email}</p>
                        <span className="inline-flex items-center gap-1.5 mt-1">
                          <UBadge tone={all[1]}>{all[0]}</UBadge>
                          <span className="text-[10px] font-black text-slate-300">{r.szerep}</span>
                        </span>
                      </td>
                      <td className="px-3 py-3 text-[12px] font-bold text-slate-600">
                        {r.neptun && <span className="block font-mono text-[11px] text-slate-400">{r.neptun}</span>}
                        {[r.tagozat, r.kepzesi_szint].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-3 text-[12px] font-bold text-slate-600 max-w-[24ch] truncate">
                        {[r.szak, r.kar].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-3">
                        {(r.csoportok || []).length === 0 ? <span className="text-slate-300 text-[12px]">—</span> : (
                          <span className="text-[11px] font-bold text-slate-500">
                            {(r.csoportok || []).slice(0, 2).join(', ')}
                            {(r.csoportok || []).length > 2 ? ' +' + ((r.csoportok || []).length - 2) : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] font-black text-slate-700 tabular-nums">{r.kurzus_db}</td>
                      <td className="px-3 py-3 text-right text-[13px] font-black text-slate-700 tabular-nums">{r.felveteli_db}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {lista && lista.ossz > STU_LAP && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-50">
            <button disabled={eltolas === 0} onClick={() => setEltolas(Math.max(0, eltolas - STU_LAP))}
              className={U_btnGhost + ' py-2 px-3 text-[12px]'}>
              <Lucide.ChevronLeft size={14} /> Előző
            </button>
            <button disabled={eltolas + sorok.length >= lista.ossz} onClick={() => setEltolas(eltolas + STU_LAP)}
              className={U_btnGhost + ' py-2 px-3 text-[12px]'}>
              Következő <Lucide.ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed mt-4 max-w-3xl">
        A lista személyes adatot mutat, ezért csak ügyintézői szerepkörrel nyílik meg — ezt az adatbázis
        kényszeríti ki, nem a menü. A kurzusértékelés kitöltöttsége itt szándékosan nem jelenik meg:
        a kérdőív névtelen.
      </p>

      <STU_Adatlap open={!!kivalasztott} profileId={kivalasztott} onClose={() => setKivalasztott(null)} />
    </div>
  );
}
