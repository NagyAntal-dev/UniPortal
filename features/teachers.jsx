/* ============================================================
   Oktatói nyilvántartás — felület a supabase/54_teacher_registry.sql fölé.

   MIT CSINÁL
     Oktatók felvitele, adataik javítása, kurzus-hozzárendelés, fiók-kötés,
     inaktiválás. A kurzusnyilvántartás (features/courses.jsx) mintáját követi,
     hogy a két törzsadat-képernyő ugyanúgy viselkedjen.

   A KÉT DOLOG, AMIT A FELÜLET KIMOND
     1. Az INAKTIVÁLÁS nyilvántartási állapot. Az echo.eligibility_rebuild() a
        course_teacher-ből dolgozik és NEM nézi a teacher.active jelzőt (MÉRVE),
        tehát amíg az oktatónak kurzus-hozzárendelése van, egy új kampány
        továbbra is behúzza. Az RPC visszaadja a megmaradt hozzárendelések
        számát, mi pedig kiírjuk — nem csendben történik.
     2. A TÖRLÉS majdnem mindig rossz válasz: az echo.teacher idegen kulcsai
        kaszkádolnak, tehát a törlés kampánytörténetet vinne. A szerver ezt
        elutasítja; itt a gomb is csak akkor aktív, ha tényleg nincs nyom.
   ============================================================ */

function TCH_msg(e) {
  const raw = (e && (e.message || e.hint || e.details)) || String(e || '');
  const kod = (raw.match(/^([A-Z_]{4,})/) || [])[1];
  const TERKEP = {
    ECHO_NOT_AUTHENTICATED: 'Lejárt a munkameneted — lépj be újra.',
    ECHO_FORBIDDEN:         'Ehhez nincs jogosultságod.',
    ECHO_TEACHER_NOT_FOUND: 'Ez az oktató már nem létezik. Frissítsd a listát.',
    ECHO_PROFILE_NOT_FOUND: 'Ez a fiók nem található.',
  };
  if (kod && TERKEP[kod]) return TERKEP[kod];
  /* A PostgREST akkor is ezt adja, ha a migráció még nem futott le — a nyers
     angol üzenet („Could not find the function…") ilyenkor a felhasználót
     hibáztatná valamiért, amiről nem tehet. Mondjuk meg, mi a teendő. */
  if (/could not find the function/i.test(raw) || /PGRST202/.test(raw)) {
    return 'Az oktatói nyilvántartás adatbázis-oldala még nincs telepítve. '
         + 'Futtatni kell a supabase/54_teacher_registry.sql migrációt.';
  }
  // A szerver üzenetei szándékosan elmondják az OKOT is (miért veszélyes a
  // törlés, mi marad a hozzárendelésekből) — a kódot levágjuk, a magyarázatot
  // meghagyjuk.
  return raw.replace(/^[A-Z_]{4,}:\s*/, '') || 'Ismeretlen hiba.';
}

async function TCH_rpc(fn, args) {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const { data, error } = await window.sb.rpc(fn, args || {});
  if (error) throw error;
  return data;
}

const TCH_api = {
  list:       (q, allapot, org) => TCH_rpc('echo_teacher_list',
                                    { p_q: q || null, p_active: allapot || 'aktiv', p_org: org || null }),
  get:        (id)              => TCH_rpc('echo_teacher_get', { p_teacher: id }),
  options:    (kind, id, q)     => TCH_rpc('echo_teacher_options',
                                    { p_kind: kind, p_teacher: id || null, p_q: q || null }),
  save:       (p)               => TCH_rpc('echo_teacher_save', p),
  setActive:  (id, aktiv, ok)   => TCH_rpc('echo_teacher_set_active',
                                    { p_teacher: id, p_active: aktiv, p_indok: ok || null }),
  courseSet:  (id, kurzus, share, szerep, torol) => TCH_rpc('echo_teacher_course_set',
                                    { p_teacher: id, p_course: kurzus, p_share: share,
                                      p_role: szerep || null, p_remove: !!torol }),
  del:        (id)              => TCH_rpc('echo_teacher_delete', { p_teacher: id }),
  // A fiók-kötés a 19_echo_roles.sql-ből jön: null profillal bont.
  link:       (id, profil)      => TCH_rpc('echo_teacher_link', { p_teacher: id, p_profile: profil }),
};

const TCH_SZEREP = {
  oktato:        { cimke: 'Oktató',          tone: 'slate'   },
  kurzusfelelos: { cimke: 'Kurzusfelelős',   tone: 'primary' },
  gyakvezeto:    { cimke: 'Gyakorlatvezető', tone: 'blue'    },
};

/* ------------------------------------------------------------
   Választó — szervezeti egység, fiók vagy kurzus keresésére.
   ------------------------------------------------------------ */
