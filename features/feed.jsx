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

const FEED_loadPosts = () => dlSelect(FEED_TABLE, FEED_LS, FEED_seed, 'created_at', false);
const FEED_loadRsvps = () => dlSelect(RSVP_TABLE, RSVP_LS, () => [], 'created_at', false);
const FEED_loadTix = () => dlSelect(TIX_TABLE, TIX_LS, () => [], 'created_at', false);

function FEED_img(url, className, alt) {
  return <img src={url} alt={alt || ''} loading="lazy" className={className} referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
}

/* ---------- Admin composer ---------- */
function FeedComposer({ open, onClose, onPublished, authorName }) {
  const empty = { type: 'news', title: '', body: '', image_url: '', gallery: '', promo_code: '', discount: '', event_date: '', event_location: '', capacity: '', ticket_code: '', cta_label: '', cta_href: '', pinned: false };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  useEffect(() => { if (open) setF(empty); }, [open]);

  const uploadImg = async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const dataUrl = await KB_readFileAsDataUrl(file); set('image_url', dataUrl);
  };
  const publish = async () => {
    if (!f.title.trim()) return;
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
    await dlInsert(FEED_TABLE, row, FEED_LS);
    setBusy(false); onPublished && onPublished(); onClose();
  };

  const typeBtns = Object.entries(FEED_TYPES);
  const show = (keys) => keys.includes(f.type);
  return (
    <UModal open={open} onClose={onClose} title="Új hírfolyam-bejegyzés" subtitle="Minden belépő felhasználó látja" icon={<Lucide.PenSquare size={20} />} max="max-w-2xl">
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

        <label className="flex items-center gap-2.5 text-sm font-bold text-slate-600 cursor-pointer">
          <input type="checkbox" checked={f.pinned} onChange={e => set('pinned', e.target.checked)} className="w-4 h-4 accent-primary" /> Kiemelés a hírfolyam tetejére
        </label>
        <div className="flex justify-end gap-3 pt-2">
          <button className={U_btnGhost} onClick={onClose}>Mégse</button>
          <button className={U_btnPrimary} disabled={busy || !f.title.trim()} onClick={publish}>{busy ? 'Közzététel…' : 'Bejegyzés közzététele'}</button>
        </div>
      </div>
    </UModal>
  );
}

