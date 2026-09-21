/* ============================================================
   UniPortal — Ügynökségi portál (II/3 csomag)
   A 29_agency.sql migráció felülete.

   Ez a fájl az app.jsx moduljába fűződik a FEATURES-jelölőnél,
   tehát React, a hookok, az ICONS, a `sb`, a `uid` és a DOC_* segédek
   már hatókörben vannak — IMPORT NINCS.

   Amit lefed:
     1./7. tétel — ügynökségi regisztráció elfogadása/elutasítása, és
                   az önregisztrált ügynökségek megjelenése
     3. tétel    — számlázási folyamat a kifizetés-igénylés helyett
     4. tétel    — jutalék CSAK a beiratkozás lezárása után, ADMIN küldi
     5. tétel    — dokumentum (szerződés, meghatalmazás) az ügynökséghez
     6. tétel    — country of origin + countries of recruitment
   ============================================================ */

/* ---------- 1. Hibaüzenetek magyarul --------------------------------------
   A szerver magyar szövegeket dob (raise exception), de a PostgREST
   rétegben ezek néha kódra szűkülnek. Egy helyen fordítjuk. */
const AGENCY_PGERR = {
  '42501': 'Ehhez a művelethez nincs jogosultsága.',
  'PGRST301': 'A munkamenet lejárt. Jelentkezzen be újra.',
  '23503': 'A hivatkozott sor nem létezik (ügynökség vagy időszak).',
  '23505': 'Ez a tétel már létezik.',
  '42P01': 'A modul táblái hiányoznak — a 29_agency.sql migráció még nem futott le.',
  '42883': 'A modul függvényei hiányoznak — a 29_agency.sql migráció még nem futott le.',
  // A PostgREST NEM a postgres hibakódját adja vissza, ha a tábla/függvény
  // nincs a séma-gyorsítótárban, hanem sajátot — mérve a böngészőben, ahol
  // "Could not find the table 'public.agency_invoice' in the schema cache"
  // szivárgott ki angolul a felületre.
  'PGRST205': 'A modul táblái hiányoznak — a 29_agency.sql migráció még nem futott le.',
  'PGRST202': 'A modul függvényei hiányoznak — a 29_agency.sql migráció még nem futott le.',
};

// Ugyanaz a helyzet, ha csak a szöveg jön vissza kód nélkül.
const AGENCY_MISSING_RE = /Could not find the (table|function)|schema cache|does not exist/i;

function AGENCY_msg(e) {
  if (!e) return 'Ismeretlen hiba.';
  const raw = String(e.message || e.details || e.hint || e);
  const code = e.code || (e.error && e.error.code);
  // A szerver saját magyar mondata a legjobb üzenet — ha van, azt adjuk.
  if (/[őűáéíóöúüÁÉÍÓÖŐÚÜŰ]/.test(raw) && raw.length > 12) return raw;
  if (code && AGENCY_PGERR[code]) return AGENCY_PGERR[code];
  for (const k in AGENCY_PGERR) { if (raw.indexOf(k) >= 0) return AGENCY_PGERR[k]; }
  if (AGENCY_MISSING_RE.test(raw)) {
    return 'A modul még nem érhető el — a 29_agency.sql migráció nem futott le az adatbázison.';
  }
  if (/Failed to fetch|NetworkError|network/i.test(raw)) {
    return 'Nincs kapcsolat a kiszolgálóval.';
  }
  return raw || 'Ismeretlen hiba.';
}

/* ---------- 2. AGENCY_rpc — a 7 publikus RPC egyetlen kapuja -------------
   Az agency_module_rollback() SZÁNDÉKOSAN nincs itt: amit nem lehet
   leírni a felületről, azt nem lehet véletlenül elsütni sem. */
async function AGENCY_rpc(name, args) {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  let res;
  try {
    res = await window.sb.rpc(name, args || {});
  } catch (e) {
    throw new Error(AGENCY_msg(e));
  }
  if (res && res.error) throw new Error(AGENCY_msg(res.error));
  return res ? res.data : null;
}

async function AGENCY_select(table, opts) {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  const o = opts || {};
  let qb = window.sb.from(table).select(o.columns || '*');
  if (o.eq) { for (const k in o.eq) { if (o.eq[k] != null) qb = qb.eq(k, o.eq[k]); } }
  if (o.order) qb = qb.order(o.order, { ascending: o.ascending !== false });
  const { data, error } = await qb;
  if (error) throw new Error(AGENCY_msg(error));
  return data || [];
}

const AGENCY_api = {
  // 1./7. tétel
  decide:        (id, decision, reason, rate) =>
                   AGENCY_rpc('agency_decide', {
                     p_agency: id, p_decision: decision,
                     p_reason: reason || null,
                     p_rate: (rate === '' || rate == null) ? null : Number(rate),
                   }),
  // 4. tétel — a beiratkozás ténye és az időszak
  setEnrolled:   (studentId, on) =>
                   AGENCY_rpc('student_set_enrolled', { p_student: studentId, p_on: on || null }),
  periodState:   (periodId, state) =>
                   AGENCY_rpc('agency_period_set_state', { p_period: periodId, p_state: state }),
  preview:       (periodId, agencyId) =>
                   AGENCY_rpc('agency_commission_preview', {
                     p_period: periodId, p_agency: agencyId || null,
                   }),
  issue:         (periodId, agencyId, dueOn, note) =>
                   AGENCY_rpc('agency_commission_issue', {
                     p_period: periodId, p_agency: agencyId,
                     p_due_on: dueOn || null, p_note: note || null,
                   }),
  // 3. tétel — számla
  invoiceAttach: (o) =>
                   AGENCY_rpc('agency_invoice_attach', {
                     p_invoice: o.invoiceId, p_number: o.number,
                     p_issued_on: o.issuedOn || null, p_path: o.path,
                     p_title: o.title || null, p_file_name: o.fileName || null,
                     p_file_size: o.fileSize || null, p_note: o.note || null,
                   }),
  invoiceDecide: (invoiceId, decision, reason) =>
                   AGENCY_rpc('agency_invoice_decide', {
                     p_invoice: invoiceId, p_decision: decision, p_reason: reason || null,
                   }),
  // Táblák
  periods:       ()   => AGENCY_select('agency_commission_period', { order: 'opens_on', ascending: false }),
  invoices:      (ag) => AGENCY_select('agency_invoice', { eq: { agency_id: ag || null }, order: 'requested_at', ascending: false }),
  invoiceItems:  (invoiceId) => AGENCY_select('agency_commission_item', { eq: { invoice_id: invoiceId }, order: 'student_name' }),
  documents:     (ag) => AGENCY_select('agency_document', { eq: { agency_id: ag || null }, order: 'uploaded_at', ascending: false }),
  addDocument:   async (row) => {
                   const { data, error } = await window.sb.from('agency_document').insert(row).select().single();
                   if (error) throw new Error(AGENCY_msg(error));
                   return data;
                 },
  delDocument:   async (id) => {
                   const { error } = await window.sb.from('agency_document').delete().eq('id', id);
                   if (error) throw new Error(AGENCY_msg(error));
                 },
};