function TCH_Picker({ kind, teacherId, value, label, hint, placeholder, onPick, onClear }) {
  const [nyit, setNyit] = useState(false);
  const [q, setQ]       = useState('');
  const [opts, setOpts] = useState([]);
  const [err, setErr]   = useState('');
  const [tolt, setTolt] = useState(false);
  const dobozRef = useRef(null);

  /* A legördülő abszolút pozícionált, tehát RÁFEKSZIK az alatta lévő mezőkre
     és gombokra. Ha csak a saját gombjával lehetne becsukni, a felhasználó
     mellékattintva egy TAKART elemet célozna meg — például a „Hozzárendelés"
     gombot, miközben azt hiszi, csak elveti a listát. Ezért kívülre kattintva
     és Escape-re is becsukjuk. */
  useEffect(() => {
    if (!nyit) return;
    const kivul = (e) => { if (dobozRef.current && !dobozRef.current.contains(e.target)) setNyit(false); };
    const esc   = (e) => { if (e.key === 'Escape') setNyit(false); };
    document.addEventListener('mousedown', kivul);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', kivul);
      document.removeEventListener('keydown', esc);
    };
  }, [nyit]);

  useEffect(() => {
    if (!nyit) return;
    let el = true;
    const t = setTimeout(() => {
      setTolt(true);
      TCH_api.options(kind, teacherId, q)
        .then(r => { if (el) { setOpts(Array.isArray(r) ? r : []); setErr(''); } })
        .catch(e => { if (el) { setOpts([]); setErr(TCH_msg(e)); } })
        .finally(() => { if (el) setTolt(false); });
    }, 220);
    return () => { el = false; clearTimeout(t); };
  }, [nyit, q, kind, teacherId]);

  return (
    <div className="relative" ref={dobozRef}>
      <UField label={label} hint={hint}>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setNyit(v => !v)}
            className={U_input + ' text-left flex items-center justify-between'}
          >
            <span className={value ? 'text-slate-800' : 'text-slate-400'}>
              {value || placeholder || 'Válassz…'}
            </span>
            <Lucide.ChevronDown size={16} className="text-slate-400 flex-none" />
          </button>
          {value && onClear && (
            <button type="button" onClick={onClear} title="Mező ürítése"
              className="px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 transition-colors">
              <Lucide.X size={15} />
            </button>
          )}
        </div>
      </UField>

      {nyit && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input autoFocus value={q} onChange={e => setQ(e.target.value)}
              placeholder="Keresés…"
              className="w-full px-3 py-2 text-sm bg-slate-50 rounded-xl focus:outline-none" />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {tolt && <div className="px-4 py-3 text-xs text-slate-400">Keresés…</div>}
            {err && <div className="px-4 py-3 text-xs text-red-600">{err}</div>}
            {!tolt && !err && opts.length === 0 && (
              <div className="px-4 py-3 text-xs text-slate-400">Nincs találat.</div>
            )}
            {opts.map(o => (
              <button key={o.id} type="button"
                onClick={() => { onPick(o); setNyit(false); setQ(''); }}
                className="w-full text-left px-4 py-2.5 hover:bg-primary/5 transition-colors border-b border-slate-50 last:border-0">
                <span className="block text-sm font-semibold text-slate-700">{o.cimke}</span>
                {o.reszlet && <span className="block text-[11px] text-slate-400">{o.reszlet}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   Oktató felvitele / szerkesztése
   ------------------------------------------------------------ */
function TCH_Form({ open, oktato, onClose, onSaved }) {
  const uj = !oktato;
  const [f, setF]       = useState({});
  const [orgNev, setOrgNev] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(uj ? { code: '', name: '', title: '', email: '', org_unit_id: null }
            : { code: oktato.code || '', name: oktato.name || '', title: oktato.title || '',
                email: oktato.email || '', org_unit_id: oktato.org_unit_id || null });
    setOrgNev(uj ? '' : (oktato.org_unit || ''));
  }, [open, oktato && oktato.id]);

  const set = (k) => (v) => setF(p => ({ ...p, [k]: v }));
  const ok  = f.code && f.code.trim() && f.name && f.name.trim() && !busy;

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      // A kiüríthető mezőket nevesíteni kell: e nélkül a null „ne változtass".
      const clear = [];
      if (!uj) {
        if (!f.title || !f.title.trim()) clear.push('title');
        if (!f.email || !f.email.trim()) clear.push('email');
        if (!f.org_unit_id)              clear.push('org_unit');
      }
      const r = await TCH_api.save({
        p_id: uj ? null : oktato.id,
        p_code: f.code, p_name: f.name,
        p_title: f.title || null, p_email: f.email || null,
        p_org_unit_id: f.org_unit_id || null,
        p_clear: clear.length ? clear : null,
      });
      onSaved(r, uj);
      onClose();
    } catch (e) { setErr(TCH_msg(e)); }
    finally { setBusy(false); }
  };

  /* A közös UModal a HÁTTÉRRE kattintva is zár. Egy kitöltött űrlapnál ez egy
     véletlen kattintással mindent elvisz, nyom nélkül — ugyanaz a panasz, ami
     a belépőablaknál is jött. Itt nem az egész alkalmazást írjuk át: ha van
     beírt adat, rákérdezünk. */
  const piszkos = () => !!(
    (f.code && f.code.trim()) || (f.name && f.name.trim()) ||
    (f.title && f.title.trim()) || (f.email && f.email.trim()) || f.org_unit_id
  );
  const zarhat = () => {
    if (busy) return;
    if (piszkos() && !window.confirm('A beírt adatok elvesznek. Biztosan bezárod?')) return;
    onClose();
  };

  return (
    <UModal open={open} onClose={zarhat} max="max-w-2xl"
      icon={<Lucide.GraduationCap size={20} />}
      title={uj ? 'Új oktató' : 'Oktató szerkesztése'}
      subtitle={uj ? 'A kód és a név kötelező — a kód később is módosítható, de egyedi'
                   : 'A kódot csak akkor írd át, ha a nyilvántartásban is változott'}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <UField label="Kód" hint="egyedi azonosító">
            <input className={U_input} value={f.code || ''} onChange={e => set('code')(e.target.value)}
              placeholder="pl. OKT001" />
          </UField>
          <div className="sm:col-span-2">
            <UField label="Név">
              <input className={U_input} value={f.name || ''} onChange={e => set('name')(e.target.value)}
                placeholder="pl. Kovács Anna" />
            </UField>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <UField label="Titulus" hint="nem kötelező">
            <input className={U_input} value={f.title || ''} onChange={e => set('title')(e.target.value)}
              placeholder="pl. Dr." />
          </UField>
          <div className="sm:col-span-2">
            <UField label="E-mail" hint="a fiók-kötéshez nem ez kell, csak elérhetőség">
              <input className={U_input} value={f.email || ''} onChange={e => set('email')(e.target.value)}
                placeholder="pl. kovacs.anna@nje.hu" />
            </UField>
          </div>
        </div>

        <TCH_Picker
          kind="org_unit" label="Szervezeti egység" hint="tanszék vagy kar"
          value={orgNev} placeholder="Nincs megadva"
          onPick={o => { set('org_unit_id')(o.id); setOrgNev(o.cimke); }}
          onClear={() => { set('org_unit_id')(null); setOrgNev(''); }} />

        {err && (
          <div className="text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button className={U_btnGhost} onClick={zarhat} disabled={busy}>Mégse</button>
          <button className={U_btnPrimary} onClick={ment} disabled={!ok}>
            {busy ? 'Mentés…' : (uj ? 'Oktató létrehozása' : 'Mentés')}
          </button>
        </div>
      </div>
    </UModal>
  );
}

/* ------------------------------------------------------------
   Kurzus hozzárendelése az oktatóhoz
   ------------------------------------------------------------ */
function TCH_CourseAdd({ open, teacherId, onClose, onDone }) {
  const [kurzus, setKurzus] = useState(null);
  const [nev, setNev]       = useState('');
  const [share, setShare]   = useState('100');
  const [szerep, setSzerep] = useState('oktato');
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState('');

  useEffect(() => {
    if (!open) return;
    setKurzus(null); setNev(''); setShare('100'); setSzerep('oktato'); setErr('');
  }, [open]);

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      const sz = share === '' ? null : Number(share);
      const r = await TCH_api.courseSet(teacherId, kurzus, sz, szerep, false);
      onDone(r); onClose();
    } catch (e) { setErr(TCH_msg(e)); }
    finally { setBusy(false); }
  };

  const zarhatKurzus = () => {
    if (busy) return;
    if (kurzus && !window.confirm('A kiválasztott kurzus elvész. Biztosan bezárod?')) return;
    onClose();
  };

  return (
    <UModal open={open} onClose={zarhatKurzus} max="max-w-xl"
      icon={<Lucide.Link2 size={20} />} title="Kurzus hozzárendelése"
      subtitle="A részarány dönti el, bekerül-e az oktató a kampány jogosultjai közé">
      <div className="space-y-4">
        <TCH_Picker
          kind="course" teacherId={teacherId} label="Kurzus"
          hint="csak azok látszanak, amiket még nem visz"
          value={nev} placeholder="Válassz kurzust…"
          onPick={o => { setKurzus(o.id); setNev(o.cimke); }} />

        <div className="grid grid-cols-2 gap-4">
          <UField label="Részarány (%)" hint="mekkora részt visz a kurzusból">
            <input className={U_input} type="number" min="0" max="100" value={share}
              onChange={e => setShare(e.target.value)} />
          </UField>
          <UField label="Szerep">
            <select className={U_input} value={szerep} onChange={e => setSzerep(e.target.value)}>
              {Object.keys(TCH_SZEREP).map(k => (
                <option key={k} value={k}>{TCH_SZEREP[k].cimke}</option>
              ))}
            </select>
          </UField>
        </div>

        <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5">
          A kampány jogosultság-építése <strong>küszöb alatti részaránnyal</strong> nem veszi
          be az oktatót — ezt az ECHO beállításai határozzák meg, nem ez az űrlap.
        </div>

        {err && (
          <div className="text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className={U_btnGhost} onClick={zarhatKurzus} disabled={busy}>Mégse</button>
          <button className={U_btnPrimary} onClick={ment} disabled={!kurzus || busy}>
            {busy ? 'Mentés…' : 'Hozzárendelés'}
          </button>
        </div>
      </div>
    </UModal>
  );
}

/* ------------------------------------------------------------
   Fiók összekötése / bontása
   ------------------------------------------------------------ */
function TCH_LinkForm({ open, teacher, onClose, onDone }) {
  const [profil, setProfil] = useState(null);
  const [nev, setNev]       = useState('');
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState('');

  useEffect(() => { if (open) { setProfil(null); setNev(''); setErr(''); } }, [open]);

  const koss = async (ertek) => {
    setBusy(true); setErr('');
    try { await TCH_api.link(teacher.id, ertek); onDone(); onClose(); }
    catch (e) { setErr(TCH_msg(e)); }
    finally { setBusy(false); }
  };

  const kotott = teacher && teacher.profile_id;

  return (
    <UModal open={open} onClose={busy ? () => {} : onClose} max="max-w-lg"
      icon={<Lucide.UserCheck size={20} />}
      title={kotott ? 'Fiók-kötés bontása' : 'Fiók összekötése'}
      subtitle="A kötés adja meg, hogy az oktató lássa a saját eredményeit">
      <div className="space-y-4">
        {kotott ? (
          <div className="text-sm text-slate-600">
            Jelenlegi fiók:{' '}
            <strong className="text-slate-800">
              {(teacher.fiok && (teacher.fiok.name || teacher.fiok.email)) || '—'}
            </strong>
            <div className="text-[12px] text-slate-500 mt-2">
              A bontás után az oktató <strong>nem látja</strong> a saját eredményeit, és az
              ECHO „OKTATO" jogosultsága is megszűnik. A kampányadatok nem vesznek el.
            </div>
          </div>
        ) : (
          <TCH_Picker
            kind="profile" teacherId={teacher && teacher.id} label="Fiók"
            hint="csak olyan fiók választható, ami még nincs másik oktatóhoz kötve"
            value={nev} placeholder="Válassz fiókot…"
            onPick={o => { setProfil(o.id); setNev(o.cimke); }} />
        )}

        {err && (
          <div className="text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className={U_btnGhost} onClick={onClose} disabled={busy}>Mégse</button>
          {kotott ? (
            <button className={U_btn + ' bg-red-600 text-white hover:bg-red-700'}
              onClick={() => koss(null)} disabled={busy}>
              {busy ? 'Bontás…' : 'Kötés bontása'}
            </button>
          ) : (
            <button className={U_btnPrimary} onClick={() => koss(profil)} disabled={!profil || busy}>
              {busy ? 'Összekötés…' : 'Összeköt'}
            </button>
          )}
        </div>
      </div>
    </UModal>
  );
}

/* ------------------------------------------------------------
   Egy kurzus sora az oktató lapján — helyben szerkeszthető, és lenyitva
   megmutatja, kik járnak rá.

   MIÉRT ITT VAN A NÉVSOR
     A kurzus hallgatói MINDEN oktatójához tartoznak: a részarány nem osztja
     szét a névsort, csak azt mondja meg, ki mekkora részt visz. Ezért a
     „hozzá tartozó diákok" a kurzus teljes névsora — pontosan azt hívjuk le,
     amit a kurzusnyilvántartás is (echo_course_students).
   ------------------------------------------------------------ */
function TCH_CourseRow({ k, teacherId, busy, onChanged, onRemove, felvett }) {
  const [nyit, setNyit]     = useState(false);
  const [szerk, setSzerk]   = useState(false);
  const [share, setShare]   = useState(k.share_pct == null ? '' : String(Number(k.share_pct)));
  const [szerep, setSzerep] = useState(k.role || 'oktato');
  const [ment, setMent]     = useState(false);
  const [err, setErr]       = useState('');

  const [diak, setDiak]     = useState(null);
  const [dTolt, setDTolt]   = useState(false);
  const [dErr, setDErr]     = useState('');
  const [dQ, setDQ]         = useState('');

  /* A SZERKESZTŐ MEZŐI KÖVESSÉK A FRISS ADATOT. A useState kezdőértéke csak az
     ELSŐ rendereléskor számít: ha a szülő újratölt (mentés, kurzusváltozás),
     vagy ugyanaz a kurzus egy MÁSIK oktató lapján jelenik meg, a mezőkben a
     régi részarány és szerep maradna — és mentéskor AZT írnánk rá a friss
     rekordra. Amíg a sor szerkesztés alatt van, nem nyúlunk hozzá: a felhasználó
     félkész beírását nem szabad kirántani alóla. */
  useEffect(() => {
    if (szerk) return;
    setShare(k.share_pct == null ? '' : String(Number(k.share_pct)));
    setSzerep(k.role || 'oktato');
  }, [k.course_id, k.share_pct, k.role, teacherId, szerk]);

  // A névsort CSAK lenyitáskor kérjük le — egy oktatónak akár 14 kurzusa is
  // lehet, azokat előre betölteni felesleges kör lenne.
  useEffect(() => {
    if (!nyit) return;
    let el = true;
    const t = setTimeout(() => {
      setDTolt(true);
      TCH_rpc('echo_course_students', { p_course: k.course_id, p_q: dQ || null, p_limit: 500 })
        .then(r => { if (el) { setDiak(Array.isArray(r) ? r : []); setDErr(''); } })
        .catch(e => { if (el) { setDiak([]); setDErr(TCH_msg(e)); } })
        .finally(() => { if (el) setDTolt(false); });
    }, dQ ? 250 : 0);
    return () => { el = false; clearTimeout(t); };
  }, [nyit, dQ, k.course_id]);

  const sz = TCH_SZEREP[k.role] || { cimke: k.role || '—', tone: 'slate' };

  const mentes = async () => {
    /* AZ ÜRES MEZŐ NEM 0 ÉS NEM 100. A szerver oldalán a beszúrás
       coalesce(p_share, 100)-at ír, az ütközés-ág pedig ezt az értéket veszi
       át — vagyis egy null CSENDBEN 100%-ra állítaná a részarányt. Egy 15%-os
       oktató így hirtelen 100%-ossá válna, és bekerülne olyan kampányba,
       ahonnan a küszöb szándékosan kihagyta. Ezért az üres mezőt „ne
       változtass"-ként kezeljük: a meglévő értéket küldjük vissza. */
    const eredeti = k.share_pct == null ? null : Number(k.share_pct);
    const kuldott = share === '' ? eredeti : Number(share);
    if (share !== '' && (isNaN(kuldott) || kuldott < 0 || kuldott > 100)) {
      setErr('A részarány 0 és 100 közötti szám lehet.');
      return;
    }
    setMent(true); setErr('');
    try {
      await TCH_api.courseSet(teacherId, k.course_id, kuldott, szerep, false);
      setSzerk(false);
      onChanged && onChanged();
    } catch (e) { setErr(TCH_msg(e)); }
    finally { setMent(false); }
  };

  const megse = () => {
    setShare(k.share_pct == null ? '' : String(Number(k.share_pct)));
    setSzerep(k.role || 'oktato');
    setSzerk(false); setErr('');
  };

  return (
    <>
      <tr className={'border-b border-slate-50 ' + (nyit ? 'bg-slate-50/70' : '')}>
        <td className="px-6 py-3">
          <button type="button" onClick={() => setNyit(v => !v)}
            className="flex items-start gap-2 text-left group">
            <Lucide.ChevronRight size={15}
              className={'mt-0.5 flex-none text-slate-400 transition-transform '
                         + (nyit ? 'rotate-90' : '')} />
            <span>
              <span className="block font-semibold text-slate-700 group-hover:text-primary transition-colors">
                {k.name}
              </span>
              <span className="block text-[11px] text-slate-400">{k.code}</span>
            </span>
          </button>
        </td>
        <td className="px-6 py-3 text-slate-500">{k.term}</td>

        {/* A FELVETT LETSZAM az aktiv enrollment sorokbol jon (72-es migracio).
            A kurzus sajat 'letszam' mezoje a forrasrendszere, es gyakran ures —
            ezert a mert szam az elsodleges, az meg csak tartalek. */}
        <td className="px-6 py-3">
          <span className="font-black text-slate-700 tabular-nums">
            {felvett != null ? felvett : (k.letszam != null ? k.letszam : '—')}
          </span>
          <span className="text-[11px] text-slate-400 font-bold"> fő</span>
        </td>

        <td className="px-6 py-3">
          {szerk ? (
            <select className={U_input + ' py-1.5 text-[13px]'} value={szerep}
              onChange={e => setSzerep(e.target.value)} disabled={ment || busy}>
              {/* Ha a rekordban a háromnál több szerep van (külső importból
                  jöhet ilyen), a SAJÁTJÁT is felkínáljuk — különben a mentés
                  csendben átírná valami másra, vagy a szerver visszadobná. */}
              {(Object.keys(TCH_SZEREP).indexOf(szerep) < 0 && szerep
                ? [szerep].concat(Object.keys(TCH_SZEREP))
                : Object.keys(TCH_SZEREP)).map(x => (
                <option key={x} value={x}>{(TCH_SZEREP[x] && TCH_SZEREP[x].cimke) || x}</option>
              ))}
            </select>
          ) : <UBadge tone={sz.tone}>{sz.cimke}</UBadge>}
        </td>

        <td className="px-6 py-3">
          {szerk ? (
            <input type="number" min="0" max="100" value={share} disabled={ment || busy}
              onChange={e => setShare(e.target.value)}
              className={U_input + ' py-1.5 text-[13px] w-24'} />
          ) : (
            <span className="text-slate-600 font-semibold">
              {k.share_pct == null ? '—' : Number(k.share_pct) + '%'}
            </span>
          )}
        </td>

        <td className="px-6 py-3">
          <div className="flex items-center justify-end gap-1.5">
            {szerk ? (
              <>
                <button onClick={mentes} disabled={ment || busy}
                  className="px-2.5 py-1.5 rounded-lg bg-primary text-white text-[12px] font-bold hover:bg-primary/90 disabled:opacity-50">
                  {ment ? 'Mentés…' : 'Mentés'}
                </button>
                <button onClick={megse} disabled={ment || busy}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-[12px] font-bold hover:bg-slate-200 disabled:opacity-50">
                  Mégse
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setSzerk(true)} disabled={busy}
                  title="Részarány és szerep módosítása"
                  className="text-slate-400 hover:text-primary transition-colors disabled:opacity-40 p-1">
                  <Lucide.Pencil size={15} />
                </button>
                <button onClick={() => onRemove(k.course_id)} disabled={busy}
                  title="Levétel a kurzusról"
                  className="text-slate-400 hover:text-red-600 transition-colors disabled:opacity-40 p-1">
                  <Lucide.Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        </td>
      </tr>

      {err && (
        <tr className="border-b border-slate-50">
          <td colSpan={5} className="px-6 pb-3">
            <div className="text-[12px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
              {err}
            </div>
          </td>
        </tr>
      )}

      {nyit && (
        <tr className="border-b border-slate-100 bg-slate-50/70">
          <td colSpan={5} className="px-6 pb-5 pt-1">
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 flex-wrap">
                <div>
                  <span className="text-[12px] font-black text-slate-700">
                    A kurzus hallgatói
                    {/* Hibánál NEM írunk létszámot: a „0 fő" azt állítaná, hogy
                        a kurzuson nincs hallgató, holott csak a lekérés bukott.
                        A 500 a szerverhívás korlátja — ha pont annyi jött, azt
                        megmondjuk, nehogy a szám döntési alapnak látsszon. */}
                    {!dErr && diak && (
                      <span className="text-slate-400">
                        {' · '}{diak.length >= 500 ? 'az első 500' : diak.length + ' fő'}
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-slate-400">
                    Ők értékelik ezt az oktatót ezen a kurzuson.
                  </span>
                </div>
                <input value={dQ} onChange={e => setDQ(e.target.value)}
                  placeholder="Keresés a névsorban…"
                  className="px-3 py-1.5 text-[12px] bg-slate-50 border border-slate-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 w-56" />
              </div>

              {dTolt && !diak && <div className="px-4 py-4 text-[12px] text-slate-400">Névsor betöltése…</div>}
              {dErr && <div className="px-4 py-4 text-[12px] text-red-600">{dErr}</div>}
              {diak && diak.length === 0 && !dTolt && !dErr && (
                <div className="px-4 py-5 text-[12px] text-slate-400">
                  {dQ ? 'Nincs találat a keresésre.' : 'Erre a kurzusra egyetlen hallgató sincs felvéve.'}
                </div>
              )}

              {diak && diak.length > 0 && (
                <div className="max-h-80 overflow-y-auto">
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-[9px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                        <th className="px-4 py-2">Hallgató</th>
                        <th className="px-4 py-2">Félév</th>
                        <th className="px-4 py-2">Állapot</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diak.map((d, i) => (
                        <tr key={(d.profile_id || '') + i} className="border-b border-slate-50 last:border-0">
                          <td className="px-4 py-2">
                            <span className="block font-semibold text-slate-700">{d.nev}</span>
                            <span className="block text-[11px] text-slate-400">{d.email}</span>
                          </td>
                          <td className="px-4 py-2 text-slate-500">{d.term}</td>
                          <td className="px-4 py-2">
                            <UBadge tone={d.status === 'active' ? 'green' : 'slate'}>
                              {d.status === 'active' ? 'aktív' : (d.status || '—')}
                            </UBadge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------------------------------------
   Egy oktató lapja
   ------------------------------------------------------------ */
function TCH_Detail({ id, user, onChanged, onDeleted }) {
  const [d, setD]       = useState(null);
  const [tolt, setTolt] = useState(true);
  const [err, setErr]   = useState('');
  const [szerk, setSzerk]   = useState(false);
  const [kurzus, setKurzus] = useState(false);
  const [link, setLink]     = useState(false);
  const [uzenet, setUzenet] = useState('');
  const [busy, setBusy]     = useState(false);
  /* Összesítő számok (72_teacher_stats.sql). Külön hívás, mert az
     echo_teacher_get() törzse a törzsadaté — és ha a migráció még nem futott
     le, a lap többi része maradjon változatlanul használható. */
  const [stat, setStat]     = useState(null);
  const hivRef = useRef(null);

  /* Helyben frissítés (mentés, kurzusváltozás, fiók-kötés után). A `d`-t
     SZÁNDÉKOSAN nem nullázza: ilyenkor ugyanarról az oktatóról van szó, és
     nem akarjuk, hogy a lap villanjon egyet. */
  const tolts = () => {
    setTolt(true);
    TCH_api.get(id)
      .then(r => { setD(r); setErr(''); })
      .catch(e => setErr(TCH_msg(e)))
      .finally(() => setTolt(false));
  };

  /* OKTATÓVÁLTÁS — ez MÁS, mint a helyben frissítés, és korábban nem volt az.
     A hiba, amit javít: a `d` a betöltés alatt (és hibás betöltésnél VÉGLEG) az
     ELŐZŐ oktató rekordja maradt, miközben a lista már a másikat jelölte. A lap
     minden gombja `d.id`-re dolgozik, tehát az „Inaktiválás" és a „Végleges
     törlés" a rossz oktatóra futott volna — a törlés visszafordíthatatlanul.
     Két őr kell hozzá:
       1. a `d` azonnali nullázása, hogy a régi adat ne látszódjon tovább;
       2. elavulás-jelző, mert két gyors kattintásnál a válaszok fordított
          sorrendben is visszaérhetnek, és a régi kérés felülírná az újat.
     A `key={valasztott}` a hívó oldalon ugyanezt erősíti meg. */
  useEffect(() => {
    if (!id) return;
    let el = true;
    setD(null); setErr(''); setUzenet(''); setTolt(true);
    setStat(null);
    TCH_api.get(id)
      .then(r => { if (el) { setD(r); setErr(''); } })
      .catch(e => { if (el) setErr(TCH_msg(e)); })
      .finally(() => { if (el) setTolt(false); });
    TCH_rpc('echo_teacher_stats', { p_teacher: id })
      .then(r => { if (el) setStat(r); })
      .catch(() => { if (el) setStat(null); });   /* a 72-es migráció még nem futott le */
    // A lap a lista ALATT nyílik meg: oktatóváltásnál oda görgetünk, különben
    // a kattintás után a képernyőn látszólag nem történik semmi.
    setTimeout(() => { try { hivRef.current && hivRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {} }, 120);
    return () => { el = false; };
  }, [id]);

  if (tolt && !d) return <div className="p-8 text-sm text-slate-400">Betöltés…</div>;
  if (err && !d)  return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!d) return null;

  const nyom  = d.nyomok || {};
  const vanNyom = ['jogosultsag','valasz','kizaras','jegyzokonyv','eszrevetel']
                    .some(k => Number(nyom[k] || 0) > 0);
  /* TÖRÖLHETŐ: a `teachers` modul DELETE joga. A `regi` paraméter a mai lista;
     a szerveroldali pár az echo_teacher_delete(), ami is_admin()-t kér — ezért
     a 72-es backfill a teachers DELETE-et csak az ADMIN-nak adta meg. */
  const torolheto = !vanNyom && Number(nyom.kurzus || 0) === 0
                    && PERM_can(user, 'teachers', 'DELETE',
                                ['SUPERADMIN','ADMIN'].includes(user.role));

  const allapotValt = async () => {
    setBusy(true); setUzenet(''); setErr('');
    try {
      const r = await TCH_api.setActive(d.id, !d.active, null);
      setD(r.oktato || r);
      setUzenet(r.figyelmeztetes || '');
      onChanged && onChanged();
    } catch (e) { setErr(TCH_msg(e)); }
    finally { setBusy(false); }
  };

  const kurzusLe = async (courseId) => {
    setBusy(true); setErr('');
    try { setD(await TCH_api.courseSet(d.id, courseId, null, null, true)); onChanged && onChanged(); }
    catch (e) { setErr(TCH_msg(e)); }
    finally { setBusy(false); }
  };

  const torol = async () => {
    setBusy(true); setErr('');
    try { await TCH_api.del(d.id); onDeleted && onDeleted(); }
    catch (e) { setErr(TCH_msg(e)); }
    finally { setBusy(false); }
  };

  const szam = (v) => (v == null ? '—' : v);
  const felevek = (stat && stat.felevek) || [];

  return (
    <div className="space-y-5" ref={hivRef} data-tch-lap={id}>
      {/* fejléc */}
      <div className="bg-white rounded-3xl border border-slate-100 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-xl font-black text-slate-900">
                {d.title ? d.title + ' ' : ''}{d.name}
              </h3>
              <UBadge tone={d.active ? 'green' : 'slate'}>
                {d.active ? 'Aktív' : 'Inaktív'}
              </UBadge>
              {d.ext_source && d.ext_source !== 'manual' && (
                <UBadge tone="blue">külső forrás: {d.ext_source}</UBadge>
              )}
            </div>
            <p className="text-sm text-slate-500 mt-1.5">
              {d.code}
              {d.email ? ' · ' + d.email : ''}
              {d.org_unit ? ' · ' + d.org_unit : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className={U_btnGhost} onClick={() => setSzerk(true)} disabled={busy}>
              <Lucide.Pencil size={15} /> Szerkesztés
            </button>
            <button className={U_btn + (d.active
                      ? ' bg-amber-500 text-white hover:bg-amber-600'
                      : ' bg-emerald-600 text-white hover:bg-emerald-700')}
              onClick={allapotValt} disabled={busy}>
              {d.active ? <Lucide.UserMinus size={15} /> : <Lucide.UserCheck size={15} />}
              {d.active ? ' Inaktiválás' : ' Aktiválás'}
            </button>
          </div>
        </div>

        {uzenet && (
          <div className="mt-4 text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
            <strong className="block mb-0.5">Az inaktiválás megtörtént, de olvasd el ezt:</strong>
            {uzenet}
          </div>
        )}
        {err && (
          <div className="mt-4 text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
            {err}
          </div>
        )}
      </div>

      {/* fiók-kötés */}
      <div className="bg-white rounded-3xl border border-slate-100 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h4 className="text-sm font-black text-slate-800">Fiók-kötés</h4>
            <p className="text-[12px] text-slate-500 mt-1 max-w-lg">
              Ez adja meg, hogy az oktató belépve lássa a saját eredményeit. Kötés nélkül
              az „Oktatói eredmények" képernyő üresen fogadja.
            </p>
            <div className="mt-3 text-sm">
              {d.fiok ? (
                <span className="text-slate-700 font-semibold">
                  {d.fiok.name || d.fiok.email}
                  <span className="text-slate-400 font-normal"> · {d.fiok.email}</span>
                </span>
              ) : (
                <span className="text-slate-400">Nincs fiók összekötve.</span>
              )}
            </div>
            {Array.isArray(d.grantok) && d.grantok.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {d.grantok.map(g => (
                  <UBadge key={g.id} tone={g.aktiv ? 'violet' : 'slate'}>
                    {g.role}{g.expires_at ? ' · lejár' : ''}
                  </UBadge>
                ))}
              </div>
            )}
          </div>
          {/* A fiók-kötés szerveroldali feltétele az echo.can_grant(): admin
              vagy ECHO SYSADMIN. Egy ügyintézőnek (ADMISSIONS/FINANCE) a gomb
              végigvezetné a keresésen, és csak a végén közölné, hogy nem
              szabad — ezért nála meg sem jelenik, hanem megmondjuk, kitől
              kérje. */}
          {/* A fiók-kötés ECHO-grantot is kioszt (echo_teacher_link -> 'OKTATO'),
              tehát NEM modul-mátrix kérdése: az ECHO saját, hatókörös
              jogosultsági dimenziója dönt róla (19_echo_roles.sql). A 19-es
              fejléce kimondja: „AZ ECHO-JOG SOHA NEM SZÁRMAZIK A UniPortal
              SUPERADMIN-BÓL." Ezért ez a lista SZÁNDÉKOSAN kódba égetett marad. */}
          {['SUPERADMIN','ADMIN'].includes(user.role) ? (
            <button className={U_btnGhost} onClick={() => setLink(true)} disabled={busy}>
              <Lucide.UserCheck size={15} /> {d.fiok ? 'Kötés bontása' : 'Összeköt'}
            </button>
          ) : (
            <span className="text-[11px] text-slate-400 max-w-[190px] text-right">
              A fiók-kötést rendszergazda végzi.
            </span>
          )}
        </div>
      </div>

      {/* ÖSSZESÍTŐ — mennyi munkája van, és hány hallgatót érint.
          Eredményt (átlagot, választ) SZÁNDÉKOSAN nem mutat: az a k-küszöbhöz
          kötött „Oktatói eredmények” képernyőé, a kérdőív pedig névtelen. */}
      {stat && (
        <div className="space-y-3" data-tch-osszesito="1">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[[szam(stat.kurzus_ossz), 'kurzusa', 'A hozzárendelt kurzusok száma, minden félévben.'],
              [szam(stat.hallgato_ossz), 'hallgatója', 'Különböző hallgatók az összes kurzusán. Aki két kurzusára is jár, egyszer számít.'],
              [szam(stat.kurzusfelvetel_ossz), 'kurzusfelvétel', 'Hallgató × kurzus párok száma — ennyi értékelhető kurzusa van összesen.'],
              [szam(stat.kampany_db), 'kampányban érintett', 'Hány ECHO-kampány jogosultsági listájára került fel.']]
              .map(([v, cimke, sug], i) => (
              <div key={i} className="bg-white rounded-2xl border border-slate-100 px-5 py-4" title={sug}>
                <div className="text-2xl font-black text-slate-900 tabular-nums">{v}</div>
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">{cimke}</div>
              </div>
            ))}
          </div>

          {felevek.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-100 px-5 py-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Félévenként</p>
              <div className="flex flex-wrap gap-2">
                {felevek.map(f => (
                  <span key={f.felev} data-tch-felev={f.felev}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-1.5 text-[12px] font-bold text-slate-600">
                    <span className="text-slate-800">{f.felev}</span>
                    <span className="text-slate-400">{f.kurzus} kurzus · {f.hallgato} hallgató</span>
                  </span>
                ))}
              </div>
              {Number(stat.kizaras_db) > 0 && (
                <p className="text-[11px] text-amber-700 font-bold mt-2.5">
                  {stat.kizaras_db} kizárási bejegyzés (létszám, órarendi info, vizsgakurzus vagy óraarány miatt kimaradt kurzus).
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* kurzusok */}
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 flex-wrap">
          <div>
            <h4 className="text-sm font-black text-slate-800">
              Kurzusai <span className="text-slate-400 font-bold">({(d.kurzusok || []).length})</span>
            </h4>
            <p className="text-[12px] text-slate-500 mt-0.5">
              Ez alapján kerül be a kampányok jogosultjai közé. Nyisd le a kurzust
              a hallgatói névsorért, vagy a ceruzával írd át a részarányt és a szerepet.
            </p>
          </div>
          <button className={U_btnGhost} onClick={() => setKurzus(true)} disabled={busy}>
            <Lucide.Plus size={15} /> Kurzus hozzárendelése
          </button>
        </div>

        {/* A levétel hibája ITT kell hogy megjelenjen, nem a lap tetején: a
            táblázat több száz pixerrel lejjebb van, és a felhasználó azt látná,
            hogy a kuka gomb „nem csinál semmit". */}
        {err && (
          <div className="mx-6 mt-4 text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
            {err}
          </div>
        )}

        {(d.kurzusok || []).length === 0 ? (
          <UEmpty icon={<Lucide.BookOpen size={26} />} title="Nincs kurzusa"
            subtitle="Amíg nincs kurzus-hozzárendelése, egyetlen kampányba sem kerül be." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                  <th className="px-6 py-3">Kurzus</th>
                  <th className="px-6 py-3">Félév</th>
                  <th className="px-6 py-3">Hallgató</th>
                  <th className="px-6 py-3">Szerep</th>
                  <th className="px-6 py-3">Részarány</th>
                  <th className="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {d.kurzusok.map(k => (
                  <TCH_CourseRow key={k.course_id} k={k} teacherId={d.id} busy={busy}
                    felvett={stat && stat.kurzusok ? stat.kurzusok[k.course_id] : null}
                    onChanged={tolts} onRemove={kurzusLe} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* nyomok és törlés */}
      <div className="bg-white rounded-3xl border border-slate-100 p-6">
        <h4 className="text-sm font-black text-slate-800">Mi tartozik hozzá</h4>
        <p className="text-[12px] text-slate-500 mt-1 max-w-2xl">
          Ez dönti el, törölhető-e. A törlés kaszkádol: elvinné a jogosultsági sorokat, a
          kizárási naplót és a jegyzőkönyv-átadásokat is — ezért ha bármelyik szám nem
          nulla, a szerver elutasítja. Ilyenkor az <strong>inaktiválás</strong> a helyes lépés.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
          {[['kurzus','Kurzus'],['jogosultsag','Jogosultság'],['valasz','Válasz'],
            ['kizaras','Kizárás'],['jegyzokonyv','Jegyzőkönyv'],['eszrevetel','Észrevétel']].map(([k, cimke]) => (
            <div key={k} className={'rounded-2xl px-3 py-3 border '
                  + (Number(nyom[k] || 0) > 0 ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-100')}>
              <div className="text-lg font-black text-slate-800">{nyom[k] || 0}</div>
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{cimke}</div>
            </div>
          ))}
        </div>

        {PERM_can(user, 'teachers', 'DELETE', ['SUPERADMIN','ADMIN'].includes(user.role)) && (
          <div className="mt-5 pt-5 border-t border-slate-100 flex items-center justify-between gap-4 flex-wrap">
            <span className="text-[12px] text-slate-500">
              {torolheto
                ? 'Ehhez az oktatóhoz nem tartozik semmi — biztonságosan törölhető.'
                : 'Törlés nem lehetséges, mert tartozik hozzá adat. Használd az inaktiválást.'}
            </span>
            <button
              className={U_btn + ' bg-red-600 text-white hover:bg-red-700 disabled:opacity-40'}
              onClick={torol} disabled={!torolheto || busy}>
              <Lucide.Trash2 size={15} /> Végleges törlés
            </button>
          </div>
        )}

        {/* A szerver a törlésnél PONTOSAN megmondja, mi tartozik az oktatóhoz —
            ez a magyarázat a gomb mellett ér valamit, nem a lap tetején. */}
        {err && PERM_can(user, 'teachers', 'DELETE', ['SUPERADMIN','ADMIN'].includes(user.role)) && (
          <div className="mt-3 text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
            {err}
          </div>
        )}
      </div>

      <TCH_Form open={szerk} oktato={d} onClose={() => setSzerk(false)}
        onSaved={(r) => { setD(r); onChanged && onChanged(); }} />
      <TCH_CourseAdd open={kurzus} teacherId={d.id} onClose={() => setKurzus(false)}
        onDone={(r) => { setD(r); onChanged && onChanged(); }} />
      <TCH_LinkForm open={link} teacher={d} onClose={() => setLink(false)}
        onDone={() => { tolts(); onChanged && onChanged(); }} />
    </div>
  );
}

/* ------------------------------------------------------------
   Fő képernyő
   ------------------------------------------------------------ */
function TCH_View({ user }) {
  const [sor, setSor]       = useState([]);
  const [tolt, setTolt]     = useState(true);
  const [err, setErr]       = useState('');
  const [q, setQ]           = useState('');
  const [allapot, setAllapot] = useState('aktiv');
  const [org, setOrg]       = useState(null);
  const [orgNev, setOrgNev] = useState('');
  const [valasztott, setValasztott] = useState(null);
  const [ujForm, setUjForm] = useState(false);

  /* Kézi frissítés (mentés, törlés után). Az elavulás-jelzőt a lenti effekt
     adja — ide nem kell, mert nincs mellette másik, versengő kérés. */
  const tolts = () => {
    setTolt(true);
    TCH_api.list(q, allapot, org)
      .then(r => { setSor(Array.isArray(r) ? r : []); setErr(''); })
      .catch(e => { setSor([]); setErr(TCH_msg(e)); })
      .finally(() => setTolt(false));
  };

  /* SZŰRÉSVÁLTÁS. Gépelés közben több kérés is útnak indulhat, és ezek NEM
     feltétlenül a kiküldés sorrendjében érnek vissza — elavulás-jelző nélkül
     egy korábbi, tágabb keresés eredménye ülne rá a frissebbre, és a lista
     tartósan mást mutatna, mint amit a szűrők állítanak. */
  useEffect(() => {
    let el = true;
    const t = setTimeout(() => {
      setTolt(true);
      TCH_api.list(q, allapot, org)
        .then(r => { if (el) { setSor(Array.isArray(r) ? r : []); setErr(''); } })
        .catch(e => { if (el) { setSor([]); setErr(TCH_msg(e)); } })
        .finally(() => { if (el) setTolt(false); });
    }, 250);
    return () => { el = false; clearTimeout(t); };
  }, [q, allapot, org]);

  const osszesen = React.useMemo(() => ({
    db:      sor.length,
    kotott:  sor.filter(x => x.kotott).length,
    kurzus:  sor.reduce((a, x) => a + Number(x.kurzus || 0), 0),
    nincsKurzus: sor.filter(x => Number(x.kurzus || 0) === 0).length,
  }), [sor]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1500px] mx-auto">
      {/* fejléc */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight">Oktatói nyilvántartás</h2>
          <p className="text-sm text-slate-500 mt-1">
            Oktatók adatai, kurzus-hozzárendelései és fiók-kötése · az ECHO kampányok innen
            veszik, kinek a munkáját értékelik
          </p>
        </div>
        <button className={U_btnPrimary} onClick={() => setUjForm(true)}>
          <Lucide.Plus size={16} /> Új oktató
        </button>
      </div>

      {/* számok */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[[osszesen.db, 'a szűrés szerint'],
          [osszesen.kurzus, 'kurzus-hozzárendelés'],
          [osszesen.kotott, 'fiókhoz kötve'],
          [osszesen.nincsKurzus, 'kurzus nélkül']].map(([v, cimke], i) => (
          <div key={i} className="bg-white rounded-2xl border border-slate-100 px-5 py-4">
            <div className="text-2xl font-black text-slate-900">{v}</div>
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">
              {cimke}
            </div>
          </div>
        ))}
      </div>

      {/* szűrők */}
      <div className="bg-white rounded-3xl border border-slate-100 p-4 sm:p-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <UField label="Keresés" hint="név, kód vagy e-mail">
            <input className={U_input} value={q} onChange={e => setQ(e.target.value)}
              placeholder="Kezdj el gépelni…" />
          </UField>
          <UField label="Állapot">
            <select className={U_input} value={allapot} onChange={e => setAllapot(e.target.value)}>
              <option value="aktiv">Csak aktív</option>
              <option value="inaktiv">Csak inaktív</option>
              <option value="mind">Mind</option>
            </select>
          </UField>
          <TCH_Picker kind="org_unit" label="Szervezeti egység" value={orgNev}
            placeholder="Mind" onPick={o => { setOrg(o.id); setOrgNev(o.cimke); }}
            onClear={() => { setOrg(null); setOrgNev(''); }} />
        </div>
      </div>

      {err && (
        <div className="text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-2xl px-4 py-3">
          {err}
        </div>
      )}

      {/* lista */}
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        {tolt && sor.length === 0 ? (
          <div className="p-10 text-sm text-slate-400 text-center">Betöltés…</div>
        ) : sor.length === 0 ? (
          <UEmpty icon={<Lucide.GraduationCap size={26} />} title="Nincs találat"
            subtitle="Változtass a keresésen vagy a szűrőkön — vagy vegyél fel új oktatót." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                  <th className="px-6 py-3.5">Oktató</th>
                  <th className="px-6 py-3.5">Szervezeti egység</th>
                  <th className="px-6 py-3.5">Kurzus</th>
                  <th className="px-6 py-3.5">Fiók</th>
                  <th className="px-6 py-3.5">Állapot</th>
                </tr>
              </thead>
              <tbody>
                {sor.map(t => (
                  <tr key={t.id}
                    onClick={() => setValasztott(t.id)}
                    className={'border-b border-slate-50 last:border-0 cursor-pointer transition-colors '
                      + (valasztott === t.id ? 'bg-primary/5' : 'hover:bg-slate-50')}>
                    <td className="px-6 py-3.5">
                      <span className="block font-semibold text-slate-800">
                        {t.title ? t.title + ' ' : ''}{t.name}
                      </span>
                      <span className="block text-[11px] text-slate-400">
                        {t.code}{t.email ? ' · ' + t.email : ''}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-slate-500">{t.org_unit || '—'}</td>
                    <td className="px-6 py-3.5">
                      <span className={'font-black ' + (Number(t.kurzus) === 0 ? 'text-slate-300' : 'text-slate-700')}>
                        {t.kurzus}
                      </span>
                    </td>
                    <td className="px-6 py-3.5">
                      {t.kotott
                        ? <UBadge tone="green">kötve</UBadge>
                        : <UBadge tone="slate">nincs</UBadge>}
                    </td>
                    <td className="px-6 py-3.5">
                      <UBadge tone={t.active ? 'green' : 'slate'}>
                        {t.active ? 'Aktív' : 'Inaktív'}
                      </UBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* A szerver 200 sornál vág. Enélkül a hiányzó oktatókat a felhasználó
          úgy értené, hogy nincsenek — pedig csak nem fértek bele. */}
      {sor.length >= 200 && (
        <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-2.5">
          A lista az első 200 oktatót mutatja. Szűkíts a kereséssel vagy a
          szervezeti egységgel, ha nem találod, akit keresel.
        </p>
      )}

      {/* A kiválasztott oktató lapja.
          A key KÖTELEZŐ: enélkül oktatóváltáskor a komponens nem épül újra, és
          a belső állapota (a betöltött rekord, a nyitott modálisok) az előző
          oktatóé maradna — a lap gombjai pedig mind arra dolgoznának. */}
      {valasztott && (
        <TCH_Detail key={valasztott} id={valasztott} user={user}
          onChanged={tolts}
          onDeleted={() => { setValasztott(null); tolts(); }} />
      )}

      <TCH_Form open={ujForm} oktato={null} onClose={() => setUjForm(false)}
        onSaved={(r) => { tolts(); setValasztott(r && r.id); }} />
    </div>
  );
}
