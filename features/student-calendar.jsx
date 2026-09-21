/* ============================================================
   UniPortal — Hallgatói naptár (a hallgatói portál „Naptár” füle)
   ------------------------------------------------------------
   Egy helyen minden, aminek dátuma van a jelentkező számára:
     • interjú (lefoglalt / javasolt) — a felvételi eljárás data.interview-jából,
       amit a szerver az interjú-időponttal szinkronban tart (61);
     • jelentkezési határidő — a be nem adott saját jelentkezés képzéseinek
       határideje;
     • események a Hírfolyamból — külön jelölve, amire jelentkezett (event_rsvps,
       ticket_claims) és amire nem; a hírfolyam „Határidő” bejegyzései;
     • a kínálat határidői — nyitott képzések, amelyekre még nem jelentkezett
       (alapból rejtve).
   BŐVÍTÉS: új forrás = új tételtípus a NAP_TIPUS-ban + egy blokk a
   NAP_tetelek-ben (id, tipus, kezd, [veg], [egesznap], cim, alcim, reszlet).
   ============================================================ */

const NAP_TIPUS = {
  interju:          { cimke: 'Interjú',                    szuro: 'interju',     pont: 'bg-primary',     kartya: 'border-l-primary',     pill: 'bg-primary text-white',                                  ikon: Lucide.Video },
  interju_javasolt: { cimke: 'Javasolt interjú',           szuro: 'interju',     pont: 'bg-amber-400',   kartya: 'border-l-amber-400',   pill: 'bg-amber-100 text-amber-800',                           ikon: Lucide.CalendarClock },
  hatarido:         { cimke: 'Jelentkezési határidő',      szuro: 'hatarido',    pont: 'bg-red-500',     kartya: 'border-l-red-500',     pill: 'bg-red-50 text-red-700',                                ikon: Lucide.AlarmClock },
  hir_hatarido:     { cimke: 'Határidő',                   szuro: 'hatarido',    pont: 'bg-red-300',     kartya: 'border-l-red-300',     pill: 'bg-red-50 text-red-600',                                ikon: Lucide.AlarmClock },
  esemeny_jel:      { cimke: 'Esemény — jelentkeztél',     szuro: 'esemeny_jel', pont: 'bg-emerald-500', kartya: 'border-l-emerald-500', pill: 'bg-emerald-50 text-emerald-700',                        ikon: Lucide.CalendarCheck },
  esemeny:          { cimke: 'Esemény — nem jelentkeztél', szuro: 'esemeny',     pont: 'bg-sky-400',     kartya: 'border-l-sky-400',     pill: 'bg-sky-50 text-sky-700',                                ikon: Lucide.CalendarDays },
  kinalat:          { cimke: 'Kínálat határideje',         szuro: 'kinalat',     pont: 'bg-slate-400',   kartya: 'border-l-slate-300',   pill: 'bg-slate-100 text-slate-600',                           ikon: Lucide.GraduationCap },
};
const NAP_SZUROK = [
  ['interju', 'Interjúk', 'interju'],
  ['hatarido', 'Határidők', 'hatarido'],
  ['esemeny_jel', 'Események — jelentkeztél', 'esemeny_jel'],
  ['esemeny', 'Események — nem jelentkeztél', 'esemeny'],
  ['kinalat', 'Kínálat határidői', 'kinalat'],
];
const NAP_ALAP_SZURO = { interju: true, hatarido: true, esemeny_jel: true, esemeny: true, kinalat: false };

