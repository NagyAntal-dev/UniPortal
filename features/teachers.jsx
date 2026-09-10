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
    <div className="relative">
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

  return (
    <UModal open={open} onClose={busy ? () => {} : onClose} max="max-w-2xl"
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
          <button className={U_btnGhost} onClick={onClose} disabled={busy}>Mégse</button>
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

  return (
    <UModal open={open} onClose={busy ? () => {} : onClose} max="max-w-xl"
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
          <button className={U_btnGhost} onClick={onClose} disabled={busy}>Mégse</button>
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

  const tolts = () => {
    setTolt(true);
    TCH_api.get(id)
      .then(r => { setD(r); setErr(''); })
      .catch(e => setErr(TCH_msg(e)))
      .finally(() => setTolt(false));
  };
  useEffect(() => { if (id) tolts(); }, [id]);

  if (tolt && !d) return <div className="p-8 text-sm text-slate-400">Betöltés…</div>;
  if (err && !d)  return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!d) return null;

  const nyom  = d.nyomok || {};
  const vanNyom = ['jogosultsag','valasz','kizaras','jegyzokonyv','eszrevetel']
                    .some(k => Number(nyom[k] || 0) > 0);
  const torolheto = !vanNyom && Number(nyom.kurzus || 0) === 0
                    && ['SUPERADMIN','ADMIN'].includes(user.role);

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

  return (
    <div className="space-y-5">
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
          <button className={U_btnGhost} onClick={() => setLink(true)} disabled={busy}>
            <Lucide.UserCheck size={15} /> {d.fiok ? 'Kötés bontása' : 'Összeköt'}
          </button>
        </div>
      </div>

      {/* kurzusok */}
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 flex-wrap">
          <div>
            <h4 className="text-sm font-black text-slate-800">
              Kurzusai <span className="text-slate-400 font-bold">({(d.kurzusok || []).length})</span>
            </h4>
            <p className="text-[12px] text-slate-500 mt-0.5">
              Ez alapján kerül be a kampányok jogosultjai közé.
            </p>
          </div>
          <button className={U_btnGhost} onClick={() => setKurzus(true)} disabled={busy}>
            <Lucide.Plus size={15} /> Kurzus hozzárendelése
          </button>
        </div>

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
                  <th className="px-6 py-3">Szerep</th>
                  <th className="px-6 py-3">Részarány</th>
                  <th className="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {d.kurzusok.map(k => {
                  const sz = TCH_SZEREP[k.role] || { cimke: k.role || '—', tone: 'slate' };
                  return (
                    <tr key={k.course_id} className="border-b border-slate-50 last:border-0">
                      <td className="px-6 py-3">
                        <span className="block font-semibold text-slate-700">{k.name}</span>
                        <span className="block text-[11px] text-slate-400">{k.code}</span>
                      </td>
                      <td className="px-6 py-3 text-slate-500">{k.term}</td>
                      <td className="px-6 py-3"><UBadge tone={sz.tone}>{sz.cimke}</UBadge></td>
                      <td className="px-6 py-3 text-slate-600 font-semibold">
                        {k.share_pct == null ? '—' : Number(k.share_pct) + '%'}
                      </td>
                      <td className="px-6 py-3 text-right">
                        <button
                          onClick={() => kurzusLe(k.course_id)} disabled={busy}
                          title="Levétel a kurzusról"
                          className="text-slate-400 hover:text-red-600 transition-colors disabled:opacity-40">
                          <Lucide.Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
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

        {['SUPERADMIN','ADMIN'].includes(user.role) && (
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

  const tolts = () => {
    setTolt(true);
    TCH_api.list(q, allapot, org)
      .then(r => { setSor(Array.isArray(r) ? r : []); setErr(''); })
      .catch(e => { setSor([]); setErr(TCH_msg(e)); })
      .finally(() => setTolt(false));
  };

  useEffect(() => {
    const t = setTimeout(tolts, 250);
    return () => clearTimeout(t);
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

      {/* a kiválasztott oktató lapja */}
      {valasztott && (
        <TCH_Detail id={valasztott} user={user}
          onChanged={tolts}
          onDeleted={() => { setValasztott(null); tolts(); }} />
      )}

      <TCH_Form open={ujForm} oktato={null} onClose={() => setUjForm(false)}
        onSaved={(r) => { tolts(); setValasztott(r && r.id); }} />
    </div>
  );
}
