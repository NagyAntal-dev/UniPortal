/* ============================================================
   UniPortal Pro — Campus Feed
   Post-login landing for every role. Admins publish news, photo
   galleries, promotions (e.g. Early Bird), event tickets/vouchers,
   RSVP events and deadline reminders. Everyone can read; students
   can RSVP to events and claim tickets/vouchers.
   ============================================================ */

const FEED_TABLE = 'feed_posts', FEED_LS = 'uni_feed';
const RSVP_TABLE = 'event_rsvps', RSVP_LS = 'uni_rsvps';
const TIX_TABLE = 'ticket_claims', TIX_LS = 'uni_tickets';

const FEED_TYPES = {
  news:     { label: 'Hír',     icon: Lucide.Newspaper,    tone: 'blue',    accent: 'text-sky-600' },
  gallery:  { label: 'Galéria',  icon: Lucide.Images,       tone: 'violet',  accent: 'text-violet-600' },
  promo:    { label: 'Ajánlat',    icon: Lucide.BadgePercent, tone: 'primary', accent: 'text-primary' },
  ticket:   { label: 'Jegy',   icon: Lucide.Ticket,       tone: 'green',   accent: 'text-emerald-600' },
  event:    { label: 'Esemény',    icon: Lucide.CalendarDays, tone: 'amber',   accent: 'text-amber-600' },
  deadline: { label: 'Határidő', icon: Lucide.AlarmClock,   tone: 'red',     accent: 'text-red-600' },
};