/* ---------- individual post card ---------- */
function FeedCard({ post, user, rsvps, tix, onChange, onDelete }) {
  const meta = FEED_TYPES[post.type] || FEED_TYPES.news;
  const I = meta.icon;
  const [copied, setCopied] = useState(false);
  const myEmail = user && user.email;
  const attendees = rsvps.filter(r => r.post_id === post.id);
  const iRsvped = attendees.some(r => r.email === myEmail);
  const myTix = tix.find(t => t.post_id === post.id && t.email === myEmail);

  const copy = (txt) => { try { navigator.clipboard.writeText(txt); } catch (e) {} setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const toggleRsvp = async () => {
    if (iRsvped) { const mine = attendees.find(r => r.email === myEmail); if (mine) await dlDelete(RSVP_TABLE, mine.id, RSVP_LS); }
    else { await dlInsert(RSVP_TABLE, { id: uid('RS'), post_id: post.id, email: myEmail, name: user.name, created_at: new Date().toISOString() }, RSVP_LS); }
    onChange && onChange();
  };
  const claim = async () => {
    if (myTix) return;
    await dlInsert(TIX_TABLE, { id: uid('TX'), post_id: post.id, email: myEmail, code: post.ticket_code || ('NJE-' + Math.random().toString(36).slice(2, 8).toUpperCase()), created_at: new Date().toISOString() }, TIX_LS);
    onChange && onChange();
  };
  const dleft = DL_daysLeft(post.event_date);

  return (
    <article className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
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
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 font-bold">{DL_date(post.created_at)}</span>
            {isAdmin(user) && <button onClick={() => onDelete(post)} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 transition-colors" title="Törlés"><Lucide.Trash2 size={14} /></button>}
          </div>
        </div>

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
        {post.cta_label && post.cta_href && (
          <a href={post.cta_href} target="_blank" rel="noreferrer" className={U_btnGhost + ' mt-4'}>{post.cta_label} <Lucide.ArrowUpRight size={15} /></a>
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

  const teendo = sor
    .filter(c => c.is_open && !bekuldve(c) &&
      (c.allapot === 'kitoltheto' || c.allapot === 'folyamatban' || c.allapot === 'felbehagyott'))
    .sort((a, b) => {
      // Ugyanaz a rangsor, mint a Kurzusértékelés listáján: elkezdett előbb,
      // aztán a közelebbi határidő. A kettő ne mondjon mást ugyanarról.
      const s = (x) => (x.has_draft || x.allapot === 'folyamatban' || x.allapot === 'felbehagyott') ? 0 : 1;
      const h = (x) => { const t = Date.parse(x.closes_at || ''); return isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
      return (s(a) - s(b)) || (h(a) - h(b));
    });

  if (teendo.length === 0) return null;

  const indit = (c) => {
    try {
      sessionStorage.setItem('echo_megnyitando',
        JSON.stringify({ campaign_id: c.campaign_id, course_id: c.course_id }));
    } catch (e) { /* privát ablakban is működjön — ilyenkor csak a listáig visz */ }
    onNavigate && onNavigate(AppView.ECHO_STUDENT);
  };

  const napokMulva = (c) => {
    const t = Date.parse(c.closes_at || '');
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
            {teendo.length === 1 ? 'Egy kérdőív vár rád' : teendo.length + ' kérdőív vár rád'}
          </h3>
          <p className="text-[12px] text-slate-500 mt-0.5">
            Oktatói munka véleményezése · a kitöltés névtelen, a válaszaid nem köthetők vissza hozzád
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-50">
        {teendo.slice(0, 5).map(c => {
          const nap = napokMulva(c);
          const elkezdte = c.has_draft || c.allapot === 'folyamatban' || c.allapot === 'felbehagyott';
          return (
            <div key={c.campaign_id + '|' + c.course_id}
              className="flex items-center justify-between gap-4 px-5 sm:px-6 py-3.5 flex-wrap">
              <div className="min-w-0">
                <span className="block text-sm font-bold text-slate-800 truncate">
                  {c.course_name}
                </span>
                <span className="block text-[11px] text-slate-400 mt-0.5">
                  {c.campaign_name}
                  {c.campaign_code && typeof ECHO_KampanyId === 'function' ? <span className="ml-1.5"><ECHO_KampanyId kod={c.campaign_code} kicsi /></span> : null}
                  {nap != null && nap >= 0 && (
                    <span className={nap <= 3 ? ' text-amber-600 font-bold' : ''}>
                      {' · '}{nap === 0 ? 'ma zár' : nap + ' nap múlva zár'}
                    </span>
                  )}
                </span>
              </div>
              <button onClick={() => indit(c)}
                className={U_btnPrimary + ' flex-none py-2 px-4 text-[13px]'}>
                {elkezdte ? 'Folytatás' : 'Kitöltés'}
                <Lucide.ArrowRight size={15} />
              </button>
            </div>
          );
        })}
      </div>

      {teendo.length > 5 && (
        <button onClick={() => onNavigate && onNavigate(AppView.ECHO_STUDENT)}
          className="w-full px-6 py-3 text-[12px] font-bold text-primary hover:bg-primary/5 transition-colors border-t border-slate-50">
          + még {teendo.length - 5} kérdőív — mutasd mind
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

  const refetch = async () => {
    const [p, r, t] = await Promise.all([FEED_loadPosts(), FEED_loadRsvps(), FEED_loadTix()]);
    setPosts(p); setRsvps(r); setTix(t);
  };
  useEffect(() => { refetch(); }, []);

  const firstName = ((user && user.name) || '').split(' ').slice(-1)[0] || (user && user.name) || 'there';
  const filtered = (posts || []).filter(p => filter === 'all' || p.type === filter);
  const ordered = [...filtered].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.created_at) - new Date(a.created_at));

  const chips = [['all', 'Összes'], ...Object.entries(FEED_TYPES).map(([k, m]) => [k, m.label])];

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-in fade-in duration-500">
      {/* hero */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">Kampusz hírfolyam</p>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Üdv újra itt, {firstName} 👋</h1>
          <p className="text-slate-400 mt-1 font-medium">Hírek, ajánlatok, események és határidők az egyetemtől.</p>
        </div>
        {isAdmin(user) && <button className={U_btnPrimary} onClick={() => setComposer(true)}><Lucide.Plus size={17} /> Új bejegyzés</button>}
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
        <div className="bg-white rounded-3xl border border-slate-100"><UEmpty icon={<Lucide.Newspaper size={26} />} title="Itt még nincs semmi" subtitle={isAdmin(user) ? 'Tedd közzé az első bejegyzést, hogy elinduljon a hírfolyam.' : 'Nézz vissza hamarosan a hírekért és eseményekért.'} action={isAdmin(user) ? <button className={U_btnPrimary} onClick={() => setComposer(true)}><Lucide.Plus size={16} /> Új bejegyzés</button> : null} /></div>
      ) : (
        <div className="space-y-5">
          {ordered.map(p => <FeedCard key={p.id} post={p} user={user} rsvps={rsvps} tix={tix} onChange={refetch} onDelete={setConfirmDel} />)}
        </div>
      )}

      <FeedComposer open={composer} onClose={() => setComposer(false)} onPublished={refetch} authorName={user && user.name} />
      <UModal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="Törlöd a bejegyzést?" icon={<Lucide.Trash2 size={20} />} max="max-w-md">
        <p className="text-sm text-slate-500">Ezzel a(z) „{confirmDel && confirmDel.title}” bejegyzés mindenki hírfolyamából eltűnik.</p>
        <div className="flex justify-end gap-3 mt-6">
          <button className={U_btnGhost} onClick={() => setConfirmDel(null)}>Mégse</button>
          <button className={U_btn + ' bg-red-500 text-white px-5 py-3 hover:bg-red-600'} onClick={async () => { await dlDelete(FEED_TABLE, confirmDel.id, FEED_LS); setConfirmDel(null); refetch(); }}>Törlés</button>
        </div>
      </UModal>
    </div>
  );
};