/* ---------- 3. Feltöltés a MEGLÉVŐ documents bucketbe --------------------
   Az útvonal-konvenció a 08-as migráció policy-jei miatt KÖTÖTT:
     <auth.uid()>/agency/<agencyId>/<fájl>
   Az első mappaszint a feltöltő felhasználó azonosítója — enélkül a
   storage insert policy visszautasítja. */
async function AGENCY_upload(file, ownerId, agencyId) {
  if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
  if (!ownerId) throw new Error('Ismeretlen feltöltő — jelentkezzen be újra.');
  if (!agencyId) throw new Error('Nincs ügynökség kiválasztva.');
  if (file.size > 20 * 1024 * 1024) throw new Error('A fájl nagyobb 20 MB-nál.');
  const safe = (typeof DOC_safeName === 'function')
    ? DOC_safeName(file.name)
    : String(file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const path = [ownerId, 'agency', agencyId,
    Date.now().toString(36) + '-' + safe].join('/');
  const { error } = await window.sb.storage.from('documents').upload(path, file, {
    upsert: true, contentType: FELT_dokumentumTipus(file),
  });
  if (error) throw new Error(AGENCY_msg(error));
  return path;
}

async function AGENCY_signedUrl(path) {
  if (!path || !window.sb) return '';
  const { data, error } = await window.sb.storage.from('documents').createSignedUrl(path, 3600);
  if (error || !data) return '';
  return data.signedUrl;
}

/* ---------- 4. Apró közös darabok ---------------------------------------- */
const AGENCY_DOC_KINDS = [
  { id: 'contract',          label: 'Szerződés' },
  { id: 'power_of_attorney', label: 'Meghatalmazás' },
  { id: 'certificate',       label: 'Cégkivonat / igazolás' },
  { id: 'invoice',           label: 'Számla' },
  { id: 'other',             label: 'Egyéb' },
];

const AGENCY_INVOICE_LABEL = {
  requested: 'Számla igényelve',
  submitted: 'Számla beérkezett',
  approved:  'Elfogadva',
  rejected:  'Visszaküldve',
  paid:      'Kifizetve',
};
const AGENCY_INVOICE_CLASS = {
  requested: 'bg-amber-50 text-amber-700 border-amber-200',
  submitted: 'bg-sky-50 text-sky-700 border-sky-200',
  approved:  'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected:  'bg-rose-50 text-rose-700 border-rose-200',
  paid:      'bg-slate-900 text-white border-slate-900',
};

const AGENCY_APPROVAL_LABEL = {
  pending:  'Elbírálásra vár',
  approved: 'Jóváhagyva',
  rejected: 'Elutasítva',
};
const AGENCY_APPROVAL_CLASS = {
  pending:  'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
};

const AGENCY_eur = (n) => '€' + Number(n || 0).toLocaleString('hu-HU', { maximumFractionDigits: 2 });
const AGENCY_day = (d) => (d ? String(d).slice(0, 10).replace(/-/g, '.') : '—');
const AGENCY_kb = (b) => (b ? (b / 1024 > 1024 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' kB') : '');

// Az ügynökség adatlapján a toborzási országok tömbként jönnek; a szerkesztés
// vesszős listával a legkényelmesebb, ezért oda-vissza fordítjuk.
const AGENCY_arr2str = (a) => (Array.isArray(a) ? a.join(', ') : (a || ''));
const AGENCY_str2arr = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

/* Egységes állapotcímke. */
const AGENCY_Badge = ({ text, cls }) => (
  <span className={'inline-flex items-center px-2 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wide ' + (cls || 'bg-slate-50 text-slate-600 border-slate-200')}>
    {text}
  </span>
);

/* Hibasáv — a szerver mondatát mutatja, nem nyeli el. */
const AGENCY_Error = ({ text, onClose }) => (!text ? null : (
  <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
    <ICONS.AlertTriangle size={18} className="shrink-0 mt-0.5" />
    <p className="flex-1 leading-relaxed">{text}</p>
    {onClose && (
      <button onClick={onClose} className="text-rose-400 hover:text-rose-700" aria-label="Bezárás">
        <ICONS.X size={16} />
      </button>
    )}
  </div>
));

const AGENCY_Empty = ({ icon, title, hint }) => (
  <div className="flex flex-col items-center justify-center py-14 text-center">
    <div className="w-14 h-14 rounded-2xl bg-slate-50 text-slate-300 flex items-center justify-center mb-4">
      {icon || <ICONS.Inbox size={26} />}
    </div>
    <p className="font-bold text-slate-600">{title}</p>
    {hint && <p className="text-xs text-slate-400 mt-1 max-w-[46ch] leading-relaxed">{hint}</p>}
  </div>
);

/* ============================================================
   5. ÜGYNÖKSÉGI REGISZTRÁCIÓK — 1. és 7. tétel
   ------------------------------------------------------------
   A tesztelők panasza: "az önregisztrált ügynökségek eltűnnek".
   Eltűntek, mert az önregisztráció csak felhasználói fiókot hozott
   létre, ügynökség-sort nem. A 29-es migráció 6. szakasza ezt
   megjavította; itt jelenik meg a döntés felülete.

   A döntést az agency_decide() RPC hozza — az admin-ellenőrzés,
   az indoklás kényszere és a napló SZERVEROLDALON van, a felület
   csak felkínálja.
   ============================================================ */
const AgencyRegistrations = ({ user, agencies, onChanged }) => {
  const [filter, setFilter]   = useState('pending');
  const [busyId, setBusyId]   = useState('');
  const [error, setError]     = useState('');
  const [openId, setOpenId]   = useState('');
  const [reason, setReason]   = useState('');
  const [rate, setRate]       = useState('');

  /* Az ügynökségi regisztráció elbírálása az `agent_portal` modul USE joga.
     A `regi` paraméter a MAI lista: ha a 72-es migráció nem futott le, az dönt. */
  const canDecide = PERM_can(user, 'agent_portal', 'USE',
    ['SUPERADMIN', 'ADMIN'].indexOf(user.role) >= 0);

  const rows = (agencies || []).filter(a => {
    const st = a.approval_status || 'approved';
    return filter === 'all' ? true : st === filter;
  });
  const countOf = (st) => (agencies || []).filter(a => (a.approval_status || 'approved') === st).length;

  const decide = async (agency, decision) => {
    if (decision === 'rejected' && !reason.trim()) {
      setError('Az elutasításhoz indoklás kell.');
      return;
    }
    setBusyId(agency.id); setError('');
    try {
      await AGENCY_api.decide(agency.id, decision, reason.trim(), decision === 'approved' ? rate : null);
      setOpenId(''); setReason(''); setRate('');
      if (onChanged) await onChanged();
    } catch (e) {
      setError(e.message || 'A döntés nem sikerült.');
    } finally {
      setBusyId('');
    }
  };

  if (!canDecide) {
    return (
      <AGENCY_Empty
        icon={<ICONS.Lock size={26} />}
        title="Ehhez a nézethez nincs jogosultsága"
        hint="Ügynökségi regisztrációról SUPERADMIN vagy ADMIN dönthet."
      />
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-slate-800">Ügynökségi regisztrációk</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-[70ch] leading-relaxed">
            Az önregisztrált ügynökségek itt jelennek meg, elbírálásra várva. A jóváhagyás
            a hozzá tartozó ügynöki fiókot is aktiválja, az elutasítás pedig indoklással
            és naplózva történik.
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-white border border-slate-100 rounded-2xl shadow-sm">
          {[
            { id: 'pending',  label: 'Elbírálásra vár' },
            { id: 'approved', label: 'Jóváhagyva' },
            { id: 'rejected', label: 'Elutasítva' },
            { id: 'all',      label: 'Mind' },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setFilter(t.id)}
              className={'px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ' +
                (filter === t.id ? 'bg-slate-900 text-white shadow-md' : 'text-slate-500 hover:text-slate-800')}
            >
              {t.label}
              {t.id !== 'all' && <span className="ml-1.5 opacity-60">{countOf(t.id)}</span>}
            </button>
          ))}
        </div>
      </div>

      <AGENCY_Error text={error} onClose={() => setError('')} />

      {rows.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm">
          <AGENCY_Empty
            icon={<ICONS.Briefcase size={26} />}
            title="Nincs ilyen állapotú ügynökség"
            hint="Az önregisztrált ügynökségek automatikusan „elbírálásra vár” állapotban érkeznek ide."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 sm:gap-6">
          {rows.map(a => {
            const st = a.approval_status || 'approved';
            const open = openId === a.id;
            return (
              <div key={a.id} className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
                <div className="p-6">
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold shrink-0">
                        {(a.name || '?').charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-slate-800 truncate">{a.name}</p>
                        <p className="text-xs text-slate-400 truncate">{a.email || '—'}</p>
                      </div>
                    </div>
                    <AGENCY_Badge text={AGENCY_APPROVAL_LABEL[st] || st} cls={AGENCY_APPROVAL_CLASS[st]} />
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                    <div>
                      <dt className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Kapcsolattartó</dt>
                      <dd className="font-semibold text-slate-700 mt-0.5">{a.contactPerson || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Jutalék kulcs</dt>
                      <dd className="font-semibold text-slate-700 mt-0.5">{a.commissionRate || 0}%</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Származási ország</dt>
                      <dd className="font-semibold text-slate-700 mt-0.5">{a.country_of_origin || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Jelentkezés ideje</dt>
                      <dd className="font-semibold text-slate-700 mt-0.5">{AGENCY_day(a.requested_at)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Toborzási országok</dt>
                      <dd className="mt-1 flex flex-wrap gap-1.5">
                        {(a.countries_of_recruitment || []).length === 0
                          ? <span className="text-slate-300 italic">nincs megadva</span>
                          : (a.countries_of_recruitment || []).map(c => (
                              <span key={c} className="px-2 py-0.5 rounded-lg bg-slate-50 border border-slate-100 text-[11px] font-semibold text-slate-600">{c}</span>
                            ))}
                      </dd>
                    </div>
                  </dl>

                  {a.self_registered && (
                    <p className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-bold text-sky-700 bg-sky-50 border border-sky-100 rounded-lg px-2 py-1">
                      <ICONS.Globe size={12} /> Önregisztráció
                    </p>
                  )}
                  {st === 'rejected' && a.rejected_reason && (
                    <p className="mt-4 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 leading-relaxed">
                      <span className="font-bold">Elutasítva:</span> {a.rejected_reason}
                    </p>
                  )}
                  {a.decided_at && (
                    <p className="mt-3 text-[11px] text-slate-400">
                      Döntés: {AGENCY_day(a.decided_at)} · {a.decided_by || '—'}
                    </p>
                  )}
                </div>

                {st === 'pending' && (
                  <div className="border-t border-slate-50 bg-slate-50/60 p-5">
                    {!open ? (
                      <button
                        onClick={() => { setOpenId(a.id); setReason(''); setRate(String(a.commissionRate || 0)); setError(''); }}
                        className="w-full py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 transition-colors"
                      >
                        Döntés meghozatala
                      </button>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">
                            Jutalék kulcs (%) — jóváhagyáskor
                          </label>
                          <input
                            type="number" min="0" max="100" value={rate}
                            onChange={e => setRate(e.target.value)}
                            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">
                            Indoklás — elutasításhoz kötelező
                          </label>
                          <textarea
                            rows={2} value={reason}
                            onChange={e => setReason(e.target.value)}
                            placeholder="Miért utasítja el?"
                            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                          />
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <button
                            disabled={busyId === a.id}
                            onClick={() => decide(a, 'approved')}
                            className="flex-1 min-w-[8rem] py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-2"
                          >
                            <ICONS.CheckCircle size={16} /> Elfogadás
                          </button>
                          <button
                            disabled={busyId === a.id}
                            onClick={() => decide(a, 'rejected')}
                            className="flex-1 min-w-[8rem] py-2.5 rounded-xl bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-2"
                          >
                            <ICONS.XCircle size={16} /> Elutasítás
                          </button>
                          <button
                            onClick={() => { setOpenId(''); setError(''); }}
                            className="px-4 py-2.5 rounded-xl text-slate-500 text-sm font-bold hover:bg-white transition-colors"
                          >
                            Mégse
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ============================================================
   6. SZÁMLÁZÁS ÉS JUTALÉK — 3. és 4. tétel
   ------------------------------------------------------------
   Ami megváltozott a tesztelői visszajelzés nyomán:

   - A régi "Kifizetés igénylése" gomb ELTŰNT. Helyette számlázási
     folyamat van: az ADMIN kér számlát, az ÜGYNÖKSÉG csatolja,
     a pénzügy elfogadja vagy visszaküldi.
   - A jutalékot NEM az ügynök igényli, hanem az admin küldi ki, és
     CSAK LEZÁRT beiratkozási időszakra. Év közben az RPC elbukik —
     ezt itt a felület is előre jelzi, de a döntés a szerveré.
   - A lista a TÉNYLEGESEN BEIRATKOZOTT hallgatókból áll (enrolled_at),
     nem a felvett vagy fizetett jelentkezőkből.
   ============================================================ */
const AgencyBilling = ({ user, agencies, myAgencyId, onChanged }) => {
  /* isAgent / isFinance: „KI VAGYOK" — melyik PERSPEKTÍVÁT kapja a képernyő
     (ügynöki vagy pénzügyi nézet). Ezek SZÁNDÉKOSAN maradnak szerepkör-
     ellenőrzések: nem azt döntik el, hogy szabad-e, hanem hogy mit lát.
     isAdmin: „MIT TEHETEK" — a periódus zárása és a számlaigénylés kiküldése
     írás, tehát az `agent_portal` modul EDIT joga dönti el. */
  const isAgent   = user.role === 'AGENT';
  const isAdmin   = PERM_can(user, 'agent_portal', 'EDIT',
    ['SUPERADMIN', 'ADMIN'].indexOf(user.role) >= 0);
  const isFinance = user.role === 'FINANCE';

  const [periods, setPeriods]   = useState([]);
  const [periodId, setPeriodId] = useState('');
  const [agencyId, setAgencyId] = useState(myAgencyId || '');
  const [preview, setPreview]   = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [items, setItems]       = useState({});     // invoiceId -> tételek
  const [openInv, setOpenInv]   = useState('');
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState('');
  const [error, setError]       = useState('');
  const [notice, setNotice]     = useState('');

  const period = periods.find(p => p.id === periodId) || null;
  const periodClosed = !!(period && period.state === 'closed');

  const reload = async () => {
    setError('');
    try {
      const [ps, inv] = await Promise.all([
        AGENCY_api.periods(),
        AGENCY_api.invoices(isAgent ? (myAgencyId || '') : null),
      ]);
      setPeriods(ps);
      setInvoices(inv);
      if (!periodId && ps.length) setPeriodId(ps[0].id);
    } catch (e) {
      setError(e.message || 'A számlázási adatok betöltése nem sikerült.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  // Az előnézet az időszaktól és az ügynökségtől függ. Az RLS/RPC úgyis
  // csak azt adja vissza, amit a bejelentkezett szerep láthat.
  useEffect(() => {
    if (!periodId) { setPreview([]); return; }
    let live = true;
    (async () => {
      try {
        const rows = await AGENCY_api.preview(periodId, isAgent ? myAgencyId : (agencyId || null));
        if (live) setPreview(rows || []);
      } catch (e) {
        if (live) { setPreview([]); setError(e.message || 'Az előnézet nem tölthető be.'); }
      }
    })();
    return () => { live = false; };
  }, [periodId, agencyId, isAgent, myAgencyId]);

  const togglePeriod = async () => {
    if (!period) return;
    setBusy('period'); setError(''); setNotice('');
    try {
      await AGENCY_api.periodState(period.id, period.state === 'closed' ? 'open' : 'closed');
      await reload();
      setNotice(period.state === 'closed'
        ? 'A beiratkozási időszak újra nyitva. Jutalék innentől nem küldhető ki.'
        : 'A beiratkozási időszak lezárva. A jutalék innentől kiküldhető.');
    } catch (e) {
      setError(e.message || 'Az időszak állapota nem változott.');
    } finally { setBusy(''); }
  };

  const issue = async (targetAgency) => {
    setBusy('issue'); setError(''); setNotice('');
    try {
      const inv = await AGENCY_api.issue(periodId, targetAgency, null, null);
      await reload();
      setNotice('Számlaigénylés kiküldve: ' + AGENCY_eur(inv && inv.amount) +
                ' · ' + ((inv && inv.student_count) || 0) + ' beiratkozott hallgató.');
      if (onChanged) await onChanged();
    } catch (e) {
      setError(e.message || 'A jutalék kiküldése nem sikerült.');
    } finally { setBusy(''); }
  };

  const decideInvoice = async (inv, decision, reason) => {
    setBusy(inv.id); setError(''); setNotice('');
    try {
      await AGENCY_api.invoiceDecide(inv.id, decision, reason);
      await reload();
    } catch (e) {
      setError(e.message || 'A döntés nem sikerült.');
    } finally { setBusy(''); }
  };

  const loadItems = async (invId) => {
    if (openInv === invId) { setOpenInv(''); return; }
    setOpenInv(invId);
    if (items[invId]) return;
    try {
      const rows = await AGENCY_api.invoiceItems(invId);
      setItems(prev => ({ ...prev, [invId]: rows }));
    } catch (e) {
      setError(e.message || 'A jutaléktételek nem tölthetők be.');
    }
  };

  const previewTotal = preview.reduce((a, r) => a + Number(r.amount || 0), 0);
  const previewOpen  = preview.filter(r => !r.already_invoiced);
  const openTotal    = previewOpen.reduce((a, r) => a + Number(r.amount || 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <ICONS.RefreshCw size={22} className="animate-spin mr-3" /> Betöltés…
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <AGENCY_Error text={error} onClose={() => setError('')} />
      {notice && (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <ICONS.CheckCircle size={18} className="shrink-0 mt-0.5" />
          <p className="flex-1 leading-relaxed">{notice}</p>
          <button onClick={() => setNotice('')} className="text-emerald-400 hover:text-emerald-700" aria-label="Bezárás">
            <ICONS.X size={16} />
          </button>
        </div>
      )}

      {/* --- Beiratkozási időszak (4. tétel kapuja) --- */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-[16rem]">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
              Beiratkozási időszak
            </label>
            <select
              value={periodId}
              onChange={e => setPeriodId(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              {periods.length === 0 && <option value="">Nincs időszak</option>}
              {periods.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label} ({AGENCY_day(p.opens_on)}–{AGENCY_day(p.closes_on)})
                </option>
              ))}
            </select>
          </div>

          {!isAgent && (
            <div className="min-w-[16rem]">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
                Ügynökség
              </label>
              <select
                value={agencyId}
                onChange={e => setAgencyId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="">Minden ügynökség</option>
                {(agencies || []).filter(a => (a.approval_status || 'approved') === 'approved').map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-3">
            <AGENCY_Badge
              text={periodClosed ? 'Beiratkozás lezárva' : 'Beiratkozás nyitva'}
              cls={periodClosed
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-amber-50 text-amber-700 border-amber-200'}
            />
            {isAdmin && period && (
              <button
                disabled={busy === 'period'}
                onClick={togglePeriod}
                className="px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {periodClosed ? 'Időszak újranyitása' : 'Beiratkozás lezárása'}
              </button>
            )}
          </div>
        </div>

        {!periodClosed && (
          <p className="mt-4 flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 leading-relaxed">
            <ICONS.Info size={15} className="shrink-0 mt-0.5" />
            <span>
              Év közben jutalék nem igényelhető. A számlaigénylés csak azután küldhető ki,
              hogy az admin lezárta a beiratkozási időszakot — ezt a szerver is kikényszeríti.
            </span>
          </p>
        )}
      </div>

      {/* --- Elszámolható hallgatók (a beiratkozás TÉNYE alapján) --- */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-50 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-bold text-slate-800 text-lg">Elszámolható beiratkozott hallgatók</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-[70ch] leading-relaxed">
              Csak azok a hallgatók szerepelnek, akiknél az ügyintéző rögzítette a beiratkozás
              tényét, a felvételi állapotuk „Felvéve”, és a beiratkozás dátuma az időszakba esik.
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Még nem számlázott</p>
            <p className="text-2xl font-bold text-slate-800">{AGENCY_eur(openTotal)}</p>
            <p className="text-[11px] text-slate-400">{previewOpen.length} hallgató · összesen {AGENCY_eur(previewTotal)}</p>
          </div>
        </div>

        {preview.length === 0 ? (
          <AGENCY_Empty
            icon={<ICONS.Users size={26} />}
            title="Nincs elszámolható beiratkozott hallgató"
            hint="A jutalék alapja a beiratkozás ténye. Amíg az ügyintéző nem rögzíti, a hallgató nem jelenik meg itt."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50 text-slate-400 text-[10px] font-bold uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-4">Hallgató</th>
                  {!isAgent && <th className="px-6 py-4">Ügynökség</th>}
                  <th className="px-6 py-4">Szak</th>
                  <th className="px-6 py-4">Beiratkozott</th>
                  <th className="px-6 py-4">Tandíj</th>
                  <th className="px-6 py-4">Kulcs</th>
                  <th className="px-6 py-4">Jutalék</th>
                  <th className="px-6 py-4 text-right">Állapot</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {preview.map(r => (
                  <tr key={r.agency_id + '/' + r.student_id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-semibold text-slate-800">{r.student_name}</td>
                    {!isAgent && <td className="px-6 py-4 text-xs text-slate-600">{r.agency_name}</td>}
                    <td className="px-6 py-4 text-xs text-slate-500">{r.program || '—'}</td>
                    <td className="px-6 py-4 text-xs text-slate-500">{AGENCY_day(r.enrolled_on)}</td>
                    <td className="px-6 py-4 text-slate-600">{AGENCY_eur(r.tuition_fee)}</td>
                    <td className="px-6 py-4 text-slate-600">{Number(r.rate || 0)}%</td>
                    <td className="px-6 py-4 font-bold text-slate-800">{AGENCY_eur(r.amount)}</td>
                    <td className="px-6 py-4 text-right">
                      {r.already_invoiced
                        ? <AGENCY_Badge text="Számlázva" cls="bg-slate-100 text-slate-500 border-slate-200" />
                        : <AGENCY_Badge text="Elszámolható" cls="bg-emerald-50 text-emerald-700 border-emerald-200" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* A KIKÜLDÉS ADMIN művelet — az ügynök felületén meg sem jelenik. */}
        {isAdmin && (
          <div className="border-t border-slate-50 bg-slate-50/60 p-6">
            {!agencyId ? (
              <p className="text-xs text-slate-500">
                A számlaigénylés kiküldéséhez válasszon egy konkrét ügynökséget.
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className="text-xs text-slate-500 max-w-[60ch] leading-relaxed">
                  A kiküldés pillanatképet készít a tandíjból és a jutalékkulcsból, majd
                  felszólítja az ügynökséget a saját számlája csatolására.
                </p>
                <button
                  disabled={busy === 'issue' || !periodClosed || previewOpen.length === 0}
                  onClick={() => issue(agencyId)}
                  className="px-6 py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
                  title={!periodClosed ? 'Előbb le kell zárni a beiratkozási időszakot.' : ''}
                >
                  <ICONS.Send size={16} /> Számla igénylése az ügynökségtől
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* --- Számlák (3. tétel) --- */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-50">
          <h3 className="font-bold text-slate-800 text-lg">Számlázási folyamat</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-[80ch] leading-relaxed">
            Az admin számlát kér · az ügynökség csatolja a saját számláját · a pénzügy elfogadja,
            visszaküldi vagy kifizetettre állítja. Kifizetést igényelni nem lehet.
          </p>
        </div>

        {invoices.length === 0 ? (
          <AGENCY_Empty
            icon={<ICONS.FileText size={26} />}
            title="Nincs számlaigénylés"
            hint="A folyamat az admin oldaláról indul, a beiratkozási időszak lezárása után."
          />
        ) : (
          <div className="divide-y divide-slate-50">
            {invoices.map(inv => (
              <AgencyInvoiceRow
                key={inv.id}
                inv={inv}
                agency={(agencies || []).find(a => a.id === inv.agency_id)}
                period={periods.find(p => p.id === inv.period_id)}
                user={user}
                items={items[inv.id]}
                open={openInv === inv.id}
                busy={busy === inv.id}
                onToggle={() => loadItems(inv.id)}
                onDecide={decideInvoice}
                onAttached={reload}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------- Egy számlasor: állapot, tételek, csatolás, döntés ------------- */
const AgencyInvoiceRow = ({ inv, agency, period, user, items, open, busy, onToggle, onDecide, onAttached }) => {
  const isAgent   = user.role === 'AGENT';
  /* A partnerszámla elbírálása: az `agent_portal` modul USE joga. A mai lista a
     FINANCE-t is tartalmazza — a 72-es backfill ezt megtartotta, mert a FINANCE
     role_permission sorai között ott van az agent_portal. */
  const canDecide = PERM_can(user, 'agent_portal', 'USE',
    ['SUPERADMIN', 'ADMIN', 'FINANCE'].indexOf(user.role) >= 0);
  const canAttach = isAgent && ['requested', 'rejected', 'submitted'].indexOf(inv.status) >= 0;

  const [form, setForm]     = useState({ number: '', issuedOn: '', note: '' });
  const [file, setFile]     = useState(null);
  const [attaching, setAtt] = useState(false);
  const [err, setErr]       = useState('');
  const [reason, setReason] = useState('');
  const [showAtt, setShow]  = useState(false);
  const [showRej, setRej]   = useState(false);

  const attach = async () => {
    if (!form.number.trim()) { setErr('A számlaszám kötelező.'); return; }
    if (!file)               { setErr('Töltse fel a számla fájlját.'); return; }
    setAtt(true); setErr('');
    try {
      const path = await AGENCY_upload(file, user.id, inv.agency_id);
      await AGENCY_api.invoiceAttach({
        invoiceId: inv.id,
        number: form.number.trim(),
        issuedOn: form.issuedOn || null,
        path,
        title: 'Számla ' + form.number.trim(),
        fileName: file.name,
        fileSize: file.size,
        note: form.note.trim() || null,
      });
      setShow(false); setFile(null); setForm({ number: '', issuedOn: '', note: '' });
      if (onAttached) await onAttached();
    } catch (e) {
      setErr(e.message || 'A számla csatolása nem sikerült.');
    } finally { setAtt(false); }
  };

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-bold text-slate-800">{agency ? agency.name : inv.agency_id}</p>
            <AGENCY_Badge text={AGENCY_INVOICE_LABEL[inv.status] || inv.status} cls={AGENCY_INVOICE_CLASS[inv.status]} />
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {period ? period.label : (inv.period_id || '—')} · {inv.student_count} hallgató ·
            igényelve {AGENCY_day(inv.requested_at)}
            {inv.due_on ? ' · határidő ' + AGENCY_day(inv.due_on) : ''}
          </p>
          {inv.invoice_number && (
            <p className="text-xs text-slate-500 mt-1">
              Számlaszám: <span className="font-semibold text-slate-700">{inv.invoice_number}</span>
              {inv.issued_on ? ' · kelt ' + AGENCY_day(inv.issued_on) : ''}
            </p>
          )}
          {inv.status === 'rejected' && inv.reject_reason && (
            <p className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 leading-relaxed max-w-[70ch]">
              <span className="font-bold">Visszaküldve:</span> {inv.reject_reason}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-slate-800">{AGENCY_eur(inv.amount)}</p>
          <button onClick={onToggle} className="text-indigo-600 text-xs font-bold hover:underline mt-1">
            {open ? 'Tételek elrejtése' : 'Tételek megtekintése'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 rounded-2xl border border-slate-100 overflow-hidden">
          {!items ? (
            <p className="px-4 py-3 text-xs text-slate-400">Betöltés…</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-xs text-slate-400">Nincs tétel.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-400 text-[10px] font-bold uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Hallgató</th>
                    <th className="px-4 py-3">Szak</th>
                    <th className="px-4 py-3">Beiratkozott</th>
                    <th className="px-4 py-3">Tandíj</th>
                    <th className="px-4 py-3">Kulcs</th>
                    <th className="px-4 py-3 text-right">Jutalék</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {items.map(it => (
                    <tr key={it.id}>
                      <td className="px-4 py-3 font-semibold text-slate-700">{it.student_name}</td>
                      <td className="px-4 py-3 text-slate-500">{it.program || '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{AGENCY_day(it.enrolled_on)}</td>
                      <td className="px-4 py-3 text-slate-600">{AGENCY_eur(it.tuition_fee)}</td>
                      <td className="px-4 py-3 text-slate-600">{Number(it.rate || 0)}%</td>
                      <td className="px-4 py-3 text-right font-bold text-slate-800">{AGENCY_eur(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <AGENCY_Error text={err} onClose={() => setErr('')} />

      {/* Az ÜGYNÖKSÉG csatolja a saját számláját. */}
      {canAttach && (
        <div className="mt-4">
          {!showAtt ? (
            <button
              onClick={() => { setShow(true); setErr(''); }}
              className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition-colors inline-flex items-center gap-2"
            >
              <ICONS.Upload size={16} />
              {inv.status === 'submitted' ? 'Számla cseréje' : 'Számla csatolása'}
            </button>
          ) : (
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
                    Számlaszám
                  </label>
                  <input
                    type="text" value={form.number}
                    onChange={e => setForm({ ...form, number: e.target.value })}
                    placeholder="Pl. 2024/GS-0042"
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
                    Számla kelte
                  </label>
                  <input
                    type="date" value={form.issuedOn}
                    onChange={e => setForm({ ...form, issuedOn: e.target.value })}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
                  Számla fájlja (PDF, max. 20 MB)
                </label>
                <input
                  type="file" accept="application/pdf,image/*"
                  onChange={e => setFile(e.target.files && e.target.files[0])}
                  className="w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-slate-900 file:text-white hover:file:bg-slate-800"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
                  Megjegyzés
                </label>
                <textarea
                  rows={2} value={form.note}
                  onChange={e => setForm({ ...form, note: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setShow(false); setErr(''); }}
                  className="px-4 py-2.5 text-slate-500 text-sm font-bold hover:bg-white rounded-xl transition-colors"
                >
                  Mégse
                </button>
                <button
                  disabled={attaching}
                  onClick={attach}
                  className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {attaching ? 'Feltöltés…' : 'Számla beküldése'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* A PÉNZÜGY / ADMIN dönt a beérkezett számláról. */}
      {canDecide && inv.status === 'submitted' && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            disabled={busy}
            onClick={() => onDecide(inv, 'approved')}
            className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            <ICONS.CheckCircle size={16} /> Számla elfogadása
          </button>
          <button
            disabled={busy}
            onClick={() => setRej(!showRej)}
            className="px-5 py-2.5 rounded-xl bg-white border border-rose-200 text-rose-700 text-sm font-bold hover:bg-rose-50 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            <ICONS.XCircle size={16} /> Visszaküldés
          </button>
          {inv.document_id && (
            <AgencyDocLink documentId={inv.document_id} label="Beküldött számla megnyitása" />
          )}
        </div>
      )}

      {canDecide && showRej && inv.status === 'submitted' && (
        <div className="mt-3 rounded-2xl border border-rose-100 bg-rose-50/60 p-4 space-y-3">
          <textarea
            rows={2} value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Miért küldi vissza? (kötelező)"
            className="w-full bg-white border border-rose-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500/20"
          />
          <div className="flex justify-end">
            <button
              disabled={busy || !reason.trim()}
              onClick={() => { onDecide(inv, 'rejected', reason.trim()); setRej(false); setReason(''); }}
              className="px-5 py-2.5 rounded-xl bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-40 transition-colors"
            >
              Visszaküldés indoklással
            </button>
          </div>
        </div>
      )}

      {canDecide && inv.status === 'approved' && (
        <div className="mt-4">
          <button
            disabled={busy}
            onClick={() => onDecide(inv, 'paid')}
            className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            <ICONS.Wallet size={16} /> Kifizetettre állítás
          </button>
        </div>
      )}

      {inv.status === 'paid' && inv.paid_at && (
        <p className="mt-4 text-xs text-slate-500">
          Kifizetve: {AGENCY_day(inv.paid_at)} · {inv.decided_by || '—'}
        </p>
      )}
    </div>
  );
};

/* Aláírt letöltési hivatkozás egy agency_document sorra. A signed URL
   csak kattintáskor születik meg, hogy ne járjon le a lista alatt. */
const AgencyDocLink = ({ documentId, path, label }) => {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      let p = path;
      if (!p && documentId) {
        const rows = await AGENCY_select('agency_document', { eq: { id: documentId } });
        p = rows.length ? rows[0].path : '';
      }
      const url = await AGENCY_signedUrl(p);
      if (url) window.open(url, '_blank', 'noopener');
    } catch (e) {
      // A hiányzó jogosultság itt néma marad: a gomb egyszerűen nem nyit meg semmit.
    } finally { setBusy(false); }
  };
  return (
    <button
      onClick={open} disabled={busy}
      className="px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
    >
      <ICONS.Download size={16} /> {label || 'Megnyitás'}
    </button>
  );
};

/* ============================================================
   7. ÜGYNÖKSÉGI DOKUMENTUMTÁR — 5. tétel
   ------------------------------------------------------------
   Szerződés, meghatalmazás, cégkivonat. A fájlok a MEGLÉVŐ
   'documents' bucketben élnek (08_documents_storage.sql), csak az
   elérési út és a metaadat kerül az agency_document táblába.
   Az ügynökség a saját dokumentumait látja, az ügyintéző mindet —
   ezt az RLS dönti el, nem ez a komponens.
   ============================================================ */
const AgencyDocuments = ({ user, agencies, myAgencyId }) => {
  const isAgent = user.role === 'AGENT';
  const [agencyId, setAgencyId] = useState(myAgencyId || '');
  const [docs, setDocs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [open, setOpen]         = useState(false);
  const [form, setForm]         = useState({ kind: 'contract', title: '', validFrom: '', validUntil: '', note: '' });
  const [file, setFile]         = useState(null);

  const target = isAgent ? (myAgencyId || '') : agencyId;

  const reload = async () => {
    setError('');
    try {
      setDocs(await AGENCY_api.documents(target || null));
    } catch (e) {
      setError(e.message || 'A dokumentumok betöltése nem sikerült.');
    } finally { setLoading(false); }
  };

  useEffect(() => { reload(); }, [target]);

  const upload = async () => {
    if (!target)             { setError('Válasszon ügynökséget.'); return; }
    if (!form.title.trim())  { setError('A megnevezés kötelező.'); return; }
    if (!file)               { setError('Válasszon fájlt.'); return; }
    setBusy(true); setError('');
    try {
      const path = await AGENCY_upload(file, user.id, target);
      await AGENCY_api.addDocument({
        id: 'AGD-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        agency_id: target,
        kind: form.kind,
        title: form.title.trim(),
        path,
        file_name: file.name,
        file_size: file.size,
        valid_from: form.validFrom || null,
        valid_until: form.validUntil || null,
        note: form.note.trim() || null,
        uploaded_by: user.id,
      });
      setOpen(false); setFile(null);
      setForm({ kind: 'contract', title: '', validFrom: '', validUntil: '', note: '' });
      await reload();
    } catch (e) {
      setError(e.message || 'A feltöltés nem sikerült.');
    } finally { setBusy(false); }
  };

  const remove = async (doc) => {
    setBusy(true); setError('');
    try {
      await AGENCY_api.delDocument(doc.id);
      await reload();
    } catch (e) {
      setError(e.message || 'A törlés nem sikerült.');
    } finally { setBusy(false); }
  };

  const kindLabel = (k) => {
    const o = AGENCY_DOC_KINDS.find(x => x.id === k);
    return o ? o.label : k;
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-slate-800">Ügynökségi dokumentumok</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-[70ch] leading-relaxed">
            Szerződés, meghatalmazás és egyéb okirat az ügynökséghez csatolva.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {!isAgent && (
            <div className="min-w-[15rem]">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
                Ügynökség
              </label>
              <select
                value={agencyId}
                onChange={e => setAgencyId(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="">Minden ügynökség</option>
                {(agencies || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}
          <button
            onClick={() => { setOpen(!open); setError(''); }}
            disabled={!target}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
            title={!target ? 'Előbb válasszon ügynökséget.' : ''}
          >
            <ICONS.PlusCircle size={16} /> Dokumentum csatolása
          </button>
        </div>
      </div>

      <AGENCY_Error text={error} onClose={() => setError('')} />

      {open && (
        <div className="bg-white rounded-3xl border border-indigo-100 shadow-md p-6 space-y-4 animate-in zoom-in-95 duration-200">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">Típus</label>
              <select
                value={form.kind}
                onChange={e => setForm({ ...form, kind: e.target.value })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                {AGENCY_DOC_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">Megnevezés</label>
              <input
                type="text" value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                placeholder="Pl. Együttműködési szerződés 2024"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">Érvényes ettől</label>
              <input
                type="date" value={form.validFrom}
                onChange={e => setForm({ ...form, validFrom: e.target.value })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">Érvényes eddig</label>
              <input
                type="date" value={form.validUntil}
                onChange={e => setForm({ ...form, validUntil: e.target.value })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">Fájl (max. 20 MB)</label>
            <input
              type="file"
              onChange={e => setFile(e.target.files && e.target.files[0])}
              className="w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-slate-900 file:text-white hover:file:bg-slate-800"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="px-4 py-2.5 text-slate-500 text-sm font-bold hover:bg-slate-50 rounded-xl transition-colors">
              Mégse
            </button>
            <button
              disabled={busy} onClick={upload}
              className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {busy ? 'Feltöltés…' : 'Feltöltés'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        {loading ? (
          <p className="px-6 py-8 text-sm text-slate-400">Betöltés…</p>
        ) : docs.length === 0 ? (
          <AGENCY_Empty
            icon={<ICONS.FileText size={26} />}
            title="Nincs csatolt dokumentum"
            hint="A szerződés és a meghatalmazás itt tárolható, az ügynökséghez kötve."
          />
        ) : (
          <div className="divide-y divide-slate-50">
            {docs.map(d => (
              <div key={d.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-11 h-11 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
                    <ICONS.FileText size={20} />
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-slate-800 truncate">{d.title}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {kindLabel(d.kind)}
                      {d.file_name ? ' · ' + d.file_name : ''}
                      {d.file_size ? ' · ' + AGENCY_kb(d.file_size) : ''}
                      {' · feltöltve ' + AGENCY_day(d.uploaded_at)}
                    </p>
                    {(d.valid_from || d.valid_until) && (
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Érvényes: {AGENCY_day(d.valid_from)} – {AGENCY_day(d.valid_until)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <AgencyDocLink path={d.path} label="Letöltés" />
                  <button
                    disabled={busy}
                    onClick={() => remove(d)}
                    className="p-2.5 rounded-xl text-slate-300 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition-colors"
                    aria-label="Törlés"
                  >
                    <ICONS.Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/* ============================================================
   8. AZ ADATLAP KÉT ÚJ MEZŐJE — 6. tétel
   ------------------------------------------------------------
   'country of origin'          — EGY érték (agencies.country_of_origin)
   'countries of recruitment'   — TÖBB érték (text[] tömb)

   A tömböt címkékkel szerkesztjük: enter/vessző hozzáad, az X levesz.
   Így a mentett érték mindig valódi tömb marad, nem egy vesszős szöveg.
   ============================================================ */
const AgencyCountryFields = ({ origin, countries, onChange, compact }) => {
  const [draft, setDraft] = useState('');
  const list = Array.isArray(countries) ? countries : AGENCY_str2arr(countries);

  const add = (raw) => {
    const parts = AGENCY_str2arr(raw);
    if (!parts.length) return;
    const next = list.slice();
    parts.forEach(p => { if (next.indexOf(p) < 0) next.push(p); });
    onChange({ origin, countries: next });
    setDraft('');
  };
  const drop = (c) => onChange({ origin, countries: list.filter(x => x !== c) });

  const inputCls = 'w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

  return (
    <div className={compact ? 'space-y-3' : 'grid grid-cols-1 sm:grid-cols-2 gap-4'}>
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
          Származási ország
        </label>
        <input
          type="text" value={origin || ''}
          onChange={e => onChange({ origin: e.target.value, countries: list })}
          placeholder="Pl. Nigéria"
          className={inputCls}
        />
      </div>
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
          Toborzási országok
        </label>
        <div className="flex flex-wrap gap-1.5 mb-2 min-h-[1.5rem]">
          {list.length === 0
            ? <span className="text-xs text-slate-300 italic">Még nincs megadva ország</span>
            : list.map(c => (
                <span key={c} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-50 border border-indigo-100 text-[11px] font-semibold text-indigo-700">
                  {c}
                  <button
                    type="button" onClick={() => drop(c)}
                    className="text-indigo-300 hover:text-indigo-700" aria-label="Eltávolítás"
                  >
                    <ICONS.X size={11} />
                  </button>
                </span>
              ))}
        </div>
        <input
          type="text" value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); }
          }}
          onBlur={() => add(draft)}
          placeholder="Ország, majd Enter"
          className={inputCls}
        />
        <p className="text-[10px] text-slate-400 mt-1.5">
          Több ország is megadható — Enter vagy vessző zárja le a beírt nevet.
        </p>
      </div>
    </div>
  );
};

/* ============================================================
   9. A BEIRATKOZÁS TÉNYE — a 4. tétel alapja
   ------------------------------------------------------------
   A jutalék NEM a felvételi státuszból következik: a hallgató lehet
   „Felvéve" úgy, hogy végül nem iratkozott be. Ezért van külön
   students.enrolled_at, és ezért csak ügyintéző írhatja
   (students_enrollment_guard trigger + student_set_enrolled RPC).

   A felület csak felkínálja a műveletet — a jogosultságot a szerver
   dönti el, a hibát pedig szó szerint mutatjuk meg.
   ============================================================ */
const EnrollmentControl = ({ student, canEdit, onSaved }) => {
  const [date, setDate] = useState((student.enrolled_at || '').slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  useEffect(() => { setDate((student.enrolled_at || '').slice(0, 10)); setErr(''); }, [student.id, student.enrolled_at]);

  const save = async (value) => {
    setBusy(true); setErr('');
    try {
      const row = await AGENCY_api.setEnrolled(student.id, value || null);
      if (onSaved && row) onSaved(row);
    } catch (e) {
      setErr(e.message || 'A beiratkozás rögzítése nem sikerült.');
    } finally { setBusy(false); }
  };

  if (student.enrolled_at) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-100 px-4 py-3">
          <ICONS.CheckCircle size={18} className="text-emerald-600 shrink-0" />
          <p className="text-sm font-bold text-emerald-800 flex-1">
            Beiratkozott: {AGENCY_day(student.enrolled_at)}
          </p>
          {canEdit && (
            <button
              disabled={busy}
              onClick={() => save('')}
              className="text-xs font-bold text-emerald-700 hover:underline disabled:opacity-50"
            >
              Visszavonás
            </button>
          )}
        </div>
        <AGENCY_Error text={err} onClose={() => setErr('')} />
      </div>
    );
  }

  if (!canEdit) {
    return (
      <div className="rounded-xl bg-slate-50 border border-slate-100 p-4 text-xs text-slate-400">
        Még nem iratkozott be. A beiratkozás tényét felvételi ügyintéző rögzíti.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem]">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">
            Beiratkozás dátuma
          </label>
          <input
            type="date" value={date}
            onChange={e => setDate(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>
        <button
          disabled={busy || !date}
          onClick={() => save(date)}
          className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-40 transition-colors"
        >
          {busy ? 'Mentés…' : 'Beiratkozás rögzítése'}
        </button>
      </div>
      <AGENCY_Error text={err} onClose={() => setErr('')} />
    </div>
  );
};