const NAP_loc = () => { try { return localStorage.getItem('nje_lang') === 'en' ? 'en-GB' : 'hu-HU'; } catch (e) { return 'hu-HU'; } };
// 'YYYY-MM-DD' HELYI napként (nem UTC éjfélként); minden más a Date értelmezésével.
function NAP_datum(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const NAP_ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const NAP_napEleje = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const NAP_ora = (d) => d.toLocaleTimeString(NAP_loc(), { hour: '2-digit', minute: '2-digit' });
const NAP_vanIdo = (s) => /\d{2}:\d{2}/.test(String(s || ''));

function NAP_tetelek(adat, email) {
  const { programs, apps, posts, rsvps, tix } = adat;
  const prog = (id) => programs.find(p => p.id === id);
  const t = [];

  apps.forEach(a => {
    const ids = PROG_appIds(a);
    const kepz = ids.map(prog).filter(Boolean);
    const nevek = kepz.map(k => k.name).join(' · ') || 'Felvételi eljárás';
    const azon = a.ref_no ? 'FV-' + String(a.ref_no).padStart(5, '0') : '';
    const iv = (a.data && a.data.interview) || {};
    const kezd = NAP_datum(iv.start);
    const elo = iv.status ? (iv.status === 'Booked' || iv.status === 'Proposed') : !!(iv.booked || iv.proposed);
    if (kezd && elo) {
      const javasolt = iv.status === 'Proposed' || (!iv.status && !!iv.proposed);
      t.push({
        id: 'iv-' + a.id, tipus: javasolt ? 'interju_javasolt' : 'interju', kezd, veg: NAP_datum(iv.end),
        cim: javasolt ? 'Javasolt interjú-időpont' : 'Felvételi interjú',
        alcim: [nevek, azon].filter(Boolean).join(' · '),
        reszlet: javasolt ? 'Fogadd el vagy válassz másikat a felvételi folyamatban.' : (iv.interviewerName ? 'Interjúztató: ' + iv.interviewerName : ''),
        link: javasolt ? '' : (iv.teamsUrl || ''), appId: a.id,
      });
    }
    if (a.status === 'draft') {
      kepz.forEach(k => {
        const d = NAP_datum(k.deadline);
        if (d) t.push({ id: 'dl-' + a.id + '-' + k.id, tipus: 'hatarido', kezd: d, egesznap: !NAP_vanIdo(k.deadline), cim: 'Jelentkezési határidő', alcim: [k.name, azon].filter(Boolean).join(' · '), reszlet: 'A jelentkezésed még nincs beadva.', appId: a.id });
      });
    }
  });

  const sajat = new Set(apps.flatMap(a => PROG_appIds(a)));
  programs.forEach(p => {
    if (PROG_kind(p) !== 'degree' || !p.is_open || sajat.has(p.id)) return;
    const d = NAP_datum(p.deadline);
    if (d) t.push({ id: 'kin-' + p.id, tipus: 'kinalat', kezd: d, egesznap: !NAP_vanIdo(p.deadline), cim: 'Jelentkezési határidő', alcim: p.name, reszlet: 'Erre a képzésre még nem jelentkeztél.' });
  });

  posts.forEach(p => {
    const d = NAP_datum(p.event_date);
    if (!d) return;
    const egesznap = !NAP_vanIdo(p.event_date);
    if (p.type === 'event') {
      const jel = rsvps.some(r => r.post_id === p.id && String(r.email || '').toLowerCase() === email);
      t.push({ id: 'ev-' + p.id, tipus: jel ? 'esemeny_jel' : 'esemeny', kezd: d, egesznap, cim: p.title, alcim: p.event_location || '', reszlet: jel ? 'Jelentkeztél erre az eseményre.' : 'Még nem jelentkeztél.', post: p, jelentkezett: jel, rsvpHato: true });
    } else if (p.type === 'ticket') {
      const van = tix.some(x => x.post_id === p.id && String(x.email || '').toLowerCase() === email);
      t.push({ id: 'tx-' + p.id, tipus: van ? 'esemeny_jel' : 'esemeny', kezd: d, egesznap, cim: p.title, alcim: p.event_location || '', reszlet: van ? 'Van belépőd.' : 'Még nem igényeltél belépőt — a Hírfolyamban igényelheted.', post: p });
    } else if (p.type === 'deadline') {
      t.push({ id: 'hd-' + p.id, tipus: 'hir_hatarido', kezd: d, egesznap, cim: p.title, alcim: '', reszlet: '' });
    }
  });

  return t.sort((x, y) => x.kezd - y.kezd);
}

function NAP_TetelKartya({ t, onOpenApplications, onRsvp, busy, datummal }) {
  const m = NAP_TIPUS[t.tipus];
  const I = m.ikon;
  const loc = NAP_loc();
  const hatarE = t.tipus === 'hatarido' || t.tipus === 'kinalat' || t.tipus === 'hir_hatarido';
  const hatra = hatarE ? Math.round((NAP_napEleje(t.kezd) - NAP_napEleje(new Date())) / 86400000) : null;
  const ido = t.egesznap ? '' : NAP_ora(t.kezd) + (t.veg ? '–' + NAP_ora(t.veg) : '');
  return (
    <div data-nap-tetel={t.id} data-nap-tipus={t.tipus} className={'bg-white rounded-2xl border border-slate-100 border-l-4 p-4 flex flex-col sm:flex-row sm:items-start gap-3 ' + m.kartya}>
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span className="w-9 h-9 rounded-xl bg-slate-50 text-slate-500 flex items-center justify-center flex-none"><I size={17} /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {datummal && <span className="text-[12px] font-black text-slate-500">{t.kezd.toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' })}</span>}
            {ido ? <span className="text-[12px] font-black text-slate-500 tabular-nums">{ido}</span> : <span className="text-[12px] font-black text-slate-500">Egész nap</span>}
            <span className={'text-[10px] font-bold px-2 py-0.5 rounded-full ' + m.pill}>{m.cimke}</span>
            {hatra != null && hatra >= 0 && <span className={'text-[10px] font-bold ' + (hatra <= 7 ? 'text-red-600' : 'text-slate-400')}>{hatra === 0 ? 'ma' : `még ${hatra} nap`}</span>}
          </div>
          <div className="text-sm font-black text-slate-800 mt-0.5">{t.cim}</div>
          {t.alcim && <div className="text-[12px] text-slate-500">{t.alcim}</div>}
          {t.reszlet && <div className="text-[12px] text-slate-400 mt-0.5">{t.reszlet}</div>}
        </div>
      </div>
      {(t.link || (t.appId && onOpenApplications) || t.rsvpHato) && (
        <div className="flex flex-wrap gap-2 sm:flex-none">
          {t.link && <a href={t.link} target="_blank" rel="noopener noreferrer" className={U_btnGhost + ' !py-1.5 !px-3 text-[12px]'}><Lucide.Link size={13} /> Teams-link megnyitása</a>}
          {t.appId && onOpenApplications && <button type="button" onClick={onOpenApplications} className={U_btnGhost + ' !py-1.5 !px-3 text-[12px]'}>Felvételi folyamat megnyitása</button>}
          {t.rsvpHato && (
            <button type="button" disabled={busy} onClick={() => onRsvp(t)} data-nap-rsvp={t.post.id}
              className={(t.jelentkezett ? U_btnGhost : U_btnPrimary) + ' !py-1.5 !px-3 text-[12px]'}>
              {busy ? <Lucide.Loader2 size={13} className="animate-spin" /> : null}{t.jelentkezett ? 'Lemondom' : 'Jelentkezem'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NAP_Naptar({ user, onOpenApplications }) {
  const email = String((user && user.email) || '').toLowerCase();
  const [adat, setAdat] = useState(null);
  const [nezet, setNezet] = useState(() => { try { return localStorage.getItem('nap_nezet') || 'honap'; } catch (e) { return 'honap'; } });
  const [honap, setHonap] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [nap, setNap] = useState(() => NAP_ymd(new Date()));
  const [szuro, setSzuro] = useState(() => { try { return { ...NAP_ALAP_SZURO, ...JSON.parse(localStorage.getItem('nap_szuro') || '{}') }; } catch (e) { return { ...NAP_ALAP_SZURO }; } });
  const [korabbiak, setKorabbiak] = useState(false);
  const [busy, setBusy] = useState('');
  // Jogosultsági megtagadás a jelentkezésnél (72/73-as réteg).
  const [hiba, setHiba] = useState('');

  const betolt = React.useCallback(async () => {
    const biztos = (p) => Promise.resolve(p).catch(e => { setHiba(e.message || 'A betöltés nem sikerült.'); return []; });
    const [programs, apps, posts, rsvps, tix] = await Promise.all([
      biztos(PROG_loadPrograms()), biztos(PROG_loadApps()), biztos(FEED_loadPosts()), biztos(FEED_loadRsvps()), biztos(FEED_loadTix()),
    ]);
    setAdat({
      programs: programs || [],
      apps: (apps || []).filter(a => email && String(a.applicant_email || '').toLowerCase() === email && !(a.data && a.data._cancelled)),
      posts: posts || [], rsvps: rsvps || [], tix: tix || [],
    });
  }, [email]);

  useEffect(() => { betolt(); const t = POLL_idozit(betolt, 60000); return () => clearInterval(t); }, [betolt]);
  useEffect(() => { try { localStorage.setItem('nap_szuro', JSON.stringify(szuro)); localStorage.setItem('nap_nezet', nezet); } catch (e) {} }, [szuro, nezet]);

  if (!adat) return <div className="h-72 rounded-3xl bg-white border border-slate-100 animate-pulse" data-nap-naptar="tolt" />;

  const loc = NAP_loc();
  const osszes = NAP_tetelek(adat, email);
  const lathato = osszes.filter(t => szuro[NAP_TIPUS[t.tipus].szuro]);
  const szamok = {};
  osszes.forEach(t => { const k = NAP_TIPUS[t.tipus].szuro; szamok[k] = (szamok[k] || 0) + 1; });
  const most = new Date();
  const maEleje = NAP_napEleje(most);
  const kovetkezo = osszes.filter(t => (t.tipus === 'interju' || t.tipus === 'interju_javasolt') && (t.veg || t.kezd) >= most)[0] || null;

  const rsvp = async (t) => {
    if (!t.post || busy) return;
    setBusy(t.id);
    try {
      if (t.jelentkezett) {
        const sajat = adat.rsvps.find(r => r.post_id === t.post.id && String(r.email || '').toLowerCase() === email);
        if (sajat) await dlDelete(RSVP_TABLE, sajat.id, RSVP_LS);
      } else {
        await dlInsert(RSVP_TABLE, { id: uid('RS'), post_id: t.post.id, email: user.email, name: user.name, created_at: new Date().toISOString() }, RSVP_LS);
      }
      setHiba('');
      await betolt();
    } catch (e) {
      // A dlInsert/dlDelete megtagadáskor dob (data-layer.jsx). Enélkül a
      // jelentkezés a felületen sikeresnek látszana.
      setHiba((e && e.message) || 'A jelentkezés nem sikerült.');
    } finally { setBusy(''); }
  };

  // Hónap rács: hétfővel kezdődő hetek, a hónap összes napjával.
  const eltolas = (honap.getDay() + 6) % 7;
  const racsKezd = new Date(honap.getFullYear(), honap.getMonth(), 1 - eltolas);
  const cellak = Array.from({ length: 42 }, (_, i) => new Date(racsKezd.getFullYear(), racsKezd.getMonth(), racsKezd.getDate() + i));
  const sorok = cellak[35].getMonth() !== honap.getMonth() ? (cellak[28].getMonth() !== honap.getMonth() ? 4 : 5) : 6;
  const napTetelei = (d) => { const k = NAP_ymd(d); return lathato.filter(t => NAP_ymd(t.kezd) === k); };
  const valasztottNap = NAP_datum(nap);
  const kartyaProps = { onOpenApplications, onRsvp: rsvp };

  return (
    <div className="space-y-5" data-nap-naptar="1">
      {hiba && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
          <Lucide.AlertCircle size={16} className="mt-0.5 flex-none" />
          <span className="flex-1">{hiba}</span>
          <button onClick={() => setHiba('')} className="text-red-400 hover:text-red-700"><Lucide.X size={14} /></button>
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h3 className="text-2xl font-black text-slate-900 tracking-tight">Naptáram</h3>
          <p className="text-sm text-slate-500 mt-0.5">Interjúk, határidők és események egy helyen.</p>
        </div>
        <div className="inline-flex p-1 rounded-xl bg-white border border-slate-100 shadow-sm w-fit" role="group" aria-label="Nézet">
          {[['honap', 'Hónap'], ['lista', 'Lista']].map(([k, c]) => (
            <button key={k} type="button" aria-pressed={nezet === k} data-nap-nezet={k} onClick={() => setNezet(k)}
              className={'px-4 py-2 rounded-lg text-sm font-bold transition-colors ' + (nezet === k ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800')}>{c}</button>
          ))}
        </div>
      </div>

      {kovetkezo && (
        <div className="rounded-3xl bg-slate-900 text-white p-5 flex flex-col md:flex-row md:items-center gap-4" data-nap-kovetkezo="1">
          <span className="w-12 h-12 rounded-2xl bg-white/10 flex items-center justify-center flex-none"><Lucide.Video size={22} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-black uppercase tracking-widest text-white/60">{kovetkezo.tipus === 'interju_javasolt' ? 'Javasolt interjú-időpont' : 'Következő interjúd'}</div>
            <div className="text-lg font-black">{kovetkezo.kezd.toLocaleDateString(loc, { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + NAP_ora(kovetkezo.kezd) + (kovetkezo.veg ? '–' + NAP_ora(kovetkezo.veg) : '')}</div>
            <div className="text-sm text-white/70 truncate">{kovetkezo.alcim}</div>
          </div>
          <div className="flex flex-wrap gap-2 flex-none">
            {kovetkezo.link && <a href={kovetkezo.link} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-xl bg-white text-slate-900 text-sm font-bold inline-flex items-center gap-2"><Lucide.Link size={15} /> Teams-link megnyitása</a>}
            {onOpenApplications && <button type="button" onClick={onOpenApplications} className="px-4 py-2 rounded-xl bg-white/10 text-white text-sm font-bold hover:bg-white/20">Felvételi folyamat megnyitása</button>}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Szűrők">
        {NAP_SZUROK.map(([k, c, minta]) => {
          const on = !!szuro[k];
          return (
            <button key={k} type="button" aria-pressed={on} data-nap-szuro={k} data-nap-szam={szamok[k] || 0} onClick={() => setSzuro(s => ({ ...s, [k]: !s[k] }))}
              className={'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] font-bold border transition-colors ' + (on ? 'bg-white border-slate-200 text-slate-700 shadow-sm' : 'border-dashed border-slate-200 text-slate-400 hover:text-slate-600')}>
              <span className={'w-2.5 h-2.5 rounded-full ' + (on ? NAP_TIPUS[minta].pont : 'bg-slate-200')} />
              <span>{c}</span>
              <span className="text-slate-400 tabular-nums">{szamok[k] || 0}</span>
            </button>
          );
        })}
      </div>

      {nezet === 'honap' ? (
        <div className="grid xl:grid-cols-[minmax(0,1fr),360px] gap-5 items-start">
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden" data-nap-honap={NAP_ymd(honap).slice(0, 7)}>
            <div className="flex items-center justify-between gap-2 p-4 border-b border-slate-100">
              <div className="flex items-center gap-1">
                <button type="button" aria-label="Előző hónap" title="Előző hónap" onClick={() => setHonap(h => new Date(h.getFullYear(), h.getMonth() - 1, 1))} className={U_btnGhost + ' !px-3 !py-2'}><Lucide.ChevronLeft size={16} /></button>
                <button type="button" onClick={() => { const d = new Date(); setHonap(new Date(d.getFullYear(), d.getMonth(), 1)); setNap(NAP_ymd(d)); }} className={U_btnGhost + ' !px-4 !py-2 text-sm'}>Ma</button>
                <button type="button" aria-label="Következő hónap" title="Következő hónap" data-nap-kov-honap="1" onClick={() => setHonap(h => new Date(h.getFullYear(), h.getMonth() + 1, 1))} className={U_btnGhost + ' !px-3 !py-2'}><Lucide.ChevronRight size={16} /></button>
              </div>
              <div className="text-lg font-black text-slate-900 capitalize">{honap.toLocaleDateString(loc, { year: 'numeric', month: 'long' })}</div>
            </div>
            <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50/60">
              {cellak.slice(0, 7).map((d, i) => <div key={i} className="px-1 py-2 text-center text-[10px] font-black uppercase tracking-wider text-slate-400">{d.toLocaleDateString(loc, { weekday: 'short' })}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {cellak.slice(0, sorok * 7).map(d => {
                const k = NAP_ymd(d);
                const tet = napTetelei(d);
                const masHonap = d.getMonth() !== honap.getMonth();
                const ma = k === NAP_ymd(most);
                const valasztott = k === nap;
                return (
                  <button key={k} type="button" data-nap-nap={k} data-nap-db={tet.length} aria-pressed={valasztott} onClick={() => setNap(k)}
                    aria-label={d.toLocaleDateString(loc, { month: 'long', day: 'numeric' }) + (tet.length ? ' · ' + tet.map(t => t.cim).join(', ') : '')}
                    className={'min-h-[72px] sm:min-h-[104px] p-1.5 sm:p-2 text-left border-r border-b border-slate-100 flex flex-col gap-1 min-w-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary '
                      + (valasztott ? 'bg-primary/5' : masHonap ? 'bg-slate-50/60 hover:bg-slate-50' : 'hover:bg-slate-50')}>
                    <span className={'w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-black tabular-nums ' + (ma ? 'bg-primary text-white' : valasztott ? 'ring-2 ring-primary text-primary' : masHonap ? 'text-slate-300' : 'text-slate-700')}>{d.getDate()}</span>
                    <span className="hidden sm:flex flex-col gap-0.5 min-w-0 w-full">
                      {tet.slice(0, 3).map(t => (
                        <span key={t.id} className={'truncate rounded-md px-1.5 py-0.5 text-[10px] font-bold ' + NAP_TIPUS[t.tipus].pill}>
                          {!t.egesznap && <span className="tabular-nums">{NAP_ora(t.kezd) + ' '}</span>}<span>{t.cim}</span>
                        </span>
                      ))}
                      {tet.length > 3 && <span className="text-[10px] font-bold text-slate-400 px-1">{`+${tet.length - 3} további`}</span>}
                    </span>
                    <span className="flex sm:hidden flex-wrap gap-0.5">{tet.slice(0, 4).map(t => <span key={t.id} className={'w-1.5 h-1.5 rounded-full ' + NAP_TIPUS[t.tipus].pont} />)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-3" data-nap-kivalasztott={nap}>
            <div className="text-[11px] font-black uppercase tracking-widest text-slate-400">{valasztottNap.toLocaleDateString(loc, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            {napTetelei(valasztottNap).length === 0
              ? <div className="bg-white rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">Ezen a napon nincs tétel.</div>
              : napTetelei(valasztottNap).map(t => <NAP_TetelKartya key={t.id} t={t} busy={busy === t.id} {...kartyaProps} />)}
          </div>
        </div>
      ) : (
        <div className="space-y-5" data-nap-lista="1">
          {(() => {
            const jovo = lathato.filter(t => (t.veg || t.kezd) >= maEleje);
            const mult = lathato.filter(t => (t.veg || t.kezd) < maEleje).reverse();
            const csoport = (lista) => {
              const m = new Map();
              lista.forEach(t => { const k = NAP_ymd(t.kezd); if (!m.has(k)) m.set(k, []); m.get(k).push(t); });
              return [...m.entries()];
            };
            return (
              <>
                {jovo.length === 0 && <div className="bg-white rounded-3xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">Nincs megjeleníthető tétel ebben a nézetben.</div>}
                {csoport(jovo).map(([k, lista]) => (
                  <div key={k} className="space-y-2" data-nap-lista-nap={k}>
                    <div className="text-[11px] font-black uppercase tracking-widest text-slate-400">{NAP_datum(k).toLocaleDateString(loc, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
                    {lista.map(t => <NAP_TetelKartya key={t.id} t={t} busy={busy === t.id} {...kartyaProps} />)}
                  </div>
                ))}
                {mult.length > 0 && (
                  <div className="pt-2">
                    <button type="button" onClick={() => setKorabbiak(v => !v)} aria-expanded={korabbiak} className="text-sm font-bold text-slate-500 hover:text-slate-800 inline-flex items-center gap-1.5">
                      {korabbiak ? <Lucide.ChevronUp size={15} /> : <Lucide.ChevronDown size={15} />}<span>Korábbi tételek</span><span className="text-slate-400 tabular-nums">{mult.length}</span>
                    </button>
                    {korabbiak && <div className="space-y-2 mt-3 opacity-80">{mult.map(t => <NAP_TetelKartya key={t.id} t={t} datummal busy={busy === t.id} {...kartyaProps} />)}</div>}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