function FEED_seed() {
  const d = (days) => new Date(Date.now() + days * 86400000).toISOString();
  const back = (days) => new Date(Date.now() - days * 86400000).toISOString();
  return [
    { id: 'FP-earlybird', type: 'promo', title: 'Early Bird 2026 — 15% tuition discount', body: 'Apply and pay your application fee before 30 April 2026 to lock in a 15% discount on your first-year tuition. Applies to all English-taught bachelor and master programmes.', image_url: 'https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1200&q=70', gallery: null, author_name: 'Admissions Office', pinned: true, promo_code: 'EARLYBIRD15', discount: '15% off tuition', event_date: d(60), event_location: null, capacity: null, ticket_code: null, cta_label: 'Browse programmes', cta_href: '', created_at: back(1) },
    { id: 'FP-openday', type: 'event', title: 'Online Open Day — Meet the faculties', body: 'Join our live online open day. Meet programme coordinators from Engineering, Business and Horticulture, tour the campus virtually and ask the admissions team anything.', image_url: 'https://images.unsplash.com/photo-1531058020387-3be344556be6?auto=format&fit=crop&w=1200&q=70', gallery: null, author_name: 'International Office', pinned: true, promo_code: null, discount: null, event_date: d(14), event_location: 'Online · Microsoft Teams', capacity: 200, ticket_code: null, cta_label: null, cta_href: '', created_at: back(2) },
    { id: 'FP-welcomeweek', type: 'ticket', title: 'Welcome Week pass — International students', body: 'Grab your free pass for Welcome Week: city tour, welcome dinner, buddy meet-up and the international student party. Show the code at the info desk.', image_url: null, gallery: null, author_name: 'Student Life', pinned: false, promo_code: null, discount: null, event_date: d(30), event_location: 'Kecskemét campus', capacity: 500, ticket_code: 'WELCOME-2026', cta_label: null, cta_href: '', created_at: back(3) },
    { id: 'FP-campus', type: 'gallery', title: 'A look around the Kecskemét campus', body: 'Modern labs, the GAMF engineering halls, green courtyards and the student hub — a few shots from around campus this autumn.', image_url: null, gallery: ['https://images.unsplash.com/photo-1562774053-701939374585?auto=format&fit=crop&w=800&q=70', 'https://images.unsplash.com/photo-1498243691581-b145c3f54a5a?auto=format&fit=crop&w=800&q=70', 'https://images.unsplash.com/photo-1541339907198-e08756dedf3f?auto=format&fit=crop&w=800&q=70'], author_name: 'NJE Communications', pinned: false, promo_code: null, discount: null, event_date: null, event_location: null, capacity: null, ticket_code: null, cta_label: null, cta_href: '', created_at: back(5) },
    { id: 'FP-deadline', type: 'deadline', title: 'Fall 2026 intake — application deadline', body: 'Final deadline to submit your application for programmes starting in September 2026. Make sure your documents are uploaded and your application fee is paid.', image_url: null, gallery: null, author_name: 'Admissions Office', pinned: false, promo_code: null, discount: null, event_date: d(45), event_location: null, capacity: null, ticket_code: null, cta_label: null, cta_href: '', created_at: back(6) },
    { id: 'FP-news', type: 'news', title: 'NJE expands English-taught engineering portfolio', body: 'From 2026 the GAMF Faculty welcomes more international students across Computer Science, Mechanical, Vehicle and Logistics Engineering, with strengthened industry placements at regional automotive and IT partners.', image_url: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&w=1200&q=70', gallery: null, author_name: 'NJE Communications', pinned: false, promo_code: null, discount: null, event_date: null, event_location: null, capacity: null, ticket_code: null, cta_label: null, cta_href: '', created_at: back(8) },
  ];
}

/* A demo-bejegyzésekkel csak ÜGYINTÉZŐ tölthet fel üres táblát. Célzott
   bejegyzéseknél egy hallgató hírfolyama jogosan lehet üres — ilyenkor a régi
   betöltő a demo-bejegyzéseket mutatta neki, és megpróbálta beírni őket. */
const FEED_loadPosts = (seedOk) => dlSelect(FEED_TABLE, FEED_LS, seedOk ? FEED_seed : () => [], 'created_at', false);

/* ---------- Célközönség (69_feed_audience.sql) ----------
   Üres célközönség = mindenki. A szempontok ÉS kapcsolatban, egy szemponton
   belül VAGY; az egyedi személyek mindig látják. A szűrést az adatbázis
   sorszintű szabálya végzi (feed_post_visible) — a felület csak összeállítja. */
/* Ki kezeli a hírfolyamot: a SUPERADMIN is (az isAdmin csak a pontos 'ADMIN'
   szerepkört ismeri). Ki látja a célközönség-jelölést: minden ügyintéző. */
/* SZERKESZTŐ: bejegyzést ír és töröl. A hírfolyam a `feed` modul CREATE/DELETE
   joga. A `regi` paraméter a MAI viselkedés — ha a 72-es migráció még nem
   futott le, az dönt (lásd features/perm.jsx).

   FIGYELEM, a két predikátum NEM ugyanarra jó, és ezért két külön művelet:
     FEED_szerkeszto — bejegyzést tesz közzé és töröl  -> CREATE
     FEED_ugyintezo  — a célközönség-jelölést látja, a
                       jelentkezéseket (event_rsvps) kezeli -> USE
   A mai kódba égetett listák szerint a szerkesztő szűkebb kör (SUPERADMIN,
   ADMIN), az ügyintéző bővebb (a négy belső szerepkör). A 72-es backfill
   pontosan ezt rögzítette: feed CREATE/EDIT/DELETE az ADMISSIONS-nak is jár
   (rbac_feed_posts_* = is_admissions()), a USE mindenkinek, aki látja a modult. */
const FEED_szerkeszto = (user) => PERM_can(user, 'feed', 'CREATE',
  !!(user && ['SUPERADMIN', 'ADMIN'].includes(user.role)));
const FEED_ugyintezo = (user) => PERM_can(user, 'feed', 'USE',
  !!(user && ['SUPERADMIN', 'ADMIN', 'ADMISSIONS', 'FINANCE'].includes(user.role)));
/* Törlés külön: egy bejegyzés eltüntetése visszafordíthatatlan. */
const FEED_torolhet = (user) => PERM_can(user, 'feed', 'DELETE',
  !!(user && ['SUPERADMIN', 'ADMIN'].includes(user.role)));
const FEED_CEL_LISTAK = ['szerep', 'tagozat', 'kepzesi_szint', 'kar', 'szak'];
const FEED_CEL_TETELEK = ['kurzus', 'csoport', 'szemely'];
const FEED_SZEREPEK = [['STUDENT', 'Hallgatók és jelentkezők'], ['TEACHER', 'Oktatók'], ['AGENT', 'Ügynökök']];
const FEED_celUres = () => ({ mod: 'mindenki', szerep: [], tagozat: [], kepzesi_szint: [], kar: [], szak: [], kurzus: [], csoport: [], szemely: [] });

/* A mentendő JSON: csak a nem üres listák, a tételekből csak az azonosító
   (név SOHA — a célzott hallgatók a sort a célközönséggel együtt olvassák). */
function FEED_celNormal(c) {
  if (!c || c.mod !== 'celzott') return null;
  const out = {};
  FEED_CEL_LISTAK.forEach(k => { const v = (c[k] || []).filter(Boolean); if (v.length) out[k] = v; });
  FEED_CEL_TETELEK.forEach(k => { const v = (c[k] || []).map(x => x && x.ref).filter(Boolean); if (v.length) out[k] = v; });
  return Object.keys(out).length ? out : null;
}

function FEED_celOsszegzes(aud) {
  if (!aud || typeof aud !== 'object') return '';
  const lista = (k) => Array.isArray(aud[k]) ? aud[k].filter(Boolean) : [];
  const reszek = [];
  const szerepNev = {}; FEED_SZEREPEK.forEach(([k, v]) => { szerepNev[k] = v; });
  if (lista('szerep').length) reszek.push(lista('szerep').map(r => szerepNev[r] || r).join(' / '));
  ['tagozat', 'kepzesi_szint', 'kar', 'szak'].forEach(k => { if (lista(k).length) reszek.push(lista(k).join(' / ')); });
  if (lista('kurzus').length) reszek.push(lista('kurzus').length + ' kurzus');
  if (lista('csoport').length) reszek.push(lista('csoport').length + ' csoport');
  if (lista('szemely').length) reszek.push(lista('szemely').length + ' személy');
  return reszek.join(' · ');
}

function FEED_Chipek({ cimke, opciok, valasztott, onValt, ures }) {
  return (
    <div>
      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1.5">
        {cimke}{valasztott.length > 0 && <span className="text-primary ml-1.5">{valasztott.length}</span>}
      </span>
      {opciok.length === 0 ? (
        <p className="text-[11px] text-slate-300 font-bold italic">{ures || 'nincs választható érték'}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
          {opciok.map(o => {
            const on = valasztott.indexOf(o.ertek) >= 0;
            return (
              <button key={o.ertek} type="button" data-feed-cel-chip={o.ertek}
                onClick={() => onValt(on ? valasztott.filter(x => x !== o.ertek) : valasztott.concat([o.ertek]))}
                className={'px-2.5 py-1 rounded-xl border text-[11px] font-bold transition-all ' +
                  (on ? 'border-primary bg-primary/10 text-primary' : 'border-slate-100 text-slate-500 hover:border-slate-300')}>
                {o.cimke || o.ertek}{o.db != null && <span className="ml-1 font-medium opacity-60">{o.db}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FEED_CelkozonsegValaszto({ ertek, onValt }) {
  const [attr, setAttr] = useState(null);
  const [elo, setElo] = useState(null);
  const [eloBusy, setEloBusy] = useState(false);
  const [nincsMigracio, setNincsMigracio] = useState(false);
  const set = (k) => (v) => onValt({ ...ertek, [k]: v });
  const celzott = ertek.mod === 'celzott';

  useEffect(() => {
    if (!celzott || attr || !window.sb) return;
    window.sb.rpc('student_attribute_options')
      .then(({ data, error }) => setAttr(!error && data ? data : {}))
      .catch(() => setAttr({}));
  }, [celzott]);

  const aud = FEED_celNormal(ertek);
  const kulcs = JSON.stringify(aud);
  useEffect(() => {
    if (!celzott || !aud || !window.sb) { setElo(null); return; }
    let el = true; setEloBusy(true);
    const t = setTimeout(() => {
      window.sb.rpc('feed_audience_preview', { p_aud: aud })
        .then(({ data, error }) => {
          if (!el) return;
          if (error) {
            if (/feed_audience_preview|schema cache|PGRST202/i.test((error.message || '') + (error.code || ''))) setNincsMigracio(true);
            setElo(null);
          } else { setNincsMigracio(false); setElo(data); }
          setEloBusy(false);
        })
        .catch(() => { if (el) { setElo(null); setEloBusy(false); } });
    }, 400);
    return () => { el = false; clearTimeout(t); };
  }, [celzott, kulcs]);

  const attrOpc = (k) => ((attr && attr[k]) || []).map(x => ({ ertek: x.ertek, db: x.db }));
  const betolt = (kind, q) => window.sb.rpc('feed_audience_options', { p_kind: kind, p_q: q || null })
    .then(({ data, error }) => { if (error) throw error; return data; });
  const tetel = (k) => (ertek[k] || []);
  const Picker = typeof ECHO_AudiencePicker === 'function' ? ECHO_AudiencePicker : null;

  return (
    <div data-feed-celkozonseg="1">
      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Kinek jelenjen meg?</span>
      <div className="grid grid-cols-2 gap-2">
        {[['mindenki', 'Mindenkinek', Lucide.Globe], ['celzott', 'Kiválasztott hallgatóknak', Lucide.Target]].map(([m, felirat, I]) => (
          <button key={m} type="button" onClick={() => onValt({ ...ertek, mod: m })}
            className={'flex items-center justify-center gap-2 py-3 rounded-2xl border text-[12px] font-bold transition-all ' +
              (ertek.mod === m ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 text-slate-500 hover:border-slate-200')}>
            <I size={16} /> {felirat}
          </button>
        ))}
      </div>

      {celzott && (
        <div className="mt-3 rounded-2xl border border-slate-100 p-4 space-y-4">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            A különböző szempontok <b>együtt</b> érvényesek (pl. Nappali <b>és</b> GAMF kar), egy szemponton
            belül <b>bármelyik</b> elég (pl. Nappali <b>vagy</b> Levelező). Amit üresen hagysz, az nem szűkít.
            Az egyedi személyek mindig látják a bejegyzést.
          </p>

          <FEED_Chipek cimke="Szerepkör" opciok={FEED_SZEREPEK.map(([k, v]) => ({ ertek: k, cimke: v }))}
            valasztott={ertek.szerep} onValt={set('szerep')} />

          {attr === null ? <SkeletonBar h={60} /> : (
            <div className="grid sm:grid-cols-2 gap-4">
              <FEED_Chipek cimke="Tagozat" opciok={attrOpc('tagozat')} valasztott={ertek.tagozat} onValt={set('tagozat')} ures="nincs besorolási adat" />
              <FEED_Chipek cimke="Képzési szint" opciok={attrOpc('kepzesi_szint')} valasztott={ertek.kepzesi_szint} onValt={set('kepzesi_szint')} ures="nincs besorolási adat" />
              <FEED_Chipek cimke="Kar" opciok={attrOpc('kar')} valasztott={ertek.kar} onValt={set('kar')} ures="nincs besorolási adat" />
              <FEED_Chipek cimke="Szak" opciok={attrOpc('szak')} valasztott={ertek.szak} onValt={set('szak')} ures="nincs besorolási adat" />
            </div>
          )}
          <p className="text-[11px] text-slate-400 leading-relaxed -mt-2">
            A tagozat, szint, kar és szak a Neptun-besorolásból jön: akinek nincs besorolása (pl. még csak jelentkező), azt ezek a szempontok nem érik el.
          </p>

          {Picker && (
            <div className="grid gap-3">
              <Picker kind="course" betolt={betolt} cimke="Kurzusok" ikon={<Lucide.BookOpen size={13} className="text-slate-400" />}
                sug="Akik a kijelölt kurzusok bármelyikén aktív hallgatók."
                valasztott={tetel('kurzus')} onValt={set('kurzus')} />
              <Picker kind="group" betolt={betolt} cimke="Csoportok" ikon={<Lucide.Users size={13} className="text-slate-400" />}
                sug="A Felhasználók → Csoportok alatt létrehozott csoportok bármelyikének tagjai."
                valasztott={tetel('csoport')} onValt={set('csoport')} />
              <Picker kind="user" betolt={betolt} cimke="Egyedi személyek" ikon={<Lucide.User size={13} className="text-slate-400" />}
                sug="Ők a fenti szempontoktól függetlenül mindig látják."
                valasztott={tetel('szemely')} onValt={set('szemely')} />
            </div>
          )}

          <div className="bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3" data-feed-cel-elonezet="1">
            {nincsMigracio ? (
              <p className="text-[11px] font-bold text-amber-700">A célzott bejegyzéshez előbb le kell futtatni a 69_feed_audience.sql migrációt.</p>
            ) : !aud ? (
              <p className="text-[11px] font-bold text-slate-400">Válassz legalább egy szempontot.</p>
            ) : (
              <p className="text-sm font-black text-slate-700 flex items-center gap-2">
                <Lucide.Eye size={14} className="text-slate-400" />
                {elo ? elo.osszes + ' fő látja' : '…'}
                {elo && (elo.oktato > 0 || elo.ugynok > 0) && (
                  <span className="text-[11px] font-bold text-slate-400">({elo.hallgato} hallgató · {elo.oktato} oktató · {elo.ugynok} ügynök)</span>
                )}
                {eloBusy && <Lucide.Loader2 size={13} className="animate-spin text-slate-300" />}
              </p>
            )}
            <p className="text-[11px] text-slate-400 mt-1">Az ügyintézők minden bejegyzést látnak.</p>
          </div>
        </div>
      )}
    </div>
  );
}
const FEED_loadRsvps = () => dlSelect(RSVP_TABLE, RSVP_LS, () => [], 'created_at', false);
const FEED_loadTix = () => dlSelect(TIX_TABLE, TIX_LS, () => [], 'created_at', false);

// A gomb hivatkozását szerkesztő írja be, szabad szövegként. A React a
// href attribútumot nem szűri, tehát egy "javascript:…" cím a megnyitáskor
// kódot futtatna a felület saját originjén. Csak http(s)-t engedünk át.
function FEED_biztonsagosHivatkozas(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s, window.location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch (e) {
    return '';
  }
}
function FEED_img(url, className, alt) {
  return <img src={url} alt={alt || ''} loading="lazy" className={className} referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
}

/* ---------- Admin composer ---------- */
function FeedComposer({ open, onClose, onPublished, authorName }) {
  const empty = { type: 'news', title: '', body: '', image_url: '', gallery: '', promo_code: '', discount: '', event_date: '', event_location: '', capacity: '', ticket_code: '', cta_label: '', cta_href: '', pinned: false };
  const [f, setF] = useState(empty);
  const [cel, setCel] = useState(FEED_celUres());
  const [hiba, setHiba] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  useEffect(() => { if (open) { setF(empty); setCel(FEED_celUres()); setHiba(''); } }, [open]);

  const uploadImg = async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const dataUrl = await KB_readFileAsDataUrl(file); set('image_url', dataUrl);
  };
  const publish = async () => {
    if (!f.title.trim()) return;
    const aud = FEED_celNormal(cel);
    if (cel.mod === 'celzott' && !aud) { setHiba('Válassz legalább egy szempontot, vagy állítsd „Mindenkinek”-re.'); return; }
    setHiba('');
    setBusy(true);
    const row = {
      id: uid('FP'), type: f.type, title: f.title.trim(), body: f.body.trim(),
      image_url: f.image_url || null,
      gallery: f.gallery ? f.gallery.split(/[\n,]/).map(s => s.trim()).filter(Boolean) : null,
      author_name: authorName || 'Admissions Office', pinned: !!f.pinned,
      promo_code: f.promo_code || null, discount: f.discount || null,
      event_date: f.event_date || null, event_location: f.event_location || null,
      capacity: f.capacity ? Number(f.capacity) : null, ticket_code: f.ticket_code || null,
      cta_label: f.cta_label || null, cta_href: f.cta_href || null, created_at: new Date().toISOString(),
    };
    if (aud) {
      /* Célzott bejegyzés CSAK az adatbázisba mehet: a helyi tárolós tartalék
         mindenkinek megmutatná, és a szerző azt hinné, közzétette. */
      try {
        if (!window.sb) throw new Error('Nincs adatbázis-kapcsolat.');
        const { error } = await window.sb.from(FEED_TABLE).insert({ ...row, celkozonseg: aud }).select().single();
        if (error) throw error;
      } catch (e) {
        const m = (e && e.message) || '';
        setHiba(/celkozonseg/i.test(m) ? 'A célzott bejegyzéshez előbb le kell futtatni a 69_feed_audience.sql migrációt.'
                                       : 'A közzététel nem sikerült: ' + (m || 'ismeretlen hiba'));
        setBusy(false);
        return;
      }
    } else {
      // A dlInsert a 72/73-as óta DOBHAT: egy megtagadott írás nem eshet
      // vissza helyi tárolóra, különben a szerző azt hinné, közzétette.
      try {
        await dlInsert(FEED_TABLE, row, FEED_LS);
      } catch (e) {
        setHiba('A közzététel nem sikerült: ' + ((e && e.message) || 'ismeretlen hiba'));
        setBusy(false);
        return;
      }
    }
    setBusy(false); onPublished && onPublished(); onClose();
  };

  const typeBtns = Object.entries(FEED_TYPES);
  const show = (keys) => keys.includes(f.type);
  return (
    <UModal open={open} onClose={onClose} title="Új hírfolyam-bejegyzés" subtitle={cel.mod === 'celzott' ? 'Csak a kiválasztott célközönség látja' : 'Minden belépő felhasználó látja'} icon={<Lucide.PenSquare size={20} />} max="max-w-2xl">
      <div className="space-y-5">
        <div>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Bejegyzés típusa</span>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {typeBtns.map(([key, meta]) => {
              const I = meta.icon; const on = f.type === key;
              return (
                <button key={key} onClick={() => set('type', key)} className={'flex flex-col items-center gap-1.5 py-3 rounded-2xl border text-[11px] font-bold transition-all ' + (on ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 text-slate-500 hover:border-slate-200')}>
                  <I size={18} /> {meta.label}
                </button>
              );
            })}
          </div>
        </div>
        <UField label="Cím"><input className={U_input} value={f.title} onChange={e => set('title', e.target.value)} placeholder="A bejegyzés címe" /></UField>
        <UField label="Szöveg"><textarea className={U_input + ' min-h-[90px] resize-y'} value={f.body} onChange={e => set('body', e.target.value)} placeholder="Írd le a részleteket…" /></UField>

        {show(['news', 'promo', 'event']) && (
          <div className="grid sm:grid-cols-2 gap-4">
            <UField label="Borítókép URL"><input className={U_input} value={f.image_url && f.image_url.startsWith('data:') ? '' : f.image_url} onChange={e => set('image_url', e.target.value)} placeholder="https://…" /></UField>
            <UField label="…vagy feltöltés"><label className={U_btnGhost + ' w-full cursor-pointer'}><Lucide.Upload size={15} /> Kép választása<input type="file" accept="image/*" className="hidden" onChange={uploadImg} /></label></UField>
          </div>
        )}
        {show(['gallery']) && <UField label="Galéria kép-URL-ek" hint="Soronként egy (vagy vesszővel elválasztva)"><textarea className={U_input + ' min-h-[70px]'} value={f.gallery} onChange={e => set('gallery', e.target.value)} placeholder={"https://…\nhttps://…"} /></UField>}
        {show(['promo']) && (
          <div className="grid sm:grid-cols-2 gap-4">
            <UField label="Kuponkód"><input className={U_input} value={f.promo_code} onChange={e => set('promo_code', e.target.value)} placeholder="EARLYBIRD15" /></UField>
            <UField label="Kedvezmény megnevezése"><input className={U_input} value={f.discount} onChange={e => set('discount', e.target.value)} placeholder="15% tandíjkedvezmény" /></UField>
          </div>
        )}
        {show(['ticket']) && <UField label="Jegy- vagy kuponkód"><input className={U_input} value={f.ticket_code} onChange={e => set('ticket_code', e.target.value)} placeholder="WELCOME-2026" /></UField>}
        {show(['event', 'ticket', 'promo', 'deadline']) && (
          <div className="grid sm:grid-cols-2 gap-4">
            <UField label={f.type === 'deadline' ? 'Határidő dátuma' : 'Dátum és időpont'}><input type="datetime-local" className={U_input} value={f.event_date} onChange={e => set('event_date', e.target.value)} /></UField>
            {show(['event', 'ticket']) && <UField label="Helyszín"><input className={U_input} value={f.event_location} onChange={e => set('event_location', e.target.value)} placeholder="Kampusz / Online" /></UField>}
          </div>
        )}
        {show(['event', 'ticket']) && <UField label="Létszámkeret (opcionális)"><input type="number" className={U_input} value={f.capacity} onChange={e => set('capacity', e.target.value)} placeholder="pl. 200" /></UField>}
        {show(['news', 'promo']) && (
          <div className="grid sm:grid-cols-2 gap-4">
            <UField label="Gomb felirata (opcionális)"><input className={U_input} value={f.cta_label} onChange={e => set('cta_label', e.target.value)} placeholder="Tudj meg többet" /></UField>
            <UField label="Gomb hivatkozása (opcionális)"><input className={U_input} value={f.cta_href} onChange={e => set('cta_href', e.target.value)} placeholder="https://nje.hu/en" /></UField>
          </div>
        )}

        <FEED_CelkozonsegValaszto ertek={cel} onValt={setCel} />

        <label className="flex items-center gap-2.5 text-sm font-bold text-slate-600 cursor-pointer">
          <input type="checkbox" checked={f.pinned} onChange={e => set('pinned', e.target.checked)} className="w-4 h-4 accent-primary" /> Kiemelés a hírfolyam tetejére
        </label>
        <div className="flex justify-end gap-3 pt-2">
          {hiba && <p className="mr-auto self-center text-[12px] font-bold text-red-600" role="alert" data-feed-hiba="1">{hiba}</p>}
          <button className={U_btnGhost} onClick={onClose}>Mégse</button>
          <button className={U_btnPrimary} disabled={busy || !f.title.trim()} onClick={publish}>{busy ? 'Közzététel…' : 'Bejegyzés közzététele'}</button>
        </div>
      </div>
    </UModal>
  );
}

/* ---------- individual post card ---------- */
function FeedCard({ post, user, rsvps, tix, onChange, onDelete, nezes, onLatta }) {
  const meta = FEED_TYPES[post.type] || FEED_TYPES.news;
  const I = meta.icon;
  const [copied, setCopied] = useState(false);
  // Jogosultsági megtagadás a kártyán (jelentkezés, jegyigénylés).
  const [kartyaHiba, setKartyaHiba] = useState('');
  const myEmail = user && user.email;
  const attendees = rsvps.filter(r => r.post_id === post.id);
  const iRsvped = attendees.some(r => r.email === myEmail);
  const myTix = tix.find(t => t.post_id === post.id && t.email === myEmail);

  const copy = (txt) => { try { navigator.clipboard.writeText(txt); } catch (e) {} setCopied(true); setTimeout(() => setCopied(false), 1500); };
  /* A dlDelete / dlInsert megtagadás esetén DOB (lásd data-layer.jsx). Enélkül
     egy elutasított jelentkezés a felületen sikeresnek látszana. */
  const toggleRsvp = async () => {
    try {
      if (iRsvped) { const mine = attendees.find(r => r.email === myEmail); if (mine) await dlDelete(RSVP_TABLE, mine.id, RSVP_LS); }
      else { await dlInsert(RSVP_TABLE, { id: uid('RS'), post_id: post.id, email: myEmail, name: user.name, created_at: new Date().toISOString() }, RSVP_LS); }
      setKartyaHiba('');
    } catch (e) { setKartyaHiba((e && e.message) || 'A művelet nem sikerült.'); }
    onChange && onChange();
  };
  const claim = async () => {
    if (myTix) return;
    try {
      await dlInsert(TIX_TABLE, { id: uid('TX'), post_id: post.id, email: myEmail, code: post.ticket_code || ('NJE-' + Math.random().toString(36).slice(2, 8).toUpperCase()), created_at: new Date().toISOString() }, TIX_LS);
      setKartyaHiba('');
    } catch (e) { setKartyaHiba((e && e.message) || 'A jegyigénylés nem sikerült.'); }
    onChange && onChange();
  };
  const dleft = DL_daysLeft(post.event_date);

  /* „LÁTTA” = a kártya legalább félig megjelent a képernyőn (70). Nem
     kattintás és nem olvasás — a felület szövege sem állít többet. Egy
     felhasználó egy bejegyzésnél egyszer számít, a naplózás a szerveren
     ütközésmentes (on conflict). */
  const hivRef = useRef(null);
  const lattaRef = useRef(false);
  useEffect(() => {
    if (!onLatta || lattaRef.current) return;
    const el = hivRef.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const fig = new IntersectionObserver((sorok) => {
      sorok.forEach(x => {
        if (x.isIntersecting && !lattaRef.current) { lattaRef.current = true; onLatta(post.id); fig.disconnect(); }
      });
    }, { threshold: 0.5 });
    fig.observe(el);
    return () => fig.disconnect();
  }, [post.id, onLatta]);

  return (
    <article ref={hivRef} data-feed-poszt={post.id}
      className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
      {post.type === 'gallery' && post.gallery && post.gallery.length > 0 && (
        <div className={'grid gap-1 ' + (post.gallery.length === 1 ? 'grid-cols-1' : post.gallery.length === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
          {post.gallery.slice(0, 6).map((g, i) => <div key={i} className="aspect-[4/3] bg-slate-100 overflow-hidden">{FEED_img(g, 'w-full h-full object-cover')}</div>)}
        </div>
      )}
      {post.type !== 'gallery' && post.image_url && (
        <div className="aspect-[16/7] bg-slate-100 overflow-hidden">{FEED_img(post.image_url, 'w-full h-full object-cover')}</div>
      )}

      <div className="p-6">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <UBadge tone={meta.tone}><I size={12} /> {meta.label}</UBadge>
            {post.pinned && <UBadge tone="slate"><Lucide.Pin size={11} /> Kiemelt</UBadge>}
            {FEED_ugyintezo(user) && FEED_celOsszegzes(post.celkozonseg) && (
              <span data-feed-celzott="1" title="Célközönség — csak az ügyintézők látják ezt a jelölést">
                <UBadge tone="blue"><Lucide.Target size={11} /> {FEED_celOsszegzes(post.celkozonseg)}</UBadge>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {nezes != null && (
              <span data-feed-nezes={post.id}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-400"
                title={'Hányan látták — ' + nezes + ' különböző felhasználó képernyőjén jelent meg. Nevet a rendszer nem mutat, és az ügyintézők megtekintése nem számít bele.'}>
                <Lucide.Eye size={13} className="flex-none" /> {nezes}
              </span>
            )}
            <span className="text-[11px] text-slate-400 font-bold">{DL_date(post.created_at)}</span>
            {FEED_torolhet(user) && <button onClick={() => onDelete(post)} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 transition-colors" title="Törlés"><Lucide.Trash2 size={14} /></button>}
          </div>
        </div>

        {kartyaHiba && (
          <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-3 py-2 text-[13px] font-semibold">
            <Lucide.AlertCircle size={14} className="mt-0.5 flex-none" />
            <span className="flex-1">{kartyaHiba}</span>
            <button onClick={() => setKartyaHiba('')} className="text-red-400 hover:text-red-700"><Lucide.X size={13} /></button>
          </div>
        )}

        <h3 className="text-xl font-black text-slate-900 tracking-tight leading-snug">{post.title}</h3>
        {post.body && <p className="text-sm text-slate-500 leading-relaxed mt-2 whitespace-pre-line max-w-[70ch]">{post.body}</p>}

        {/* meta strip */}
        {(post.event_date || post.event_location) && post.type !== 'deadline' && (
          <div className="flex flex-wrap items-center gap-4 mt-4 text-[13px] font-bold text-slate-600">
            {post.event_date && <span className="flex items-center gap-1.5"><Lucide.Clock size={14} className={meta.accent} /> {DL_dateLong(post.event_date)}</span>}
            {post.event_location && <span className="flex items-center gap-1.5"><Lucide.MapPin size={14} className={meta.accent} /> {post.event_location}</span>}
          </div>
        )}

        {/* promo */}
        {post.type === 'promo' && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {post.discount && <div className="px-3 py-2 rounded-xl bg-primary/5 text-primary font-black text-sm">{post.discount}</div>}
            {post.promo_code && (
              <button onClick={() => copy(post.promo_code)} className="group flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-primary/40 text-primary font-mono font-bold text-sm hover:bg-primary/5 transition-colors">
                {post.promo_code} {copied ? <Lucide.Check size={14} /> : <Lucide.Copy size={14} className="opacity-60 group-hover:opacity-100" />}
              </button>
            )}
            {dleft != null && dleft >= 0 && <span className="text-xs font-bold text-slate-400">{dleft + ' nap múlva lejár'}</span>}
          </div>
        )}

        {/* deadline */}
        {post.type === 'deadline' && (
          <div className="mt-4 flex items-center gap-3">
            <div className={'px-4 py-3 rounded-2xl font-black ' + (dleft != null && dleft <= 7 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600')}>
              {dleft == null ? DL_date(post.event_date) : dleft < 0 ? 'Lezárva' : dleft === 0 ? 'Ma' : dleft + ' nap van hátra'}
            </div>
            <span className="text-sm font-bold text-slate-500">{DL_dateLong(post.event_date)}</span>
          </div>
        )}

        {/* ticket / voucher */}
        {post.type === 'ticket' && (
          <div className="mt-4">
            {myTix ? (
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-emerald-50 border border-emerald-100">
                <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center"><Lucide.TicketCheck size={20} /></div>
                <div><div className="text-[11px] font-black text-emerald-700 uppercase tracking-wider">A kódod</div><div className="font-mono font-black text-emerald-800 text-lg tracking-wide">{myTix.code}</div></div>
              </div>
            ) : (
              <button onClick={claim} className={U_btnPrimary}><Lucide.Ticket size={16} /> Kérem a jegyet</button>
            )}
          </div>
        )}

        {/* event RSVP */}
        {post.type === 'event' && (
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <button onClick={toggleRsvp} className={iRsvped ? U_btnGhost : U_btnPrimary}>
              {iRsvped ? <><Lucide.Check size={16} /> Ott leszek</> : <><Lucide.CalendarPlus size={16} /> Jelentkezem</>}
            </button>
            <span className="text-sm font-bold text-slate-400 flex items-center gap-1.5"><Lucide.Users size={15} /> {attendees.length}{post.capacity ? ' / ' + post.capacity : ''}{' résztvevő'}</span>
          </div>
        )}

        {/* generic CTA */}
        {post.cta_label && FEED_biztonsagosHivatkozas(post.cta_href) && (
          <a href={FEED_biztonsagosHivatkozas(post.cta_href)} target="_blank" rel="noreferrer" className={U_btnGhost + ' mt-4'}>{post.cta_label} <Lucide.ArrowUpRight size={15} /></a>
        )}

        <div className="mt-5 pt-4 border-t border-slate-50 flex items-center gap-2 text-[12px] text-slate-400 font-bold">
          <Lucide.BadgeCheck size={14} className="text-primary" /> {post.author_name || 'NJE'}
        </div>
      </div>
    </article>
  );
}

/* ---------- main view ---------- */
/* ------------------------------------------------------------
   Kitöltendő kérdőívek a hírfolyam tetején.

   MIÉRT ITT
     A kérdőívre a hallgatónak határideje van, de a Kurzusértékelés menüpontba
     nem feltétlenül néz be. A hírfolyam az, amit belépéskor lát — a teendő
     ezért ide kerül, és a gomb NEM a listáig visz, hanem egyenesen a kitöltőt
     nyitja (az átadás az ECHO_ATADAS_KULCS sessionStorage-kulcson megy).

   HA NINCS TEENDŐ, NEM RENDERELÜNK SEMMIT — üres doboz csak zajt csinálna.
   ------------------------------------------------------------ */
function FEED_EchoTeendok({ onNavigate }) {
  const [sor, setSor] = useState(null);

  useEffect(() => {
    let el = true;
    (async () => {
      try {
        // Az ECHO modul a csomagban ELŐBB áll, tehát az ECHO_api itt már él.
        // A védelem mégis kell: ha valaki átrendezi a sorrendet, a hírfolyam
        // ne fehér képernyővel bukjon el egy nem létező néven.
        if (typeof ECHO_api === 'undefined' || !ECHO_api.myCourses) { if (el) setSor([]); return; }
        const d = await ECHO_api.myCourses();
        if (el) setSor(Array.isArray(d) ? d : []);
      } catch (e) { if (el) setSor([]); }
    })();
    return () => { el = false; };
  }, []);

  if (!sor) return null;

  /* MI TŰNIK EL A KÁRTYÁRÓL
       A beküldés után a kérdőívnek azonnal el kell tűnnie a teendők közül.
       Három jelzésre támaszkodunk, mert egyik sem elég önmagában:
         1. c.submitted — a szerver részvételi naplója. Ez az elsődleges.
         2. az allapot már nem kitölthető ('kitoltve', 'lezart', stb.).
         3. van SAJÁT MÁSOLAT ebben a böngészőben — vagyis innen küldték be.
            Ez fogja meg azt a rést, amikor a beküldés megtörtént, de a
            részvételi napló frissítése még nem látszik a lekérdezésben:
            ilyenkor az allapot még 'folyamatban' lenne, és a kártya
            visszahozná egy már kitöltött kérdőívet. */
  const bekuldve = (c) => {
    if (c.submitted) return true;
    try {
      if (typeof ECHO_masolatGet === 'function'
          && ECHO_masolatGet(c.campaign_id, c.course_id)) return true;
    } catch (e) { /* a másolat hiánya nem hiba */ }
    return false;
  };

  /* KÉT FAJTA TEENDŐ
       ertekeles — a félév végi, névtelen kitöltés (nyitott kitöltési ablak);
       celok     — a félév eleji célmeghatározás, amíg a hallgató még nem adott
                   meg célt (nyitott célmeghatározási ablak, goals_saved = hamis).
     A célmeghatározás határideje a goals_close_at (68-as migráció); ha még
     nincs meg, a teendő határidő nélkül jelenik meg. */
  const ertekeles = sor
    .filter(c => c.is_open && !bekuldve(c) &&
      (c.allapot === 'kitoltheto' || c.allapot === 'folyamatban' || c.allapot === 'felbehagyott'))
    .map(c => ({ ...c, _mod: 'fill', _zar: c.closes_at }));
  const celok = sor
    .filter(c => c.is_goals_open && !c.goals_saved)
    .map(c => ({ ...c, _mod: 'goals', _zar: c.goals_close_at || null }));
  const teendo = ertekeles.concat(celok)
    .sort((a, b) => {
      // Ugyanaz a rangsor, mint a Kurzusértékelés listáján: elkezdett előbb,
      // aztán a közelebbi határidő. A kettő ne mondjon mást ugyanarról.
      const s = (x) => (x._mod === 'fill' && (x.has_draft || x.allapot === 'folyamatban' || x.allapot === 'felbehagyott')) ? 0 : 1;
      const h = (x) => { const t = Date.parse(x._zar || ''); return isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
      return (s(a) - s(b)) || (h(a) - h(b));
    });

  if (teendo.length === 0) return null;

  const indit = (c) => {
    try {
      sessionStorage.setItem('echo_megnyitando',
        JSON.stringify({ campaign_id: c.campaign_id, course_id: c.course_id, mod: c._mod }));
    } catch (e) { /* privát ablakban is működjön — ilyenkor csak a listáig visz */ }
    onNavigate && onNavigate(AppView.ECHO_STUDENT);
  };

  const napokMulva = (c) => {
    const t = Date.parse(c._zar || '');
    if (isNaN(t)) return null;
    return Math.ceil((t - Date.now()) / 86400000);
  };

  return (
    <div className="mb-6 bg-white rounded-3xl border border-primary/20 overflow-hidden shadow-sm">
      <div className="flex items-start gap-3 px-5 sm:px-6 py-4 bg-primary/5 border-b border-primary/10">
        <span className="w-9 h-9 rounded-2xl bg-primary/15 text-primary flex items-center justify-center flex-none">
          <Lucide.ClipboardList size={18} />
        </span>
        <div>
          <h3 className="text-[15px] font-black text-slate-900">
            {celok.length === 0
              ? (teendo.length === 1 ? 'Egy kérdőív vár rád' : teendo.length + ' kérdőív vár rád')
              : (teendo.length === 1 ? 'Egy teendő vár rád' : teendo.length + ' teendő vár rád')}
          </h3>
          <p className="text-[12px] text-slate-500 mt-0.5">
            {ertekeles.length === 0
              ? 'Oktatói munka véleményezése · a félév eleji céljaidat csak te látod'
              : 'Oktatói munka véleményezése · a kitöltés névtelen, a válaszaid nem köthetők vissza hozzád'}
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-50">
        {teendo.slice(0, 5).map(c => {
          const nap = napokMulva(c);
          const celMod = c._mod === 'goals';
          const elkezdte = !celMod && (c.has_draft || c.allapot === 'folyamatban' || c.allapot === 'felbehagyott');
          return (
            <div key={c.campaign_id + '|' + c.course_id + '|' + c._mod} data-feed-echo-teendo={c._mod}
              className="flex items-center justify-between gap-4 px-5 sm:px-6 py-3.5 flex-wrap">
              <div className="min-w-0">
                <span className="block text-sm font-bold text-slate-800 truncate">
                  {c.course_name}
                </span>
                <span className="block text-[11px] text-slate-400 mt-0.5">
                  <span className={'inline-flex items-center gap-1 font-bold mr-1.5 ' + (celMod ? 'text-sky-600' : 'text-primary')}>
                    {celMod ? <Lucide.Target size={11} /> : <Lucide.ClipboardList size={11} />}
                    {celMod ? 'Célmeghatározás' : 'Értékelés'}
                  </span>
                  {c.campaign_name}
                  {(c.campaign_ref_no || c.campaign_code) && typeof ECHO_KampanyId === 'function' ? <span className="ml-1.5"><ECHO_KampanyId sorszam={c.campaign_ref_no} kod={c.campaign_code} kicsi /></span> : null}
                  {nap != null && nap >= 0 && (
                    <span className={nap <= 3 ? ' text-amber-600 font-bold' : ''}>
                      {' · '}{nap === 0 ? 'ma zár' : nap + ' nap múlva zár'}
                    </span>
                  )}
                </span>
              </div>
              <button onClick={() => indit(c)}
                className={U_btnPrimary + ' flex-none py-2 px-4 text-[13px]'}>
                {celMod ? 'Célok megadása' : elkezdte ? 'Folytatás' : 'Kitöltés'}
                <Lucide.ArrowRight size={15} />
              </button>
            </div>
          );
        })}
      </div>

      {teendo.length > 5 && (
        <button onClick={() => onNavigate && onNavigate(AppView.ECHO_STUDENT)}
          className="w-full px-6 py-3 text-[12px] font-bold text-primary hover:bg-primary/5 transition-colors border-t border-slate-50">
          + még {teendo.length - 5} {celok.length ? 'teendő' : 'kérdőív'} — mutasd mind
        </button>
      )}
    </div>
  );
}

const FeedView = ({ user, onNavigate }) => {
  const [posts, setPosts] = useState(null);
  const [rsvps, setRsvps] = useState([]);
  const [tix, setTix] = useState([]);
  const [filter, setFilter] = useState('all');
  const [composer, setComposer] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  // A törlés megtagadható (72/73-as jogosultsági réteg) — ilyenkor a
  // párbeszéd nyitva marad, és kiírja, miért nem sikerült.
  const [torlesHiba, setTorlesHiba] = useState('');
  const [betoltesHiba, setBetoltesHiba] = useState('');
  /* Megtekintés-számlálók (70). Ha a migráció még nem futott le, a szám
     sehol nem jelenik meg — a hírfolyam enélkül is teljes értékű. */
  const [nezesek, setNezesek] = useState({});
  const [nezesVan, setNezesVan] = useState(true);
  const varoRef = useRef([]);
  const idoRef = useRef(null);

  const nezesHiba = (error) => {
    const m = ((error && error.message) || '') + ((error && error.code) || '');
    if (/feed_view_|schema cache|PGRST202/i.test(m)) setNezesVan(false);
  };

  const refetch = async () => {
    try {
    const [p, r, t] = await Promise.all([FEED_loadPosts(FEED_ugyintezo(user)), FEED_loadRsvps(), FEED_loadTix()]);
    setPosts(p); setRsvps(r); setTix(t);
    setBetoltesHiba('');
    const idk = (p || []).map(x => x && x.id).filter(Boolean).slice(0, 200);
    if (window.sb && idk.length) {
      try {
        const { data, error } = await window.sb.rpc('feed_view_counts', { p_posts: idk });
        if (error) nezesHiba(error); else if (data) setNezesek(prev => ({ ...prev, ...data }));
      } catch (e) { /* a szám hiánya nem állíthatja meg a hírfolyamot */ }
    }
    } catch (e) { setBetoltesHiba(e.message || 'A betöltés nem sikerült.'); }
  };
  useEffect(() => { refetch(); }, []);

  /* A látottá vált bejegyzéseket összegyűjtjük, és egy kéréssel naplózzuk —
     görgetés közben ne menjen kérés kártyánként. */
  const latta = React.useCallback((id) => {
    if (!window.sb || !id) return;
    if (varoRef.current.indexOf(id) < 0) varoRef.current.push(id);
    if (idoRef.current) clearTimeout(idoRef.current);
    idoRef.current = setTimeout(async () => {
      const idk = varoRef.current.slice(0, 200); varoRef.current = [];
      if (!idk.length) return;
      try {
        const { data, error } = await window.sb.rpc('feed_view_log', { p_posts: idk });
        if (error) nezesHiba(error); else if (data) setNezesek(prev => ({ ...prev, ...data }));
      } catch (e) { /* csendben: a számláló nem kritikus */ }
    }, 900);
  }, []);
  useEffect(() => () => { if (idoRef.current) clearTimeout(idoRef.current); }, []);

  const firstName = ((user && user.name) || '').split(' ').slice(-1)[0] || (user && user.name) || 'there';
  const filtered = (posts || []).filter(p => filter === 'all' || p.type === filter);
  const ordered = [...filtered].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.created_at) - new Date(a.created_at));

  const chips = [['all', 'Összes'], ...Object.entries(FEED_TYPES).map(([k, m]) => [k, m.label])];

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-in fade-in duration-500">
      {betoltesHiba && <div role="alert" className="mb-4 rounded-xl bg-red-50 p-4 text-red-700">{betoltesHiba}</div>}
      {/* hero */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">Kampusz hírfolyam</p>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Üdv újra itt, {firstName} 👋</h1>
          <p className="text-slate-400 mt-1 font-medium">Hírek, ajánlatok, események és határidők az egyetemtől.</p>
        </div>
        {FEED_szerkeszto(user) && <button className={U_btnPrimary} onClick={() => setComposer(true)}><Lucide.Plus size={17} /> Új bejegyzés</button>}
      </div>

      {/* Kitöltendő kérdőívek — a hírfolyam bejegyzései ELŐTT, mert ez teendő,
          nem hír. Ha nincs, a komponens nem renderel semmit. */}
      <FEED_EchoTeendok onNavigate={onNavigate} />

      {/* filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 mb-6 -mx-1 px-1 custom-scrollbar">
        {chips.map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} className={'flex-none px-4 py-2 rounded-full text-[13px] font-bold transition-all ' + (filter === k ? 'bg-slate-900 text-white' : 'bg-white border border-slate-100 text-slate-500 hover:border-slate-300')}>{label}</button>
        ))}
      </div>

      {posts === null ? (
        <div className="space-y-4">{[0, 1, 2].map(i => <div key={i} className="h-52 rounded-3xl bg-white border border-slate-100 animate-pulse" />)}</div>
      ) : ordered.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100"><UEmpty icon={<Lucide.Newspaper size={26} />} title="Itt még nincs semmi" subtitle={FEED_szerkeszto(user) ? 'Tedd közzé az első bejegyzést, hogy elinduljon a hírfolyam.' : 'Nézz vissza hamarosan a hírekért és eseményekért.'} action={FEED_szerkeszto(user) ? <button className={U_btnPrimary} onClick={() => setComposer(true)}><Lucide.Plus size={16} /> Új bejegyzés</button> : null} /></div>
      ) : (
        <div className="space-y-5">
          {ordered.map(p => (
            <FeedCard key={p.id} post={p} user={user} rsvps={rsvps} tix={tix} onChange={refetch} onDelete={setConfirmDel}
              nezes={nezesVan && nezesek[p.id] != null ? nezesek[p.id] : null} onLatta={nezesVan ? latta : null} />
          ))}
        </div>
      )}

      <FeedComposer open={composer} onClose={() => setComposer(false)} onPublished={refetch} authorName={user && user.name} />
      <UModal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="Törlöd a bejegyzést?" icon={<Lucide.Trash2 size={20} />} max="max-w-md">
        <p className="text-sm text-slate-500">Ezzel a(z) „{confirmDel && confirmDel.title}” bejegyzés mindenki hírfolyamából eltűnik.</p>
        {torlesHiba && (
          <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-3 py-2 text-[13px] font-semibold">
            <Lucide.AlertCircle size={14} className="mt-0.5 flex-none" />
            <span className="flex-1">{torlesHiba}</span>
          </div>
        )}
        <div className="flex justify-end gap-3 mt-6">
          <button className={U_btnGhost} onClick={() => { setTorlesHiba(''); setConfirmDel(null); }}>Mégse</button>
          <button className={U_btn + ' bg-red-500 text-white px-5 py-3 hover:bg-red-600'}
            onClick={async () => {
              // A dlDelete megtagadás esetén dob: a párbeszéd maradjon nyitva,
              // és mondja meg, mi történt — ne tűnjön el „sikeresen".
              try { await dlDelete(FEED_TABLE, confirmDel.id, FEED_LS); }
              catch (e) { setTorlesHiba((e && e.message) || 'A törlés nem sikerült.'); return; }
              setTorlesHiba(''); setConfirmDel(null); refetch();
            }}>Törlés</button>
        </div>
      </UModal>
    </div>
  );
};
