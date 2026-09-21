/* ============================================================
   UniPortal Pro — ECHO (OMHV) 1. + 2. szelet
   Oktatói munka hallgatói véleményezése — Neumann János Egyetem,
   28/2023. szenátusi határozat.

   (az app.jsx moduljába fűzve — NINCS import és NINCS export;
    React, hookok, Lucide, window.sb, valamint a data-layer.jsx
    UI-atomjai (UBadge, UModal, UEmpty, UField, U_input, U_btnPrimary,
    U_btnGhost, UToast) és az app.jsx töltő-komponensei
    (SkeletonBar, SkeletonRows, RefreshingBadge) a scope-ban vannak.)

   MIT CSINÁL EZ A FÁJL
     • ECHO_api            — vékony réteg a public sémás ECHO RPC-k fölé
     • ECHO_StudentView    — hallgatói kurzuslista + célmeghatározó + kitöltő varázsló
     • ECHO_AdminView      — MIR/admin, HÁROM FÜLLEL:
         – ECHO_CampaignsPanel  kampányok, kitöltési arány, kizárási napló (1. szelet)
         – ECHO_Editor          kérdőívszerkesztő: sablon/verzió, állapotgép,
                                szakasz- és kérdés-CRUD, élő előnézet, ellenőrző lista
         – ECHO_ModerationView  moderálási sor a 3. § (10) indok-katalógusával
     • ECHO_TeacherView    — oktatói eredménynézet: arány, kérdésenkénti eredmény,
                             k-küszöbök melletti ŐSZINTE üres állapotok

   AMIT NEM CSINÁL (tudatosan, a következő körre marad)
     • ECHO saját szerepkör-dimenzió (ECHO_MIR / ECHO_DEKAN / OKTATO): ma minden
       admin oldali RPC public.is_admin()-hoz kötött, és echo.teacher.profile_id
       minden soron NULL — mérve a helyi replikán
     • kari szűkítés ("csak a saját kar"): az echo.org_unit fa megvan, a
       where-feltétel nincs

   A KÉRDÉSEK NEM ITT VANNAK. A varázsló a template_version.compiled JSONB-ből
   generálódik, amit az echo_get_form() változatlanul ad vissza. Ha ide bármikor
   bekerülne egy kérdésszöveg, az azt jelentené, hogy a felület és a szenátus
   által jóváhagyott kérdőív szétcsúszhat — pontosan ezt kerüljük.
   ============================================================ */

/* ------------------------------------------------------------
   0. Nyelv és adat-eredetű szöveg
   ------------------------------------------------------------ */

/* A hírfolyam „Kitöltés" gombja ezen a kulcson adja át, melyik kurzust
   akarta a hallgató. sessionStorage: a lapfülhöz kötött, és magától elmúlik —
   nem akarunk tartós nyomot hagyni arról, ki mire készül. */
const ECHO_ATADAS_KULCS = 'echo_megnyitando';

/* ============================================================
   A HALLGATÓ SAJÁT MÁSOLATA A BEKÜLDÖTT VÁLASZAIRÓL

   MIÉRT NEM A SZERVERRŐL JÖN
     Mert onnan NEM JÖHET. A beküldött válasz szándékosan nem köthető vissza
     a hallgatóhoz, három egymást erősítő rétegben — MÉRVE:
       1. az echo.response táblában EGYETLEN oszlop sincs, ami a hallgatóra
          mutatna (campaign, course, teacher, template_version, scope,
          attendance_band, answers — és semmi más);
       2. a beküldés külön, munkamenet nélküli anon klienssel megy, tehát a
          JWT el sem jut a szerverig (lásd ECHO_anonClient);
       3. a beküldés után az echo.shuffle_responses() fizikailag újrarendezi
          a sorokat, hogy még a beszúrási sorrend se áruljon el semmit.
     Ha ezt a másolatot a szerveren tárolnánk a hallgatóhoz kötve, mind a
     három réteg értelmét vesztené: aki az adatbázist látja, össze tudná
     párosítani a nevet a válasszal. Ezért a másolat KIZÁRÓLAG a hallgató
     saját böngészőjében él.

   MIT JELENT EZ A HALLGATÓNAK
     A másolat az ő gépén, az ő böngészőjében marad. Másik gépen, másik
     böngészőben, vagy a böngészőadatok törlése után NEM lesz meg. Ezt a
     felület KIMONDJA — nem hagyjuk abban a hitben, hogy a rendszer őrzi.
   ============================================================ */
const ECHO_MASOLAT_KULCS = 'echo_valaszaim';
/* A MÁSOLAT FELHASZNÁLÓHOZ KÖTÖTT. Korábban egyetlen közös kulcs alatt élt, ezért
   közös gépen a következő bejelentkező hallgató az előző hallgató másolatát kapta:
   a kurzust „Kész”-nek látta, és nem tudta kitölteni (hibajelentés, 2026-09-16).
   Az azonosítót a bejelentkezett munkamenetből olvassuk ki, SZINKRON — a hírfolyam
   kártyája (feed.jsx) a Kurzusértékelés nézet előtt fut, onnan is ez hívódik.
   Ha nincs bejelentkezett felhasználó, nincs másolat sem (sem olvasás, sem írás). */
let ECHO__masolatUid = null;
function ECHO_masolatUidBeallit(uid) { ECHO__masolatUid = uid || null; }
function ECHO_aktualisUid() {
  if (ECHO__masolatUid) return ECHO__masolatUid;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^sb-.+-auth-token$/.test(k)) {
        const s = JSON.parse(localStorage.getItem(k) || 'null');
        const u = (s && s.user) || (s && s.currentSession && s.currentSession.user);
        if (u && u.id) return u.id;
      }
    }
  } catch (e) {}
  return null;
}
function ECHO_masolatTarolo() { const uid = ECHO_aktualisUid(); return uid ? ECHO_MASOLAT_KULCS + ':' + uid : null; }

function ECHO_masolatMind() {
  const k = ECHO_masolatTarolo();
  if (!k) return {};
  try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; }
  catch (e) { return {}; }
}

function ECHO_masolatKulcs(campaignId, courseId) { return campaignId + '|' + courseId; }

function ECHO_masolatGet(campaignId, courseId) {
  const m = ECHO_masolatMind();
  return m[ECHO_masolatKulcs(campaignId, courseId)] || null;
}

/* Olvasható kérdés–válasz párokat épít a kitöltésből. A nyers payload
   kulcs-érték párjai a hallgatónak semmit nem mondanának. */
function ECHO_masolatTetelek(compiled, teachers, ans, tans, lang) {
  const ki = [];
  const opcioCimke = (q, v) => {
    const o = (q.options || []).find(x => String(x.value) === String(v));
    return o ? ECHO_txt(o, lang) : String(v);
  };
  const ertek = (q, v) => {
    if (v === undefined || v === null || v === '') return null;
    if (Array.isArray(v)) return v.length ? v.map(x => opcioCimke(q, x)).join(', ') : null;
    if (q.type === 'single' || q.type === 'multi' || q.type === 'skip') return opcioCimke(q, v);
    return String(v);
  };

  ((compiled && compiled.sections) || []).forEach(sec => {
    const szakasz = ECHO_txt(sec, lang);
    (sec.questions || []).forEach(q => {
      if (ECHO_repTeacher(q)) {
        // Oktatónként külön válasz — az oktató nevével együtt mentjük.
        (teachers || []).forEach(t => {
          const v = (tans && tans[t.id]) ? tans[t.id][q.id] : undefined;
          const e = ertek(q, v);
          if (e !== null) ki.push({ szakasz, kerdes: ECHO_txt(q, lang), kire: t.name, valasz: e });
        });
        return;
      }
      if (q.repeat) return;             // célonkénti ismétlés — összevontan megy be
      const e = ertek(q, ans ? ans[q.id] : undefined);
      if (e !== null) ki.push({ szakasz, kerdes: ECHO_txt(q, lang), valasz: e });
    });
  });
  return ki;
}

function ECHO_masolatMent(course, compiled, teachers, ans, tans, lang) {
  try {
    const m = ECHO_masolatMind();
    m[ECHO_masolatKulcs(course.campaign_id, course.course_id)] = {
      mentve:  new Date().toISOString(),
      kurzus:  course.course_name,
      kod:     course.course_code,
      kampany: course.campaign_name,
      tetelek: ECHO_masolatTetelek(compiled, teachers, ans, tans, lang),
    };
    const k = ECHO_masolatTarolo();
    if (!k) return false;
    localStorage.setItem(k, JSON.stringify(m));
    return true;
  } catch (e) {
    // Privát ablak, tele tárhely, letiltott sütik — a beküldés ettől még
    // sikeres volt, ezért NEM dobunk hibát. Csak nem lesz másolat.
    return false;
  }
}

// A fejléc nyelvváltója ezt a kulcsot írja (app.jsx setupI18n).
function ECHO_lang() {
  try { return (localStorage.getItem('nje_lang') || 'hu') === 'en' ? 'en' : 'hu'; }
  catch (e) { return 'hu'; }
}

// hu/en mezőpár feloldása egy compiled-objektumon.
function ECHO_txt(o, lang) {
  if (!o) return '';
  if (lang === 'en' && o.en) return o.en;
  return o.hu || o.en || '';
}

/* A KÉRDŐÍV NYELVE — 3. § (1): a hallgató a KÉPZÉS nyelvén kapja a kérdőívet.
   Ez NEM ugyanaz, mint a fejléc nyelvválasztója (ECHO_lang): a felület kerete
   maradhat a felhasználó nyelvén, a szenátus által jóváhagyott kérdés- és
   opciószövegek viszont a kurzuséhoz kötöttek. Két hallgató ugyanazon a
   kurzuson ugyanazt a kérdést kell hogy lássa — különben a válaszaik nem
   ugyanarra a kérdésre adott válaszok.

   A kurzus nyelve az echo.course.lang oszlopból jön, az echo_get_form()
   'course'.'lang' mezőjén. Ha hiányzik, magyar. */
function ECHO_courseLang(course) {
  const raw = String((course && course.lang) || '').trim().toLowerCase();
  if (raw === 'en' || raw.indexOf('angol') >= 0 || raw.indexOf('english') >= 0) return 'en';
  return 'hu';
}

/* Van-e a kérdőívnek használható fordítása az adott nyelven.
   AZ ÉLESÍTÉS-ELŐTTI ELLENŐRZÉS EZT MÁR GARANTÁLJA: az echo.template_validate()
   'hianyzo_angol_szakaszcim' / 'hianyzo_angol_forditas' / 'hianyzo_angol_opcio'
   kóddal HIBÁT ad, és az echo_template_transition() élesítéskor ezt kikényszeríti
   — vagyis egy 'live' verzióban minden szakasznak, kérdésnek és opciónak VAN
   angol szövege. Ez a függvény tehát nem a normál út, hanem védőháló: a
   szerkesztő előnézetében és a régi (1. verziós, még a validátor előtti)
   kérdőíveknél előfordulhat hiányzó fordítás, és ilyenkor jobb magyarul
   megmutatni a kérdést, mint üresen. */
function ECHO_hasTranslation(form, lang) {
  if (lang !== 'en') return true;                     // magyarul mindig van
  const secs = (form && Array.isArray(form.sections)) ? form.sections : [];
  if (!secs.length) return true;                      // nincs mit fordítani
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    if (!String(sec.en || '').trim()) return false;
    const qs = Array.isArray(sec.questions) ? sec.questions : [];
    for (let j = 0; j < qs.length; j++) {
      if (!String(qs[j].en || '').trim()) return false;
    }
  }
  return true;
}

/* A kitöltő tényleges nyelve. A kurzusé dönt; ha azon a nyelven nincs
   fordítás, magyarra esünk vissza. A visszaesés TÉNYE is kell a hívónak,
   hogy a felület megmondhassa a hallgatónak, miért magyarul látja. */
function ECHO_formLang(course, form) {
  const want = ECHO_courseLang(course);
  return ECHO_hasTranslation(form, want) ? want : 'hu';
}
function ECHO_langFellBack(course, form) {
  return ECHO_courseLang(course) !== ECHO_formLang(course, form);
}

/* ADATBÓL JÖVŐ SZÖVEG BURKA.
   Az app.jsx-ben futó HU→EN fordító EN módban a DOM szövegcsomópontjait írja
   át reguláris kifejezésekkel. A kérdőív kérdés- és opciószövegei adatból
   jönnek és a szenátus hagyta jóvá — ezeket gépi átírás nem érintheti, mert
   az már nem a jóváhagyott kérdőív lenne. Minden ilyen szöveg ebbe a burokba
   kerül; a fordító acceptNode/SKIP ága a [data-echo-noi18n] részfát elutasítja. */
const ECHO_Src = ({ children, className = '' }) => (
  <span data-echo-noi18n className={className}>{children}</span>
);

/* ------------------------------------------------------------
   1. ECHO_api — vékony réteg a public sémás RPC-k fölé
   ------------------------------------------------------------
   A szignatúrák a 15_echo_core.sql 9. szakaszából valók, betű szerint:
     public.echo_my_courses()
     public.echo_get_form(p_campaign uuid, p_course uuid)
     public.echo_save_goals(p_campaign uuid, p_course uuid, p_goals jsonb, p_expectations jsonb)
     public.echo_issue_ticket(p_campaign uuid, p_course uuid)
     public.echo_submit(p_ticket text, p_payload jsonb)      -- CSAK anon joggal
     public.echo_campaigns()
     public.echo_rate(p_campaign uuid)
     public.echo_rebuild_eligibility(p_campaign uuid)
   A kliens az 'echo' sémát SOHA nem éri el közvetlenül: nincs rá USAGE joga.
   ------------------------------------------------------------ */

// A szerver oldali hibakódok emberi szövege. Ami nincs a listán, azt
// nyersen mutatjuk — jobb egy ismeretlen kód, mint egy hazug üzenet.
const ECHO_ERR = {
  ECHO_NOT_AUTHENTICATED:  'Nincs bejelentkezve.',
  ECHO_NOT_APPROVED:       'A fiókod még nincs jóváhagyva.',
  ECHO_NOT_ELIGIBLE:       'Ez a kurzus nem véleményezhető ezzel a fiókkal.',
  ECHO_CAMPAIGN_NOT_READY: 'A kampány még nem indult el.',
  ECHO_CAMPAIGN_CLOSED:    'A kitöltési ablak zárva van.',
  ECHO_GOALS_CLOSED:       'A célmeghatározási ablak zárva van.',
  ECHO_TOO_MANY_GOALS:     'Legfeljebb 3 cél és 3 elvárás adható meg.',
  /* --- 23_echo_form_rules.sql (1. fázis) hibakódjai --- */
  ECHO_GOALS_REQUIRED:     'Legalább egy célt meg kell fogalmaznod.',
  ECHO_INTRO_REQUIRED:     'A célmeghatározás bevezető kérdéseire válaszolni kell.',
  ECHO_BAD_INTRO:          'A bevezető kérdésekre adott válasz érvénytelen.',
  ECHO_OTHER_TEXT_REQUIRED:'Az „Egyéb" válasz mellé szöveget is meg kell adni.',
  ECHO_BAD_PAYLOAD:        'A beküldött adat szerkezete hibás.',
  ECHO_BAD_GOALS_MET:      'A célteljesülés értéke érvénytelen.',
  ECHO_PAYLOAD_TOO_LARGE:  'A kitöltés túl hosszú — kérjük, rövidítsd a szöveges válaszokat.',
  ECHO_ALREADY_SUBMITTED:  'Ezt a kurzust már értékelted.',
  ECHO_TICKET_EXPIRED:     'A kitöltési jegy lejárt. Kezdd elölről — a válaszaid megmaradtak.',
  ECHO_TICKET_SPENT:       'Ezt a jegyet már felhasználtuk. Az értékelés valószínűleg beérkezett.',
  ECHO_TICKET_BADSIG:      'A kitöltési jegy érvénytelen.',
  ECHO_TICKET_INVALID:     'A kitöltési jegy sérült vagy hiányos. Kérjük, kezdd elölről.',
  ECHO_TICKET_LIMIT:       'Ehhez a kurzushoz már nem kérhető újabb kitöltési jegy.',
  ECHO_TEACHER_NOT_ELIGIBLE: 'Az egyik oktató nem véleményezhető ebben a kampányban.',

  /* --- 16_echo_reports.sql (2. szelet) hibakódjai --- */
  // A results_gate() dobja. A teljes üzenet felsorolja az engedett állapotokat,
  // ezért a nyers szöveget IS megmutatjuk mellette (lásd ECHO_msg alább).
  ECHO_RESULTS_NOT_READY:  'A kampány jelenlegi állapotában nem jeleníthető meg eredmény.',
  ECHO_CAMPAIGN_NOT_FOUND: 'A kampány nem található.',
  ECHO_TEMPLATE_MISSING:   'A kampányhoz nincs kérdőív-verzió rendelve.',
  ECHO_RESPONSE_NOT_FOUND: 'A válasz nem található.',
  ECHO_BAD_REASON:         'Ismeretlen érvénytelenségi indok-kód.',
  ECHO_REASON_REQUIRED:    'Érvénytelenné nyilvánításhoz indokot kell választani (3. § (10)).',
  ECHO_VERSION_NOT_FOUND:  'A kérdőív-verzió nem található.',
  ECHO_SOURCE_NOT_FOUND:   'A klónozás forrásverziója nem található.',
  ECHO_NAME_REQUIRED:      'A sablon/verzió nevét meg kell adni.',
  ECHO_NOT_DRAFT:          'Csak piszkozat állapotban lehet menteni. Készíts új verziót.',
  ECHO_NAME_EMPTY:         'A kérdőív neve nem lehet üres.',
  ECHO_NAME_TOO_LONG:      'A kérdőív neve legfeljebb 120 karakter lehet.',
  ECHO_BAD_COMPILED:       'A kérdőív szerkezete hibás (nem JSON objektum).',
  ECHO_VALIDATION_FAILED:  'Az élesítés előtti ellenőrzés hibát talált — élesítés nem engedélyezett.',
  ECHO_BAD_STATE:          'Ismeretlen célállapot.',

  /* --- 19_echo_roles.sql (0.4 szelet) hibakódjai --- */
  // Az ECHO_FORBIDDEN itt HÁROM különböző okot takarhat (nincs kötés / nincs
  // grant / nem a te kurzusod), ezért a nyers magyarázatot is kiírjuk — lásd
  // ECHO_ERR_VERBOSE alább.
  ECHO_TEACHER_NOT_FOUND:  'Ez az oktatói sor nem található.',
  ECHO_PROFILE_NOT_FOUND:  'Ez a fiók nem található.',
  ECHO_PROFILE_TAKEN:      'Ez a fiók már egy másik oktatói sorhoz van kötve.',
  ECHO_ORG_NOT_FOUND:      'A megadott szervezeti egység nem található.',
  ECHO_BAD_ROLE:           'Ismeretlen ECHO-szerepkör.',
  ECHO_PREREQ_MISSING:     'Az ECHO szerepkör-migráció (19_echo_roles.sql) még nem futott le.',

  ECHO_FORBIDDEN:          'Ehhez nincs jogosultságod.',
};

// Néhány szerverhiba a KÓDON TÚL is hordoz információt (melyik állapotban
// lenne látható az eredmény, hány ellenőrzési hiba van). Ezeknél a nyers
// szöveget is kiírjuk — az emberi mondat önmagában kevesebbet mondana.
const ECHO_ERR_VERBOSE = ['ECHO_RESULTS_NOT_READY', 'ECHO_VALIDATION_FAILED', 'ECHO_NOT_DRAFT',
  // Ezek a szerveren MEGMONDJAK, melyik kerdesnel/mezonel bukott el.
  'ECHO_OTHER_TEXT_REQUIRED', 'ECHO_INTRO_REQUIRED', 'ECHO_BAD_INTRO',
  // Az ECHO_FORBIDDEN a 19-es óta MEGMONDJA, mi hiányzik: a kötés, a grant, vagy
  // a kurzus a másé. Enélkül a felhasználó csak annyit látna, hogy "nem szabad".
  'ECHO_FORBIDDEN', 'ECHO_PROFILE_TAKEN', 'ECHO_BAD_ROLE'];

function ECHO_msg(e) {
  const raw = (e && (e.message || e.error_description || e.hint)) || '';
  const code = Object.keys(ECHO_ERR).find(k => raw.indexOf(k) >= 0);
  if (code) {
    if (ECHO_ERR_VERBOSE.indexOf(code) >= 0) {
      // A ': ' utáni rész a szerver saját, számított magyarázata.
      const tail = raw.slice(raw.indexOf(code) + code.length).replace(/^\s*:\s*/, '').trim();
      return tail ? ECHO_ERR[code] + ' ' + tail : ECHO_ERR[code];
    }
    return ECHO_ERR[code];
  }
  if (/function .*echo_/i.test(raw) || /schema cache/i.test(raw)) {
    /* Nevezzük meg a HELYES migrációt: a „telepítsd a 15-öst" üzenet félrevezet,
       ha valójában egy későbbi csomag hiányzik. */
    if (/echo_results_raw|echo_campaign_filters/i.test(raw)) {
      return 'Az adminisztrátori nyers nézet még nincs telepítve. '
           + 'Futtatni kell a supabase/56_admin_results_control.sql migrációt.';
    }
    if (/echo_teacher_(list|get|save|set_active|course_set|options|delete)/i.test(raw)) {
      return 'Az oktatói nyilvántartás még nincs telepítve '
           + '(supabase/54_teacher_registry.sql).';
    }
    return 'Az ECHO adatbázis-rész még nincs telepítve (15_echo_core.sql).';
  }
  return raw || 'Ismeretlen hiba.';
}

// Az azonosított hívások a szokásos, bejelentkezett klienssel mennek.
async function ECHO_rpc(fn, args) {
  if (!window.sb) throw new Error('Nincs kapcsolat a háttérrendszerrel.');
  const { data, error } = await window.sb.rpc(fn, args || {});
  if (error) throw error;
  return data;
}

/* AZ ANONIM KLIENS — ez a fájl legfontosabb néhány sora.

   Miért nem a window.sb-vel küldjük be a kitöltést:
   a window.sb minden kérésre ráteszi a bejelentkezett hallgató JWT-jét az
   Authorization fejlécbe. Az echo_submit SECURITY DEFINER, tehát a JWT-t nem
   HASZNÁLJA — de a kérés akkor is átvinné a hallgató azonosítóját ugyanabban a
   HTTP-kérésben, amelyben a válaszai utaznak. Ettől kezdve a kettő összekötése
   már csak naplózás kérdése (edge proxy log, WAF, hibakövető), és a rendszer
   anonimitása nem az adatmodellen, hanem az üzemeltető jóindulatán múlna.
   Ezért a beküldés SAJÁT, munkamenet nélküli klienssel megy: persistSession és
   autoRefreshToken kikapcsolva, hogy a supabase-js semmilyen körülmények között
   ne emeljen be tokent a háttérből. A 15_echo_core.sql ugyanezt kényszeríti ki
   a másik oldalról: az echo_submit EXECUTE joga KIZÁRÓLAG az 'anon' szerepköré,
   az 'authenticated' nem is hívhatja.

   Ha az anon kliens bármiért nem hozható létre, NEM esünk vissza a window.sb-re.
   Az a "működik, csak épp deanonimizál" eset — inkább hibázzon látványosan. */
let ECHO__anonClient = null;
function ECHO_anonClient() {
  if (ECHO__anonClient) return ECHO__anonClient;
  const g = window.supabase;   // a @supabase/supabase-js UMD globálisa (app.html / index.html)
  if (!g || typeof g.createClient !== 'function' || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    return null;
  }
  ECHO__anonClient = g.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return ECHO__anonClient;
}

const ECHO_api = {
  myCourses:   ()               => ECHO_rpc('echo_my_courses'),

  /* ---- PISZKOZAT (22_echo_draft.sql) ----
     Mind a három AZONOSÍTOTT úton megy, a bejelentkezett munkamenettel — ez
     az ellentéte a beküldésnek, és szándékosan az. A piszkozat a beküldésig
     a hallgatóhoz köthető; a szerver a hívó auth.uid()-jára szűr, hallgató-
     azonosítót egyik hívás sem fogad paraméterként.
     A drop a SIKERES BEKÜLDÉS UTÁN fut — lásd a 22-es fájl fejlécét arról,
     miért nem az (anonim) echo_submit törli a piszkozatot. */
  draftSave:   (campaign, course, payload, step) =>
                 ECHO_rpc('echo_draft_save', {
                   p_campaign: campaign, p_course: course,
                   p_payload: payload, p_step: step | 0,
                 }),
  draftGet:    (campaign, course) =>
                 ECHO_rpc('echo_draft_get', { p_campaign: campaign, p_course: course }),
  draftDrop:   (campaign, course) =>
                 ECHO_rpc('echo_draft_drop', { p_campaign: campaign, p_course: course }),
  getForm:     (campaign, course) => ECHO_rpc('echo_get_form', { p_campaign: campaign, p_course: course }),
  // p_intro: a célmeghatározó két BEVEZETŐ kérdésének válasza. Ez az
  // AZONOSÍTOTT echo.student_goal sorba megy (a hallgató sajátja), és
  // SOHA nem kerül át a névtelen válaszhalmazba — lásd 23_echo_form_rules.sql.
  saveGoals:   (campaign, course, goals, expectations, intro) =>
                 ECHO_rpc('echo_save_goals', {
                   p_campaign: campaign, p_course: course,
                   p_goals: goals, p_expectations: expectations,
                   p_intro: intro || {},
                 }),
  issueTicket: (campaign, course) => ECHO_rpc('echo_issue_ticket', { p_campaign: campaign, p_course: course }),

  // ANONIM ÚT. Lásd az ECHO_anonClient fölötti indoklást.
  submit: async (ticket, payload) => {
    const anon = ECHO_anonClient();
    if (!anon) throw new Error('A névtelen beküldő kliens nem hozható létre — a kitöltés nem küldhető be biztonságosan.');
    const { data, error } = await anon.rpc('echo_submit', { p_ticket: ticket, p_payload: payload });
    if (error) throw error;
    return data;
  },

  campaigns:  ()          => ECHO_rpc('echo_campaigns'),
  campaignUpdate: (id, p) => ECHO_rpc('echo_campaign_update', {
    p_campaign: id,
    p_nev: p.nev ?? null, p_name_en: p.nameEn ?? null, p_term: p.term ?? null,
    p_template_version: p.ver ?? null,
    p_opens_at: p.opensAt ?? null, p_closes_at: p.closesAt ?? null,
    p_goals_open_at: p.goalsOpenAt ?? null, p_goals_close_at: p.goalsCloseAt ?? null,
    p_clear: (p.clear && p.clear.length) ? p.clear : null }),
  audience:       (id)          => ECHO_rpc('echo_campaign_audience', { p_campaign: id }),
  audienceSet:    (id, items)   => ECHO_rpc('echo_campaign_audience_set',
                                    { p_campaign: id, p_items: items }),
  audienceStudents:(id, items, q) => ECHO_rpc('echo_audience_target_students',
                                    { p_campaign: id, p_items: items, p_q: q || null, p_limit: 2000 }),
  campaignForm:   (id)          => ECHO_rpc('echo_campaign_form', { p_campaign: id }),
  studentCourses: (id, profile, items) => ECHO_rpc('echo_student_courses',
                                    { p_campaign: id, p_profile: profile,
                                      p_items: items || null }),
  campaignStudents:(id, q)      => ECHO_rpc('echo_campaign_students',
                                    { p_campaign: id, p_q: q || null, p_limit: 2000 }),
  audiencePreview:(id, items)   => ECHO_rpc('echo_audience_preview',
                                    { p_campaign: id, p_items: items }),
  audienceOptions:(id, kind, q) => ECHO_rpc('echo_audience_options',
                                    { p_campaign: id, p_kind: kind, p_q: q || null, p_limit: 60 }),
  /* A tulajdonsag-szuro ertekkeszlete es kartyankenti letszama (80). Az
     ertekkeszletet a 71-es mar kiadja mind a hat mezore — nem irunk masodikat. */
  attrOptions:    ()            => ECHO_rpc('student_directory_options'),
  attrCount:      (rule)        => ECHO_rpc('attr_rule_count', { p_rule: rule }),
  rate:       (campaign)  => ECHO_rpc('echo_rate', { p_campaign: campaign }),
  rebuildEligibility: (campaign) => ECHO_rpc('echo_rebuild_eligibility', { p_campaign: campaign }),

  /* ---- 3. szelet: 18_echo_campaign.sql, betű szerinti szignatúrák ----
       public.echo_campaign_create(p_nev text, p_term text, p_template_version uuid,
                                   p_opens_at timestamptz, p_closes_at timestamptz)
       public.echo_campaign_transition(p_campaign uuid, p_to text, p_force boolean default false)
       public.echo_campaign_get(p_campaign uuid)
     Mind is_admin()-hez kötve a függvény TÖRZSÉBEN, 'authenticated' granttal.
     Enélkül a kampány örökre abban az állapotban maradt, amiben a seed
     létrehozta — és a 16_echo_reports.sql riportmotorja elérhetetlen volt,
     mert az echo.results_gate() 'closed' vagy későbbi állapotot követel. */
  campaignCreate: (nev, term, templateVersion, opensAt, closesAt) =>
    ECHO_rpc('echo_campaign_create', {
      p_nev: nev, p_term: term, p_template_version: templateVersion,
      p_opens_at: opensAt, p_closes_at: closesAt,
    }),
  // A p_force KIZÁRÓLAG időzítési és teljességi feltételt old fel (korai zárás,
  // lejárt ablakkal való nyitás, moderálatlan sor melletti közzététel). Az
  // állapotgép átugrását és a pecsét utáni visszalépést SEMMI nem oldja fel —
  // azt az adatbázisban trigger is őrzi (echo.campaign_seal_guard).
  campaignTransition: (campaign, to, force) =>
    ECHO_rpc('echo_campaign_transition', {
      p_campaign: campaign, p_to: to, p_force: !!force,
    }),
  campaignGet: (campaign) => ECHO_rpc('echo_campaign_get', { p_campaign: campaign }),

  /* ---- 2. szelet: 16_echo_reports.sql 8. szakasz, betű szerinti szignatúrák ----
       public.echo_teacher_results(p_campaign uuid, p_course uuid, p_teacher uuid default null)
       public.echo_course_results(p_campaign uuid, p_course uuid)
       public.echo_moderation_queue(p_campaign uuid)
       public.echo_moderate(p_response uuid, p_question text, p_allapot text,
                            p_indok text default null, p_megjegyzes text default null)
       public.echo_templates()
       public.echo_template_get(p_version uuid)
       public.echo_template_create(p_name text, p_from uuid default null)
       public.echo_template_save(p_version uuid, p_compiled jsonb)
       public.echo_template_validate(p_version uuid)
       public.echo_template_transition(p_version uuid, p_to text)
     Mind 'authenticated' granttal; a tényleges szűrés a függvény TÖRZSÉBEN van
     (is_admin(), illetve az echo.teacher.profile_id szerinti oktatói kötés). */
  teacherResults: (campaign, course, teacher) =>
    ECHO_rpc('echo_teacher_results', { p_campaign: campaign, p_course: course, p_teacher: teacher || null }),
  // ADMIN NYERS NEZET (56_admin_results_control.sql) — kuszob es
  // oralatogatas-szures nelkul, moderalasi allapottal egyutt.
  resultsRaw:     (campaign, course, scope, teacher) =>
                    ECHO_rpc('echo_results_raw', { p_campaign: campaign, p_course: course,
                                                   p_scope: scope || 'course', p_teacher: teacher || null }),
  // A kampany relevancia-szuroje: beleszamitson-e az alacsony oralatogatas.
  filtersGet:     (campaign) => ECHO_rpc('echo_campaign_filters_get', { p_campaign: campaign }),
  filtersSet:     (campaign, lowIncluded) =>
                    ECHO_rpc('echo_campaign_filters_set',
                             { p_campaign: campaign, p_low_attendance_included: !!lowIncluded }),

  courseResults:  (campaign, course) =>
    ECHO_rpc('echo_course_results', { p_campaign: campaign, p_course: course }),

  /* EXPORT — 34_echo_export.sql
     Ugyanaz az adatút, mint a képernyőé: a szerver a results_build()
     kimenetét lapítja sorokká, és minden rejtés-jelzőt tiszteletben tart.
     Amit a riport elrejt, azt az export nem tudja megmutatni — nem
     ellenőrzésből, hanem mert hozzá sem fér a nyers válaszokhoz. */
  exportResults: (campaign, course, teacher, scope, format) =>
    ECHO_rpc('echo_export_results', {
      p_campaign: campaign, p_course: course, p_teacher: teacher || null,
      p_scope: scope || 'course', p_format: format || 'csv' }),
  exportLog: (campaign) =>
    ECHO_rpc('echo_export_log', { p_campaign: campaign || null }),

  /* 7 NAPOS OKTATÓI ÉSZREVÉTEL — 35_echo_comment.sql, 6. § (7)
     A határidő NEM a kampány zárásától indul, hanem az ÁTVÉTELTŐL. Amíg
     nincs átvétel, a szerver 'atvette: null'-t ad, és az óra el sem indul. */
  commentWindow: (campaign) =>
    ECHO_rpc('echo_my_comment_window', { p_campaign: campaign }),
  commentSubmit: (campaign, body) =>
    ECHO_rpc('echo_teacher_comment_submit', { p_campaign: campaign, p_body: body }),
  comments: (campaign) =>
    ECHO_rpc('echo_teacher_comments', { p_campaign: campaign || null }),
  commentAck: (id, note) =>
    ECHO_rpc('echo_comment_acknowledge', { p_comment: id, p_note: note || null }),
  protocolHandover: (campaign, teacher, method, note) =>
    ECHO_rpc('echo_protocol_handover', {
      p_campaign: campaign, p_teacher: teacher,
      p_method: method || 'rendszer', p_note: note || null }),

  moderationQueue: (campaign) => ECHO_rpc('echo_moderation_queue', { p_campaign: campaign }),
  moderate: (response, question, allapot, indok, megjegyzes) =>
    ECHO_rpc('echo_moderate', {
      p_response: response, p_question: question, p_allapot: allapot,
      p_indok: indok || null, p_megjegyzes: megjegyzes || null,
    }),

  templates:          ()               => ECHO_rpc('echo_templates'),
  templateGet:        (version)        => ECHO_rpc('echo_template_get', { p_version: version }),
  templateCreate:     (name, from)     => ECHO_rpc('echo_template_create', { p_name: name, p_from: from || null }),
  templateSave:       (version, compiled) => ECHO_rpc('echo_template_save', { p_version: version, p_compiled: compiled }),
  // A kérdőív NEVE a sablonon él (echo.template.name_hu/name_en), nem a verzión,
  // ezért külön RPC menti — és csak draft állapotban (17_echo_template_rename.sql).
  templateRename:     (version, nameHu, nameEn) => ECHO_rpc('echo_template_rename',
                        { p_version: version, p_name_hu: nameHu, p_name_en: nameEn || null }),
  templateValidate:   (version)        => ECHO_rpc('echo_template_validate', { p_version: version }),
  templateTransition: (version, to)    => ECHO_rpc('echo_template_transition', { p_version: version, p_to: to }),

  /* ---- 0.4 szelet: 19_echo_roles.sql — OKTATÓI BELÉPÉS ----
       public.echo_my_teacher_courses()
       public.echo_teacher_link(p_teacher uuid, p_profile uuid)
       public.echo_role_grants()
       public.echo_role_grant(p_person uuid, p_role text, p_scope uuid,
                              p_expires timestamptz, p_iktatoszam text)
       public.echo_my_roles()
     Mind 'authenticated' granttal, az anon egyiket sem hívhatja. A tényleges
     szűrés a függvény TÖRZSÉBEN van: echo.can_grant() / echo.can_see_grants() /
     az echo.teacher.profile_id kötés + élő 'OKTATO' grant. */
  myTeacherCourses: ()               => ECHO_rpc('echo_my_teacher_courses'),
  myRoles:          ()               => ECHO_rpc('echo_my_roles'),
  teacherLink:      (teacher, profile) =>
    ECHO_rpc('echo_teacher_link', { p_teacher: teacher, p_profile: profile || null }),
  roleGrants:       ()               => ECHO_rpc('echo_role_grants'),
  roleGrant:        (person, role, scope, expires, iktatoszam) =>
    ECHO_rpc('echo_role_grant', {
      p_person: person, p_role: role,
      p_scope: scope || null, p_expires: expires || null,
      p_iktatoszam: iktatoszam || null,
    }),
};

/* ------------------------------------------------------------
   2. Segédfüggvények a compiled JSONB értelmezéséhez
   ------------------------------------------------------------ */

// A compiled options tömbje kétféle: ["szöveg", …] vagy [{value,hu,en}, …].
// A kettő egységesítése — a beküldött érték MINDIG a `value`.
function ECHO_options(q, lang) {
  const raw = Array.isArray(q && q.options) ? q.options : [];
  return raw.map((o, i) => {
    if (o && typeof o === 'object') {
      return { value: o.value != null ? o.value : (o.hu || String(i)), label: ECHO_txt(o, lang) || String(o.value || '') };
    }
    return { value: String(o), label: String(o) };
  });
}

// Determinisztikus keverés: a "randomize": true kérdéseknél a sorrend
// kitöltésenként más, de EGY kitöltésen belül nem ugrál (a lépések között
// oda-vissza lehet lépkedni). A mag a kitöltés indításakor születik.
function ECHO_shuffle(list, seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = (Math.imul(h, 48271) + 11) >>> 0;
    const j = h % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/* A compiled `cond` mezőjének kiértékelése.
   A jelenlegi kérdőívben két alak fordul elő:
     {"has_goals": true}   — csak akkor, ha a hallgató mentett félév eleji célt
     {"teacher_skip": null} — csak akkor, ha az oktatót NEM hagyta ki
   Az értelmezés általános, hogy egy jövőbeli verzió új feltétele se törje el
   a felületet: kulcsonként vagy a has_goals kapcsolóra, vagy az adott kérdés
   aktuális válaszára illesztünk. */
function ECHO_condOk(cond, ctx) {
  if (!cond || typeof cond !== 'object') return true;
  return Object.keys(cond).every((k) => {
    const want = cond[k];
    if (k === 'has_goals') return !!ctx.hasGoals === !!want;
    const have = ctx.answers ? ctx.answers[k] : undefined;
    const empty = (have === undefined || have === null || have === '' ||
                   (Array.isArray(have) && have.length === 0));
    if (want === null) return empty;
    if (Array.isArray(want)) return want.indexOf(have) >= 0;
    return have === want;
  });
}

// Ki van-e töltve egy kötelező kérdés.
function ECHO_answered(q, v) {
  if (q.type === 'multi') return Array.isArray(v) && v.length > 0;
  if (q.type === 'scale') return typeof v === 'number';
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/* ------------------------------------------------------------
   2/b. Az "EGYÉB" OPCIÓ — bejelölve kötelező mellé szöveget írni
   ------------------------------------------------------------
   MI A HELYZET: a többes választású kérdések opciólistájában a prototípus
   kérdőívében szerepel egy szó szerinti "Egyéb" / "Other" opció (mérve a
   2. verzió compiled JSONB-jén: a course_strengths_p és a course_improve_p
   kérdésnél), MELLETTE pedig az allowOther:true miatt megjelenik a szabad
   szövegmező. Ha a hallgató csak az "Egyéb"-et jelöli be és nem ír semmit,
   a válasz értelmezhetetlen: azt tudjuk, hogy valami más volt, de azt nem,
   hogy mi. Ezért az "Egyéb" bejelölése MELLÉ legalább egy saját szöveg kell.

   AZ AZONOSÍTÁS a compiled adatából megy, nem felületi feltételezésből:
     • elsődlegesen az opció `other: true` jelzője (ezt a kérdőív-verzió
       viheti magával), másodlagosan a value/hu/en szövege.
   A második ág azért kell, mert a MA ÉLŐ 2. verzióban nincs `other` jelző —
   e nélkül a szabály a jelenlegi kérdőíven nem fogna. */
const ECHO_OTHER_WORDS = ['egyéb', 'egyeb', 'other'];
function ECHO_isOtherOption(o) {
  if (!o) return false;
  if (typeof o === 'object' && o.other === true) return true;
  const probe = (typeof o === 'object')
    ? [o.value, o.hu, o.en]
    : [o];
  return probe.some(x => ECHO_OTHER_WORDS.indexOf(String(x == null ? '' : x).trim().toLowerCase()) >= 0);
}

/* Bejelölte-e a hallgató az "Egyéb" opciót ezen a kérdésen. */
function ECHO_otherPicked(q, value) {
  const arr = Array.isArray(value) ? value : [];
  if (!arr.length) return false;
  const raw = Array.isArray(q && q.options) ? q.options : [];
  return raw.some(o => ECHO_isOtherOption(o) &&
    arr.indexOf((o && typeof o === 'object') ? (o.value != null ? o.value : o.hu) : String(o)) >= 0);
}

/* Írt-e MELLÉ saját szöveget. A saját szöveg definíció szerint az, ami nincs
   benne az opciólistában — pontosan úgy, ahogy az ECHO_QMulti `extras`-a
   számolja. */
function ECHO_otherText(q, value) {
  const arr = Array.isArray(value) ? value : [];
  const raw = Array.isArray(q && q.options) ? q.options : [];
  const known = raw.map(o => (o && typeof o === 'object') ? (o.value != null ? o.value : o.hu) : String(o));
  return arr.filter(v => known.indexOf(v) < 0 && String(v || '').trim() !== '');
}

/* A HIÁNY: "Egyéb" bejelölve, de nincs mellé szöveg.
   Ez a KLIENSOLDALI kapu; ugyanezt a szabályt az echo_submit() is
   kikényszeríti (ECHO_OTHER_TEXT_REQUIRED), hogy a nyers API-n se lehessen
   megkerülni. */
function ECHO_otherMissing(q, value) {
  if (!q || q.type !== 'multi') return false;
  return ECHO_otherPicked(q, value) && ECHO_otherText(q, value).length === 0;
}

/* ------------------------------------------------------------
   2/c. DINAMIKUS BEHELYETTESÍTÉS — a KÖZÖS út
   ------------------------------------------------------------
   A kérdőívszövegek helykitöltőket tartalmazhatnak ("[Oktató neve] erősségei"),
   amiket a konkrét oktató és kurzus adata tölt ki. Ez KORÁBBAN CSAK a
   szerkesztő ELŐNÉZETÉBEN történt meg (ECHO_TOKENS + ECHO_tok), a valódi
   kitöltésben nem — a hallgató szó szerint a "[Oktató neve] erősségei"
   feliratot látta. Az oktatónkénti ismétlődő kérdéseknél ez zavaró, és
   ráadásul azt is elrejti, MELYIK oktatóról szól éppen a kérdés.

   Ezért a feloldás innentől EGY helyen van, és a kitöltő is, az előnézet is
   ugyanezt hívja — csak a környezet (ctx) más: az előnézet mintaértékeket ad,
   a kitöltő a valódi kurzust és az AKTUÁLIS oktatót. */
function ECHO_tokenMap(ctx) {
  const c = (ctx && ctx.course) || {};
  const t = (ctx && ctx.teacher) || {};
  const g = (ctx && ctx.goal) || {};
  const tName = String(t.name || '').trim();
  const cHu = String(c.name || c.course_name || '').trim();
  const cEn = String(c.name_en || c.course_name_en || '').trim() || cHu;
  const gTxt = String(g.text || '').trim();
  const m = {};
  // Csak azt a tokent tesszük a térképre, amire van valódi érték — így egy
  // hiányzó adat nem tünteti el a kérdésszöveg egy darabját, hanem meghagyja
  // a helykitöltőt, ami legalább látható hiba.
  if (tName) { m['[Oktató neve]'] = tName; m['[oktató neve]'] = tName; m['[Teacher name]'] = tName; }
  if (cHu)   { m['[Kurzus neve]'] = cHu; }
  if (cEn)   { m['[Course name]'] = cEn; }
  if (gTxt)  { m['[Cél]'] = gTxt; m['[Goal]'] = gTxt; }
  return m;
}

function ECHO_applyTokens(s, map) {
  if (s == null) return s;
  let out = String(s);
  if (out.indexOf('[') < 0) return out;          // gyors kiszállás
  Object.keys(map).forEach(k => { if (out.indexOf(k) >= 0) out = out.split(k).join(map[k]); });
  return out;
}

/* Egy kérdés MEGJELENÍTÉSI alakja: a tokenek feloldva a kérdésszövegben, a
   súgóban és az opciócímkékben is. A `value` mezőket SZÁNDÉKOSAN nem
   bántjuk: a beküldött érték a compiled szerinti nyers `value`, azt a
   feloldás nem írhatja át, különben a riportok nem találnának rá. */
function ECHO_resolveTokens(q, ctx) {
  const map = ECHO_tokenMap(ctx);
  if (!q || !Object.keys(map).length) return q;
  const help = (q.help && typeof q.help === 'object')
    ? { hu: ECHO_applyTokens(q.help.hu, map), en: ECHO_applyTokens(q.help.en, map) }
    : ECHO_applyTokens(q.help, map);
  const opts = Array.isArray(q.options) ? q.options.map(o => (
    (o && typeof o === 'object')
      ? Object.assign({}, o, { hu: ECHO_applyTokens(o.hu, map), en: ECHO_applyTokens(o.en, map) })
      : ECHO_applyTokens(o, map)
  )) : q.options;
  return Object.assign({}, q, {
    hu: ECHO_applyTokens(q.hu, map),
    en: ECHO_applyTokens(q.en, map),
    help: help, options: opts,
  });
}

/* A félév eleji célok és oktatói elvárások EGYETLEN, sorrendtartó listája.
   A prototípus a kettőt egymás után, külön lépésként tölti vissza; a
   `kind` mező őrzi, melyik melyik, mert a felületi címke más
   ("A célod" / "Az oktatóval szembeni elvárásod").
   A `key` a válaszkulcs egyedi utótagja — INDEX ALAPÚ, nem szöveg alapú:
   ha két cél szövege azonos, a kulcsuk akkor sem eshet egybe. */
function ECHO_goalItems(goals) {
  const g = (goals && Array.isArray(goals.goals)) ? goals.goals : [];
  const e = (goals && Array.isArray(goals.expectations)) ? goals.expectations : [];
  const out = [];
  g.forEach((t, i) => { const s = String(t || '').trim(); if (s) out.push({ key: 'g' + i, kind: 'goal', text: s }); });
  e.forEach((t, i) => { const s = String(t || '').trim(); if (s) out.push({ key: 'e' + i, kind: 'exp',  text: s }); });
  return out;
}

/* A CÉLMEGHATÁROZÓ (part1) BEVEZETŐ KÉRDÉSEI a compiled JSONB-ből.
   MIÉRT ONNAN: a fájl fejlécének szabálya szerint kérdésszöveg NEM kerülhet a
   felületbe — ami itt állna, az szétcsúszhatna a szenátus által jóváhagyott
   kérdőívtől. A célmeghatározó eddig azért volt kivétel, mert a part1-ben
   egyetlen kérdés sem volt (mérve: a 2. verzióban 0 db part1 szakasz); a
   listaszerkesztők címkéi ezért kényszerből a kódban állnak.
   A két bevezető kérdés viszont VALÓDI kérdőívkérdés, ezért a compiled-ból jön
   (24_echo_form_v3.sql). Ha a kérdőívben nincs part1 szakasz, ez üres listát ad,
   és a célmeghatározó pontosan úgy viselkedik, mint eddig. */
function ECHO_part1Questions(form) {
  const secs = (form && Array.isArray(form.sections)) ? form.sections : [];
  const out = [];
  secs.forEach((sec) => {
    if (sec.part !== 'part1') return;
    (sec.questions || []).forEach(q => out.push(q));
  });
  return out;
}

/* Egy repeat:"goal" kérdés válaszkulcsa EGY célra. A kulcs a kitöltő
   MEMÓRIÁJÁBAN egyedi; a beküldött payloadba EZ SOHA nem kerül bele
   (lásd ECHO_buildPayload → ECHO_goalsMerge). */
function ECHO_goalKey(q, item) { return q.id + '@' + item.key; }

/* Ismétlődés-fajták. A repeat:"teacher_goal" kérdés MINDKÉT bontásban
   elhangzik — oktatónként egyszer ÉS célonként egyszer (nem a kettő szorzata).
   Az oktatói válasz az oktató zsákjába, a célonkénti az összevont kurzusszintű
   értékbe megy, pontosan úgy, mint a sima "teacher" / "goal" kérdésnél. */
function ECHO_repTeacher(q) { return q.repeat === 'teacher' || q.repeat === 'teacher_goal'; }
function ECHO_repGoal(q)    { return q.repeat === 'goal'    || q.repeat === 'teacher_goal'; }

/* A célonkénti válaszok ÖSSZEVONÁSA egyetlen értékké.
   MIÉRT KELL ÖSSZEVONNI: a válaszsor névtelen, a célok SZÁMOSSÁGA viszont
   kvázi-azonosító — az echo.student_goal tábla a hallgatóhoz van kötve,
   tehát abból látszik, ki hány célt írt. Ha a payload célonként egy elemet
   vinne, a tömb hossza leszűkítené a lehetséges kitöltők körét, a célok
   szövege pedig egyenesen azonosítana. Az echo_submit() ezért NÉV SZERINT
   levágja a goals / goal_texts / goal_count / expectations kulcsokat, és a
   'goals_met'-en kívül semmilyen cél-adatot nem enged be (15_echo_core.sql,
   9.5 szakasz 4. lépése). Ez a függvény ehhez a szerződéshez igazodik.
   A SZABÁLY:
     • ha minden cél ugyanazt az értéket kapta → az az érték megy át;
     • ha mind legalább 'teljesult' (vagy 'tulteljesult') → 'teljesult';
     • minden más vegyes eset → 'reszben'.
   Az echo_submit() CHECK-je csak ezt a négy értéket fogadja el. */
const ECHO_GOAL_RANK = { nem_teljesult: 0, reszben: 1, teljesult: 2, tulteljesult: 3 };
function ECHO_goalsMerge(values) {
  const known = (values || []).filter(v => typeof v === 'string' && ECHO_GOAL_RANK[v] !== undefined);
  if (!known.length) return undefined;
  let lo = 9, hi = -1;
  known.forEach(v => { const r = ECHO_GOAL_RANK[v]; if (r < lo) lo = r; if (r > hi) hi = r; });
  if (lo === hi) return known[0];
  if (lo >= ECHO_GOAL_RANK.teljesult) return 'teljesult';
  return 'reszben';
}

/* A compiled → lépéslista.
     repeat:"teacher" kérdést tartalmazó szakaszból oktatónként EGY lépés lesz;
     repeat:"goal"    kérdést tartalmazóból CÉLONKÉNT (és elvárásonként) egy.
   MÉRT HIBA VOLT (javítva): a repeat:"goal" kérdés korábban egyik ágra sem
   illett — sem az oktatónkéntire, sem a `!q.repeat` szűrőre —, ezért a
   szerkesztő felkínálta ugyan a beállítást, de a kitöltőben SOHA nem jelent
   meg egyetlen ilyen kérdés sem.
   HA A HALLGATÓNAK NINCS CÉLJA, a szakasz KIESIK — nem üres lépésként
   marad benne. A prototípus is így viselkedik.
   SORREND: ha egy szakasz egyszerre tartalmaz oktatónkénti és célonkénti
   kérdést, az OKTATÓNKÉNTI bontás nyer (a két bontás nem szorozható össze).
   Ilyen szakaszt a validátor ma nem tilt, de a kérdőív nem is használ. */
/* KAMPÁNYAZONOSÍTÓ — inkrementális sorszám (echo.campaign.ref_no, 68-as migráció),
   K-0001 alakban; a hosszú kód (pl. OMHV-2026-27-1-14) a súgóba kerül. A 68 előtt
   a sorszám hiányzik, ilyenkor a kód látszik. Ugyanaz a címke jelenik meg az admin és a
   hallgatói felületen, így egy hibajelzésnél egyértelmű, melyik kampányról van szó. */
function ECHO_kampanyAzon(sorszam, kod) {
  const n = Number(sorszam);
  return (sorszam != null && Number.isFinite(n) && n > 0) ? 'K-' + String(n).padStart(4, '0') : (kod || '');
}
function ECHO_KampanyId({ sorszam, kod, kicsi }) {
  const azon = ECHO_kampanyAzon(sorszam, kod);
  if (!azon) return null;
  return (
    <span title={'Kampányazonosító' + (kod && kod !== azon ? ' · ' + kod : '')} data-echo-kampany-id={azon} data-echo-noi18n="1"
      className={'inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-600 font-mono font-bold align-middle whitespace-nowrap ' +
                 (kicsi ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]')}>
      <Lucide.Hash size={kicsi ? 10 : 11} className="flex-none" />{azon}
    </span>
  );
}

function ECHO_buildSteps(form, teachers, goalItems) {
  const sections = (form && Array.isArray(form.sections)) ? form.sections : [];
  const items = Array.isArray(goalItems) ? goalItems : [];
  const steps = [];
  sections.forEach((sec) => {
    if (sec.part && sec.part !== 'part2') return;   // a part1 a célmeghatározó, nem itt van
    const qs = Array.isArray(sec.questions) ? sec.questions : [];
    /* KÉRDÉSFAJTÁNKÉNT. Korábban egyetlen oktatónként vagy célonként ismétlődő
       kérdés az EGÉSZ szakaszt átfordította: a szakasz többi kérdése eltűnt, és
       ha nem volt oktató vagy cél, a szakaszból egy lépés sem lett — a kitöltő
       rögtön az összegzést mutatta, mintha kész lenne (hibajelentés, 2026-09-17).
       Most: az ismétlődés nélküli kérdések egy lépés, utána oktatónként, majd
       célonként külön lépések — mindegyik csak a saját fajtájú kérdéseit mutatja
       (visibleQs). A repeat:"teacher_goal" kérdés az oktatói ÉS a célonkénti
       lépésekben is megjelenik. */
    if (qs.some(q => !q.repeat)) steps.push({ kind: 'section', section: sec });
    if (qs.some(ECHO_repTeacher)) {
      (teachers || []).forEach((t) => steps.push({ kind: 'teacher', section: sec, teacher: t }));
    }
    if (qs.some(ECHO_repGoal)) {
      // Nincs cél → nincs célonkénti lépés; a szakasz többi kérdése ettől még megjelenik.
      items.forEach((it) => steps.push({ kind: 'goal', section: sec, goal: it }));
    }
  });
  steps.push({ kind: 'review', section: null });
  return steps;
}

/* ------------------------------------------------------------
   3. Kérdés-atomok (mobilbarát: nagy érintési célpontok)
   ------------------------------------------------------------ */

const ECHO_choiceBase =
  'w-full text-left flex items-start gap-3 rounded-2xl border-2 px-4 py-4 min-h-[56px] ' +
  'transition-all active:scale-[0.99] text-sm font-bold';
const ECHO_choiceOff = ' border-slate-100 bg-white text-slate-700 hover:border-slate-200 hover:bg-slate-50';
const ECHO_choiceOn  = ' border-primary bg-primary/5 text-primary';
const ECHO_choiceDis = ' border-slate-100 bg-slate-50 text-slate-300 pointer-events-none';

function ECHO_QSingle({ q, opts, value, onChange }) {
  return (
    <div className="space-y-2.5">
      {opts.map(o => (
        <button key={o.value} type="button"
          onClick={() => onChange(value === o.value ? null : o.value)}
          className={ECHO_choiceBase + (value === o.value ? ECHO_choiceOn : ECHO_choiceOff)}>
          <span className={'mt-0.5 w-5 h-5 flex-none rounded-full border-2 flex items-center justify-center ' +
                           (value === o.value ? 'border-primary' : 'border-slate-300')}>
            {value === o.value && <span className="w-2.5 h-2.5 rounded-full bg-primary" />}
          </span>
          <ECHO_Src>{o.label}</ECHO_Src>
        </button>
      ))}
    </div>
  );
}

function ECHO_QMulti({ q, opts, value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const max = Number(q.max) > 0 ? Number(q.max) : opts.length;
  const [other, setOther] = useState('');

  // Az „Egyéb"-ként beírt, tehát a listában nem szereplő értékek.
  const extras = arr.filter(v => !opts.some(o => o.value === v));
  // Van-e egyáltalán „Egyéb" nevű opció a listában, és be van-e jelölve.
  const otherPicked = ECHO_otherPicked(q, arr);

  /* A KERETSZÁMOLÁS ÉS AZ „EGYÉB" — MÉRT VOLT ZSÁKUTCA.
     A kurzus-erősségek kérdésnél max=2 (mérve a 2. verzió compiled JSONB-jén).
     Ha a hallgató bejelöli az „Egyéb"-et ÉS egy másik állítást, a keret betelik.
     A régi kód ilyenkor letiltotta a szövegmezőt (`disabled={full}`) — vagyis
     pont azt a mezőt, aminek a kitöltése az új szabály szerint KÖTELEZŐ.
     Onnan nem volt kiút: se tovább, se kitölteni.
     A megoldás: ha az „Egyéb" be van jelölve, a MELLÉ írt szöveg nem külön
     választás, hanem az „Egyéb" TARTALMA — tehát nem fogyaszt keretet.
     Ha nincs bejelölt „Egyéb", a szabad szöveg a régi módon számít bele. */
  const used = otherPicked ? (arr.length - extras.length) : arr.length;
  const full = used >= max;
  // Bejelölt „Egyéb" mellé EGY szöveg tartozik; e nélkül a régi korlát él.
  const canAddOther = otherPicked ? (extras.length < 1) : !full;

  const toggle = (v) => {
    if (arr.indexOf(v) >= 0) onChange(arr.filter(x => x !== v));
    else if (!full) onChange(arr.concat([v]));
  };
  const addOther = () => {
    const t = other.trim();
    if (!t || !canAddOther || arr.indexOf(t) >= 0) return;
    onChange(arr.concat([t]));
    setOther('');
  };
  /* Bejelölte az „Egyéb" opciót, de nem írt mellé semmit. A szövegmező ilyenkor
     KÖTELEZŐ — csupasz „Egyéb"-ből nem derül ki, mi volt az. A Tovább gomb is
     ezt nézi (ECHO_otherMissing), és az echo_submit() is. Itt, a kérdés
     mellett mondjuk el, mert itt lehet orvosolni. */
  const needOther = ECHO_otherMissing(q, arr);

  return (
    <div className="space-y-2.5">
      {/* Élő számláló — a korlát nem meglepetés, hanem visszajelzés. */}
      <div className="flex items-center justify-between text-[11px] font-black uppercase tracking-wider mb-1">
        <span className={full ? 'text-primary' : 'text-slate-400'}>
          kiválasztva {used}/{max}
        </span>
        {full && <span className="text-slate-400 normal-case tracking-normal font-bold">a keret betelt — vegyél le egyet a cseréhez</span>}
      </div>

      {opts.map(o => {
        const on = arr.indexOf(o.value) >= 0;
        const dis = !on && full;
        return (
          <button key={o.value} type="button" onClick={() => toggle(o.value)}
            className={ECHO_choiceBase + (on ? ECHO_choiceOn : (dis ? ECHO_choiceDis : ECHO_choiceOff))}>
            <span className={'mt-0.5 w-5 h-5 flex-none rounded-md border-2 flex items-center justify-center ' +
                             (on ? 'border-primary bg-primary text-white' : 'border-slate-300')}>
              {on && <Lucide.Check size={13} strokeWidth={4} />}
            </span>
            <ECHO_Src>{o.label}</ECHO_Src>
          </button>
        );
      })}

      {extras.map(v => (
        <button key={'x_' + v} type="button" onClick={() => toggle(v)}
          className={ECHO_choiceBase + ECHO_choiceOn}>
          <span className="mt-0.5 w-5 h-5 flex-none rounded-md border-2 border-primary bg-primary text-white flex items-center justify-center">
            <Lucide.Check size={13} strokeWidth={4} />
          </span>
          <ECHO_Src>{v}</ECHO_Src>
        </button>
      ))}

      {q.allowOther && (
        <div className="pt-1">
          <div className="flex gap-2">
            <input className={U_input + (needOther ? ' border-amber-300 bg-amber-50/40' : '')}
              value={other} disabled={!canAddOther}
              onChange={e => setOther(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOther(); } }}
              placeholder={needOther ? 'Írd le, mi volt az…' : 'Egyéb — saját szöveg'}
              maxLength={120} />
            <button type="button" onClick={addOther} disabled={!canAddOther || !other.trim()}
              className={U_btnGhost + ' flex-none'}><Lucide.Plus size={16} /></button>
          </div>
          {needOther && (
            <p className="mt-1.5 text-[11px] font-bold text-amber-700 flex items-start gap-1.5">
              <Lucide.AlertTriangle size={13} className="flex-none mt-px" />
              Az „Egyéb" mellé kötelező szöveget írni — írd be, majd a + gombbal add hozzá.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ECHO_QScale({ q, value, onChange, lang }) {
  const sc = q.scale || { min: 1, max: 7 };
  const min = Number(sc.min) || 1, max = Number(sc.max) || 7;
  const nums = [];
  for (let i = min; i <= max; i++) nums.push(i);
  const lo = lang === 'en' ? (sc.min_en || sc.min_hu) : (sc.min_hu || sc.min_en);
  const hi = lang === 'en' ? (sc.max_en || sc.max_hu) : (sc.max_hu || sc.max_en);
  return (
    <div>
      <div className="flex gap-1.5 sm:gap-2">
        {nums.map(n => (
          <button key={n} type="button" onClick={() => onChange(value === n ? null : n)}
            className={'flex-1 min-w-[40px] h-14 rounded-2xl border-2 font-black text-base transition-all active:scale-95 ' +
                       (value === n ? 'border-primary bg-primary text-white shadow-lg shadow-primary/20'
                                    : 'border-slate-100 bg-white text-slate-600 hover:border-slate-200')}>
            {n}
          </button>
        ))}
      </div>
      <div className="flex justify-between mt-2 text-[11px] font-bold text-slate-400">
        <ECHO_Src>{lo || ''}</ECHO_Src>
        <ECHO_Src>{hi || ''}</ECHO_Src>
      </div>
    </div>
  );
}

function ECHO_QLong({ q, value, onChange }) {
  const max = Number(q.max) > 0 ? Number(q.max) : 1500;
  const v = value || '';
  return (
    <div>
      <textarea className={U_input + ' min-h-[140px] resize-y'} value={v} maxLength={max}
        onChange={e => onChange(e.target.value)}
        placeholder="Írd le a saját szavaiddal…" />
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[11px] text-slate-400 font-bold">{v.length}/{max}</span>
        {q.moderated && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 font-bold">
            <Lucide.ShieldCheck size={12} /> moderált mező
          </span>
        )}
      </div>
    </div>
  );
}

/* A "skip" típus: nem kérdés, hanem KAPU. Alapból nincs bejelölve semmi
   (= értékelem az oktatót); ha a hallgató kihagyja, indokot választ. */
function ECHO_QSkip({ q, opts, value, onChange }) {
  const on = value !== undefined && value !== null && value !== '';
  const listed = opts.some(o => o.value === value);
  const [other, setOther] = useState(on && !listed ? String(value) : '');
  return (
    <div className="space-y-3">
      <button type="button" onClick={() => onChange(on ? null : (opts[0] ? opts[0].value : 'Nem tudom értékelni'))}
        className={ECHO_choiceBase + (on ? ' border-amber-300 bg-amber-50 text-amber-700' : ECHO_choiceOff)}>
        <span className={'mt-0.5 w-5 h-5 flex-none rounded-md border-2 flex items-center justify-center ' +
                         (on ? 'border-amber-500 bg-amber-500 text-white' : 'border-slate-300')}>
          {on && <Lucide.Check size={13} strokeWidth={4} />}
        </span>
        Ezt az oktatót nem tudom értékelni
      </button>
      {on && (
        <div className="pl-2 border-l-2 border-amber-200 space-y-2.5">
          <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">A kihagyás oka</p>
          {opts.map(o => (
            <button key={o.value} type="button" onClick={() => onChange(o.value)}
              className={ECHO_choiceBase + (value === o.value ? ECHO_choiceOn : ECHO_choiceOff)}>
              <span className={'mt-0.5 w-5 h-5 flex-none rounded-full border-2 flex items-center justify-center ' +
                               (value === o.value ? 'border-primary' : 'border-slate-300')}>
                {value === o.value && <span className="w-2.5 h-2.5 rounded-full bg-primary" />}
              </span>
              <ECHO_Src>{o.label}</ECHO_Src>
            </button>
          ))}
          {q.allowOther && (
            <input className={U_input} value={other} maxLength={200}
              onChange={e => { const t = e.target.value; setOther(t);
                // Kiürítéskor visszaáll a felkínált első indokra — különben a törölt szöveg maradna az érték.
                onChange(t.trim() ? t.trim() : (opts[0] ? opts[0].value : 'Nem tudom értékelni')); }}
              placeholder="Egyéb ok — saját szöveg" />
          )}
        </div>
      )}
    </div>
  );
}

/* Egy kérdés kerete: sorszám, szöveg, súgó, majd a típusnak megfelelő atom.
   A `ctx` a behelyettesítés környezete (kurzus, aktuális oktató, aktuális cél).
   A TOKENFELOLDÁS ITT történik — ezért csinálja a kitöltő és a szerkesztő
   előnézete pontosan ugyanazt: mindkettő ezen a komponensen megy át. */
function ECHO_Question({ q: rawQ, index, value, onChange, lang, seed, ctx, hiba }) {
  const q = ctx ? ECHO_resolveTokens(rawQ, ctx) : rawQ;
  const opts = ECHO_options(q, lang);
  // A súgó kétféle alakban jöhet: sztring (a 15-ös seed) vagy {hu,en} pár
  // (a szerkesztő és a 18b-s, prototípusból származó kérdőív ezt írja).
  // Objektumot React nem tud gyerekként kirajzolni — feloldjuk.
  const help = (q.help && typeof q.help === 'object') ? ECHO_txt(q.help, lang) : (q.help || '');
  const shown = q.randomize ? ECHO_shuffle(opts, seed + '|' + q.id) : opts;
  return (
    <div className={'py-6 border-b border-slate-50 last:border-0 scroll-mt-24 ' + (hiba ? '-mx-3 px-3 rounded-2xl bg-red-50/60 ring-1 ring-red-200' : '')}
      data-echo-kerdes={q.id} data-echo-hiba={hiba || undefined}>
      <div className="flex items-start gap-3 mb-4">
        <span className={'flex-none w-7 h-7 rounded-xl text-xs font-black flex items-center justify-center mt-0.5 ' + (hiba ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-500')}>
          {hiba ? <Lucide.AlertCircle size={15} /> : index}
        </span>
        <div className="min-w-0">
          <h4 className="text-[15px] sm:text-base font-black text-slate-900 leading-snug">
            <ECHO_Src>{ECHO_txt(q, lang)}</ECHO_Src>
            {q.required && <span className="text-primary ml-1">*</span>}
          </h4>
          {help && (
            <p className="text-xs text-slate-400 font-medium mt-1.5 leading-relaxed">
              <ECHO_Src>{help}</ECHO_Src>
            </p>
          )}
          {/* A hiba a kérdésnél szól, nem az oldal alján (hibajelentés). */}
          {hiba && (
            <p className="inline-flex items-center gap-1.5 rounded-lg bg-red-100 text-red-700 text-xs font-black px-2 py-1 mt-2" role="alert" data-echo-kerdes-hiba={hiba}>
              {hiba === 'egyeb' ? 'Az „Egyéb” mellé hiányzik a szöveg — írd le, mi volt az, és add hozzá a + gombbal.' : 'Nem lett kitöltve — ez a kérdés kötelező.'}
            </p>
          )}
        </div>
      </div>
      <div className="sm:pl-10">
        {q.type === 'single'   && <ECHO_QSingle q={q} opts={shown} value={value} onChange={onChange} />}
        {q.type === 'multi'    && <ECHO_QMulti  q={q} opts={shown} value={value} onChange={onChange} />}
        {q.type === 'scale'    && <ECHO_QScale  q={q} value={value} onChange={onChange} lang={lang} />}
        {q.type === 'longtext' && <ECHO_QLong   q={q} value={value} onChange={onChange} />}
        {q.type === 'skip'     && <ECHO_QSkip   q={q} opts={shown} value={value} onChange={onChange} />}
        {['single','multi','scale','longtext','skip'].indexOf(q.type) < 0 && (
          <div className="text-xs text-amber-600 font-bold bg-amber-50 rounded-xl px-4 py-3">
            Ismeretlen kérdéstípus: <ECHO_Src>{String(q.type)}</ECHO_Src> — a felület frissítésre szorul.
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   4. Állapotjelzők
   ------------------------------------------------------------ */

// Az echo_my_courses 'allapot' mezője → felületi címke.
const ECHO_STATE = {
  kitoltve:    { label: 'Kész',          tone: 'green',   icon: 'CheckCircle2', hint: 'Az értékelésed beérkezett.' },
  // FIGYELEM: ez az allapot NEM 'elkezdte'-t jelent. A naplo 'attempted'
  // jelzojet a jegykiadas teszi fel, azt viszont a varazslo CSAK a bekuldes
  // pillanataban hivja — vagyis ez azt jelenti, hogy egy korabbi bekuldes
  // elindult, de nem fejezodott be. A FELBEHAGYOTT ettol kulon allapot: ott
  // van mentett piszkozat, es a kitoltes folytathato.
  /* A FELIRAT KORABBAN „Sikertelen beküldés" VOLT — es ez tobbnyire NEM IGAZ.
     A napló `submitted` jelzoje csak a kampany lezarasakor kerul fel (kotegelt
     echo.mark_submitted), tehat egy TOKELETESEN sikeres bekuldes is ide esik,
     amig a kampany nyitva van. A felulet igy sikertelenseget allitott olyan
     hallgatonak, aki rendben bekuldott — es ujrakitoltesre biztatta.
     Amit tudunk: elindult egy bekuldes, es a rendszer meg nem tudja
     visszaigazolni. Ha ezen a bongeszon tortent, a sajat masolat elarulja, es
     a kartya „Kész"-t mutat helyette. */
  folyamatban: { label: 'Nincs visszaigazolva', tone: 'amber', icon: 'AlertTriangle', hint: 'Elindult egy beküldés, de a rendszer a kampány lezárásáig nem igazolja vissza. Ha megszakadt, töltsd ki újra — ha nem, nyugodtan hagyd így.' },
  // 22_echo_draft.sql: van mentett piszkozat, a kitoltes ott folytathato, ahol
  // abbamaradt. A piszkozat a bekuldesig visszakeresheto a hallgatohoz — ezt a
  // felulet a kitoltoben ki is mondja.
  felbehagyott: { label: 'Félbehagyott', tone: 'blue', icon: 'PauseCircle', hint: 'Van mentett piszkozatod — a kitöltés folytatható.' },
  kitoltheto:  { label: 'Nem kezdett',   tone: 'primary', icon: 'Circle',       hint: 'A kitöltési ablak nyitva.' },
  celkituzes:  { label: 'Célkitűzés',    tone: 'blue',    icon: 'Target',       hint: 'A félév eleji célok adhatók meg.' },
  lezart:      { label: 'Lezárt',        tone: 'slate',   icon: 'Lock',         hint: 'A kitöltési ablak bezárt.' },
  nem_nyitott: { label: 'Még nem nyílt', tone: 'slate',   icon: 'Clock',        hint: 'A kampány még nem indult.' },
};

function ECHO_StateBadge({ allapot }) {
  const s = ECHO_STATE[allapot] || ECHO_STATE.nem_nyitott;
  const Icon = Lucide[s.icon] || Lucide.Circle;
  return <UBadge tone={s.tone}><Icon size={11} /> {s.label}</UBadge>;
}

const ECHO_CAMPAIGN_STATE = {
  draft:      { label: 'Előkészítés', tone: 'slate' },
  open:       { label: 'Nyitva',      tone: 'green' },
  closed:     { label: 'Lezárva',     tone: 'amber' },
  processing: { label: 'Feldolgozás', tone: 'blue' },
  sealed:     { label: 'Zárolt',      tone: 'violet' },
  published:  { label: 'Közzétéve',   tone: 'primary' },
};

/* AZ ÁLLAPOT ÉS AZ ABLAK KÉT KÜLÖN DOLOG — és ez félrevezetett már.
   A kampány „NYITVA" állapotba kerül attól, hogy az ügyintéző megnyitja, de
   kitölthetővé csak akkor válik, amikor elérkezik a NYITÁSI IDŐPONT. A szerver
   ezt az is_open mezőben külön meg is mondja; eddig nem használtuk ki, ezért a
   lista „NYITVA"-t mutatott olyan kampányra is, amelynek az ablaka még el sem
   kezdődött — és úgy tűnt, a hallgatói oldal hibázik.
   Visszaad: null (nincs mit hozzátenni), vagy {szoveg, tone}. */
function ECHO_ablakAllapot(c) {
  if (!c || c.state !== 'open' || c.is_open) return null;
  const nyit = Date.parse(c.opens_at || '');
  const zar  = Date.parse(c.closes_at || '');
  const most = Date.now();
  if (!isNaN(nyit) && most < nyit) {
    return { szoveg: 'megnyílik: ' + ECHO_dateTime(c.opens_at), tone: 'amber' };
  }
  if (!isNaN(zar) && most > zar) {
    return { szoveg: 'az ablak lejárt: ' + ECHO_dateTime(c.closes_at), tone: 'red' };
  }
  return { szoveg: 'az ablak nincs nyitva', tone: 'amber' };
}

function ECHO_date(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch (e) { return String(s).slice(0, 10); }
}
function ECHO_dateTime(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return String(s).slice(0, 16); }
}

/* ------------------------------------------------------------
   5. Félév eleji CÉLMEGHATÁROZÓ (Part 1)
   ------------------------------------------------------------
   1–3 cél és 1–3 oktatói elvárás. A szerver ugyanezt a korlátot
   kikényszeríti (ECHO_TOO_MANY_GOALS), ez itt csak a kényelem.
   FONTOS: a célok SZÖVEGE és SZÁMOSSÁGA soha nem kerül át a beküldött
   értékelésbe — a kettő közt egyedül a "célteljesülés" összegzés megy át.
   ------------------------------------------------------------ */

function ECHO_ListEditor({ title, hint, items, setItems, max = 3, placeholder, hiba, azon }) {
  const setAt = (i, v) => { const a = items.slice(); a[i] = v; setItems(a); };
  const del   = (i)     => setItems(items.filter((_, k) => k !== i));
  return (
    <div className={'scroll-mt-24 ' + (hiba ? '-mx-3 px-3 py-3 rounded-2xl bg-red-50/60 ring-1 ring-red-200' : '')}
      data-echo-kerdes={azon || undefined} data-echo-hiba={hiba ? 'kotelezo' : undefined}>
      <div className="flex items-baseline justify-between mb-2">
        <span className={'text-[10px] font-black uppercase tracking-widest ' + (hiba ? 'text-red-600' : 'text-slate-400')}>{title}</span>
        <span className="text-[11px] font-bold text-slate-400">{items.length}/{max}</span>
      </div>
      {hiba && (
        <p className="inline-flex items-center gap-1.5 rounded-lg bg-red-100 text-red-700 text-xs font-black px-2 py-1 mb-2" role="alert" data-echo-kerdes-hiba="kotelezo">
          <Lucide.AlertCircle size={13} className="flex-none" /> {hiba}
        </p>
      )}
      {hint && <p className="text-xs text-slate-400 font-medium mb-3">{hint}</p>}
      <div className="space-y-2">
        {items.map((v, i) => (
          <div key={i} className="flex gap-2">
            <span className="flex-none w-9 h-[46px] rounded-xl bg-slate-100 text-slate-500 text-xs font-black flex items-center justify-center">{i + 1}</span>
            <input className={U_input} value={v} maxLength={240} placeholder={placeholder}
              onChange={e => setAt(i, e.target.value)} />
            <button type="button" onClick={() => del(i)}
              className="flex-none w-11 h-[46px] rounded-xl text-slate-300 hover:text-red-500 hover:bg-red-50 flex items-center justify-center transition-colors">
              <Lucide.Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
      {items.length < max && (
        <button type="button" onClick={() => setItems(items.concat(['']))}
          className="mt-2 inline-flex items-center gap-2 text-sm font-bold text-primary hover:bg-primary/5 rounded-xl px-3 py-2.5 transition-colors">
          <Lucide.Plus size={16} /> Hozzáadás
        </button>
      )}
    </div>
  );
}

function ECHO_GoalsView({ course, onBack, onSaved }) {
  const [form, setForm] = useState(null);
  const [goals, setGoals] = useState([]);
  const [exps, setExps] = useState([]);
  // A két bevezető kérdés válasza: kérdés_id -> érték.
  const [intro, setIntro] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [touched, setTouched] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const f = await ECHO_api.getForm(course.campaign_id, course.course_id);
        if (dead) return;
        setForm(f);
        const g = (f && f.goals) || {};
        setGoals(Array.isArray(g.goals) && g.goals.length ? g.goals.map(String) : ['']);
        setExps(Array.isArray(g.expectations) && g.expectations.length ? g.expectations.map(String) : ['']);
        // A korábban mentett bevezető válaszok visszatöltése (echo_get_form
        // 'goals'.'intro' — 23_echo_form_rules.sql).
        setIntro((g.intro && typeof g.intro === 'object') ? g.intro : {});
      } catch (e) { if (!dead) { setForm(false); setErr(ECHO_msg(e)); } }
    })();
    return () => { dead = true; };
  }, [course.campaign_id, course.course_id]);

  if (form === null) {
    return (
      <div className="p-6 sm:p-8 max-w-3xl mx-auto space-y-4">
        <SkeletonBar w="180px" h={14} />
        <div className="bg-white rounded-3xl border border-slate-100 p-6 space-y-4">
          <SkeletonBar w="60%" h={18} /><SkeletonBar w="90%" /><SkeletonBar w="80%" /><SkeletonBar w="70%" />
        </div>
      </div>
    );
  }

  // Hibaag — a testverkomponens (ECHO_Wizard) mintajara. Enelkul a betoltes
  // elhasalasa utan (form === false) egy mukodokepesnek LATSZO, ures
  // celszerkeszto jelenne meg, amiben a mentes egy masodik hibat adna.
  if (form === false) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <UEmpty icon={<Lucide.AlertCircle size={28} />}
          title="A célmeghatározás nem tölthető be" subtitle={err}
          action={<button onClick={onBack} className={U_btnGhost}>Vissza</button>} />
      </div>
    );
  }

  const part1 = form && form.form && Array.isArray(form.form.parts)
    ? form.form.parts.find(p => p.id === 'part1') : null;

  const compiled = form.form || {};
  // A kérdőív nyelve itt is a KURZUSÉ — a célmeghatározó ugyanannak a
  // kérdőívnek az 1. része (3. § (1)). Lásd ECHO_formLang.
  const courseMeta = form.course || {};
  const lang = ECHO_formLang(courseMeta, compiled);
  const langFellBack = ECHO_langFellBack(courseMeta, compiled);

  // A két BEVEZETŐ kérdés a compiled part1 szakaszából.
  const introQs = ECHO_part1Questions(compiled);
  const introMissing = introQs.filter(q => q.required && !ECHO_answered(q, intro[q.id]));

  /* LEGALÁBB EGY CÉL KÖTELEZŐ. A célmeghatározás akkor ér valamit, ha van mit
     a félév végén értékelni: cél nélkül a "Célok teljesülése" szakasz teljesen
     kiesik a kitöltőből (ECHO_buildSteps), tehát az üresen mentett
     célmeghatározás csak látszatlépés lenne.
     Ugyanezt a szabályt az echo_save_goals() is kikényszeríti
     (ECHO_GOALS_REQUIRED) — a felület csak előbb szól. */
  const cleanGoals = goals.map(t => String(t).trim()).filter(Boolean).slice(0, 3);
  const cleanExps  = exps.map(t => String(t).trim()).filter(Boolean).slice(0, 3);
  const noGoal = cleanGoals.length === 0;
  const blocked = noGoal || introMissing.length > 0;

  const save = async () => {
    if (blocked) {
      setTouched(true);
      ECHO_elsoHibara(introMissing[0] || { id: 'echo-celok' });
      return;
    }
    setBusy(true); setErr(''); setTouched(false);
    try {
      await ECHO_api.saveGoals(course.campaign_id, course.course_id,
                               cleanGoals, cleanExps, intro);
      setToast('A célok elmentve.');
      onSaved && onSaved();
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto">
      <UToast msg={toast} onDone={() => setToast('')} />
      <button onClick={onBack} className="inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-primary mb-5 transition-colors">
        <Lucide.ArrowLeft size={16} /> Vissza a kurzusokhoz
      </button>

      <div className="bg-white rounded-3xl border border-slate-100 p-6 sm:p-8">
        <div className="flex items-start gap-3 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center flex-none">
            <Lucide.Target size={22} />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-black text-slate-900 tracking-tight">
              {part1 ? <ECHO_Src>{ECHO_txt(part1, lang)}</ECHO_Src> : 'Célmeghatározás'}
            </h2>
            <p className="text-sm text-slate-400 font-medium mt-0.5">
              <ECHO_Src>{course.course_code} · {course.course_name}</ECHO_Src>{(course.campaign_ref_no || course.campaign_code) ? <span className="ml-2 align-middle"><ECHO_KampanyId sorszam={course.campaign_ref_no} kod={course.campaign_code} kicsi /></span> : null}
            </p>
            {langFellBack && (
              <p className="mt-1.5 text-[11px] font-bold text-amber-700 inline-flex items-start gap-1.5">
                <Lucide.Languages size={13} className="flex-none mt-px" />
                A kurzus nyelvén ({ECHO_courseLang(courseMeta).toUpperCase()}) nincs jóváhagyott
                fordítás, ezért a kérdőívet magyarul mutatjuk.
              </p>
            )}
          </div>
        </div>

        <div className="bg-sky-50/60 border border-sky-100 rounded-2xl px-4 py-3 mb-7 flex gap-2.5">
          <Lucide.Info size={16} className="text-sky-500 flex-none mt-0.5" />
          <p className="text-xs text-sky-900/70 font-medium leading-relaxed">
            A félév elején kitűzött célok csak a Tiéd — az oktató nem látja őket, és a
            félév végi értékelésbe sem kerülnek át. Egyedül azt visszük tovább, hogy a
            céljaid mennyiben teljesültek.
          </p>
        </div>

        {/* A KÉT BEVEZETŐ KÉRDÉS. A prototípus szerint a célmeghatározás ezekkel
            indul: volt-e szó a célokról az oktatóval, és világosak-e a
            teljesítési követelmények. A szövegük a compiled part1 szakaszából
            jön, nem innen — lásd ECHO_part1Questions. */}
        {introQs.length > 0 && (
          <div className="mb-2 -mt-2 border-b border-slate-50">
            {introQs.map((q, i) => (
              <ECHO_Question key={q.id} q={q} index={i + 1} lang={lang} seed={'goals|' + course.course_id}
                ctx={{ course: courseMeta }}
                hiba={touched && introMissing.indexOf(q) >= 0 ? 'kotelezo' : null}
                value={intro[q.id]}
                onChange={(v) => { setIntro(prev => ({ ...prev, [q.id]: v })); setTouched(false); }} />
            ))}
          </div>
        )}

        <div className="space-y-8">
          <ECHO_ListEditor title="Céljaim ezen a kurzuson" max={3} items={goals} setItems={(v) => { setGoals(v); setTouched(false); }}
            azon="echo-celok" hiba={touched && noGoal ? 'Nem lett kitöltve — legalább egy célt adj meg (e nélkül a félév végén nincs mit értékelni).' : null}
            placeholder="Pl. magabiztosan írjak SQL lekérdezést"
            hint="Legalább 1, legfeljebb 3 cél. Konkrét, félév végén eldönthető megfogalmazás segít a legtöbbet." />
          <ECHO_ListEditor title="Elvárásaim az oktatótól" max={3} items={exps} setItems={setExps}
            placeholder="Pl. kapjak érdemi visszajelzést a beadandóra"
            hint="Legfeljebb 3 elvárás — ez a rész nem kötelező." />
        </div>

        {/* A hiányt a kérdéseknél jelöljük; itt csak egy rövid utalás marad a gomb közelében. */}
        {touched && blocked && (
          <p className="mt-6 text-[12px] font-bold text-red-600 flex items-center gap-1.5" role="alert" data-echo-sav-hiba="1">
            <Lucide.AlertCircle size={14} className="flex-none" /> A hiányzó válaszokat pirossal jelöltük a kérdéseknél.
          </p>
        )}

        {err && (
          <div className="mt-6 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
            <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
          </div>
        )}

        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <button onClick={save} disabled={busy} className={U_btnPrimary + ' flex-1'}>
            {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.Save size={16} />}
            {busy ? 'Mentés…' : 'Célok mentése'}
          </button>
          <button onClick={onBack} className={U_btnGhost}>Bezárás</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   6. Félév végi KITÖLTŐ VARÁZSLÓ
   ------------------------------------------------------------ */

/* A beküldött payload összeállítása. Az alakot az echo_submit fejléce írja elő:
     { attendance, course:{…}, teachers:[{teacher, skipped, skip_reason, answers:{…}}] }
   Modulszintű (nem a varázsló closure-jében), hogy önmagában is tesztelhető
   legyen a valódi compiled JSONB-vel.
   A szerver ezen felül még LEVÁGJA az azonosító mezőket — a frontend nem
   védvonal, csak jóhiszemű fél. Ide szándékosan nem kerül semmilyen
   időbélyeg, sorszám vagy hallgatói azonosító. */
function ECHO_buildPayload(compiled, teachers, ans, tans, hasGoals, goalItems) {
  const sections = (compiled && compiled.sections) || [];
  const items = Array.isArray(goalItems) ? goalItems : [];
  const courseAns = {};
  let attendance = null;

  sections.forEach((sec) => {
    if (sec.part && sec.part !== 'part2') return;
    (sec.questions || []).forEach((q) => {
      // repeat:"goal" — a célonként megadott értékek EGY összesített értékké
      // olvadnak. A tételes cél-adat (szöveg, darabszám, sorrend) SZÁNDÉKOSAN
      // nem kerül a payloadba: a célok számossága kvázi-azonosító, a szövegük
      // pedig egyenesen azonosít. Lásd ECHO_goalsMerge magyarázatát és az
      // echo_submit() 4. lépését, ami ezeket a kulcsokat amúgy is levágja.
      if (ECHO_repGoal(q)) {
        if (!items.length) return;
        if (!ECHO_condOk(q.cond, { answers: ans, hasGoals })) return;
        const merged = ECHO_goalsMerge(items.map(it => ans[ECHO_goalKey(q, it)]));
        if (merged !== undefined) courseAns[q.id] = merged;
        return;
      }
      if (q.repeat) return;
      if (!ECHO_condOk(q.cond, { answers: ans, hasGoals })) return;
      const v = ans[q.id];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
      // Az óralátogatás az echo_submit szerint a payload GYÖKERÉBE megy
      // (v_att := p_payload->>'attendance'), nem a course objektumba.
      if (q.id === 'attendance') { attendance = String(v); return; }
      courseAns[q.id] = v;
    });
  });

  // A kihagyás-kérdés (type:"skip", repeat:"teacher") — ez nem válasz, hanem
  // a skipped/skip_reason mezőpár forrása, ezért az answers közé nem kerül be.
  const skipQ = sections
    .reduce((acc, s) => acc.concat((s.questions || []).filter(q => q.type === 'skip' && q.repeat === 'teacher')), [])[0];

  const tArr = (teachers || []).map((t) => {
    const bag = (tans && tans[t.id]) || {};
    const skipVal = skipQ ? bag[skipQ.id] : undefined;
    const skipped = !!(skipVal !== undefined && skipVal !== null && skipVal !== '');
    const answers = {};
    if (!skipped) {
      Object.keys(bag).forEach((k) => {
        if (skipQ && k === skipQ.id) return;
        const v = bag[k];
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
        answers[k] = v;
      });
    }
    return { teacher: t.id, skipped, skip_reason: skipped ? String(skipVal) : null, answers };
  });

  return { attendance, course: courseAns, teachers: tArr };
}

/* A TELJES kitöltésen végigfutó "Egyéb"-ellenőrzés. A lépésenkénti kapu
   (ECHO_otherMissing a Tovább gombon) elvileg elég — csak úgy lehet eljutni az
   összegzésig, ha minden lépés átment rajta —, de a beküldés előtt ez a
   függvény még egyszer végignézi az egészet. Olcsó, és így a hallgató a saját
   nyelvén kapja meg a hibát, nem szerverhibaként (ECHO_OTHER_TEXT_REQUIRED).
   Modulszintű, hogy a valódi compiled JSONB-vel önmagában is tesztelhető legyen. */
function ECHO_otherGaps(compiled, teachers, ans, tans, hasGoals, goalItems) {
  const sections = (compiled && compiled.sections) || [];
  const items = Array.isArray(goalItems) ? goalItems : [];
  const gaps = [];
  sections.forEach((sec) => {
    if (sec.part && sec.part !== 'part2') return;
    (sec.questions || []).forEach((q) => {
      if (q.type !== 'multi') return;
      if (ECHO_repTeacher(q)) {
        (teachers || []).forEach((t) => {
          const bag = (tans && tans[t.id]) || {};
          if (!ECHO_condOk(q.cond, { answers: bag, hasGoals })) return;
          if (ECHO_otherMissing(q, bag[q.id])) gaps.push({ q, teacher: t });
        });
        if (!ECHO_repGoal(q)) return;   // teacher_goal: a célonkénti ág is fusson
      }
      if (ECHO_repGoal(q)) {
        if (!items.length) return;
        items.forEach((it) => {
          if (ECHO_otherMissing(q, ans[ECHO_goalKey(q, it)])) gaps.push({ q, goal: it });
        });
        return;
      }
      if (!ECHO_condOk(q.cond, { answers: ans, hasGoals })) return;
      if (ECHO_otherMissing(q, ans[q.id])) gaps.push({ q });
    });
  });
  return gaps;
}

/* Az első olyan lépés, ahol kötelező kérdés válasz nélkül maradt, vagy az „Egyéb”
   mellől hiányzik a szöveg. Ugyanaz a láthatósági szabály, mint a varázsló
   visibleQs-ében. { lepes, q } vagy null. */
function ECHO_elsoHianyosLepes(steps, ans, tans, hasGoals) {
  for (let i = 0; i < (steps || []).length; i++) {
    const st = steps[i];
    if (!st || !st.section) continue;
    const qs = Array.isArray(st.section.questions) ? st.section.questions : [];
    let lathato, ertek;
    if (st.kind === 'teacher') {
      const bag = (tans && tans[st.teacher.id]) || {};
      lathato = qs.filter(q => ECHO_repTeacher(q) && ECHO_condOk(q.cond, { answers: bag, hasGoals }));
      ertek = (q) => bag[q.id];
    } else if (st.kind === 'goal') {
      lathato = qs.filter(q => ECHO_repGoal(q) && ECHO_condOk(q.cond, { answers: ans, hasGoals }));
      ertek = (q) => ans[ECHO_goalKey(q, st.goal)];
    } else {
      lathato = qs.filter(q => !q.repeat && ECHO_condOk(q.cond, { answers: ans, hasGoals }));
      ertek = (q) => ans[q.id];
    }
    const q = lathato.find(x => (x.required && !ECHO_answered(x, ertek(x))) || ECHO_otherMissing(x, ertek(x)));
    if (q) return { lepes: i, q };
  }
  return null;
}

/* A blokkolt továbblépésnél az első hibás kérdéshez görgetünk. */
function ECHO_elsoHibara(kerdes) {
  if (!kerdes) return;
  setTimeout(() => {
    try {
      const el = document.querySelector('[data-echo-kerdes="' + String(kerdes.id).replace(/"/g, '') + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {}
  }, 60);
}

function ECHO_Wizard({ course, onBack, onSubmitted }) {
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [step, setStep] = useState(0);
  const [ans, setAns] = useState({});     // kurzusszintű: kérdés_id -> érték
  const [tans, setTans] = useState({});   // oktató_id -> { kérdés_id -> érték }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [touched, setTouched] = useState(false);
  // A kiadott, de meg el nem koltott jegy. Csak a memoriaban el (nem
  // localStorage-ban): a jegy egy alairt, ervenyes bekuldesi jogosultsag,
  // amit nem teszunk a hallgato gepere. Lasd a submit() magyarazatat.
  const ticketRef = useRef(null);
  // A "randomize" kérdések keverési magja — kitöltésenként egyszer születik.
  const [seed] = useState(() => String(Date.now()) + ':' + Math.random().toString(36).slice(2));

  /* ---------- PISZKOZAT (22_echo_draft.sql) ----------
     draft:  null = meg toltjuk, false = nincs mentett piszkozat,
             objektum = van, es a hallgatonak felajanljuk a folytatast.
     resume: null = meg nem dontott, true/false = dontott. Amig null es van
             piszkozat, a kitolto helyett a FELAJANLO kepernyo latszik.
     A mentes NEM billentyuleutesenkent fut, hanem lepesvaltaskor es amikor egy
     mezo elveszti a fokuszt (lasd az onBlur-t a lepes tartalman) — igy egy
     kitoltes nagysagrendileg tizes, nem ezres nagysagrendu irast jelent. */
  const [draft, setDraft] = useState(null);
  const [resume, setResume] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  // A legutobb ELMENTETT allapot ujjlenyomata. Ha nem valtozott, nem irunk.
  const lastSavedRef = useRef('');

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const f = await ECHO_api.getForm(course.campaign_id, course.course_id);
        if (!dead) setForm(f);
      } catch (e) { if (!dead) { setForm(false); setErr(ECHO_msg(e)); } }
      // A piszkozat lekerdezese KULON hibaag: ha ez elszall (pl. a 22-es
      // migracio meg nem ment fel), a kitoltes akkor is induljon — csak
      // mentes nelkul. A piszkozat kenyelem, nem elofeltetel.
      try {
        const d = await ECHO_api.draftGet(course.campaign_id, course.course_id);
        if (dead) return;
        if (d && d.van) { setDraft(d); }
        else { setDraft(false); setResume(false); }
      } catch (e) { if (!dead) { setDraft(false); setResume(false); } }
    })();
    return () => { dead = true; };
  }, [course.campaign_id, course.course_id]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [step]);

  /* A tenyleges mentes. Csendben bukik: a piszkozat elvesztese kellemetlen, de
     a kitoltest nem szabad megallitania — a hallgato valaszai a memoriaban
     tovabb elnek, es a bekuldes utjaban semmi nem all. A hibat a fejlecben
     megjeleno "nem sikerult menteni" jelzes mondja el, nem egy modalis ablak. */
  const [saveErr, setSaveErr] = useState(false);
  const saveDraft = async (aBag, tBag, atStep) => {
    // Amig a hallgato nem dontott a folytatasrol, NEM irunk felul semmit.
    if (resume === null) return;
    const payload = { ans: aBag, tans: tBag };
    const fp = JSON.stringify(payload) + '|' + atStep;
    if (fp === lastSavedRef.current) return;      // nem valtozott
    setSaving(true);
    try {
      await ECHO_api.draftSave(course.campaign_id, course.course_id, payload, atStep);
      lastSavedRef.current = fp;
      setSavedAt(new Date());
      setSaveErr(false);
    } catch (e) { setSaveErr(true); }
    finally { setSaving(false); }
  };

  // A piszkozat lekerdezesere is varunk: kulonben egy pillanatra felvillanna az
  // ures urlap, mielott a folytatast felajanljuk.
  if (form === null || draft === null) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-4">
        <SkeletonBar w="180px" h={14} />
        <div className="bg-white rounded-3xl border border-slate-100 p-6 space-y-5">
          <SkeletonBar w="55%" h={20} />
          <SkeletonBar w="100%" h={48} /><SkeletonBar w="100%" h={48} /><SkeletonBar w="100%" h={48} />
        </div>
      </div>
    );
  }
  if (form === false) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <UEmpty icon={<Lucide.AlertCircle size={28} />} title="A kérdőív nem tölthető be" subtitle={err}
          action={<button onClick={onBack} className={U_btnGhost}>Vissza</button>} />
      </div>
    );
  }

  /* ---------- A FOLYTATÁS FELAJÁNLÁSA ----------
     Van mentett piszkozat, és a hallgató még nem döntött. Két út van, és
     mindkettő visszafordíthatatlan a maga módján — ezért kérdezünk, ahelyett
     hogy némán visszatöltenénk. */
  if (draft && resume === null) {
    const startFresh = async () => {
      // Az ujrakezdes ELDOBJA a mentett piszkozatot. Ha csak a memoriaban
      // kezdenenk ujra, a regi payload ott maradna a szerveren addig, amig egy
      // kesobbi mentes felul nem irja — vagyis a hallgato azt hinne, hogy
      // eldobta, kozben megvan. Ezert torlunk, es csak utana engedunk tovabb.
      setResume(false);
      try { await ECHO_api.draftDrop(course.campaign_id, course.course_id); } catch (e) { /* csendben */ }
      lastSavedRef.current = '';
    };
    return (
      <div className="p-4 sm:p-8 max-w-2xl mx-auto">
        <div className="bg-white rounded-3xl border border-slate-100 p-8 sm:p-10">
          <div className="w-16 h-16 rounded-3xl bg-blue-50 text-blue-500 flex items-center justify-center mb-5">
            <Lucide.PauseCircle size={32} />
          </div>
          <h2 className="text-2xl font-black text-slate-900 tracking-tight">Van egy félbehagyott kitöltésed</h2>
          <p className="text-sm text-slate-500 font-medium mt-3 leading-relaxed">
            Ezen a kurzuson <b className="text-slate-700">{ECHO_dateTime(draft.mentve)}</b> mentettünk
            utoljára{typeof draft.step === 'number' ? ` a ${draft.step + 1}. lépésnél` : ''}.
            Folytathatod ott, ahol abbahagytad.
          </p>
          <div className="mt-5 rounded-2xl bg-amber-50 border border-amber-100 px-4 py-3.5">
            <p className="text-[11px] font-black uppercase tracking-widest text-amber-600 mb-1.5">
              Amit a piszkozatról tudnod kell
            </p>
            <p className="text-xs text-amber-800 font-medium leading-relaxed">
              A mentett piszkozat — a beküldésig — <b>visszakereshető hozzád</b>: a kitöltésed
              a fiókodhoz kötve várakozik. A tartalmát rajtad kívül senki nem látja, sem oktató,
              sem adminisztrátor. A <b>beküldés pillanatában</b> ez a kapcsolat elszakad: a
              válaszaid névtelenül kerülnek be, a piszkozat pedig törlődik.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 mt-7">
            <button
              onClick={() => {
                const p = draft.payload || {};
                setAns(p.ans && typeof p.ans === 'object' ? p.ans : {});
                setTans(p.tans && typeof p.tans === 'object' ? p.tans : {});
                setStep(Number(draft.step) > 0 ? Number(draft.step) : 0);
                // A visszatoltott allapot MAR el van mentve — ne irjuk ki ujra.
                lastSavedRef.current = JSON.stringify({
                  ans: (draft.payload || {}).ans || {}, tans: (draft.payload || {}).tans || {},
                }) + '|' + (Number(draft.step) || 0);
                setSavedAt(new Date(draft.mentve));
                setResume(true);
              }}
              className={U_btnPrimary + ' flex-1 py-3.5'}>
              <Lucide.PlayCircle size={16} /> Folytatás
            </button>
            <button onClick={startFresh} className={U_btnGhost + ' flex-1 py-3.5'}>
              <Lucide.RotateCcw size={16} /> Újrakezdés üres űrlappal
            </button>
          </div>
          <button onClick={onBack} className="mt-4 text-sm font-bold text-slate-400 hover:text-primary transition-colors">
            Most nem töltöm ki — a piszkozat megmarad
          </button>
        </div>
      </div>
    );
  }

  const compiled = form.form || {};
  const teachers = Array.isArray(form.teachers) ? form.teachers : [];
  /* A KÉRDŐÍV NYELVE — 3. § (1): a KÉPZÉS nyelve dönt, nem a fejléc
     nyelvválasztója. A kurzus nyelvét az echo_get_form() 'course'.'lang'
     mezője hozza. A felület KERETE (gombok, lépésszámláló) marad a
     felhasználó nyelvén — azt az app.jsx fordítója kezeli. */
  const courseMeta = form.course || {};
  const lang = ECHO_formLang(courseMeta, compiled);
  const langFellBack = ECHO_langFellBack(courseMeta, compiled);
  // A félév elején mentett célok és oktatói elvárások — az echo_get_form
  // ezeket a HÍVÓ SAJÁT sorából adja vissza (echo.student_goal).
  const goalItems = ECHO_goalItems(form.goals);
  const hasGoals = goalItems.length > 0;
  const steps = ECHO_buildSteps(compiled, teachers, goalItems);
  const cur = steps[Math.min(step, steps.length - 1)];

  // Az aktuális lépés látható kérdései (a cond kiértékelése után).
  const visibleQs = (() => {
    if (!cur || !cur.section) return [];
    const qs = Array.isArray(cur.section.questions) ? cur.section.questions : [];
    if (cur.kind === 'teacher') {
      const bag = tans[cur.teacher.id] || {};
      return qs.filter(q => ECHO_repTeacher(q) && ECHO_condOk(q.cond, { answers: bag, hasGoals }));
    }
    if (cur.kind === 'goal') {
      // A célonkénti kérdés válaszai a kurzusszintű `ans` zsákban élnek,
      // cél-utótaggal ellátott kulcson. A cond kiértékelése ezért a NYERS
      // `ans`-t kapja: a mai kérdőívben a célkérdésnek nincs feltétele, egy
      // jövőbeli feltétel viszont csak nem-ismétlődő kérdésre hivatkozhat.
      return qs.filter(q => ECHO_repGoal(q) && ECHO_condOk(q.cond, { answers: ans, hasGoals }));
    }
    return qs.filter(q => !q.repeat && ECHO_condOk(q.cond, { answers: ans, hasGoals }));
  })();

  // A válaszkulcs a lépés fajtájától függ:
  //   teacher — oktatónkénti zsák (tans[oktató_id]), kulcs a kérdés id-ja;
  //   goal    — a kurzusszintű zsák, kulcs "<kérdés_id>@<cél_kulcs>", tehát
  //             célonként EGYEDI (két azonos szövegű cél sem ütközik);
  //   section — a kurzusszintű zsák, kulcs a kérdés id-ja.
  const keyOf = (q) => (cur.kind === 'goal' ? ECHO_goalKey(q, cur.goal) : q.id);
  // A lépés azonosítója a React-kulcshoz és a keverési maghoz. Célonként külön
  // kell, különben a két cél kérdése ugyanazt a komponenspéldányt kapná, és a
  // beírt érték átcsordulna a következő célra.
  const stepKey = cur.kind === 'teacher' ? cur.teacher.id
                : cur.kind === 'goal'    ? (cur.section.id + '#' + cur.goal.key)
                : (cur.section ? cur.section.id : 'review');
  const getV = (q) => (cur.kind === 'teacher' ? (tans[cur.teacher.id] || {})[q.id] : ans[keyOf(q)]);
  const setV = (q, v) => {
    if (cur.kind === 'teacher') {
      const id = cur.teacher.id;
      setTans(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [q.id]: v } }));
    } else {
      const k = keyOf(q);
      setAns(prev => ({ ...prev, [k]: v }));
    }
    setTouched(false);
  };

  const missing = visibleQs.filter(q => q.required && !ECHO_answered(q, getV(q)));
  /* "EGYÉB" BEJELÖLVE, DE NINCS MELLÉ SZÖVEG. Ez a kötelezőségtől FÜGGETLEN
     hiány: egy nem kötelező kérdésnél is értelmetlen a csupasz "Egyéb".
     Ugyanezt a szabályt az echo_submit() is kikényszeríti — a felület csak
     azért kapja meg, hogy a hallgató ELŐBB értesüljön róla, mint a beküldésnél. */
  const otherOpen = visibleQs.filter(q => ECHO_otherMissing(q, getV(q)));
  const blocked = missing.length + otherOpen.length;
  const isLast = cur && cur.kind === 'review';

  /* A BEHELYETTESÍTÉS KÖRNYEZETE: a kurzus, és — oktatónkénti lépésen — az
     ÉPPEN értékelt oktató, célonkéntin az éppen értékelt cél. Így oldódik fel
     az "[Oktató neve] erősségei" a valódi névre. */
  const tokenCtx = {
    course: courseMeta,
    teacher: cur && cur.kind === 'teacher' ? cur.teacher : null,
    goal: cur && cur.kind === 'goal' ? cur.goal : null,
  };

  const submit = async () => {
    // Teljesen üres értékelést nem küldünk be: az egy elköltött jegy tartalom nélkül.
    const ertekes = (v) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length));
    const vanValasz = Object.keys(ans || {}).some(k => ertekes(ans[k]))
      || Object.keys(tans || {}).some(t => Object.keys(tans[t] || {}).some(k => ertekes(tans[t][k])));
    if (!vanValasz) {
      setErr('Egyetlen kérdésre sem válaszoltál — üres értékelést nem küldünk be. Lépj vissza, és töltsd ki a kérdéseket.');
      return;
    }
    /* Ha egy korábbi lépés hiányos (pl. piszkozatból közvetlenül az összegzésre
       érkezett), oda lépünk vissza, és a hibát a kérdésnél mutatjuk. */
    const hiany = ECHO_elsoHianyosLepes(steps, ans, tans, hasGoals);
    if (hiany) {
      setErr(''); setStep(hiany.lepes); setTouched(true); ECHO_elsoHibara(hiany.q);
      return;
    }
    // Végső ellenőrzés a teljes kitöltésen — lásd ECHO_otherGaps.
    const gaps = ECHO_otherGaps(compiled, teachers, ans, tans, hasGoals, goalItems);
    if (gaps.length) {
      setErr('Egy „Egyéb" válasz mellől hiányzik a szöveg (' +
             gaps.map(g => ECHO_txt(g.q, lang)).join(' · ') +
             '). Lépj vissza arra a kérdésre, és írd le, mi volt az.');
      return;
    }
    setBusy(true); setErr('');
    try {
      // 1) AZONOSÍTOTT lépés: a részvételi napló megjelöli, hogy próbálkoztunk.
      //    A jegyről a szerver semmit nem tárol — csak aláírja.
      //
      //    JEGY-ÚJRAHASZNOSÍTÁS: ha egy korábbi próbálkozás a 2) lépésnél bukott
      //    el (pl. hálózati hiba), a jegy NINCS elköltve — az elköltést jelző
      //    nonce ugyanabban a tranzakcióban íródik, mint a válasz, tehát együtt
      //    is szállnak el. Ilyenkor ÚJ jegyet kérni két bajt okozna:
      //      • a hallgató elfogyasztaná a max_tickets_per_course keretét, és a
      //        második hiba után ECHO_TICKET_LIMIT-tel kizárná magát;
      //      • az elpazarolt jegy miatt a kurzuson a kiadott jegyek száma
      //        tartósan meghaladná a válaszokét, és az echo.mark_submitted()
      //        — ami jegyalapon számol — SOHA nem tudná lezártnak jelölni.
      //    Ezért a memóriában tartjuk, és amíg érvényes, újra ezt küldjük.
      const now = Date.now();
      if (!ticketRef.current || ticketRef.current.expMs <= now) {
        const t = await ECHO_api.issueTicket(course.campaign_id, course.course_id);
        // Biztonsagi ratartas: a szerveroldali TTL-nel 60 masodperccel korabban
        // tekintjuk lejartnak, hogy a halozati ido ne fusson bele a lejaratba.
        const ttlMs = (Number(t.ttl_minutes) || 0) * 60000;
        ticketRef.current = { ticket: t.ticket, expMs: now + Math.max(ttlMs - 60000, 0) };
      }
      // 2) ANONIM lépés: külön, munkamenet nélküli klienssel. A JWT nem megy ki.
      await ECHO_api.submit(ticketRef.current.ticket,
                            ECHO_buildPayload(compiled, teachers, ans, tans, hasGoals, goalItems));
      ticketRef.current = null;   // elkoltottuk, tobbe nem hasznalhato

      /* A HALLGATÓ SAJÁT MÁSOLATA — kizárólag a böngészőjében. A szerver
         szándékosan nem tudja, ki mit válaszolt (lásd a fájl elején az
         ECHO_MASOLAT_KULCS magyarázatát), ezért ha a hallgató később vissza
         akarja olvasni a válaszait, ez az EGYETLEN mód, ami nem rontja el az
         anonimitást. Ha nem sikerül (privát ablak, tele tárhely), az nem hiba:
         a beküldés attól még megtörtént. */
      ECHO_masolatMent(course, compiled, teachers, ans, tans, lang);

      // 3) A PISZKOZAT ELDOBASA — kulon, AZONOSITOTT keresben, a bekuldes UTAN.
      //    Miert nem az echo_submit teszi: az anon jogon fut, es szandekosan
      //    nem tudja, ki kuldott be (lasd 22_echo_draft.sql fejlec). Ez a hivas
      //    mar semmilyen valasz-tartalmat nem hordoz, csak a kampany/kurzus
      //    part — a ket keres igy elvalik egymastol.
      //    Ha ez a hivas elszall, a piszkozat NEM marad orokre: a kampany
      //    zarasakor egy trigger, lejaratkor a takarito eltakaritja. Ezert
      //    nyeljuk a hibat — a hallgatonak a bekuldes sikerult, es ez a fontos.
      try { await ECHO_api.draftDrop(course.campaign_id, course.course_id); }
      catch (e) { /* csendben — a szerveroldali takaritas elviszi */ }

      setDone(true);
      onSubmitted && onSubmitted(course);
    } catch (e) {
      // A mar elkoltott vagy lejart jegyet dobjuk el, hogy az ujraprobalkozas
      // frisset kerjen; minden mas hibanal megtartjuk (lasd fent).
      const raw = (e && (e.message || e.error_description || e.hint)) || '';
      if (raw.indexOf('ECHO_TICKET_SPENT') >= 0 || raw.indexOf('ECHO_TICKET_EXPIRED') >= 0
          || raw.indexOf('ECHO_TICKET_BADSIG') >= 0) ticketRef.current = null;
      setErr(ECHO_msg(e));
    }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="p-4 sm:p-8 max-w-2xl mx-auto">
        <div className="bg-white rounded-3xl border border-slate-100 p-8 sm:p-10 text-center">
          <div className="w-20 h-20 rounded-3xl bg-emerald-50 text-emerald-500 flex items-center justify-center mx-auto mb-5">
            <Lucide.CheckCircle2 size={38} />
          </div>
          <h2 className="text-2xl font-black text-slate-900 tracking-tight">Köszönjük az értékelést</h2>
          <p className="text-sm text-slate-500 font-medium mt-3 leading-relaxed max-w-md mx-auto">
            A válaszaid névtelenül érkeztek be. A rendszer azt tartja nyilván, hogy
            ezt a kurzust értékelted, de azt nem, hogy mit írtál — a kettő külön
            táblában él, közös kulcs nélkül.
          </p>
          <button onClick={onBack} className={U_btnPrimary + ' mt-7'}>
            <Lucide.ArrowLeft size={16} /> Vissza a kurzusokhoz
          </button>
        </div>
      </div>
    );
  }

  /* NINCS NEKI SZÓLÓ KÉRDÉS. Ha a kérdőívből egyetlen kérdéslépés sem lesz (pl. csak
     célonként ismétlődő kérdés van, és a hallgatónak nincs célja), az összegzés
     üresen, beküldhetőnek látszana. Helyette megmondjuk, mi a helyzet. */
  if (steps.every(s => s.kind === 'review')) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto" data-echo-ures-kerdoiv="1">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-primary mb-4 transition-colors">
          <Lucide.ArrowLeft size={16} /> Vissza a kurzusokhoz
        </button>
        <div className="bg-white rounded-3xl border border-slate-100 p-8 text-center">
          <Lucide.FileQuestion size={28} className="text-slate-300 mx-auto mb-3" />
          <h2 className="text-lg font-black text-slate-900">Ebben a kérdőívben most nincs neked szóló kérdés</h2>
          <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto leading-relaxed">
            A kérdőív kérdései olyan feltételhez kötöttek, ami rád most nem illik (például a félév elején megadott célokhoz).
            Üres értékelést nem küldünk be. Ha szerinted ez hiba, jelezd a Nemzetközi Irodának.
          </p>
        </div>
      </div>
    );
  }

  const pct = Math.round(((step + 1) / steps.length) * 100);
  const title = cur.kind === 'review'
    ? 'Összegzés és beküldés'
    : ECHO_txt(cur.section, lang);

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto pb-32">
      <button onClick={onBack} className="inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-primary mb-4 transition-colors">
        <Lucide.ArrowLeft size={16} /> Kilépés — a válaszaid piszkozatként megmaradnak
      </button>

      {/* fejléc + lépésjelző */}
      <div className="bg-white rounded-3xl border border-slate-100 p-5 sm:p-6 mb-4">
        <p className="text-xs font-bold text-slate-400 mb-1">
          <ECHO_Src>{course.course_code} · {course.course_name}</ECHO_Src>{(course.campaign_ref_no || course.campaign_code) ? <span className="ml-2 align-middle"><ECHO_KampanyId sorszam={course.campaign_ref_no} kod={course.campaign_code} kicsi /></span> : null}
        </p>
        <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
          {cur.kind === 'review' ? title : <ECHO_Src>{title}</ECHO_Src>}
        </h2>
        {cur.kind === 'teacher' && (
          <p className="text-sm font-bold text-primary mt-1">
            <ECHO_Src>{cur.teacher.name}{cur.teacher.title ? ' · ' + cur.teacher.title : ''}</ECHO_Src>
          </p>
        )}
        {/* A KURZUS NYELVE DÖNT (3. § (1)). Ha a képzés nyelvén nincs fordítás,
            magyarra esünk vissza — és ezt MEGMONDJUK, mert különben az angol
            nyelvű képzés hallgatója azt hinné, elrontott valamit. Az élesítés
            előtti ellenőrzés miatt ez élő kérdőíven nem fordulhat elő. */}
        {langFellBack && (
          <p className="mt-2 text-[11px] font-bold text-amber-700 inline-flex items-start gap-1.5">
            <Lucide.Languages size={13} className="flex-none mt-px" />
            A kurzus nyelvén ({ECHO_courseLang(courseMeta).toUpperCase()}) nincs jóváhagyott
            fordítás, ezért a kérdőívet magyarul mutatjuk.
          </p>
        )}
        {cur.kind === 'goal' && (
          <div className="mt-2 rounded-2xl bg-primary/5 border border-primary/10 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-primary/60 mb-1">
              {cur.goal.kind === 'goal' ? 'A félév elején kitűzött célod' : 'Az oktatóval szemben megfogalmazott elvárásod'}
            </p>
            {/* A cél szövegét a HALLGATÓ írta — gépi fordítás nem érintheti. */}
            <p className="text-sm font-bold text-slate-800 leading-snug"><ECHO_Src>{cur.goal.text}</ECHO_Src></p>
          </div>
        )}
        <div className="mt-4">
          <div className="flex items-center justify-between text-[11px] font-black uppercase tracking-wider text-slate-400 mb-1.5">
            <span>{step + 1}. lépés / {steps.length}</span><span>{pct}%</span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: pct + '%' }} />
          </div>
        </div>

        {/* ---------- MENTÉSI ÁLLAPOT + ŐSZINTE KÖZLÉS ----------
            A piszkozat kényelmes, de nem ingyenes: a beküldésig a fiókhoz
            kötve áll. Ezt nem elrejteni kell, hanem kimondani — ugyanott,
            ahol a mentés tényét is közöljük. */}
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-start gap-2">
          <span className="flex-none mt-0.5 text-slate-300">
            {saving ? <Lucide.Loader2 size={13} className="animate-spin" />
                    : saveErr ? <Lucide.CloudOff size={13} className="text-amber-500" />
                    : <Lucide.Cloud size={13} />}
          </span>
          <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
            {saving ? <b className="text-slate-500">Mentés…</b>
             : saveErr ? <b className="text-amber-600">A piszkozatot most nem sikerült menteni — a válaszaid a böngészőben megvannak.</b>
             : savedAt ? <b className="text-slate-500">Piszkozat mentve {ECHO_dateTime(savedAt)}.</b>
             : <b className="text-slate-500">A kitöltésed automatikusan mentődik.</b>}
            {' '}A piszkozat a beküldésig <b className="text-slate-500">visszakereshető hozzád</b>, de
            a tartalmát rajtad kívül senki nem látja. A beküldés pillanatában ez a kapcsolat
            elszakad, és a piszkozat törlődik.
          </p>
        </div>
      </div>

      {/* a lépés tartalma
          AUTOMATIKUS MENTÉS: az onBlur a React-ben buborékol (focusout), tehát
          ez az EGY kezelő elkapja minden beágyazott mező fókuszvesztését — a
          szövegdobozét is. Szándékosan NEM onChange: billentyűleütésenként
          menteni feleslegesen terhelné a szervert, és a szabadszöveges válasz
          minden köztes változatát rögzítené. */}
      <div className="bg-white rounded-3xl border border-slate-100 px-5 sm:px-8 py-2"
           onBlur={() => { saveDraft(ans, tans, step); }}>
        {cur.kind === 'review' ? (
          <ECHO_Review compiled={compiled} teachers={teachers} ans={ans} tans={tans}
            hasGoals={hasGoals} goalItems={goalItems} lang={lang} onJump={setStep} steps={steps}
            course={courseMeta} />
        ) : visibleQs.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-400 font-bold">
            Ebben a szakaszban most nincs megválaszolandó kérdés.
          </div>
        ) : (
          visibleQs.map((q, i) => (
            <ECHO_Question key={stepKey + '|' + q.id}
              q={q} index={i + 1} lang={lang} seed={seed + '|' + stepKey}
              ctx={tokenCtx}
              hiba={touched ? (missing.indexOf(q) >= 0 ? 'kotelezo' : (otherOpen.indexOf(q) >= 0 ? 'egyeb' : null)) : null}
              value={getV(q)} onChange={(v) => setV(q, v)} />
          ))
        )}
      </div>

      {err && (
        <div className="mt-3 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {/* navigáció — mobilon a hüvelykujj közelében ragad meg */}
      <div className="fixed bottom-0 left-72 right-0 bg-white/95 backdrop-blur border-t border-slate-100 px-4 sm:px-8 py-3 z-40">
        {/* A figyelmeztetés a gombok fölött is látszik — az oldal alján a sáv mögé kerülhetett. */}
        {touched && blocked > 0 && (
          <div className="max-w-3xl mx-auto mb-2 text-[12px] font-bold text-red-600 flex items-center gap-1.5" role="alert" data-echo-sav-hiba="1">
            <Lucide.AlertCircle size={14} className="flex-none" />
            {missing.length > 0 ? 'Még ' + missing.length + ' kötelező kérdés vár válaszra — pirossal jelöltük.' : 'Egy „Egyéb” válasz mellé még szöveg kell — pirossal jelöltük.'}
          </div>
        )}
        <div className="max-w-3xl mx-auto flex gap-3">
          {/* Lepesvaltaskor mentunk — ez a masik automatikus mentesi pont. */}
          <button onClick={() => { setTouched(false); const n = Math.max(0, step - 1); setStep(n); saveDraft(ans, tans, n); }}
            disabled={step === 0} className={U_btnGhost + ' flex-none'}>
            <Lucide.ChevronLeft size={16} /> Vissza
          </button>
          {isLast ? (
            <button onClick={submit} disabled={busy} className={U_btnPrimary + ' flex-1'}>
              {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.Send size={16} />}
              {busy ? 'Beküldés…' : 'Névtelen beküldés'}
            </button>
          ) : (
            <button
              onClick={() => {
                if (blocked) { setTouched(true); ECHO_elsoHibara(visibleQs.find(x => missing.indexOf(x) >= 0 || otherOpen.indexOf(x) >= 0)); return; }
                setTouched(false); const n = step + 1; setStep(n); saveDraft(ans, tans, n);
              }}
              className={U_btnPrimary + ' flex-1'}>
              Tovább <Lucide.ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Az összegző lépés: mit fogunk beküldeni. Szándékosan nincs benne
// semmi, ami a kitöltőt azonosítaná.
function ECHO_Review({ compiled, teachers, ans, tans, hasGoals, goalItems, lang, onJump, steps, course }) {
  /* Az összegzésben is a FELOLDOTT kérdésszöveg áll — különben a hallgató a
     lépéseken a valódi oktatónevet látná, az összegzésben viszont visszakapná
     a nyers "[Oktató neve]"-t. A `t` az a környezet, amiben a kérdés elhangzott. */
  const label = (q, t) => ECHO_txt(ECHO_resolveTokens(q, { course: course, teacher: t || null }), lang);
  const show = (v) => Array.isArray(v) ? v.join(' · ') : (typeof v === 'number' ? String(v) : String(v || '—'));
  const items = Array.isArray(goalItems) ? goalItems : [];

  const courseRows = [];
  const goalRows = [];       // { q, item, v } — célonként, csak a KÉPERNYŐN
  const goalMerged = [];     // { q, v }      — ez az, ami TÉNYLEG beküldésre kerül
  (compiled.sections || []).forEach((sec) => {
    if (sec.part && sec.part !== 'part2') return;
    (sec.questions || []).forEach((q) => {
      if (ECHO_repGoal(q)) {
        if (!items.length) return;
        if (!ECHO_condOk(q.cond, { answers: ans, hasGoals })) return;
        items.forEach(it => goalRows.push({ q, item: it, v: ans[ECHO_goalKey(q, it)] }));
        goalMerged.push({ q, v: ECHO_goalsMerge(items.map(it => ans[ECHO_goalKey(q, it)])) });
        return;
      }
      if (q.repeat) return;
      if (!ECHO_condOk(q.cond, { answers: ans, hasGoals })) return;
      courseRows.push({ q, v: ans[q.id] });
    });
  });

  // Az összevont érték felületi címkéje. A value-k az echo_submit() CHECK-jéből
  // valók; ha egy jövőbeli kérdőív mást használ, a nyers értéket írjuk ki.
  const MERGED_LABEL = { nem_teljesult: 'Nem teljesült', reszben: 'Részben teljesült',
                         teljesult: 'Teljesült', tulteljesult: 'Túlteljesült' };
  // A célonkénti válasz felületi címkéje az adott kérdés saját opciólistájából.
  const optLabel = (q, v) => {
    const hit = ECHO_options(q, lang).filter(o => o.value === v)[0];
    return hit ? hit.label : (v === undefined || v === null || v === '' ? '—' : String(v));
  };

  const skipQ = (compiled.sections || [])
    .reduce((acc, s) => acc.concat((s.questions || []).filter(q => q.type === 'skip' && q.repeat === 'teacher')), [])[0];

  return (
    <div className="py-6 space-y-7">
      <div className="bg-emerald-50/60 border border-emerald-100 rounded-2xl px-4 py-3 flex gap-2.5">
        <Lucide.Lock size={16} className="text-emerald-600 flex-none mt-0.5" />
        <p className="text-xs text-emerald-900/70 font-medium leading-relaxed">
          A beküldés külön, bejelentkezés nélküli csatornán megy: a válaszaid mellé
          nem kerül sem a fiókod azonosítója, sem időbélyeg. A rendszer csak azt
          jegyzi fel — külön táblában —, hogy ezt a kurzust értékelted.
        </p>
      </div>

      <div>
        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">A kurzusra adott válaszaid</h4>
        <div className="space-y-2.5">
          {courseRows.map(({ q, v }) => (
            <div key={q.id} className="flex items-start gap-3 text-sm">
              <span className="flex-1 text-slate-400 font-medium"><ECHO_Src>{label(q)}</ECHO_Src></span>
              <span className="flex-1 text-slate-800 font-bold text-right"><ECHO_Src>{show(v)}</ECHO_Src></span>
            </div>
          ))}
        </div>
      </div>

      {goalRows.length > 0 && (
        <div>
          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">A céljaid teljesülése</h4>
          <div className="space-y-2.5">
            {goalRows.map(({ q, item, v }) => {
              const idx = steps.findIndex(st => st.kind === 'goal' && st.goal.key === item.key
                                             && st.section && (st.section.questions || []).some(x => x.id === q.id));
              return (
                <button key={ECHO_goalKey(q, item)} onClick={() => idx >= 0 && onJump(idx)}
                  className="w-full flex items-start gap-3 text-sm text-left rounded-2xl border border-slate-100 px-4 py-3 hover:border-slate-200 hover:bg-slate-50 transition-all">
                  <span className="flex-1 text-slate-400 font-medium">
                    <ECHO_Src>{item.text}</ECHO_Src>
                    <span className="block text-[10px] font-black uppercase tracking-widest text-slate-300 mt-0.5">
                      {item.kind === 'goal' ? 'saját cél' : 'oktatói elvárás'}
                    </span>
                  </span>
                  <span className="flex-1 text-slate-800 font-bold text-right"><ECHO_Src>{optLabel(q, v)}</ECHO_Src></span>
                </button>
              );
            })}
          </div>
          {/* ŐSZINTESÉG A KITÖLTŐVEL: a célonkénti válaszokat látja, de a
              beküldés EGYETLEN összevont értéket visz át. Ezt nem rejtjük el —
              a cél szövege és darabszáma azonosítana, ezért marad ki. */}
          <div className="mt-3 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3">
            <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
              A beküldésbe a céljaid szövege és darabszáma <b>nem</b> kerül bele — azok
              azonosítanának. Egyetlen összevont érték megy át:{' '}
              {goalMerged.map(({ q, v }) => (
                <b key={q.id} className="text-slate-800">{MERGED_LABEL[v] || '—'}</b>
              ))}.
            </p>
          </div>
        </div>
      )}

      <div>
        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Az oktatók értékelése</h4>
        <div className="space-y-2">
          {teachers.map((t, i) => {
            const bag = tans[t.id] || {};
            const sv = skipQ ? bag[skipQ.id] : undefined;
            const skipped = !!(sv !== undefined && sv !== null && sv !== '');
            const idx = steps.findIndex(s => s.kind === 'teacher' && s.teacher.id === t.id);
            return (
              <button key={t.id} onClick={() => idx >= 0 && onJump(idx)}
                className="w-full flex items-center gap-3 rounded-2xl border border-slate-100 px-4 py-3 hover:border-slate-200 hover:bg-slate-50 transition-all text-left">
                <div className="w-9 h-9 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center flex-none">
                  <Lucide.User size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black text-slate-800 truncate"><ECHO_Src>{t.name}</ECHO_Src></p>
                  <p className="text-[11px] text-slate-400 font-bold truncate">
                    {skipped ? <ECHO_Src>{'kihagyva — ' + String(sv)}</ECHO_Src> : 'értékelve'}
                  </p>
                </div>
                {skipped ? <UBadge tone="amber">kihagyva</UBadge> : <UBadge tone="green">kész</UBadge>}
              </button>
            );
          })}
          {teachers.length === 0 && (
            <p className="text-sm text-slate-400 font-bold">Ebben a kurzusban nincs véleményezhető oktató.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   7. ECHO_StudentView — a hallgatói belépőpont
   ------------------------------------------------------------ */

function ECHO_StudentView({ user }) {
  // A másolat a bejelentkezett hallgatóé; a régi, közös (felhasználó nélküli)
  // kulcsot eltakarítjuk — nem rendelhető senkihez, és épp ez zárta ki a többieket.
  useEffect(() => {
    ECHO_masolatUidBeallit(user && user.id);
    try { localStorage.removeItem(ECHO_MASOLAT_KULCS); } catch (e) {}
  }, [user && user.id]);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState(null);     // { kind:'goals'|'fill', course }
  const [localDone, setLocalDone] = useState({});  // campaign|course -> true
  const [masolatNyit, setMasolatNyit] = useState(null);  // melyik kurzus masolatat nezzuk

  const load = async (background) => {
    if (background) setRefreshing(true);
    setErr('');
    try {
      const d = await ECHO_api.myCourses();
      setRows(Array.isArray(d) ? d : []);
    } catch (e) {
      setRows([]);
      setErr(ECHO_msg(e));
    } finally { setRefreshing(false); }
  };
  useEffect(() => { load(false); }, []);

  /* ÁTADÁS A HÍRFOLYAMBÓL. A hírfolyam kártyáján a „Kitöltés" gomb ide navigál,
     és sessionStorage-ban hagyja, MELYIK kurzust akarta a hallgató. Ha itt
     megtaláljuk a betöltött sorok között, egyből a kitöltőt nyitjuk — így a
     gomb tényleg elindítja a kitöltést, nem csak a listáig visz.
     A kulcsot AZONNAL töröljük: egy oldalfrissítés ne nyissa meg újra. */
  useEffect(() => {
    if (!rows || !rows.length || mode) return;
    let cel = null;
    try {
      const nyers = sessionStorage.getItem(ECHO_ATADAS_KULCS);
      if (nyers) { cel = JSON.parse(nyers); sessionStorage.removeItem(ECHO_ATADAS_KULCS); }
    } catch (e) { cel = null; }
    if (!cel) return;
    const c = rows.find(x => x.campaign_id === cel.campaign_id && x.course_id === cel.course_id);
    // Csak akkor nyitjuk, ha TÉNYLEG kitölthető — a kártya és a kattintás közt
    // lejárhatott a kampány, és akkor a listát kell mutatni, nem egy hibát.
    if (cel.mod === 'goals') {
      // A hírfolyam célmeghatározási teendője: a célmegadó nézetet nyitjuk.
      if (c && c.is_goals_open) setMode({ kind: 'goals', course: c });
      return;
    }
    if (c && c.is_open &&
        (c.allapot === 'kitoltheto' || c.allapot === 'folyamatban' || c.allapot === 'felbehagyott')) {
      setMode({ kind: 'fill', course: c });
    }
  }, [rows]);

  const key = (c) => c.campaign_id + '|' + c.course_id;

  /* A saját másolatokat renderelésenként EGYSZER olvassuk ki: az
     ECHO_masolatMind() a teljes JSON-t értelmezi, és 20+ kurzuskártyánál
     kártyánként újra megtenné. */
  const masolatok = ECHO_masolatMind();

  if (mode && mode.kind === 'goals') {
    return <ECHO_GoalsView course={mode.course} onBack={() => { setMode(null); load(true); }} onSaved={() => load(true)} />;
  }
  if (mode && mode.kind === 'fill') {
    return (
      <ECHO_Wizard course={mode.course}
        onBack={() => { setMode(null); load(true); }}
        onSubmitted={(c) => setLocalDone(p => ({ ...p, [key(c)]: true }))} />
    );
  }

  if (rows === null) {
    return (
      <div className="p-4 sm:p-8 max-w-5xl mx-auto">
        <SkeletonBar w="220px" h={22} className="mb-2" />
        <SkeletonBar w="340px" h={13} className="mb-7" />
        <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
          <table className="w-full"><tbody><SkeletonRows rows={4} cols={['45%', '20%', '25%', '60px']} /></tbody></table>
        </div>
      </div>
    );
  }

  // A 'felbehagyott' ide tartozik: van mentett piszkozat, es a kitoltes
  // folytathato — ez a legsurgetobb teendo a listaban.
  // Ugyanaz a három jelzés, mint a hírfolyam kártyáján (lásd ott a
  // magyarázatot) — a két felület ne mondjon mást ugyanarról a kérdőívről.
  const open   = rows.filter(c => !localDone[key(c)] && !c.submitted &&
    !masolatok[key(c)] &&
    (c.allapot === 'kitoltheto' || c.allapot === 'folyamatban' || c.allapot === 'felbehagyott'));
  const goals  = rows.filter(c => c.allapot === 'celkituzes');
  const rest   = rows.filter(c => open.indexOf(c) < 0 && goals.indexOf(c) < 0);

  /* A TEENDŐ MINDIG FELÜL. A csoport eddig a szerver sorrendjében jött, ami a
     hallgatónak semmit nem jelent: elsőre nem az látszott, amivel dolga van.
     Három szint, ebben a sorrendben:
       1. amit ELKEZDETT, de nem fejezett be — ez a legsürgetőbb, mert a
          piszkozat lejár (echo.draft.expires_at), és a munkája veszne el;
       2. amihez HOZZÁ SEM KEZDETT;
       3. azon belül a KÖZELEBBI HATÁRIDŐ előbb — akinek holnap zár, azt
          nem szabad a lista aljára tenni.
     A rendezés másolaton dolgozik: a .sort() helyben rendez, és a `rows`
     tömböt a `rest` számítása még használja. */
  // MÉRVE az echo_my_courses() visszatérő soraiból: has_draft, closes_at,
  // course_name. A has_draft pontosabb jelzés, mint az allapot szövege — az
  // 'elkezdte' a szerveren mást jelent (ticket), a piszkozat viszont épp azt,
  // hogy a hallgató válaszai félbemaradtak.
  const surgosseg = (c) => (c.has_draft || c.allapot === 'folyamatban'
                            || c.allapot === 'felbehagyott') ? 0 : 1;
  const hatarido  = (c) => {
    const t = Date.parse(c.closes_at || '');
    return isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  const openSorted = open.slice().sort((a, b) =>
    (surgosseg(a) - surgosseg(b)) ||
    (hatarido(a)  - hatarido(b))  ||
    String(a.course_name || '').localeCompare(String(b.course_name || ''), 'hu'));

  const Card = ({ c }) => {
    /* MI SZAMIT BIZONYITEKNAK A BEKULDESRE
       A szerver `submitted` jelzoje CSAK a kampany lezarasakor kerul fel: az
       echo.mark_submitted() kotegelt, es kurzusonkent csak akkor jelol, ha
       minden kiadott jegy elkoltodott (15_echo_core.sql 6.4). Ez szandekos —
       egyenkenti jeloles elarulna, ki mikor kuldott be. Amig tehat a kampany
       nyitva van, a napló szerint SENKI nincs bekuldve.
       Ezert a sajat masolat a dontő jel: az KIZAROLAG sikeres bekuldes utan
       irodik (lasd ECHO_masolatMent hivasat a varazsloban). Ha megvan, a
       hallgato ezen a bongeszon beküldte — akkor is, ha kozben ujratoltotte az
       oldalt vagy visszajott egy masik napon. */
    const doneNow = !!localDone[key(c)] || !!masolatok[key(c)];
    const allapot = doneNow ? 'kitoltve' : c.allapot;
    const canFill = !doneNow && c.is_open &&
      (c.allapot === 'kitoltheto' || c.allapot === 'folyamatban' || c.allapot === 'felbehagyott');
    const canGoals = c.is_goals_open;
    const masolat = masolatok[key(c)];
    return (
      <div className="bg-white rounded-3xl border border-slate-100 p-5 hover:border-slate-200 transition-all">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <p className="text-[11px] font-black text-slate-400 tracking-wider flex flex-wrap items-center gap-x-2 gap-y-1"><ECHO_Src>{c.course_code}</ECHO_Src><ECHO_KampanyId sorszam={c.campaign_ref_no} kod={c.campaign_code} kicsi /></p>
            <h3 className="font-black text-slate-900 leading-snug mt-0.5"><ECHO_Src>{c.course_name}</ECHO_Src></h3>
          </div>
          <ECHO_StateBadge allapot={allapot} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold text-slate-400 mb-4">
          <span className="inline-flex items-center gap-1"><Lucide.CalendarDays size={12} /> <ECHO_Src>{c.term}</ECHO_Src></span>
          <span className="inline-flex items-center gap-1"><Lucide.Users size={12} /> {c.teacher_count} oktató</span>
          {c.closes_at && <span className="inline-flex items-center gap-1"><Lucide.Clock size={12} /> {ECHO_date(c.closes_at)}-ig</span>}
          {c.goals_saved && <span className="inline-flex items-center gap-1 text-primary"><Lucide.Target size={12} /> célok megadva</span>}
          {/* A piszkozat LETE es a lepesszam latszik, a TARTALMA soha. */}
          {c.has_draft && (
            <span className="inline-flex items-center gap-1 text-blue-500">
              <Lucide.PauseCircle size={12} />
              {(Number(c.draft_step) || 0) + 1}. lépésnél abbahagyva
            </span>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {canFill && (
            <button onClick={() => setMode({ kind: 'fill', course: c })} className={U_btnPrimary + ' flex-1 py-3.5'}>
              <Lucide.ClipboardList size={16} />
              {/* A 22_echo_draft.sql ota a 'felbehagyott' VALODI, folytathato
                  allapot: a kitolto visszatolti a mentett piszkozatot, es azon a
                  lepesen nyit, ahol a hallgato abbahagyta. A 'folyamatban' tovabbra
                  is hibaallapot (elindult, de be nem fejezodott bekuldes). */}
              {c.allapot === 'felbehagyott' ? 'Kitöltés folytatása'
                : c.allapot === 'folyamatban' ? 'Értékelés újrakezdése'
                : 'Értékelés kitöltése'}
            </button>
          )}
          {canGoals && (
            <button onClick={() => setMode({ kind: 'goals', course: c })}
              className={(canFill ? U_btnGhost : U_btnPrimary) + ' flex-1 py-3.5'}>
              <Lucide.Target size={16} /> {c.goals_saved ? 'Célok szerkesztése' : 'Célok megadása'}
            </button>
          )}
          {/* SAJÁT MÁSOLAT. Csak akkor jelenik meg, ha a hallgató ezen a
              böngészőn küldte be — a szerver nem tudja, ki mit válaszolt. */}
          {masolat && (
            <button onClick={() => setMasolatNyit(c)}
              className={(canFill || canGoals ? U_btnGhost : U_btnPrimary) + ' flex-1 py-3.5'}>
              <Lucide.FileText size={16} /> A válaszaim
            </button>
          )}

          {!canFill && !canGoals && !masolat && (
            <div className="flex-1 text-xs font-bold text-slate-400 py-3">
              {(ECHO_STATE[allapot] || ECHO_STATE.nem_nyitott).hint}
              {/* „A kampány még nem indult." önmagában nem mond semmit arról,
                  MIKOR indul — a hallgató nem tudja, mikor nézzen vissza. */}
              {allapot === 'nem_nyitott' && c.opens_at && (
                <span className="block mt-1 text-amber-600">
                  Megnyílik: {ECHO_dateTime(c.opens_at)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const Group = ({ title, subtitle, items, icon }) => {
    if (!items.length) return null;
    const Icon = Lucide[icon] || Lucide.Circle;
    return (
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Icon size={15} className="text-slate-400" />
          <h2 className="text-sm font-black text-slate-700 tracking-tight">{title}</h2>
          <span className="text-[11px] font-black text-slate-300">{items.length}</span>
        </div>
        {subtitle && <p className="text-xs text-slate-400 font-medium -mt-2 mb-3">{subtitle}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map(c => <Card key={key(c)} c={c} />)}
        </div>
      </section>
    );
  };

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-7">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">Kurzusértékelés</h1>
          <p className="text-sm text-slate-400 font-medium mt-1">
            Oktatói munka hallgatói véleményezése · 28/2023. szenátusi határozat
          </p>
        </div>
        <div className="flex items-center gap-3 flex-none pt-2">
          <RefreshingBadge on={refreshing} />
          <button onClick={() => load(true)} className="w-10 h-10 rounded-xl hover:bg-slate-100 text-slate-400 flex items-center justify-center transition-colors" title="Frissítés">
            <Lucide.RefreshCw size={16} />
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-6 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {rows.length === 0 && !err && (
        <UEmpty icon={<Lucide.ClipboardList size={28} />} title="Most nincs értékelhető kurzusod"
          subtitle="Amikor egy kampány megnyílik, a véleményezhető kurzusaid itt jelennek meg." />
      )}

      <Group title="Kitölthető most" icon="ClipboardList" items={openSorted}
        subtitle="A félév végi értékelés. Névtelen — a válaszaid nem köthetők vissza hozzád." />
      <Group title="Félév eleji célmeghatározás" icon="Target" items={goals}
        subtitle="1–3 saját cél és 1–3 oktatói elvárás. Csak Te látod." />
      <Group title="Lezárt és kész kurzusok" icon="Archive" items={rest} />

      <ECHO_SajatValaszok course={masolatNyit} onClose={() => setMasolatNyit(null)} />
    </div>
  );
}

/* ------------------------------------------------------------
   „A válaszaim" — a hallgató saját, BÖNGÉSZŐBEN tárolt másolata.
   ------------------------------------------------------------ */
function ECHO_SajatValaszok({ course, onClose }) {
  if (!course) return null;
  const m = ECHO_masolatGet(course.campaign_id, course.course_id);
  if (!m) return null;

  const datum = (() => {
    try { return new Date(m.mentve).toLocaleString('hu-HU',
      { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(m.mentve || '').slice(0, 16); }
  })();

  // Szakaszonként csoportosítva, ahogy kitöltéskor is látta.
  const szakaszok = [];
  (m.tetelek || []).forEach(t => {
    let sz = szakaszok.find(x => x.nev === t.szakasz);
    if (!sz) { sz = { nev: t.szakasz, sorok: [] }; szakaszok.push(sz); }
    sz.sorok.push(t);
  });

  return (
    <UModal open={!!course} onClose={onClose} max="max-w-2xl"
      icon={<Lucide.FileText size={20} />} title="A válaszaim"
      subtitle={course.course_name}>
      <div className="space-y-4">
        {/* Mondatonként külön elem: a nyelvváltó a TELJES szövegcsomópontot
            keresi a szótárban, egy mondat közepébe tett <strong> pedig
            darabokra vágná, és a darabok fordítatlanul maradnának. */}
        <div className="text-[12px] text-slate-600 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3">
          <span className="block font-bold text-slate-800 mb-1">
            Ez a másolat csak ezen a böngészőn van meg.
          </span>
          <span className="block">
            A beküldött értékelés névtelen: a rendszer nem tárolja, ki mit válaszolt, ezért a válaszaidat nem tudja visszaadni.
          </span>
          <span className="block mt-1">
            Ezt a másolatot a beküldéskor a saját gépeden mentettük el. Másik gépen, másik böngészőben, vagy a böngészőadatok törlése után nem lesz meg.
          </span>
          <span className="block mt-1.5 text-slate-400">Mentve: {datum}</span>
        </div>

        {szakaszok.length === 0 ? (
          <p className="text-sm text-slate-400">A másolat üres.</p>
        ) : (
          <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
            {szakaszok.map((sz, i) => (
              <div key={i}>
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
                  <ECHO_Src>{sz.nev}</ECHO_Src>
                </h4>
                <div className="space-y-2">
                  {sz.sorok.map((t, j) => (
                    <div key={j} className="bg-white border border-slate-100 rounded-2xl px-4 py-3">
                      <p className="text-[13px] text-slate-500">
                        <ECHO_Src>{t.kerdes}</ECHO_Src>
                        {t.kire && <span className="font-bold text-primary"> · <ECHO_Src>{t.kire}</ECHO_Src></span>}
                      </p>
                      <p className="text-sm font-bold text-slate-800 mt-1"><ECHO_Src>{t.valasz}</ECHO_Src></p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end pt-1">
          <button className={U_btnPrimary} onClick={onClose}>Bezárás</button>
        </div>
      </div>
    </UModal>
  );
}

/* ------------------------------------------------------------
   8. ECHO_CampaignsPanel — MIR / admin, kampányfül
   ------------------------------------------------------------
   FONTOS: ez a PANEL SEMMILYEN válasz-TARTALMAT nem mutat, mert az
   echo_campaigns() és az echo_rate() szándékosan csak darabszámot ad
   vissza. Az eredmény a 2. szelet RPC-in (echo_course_results /
   echo_teacher_results) át jön, külön nézetben (ECHO_TeacherView), a
   k-anonimitási küszöbökkel — lásd 16_echo_reports.sql 4–5. szakasz.
   Az ECHO_AdminView (13. szakasz) ezt a panelt fűzi fülre a szerkesztővel
   és a moderálással.
   ------------------------------------------------------------ */

/* A kizárási szabályok katalógusa — az echo.exclusion_rule seed sorai.
   Felületi HIVATKOZÁSI szöveg, nem adatforrás: a tényleges naplósorokat az
   adatbázis tartja. A §-hivatkozások az SQL-ben is BECSLÉSSEL szerepelnek
   (a 28/2023. határozat szövege nem állt rendelkezésre) — ezért látszik itt
   is a "pontosítandó" jelölés. */
const ECHO_EXCLUSION_RULES = [
  { code: 'LETSZAM_ALATT',       name: 'Létszám a küszöb alatt',            scope: 'kurzus', why: 'A kis csoportban a válasz tartalma önmagában azonosítaná a kitöltőt.' },
  { code: 'NINCS_ORARENDI_INFO', name: 'Nincs órarendi információ',         scope: 'kurzus', why: 'Nincs kontaktóra, így nincs mit véleményezni.' },
  { code: 'VIZSGAKURZUS',        name: 'Vizsgakurzus',                      scope: 'kurzus', why: 'Nincs oktatási tevékenység, csak számonkérés.' },
  { code: 'NINCS_OKTATO',        name: 'Nincs rögzített oktató',            scope: 'kurzus', why: 'Oktatói értékelés nem képezhető.' },
  { code: 'OKTATOI_ARANY_ALATT', name: 'Oktatói óraarány a küszöb alatt',   scope: 'oktatói pár', why: 'A hallgatónak nincs elegendő tapasztalata az oktató munkájáról.' },
];

function ECHO_Meter({ value, max, tone = 'primary' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar = { primary: 'bg-primary', green: 'bg-emerald-500', amber: 'bg-amber-500' }[tone] || 'bg-primary';
  return (
    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
      <div className={'h-full rounded-full transition-all ' + bar} style={{ width: pct + '%' }} />
    </div>
  );
}

/* ------------------------------------------------------------
   8.a A kampány-életciklus felülete (18_echo_campaign.sql)
   ------------------------------------------------------------
   MIÉRT VAN EZ ITT: a 16_echo_reports.sql 2551 sornyi riport- és
   moderálómotorja addig ELÉRHETETLEN volt a felületről, amíg a kampányt
   semmi nem tudta 'open'-ből továbbvinni — az echo.results_gate() ugyanis
   'closed' vagy későbbi állapotot követel. A 18_echo_campaign.sql adta meg
   a hiányzó két RPC-t; ez a néhány komponens az a kapcsoló, amivel az admin
   ténylegesen használni tudja őket.

   AMIT A FELÜLET KIMOND, MIELŐTT KATTINTASZ:
   a pecsételés (processing → sealed) VISSZAFORDÍTHATATLAN. Lefut az
   echo.shuffle_responses(), és onnantól sem az RPC, sem közvetlen UPDATE nem
   viszi vissza a kampányt — az adatbázisban trigger őrzi (mérve). */

const ECHO_CAMPAIGN_STEP = {
  draft:      { igé: 'Vissza előkészítésbe', mit: 'A kampány újra szerkeszthető, kitöltést nem fogad.' },
  open:       { igé: 'Megnyitás',            mit: 'Ettől kezdve a jogosult hallgatók jegyet kérhetnek és kitölthetnek.' },
  closed:     { igé: 'Lezárás',              mit: 'A kitöltés véget ér. Az ADMIN innentől lát eredményt, az oktató még nem.' },
  processing: { igé: 'Feldolgozás indítása', mit: 'Lezárul a részvételi napló, és feltöltődik a moderálási sor.' },
  sealed:     { igé: 'Pecsételés',           mit: 'Az adat véglegessé válik. Lefut az echo.shuffle_responses().' },
  published:  { igé: 'Közzététel',           mit: 'Az eredmény megnyílik az oktatóknak is (echo.results_gate).' },
};

// A <input type="datetime-local"> a helyi idővel dolgozik, a Postgres viszont
// timestamptz-t vár. A két irányú váltás egy helyen, hogy ne csússzon el.
function ECHO_toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function ECHO_fromLocalInput(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/* --- Felevek a legordulohoz ---------------------------------------------
   A felev formatuma '2025/26/2': a tanev elso eve / a masodik eve ket jegyen /
   1 = oszi, 2 = tavaszi. A lista a MAI datum kore general harom tanevet, es
   hozzaveszi azokat a feleveket, amikre mar van kampany — igy egy regebbi vagy
   kezzel felvitt felev sem tunik el a legordulobol.

   A felev NEM foglalhato: egy felevre barmennyi kampany futhat (a tiltast a
   41_campaign_term_free.sql szuntette meg). A mar futo kampanyok szamat azert
   irjuk ki a sor vegen, mert tajekoztat — de nem tilt es nem tesz semmit
   valaszthatatlanna. */
const ECHO_TERM_ACTIVE = ['draft', 'open', 'closed', 'processing'];

function ECHO_termCurrent(now) {
  const d = now || new Date();
  // A tanev szeptemberben kezdodik, de a kampanyt mar augusztusban keszitik:
  // augusztustol a KOVETKEZO tanev szamit mostaninak.
  const y = d.getFullYear() - (d.getMonth() >= 7 ? 0 : 1);
  const sem = (d.getMonth() >= 7 || d.getMonth() === 0) ? '1' : '2';
  return y + '/' + String((y + 1) % 100).padStart(2, '0') + '/' + sem;
}

function ECHO_termLabel(term) {
  const m = /^(\d{4})\/(\d{2})\/([12])$/.exec(term || '');
  if (!m) return term;                     // kezzel felvitt, ismeretlen alaku felev
  return term + ' \u00b7 ' + (m[3] === '1' ? 'őszi' : 'tavaszi') + ' félév';
}

function ECHO_termOptions(rows, now) {
  const d = now || new Date();
  const base = d.getFullYear() - (d.getMonth() >= 7 ? 0 : 1);
  const list = [];
  for (let y = base - 1; y <= base + 1; y++) {
    const nx = String((y + 1) % 100).padStart(2, '0');
    list.push(y + '/' + nx + '/1', y + '/' + nx + '/2');
  }
  const db = new Map();
  (Array.isArray(rows) ? rows : []).forEach(c => {
    if (!c || !c.term) return;
    if (list.indexOf(c.term) < 0) list.push(c.term);
    if (ECHO_TERM_ACTIVE.indexOf(c.state) >= 0) db.set(c.term, (db.get(c.term) || 0) + 1);
  });
  // A negyjegyu evszam miatt a sztringrendezes idorendet ad.
  return list.sort().map(term => ({ term, futo: db.get(term) || 0 }));
}

/* --- Hallgatói névsor modal ----------------------------------------------
   Ket helyen nyilik: a szerkesztoben a MEG NEM MENTETT celkozonseghez, es a
   kampany "Jogosult hallgato" kartyaja mogul a TENYLEGES jogosultakhoz. A
   ket forras kulonbozo, ezert a hivo adja at a betoltot — a modal maga nem
   tudja, honnan jon az adat, es nem is kell tudnia.

   AMIT SZANDEKOSAN NEM MUTAT: ki kuldte be a kerdoivet. Az echo.participation
   tarolja ezt (kell a ketszeres kitoltes ellen), de bongeszheto listaja mas
   iranybol nyitna meg ugyanazt, amit a k-anonimitasi kuszobok vednek. */
function ECHO_StudentListModal({ open, cim, alcim, betolt, betoltKurzus, onClose }) {
  const [d, setD]     = useState(null);
  const [q, setQ]     = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Melyik sor van kibontva, es mit toltottunk be hozza. KATTINTASRA keruk le,
  // nem a listaval egyutt: merve a kurzuscimkek a valasz meretet a
  // haromszorosara vinnek (a jogosultak kurzusszama 1-tol 20-ig terjed), olyan
  // adatert, amit a legtobb sornal soha senki nem nyit ki.
  const [nyit, setNyit] = useState(null);
  const [kurzusok, setKurzusok] = useState({});

  useEffect(() => {
    if (!open) { setD(null); setQ(''); setErr(''); setNyit(null); setKurzusok({}); return; }
    let el = true;
    setBusy(true);
    const t = setTimeout(() => {
      betolt(q)
        .then(r => { if (el) { setD(r); setErr(''); setBusy(false); } })
        .catch(e => { if (el) { setD(null); setErr(ECHO_msg(e)); setBusy(false); } });
    }, q ? 300 : 0);
    return () => { el = false; clearTimeout(t); };
  }, [open, q]);

  const sorok = (d && Array.isArray(d.sorok)) ? d.sorok : [];

  const bont = (pid) => {
    if (nyit === pid) { setNyit(null); return; }
    setNyit(pid);
    if (kurzusok[pid] || !betoltKurzus) return;
    setKurzusok(p => ({ ...p, [pid]: 'tolt' }));
    betoltKurzus(pid)
      .then(r => setKurzusok(p => ({ ...p, [pid]: (r && r.kurzusok) || [] })))
      .catch(e => setKurzusok(p => ({ ...p, [pid]: { hiba: ECHO_msg(e) } })));
  };

  return (
    <UModal open={open} onClose={onClose} max="max-w-3xl"
      icon={<Lucide.Users size={20} />} title={cim} subtitle={alcim}>
      {err && (
        <div className="mb-4 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      <div className="flex items-center gap-3 mb-3">
        <input className={U_input + ' text-sm'} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Szűrés névre vagy e-mailre…" />
        <RefreshingBadge on={busy} />
      </div>

      {d && (
        <p className="text-[11px] font-black text-slate-400 mb-2">
          {/* Szures kozben az 'ossz' tovabbra is a TELJES letszam — a mutatott
              sorokat a szuro szukitette, nem a lista hatara. A ketto mast
              jelent, ezert nem szabad ugyanugy fogalmazni. */}
          {q
            ? <span>{d.mutatva} találat · {d.ossz} hallgatóból</span>
            : <span>{d.ossz} hallgató</span>}
          {!q && d.mutatva < d.ossz && (
            <span className="text-amber-600"> · ebből {d.mutatva} látszik (a lista {d.hatar} sornál megáll)</span>
          )}
          {q && d.mutatva >= d.hatar && (
            <span className="text-amber-600"> · a lista {d.hatar} sornál megáll, szűkíts tovább</span>
          )}
        </p>
      )}

      {/* KITÖLTÖTTSÉG — névtelen összesítő (67_echo_campaign_students_status.sql).
          Névenként SZÁNDÉKOSAN nem jelöljük: a beküldés névtelen jeggyel megy, a
          „kész” egyenként nem is ismerhető, és ki mikor töltött ki, azt nem adjuk ki.
          A migráció előtt a 'statusz' kulcs hiányzik — ilyenkor nincs összesítő. */}
      {d && d.statusz && (() => {
        const st = d.statusz;
        const nyitott = st.kampany_allapot === 'draft' || st.kampany_allapot === 'open';
        const keszIsmert = !nyitott && (Number(st.kesz) > 0 || st.kampany_allapot !== 'closed');
        const doboz = (szin, ikon, cim, ertek, megj, kulcs) => (
          <div className={'rounded-2xl border px-3 py-2.5 ' + szin} data-echo-statusz={kulcs}>
            <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider">{ikon}{cim}</div>
            <div className="text-xl font-black tabular-nums mt-0.5">{ertek}</div>
            {megj && <div className="text-[10px] font-bold opacity-80 leading-snug">{megj}</div>}
          </div>
        );
        return (
          <div className="mb-3" data-echo-statusz-sav="1">
            <div className="grid grid-cols-3 gap-2">
              {doboz('bg-slate-50 border-slate-200 text-slate-600', <Lucide.Circle size={12} />, 'Még nem kezdte el', st.nem_kezdte, null, 'nem_kezdte')}
              {doboz('bg-amber-50 border-amber-200 text-amber-700', <Lucide.Clock size={12} />, 'Elkezdte', st.elkezdte, 'jegyet kért vagy van piszkozata', 'elkezdte')}
              {doboz('bg-emerald-50 border-emerald-200 text-emerald-700', <Lucide.CheckCircle2 size={12} />, 'Kész',
                keszIsmert ? st.kesz : '—', keszIsmert ? null : (nyitott ? 'a kampány lezárásakor derül ki' : 'a feldolgozáskor derül ki'), 'kesz')}
            </div>
            <p className="text-[10px] text-slate-400 font-bold mt-1.5 leading-relaxed">
              {'Kurzusértékelésenként számolva (' + st.egyseg + ' hallgató × kurzus). Névenként szándékosan nem jelöljük: a kérdőív névtelen, és a beküldés nem köthető hallgatóhoz.'}
            </p>
          </div>
        );
      })()}

      {d === null ? <SkeletonRows n={6} /> : sorok.length === 0 ? (
        <UEmpty icon={<Lucide.UserX size={22} />} title="Nincs találat"
          text={q ? 'Ezzel a szűréssel senki.' : 'Ez a beállítás egyetlen hallgatót sem ér el.'} />
      ) : (
        <div className="max-h-[26rem] overflow-y-auto divide-y divide-slate-50 border border-slate-100 rounded-2xl">
          {sorok.map(h => {
            const ki  = nyit === h.profile_id;
            const adat = kurzusok[h.profile_id];
            return (
              <div key={h.profile_id} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-700 truncate">{h.nev}</div>
                    <div className="text-[10px] font-bold text-slate-400 truncate">
                      {h.email}
                      {h.tagozat ? ' · ' + h.tagozat : ''}
                      {h.kepzesi_szint ? ' · ' + h.kepzesi_szint : ''}
                      {h.szak ? ' · ' + h.szak : ''}
                    </div>
                    {h.kar && (
                      <div className="text-[10px] font-bold text-slate-300 truncate">{h.kar}</div>
                    )}
                  </div>
                  {h.kurzus != null && (betoltKurzus ? (
                    <button type="button" onClick={() => bont(h.profile_id)}
                      className={'text-[10px] font-black flex-none inline-flex items-center gap-1 ' +
                        'px-2 py-1 rounded-lg transition ' +
                        (ki ? 'bg-primary text-white' : 'text-primary hover:bg-orange-50')}>
                      {h.kurzus} kurzus
                      <Lucide.ChevronDown size={11}
                        className={'transition-transform ' + (ki ? 'rotate-180' : '')} />
                    </button>
                  ) : (
                    <span className="text-[10px] font-black text-slate-400 flex-none">
                      {h.kurzus} kurzus
                    </span>
                  ))}
                </div>

                {ki && (
                  <div className="mt-2 ml-1 pl-3 border-l-2 border-orange-100 space-y-1.5">
                    {adat === 'tolt' || adat === undefined ? (
                      <SkeletonBar h={14} />
                    ) : adat && adat.hiba ? (
                      <p className="text-[11px] font-bold text-red-500">{adat.hiba}</p>
                    ) : (adat || []).length === 0 ? (
                      <p className="text-[11px] font-bold text-slate-300 italic">nincs kurzus</p>
                    ) : adat.map(k => (
                      <div key={k.course_id}>
                        <div className="text-[11px] font-bold text-slate-600">
                          <ECHO_Src>{k.code} · {k.name}</ECHO_Src>
                        </div>
                        <div className="text-[10px] font-bold text-slate-400">
                          {k.term}{k.oktatok ? ' · ' + k.oktatok : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-400 leading-relaxed mt-3">
        A lista azt mutatja, <b>kit érint</b> a kampány. Azt, hogy ki küldte be a kérdőívet,
        szándékosan nem mutatjuk: a kérdőív névtelen, és egy ilyen névsor a közzétett
        eredménnyel együtt visszafejthetővé tenné a válaszokat.
      </p>
    </UModal>
  );
}


/* --- Új kampány űrlapja ---------------------------------------------------
   A sablonverzió-választó KIZÁRÓLAG 'live' és 'approved' verziót kínál, mert
   az echo_campaign_create() is csak ezeket fogadja el. A megnyitáshoz viszont
   már 'live' kell (ECHO_TEMPLATE_NOT_LIVE) — ezt a lista ki is írja, hogy ne
   utólag derüljön ki. */
function ECHO_CampaignCreate({ open, onClose, onDone, campaigns }) {
  const [tpls, setTpls]   = useState(null);
  const [nev, setNev]     = useState('');
  const [term, setTerm]   = useState('');
  const [ver, setVer]     = useState('');
  const [opensAt, setOpensAt]   = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  // A legordulo a mar letezo kampanyokbol tudja meg, melyik felev foglalt —
  // kulon lekeres nelkul, mert a lista ugyis be van toltve a panelen.
  const termNow  = React.useMemo(() => ECHO_termCurrent(), []);
  const termOpts = React.useMemo(() => ECHO_termOptions(campaigns), [campaigns]);

  useEffect(() => {
    if (!open) return;
    setErr(''); setBusy(false);
    // A mostani felevet felajanljuk — a felev nem foglalhato, tehat ez
    // mindig ervenyes valasztas marad.
    setTerm(prev => prev || termNow);
    ECHO_api.templates()
      .then(d => {
        const arr = [];
        (Array.isArray(d) ? d : []).forEach(t => {
          (Array.isArray(t.verziok) ? t.verziok : []).forEach(v => {
            if (v.state === 'live' || v.state === 'approved') {
              arr.push({ id: v.id, label: `${t.name_hu} · v${v.version}`, state: v.state, kerdesek: v.kerdesek });
            }
          });
        });
        arr.sort((a, b) => (a.state === 'live' ? -1 : 1) - (b.state === 'live' ? -1 : 1));
        setTpls(arr);
        // Szandekosan NEM valasztunk automatikusan: a kerdoiv utolag is
        // megadhato, es a csendben elovalasztott sablon rosszabb, mint a
        // kimondottan ures allapot.
      })
      .catch(e => { setTpls([]); setErr(ECHO_msg(e)); });
  }, [open]);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await ECHO_api.campaignCreate(
        nev.trim(), term.trim(), ver || null,
        opensAt  ? ECHO_fromLocalInput(opensAt)  : null,
        closesAt ? ECHO_fromLocalInput(closesAt) : null);
      onDone(r);
      setNev(''); setTerm(''); setOpensAt(''); setClosesAt(''); setVer('');
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  const sel = (tpls || []).find(t => t.id === ver);
  // Vazkampanyhoz eleg a nev es a felev. Az ablak viszont csak EGYBEN
  // ertelmes: fel ablakot a szerver is elutasit (ECHO_HALF_WINDOW), de jobb
  // itt megfogni. A kerdoiv teljesen szabadon hagyhato.
  const felAblak   = (!!opensAt) !== (!!closesAt);
  const rosszAblak = opensAt && closesAt
                     && ECHO_fromLocalInput(closesAt) <= ECHO_fromLocalInput(opensAt);
  const ok  = nev.trim() && term.trim() && !felAblak && !rosszAblak;

  return (
    <UModal open={open} onClose={onClose} max="max-w-2xl"
      icon={<Lucide.Megaphone size={20} />} title="Új kampány"
      subtitle="A kampány mindig ELŐKÉSZÍTÉS (draft) állapotban jön létre">
      {err && (
        <div className="mb-5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      <div className="space-y-4">
        <UField label="A kampány neve" hint="Ez látszik a hallgatói és az oktatói felületen is.">
          <input className={U_input} value={nev} onChange={e => setNev(e.target.value)}
            placeholder="OMHV 2025/26/2 — tavaszi félév" maxLength={160} />
        </UField>

        <UField label="Félév"
          hint="Az alkalmassági lista EBBŐL dolgozik: az echo.eligibility_rebuild() a félév minden kurzusát összegyűjti. Egy félévre bármennyi kampány futhat egyszerre — a hallgató ilyenkor kampányonként külön kérdőívet kap.">
          <select className={U_input} value={term} onChange={e => setTerm(e.target.value)}>
            <option value="">Válassz félévet…</option>
            {termOpts.map(t => (
              <option key={t.term} value={t.term}>
                {ECHO_termLabel(t.term)}
                {t.term === termNow ? ' \u00b7 mostani' : ''}
                {t.futo ? ' \u00b7 ' + t.futo + ' futó kampány' : ''}
              </option>
            ))}
          </select>
        </UField>

        <UField label="Kérdőív (sablonverzió)"
          hint="Csak jóváhagyott és élesített verzió választható. A MEGNYITÁSHOZ már élesített (live) kell.">
          {tpls === null ? <SkeletonBar h={44} /> : tpls.length === 0 ? (
            <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 text-[12px] font-bold text-amber-700">
              Nincs egyetlen jóváhagyott vagy élesített sablonverzió sem. Előbb a
              „Kérdőívszerkesztő” fülön hagyd jóvá és élesítsd a kérdőívet.
            </div>
          ) : (
            <select className={U_input} value={ver} onChange={e => setVer(e.target.value)}>
              <option value="">Később adom meg — most csak a kampány váza jöjjön létre</option>
              {tpls.map(t => (
                <option key={t.id} value={t.id}>
                  {t.label} · {t.state === 'live' ? 'élesített' : 'jóváhagyott'} · {t.kerdesek} kérdés
                </option>
              ))}
            </select>
          )}
        </UField>

        {sel && sel.state !== 'live' && (
          <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 flex gap-2.5">
            <Lucide.AlertTriangle size={15} className="text-amber-500 flex-none mt-0.5" />
            <p className="text-[11px] text-amber-700 font-medium leading-relaxed">
              Ez a verzió még csak <b>jóváhagyott</b>. A kampány létrejön vele, de
              megnyitni csak azután lehet, hogy a szerkesztőben élesítetted
              (ECHO_TEMPLATE_NOT_LIVE).
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UField label="Nyitás">
            <input type="datetime-local" className={U_input} value={opensAt} onChange={e => setOpensAt(e.target.value)} />
          </UField>
          <UField label="Zárás">
            <input type="datetime-local" className={U_input} value={closesAt} onChange={e => setClosesAt(e.target.value)} />
          </UField>
        </div>
        {opensAt && closesAt && !(ECHO_fromLocalInput(closesAt) > ECHO_fromLocalInput(opensAt)) && (
          <p className="text-[11px] font-black text-red-500">A zárás nem lehet a nyitás előtt (ECHO_WINDOW_INVALID).</p>
        )}

        <div className="bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5">
          <Lucide.Info size={15} className="text-slate-400 flex-none mt-0.5" />
          <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
            A létrehozás után a következő lépés az <b>alkalmasság újraépítése</b>:
            jogosultsági sor nélkül a kampány nem nyitható meg (ECHO_NO_ELIGIBILITY),
            mert akkor senki nem tudná kitölteni, és a kizárási napló is üres maradna.
          </p>
        </div>

        <div className="flex gap-3 pt-1">
          <button className={U_btnGhost} onClick={onClose}>Mégsem</button>
          <button className={U_btnPrimary} disabled={!ok || busy} onClick={save}>
            {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.Plus size={16} />}
            {busy ? 'Létrehozás…' : 'Kampány létrehozása'}
          </button>
        </div>
      </div>
    </UModal>
  );
}

/* --- Állapotváltás: gombsor + megerősítés --------------------------------
   A gombokat az echo_campaign_get() 'kovetkezo' tömbje adja — a szerver
   mondja meg, mi következhet és mi blokkolja. A felület NEM találgat: ha a
   szerver szerint egy lépés blokkolt, a gomb letiltva, és mellette OTT ÁLL,
   miért (a precheck üzenete szó szerint). */
function ECHO_TransitionConfirm({ step, campaign, busy, onCancel, onConfirm }) {
  const [force, setForce] = useState(false);
  useEffect(() => { setForce(false); }, [step && step.to]);
  if (!step) return null;
  const meta  = ECHO_CAMPAIGN_STEP[step.to] || { igé: step.to, mit: '' };
  const seal  = step.to === 'sealed';
  const back  = step.irany === 'vissza';
  const blocked = !step.ok;

  return (
    <UModal open={!!step} onClose={busy ? () => {} : onCancel} max="max-w-lg"
      icon={seal ? <Lucide.Lock size={20} /> : back ? <Lucide.Undo2 size={20} /> : <Lucide.ArrowRight size={20} />}
      title={meta.igé}
      subtitle={campaign.code + ' · ' + ((ECHO_CAMPAIGN_STATE[campaign.state] || {}).label || campaign.state)
                + ' → ' + ((ECHO_CAMPAIGN_STATE[step.to] || {}).label || step.to)}>

      {seal && (
        <div className="mb-5 bg-red-50 border-2 border-red-200 rounded-2xl px-4 py-4">
          <div className="flex items-center gap-2 mb-2">
            <Lucide.ShieldAlert size={18} className="text-red-500 flex-none" />
            <p className="text-sm font-black text-red-700">Ez a lépés VISSZAFORDÍTHATATLAN.</p>
          </div>
          <p className="text-[12px] text-red-700/90 font-medium leading-relaxed">
            A pecsételéssel lefut az <code>echo.shuffle_responses()</code>: a válaszsorok
            fizikai sorrendje véglegesen elbomlik — pont ez az, ami a beküldési
            sorrendet mint rejtett csatornát megszünteti. Utána a kampányt sem
            ez az RPC, sem közvetlen adatbázis-módosítás nem viszi vissza: az
            <code> echo.campaign_seal_guard()</code> trigger elutasítja. A kampány
            innentől már csak közzétehető.
          </p>
        </div>
      )}

      {back && (
        <div className="mb-5 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 flex gap-2.5">
          <Lucide.Undo2 size={15} className="text-amber-500 flex-none mt-0.5" />
          <p className="text-[12px] text-amber-700 font-medium leading-relaxed">
            Ez VISSZALÉPÉS. A pecsét előtt megengedett, de az echo.campaign_log-ba
            bekerül, ki és mikor lépett vissza.
          </p>
        </div>
      )}

      <p className="text-sm text-slate-600 font-medium leading-relaxed mb-4">{meta.mit}</p>

      <div className={'rounded-2xl px-4 py-3 mb-5 ' + (blocked ? 'bg-red-50 border border-red-100' : 'bg-slate-50')}>
        <p className="text-[10px] font-black uppercase tracking-widest mb-1 text-slate-400">
          {blocked ? 'A szerver szerint ez most blokkolt' : 'Előfeltétel'}
        </p>
        <p className={'text-[12px] font-medium leading-relaxed ' + (blocked ? 'text-red-600' : 'text-slate-500')}>
          {step.uzenet}
        </p>
        {blocked && step.kod && (
          <p className="text-[10px] font-black text-red-400 tracking-wider mt-1.5">{step.kod}</p>
        )}
      </div>

      {blocked && step.forcolhato && (
        <label className="flex items-start gap-3 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 mb-5 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={force} onChange={e => setForce(e.target.checked)} />
          <span className="text-[12px] text-amber-700 font-medium leading-relaxed">
            <b>Kényszerítem.</b> A kényszerítés KIZÁRÓLAG ezt az időzítési vagy
            teljességi feltételt oldja fel, és a naplóban külön jelölve marad.
            Az állapotgép átugrását és a pecsét utáni visszalépést semmi nem oldja fel.
          </span>
        </label>
      )}

      {blocked && !step.forcolhato && (
        <p className="text-[12px] font-bold text-slate-500 mb-5">
          Ez a feltétel nem kényszeríthető ki — szerkezeti akadály, nem időzítés.
        </p>
      )}

      <div className="flex gap-3">
        <button className={U_btnGhost} onClick={onCancel} disabled={busy}>Mégsem</button>
        <button
          className={(seal ? U_btn + ' bg-red-500 text-white px-5 py-3 shadow-lg shadow-red-500/10 hover:bg-red-600' : U_btnPrimary)}
          disabled={busy || (blocked && !(step.forcolhato && force))}
          onClick={() => onConfirm(step.to, blocked && force)}>
          {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : seal ? <Lucide.Lock size={16} /> : <Lucide.Check size={16} />}
          {busy ? 'Folyamatban…' : (blocked && force ? meta.igé + ' (kényszerítve)' : meta.igé)}
        </button>
      </div>
    </UModal>
  );
}

/* A célközönség tételei a SZERVER alakjában. Egyetlen helyen, mert négy hívó
   is használja (előnézet, névsor, kurzusbontás, mentés), és ha ezek elcsúsznak,
   a szerkesztőben látott szám másról szól, mint ami mentésre kerül.

   A 'filter' tételnek NINCS id-ja: maga hordozza a szabályt (80). Az üres
   kártya — amit épp most adtak hozzá, de még nem kattintottak bele — kimarad:
   a szerver validálása joggal utasítaná el, de a felhasználó még csak elkezdte. */
const ECHO_audItems = (tetel) => (tetel || []).reduce((acc, x) => {
  if (x.kind === 'filter') {
    const sz = x.szabaly || {};
    if (Object.keys(sz).length) acc.push({ kind: 'filter', szabaly: sz });
  } else {
    acc.push({ kind: x.kind, id: x.ref });
  }
  return acc;
}, []);

/* --- Célközönség-választó ------------------------------------------------
   Egy típus (kurzus / csoport / személy) kiválasztott tételei + kereső. Az
   ajánlatokat a szerver adja (echo_audience_options), mert a kurzuslista és a
   hallgatói névsor is túl nagy ahhoz, hogy a kliensbe töltsük. */
function ECHO_AudiencePicker({ campaignId, kind, cimke, ikon, sug, valasztott, onValt, ro, betolt, nyitSug }) {
  const [q, setQ]         = useState('');
  const [opts, setOpts]   = useState(null);
  const [nyit, setNyit]   = useState(false);
  const [err, setErr]     = useState('');

  useEffect(() => {
    if (!nyit || ro) return;
    let el = true;
    const t = setTimeout(() => {
      // A hírfolyam célközönség-választója saját lekérőt ad (feed_audience_options).
      (betolt ? betolt(kind, q) : ECHO_api.audienceOptions(campaignId, kind, q))
        .then(d => { if (el) { setOpts(Array.isArray(d) ? d : []); setErr(''); } })
        .catch(e => { if (el) { setOpts([]); setErr(ECHO_msg(e)); } });
    }, 250);           // gepeles kozben ne inditsunk minden leutesre lekerest
    return () => { el = false; clearTimeout(t); };
  }, [nyit, q, kind, campaignId, ro]);

  const benne = (id) => valasztott.some(v => v.ref === id);

  return (
    <div className="border border-slate-100 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          {ikon}
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{cimke}</span>
          {valasztott.length > 0 && (
            <span className="text-[10px] font-black text-primary">{valasztott.length}</span>
          )}
        </div>
        {!ro && (
          <div className="flex items-center gap-3">
            {/* Sok kijelolt tetelt egyenkent torolni kinszenvedes — es ha a
                kurzusokat valaki "mindet kijelolom" szandekkal toltotte fel,
                pont ez kell a javitashoz: az URES kurzuslista jelenti a
                felev osszes kurzusat. */}
            {valasztott.length > 1 && (
              <button type="button" onClick={() => onValt([])}
                className="text-[11px] font-black text-slate-400 hover:text-red-500 hover:underline">
                Összes eltávolítása
              </button>
            )}
            <button type="button" onClick={() => setNyit(v => !v)}
              className="text-[11px] font-black text-primary hover:underline">
              {nyit ? 'Kész' : '+ Hozzáadás'}
            </button>
          </div>
        )}
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed mb-3">{sug}</p>

      {valasztott.length === 0 ? (
        <p className="text-[11px] text-slate-300 font-bold italic">nincs kijelölve</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {valasztott.map(v => (
            <span key={v.ref}
              className="inline-flex items-center gap-1.5 bg-slate-50 border border-slate-100
                         rounded-xl pl-2.5 pr-1.5 py-1 text-[11px] font-bold text-slate-600 max-w-full">
              <span className="truncate" title={v.cimke}>{v.cimke}</span>
              {!ro && (
                <button type="button" onClick={() => onValt(valasztott.filter(x => x.ref !== v.ref))}
                  className="text-slate-300 hover:text-red-500 flex-none">
                  <Lucide.X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {nyit && !ro && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <input className={U_input + ' text-sm'} value={q} autoFocus
            onChange={e => setQ(e.target.value)} placeholder="Keresés…" />
          {nyitSug && (
            <p className="text-[11px] text-amber-700 font-bold leading-relaxed mt-2">{nyitSug}</p>
          )}
          {err &&<p className="text-[11px] text-red-500 font-bold mt-2">{err}</p>}
          <div className="mt-2 max-h-56 overflow-y-auto space-y-1">
            {opts === null ? <SkeletonBar h={32} /> : opts.length === 0 ? (
              <p className="text-[11px] text-slate-300 font-bold italic py-2">nincs találat</p>
            ) : opts.map(o => (
              <button key={o.id} type="button" disabled={benne(o.id)}
                onClick={() => onValt(valasztott.concat([{ ref: o.id, cimke: o.cimke, kind }]))}
                className={'w-full text-left px-3 py-2 rounded-xl border transition ' +
                  (benne(o.id) ? 'border-slate-100 bg-slate-50 opacity-50 cursor-default'
                               : 'border-slate-100 hover:border-primary hover:bg-orange-50/40')}>
                <span className="block text-xs font-bold text-slate-700 truncate">{o.cimke}</span>
                <span className="block text-[10px] text-slate-400 font-bold truncate">{o.reszlet}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


/* --- Kampányszerkesztő ---------------------------------------------------
   Egy helyen a metaadatok ÉS az, hogy ki kapja meg a kérdőívet. A szerver
   szabálya: 'draft' állapotban minden szerkeszthető, futó kampányon CSAK a
   név. A felület ezt nem duplikálja, hanem tükrözi — a mezők letiltása csak
   udvariasság, az érvényesítés a szerveren van (ECHO_CAMPAIGN_RUNNING). */
function ECHO_CampaignEditor({ open, campaign, campaigns, onClose, onDone }) {
  const [tpls, setTpls]   = useState(null);
  const [aud, setAud]     = useState(null);
  const [nev, setNev]     = useState('');
  const [nevEn, setNevEn] = useState('');
  const [term, setTerm]   = useState('');
  const [ver, setVer]     = useState('');
  const [op, setOp]       = useState('');
  const [cl, setCl]       = useState('');
  const [gop, setGop]     = useState('');
  const [gcl, setGcl]     = useState('');
  const [tetel, setTetel] = useState([]);
  const [attrOpts, setAttrOpts] = useState(null);  // a tulajdonsag-szuro ertekkeszlete
  const [elo, setElo]     = useState(null);     // elonezet a MEG NEM MENTETT listara
  const [eloBusy, setEloBusy] = useState(false);
  const [nevsorOpen, setNevsorOpen] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  const draft = !!campaign && campaign.state === 'draft';
  const ro    = !draft;
  const termOpts = React.useMemo(() => ECHO_termOptions(campaigns), [campaigns]);

  useEffect(() => {
    if (!open || !campaign) return;
    setErr(''); setBusy(false);
    setAud(null); setTetel([]); setAttrOpts(null);
    // A mezoket NEM a listasorbol toltjuk: az echo_campaigns() nem ad
    // name_en-t, a celmeghatarozasi ablakot pedig egyik lista sem. Egyetlen
    // forras van, az echo_campaign_audience().kampany — igy nem tud ketto
    // elcsuszni egymastol.
    setNev(campaign.name || ''); setNevEn(''); setTerm(campaign.term || '');
    setVer(''); setOp(''); setCl(''); setGop(''); setGcl('');

    ECHO_api.templates()
      .then(d => {
        const arr = [];
        (Array.isArray(d) ? d : []).forEach(t => {
          (Array.isArray(t.verziok) ? t.verziok : []).forEach(v => {
            if (v.state === 'live' || v.state === 'approved') {
              arr.push({ id: v.id, label: `${t.name_hu} · v${v.version}`,
                         state: v.state, kerdesek: v.kerdesek });
            }
          });
        });
        setTpls(arr);
      })
      .catch(e => { setTpls([]); setErr(ECHO_msg(e)); });

    ECHO_api.audience(campaign.id)
      .then(d => {
        setAud(d);
        const k = (d && d.kampany) || {};
        setNev(k.name || '');
        setNevEn(k.name_en || '');
        setTerm(k.term || '');
        setVer(k.template_version_id || '');
        setOp(ECHO_toLocalInput(k.opens_at));
        setCl(ECHO_toLocalInput(k.closes_at));
        setGop(ECHO_toLocalInput(k.goals_open_at));
        setGcl(ECHO_toLocalInput(k.goals_close_at));
        // A 'filter' sorok a szabalyt is hozzak: ebbol epul vissza a
        // kartyak allapota. A ref ilyenkor a sor sajat azonositoja.
        setTetel((d && Array.isArray(d.sorok) ? d.sorok : [])
          .map(x => ({ ref: x.ref, cimke: x.cimke, kind: x.kind, szabaly: x.szabaly })));
      })
      .catch(e => { setAud(null); setErr(ECHO_msg(e)); });

    // Az ertekkeszlet a szurokartyakhoz. Nem blokkolo: ha a 80-as meg nem
    // futott le, a kartyak ures listat mutatnak, a tobbi felulet mukodik.
    ECHO_api.attrOptions().then(setAttrOpts).catch(() => setAttrOpts({}));
  }, [open, campaign && campaign.id]);

  // A becslest a SZERVER adja, mert a beiratkozasi adat nincs a kliensben.
  // Kesleltetve: gyors egymas utani kijelolesnel ne inditsunk minden
  // kattintasra lekerest. A mentett allapot igy is latszik alatta, hogy
  // legyen mihez merni a valtozast.
  useEffect(() => {
    if (!open || !campaign || !draft) { setElo(null); return; }
    let el = true;
    setEloBusy(true);
    const t = setTimeout(() => {
      ECHO_api.audiencePreview(campaign.id, ECHO_audItems(tetel))
        .then(d => { if (el) { setElo(d); setEloBusy(false); } })
        .catch(() => { if (el) { setElo(null); setEloBusy(false); } });
    }, 350);
    return () => { el = false; clearTimeout(t); setEloBusy(false); };
    // A kulcs a SZERVERNEK KULDOTT alakbol keszul: egy szurokartyan belul egy
    // chip atkattintasa is uj becslest kell hogy inditson, pedig a ref ugyanaz.
  }, [open, campaign && campaign.id, draft, JSON.stringify(ECHO_audItems(tetel))]);

  const azok = (k) => tetel.filter(t => t.kind === k);
  const setAzok = (k) => (uj) => setTetel(tetel.filter(t => t.kind !== k).concat(uj));

  // A szurokartyak a kozos AttrRuleCards alakjaban: { ref, szabaly }.
  const szurok = azok('filter').map(t => ({ ref: t.ref, szabaly: t.szabaly || {} }));
  const setSzurok = (uj) => setAzok('filter')(
    uj.map(x => ({ ref: x.ref, kind: 'filter', szabaly: x.szabaly })));

  const felAblak   = (!!op) !== (!!cl);
  const felCel     = (!!gop) !== (!!gcl);
  const rosszAblak = op && cl && ECHO_fromLocalInput(cl) <= ECHO_fromLocalInput(op);
  const ok = nev.trim() && term.trim() && !felAblak && !felCel && !rosszAblak && !busy;

  const ment = async () => {
    setBusy(true); setErr('');
    try {
      // A NULL a szerveren azt jelenti: "hagyd bekén". Amit URITENI akarunk,
      // azt a clear tombbel mondjuk meg — enelkul nem lehetne megkulonboztetni
      // a "nem kuldtem el" es a "torold" esetet.
      const clear = [];
      if (draft) {
        if (!ver) clear.push('template');
        if (!op)  clear.push('window');
        if (!gop) clear.push('goals');
        if (!nevEn.trim() && aud && aud.kampany && aud.kampany.name_en) clear.push('name_en');
      }
      await ECHO_api.campaignUpdate(campaign.id, {
        nev: nev.trim(),
        nameEn: nevEn.trim() || null,
        term: draft ? term.trim() : null,
        ver:  draft && ver ? ver : null,
        opensAt:      draft && op  ? ECHO_fromLocalInput(op)  : null,
        closesAt:     draft && cl  ? ECHO_fromLocalInput(cl)  : null,
        goalsOpenAt:  draft && gop ? ECHO_fromLocalInput(gop) : null,
        goalsCloseAt: draft && gcl ? ECHO_fromLocalInput(gcl) : null,
        clear,
      });
      if (draft) {
        await ECHO_api.audienceSet(campaign.id, ECHO_audItems(tetel));
      }
      onDone();
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  if (!campaign) return null;

  return (
    <UModal open={open} onClose={busy ? () => {} : onClose} max="max-w-4xl"
      icon={<Lucide.SlidersHorizontal size={20} />} title="Kampány szerkesztése"
      subtitle={campaign.code + ' · ' + ((ECHO_CAMPAIGN_STATE[campaign.state] || {}).label || campaign.state)}>

      {err && (
        <div className="mb-5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {ro && (
        <div className="mb-5 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 flex gap-2.5">
          <Lucide.Lock size={15} className="text-amber-500 flex-none mt-0.5" />
          <p className="text-[11px] text-amber-700 font-medium leading-relaxed">
            A kampány már <b>elindult</b>, ezért csak a <b>neve</b> módosítható. A kérdőív,
            a félév, az időablak és a célközönség menet közbeni átírása a már beérkezett
            válaszokat tenné értelmezhetetlenné, a már kiadott jegyeket pedig érvénytelenné.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --- bal: metaadatok --- */}
        <div className="space-y-4">
          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Metaadatok</h4>

          <UField label="A kampány neve" hint="Ez látszik a hallgatói és az oktatói felületen is.">
            <input className={U_input} value={nev} onChange={e => setNev(e.target.value)} maxLength={160} />
          </UField>

          <UField label="Angol név" hint="Nem kötelező. Ha üres, az angol felületen a magyar név látszik.">
            <input className={U_input} value={nevEn} onChange={e => setNevEn(e.target.value)}
              maxLength={160} placeholder="—" />
          </UField>

          <UField label="Félév" hint="Metaadat és alapértelmezett hatókör: célközönség-kurzus nélkül a félév minden kurzusa bekerül.">
            <select className={U_input} value={term} disabled={ro}
              onChange={e => setTerm(e.target.value)}>
              <option value="">Válassz félévet…</option>
              {termOpts.map(t => (
                <option key={t.term} value={t.term}>{ECHO_termLabel(t.term)}</option>
              ))}
            </select>
          </UField>

          <UField label="Kérdőív (sablonverzió)"
            hint="Üresen hagyható — de kérdőív nélkül a kampány nem indítható el (ECHO_NO_TEMPLATE).">
            {tpls === null ? <SkeletonBar h={44} /> : (
              <select className={U_input} value={ver} disabled={ro}
                onChange={e => setVer(e.target.value)}>
                <option value="">Nincs kérdőív — a kampány nem indítható</option>
                {tpls.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {t.state === 'live' ? 'élesített' : 'jóváhagyott'} · {t.kerdesek} kérdés
                  </option>
                ))}
              </select>
            )}
          </UField>

          <UField label="Célmeghatározási ablak (Part 1)"
            hint="A félév ELEJI, NEM névtelen szakasz ablaka. Ha üres, a célmeghatározás nem nyílik meg.">
            <div className="grid grid-cols-2 gap-2">
              <input type="datetime-local" className={U_input} value={gop} disabled={ro}
                onChange={e => setGop(e.target.value)} />
              <input type="datetime-local" className={U_input} value={gcl} disabled={ro}
                onChange={e => setGcl(e.target.value)} />
            </div>
          </UField>

          <UField label="Kitöltési ablak"
            hint="Üresen hagyható, de akkor a kampány nem indítható el. Két vége csak együtt értelmes.">
            <div className="grid grid-cols-2 gap-2">
              <input type="datetime-local" className={U_input} value={op} disabled={ro}
                onChange={e => setOp(e.target.value)} />
              <input type="datetime-local" className={U_input} value={cl} disabled={ro}
                onChange={e => setCl(e.target.value)} />
            </div>
          </UField>

          {(felAblak || felCel) && (
            <p className="text-[11px] text-red-500 font-bold">
              Az időablak két végpontját együtt kell megadni, vagy egyiket sem.
            </p>
          )}
          {rosszAblak && (
            <p className="text-[11px] text-red-500 font-bold">
              A zárás nem lehet a nyitás előtt.
            </p>
          )}
        </div>

        {/* --- jobb: célközönség --- */}
        <div className="space-y-4">
          <div>
            <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ki kapja meg</h4>
            <p className="text-[11px] text-slate-400 leading-relaxed mt-1.5">
              Mind a négy doboz <b>hozzáad</b>, egyik sem szűkít. A kijelölt
              <b> kurzusok</b> minden hallgatója megkapja a kérdőívet az adott kurzusra;
              a <b>csoportok</b>, a <b>személyek</b> és a <b>tulajdonságok</b> tagjai
              pedig a félévben felvett összes kurzusukra. Ha mind üres: a félév
              minden kurzusa, minden hallgatója.
            </p>
          </div>

          <ECHO_AudiencePicker campaignId={campaign.id} kind="course" ro={ro}
            cimke="Kurzusok" ikon={<Lucide.BookOpen size={13} className="text-slate-400" />}
            sug="Kijelölve: ezek minden hallgatója bekerül, a lenti dobozoktól függetlenül."
            nyitSug="Az összes kurzushoz NE jelölj ki semmit — az üres lista jelenti a félév
                     minden kurzusát. Amit itt kijelölsz, annak minden hallgatója megkapja
                     a kérdőívet."
            valasztott={azok('course')} onValt={setAzok('course')} />

          <ECHO_AudiencePicker campaignId={campaign.id} kind="group" ro={ro}
            cimke="Csoportok" ikon={<Lucide.Users size={13} className="text-slate-400" />}
            sug="A Felhasználók → Csoportok alatt létrehozott csoportok. Szabály alapú csoportnál a tagság MINDIG a mentett szabályból következik, tehát magától frissül, ha valakinek megváltozik a besorolása."
            valasztott={azok('group')} onValt={setAzok('group')} />

          <ECHO_AudiencePicker campaignId={campaign.id} kind="user" ro={ro}
            cimke="Egyedi személyek" ikon={<Lucide.User size={13} className="text-slate-400" />}
            sug="Nevesített hallgatók — csoporton kívül, egyedi esetekre."
            valasztott={azok('user')} onValt={setAzok('user')} />

          {/* TULAJDONSÁGOK. Ugyanaz a szabály-motor, mint a szabály alapú
              csoportoknál — csak nem kell előbb csoportot létrehozni hozzá.
              Több feltételcsoport egymással VAGY kapcsolatban áll. */}
          <div className="border border-slate-100 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Lucide.SlidersHorizontal size={13} className="text-slate-400" />
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                Tulajdonságok
              </span>
              {szurok.length > 0 && (
                <span className="text-[10px] font-black text-primary">{szurok.length}</span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
              Szűrés a besorolásra — tagozat, képzési szint, kar, szak. Egy
              feltételcsoporton belül a mezők <b>ÉS</b>, az értékek <b>VAGY</b>
              kapcsolatban; több feltételcsoport egymással <b>VAGY</b>. A tagság
              itt sem fagy be: mindig a mentett szabály dönt.
            </p>
            <AttrRuleCards szurok={szurok} onChange={setSzurok} ro={ro}
              opciok={attrOpts} szamol={ECHO_api.attrCount} />
          </div>

          {(elo || aud) && (
            <div className="bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {elo ? 'A mostani beállítás szerint' : 'A mentett állapot szerint'}
                </p>
                <RefreshingBadge on={eloBusy} />
              </div>
              <p className="text-sm font-black text-slate-700">
                legfeljebb {(elo || aud).legfeljebb_kurzus}
                {(elo || aud).kurzus_szukitve && !(elo || aud).hallgato_szukitve
                  ? ' kijelölt kurzus' : ' kurzus'}
                {' · '}{(elo || aud).legfeljebb_hallgato} hallgató
              </p>
              {/* A modok kulon kiirva: 59 kijelolt kurzus es "a felev minden
                  kurzusa" rakerdezes nelkul osszekeverheto. A kurzusok es a
                  KI-dobozok VAGY kapcsolatban allnak (82_audience_course_or.sql). */}
              <p className="text-[11px] text-slate-400 font-bold mt-0.5">
                {(elo || aud).kurzus_szukitve && (elo || aud).hallgato_szukitve
                  ? 'A kijelölt kurzusok minden hallgatója, és a csoportok, személyek, '
                    + 'tulajdonságok tagjai a félév összes kurzusukra.'
                  : (elo || aud).kurzus_szukitve
                    ? 'Csak a Kurzusok alatt kijelöltek — a félév többi kurzusa nem kap kérdőívet.'
                    : ((elo || aud).term ? 'A ' + (elo || aud).term + ' félév' : 'A félév')
                      + ' összes kurzusa.'}
              </p>

              {/* Ha a KI-dobozok sok emberre illeszkednek, de kozuluk keves vett
                  fel kurzust a felevben, a ket szam elter — es ez pont az, amit
                  erteni kell a mentes ELOTT. */}
              {elo && elo.hallgato_szukitve && elo.celzott_beiratkozott != null
                && elo.celzott_szemely > elo.celzott_beiratkozott && (
                <p className="text-[11px] text-amber-700 leading-relaxed mt-1.5">
                  A kijelölt csoportok, személyek és tulajdonságok <b>{elo.celzott_szemely}</b> főt
                  fednek le, de közülük csak <b>{elo.celzott_beiratkozott}</b> vett fel kurzust
                  ebben a félévben. A többinek nincs mit értékelnie.
                </p>
              )}

              {elo && aud
                && (elo.legfeljebb_kurzus !== aud.legfeljebb_kurzus
                    || elo.legfeljebb_hallgato !== aud.legfeljebb_hallgato) && (
                <p className="text-[11px] text-slate-400 font-bold mt-1.5">
                  Mentve: {aud.legfeljebb_kurzus} kurzus · {aud.legfeljebb_hallgato} hallgató —
                  a fenti szám mentés után lép életbe.
                </p>
              )}

              <button type="button" onClick={() => setNevsorOpen(true)}
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-black
                           text-primary hover:underline">
                <Lucide.Users size={12} /> Kik ezek a hallgatók?
              </button>

              <p className="text-[11px] text-slate-400 leading-relaxed mt-1.5">
                Felső korlát: a kizárási szabályok (létszám, órarendi info, vizsgakurzus,
                oktatói óraarány) csak az <b>alkalmasság újraépítésekor</b> futnak le — azt a
                mentés most már magától elvégzi.
              </p>
            </div>
          )}
        </div>
      </div>

      <ECHO_StudentListModal open={nevsorOpen} onClose={() => setNevsorOpen(false)}
        cim="A célközönség hallgatói"
        alcim={'A MOSTANI, még nem mentett beállítás szerint · ' + campaign.code}
        betolt={(q) => ECHO_api.audienceStudents(campaign.id, ECHO_audItems(tetel), q)}
        betoltKurzus={(pid) => ECHO_api.studentCourses(campaign.id, pid,
                         ECHO_audItems(tetel))} />

      <div className="flex items-center justify-end gap-2 mt-6 pt-5 border-t border-slate-100">
        <button onClick={onClose} disabled={busy} className={U_btnGhost + ' py-2.5 px-5'}>Mégse</button>
        <button onClick={ment} disabled={!ok}
          className={U_btnPrimary + ' py-2.5 px-5 disabled:opacity-40 disabled:cursor-not-allowed'}>
          {busy ? 'Mentés…' : 'Mentés'}
        </button>
      </div>
    </UModal>
  );
}


function ECHO_CampaignsPanel({ user }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sel, setSel] = useState(null);        // kiválasztott kampány
  const [editOpen, setEditOpen] = useState(false);  // kampányszerkesztő
  const [jogOpen, setJogOpen] = useState(false);    // a jogosult hallgatók névsora
  const [rate, setRate] = useState(null);      // echo_rate eredménye
  const [rateBusy, setRateBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [preview, setPreview] = useState(null); // { form } | { error }
  const [rebuild, setRebuild] = useState(null); // echo_rebuild_eligibility eredménye
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const lang = ECHO_lang();

  /* --- 3. szelet: kampány-életciklus (18_echo_campaign.sql) --- */
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState(null);   // echo_campaign_get() a kiválasztottra
  const [detailBusy, setDetailBusy] = useState(false);
  const [step, setStep] = useState(null);       // a megerősítésre váró állapotváltás
  const [txBusy, setTxBusy] = useState(false);

  const load = async (background) => {
    if (background) setRefreshing(true);
    setErr('');
    try {
      const d = await ECHO_api.campaigns();
      const arr = Array.isArray(d) ? d : [];
      setRows(arr);
      setSel(prev => (prev ? arr.find(c => c.id === prev.id) || arr[0] || null : arr[0] || null));
      return arr;
    } catch (e) { setRows([]); setErr(ECHO_msg(e)); return []; }
    finally { setRefreshing(false); }
  };
  useEffect(() => { load(false); }, []);

  useEffect(() => {
    if (!sel) { setRate(null); return; }
    let dead = false;
    setRateBusy(true);
    ECHO_api.rate(sel.id)
      .then(d => { if (!dead) setRate(d); })
      .catch(e => { if (!dead) { setRate(null); setErr(ECHO_msg(e)); } })
      .finally(() => { if (!dead) setRateBusy(false); });
    return () => { dead = true; };
  }, [sel && sel.id]);

  /* A kampány RÉSZLETEI és a lehetséges következő állapotok.
     A gombokat NEM a kliens találja ki: az echo_campaign_get() 'kovetkezo'
     tömbje mondja meg, mi következhet, mi blokkolt és miért — ugyanaz az
     echo.campaign_precheck(), ami a tényleges váltást is engedi vagy nem. */
  const loadDetail = async (id) => {
    if (!id) { setDetail(null); return; }
    setDetailBusy(true);
    try { setDetail(await ECHO_api.campaignGet(id)); }
    catch (e) { setDetail(null); setErr(ECHO_msg(e)); }
    finally { setDetailBusy(false); }
  };
  useEffect(() => { loadDetail(sel && sel.id); }, [sel && sel.id]);

  const doTransition = async (to, force) => {
    setTxBusy(true); setErr('');
    try {
      const r = await ECHO_api.campaignTransition(sel.id, to, force);
      setStep(null);
      setToast(
        (ECHO_CAMPAIGN_STEP[to] ? ECHO_CAMPAIGN_STEP[to].igé : to) +
        ' kész: ' + (ECHO_CAMPAIGN_STATE[to] ? ECHO_CAMPAIGN_STATE[to].label : to) +
        (r && r.forced ? ' (kényszerítve, naplózva)' : ''));
      await load(true);
      await loadDetail(sel.id);
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setTxBusy(false); }
  };

  const onCreated = async (r) => {
    setCreateOpen(false);
    setToast('A(z) ' + (r && r.code ? r.code : 'új') + ' kampány létrejött, előkészítés állapotban.');
    const arr = await load(true);
    const hit = (arr || []).find(c => c.id === (r && r.id));
    if (hit) setSel(hit);
  };

  /* A kérdőív megtekintése.
     Az echo_get_form() HALLGATÓI végpont: a hívó saját echo.participation
     sorára szűr, és egy adminisztrátor nincs beiratkozva a kurzusokra — ezért
     korábban a saját kampánya kérdőívét sem tudta megnézni. A 48-as migráció
     külön admin RPC-t ad (echo_campaign_form), ami a kampány sablonverziójának
     lefordított kérdőívét adja vissza, hallgatói adat nélkül. A hallgatói
     kaput SZÁNDÉKOSAN nem lazítottuk fel — annak szigorúnak kell maradnia. */
  const openForm = async () => {
    setFormOpen(true); setPreview(null);
    try {
      const f = await ECHO_api.campaignForm(sel.id);
      setPreview({ form: (f && f.form) || null, tpl: (f && f.template) || null });
    } catch (e) { setPreview({ error: ECHO_msg(e) }); }
  };

  const doRebuild = async () => {
    if (!sel) return;
    if (!window.confirm('Újraépíted a(z) ' + ECHO_kampanyAzon(sel.ref_no, sel.code) + ' kampány alkalmassági listáját?\n\nNyitott kampánynál a már kiadott jegyek egy része érvénytelenné válhat.')) return;
    setBusy(true); setErr('');
    try {
      const r = await ECHO_api.rebuildEligibility(sel.id);
      setRebuild(r);
      setToast('Az alkalmassági lista újraépült.');
      await load(true);
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  if (rows === null) {
    return (
      <div className="p-4 sm:p-8 max-w-6xl mx-auto">
        <SkeletonBar w="240px" h={22} className="mb-2" />
        <SkeletonBar w="380px" h={13} className="mb-7" />
        <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
          <table className="w-full"><tbody><SkeletonRows rows={5} cols={['30%', '15%', '20%', '20%', '15%']} /></tbody></table>
        </div>
      </div>
    );
  }

  const isAdminRole = user && (user.role === 'SUPERADMIN' || user.role === 'ADMIN');

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <UToast msg={toast} onDone={() => setToast('')} />

      <div className="flex items-start justify-between gap-4 mb-7">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">ECHO — kampánykezelés</h1>
          <p className="text-sm text-slate-400 font-medium mt-1">
            Oktatói munka hallgatói véleményezése · kampány-életciklus, kitöltési arány, kizárási napló
          </p>
        </div>
        <div className="flex items-center gap-3 flex-none pt-2">
          <RefreshingBadge on={refreshing} />
          {isAdminRole && (
            <button onClick={() => setCreateOpen(true)} className={U_btnPrimary + ' py-2.5 px-4 text-sm'}>
              <Lucide.Plus size={16} /> Új kampány
            </button>
          )}
          <button onClick={() => load(true)} className="w-10 h-10 rounded-xl hover:bg-slate-100 text-slate-400 flex items-center justify-center transition-colors" title="Frissítés">
            <Lucide.RefreshCw size={16} />
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-6 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {rows.length === 0 && !err && (
        <UEmpty icon={<Lucide.Megaphone size={28} />} title="Nincs kampány"
          subtitle="Hozz létre egyet, vagy futtasd le a 15_echo_core.sql-t — a demó seed létrehoz egy nyitott kampányt."
          action={isAdminRole ? (
            <button className={U_btnPrimary} onClick={() => setCreateOpen(true)}>
              <Lucide.Plus size={16} /> Új kampány
            </button>) : null} />
      )}

      {/* kampánylista */}
      {rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-slate-100 text-left">
                  {['Kampány', 'Állapot', 'Ablak', 'Kitöltési arány', 'Kizárva'].map(h => (
                    <th key={h} className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(c => {
                  const st = ECHO_CAMPAIGN_STATE[c.state] || { label: c.state, tone: 'slate' };
                  const arany = c.kitoltesi_arany == null ? 0 : Number(c.kitoltesi_arany);
                  const on = sel && sel.id === c.id;
                  return (
                    <tr key={c.id} onClick={() => setSel(c)}
                      className={'border-b border-slate-50 last:border-0 cursor-pointer transition-colors ' + (on ? 'bg-primary/5' : 'hover:bg-slate-50')}>
                      <td className="px-6 py-4">
                        <p className="font-black text-slate-900 text-sm"><ECHO_Src>{c.name}</ECHO_Src></p>
                        <p className="text-[11px] font-bold text-slate-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"><ECHO_KampanyId sorszam={c.ref_no} kod={c.code} kicsi /><ECHO_Src>{c.term}</ECHO_Src></p>
                      </td>
                      <td className="px-6 py-4">
                        <UBadge tone={st.tone}>{st.label}</UBadge>
                        {/* Ha az állapot NYITVA, de az ablak nem tart most, azt
                            ki kell mondani — enélkül a sor azt sugallja, hogy a
                            hallgatók már kitölthetik. */}
                        {(() => { const a = ECHO_ablakAllapot(c); return a ? (
                          <span className={'block mt-1 text-[10px] font-bold '
                            + (a.tone === 'red' ? 'text-red-600' : 'text-amber-600')}>
                            {a.szoveg}
                          </span>) : null; })()}
                      </td>
                      <td className="px-6 py-4 text-xs font-bold text-slate-500 whitespace-nowrap">
                        {ECHO_date(c.opens_at)} — {ECHO_date(c.closes_at)}
                      </td>
                      <td className="px-6 py-4 min-w-[180px]">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-sm font-black text-slate-900">{arany.toFixed(1)}%</span>
                          <span className="text-[11px] font-bold text-slate-400">{c.responses} / {c.eligible_students}</span>
                        </div>
                        <ECHO_Meter value={c.responses} max={c.eligible_students} tone={arany >= 50 ? 'green' : (arany >= 20 ? 'primary' : 'amber')} />
                      </td>
                      <td className="px-6 py-4 text-sm font-black text-slate-500">{c.excluded_courses}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sel && (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* bal: számok + kurzusonkénti arány */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              <div className="flex items-start justify-between gap-3 mb-5">
                <div>
                  <h3 className="font-black text-slate-900 flex flex-wrap items-center gap-2"><ECHO_Src>{sel.name}</ECHO_Src><ECHO_KampanyId sorszam={sel.ref_no} kod={sel.code} /></h3>
                  <p className="text-xs text-slate-400 font-bold mt-0.5">
                    {ECHO_dateTime(sel.opens_at)} — {ECHO_dateTime(sel.closes_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-none">
                  <button onClick={() => setEditOpen(true)}
                    className={U_btnGhost + ' py-2.5 px-4 text-sm'}>
                    <Lucide.SlidersHorizontal size={15} /> Szerkesztés
                  </button>
                  <button onClick={openForm} className={U_btnGhost + ' py-2.5 px-4 text-sm'}>
                    <Lucide.FileText size={15} /> Kérdőív
                  </button>
                </div>
              </div>

              {/* --- ÁLLAPOTGÉP (18_echo_campaign.sql) ---
                  A gombokat az echo_campaign_get() 'kovetkezo' tömbje adja: a
                  szerver mondja meg, mi következhet, mi blokkolt és miért. Így a
                  felület és az RPC nem tudnak szétcsúszni. */}
              <div className="border border-slate-100 rounded-2xl p-4 mb-6">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Állapot</span>
                    <UBadge tone={(ECHO_CAMPAIGN_STATE[sel.state] || {}).tone || 'slate'}>
                      {(ECHO_CAMPAIGN_STATE[sel.state] || {}).label || sel.state}
                    </UBadge>
                    {/* Az ablak állapota az ÁLLAPOT MELLETT, mert a kettő
                        nem ugyanaz: a megnyitás az állapotot váltja, a
                        kitölthetőség viszont a nyitási időponttól függ. */}
                    {(() => { const a = ECHO_ablakAllapot(sel); return a ? (
                      <span className={'text-[10px] font-black tracking-wider flex items-center gap-1 '
                        + (a.tone === 'red' ? 'text-red-600' : 'text-amber-600')}>
                        <Lucide.Clock size={11} /> {a.szoveg}
                      </span>) : null; })()}
                    {detail && detail.sealed_at && (
                      <span className="text-[10px] font-black text-violet-500 tracking-wider flex items-center gap-1">
                        <Lucide.Lock size={11} /> lepecsételve {ECHO_date(detail.sealed_at)}
                      </span>
                    )}
                  </div>
                  <RefreshingBadge on={detailBusy} />
                </div>

                {/* az állapotlánc — hol tartunk */}
                <div className="flex flex-wrap items-center gap-1 mb-4">
                  {['draft', 'open', 'closed', 'processing', 'sealed', 'published'].map((st, i, all) => {
                    const cur  = st === sel.state;
                    const past = all.indexOf(sel.state) > i;
                    return (
                      <React.Fragment key={st}>
                        {i > 0 && <Lucide.ChevronRight size={12} className="text-slate-300" />}
                        <span className={'text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-lg ' +
                          (cur ? 'bg-primary text-white' : past ? 'text-slate-400' : 'text-slate-300')}>
                          {(ECHO_CAMPAIGN_STATE[st] || {}).label || st}
                        </span>
                      </React.Fragment>
                    );
                  })}
                </div>

                {isAdminRole && detail && Array.isArray(detail.kovetkezo) && detail.kovetkezo.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {detail.kovetkezo.map(k => {
                      const meta = ECHO_CAMPAIGN_STEP[k.to] || { igé: k.to };
                      const seal = k.to === 'sealed';
                      const back = k.irany === 'vissza';
                      return (
                        <button key={k.to + k.irany} onClick={() => setStep(k)}
                          title={k.uzenet}
                          className={U_btn + ' text-sm py-2.5 px-4 ' + (
                            seal ? 'bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/10'
                                 : back ? 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                                        : 'bg-primary text-white hover:bg-primary/90 shadow-lg shadow-primary/10') +
                            (k.ok ? '' : ' opacity-60')}>
                          {seal ? <Lucide.Lock size={15} /> : back ? <Lucide.Undo2 size={15} /> : <Lucide.ArrowRight size={15} />}
                          {meta.igé}
                          {!k.ok && <Lucide.AlertTriangle size={13} />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {detail && Array.isArray(detail.kovetkezo) && detail.kovetkezo.length === 0 && (
                  <p className="text-[11px] font-bold text-slate-400">
                    A kampány a lánc végén van: közzétett állapotból nincs továbblépés, és visszaút sincs.
                  </p>
                )}

                {detail && (
                  <p className="text-[11px] text-slate-400 font-medium leading-relaxed mt-3">
                    Eredményt most {detail.eredmeny_lathato_adminnak ? 'az admin LÁT' : 'az admin sem lát'}
                    {', '}az oktató {detail.eredmeny_lathato_oktatonak ? 'LÁT' : 'nem lát'}.
                    {' '}A kaput az echo.results_gate() adja: adminnak a(z){' '}
                    {(detail.eredmeny_admin_allapotok || []).join(', ')}, oktatónak a(z){' '}
                    {(detail.eredmeny_oktato_allapotok || []).join(', ')} állapot.
                  </p>
                )}

                {detail && Array.isArray(detail.naplo) && detail.naplo.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
                    {detail.naplo.slice(0, 4).map((l, i) => (
                      <p key={i} className="text-[10px] font-bold text-slate-400">
                        {ECHO_dateTime(l.at)} · {l.from || '—'} → {l.to}
                        {l.irany === 'vissza' ? ' (visszalépés)' : ''}
                        {l.forced ? ' (kényszerítve)' : ''}
                        {l.ki ? ' · ' + l.ki : ''}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                {[
                  // "Jogosult par" = egy KURZUS-OKTATO kombinacio. Egy kurzuson
                  // tobb oktato is velemenyezheto, ezert a parok szama nagyobb
                  // lehet a kurzusokenal. A szerveroldali uzenetek is
                  // "jogosultsagi par"-nak hivjak — a cimke ezt mondja ki.
                  { k: 'Kurzus–oktató pár', v: sel.eligible_pairs, i: 'Link2',
                    t: 'Hány kurzus–oktató kombinációt lehet véleményezni. Egy kurzuson több '
                     + 'oktató is véleményezhető, ezért ez a szám nagyobb lehet a kurzusok '
                     + 'számánál. A naplókban „jogosultsági pár” néven szerepel.' },
                  { k: 'Jogosult hallgató', v: sel.eligible_students, i: 'Users',
                    t: 'Hány hallgató kapja meg a kérdőívet. Kattints a névsorért.' },
                  { k: 'Elkezdte', v: sel.attempted, i: 'PlayCircle',
                    t: 'Hányan kértek jegyet a kitöltéshez. Azt, hogy KIK, nem mutatjuk: '
                     + 'a kérdőív névtelen.' },
                  { k: 'Beérkezett', v: sel.responses, i: 'Inbox',
                    t: 'Hány kitöltött kérdőív érkezett be.' },
                ].map(x => {
                  const Ic = Lucide[x.i] || Lucide.Circle;
                  // Csak a "Jogosult hallgato" nyithato meg: a tobbi szam mogott
                  // vagy nincs nevsor (par), vagy epp azt NEM mutatjuk meg, hogy
                  // ki mit tett (elkezdte / beerkezett) — a kerdoiv nevtelen.
                  const nyit = x.k === 'Jogosult hallgató' && x.v > 0;
                  return (
                    <div key={x.k}
                      onClick={nyit ? () => setJogOpen(true) : undefined}
                      role={nyit ? 'button' : undefined}
                      title={x.t || undefined}
                      className={'bg-slate-50 rounded-2xl p-4 ' +
                        (nyit ? 'cursor-pointer hover:bg-orange-50/60 transition' : '')}>
                      <Ic size={16} className={(nyit ? 'text-primary' : 'text-slate-400') + ' mb-2'} />
                      <p className="text-xl font-black text-slate-900">{x.v}</p>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-0.5">
                        {x.k}
                        {nyit && <Lucide.ChevronRight size={11} className="inline ml-0.5 -mt-0.5 text-primary" />}
                      </p>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 mb-3">
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Kurzusonkénti kitöltés</h4>
                <RefreshingBadge on={rateBusy} />
              </div>
              {rate && Array.isArray(rate.kurzusonkent) && rate.kurzusonkent.length > 0 ? (
                <div className="space-y-3">
                  {rate.kurzusonkent.map(k => (
                    <div key={k.course_id}>
                      <div className="flex items-baseline justify-between gap-3 mb-1.5">
                        <span className="text-sm font-bold text-slate-700 truncate">
                          <ECHO_Src>{k.course_code} · {k.course_name}</ECHO_Src>
                        </span>
                        <span className="text-[11px] font-black text-slate-400 flex-none">
                          {k.valaszok} / {k.eligible} · elkezdte {k.attempted}
                        </span>
                      </div>
                      <ECHO_Meter value={k.valaszok} max={k.eligible} />
                    </div>
                  ))}
                </div>
              ) : rateBusy ? (
                <div className="space-y-3"><SkeletonBar /><SkeletonBar w="80%" /><SkeletonBar w="90%" /></div>
              ) : (
                <p className="text-sm text-slate-400 font-bold">Ehhez a kampányhoz nincs véleményezhető kurzus.</p>
              )}
            </div>
          </div>

          {/* jobb: kizárási napló */}
          <div className="space-y-6">
            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              <div className="flex items-center gap-2 mb-1">
                <Lucide.FileWarning size={16} className="text-slate-400" />
                <h3 className="font-black text-slate-900 text-sm">Kizárási napló</h3>
              </div>
              <p className="text-xs text-slate-400 font-medium mb-5">
                Minden kizárás okkal és §-hivatkozással rögzül az adatbázisban
                (echo.exclusion_log). Ha egy oktató megkérdezi, miért nem kapott
                visszajelzést, erre kell tudni mutatni.
              </p>

              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="bg-amber-50 rounded-2xl p-4">
                  <p className="text-xl font-black text-amber-700">{sel.excluded_courses}</p>
                  <p className="text-[10px] font-black text-amber-600/70 uppercase tracking-wider mt-0.5">kizárt kurzus</p>
                </div>
                <div className="bg-slate-50 rounded-2xl p-4">
                  <p className="text-xl font-black text-slate-700">{rebuild ? rebuild.excluded_pairs : '—'}</p>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-0.5">kizárt oktatói pár</p>
                </div>
              </div>

              <div className="space-y-2 mb-5">
                {ECHO_EXCLUSION_RULES.map(r => (
                  <div key={r.code} className="border border-slate-100 rounded-2xl px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-slate-700">{r.name}</span>
                      <UBadge tone={r.scope === 'kurzus' ? 'slate' : 'violet'}>{r.scope}</UBadge>
                    </div>
                    <p className="text-[11px] text-slate-400 font-medium mt-1 leading-relaxed">{r.why}</p>
                    <p className="text-[10px] text-slate-300 font-black tracking-wider mt-1.5">
                      {r.code} · 28/2023. § — pontosítandó
                    </p>
                  </div>
                ))}
              </div>

              {/* Kimondjuk, ami hiányzik: a soronkénti naplóhoz nincs RPC. */}
              <div className="bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5 mb-4">
                <Lucide.Info size={15} className="text-slate-400 flex-none mt-0.5" />
                <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
                  A SORONKÉNTI napló (melyik kurzus, melyik szabály, milyen adattal)
                  még nem jeleníthető meg: a 15_echo_core.sql nem tartalmaz hozzá
                  public RPC-t, az echo sémára pedig a kliensnek nincs joga. Itt
                  most a kampányszintű darabszámok és a szabálykatalógus látszik.
                </p>
              </div>

              {isAdminRole && (
                <button onClick={doRebuild} disabled={busy} className={U_btnGhost + ' w-full'}>
                  {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.RefreshCcw size={16} />}
                  Alkalmasság újraépítése
                </button>
              )}
              {rebuild && (
                <p className="text-[11px] font-bold text-slate-400 mt-3 text-center">
                  {rebuild.eligible_pairs} jogosult pár · {rebuild.eligible_courses} kurzus ·
                  {' '}{rebuild.excluded_courses} kurzus és {rebuild.excluded_pairs} pár kizárva
                </p>
              )}
            </div>

            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              <div className="flex items-center gap-2 mb-1">
                <Lucide.EyeOff size={16} className="text-slate-400" />
                <h3 className="font-black text-slate-900 text-sm">Eredmény: külön nézetben</h3>
              </div>
              <p className="text-xs text-slate-400 font-medium leading-relaxed">
                Ez a fül szándékosan semmilyen válasz-tartalmat nem mutat, csak
                darabszámot és arányt. Az eredményt az „Oktatói eredmények” menüpont
                adja (echo_course_results / echo_teacher_results), k-anonimitási
                küszöbökkel. NYITOTT kampány alatt ott sem látszik eredmény, csak
                arány: az echo.results_gate() adminnak a closed / processing / sealed /
                published, oktatónak a sealed / published állapotot engedi — mérve.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* kérdőív-előnézet — CSAK olvasás, szerkesztő a következő körben */}
      <UModal open={formOpen} onClose={() => setFormOpen(false)} max="max-w-3xl"
        icon={<Lucide.FileText size={20} />} title="A kampány kérdőíve"
        subtitle="Csak megtekintés — az élő verzió compiled mezője az adatbázisban immutábilis">
        {preview === null ? (
          <div className="space-y-3"><SkeletonBar w="60%" h={16} /><SkeletonBar /><SkeletonBar w="85%" /><SkeletonBar w="70%" /></div>
        ) : preview.error ? (
          <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 text-sm font-bold text-amber-700 flex gap-2">
            <Lucide.AlertTriangle size={16} className="flex-none mt-0.5" /> {preview.error}
          </div>
        ) : !preview.form ? (
          <UEmpty icon={<Lucide.FileQuestion size={28} />} title="A kérdőív üres" />
        ) : (
          <ECHO_FormPreview form={preview.form} lang={lang} tpl={preview.tpl} />
        )}
      </UModal>

      {/* --- kampány-életciklus: létrehozás és állapotváltás --- */}
      <ECHO_CampaignCreate open={createOpen} onClose={() => setCreateOpen(false)}
                          onDone={onCreated} campaigns={rows} />

      <ECHO_StudentListModal open={jogOpen} onClose={() => setJogOpen(false)}
        cim="Jogosult hallgatók"
        alcim={sel ? ((ECHO_kampanyAzon(sel.ref_no, sel.code) ? ECHO_kampanyAzon(sel.ref_no, sel.code) + ' · ' : '') + sel.name + ' · az alkalmassági lista szerint') : ''}
        betolt={(q) => ECHO_api.campaignStudents(sel.id, q)}
        betoltKurzus={(pid) => ECHO_api.studentCourses(sel.id, pid, null)} />

      <ECHO_CampaignEditor open={editOpen} campaign={sel} campaigns={rows}
        onClose={() => setEditOpen(false)}
        onDone={() => { setEditOpen(false); load(true); loadDetail(sel && sel.id); }} />
      {sel && step && (
        <ECHO_TransitionConfirm
          step={step} campaign={sel} busy={txBusy}
          onCancel={() => setStep(null)}
          onConfirm={doTransition} />
      )}
    </div>
  );
}

// A compiled JSONB olvasható kirajzolása. Ugyanabból az adatból, mint a
// kitöltő — így ami itt látszik, azt kapja a hallgató is.
function ECHO_FormPreview({ form, lang, tpl }) {
  const meta = form.meta || {};
  // A 'meta' a compiled JSONB-ből jön, és nem minden sablonverzióban van
  // kitöltve — ilyenkor a fejléc "· v" alakban, üresen jelent meg. A tpl az
  // adatbázisbeli sablonverzió (48_campaign_form.sql): ha van, AZ a pontosabb
  // forrás, mert a tábla írja, nem a fordítás pillanata.
  const cim = ECHO_txt({ hu: meta.title_hu, en: meta.title_en }, lang)
              || (tpl && (lang === 'en' ? (tpl.name_en || tpl.name_hu) : tpl.name_hu))
              || 'A kérdőív';
  const alsor = [
    meta.code || null,
    (meta.version || (tpl && tpl.version)) ? 'v' + (meta.version || tpl.version) : null,
    meta.legal_hu || null,
    (tpl && tpl.state) ? (tpl.state === 'live' ? 'élesített' : tpl.state) : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="space-y-6">
      <div className="bg-slate-50 rounded-2xl p-4">
        <h4 className="font-black text-slate-900"><ECHO_Src>{cim}</ECHO_Src></h4>
        {alsor && (
          <p className="text-xs text-slate-400 font-bold mt-1"><ECHO_Src>{alsor}</ECHO_Src></p>
        )}
        {meta.forras_megjegyzes && (
          <p className="text-[11px] text-amber-700 font-medium mt-2 leading-relaxed">
            <ECHO_Src>{meta.forras_megjegyzes}</ECHO_Src>
          </p>
        )}
      </div>
      {(form.sections || []).map(sec => (
        <div key={sec.id}>
          <div className="flex items-center gap-2 mb-3">
            <h5 className="text-sm font-black text-slate-800"><ECHO_Src>{ECHO_txt(sec, lang)}</ECHO_Src></h5>
            <UBadge tone={sec.part === 'part1' ? 'blue' : 'slate'}>
              <ECHO_Src>{sec.part}</ECHO_Src>
            </UBadge>
          </div>
          <div className="space-y-2">
            {(sec.questions || []).map(raw => {
              // A teljes űrlap előnézetében is a KÖZÖS feloldó fut — különben
              // ez a nézet mutatna nyers "[Oktató neve]"-t, miközben a
              // kérdés- és szakaszelőnézet már feloldva mutatja.
              const q = ECHO_resolveTokens(raw, ECHO_PREVIEW_CTX);
              return (
              <div key={q.id} className="border border-slate-100 rounded-2xl px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-bold text-slate-700 leading-snug">
                    <ECHO_Src>{ECHO_txt(q, lang)}</ECHO_Src>
                    {q.required && <span className="text-primary ml-1">*</span>}
                  </p>
                  <span className="text-[10px] font-black text-slate-300 uppercase tracking-wider flex-none">{q.type}</span>
                </div>
                {Array.isArray(q.options) && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {ECHO_options(q, lang).map(o => (
                      <span key={o.value} className="text-[11px] font-bold text-slate-500 bg-slate-50 rounded-lg px-2 py-1">
                        <ECHO_Src>{o.label}</ECHO_Src>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-3 mt-2 text-[10px] font-black text-slate-300 uppercase tracking-wider">
                  {q.max > 1 && <span>max {q.max}</span>}
                  {q.repeat && <span>ismétlés: {q.repeat}</span>}
                  {q.randomize && <span>kevert</span>}
                  {q.moderated && <span>moderált</span>}
                  {q.cond && <span>feltételes</span>}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   ECHO — 2. SZELET
   Kérdőívszerkesztő, oktatói eredménynézet, moderálási sor.
   A szignatúrák és a visszaadott JSON alakja a 16_echo_reports.sql-ből
   valók, és a helyi Postgres 16 replikán MÉRVE lettek (verify adatbázis,
   DEMO-2025-26-2 kampány, 42 válasz).

   AMIT A SZERVER AD, ÉS AMIT EZ A RÉTEG NEM ÍR FELÜL
     • a k-küszöbök (k_numeric=5, k_dist=10, k_text=10, k_slice=5, k_low=5 —
       mérve az echo.setting-ből) kizárólag a szerveren érvényesülnek; itt
       CSAK megjelenítjük, amit visszakaptunk, és kimondjuk, mi hiányzik
     • az eredmény időzítését az echo.results_gate() dönti el: a mérés szerint
       'open' állapotú kampányra ECHO_RESULTS_NOT_READY jön, adminnak
       closed/processing/sealed/published, oktatónak sealed/published enged
     • a compiled szerkezeti helyességét az echo_template_validate() mondja
       meg, nem ez a fájl — a szerkesztő csak MUTATJA a listát
   ============================================================ */

/* ------------------------------------------------------------
   9. Riport-atomok
   ------------------------------------------------------------ */

// Egy eloszlás-cella sávja. A `rejtve` cellának SZÁNDÉKOSAN nincs sávja és
// nincs száma — a komplementer-elnyomás (echo.suppress_cells) pont azért
// rejt el egy másodikat is, hogy kivonással se lehessen visszaszámolni.
function ECHO_CellBar({ cell, n }) {
  const rejtve = cell && cell.rejtve;
  const db = rejtve ? null : Number(cell.db || 0);
  const pct = (!rejtve && n > 0) ? Math.round((db / n) * 100) : 0;
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-xs font-bold text-slate-600 truncate">
          <ECHO_Src>{String(cell.cimke != null ? cell.cimke : cell.ertek)}</ECHO_Src>
        </span>
        {rejtve ? (
          <span className="text-[10px] font-black text-slate-300 uppercase tracking-wider flex-none flex items-center gap-1">
            <Lucide.EyeOff size={11} /> elrejtve
          </span>
        ) : (
          <span className="text-[11px] font-black text-slate-400 flex-none">{db} · {pct}%</span>
        )}
      </div>
      {rejtve
        ? <div className="h-2 rounded-full bg-[repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0_4px,#f8fafc_4px,#f8fafc_8px)]" />
        : <ECHO_Meter value={db} max={n} />}
    </div>
  );
}

// ŐSZINTE ÜRESSÉG. Ahol a küszöb elrejt, ott nem üres helyet mutatunk, hanem
// azt, hogy MIÉRT nincs adat, és MENNYI válasz kellene hozzá.
function ECHO_Hidden({ title, message, need, tone = 'slate' }) {
  const box = tone === 'amber'
    ? 'bg-amber-50 border-amber-100 text-amber-700'
    : 'bg-slate-50 border-slate-100 text-slate-500';
  return (
    <div className={'rounded-2xl border px-4 py-3 flex gap-2.5 ' + box}>
      <Lucide.EyeOff size={15} className="flex-none mt-0.5 opacity-60" />
      <div className="min-w-0">
        <p className="text-xs font-black">{title}</p>
        {message && <p className="text-[11px] font-medium mt-1 leading-relaxed opacity-80"><ECHO_Src>{message}</ECHO_Src></p>}
        {need > 0 && (
          <p className="text-[11px] font-black mt-1.5">
            Még {need} válasz kellene ahhoz, hogy ez a rész megjelenjen.
          </p>
        )}
      </div>
    </div>
  );
}

// Egy kérdés eredménye. Minden ág a szerver által visszaadott mezőkre épül:
// rejtve / rejtes_oka / uzenet / atlag / szoras / eloszlas / szovegek / szoveg_*.
function ECHO_ResultQuestion({ q, kuszob, lang }) {
  const k = kuszob || {};
  const n = Number(q.n || 0);
  const szoveges = q.type === 'longtext' || q.type === 'text' || q.type === 'long';

  return (
    <div className="border border-slate-100 rounded-2xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-sm font-black text-slate-800 leading-snug min-w-0">
          <ECHO_Src>{ECHO_txt(q, lang)}</ECHO_Src>
        </p>
        <div className="flex items-center gap-2 flex-none">
          {q.moderalatlan > 0 && <UBadge tone="amber"><Lucide.Flag size={10} /> {q.moderalatlan} moderálatlan</UBadge>}
          <UBadge tone="slate">{q.type}</UBadge>
        </div>
      </div>

      <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-3">
        {n} válasz
      </p>

      {q.rejtve ? (
        <ECHO_Hidden
          title="Ez a kérdés nem jeleníthető meg"
          message={q.uzenet}
          need={Math.max(0, Number(k.k_numeric || 0) - n)} />
      ) : (
        <>
          {q.atlag != null && (
            <div className="flex items-baseline gap-3 mb-4">
              <span className="text-3xl font-black text-slate-900">{Number(q.atlag).toFixed(2)}</span>
              <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                átlag{q.szoras != null ? ' · szórás ' + Number(q.szoras).toFixed(2) : ''}
              </span>
            </div>
          )}

          {Array.isArray(q.eloszlas) && q.eloszlas.length > 0 && (
            <div className="mb-3">
              {q.eloszlas.map((c, i) => <ECHO_CellBar key={i} cell={c} n={n} />)}
              {q.eloszlas.some(c => c && c.rejtve) && (
                <p className="text-[10px] text-slate-400 font-bold mt-2 leading-relaxed">
                  Az elrejtett cellákban {k.k_slice}-nél kevesebb válasz van. Ha csak egy
                  ilyen lenne, kivonással visszaszámolható volna — ezért rejt el a szerver
                  mindig legalább kettőt (komplementer-elnyomás).
                </p>
              )}
            </div>
          )}

          {!q.eloszlas && !szoveges && q.rejtes_oka === 'kis_elemszam_nincs_eloszlas' && (
            <ECHO_Hidden
              title="Eloszlás nélkül"
              message={q.uzenet}
              need={Math.max(0, Number(k.k_dist || 0) - n)} />
          )}

          {szoveges && (
            q.szoveg_rejtve ? (
              <ECHO_Hidden
                title="A szöveges válaszok nem jeleníthetők meg"
                message={q.szoveg_uzenet}
                need={Math.max(0, Number(k.k_text || 0) - Number(q.szoveg_db || 0))} />
            ) : (
              <div className="space-y-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                  {q.szoveg_db} moderált, érvényes szöveg
                </p>
                {(q.szovegek || []).map((s, i) => (
                  <div key={i} className="bg-slate-50 rounded-2xl px-4 py-3 text-sm text-slate-700 font-medium leading-relaxed">
                    <ECHO_Src>{String(s)}</ECHO_Src>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

// Egy teljes bontás (kurzusszintű vagy egy oktató). A `tajekoztato` a
// 33% alatti óralátogatású blokkot jelöli.
/* ------------------------------------------------------------
   NYERS, SZŰRETLEN EREDMÉNY — kizárólag adminisztrátornak.

   Ez a nézet SEMMIT nem rejt el: nincs k-küszöb, nincs óralátogatás-szűrés, és
   a szöveges válaszok a moderálási állapotukkal együtt jönnek. Az a célja, hogy
   az adminisztrátor a TELJES képet lássa, és ő döntsön arról, mi releváns.

   AMI ITT SINCS: a hallgató személye. A válaszsorban nincs olyan mező, ami rá
   mutatna — ez a nyers nézetben is így van, mert a beküldés eleve névtelen.
   ------------------------------------------------------------ */
function ECHO_RawResults({ nyers, lang }) {
  if (!nyers) return null;
  const v = nyers.valaszadas || {};
  const kerdesek = nyers.kerdesek || [];

  const ertekSzoveg = (e) => {
    if (e === null || e === undefined) return '—';
    if (Array.isArray(e)) return e.join(', ');
    if (typeof e === 'object') return JSON.stringify(e);
    return String(e);
  };

  return (
    <div className="mt-5 bg-white border border-primary/20 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-4">
        <div>
          <span className="text-[10px] font-black text-primary uppercase tracking-widest">
            Teljes, szűretlen eredmény
          </span>
          <p className="text-[12px] text-slate-500 mt-0.5">
            Küszöb és óralátogatás-szűrés nélkül. A megtekintés naplózódik.
          </p>
        </div>
        <div className="flex gap-4 ml-auto">
          {[[v.valaszok, 'válasz'], [v.alacsony, 'ebből 33% alatti'], [v.jogosult, 'jogosult']].map(([n, c], i) => (
            <div key={i} className="text-center">
              <p className="text-xl font-black text-slate-900">{n == null ? '—' : n}</p>
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">{c}</p>
            </div>
          ))}
        </div>
      </div>

      {Number(nyers.eltero_verzio) > 0 && (
        <div className="mx-5 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 flex gap-2" data-echo-eltero-verzio={nyers.eltero_verzio}>
          <Lucide.AlertTriangle size={14} className="flex-none mt-0.5 text-amber-600" />
          <p className="text-[12px] font-semibold text-amber-800">
            {`${nyers.eltero_verzio} válasz a kampány korábbi kérdőívverziójával érkezett. Ezeknél a kérdésazonosítók eltérhetnek a mostani kérdőívtől, ezért egyes válaszaik nem köthetők a mostani kérdésekhez.`}
          </p>
        </div>
      )}

      {kerdesek.length === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-400 font-bold">Ehhez a bontáshoz nincs kérdés.</p>
      ) : (
        <div className="divide-y divide-slate-50">
          {kerdesek.map((q, i) => (
            <div key={q.id || i} className="px-5 py-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                <ECHO_Src>{q.szakasz || ''}</ECHO_Src>
              </p>
              <p className="text-sm font-bold text-slate-800 mt-0.5">
                <ECHO_Src>{ECHO_txt(q, lang) || q.id}</ECHO_Src>
                <span className="text-slate-400 font-medium"> · {q.valasz_db} válasz</span>
              </p>

              {(q.ertekek || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {q.ertekek.map((e, j) => (
                    <span key={j} className="px-2 py-1 rounded-lg bg-slate-100 text-[12px] font-bold text-slate-700">
                      <ECHO_Src>{ertekSzoveg(e)}</ECHO_Src>
                    </span>
                  ))}
                </div>
              )}

              {(q.szovegek || []).length > 0 && (
                <div className="mt-3 space-y-2">
                  {q.szovegek.map((t, j) => (
                    <div key={j} className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                      <p className="text-[13px] text-slate-700"><ECHO_Src>{ertekSzoveg(t.szoveg)}</ECHO_Src></p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <UBadge tone={t.allapot === 'valid' ? 'green'
                                      : t.allapot === 'invalid' ? 'red'
                                      : t.allapot === 'pending' ? 'amber' : 'slate'}>
                          {t.allapot}
                        </UBadge>
                        {t.alacsony_oralatogatas && (
                          <UBadge tone="amber">33% alatti óralátogatás</UBadge>
                        )}
                        {t.indok && <span className="text-[11px] text-slate-400">{t.indok}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ECHO_ResultBlock({ r, lang, cim, ikon, tajekoztato }) {
  if (!r) return null;
  const k = r.kuszobok || {};
  const v = r.valaszadas || {};
  const Ikon = Lucide[ikon] || Lucide.BarChart2;

  return (
    <div className={'rounded-3xl border p-5 sm:p-6 ' + (tajekoztato ? 'bg-amber-50/40 border-amber-100' : 'bg-white border-slate-100')}>
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5 min-w-0">
          <Ikon size={18} className={tajekoztato ? 'text-amber-500' : 'text-slate-400'} />
          <h3 className="font-black text-slate-900 truncate">{cim}</h3>
        </div>
        {tajekoztato && <UBadge tone="amber"><Lucide.Info size={10} /> tájékoztató jellegű</UBadge>}
      </div>

      {tajekoztato && (
        <div className="bg-white/70 border border-amber-100 rounded-2xl px-4 py-3 mb-5">
          <p className="text-[11px] text-amber-800 font-medium leading-relaxed">
            <ECHO_Src>{r.megjegyzes || ''}</ECHO_Src>
          </p>
        </div>
      )}

      {!tajekoztato && (
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="bg-primary/5 rounded-2xl p-4 col-span-3 sm:col-span-1">
            <p className="text-3xl font-black text-primary">
              {v.arany == null ? '—' : Number(v.arany).toFixed(1) + '%'}
            </p>
            <p className="text-[10px] font-black text-primary/60 uppercase tracking-wider mt-0.5">válaszadási arány</p>
          </div>
          <div className="bg-slate-50 rounded-2xl p-4">
            <p className="text-xl font-black text-slate-900">{v.valaszok}</p>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-0.5">
              válasz ebben a bontásban
            </p>
          </div>
          <div className="bg-slate-50 rounded-2xl p-4">
            <p className="text-xl font-black text-slate-900">{v.jogosult}</p>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-0.5">jogosult</p>
          </div>
        </div>
      )}

      {/* MIÉRT LEHET KEVESEBB, MINT AHÁNYAN KITÖLTÖTTÉK
          A kampánykezelő 5/5-öt, azaz 100%-ot mutathat, miközben itt 4 áll — és
          ez így helyes. A 3. § (9) szerint a 33% alatti óralátogatást valló
          hallgató véleménye TÁJÉKOZTATÓ JELLEGŰ: kikerül a fő halmazból egy
          külön blokkba. A számot nem mondjuk meg (az önmagában is információ
          lenne egy kis csoportról), de azt igen, hogy a különbség ONNAN jön —
          különben úgy tűnik, elveszett egy válasz. */}
      {!tajekoztato && (
        <p className="text-[11px] text-slate-400 leading-relaxed -mt-2 mb-5">
          Ez a szám kevesebb lehet, mint ahányan kitöltötték: a 33% alatti óralátogatást
          valló hallgatók válaszai a 3. § (9) szerint külön, tájékoztató blokkba kerülnek,
          és ebbe a bontásba nem számítanak bele.
        </p>
      )}

      {/* KÉRDŐÍVCSERE A VÁLASZOK UTÁN (65_echo_results_questions.sql). A kérdéslista a
          kampány MOSTANI kérdőívverziójából jön; a korábbi verzióval beküldött sorok
          kérdésazonosítói eltérhetnek. A számot a szerver csak adminnak adja vissza. */}
      {!tajekoztato && Number(r.eltero_verzio) > 0 && (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 flex gap-2.5" data-echo-eltero-verzio={r.eltero_verzio}>
          <Lucide.AlertTriangle size={15} className="flex-none mt-0.5 text-amber-600" />
          <p className="text-[12px] font-semibold text-amber-800 leading-relaxed">
            {`${r.eltero_verzio} válasz a kampány korábbi kérdőívverziójával érkezett. Ezeknél a kérdésazonosítók eltérhetnek a mostani kérdőívtől, ezért egyes válaszaik nem köthetők a mostani kérdésekhez.`}
          </p>
        </div>
      )}

      {r.rejtve ? (
        <ECHO_Hidden
          title="Ez a bontás egészben elrejtve"
          message={r.uzenet}
          need={Math.max(0, Number(k.k_numeric || 0) - Number((r.valaszadas || {}).valaszok || 0))}
          tone="amber" />
      ) : (r.kerdesek || []).length === 0 ? (
        <p className="text-sm text-slate-400 font-bold">Ehhez a bontáshoz nincs kérdés.</p>
      ) : (
        <div className="space-y-3">
          {(r.kerdesek || []).map((q, i) => (
            <ECHO_ResultQuestion key={q.id || i} q={q} kuszob={k} lang={lang} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   10. ECHO_TeacherView — oktatói eredménynézet
   ------------------------------------------------------------
   KÉT ÜZEMMÓD, EGY NÉZET. A különbség CSAK abban van, hogy honnan jön a
   kampány- és kurzuslista; az eredményblokkok alatta ugyanazok.

     • 'oktato' mód — public.echo_my_teacher_courses() (19_echo_roles.sql).
       A bejelentkezett fiókhoz kötött echo.teacher sor SAJÁT kurzusai,
       kampányonként, EREDMÉNY NÉLKÜL (állapot + darabszámok). MÉRVE a
       replikán: két összekötött oktató közül az egyik 1 kurzust lát
       (GAMF-INF-101), a másik 2-t (102, 103) — és a másikét egyik sem.
     • 'admin' mód — echo_campaigns() + echo_rate(), ahogy eddig. MINDKETTŐ
       törzse public.is_admin()-t követel (15_echo_core.sql 9.6), ezért
       ADMISSIONS / FINANCE fiókkal továbbra is üres marad — a nézet ezt
       kimondja, nem hallgat üresen.

   A SORREND SZÁNDÉKOS: ELŐSZÖR az oktatói RPC. Egy fiók lehet EGYSZERRE
   admin ÉS oktató; ilyenkor a saját kurzusait akarja látni, nem az egész
   intézményt. A módváltó gomb mindkét irányban ott van, ha van jogosultság.

   MIÉRT NEM A user.echoRoles-BÓL DÖNTÜNK: az app.jsx menüszűrő próbája
   defenzív (a 19-es migráció lefutása előtt is működnie kell), tehát a
   hiánya nem bizonyíték. A szerver hívása viszont az — ezért a nézet a
   TÉNYLEGES válaszból dönt, nem egy kliensoldali jelzőből.

   Nyitott ('open') kampányra a szerver ECHO_RESULTS_NOT_READY-t dob —
   ilyenkor CSAK az arányt mutatjuk, és kimondjuk, miért.
   ------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
   ECHO_ExportButton — a riport kivitele CSV-be vagy JSON-ba

   A CSV-t itt állítjuk elő, DE az adatot nem itt szűrjük: a szerver
   echo_export_results() már elnyomott sorokat ad vissza. Ha egy cella rejtve
   volt a képernyőn, ide üresen érkezik — nincs mit "véletlenül" kiírni.

   A rejtett cellák SZÁMÁT viszont megmutatjuk. Enélkül egy hiányos állomány
   teljesnek látszana, és a fogadó fél nem tudná, hogy szűrt adatot kapott.
   --------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   ECHO_CommentPanel — a 6. § (7) szerinti 7 napos oktatói észrevétel

   A határidő NEM a kampány zárásától indul, hanem az ÁTVÉTELTŐL: attól, hogy
   az oktató ténylegesen megkapta a jegyzőkönyvet. Amíg ez nem történt meg, a
   szerver 'atvette: null'-t ad — ilyenkor NEM hazudunk határidőt, hanem
   megmondjuk, hogy az óra még el sem indult.

   A határidőn túli beadást a szerver ELFOGADJA, csak megjelöli. Ezt itt is
   őszintén kiírjuk: egy elutasított észrevétel nyomtalanul eltűnne, egy
   megjelölt viszont ott marad, és a címzett dönt róla.
   --------------------------------------------------------------------------- */
function ECHO_CommentPanel({ campaign }) {
  const [w, setW] = useState(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const reload = React.useCallback(async () => {
    if (!campaign) return;
    try { setErr(''); setW(await ECHO_api.commentWindow(campaign)); }
    catch (e) { setErr(ECHO_msg(e)); setW(null); }
  }, [campaign]);

  useEffect(() => { reload(); }, [reload]);

  if (!campaign) return null;
  if (err && !w) return null;   /* nem oktató: a panel egyszerűen nincs ott */
  if (!w) return null;

  const kuld = async () => {
    setBusy(true); setErr(''); setOk('');
    try {
      const d = await ECHO_api.commentSubmit(campaign, body);
      setBody('');
      setOk(d.kesett
        ? 'Az észrevétel rögzítve, de a határidőn TÚL érkezett — ezt a rendszer megjelölte. '
          + 'A címzett (' + (d.cimzett_szerep || 'nincs kijelölve') + ') dönt róla.'
        : 'Az észrevétel rögzítve, és továbbítva a címzettnek ('
          + (d.cimzett_szerep || 'nincs kijelölve') + ').');
      if (!d.cimzett_van) {
        setOk(o => o + ' FIGYELEM: nincs kijelölt címzett — szóljon a Minőségügynek.');
      }
      reload();
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  const fmt = (t) => t ? new Date(t).toLocaleString('hu-HU',
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div className="bg-white border border-slate-100 rounded-3xl p-5 space-y-4">
      <div className="flex items-start gap-3">
        <Lucide.MessageSquare size={18} className="flex-none mt-0.5 text-slate-400" />
        <div className="min-w-0">
          <h3 className="font-black text-slate-800">Észrevétel a jegyzőkönyvre</h3>
          <p className="text-[11px] text-slate-400 font-medium mt-1 leading-relaxed">
            A szabályzat 6. § (7) szerint {w.nap} napod van észrevételt tenni. A határidő a
            jegyzőkönyv <strong>átvételétől</strong> indul, nem a kampány zárásától.
          </p>
        </div>
      </div>

      {!w.atvette && (
        <div className="bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm text-slate-600 font-medium">
          A jegyzőkönyv átvétele még nincs rögzítve, ezért a {w.nap} napos határidő
          <strong> még el sem indult</strong>. Észrevételt az átvétel után lehet tenni.
        </div>
      )}

      {w.atvette && (
        <div className="grid sm:grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-400">Átvéve</div>
            <div className="font-bold text-slate-700">{fmt(w.atvette)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-400">Határidő</div>
            <div className="font-bold text-slate-700">{fmt(w.hatarido)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-400">Hátralévő</div>
            <div className={'font-bold ' + (w.lejart ? 'text-red-600' : 'text-emerald-700')}>
              {w.lejart ? 'Lejárt' : Math.floor((w.hatralevo_orak || 0) / 24) + ' nap '
                          + ((w.hatralevo_orak || 0) % 24) + ' óra'}
            </div>
          </div>
        </div>
      )}

      {w.atvette && (
        <>
          <textarea
            value={body} onChange={e => setBody(e.target.value)} rows={4}
            placeholder="Mit szeretnél megjegyezni a jegyzőkönyvhöz?"
            className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
          {w.lejart && (
            <div className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              A határidő lejárt. Az észrevételt a rendszer ettől még <strong>befogadja</strong>,
              de megjelöli késettként — a címzett dönt róla.
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <button disabled={busy || !body.trim()} onClick={kuld}
                    className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
              <Lucide.Send size={14} /> Észrevétel beküldése
            </button>
            {w.eddigi_eszrevetel > 0 && (
              <span className="text-[11px] font-medium text-slate-400">
                Eddig {w.eddigi_eszrevetel} észrevételt küldtél ehhez a kampányhoz.
              </span>
            )}
          </div>
        </>
      )}

      {ok  && <div className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{ok}</div>}
      {err && <div className="text-[11px] font-medium text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</div>}
    </div>
  );
}

function ECHO_ExportCsv(adat) {
  const fej = ['blokk', 'kerdes_id', 'kerdes', 'tipus', 'n', 'atlag', 'eloszlas', 'szoveg_db', 'szovegek'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const t = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const sorok = (adat.sorok || []).map(r => fej.map(k => esc(r[k])).join(';'));
  /* BOM: enélkül az Excel a magyar ékezeteket elrontja. */
  return '\ufeff' + [fej.join(';')].concat(sorok).join('\r\n');
}

function ECHO_ExportButton({ campaign, course, teacher, scope, cimke }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const fut = async (format) => {
    setBusy(true); setErr(''); setInfo('');
    try {
      const d = await ECHO_api.exportResults(campaign, course, teacher, scope, format);
      if (d.teljesen_rejtve) {
        setErr('Ez a bontás egészében rejtve van (' + (d.ok || 'k-küszöb') +
               '), ezért nem exportálható. Ez nem hiba: a küszöb alatti '
               + 'halmazból egyetlen sor sem vihető ki.');
        return;
      }
      const tartalom = (format === 'csv') ? ECHO_ExportCsv(d) : JSON.stringify(d, null, 2);
      const blob = new Blob([tartalom],
        { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'echo-' + (scope || 'course') + '-' +
                   new Date().toISOString().slice(0, 10) + '.' + format;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      const n = (d.sorok || []).length, rejtett = d.rejtett_cellak || 0;
      setInfo(n + ' sor kiírva' +
        (rejtett > 0 ? ' — ' + rejtett + ' cellát a k-küszöb elrejtett, ezek nincsenek benne.' : '.'));
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
          {cimke || 'Kivitel'}
        </span>
        <button disabled={busy} onClick={() => fut('csv')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          <Lucide.Download size={13} /> CSV
        </button>
        <button disabled={busy} onClick={() => fut('json')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          <Lucide.Download size={13} /> JSON
        </button>
      </div>
      {info && (
        <div className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
          {info}
        </div>
      )}
      {err && (
        <div className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          {err}
        </div>
      )}
    </div>
  );
}

function ECHO_TeacherView({ user }) {
  const [mode, setMode] = useState(null);   // null = még próbálkozunk | 'oktato' | 'admin'
  const [mine, setMine] = useState(null);   // echo_my_teacher_courses() nyers válasza
  const [adminCamps, setAdminCamps] = useState(null);  // echo_campaigns(); null = nem járható
  const [camps, setCamps] = useState(null);
  const [cid, setCid] = useState('');
  const [rate, setRate] = useState(null);
  const [courseId, setCourseId] = useState('');
  const [cres, setCres] = useState(null);   // echo_course_results
  const [tres, setTres] = useState(null);   // echo_teacher_results
  const [gate, setGate] = useState('');     // ECHO_RESULTS_NOT_READY üzenete
  const [listErr, setListErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const lang = ECHO_lang();

  // MINDKÉT utat EGYSZER megpróbáljuk, betöltéskor. Az admin ágat akkor is,
  // ha az oktatói sikerült — csak így tudjuk, felkínálhatjuk-e a módváltót.
  // Két olcsó hívás, és egyik sem ad vissza válasz-tartalmat, csak darabszámot.
  useEffect(() => {
    let dead = false;
    (async () => {
      let teacherOk = false, teacherErr = '';
      try {
        const d = await ECHO_api.myTeacherCourses();
        if (dead) return;
        setMine(d);
        teacherOk = true;
      } catch (e) { teacherErr = ECHO_msg(e); }

      let ac = null, adminErr = '';
      try {
        const d = await ECHO_api.campaigns();
        ac = Array.isArray(d) ? d : [];
      } catch (e) { adminErr = ECHO_msg(e); }
      if (dead) return;

      setAdminCamps(ac);
      // A SORREND SZÁNDÉKOS: aki oktató IS meg admin IS, alapból a sajátját látja.
      setMode(teacherOk ? 'oktato' : 'admin');
      // Ha EGYIK út sem járható, a SZERVER saját mondatát mutatjuk meg —
      // abból derül ki, mi hiányzik (kötés, grant, vagy admin jog).
      if (!teacherOk && ac === null) setListErr(adminErr || teacherErr);
    })();
    return () => { dead = true; };
  }, []);

  // A kampánylista a módból következik. Az oktatói válaszból ugyanolyan alakú
  // lista lesz, mint amilyet az echo_campaigns() ad — így alatta MINDEN
  // kirajzoló ág változatlan marad.
  useEffect(() => {
    if (mode === null) return;
    const arr = mode === 'oktato'
      ? (((mine && mine.kampanyok) || []).map(c => ({
          id: c.id, code: c.code, ref_no: c.ref_no, name: c.name, term: c.term, state: c.state,
          opens_at: c.opens_at, closes_at: c.closes_at,
          eredmeny_lathato: c.eredmeny_lathato, eredmeny_allapotok: c.eredmeny_allapotok,
        })))
      : (adminCamps || []);
    setCamps(arr);
    setCid(arr[0] ? arr[0].id : '');
  }, [mode, mine, adminCamps]);

  // A kurzuslista. Oktatói módban NINCS külön hívás: a kurzusok már benne
  // vannak a myTeacherCourses() válaszában, és a mezőnevek szándékosan
  // egyeznek az echo_rate().kurzusonkent alakjával (course_id / course_code /
  // course_name / eligible / attempted / valaszok).
  useEffect(() => {
    if (!cid) { setRate(null); return; }
    setCres(null); setTres(null); setGate(''); setErr('');

    if (mode === 'oktato') {
      const c = ((mine && mine.kampanyok) || []).find(x => x.id === cid);
      const ks = (c && c.kurzusok) || [];
      setRate({ kurzusonkent: ks });
      setCourseId(ks[0] ? ks[0].course_id : '');
      return;
    }

    let dead = false;
    setCourseId('');
    ECHO_api.rate(cid)
      .then(d => {
        if (dead) return;
        setRate(d);
        const ks = (d && d.kurzusonkent) || [];
        if (ks[0]) setCourseId(ks[0].course_id);
      })
      .catch(e => { if (!dead) { setRate(null); setListErr(ECHO_msg(e)); } });
    return () => { dead = true; };
  }, [cid, mode, mine]);

  useEffect(() => {
    if (!cid || !courseId) { setCres(null); setTres(null); return; }
    let dead = false;
    setBusy(true); setErr(''); setGate('');
    Promise.all([
      ECHO_api.courseResults(cid, courseId).catch(e => ({ __err: e })),
      ECHO_api.teacherResults(cid, courseId, null).catch(e => ({ __err: e })),
    ]).then(([c, t]) => {
      if (dead) return;
      const bad = (c && c.__err) || (t && t.__err);
      if (bad) {
        const raw = (bad.message || '') + '';
        if (raw.indexOf('ECHO_RESULTS_NOT_READY') >= 0) { setGate(ECHO_msg(bad)); }
        else setErr(ECHO_msg(bad));
      }
      setCres(c && c.__err ? null : c);
      setTres(t && t.__err ? null : t);
    }).finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [cid, courseId]);

  // ADMIN NYERS NEZET es RELEVANCIA-SZURO (56_admin_results_control.sql)
  const [nyers, setNyers]       = useState(null);   // a szuretlen eredmeny
  const [nyersBusy, setNyersBusy] = useState(false);
  const [nyersErr, setNyersErr] = useState('');
  const [szuroBusy, setSzuroBusy] = useState(false);
  const [szuro, setSzuro] = useState(null);   // { low_attendance_included, zarolt }

  // A szuro aktualis erteke kampanyvaltaskor. Csak adminnak — az RPC ugyis
  // elutasitana mast, es feleslegesen hibat irnank a kepernyore.
  useEffect(() => {
    if (mode !== 'admin' || !cid) { setSzuro(null); return; }
    let el = true;
    ECHO_api.filtersGet(cid)
      .then(r => { if (el) setSzuro(r); })
      .catch(() => { if (el) setSzuro(null); });
    return () => { el = false; };
  }, [mode, cid]);

    const camp = (camps || []).find(c => c.id === cid) || null;
  const courses = (rate && rate.kurzusonkent) || [];
  const course = courses.find(k => k.course_id === courseId) || null;
  const campState = camp ? (ECHO_CAMPAIGN_STATE[camp.state] || { label: camp.state, tone: 'slate' }) : null;

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">Oktatói eredmények</h1>
          <p className="text-sm text-slate-400 font-medium mt-1">
            Kérdésenkénti visszacsatolás · k-anonimitási küszöbökkel · 28/2023. szenátusi határozat
          </p>
        </div>
        {/* A MÓDVÁLTÓ csak akkor jelenik meg, ha a fiók MINDKÉT úton járhat.
            Egy csak-oktató fiók nem lát admin gombot, ami úgysem működne. */}
        {mode === 'oktato' && adminCamps !== null && (
          <button onClick={() => { setMode('admin'); setCid(''); setListErr(''); }}
            className={U_btnGhost + ' py-2.5 px-4 text-sm'}>
            <Lucide.Building2 size={15} /> Intézményi nézet
          </button>
        )}
        {mode === 'admin' && mine && (
          <button onClick={() => { setMode('oktato'); setCid(''); setListErr(''); }}
            className={U_btnGhost + ' py-2.5 px-4 text-sm'}>
            <Lucide.UserCog size={15} /> Saját kurzusaim
          </button>
        )}
      </div>

      {/* KI VAGYOK ÉN A RENDSZER SZERINT — ezt az oktató nem találgatja ki.
          A név az echo.teacher sorból jön, nem a UniPortal-profilból: ha a
          kettő nem ugyanaz az ember, itt derül ki, nem az eredménynél. */}
      {mode === 'oktato' && mine && (
        <div className="mb-6 bg-slate-900 text-white rounded-2xl px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Lucide.UserCheck size={16} className="flex-none text-emerald-400" />
          <p className="text-sm font-black">{mine.teacher_name || '(névtelen oktatói sor)'}</p>
          <span className="text-[11px] font-bold text-slate-400">
            saját kurzusok · a listában CSAK azok a kurzusok szerepelnek, amelyekre
            az alkalmassági motor felvett (echo.eligibility)
          </span>
        </div>
      )}

      {listErr && (
        <div className="mb-6 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 flex gap-2.5">
          <Lucide.AlertTriangle size={16} className="flex-none mt-0.5 text-amber-600" />
          <div>
            <p className="text-sm font-bold text-amber-700">{listErr}</p>
            <p className="text-[11px] text-amber-700/80 font-medium mt-1 leading-relaxed">
              Két út vezet ide, és egyik sem járható ezzel a fiókkal. OKTATÓKÉNT a
              public.echo_my_teacher_courses() ad kurzuslistát — ehhez az echo.teacher
              sorodhoz kötött fiók ÉS élő 'OKTATO' grant kell (19_echo_roles.sql; a kötést
              az ECHO kampányok → Szerepkörök fülön lehet létrehozni). INTÉZMÉNYI nézethez
              az echo_campaigns() és az echo_rate() kell, és MINDKETTŐ törzse
              public.is_admin()-t követel — ADMISSIONS / FINANCE fiókkal ezért marad üresen.
            </p>
          </div>
        </div>
      )}

      {camps === null ? (
        <div className="space-y-3"><SkeletonBar w="50%" h={16} /><SkeletonBar /><SkeletonBar w="80%" /></div>
      ) : camps.length === 0 && !listErr ? (
        <UEmpty icon={<Lucide.BarChart2 size={28} />}
          title={mode === 'oktato' ? 'Egyetlen kampányban sincs kurzusod' : 'Nincs kampány'}
          subtitle={mode === 'oktato'
            ? 'A kötés és a grant rendben van (a szerver nem utasított el), de az alkalmassági motor egyetlen kampányban sem vett fel oktatóként. Ez akkor is így van, ha a kurzus kevés hallgatós, vizsgakurzus, vagy a részesedésed a küszöb alatt van (echo.exclusion_rule).'
            : undefined} />
      ) : camps.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 p-5 mb-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <UField label="Kampány">
              <select className={U_input} value={cid} onChange={e => setCid(e.target.value)}>
                {camps.map(c => <option key={c.id} value={c.id}>{ECHO_kampanyAzon(c.ref_no, c.code)} — {c.name}</option>)}
              </select>
            </UField>
            <UField label="Kurzus" hint={courses.length === 0 ? 'Ehhez a kampányhoz nincs véleményezhető kurzus.' : ''}>
              <select className={U_input} value={courseId} onChange={e => setCourseId(e.target.value)} disabled={courses.length === 0}>
                {courses.map(k => <option key={k.course_id} value={k.course_id}>{k.course_code} — {k.course_name}</option>)}
              </select>
            </UField>
          </div>
          {camp && (
            <div className="flex flex-wrap items-center gap-2 mt-4">
              <UBadge tone={campState.tone}>{campState.label}</UBadge>
              <span className="text-[11px] font-bold text-slate-400">
                {ECHO_date(camp.opens_at)} — {ECHO_date(camp.closes_at)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* AZ ARÁNY MINDIG LÁTSZIK — akkor is, amikor az eredmény nem. */}
      {course && (
        <div className="bg-white rounded-3xl border border-slate-100 p-5 sm:p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Lucide.Gauge size={16} className="text-slate-400" />
            <h3 className="font-black text-slate-900 text-sm">Válaszadási arány</h3>
          </div>
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-4xl font-black text-slate-900">
              {course.eligible > 0 ? ((course.valaszok / course.eligible) * 100).toFixed(1) : '0.0'}%
            </span>
            <span className="text-xs font-black text-slate-400 uppercase tracking-wider">
              {course.valaszok} / {course.eligible} · elkezdte {course.attempted}
            </span>
          </div>
          <ECHO_Meter value={course.valaszok} max={course.eligible} />
        </div>
      )}

      {/* A NYITOTT KAMPÁNY ALATT NINCS EREDMÉNY — ezt a felület kimondja. */}
      {gate && (
        <div className="bg-slate-900 text-white rounded-3xl p-5 sm:p-6 mb-6">
          <div className="flex items-start gap-3">
            <Lucide.Lock size={18} className="flex-none mt-0.5 text-slate-400" />
            <div>
              <h3 className="font-black">Eredmény most nem látszik — csak az arány</h3>
              <p className="text-sm text-slate-300 font-medium mt-2 leading-relaxed">{gate}</p>
              <p className="text-[11px] text-slate-400 font-medium mt-3 leading-relaxed">
                Ez szándékos: a nyitott kitöltési ablak alatt látható átlag visszahatna a még
                kitöltetlen kérdőívekre. A kaput az echo.results_gate() zárja, a küszöbök
                (echo.setting) fölött. Az arány közben végig látszik, mert abból egyetlen
                kitöltő válasza sem olvasható ki.
              </p>
            </div>
          </div>
        </div>
      )}

      {err && (
        <div className="mb-6 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {busy && <div className="space-y-3 mb-6"><SkeletonBar w="40%" h={16} /><SkeletonBar /><SkeletonBar w="70%" /></div>}

      {/* ADMINISZTRÁTORI VEZÉRLŐ — csak adminnak, és csak ha van kiválasztott kurzus.
          Két dolgot ad: (a) a relevancia-szűrőt, ami azt dönti el, mi kerül az
          OKTATÓ elé, és (b) a nyers nézetet, ami küszöb nélkül mindent megmutat. */}
      {mode === 'admin' && cid && courseId && (
        <div className="mb-6 rounded-3xl border border-primary/20 bg-primary/[0.03] p-5">
          <div className="flex items-start gap-2.5 mb-4">
            <Lucide.ShieldCheck size={18} className="text-primary flex-none mt-0.5" />
            <div>
              <h3 className="font-black text-slate-900 text-[15px]">Adminisztrátori nézet</h3>
              <p className="text-[12px] text-slate-500 mt-0.5 max-w-2xl">
                A küszöbök az OKTATÓ felé védik a hallgatók névtelenségét. Adminisztrátorként
                megnézheted a teljes, szűretlen eredményt, és te döntöd el, milyen szűréssel
                kerüljön az oktató elé.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                setNyersBusy(true); setNyersErr('');
                ECHO_api.resultsRaw(cid, courseId, 'course', null)
                  .then(r => setNyers(r))
                  .catch(e => setNyersErr(ECHO_msg(e)))
                  .finally(() => setNyersBusy(false));
              }}
              disabled={nyersBusy}
              className={U_btnPrimary + ' py-2.5 px-4 text-sm'}>
              <Lucide.Eye size={15} /> {nyersBusy ? 'Betöltés…' : 'Teljes, szűretlen eredmény'}
            </button>

            {nyers && (
              <button onClick={() => setNyers(null)} className={U_btnGhost + ' py-2.5 px-4 text-sm'}>
                <Lucide.EyeOff size={15} /> Bezárás
              </button>
            )}

            {/* A relevancia-szűrő. Lepecsételt kampányon a szerver elutasítja —
                ilyenkor meg sem kínáljuk, hanem megmondjuk, miért. */}
            {szuro && szuro.zarolt ? (
              <span className="text-[12px] text-slate-400">
                A kampány le van pecsételve — a szűrés már nem módosítható.
              </span>
            ) : (
              <label className="flex items-center gap-2 text-[13px] font-bold text-slate-600 cursor-pointer">
                <input type="checkbox" disabled={szuroBusy}
                  checked={!!(szuro && szuro.low_attendance_included)}
                  onChange={(e) => {
                    setSzuroBusy(true);
                    ECHO_api.filtersSet(cid, e.target.checked)
                      .then(r => {
                        setSzuro(p => ({ ...(p || {}), low_attendance_included: !!r.low_attendance_included }));
                        // Az eredmenyt ujra kell kerni: a szuro megvaltoztatta,
                        // mi szamit bele — kulonben a regi szamokat mutatnank.
                        setCres(null); setTres(null); setNyers(null);
                        setBusy(true);
                        Promise.all([
                          ECHO_api.courseResults(cid, courseId).catch(() => null),
                          ECHO_api.teacherResults(cid, courseId, null).catch(() => null),
                        ]).then(([c, t]) => { setCres(c); setTres(t); }).finally(() => setBusy(false));
                      })
                      .catch(err => setNyersErr(ECHO_msg(err)))
                      .finally(() => setSzuroBusy(false));
                  }} />
                A 33% alatti óralátogatású válaszok is számítsanak bele
              </label>
            )}
          </div>

          {nyersErr && (
            <div className="mt-3 text-[13px] font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
              {nyersErr}
            </div>
          )}

          {nyers && <ECHO_RawResults nyers={nyers} lang={lang} />}
        </div>
      )}

      {!busy && cres && (
        <div className="space-y-6">
          <ECHO_ResultBlock
            r={cres} lang={lang} ikon="BookOpen"
            cim={'Kurzusszintű eredmény — ' + (cres.course_name || '')} />

          {/* Kivitel — 34_echo_export.sql. A szerver ugyanazt a
              results_build() utat járja, mint a fenti blokk, tehát amit
              itt nem látsz, azt az állomány sem tartalmazza. */}
          <div className="bg-white border border-slate-100 rounded-2xl px-4 py-3">
            <ECHO_ExportButton
              campaign={cid} course={courseId} teacher={null} scope="course"
              cimke="Kurzusszintű eredmény kivitele" />
          </div>

          {/* 7 napos oktatói észrevétel — 35_echo_comment.sql, 6. § (7).
              A panel magát rejti el, ha a fiók nem oktatói sorhoz kötött. */}
          <ECHO_CommentPanel campaign={cid} />

          {/* A 33% ALATTI ÓRALÁTOGATÁSÚ VÁLASZOK — KÜLÖN BLOKK, jelöléssel.
              3. § (9): ezek nem számítanak a jegyzőkönyvi statisztikába. Saját
              küszöbük van (k_low), és szöveget innen a szerver SOHA nem ad vissza. */}
          {cres.alacsony_oralatogatas && (
            (!cres.alacsony_oralatogatas.rejtve && (cres.alacsony_oralatogatas.kerdesek || []).length > 0) ? (
              <ECHO_ResultBlock
                r={Object.assign({}, cres.alacsony_oralatogatas, { kuszobok: cres.kuszobok })}
                lang={lang} ikon="Info" tajekoztato
                cim={'33% alatti óralátogatás — ' + cres.alacsony_oralatogatas.n + ' válasz'} />
            ) : (
              <div className="bg-amber-50/40 border border-amber-100 rounded-3xl p-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <Lucide.Info size={16} className="text-amber-500" />
                    <h3 className="font-black text-slate-900 text-sm">
                      33% alatti óralátogatás — {cres.alacsony_oralatogatas.n || 0} válasz
                    </h3>
                  </div>
                  <UBadge tone="amber"><Lucide.EyeOff size={10} /> nem jelenik meg</UBadge>
                </div>
                <p className="text-[11px] text-amber-800 font-black mb-1.5">
                  {Number(cres.alacsony_oralatogatas.n || 0) === 0
                    ? 'Ebben a blokkban nincs válasz.'
                    : 'Még ' + Math.max(0, Number(cres.alacsony_oralatogatas.k_low || 0) - Number(cres.alacsony_oralatogatas.n || 0)) +
                      ' válasz kellene (k_low=' + cres.alacsony_oralatogatas.k_low + '), hogy ez a blokk megjelenjen.'}
                </p>
                <p className="text-[11px] text-amber-800/80 font-medium leading-relaxed">
                  <ECHO_Src>{cres.alacsony_oralatogatas.megjegyzes || ''}</ECHO_Src>
                </p>
              </div>
            )
          )}

          {tres && Array.isArray(tres.oktatok) && tres.oktatok.map((o, i) => (
            <div key={o.teacher_id || i}>
              <ECHO_ResultBlock r={o} lang={lang} ikon="UserCog"
                cim={'Oktatói bontás — ' + (o.teacher_name || o.teacher_id)} />
              {/* Az oktatói bontásban az óralátogatási blokk MINDIG üres — nem
                  hiba, hanem két követelmény ütközése. A szerver saját szavaival. */}
              {o.alacsony_oralatogatas && (
                <div className="mt-2 bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5">
                  <Lucide.Info size={14} className="text-slate-400 flex-none mt-0.5" />
                  <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
                    <ECHO_Src>{o.alacsony_oralatogatas.megjegyzes || ''}</ECHO_Src>
                  </p>
                </div>
              )}
            </div>
          ))}

          {tres && Array.isArray(tres.oktatok) && tres.oktatok.length === 0 && (
            <div className="bg-white rounded-3xl border border-slate-100 p-5">
              <p className="text-sm font-bold text-slate-500">
                Ehhez a kurzushoz nincs oktatói bontás (az echo.course_teacher táblában nincs sor).
              </p>
            </div>
          )}
        </div>
      )}

      {/* Ami a naplóból következik — kimondva. */}
      {cres && (
        <div className="mt-6 bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5">
          <Lucide.Info size={15} className="text-slate-400 flex-none mt-0.5" />
          <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
            Minden itt megjelenített bontás EGY sort ír az echo.access_log-ba (6. § (4)) —
            akkor is, ha a bontás elrejtve tér vissza. A napló semmilyen válasz-tartalmat és
            elemszámot nem tárol, különben maga lenne a második csatorna. A megtagadott hívás
            viszont NEM naplózódik: a tranzakció visszagördül, és vele a naplósor is.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   11. ECHO_ModerationView — moderálási sor (MIR / admin)
   ------------------------------------------------------------
   A SZÖVEG NEM TÖRLŐDIK. Az 'invalid' annyit tesz, hogy a szöveg kikerül a
   visszacsatolásból (az echo.results_build csak 'valid' sorokat olvas) — az
   eredeti az echo.response.answers-ben marad, hogy a döntés felülvizsgálható
   legyen. A felület ezt kimondja, mert a moderátor különben törlésnek hinné.
   ------------------------------------------------------------ */

function ECHO_ModerationView({ user }) {
  const [camps, setCamps] = useState(null);
  const [cid, setCid] = useState('');
  const [queue, setQueue] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [done, setDone] = useState(0);
  const [rej, setRej] = useState(null);      // { item } — az elutasító párbeszéd
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const lang = ECHO_lang();

  useEffect(() => {
    let dead = false;
    ECHO_api.campaigns()
      .then(d => { if (dead) return; const a = Array.isArray(d) ? d : []; setCamps(a); if (a[0]) setCid(a[0].id); })
      .catch(e => { if (!dead) { setCamps([]); setErr(ECHO_msg(e)); } });
    return () => { dead = true; };
  }, []);

  const load = async (id) => {
    if (!id) return;
    setBusy(true); setErr('');
    try { setQueue(await ECHO_api.moderationQueue(id)); }
    catch (e) { setQueue(null); setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (cid) load(cid); }, [cid]);

  const decide = async (item, allapot, indok, megjegyzes) => {
    setBusy(true); setErr('');
    try {
      await ECHO_api.moderate(item.response_id, item.question_id, allapot, indok, megjegyzes);
      setQueue(q => q ? Object.assign({}, q, {
        tetelek: (q.tetelek || []).filter(x => !(x.response_id === item.response_id && x.question_id === item.question_id)),
        varakozik: Math.max(0, Number(q.varakozik || 0) - 1),
      }) : q);
      setDone(d => d + 1);
      setToast(allapot === 'valid' ? 'Érvényesnek jelölve.' : 'Érvénytelennek jelölve — a szöveg megmarad.');
      setRej(null); setReason(''); setNote('');
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  const items = (queue && queue.tetelek) || [];
  const okok = (queue && queue.okok) || [];

  return (
    <div>
      <UToast msg={toast} onDone={() => setToast('')} />

      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="min-w-[240px]">
          <UField label="Kampány">
            <select className={U_input} value={cid} onChange={e => setCid(e.target.value)}>
              {(camps || []).map(c => <option key={c.id} value={c.id}>{ECHO_kampanyAzon(c.ref_no, c.code)} — {c.name}</option>)}
            </select>
          </UField>
        </div>
        <button onClick={() => load(cid)} disabled={busy} className={U_btnGhost + ' py-3'}>
          {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.RefreshCw size={16} />}
          Sor frissítése
        </button>
      </div>

      {err && (
        <div className="mb-6 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {queue && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { k: 'Várakozik', v: queue.varakozik, i: 'Flag' },
            { k: 'Új sor most', v: queue.uj_sorok, i: 'Plus' },
            { k: 'Elintézve most', v: done, i: 'CheckCircle2' },
            { k: 'Indok-katalógus', v: okok.length, i: 'ListChecks' },
          ].map(x => {
            const Ic = Lucide[x.i] || Lucide.Circle;
            return (
              <div key={x.k} className="bg-slate-50 rounded-2xl p-4">
                <Ic size={16} className="text-slate-400 mb-2" />
                <p className="text-xl font-black text-slate-900">{x.v}</p>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mt-0.5">{x.k}</p>
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5 mb-6">
        <Lucide.Info size={15} className="text-slate-400 flex-none mt-0.5" />
        <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
          A sor sorrendje md5(response_id ‖ question_id) szerinti, NEM beérkezési sorrend —
          különben ez a képernyő adná vissza azt az érkezési sorrendet, amit az adatmodell
          szándékosan lebontott. Az oktató neve nem látszik: a moderálásnak nem kell tudnia,
          kiről szól a szöveg. Az „érvénytelen” döntés a szöveget NEM törli, csak kiveszi a
          visszacsatolásból, indokkal és moderátor-azonosítóval (echo.moderation).
        </p>
      </div>

      {busy && !queue && <div className="space-y-3"><SkeletonBar /><SkeletonBar w="80%" /><SkeletonBar w="60%" /></div>}

      {queue && items.length === 0 && (
        <UEmpty icon={<Lucide.CheckCircle2 size={28} />} title="A moderálási sor üres"
          subtitle="Ebben a kampányban most nincs moderálásra váró szöveges válasz." />
      )}

      <div className="space-y-3">
        {items.map(it => (
          <div key={it.response_id + '|' + it.question_id} className="bg-white rounded-3xl border border-slate-100 p-5">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <UBadge tone="slate"><Lucide.BookOpen size={10} /> <ECHO_Src>{it.course_name}</ECHO_Src></UBadge>
              <UBadge tone={it.scope === 'teacher' ? 'violet' : 'blue'}>{it.scope === 'teacher' ? 'oktatói' : 'kurzusszintű'}</UBadge>
            </div>
            <p className="text-xs font-black text-slate-400 uppercase tracking-wider mb-2">
              <ECHO_Src>{ECHO_txt({ hu: it.kerdes_hu, en: it.kerdes_en }, lang) || it.question_id}</ECHO_Src>
            </p>
            <div className="bg-slate-50 rounded-2xl px-4 py-3 text-sm text-slate-800 font-medium leading-relaxed mb-4 whitespace-pre-wrap">
              <ECHO_Src>{it.szoveg || ''}</ECHO_Src>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => decide(it, 'valid', null, null)} disabled={busy}
                className={U_btnGhost + ' py-2.5 px-4 text-sm text-emerald-700 bg-emerald-50 hover:bg-emerald-100'}>
                <Lucide.CheckCircle2 size={15} /> Érvényes
              </button>
              <button onClick={() => { setRej(it); setReason(okok[0] ? okok[0].code : ''); setNote(''); }} disabled={busy}
                className={U_btnGhost + ' py-2.5 px-4 text-sm text-red-600 bg-red-50 hover:bg-red-100'}>
                <Lucide.XCircle size={15} /> Érvénytelen
              </button>
            </div>
          </div>
        ))}
      </div>

      <UModal open={!!rej} onClose={() => setRej(null)} max="max-w-lg"
        icon={<Lucide.XCircle size={20} />} title="Érvénytelenné nyilvánítás"
        subtitle="Indok nélkül a szerver elutasítja (ECHO_REASON_REQUIRED)">
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3">
            <p className="text-[11px] text-amber-800 font-medium leading-relaxed">
              A szöveg NEM törlődik. Kikerül a visszacsatolásból, de az eredeti megmarad az
              echo.response.answers-ben — enélkül utólag nem lehetne eldönteni, jogos volt-e a
              döntés. A döntés naplózódik: ki, mikor, milyen indokkal.
            </p>
          </div>
          <UField label="Indok (3. § (10))">
            <select className={U_input} value={reason} onChange={e => setReason(e.target.value)}>
              {okok.map(o => (
                <option key={o.code} value={o.code}>
                  {ECHO_txt({ hu: o.name_hu, en: o.name_en }, lang)}{o.paragraph ? ' — ' + o.paragraph : ''}
                </option>
              ))}
            </select>
          </UField>
          <UField label="Megjegyzés (nem kötelező)" hint="Audit-nyom: a döntés indoklása emberi szavakkal.">
            <textarea className={U_input + ' min-h-[90px] resize-y'} value={note} onChange={e => setNote(e.target.value)} />
          </UField>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setRej(null)} className={U_btnGhost}>Mégsem</button>
            <button disabled={!reason || busy} onClick={() => decide(rej, 'invalid', reason, note)}
              className={U_btnPrimary}>
              {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.XCircle size={16} />}
              Érvénytelen
            </button>
          </div>
        </div>
      </UModal>
    </div>
  );
}

/* ------------------------------------------------------------
   12. ECHO_Editor — kérdőívszerkesztő
   ------------------------------------------------------------
   A prototípus legmélyebb modulja. A MUNKAMEGOSZTÁS (16_echo_reports.sql
   7. szakasz): a szerver vállalja a klónozást ÚJ kérdés-ID-kkal, a mentés
   draft-hoz kötését, a SZÁMÍTOTT élesítés-előtti ellenőrzéseket és az
   állapotgépet (triggerrel is védve). A kliens csinálja a szerkesztő
   felületet, az élő előnézetet és az opció-átrendezést.

   Az ellenőrző lista SOHA nem itt keletkezik: az echo_template_validate()
   adja, és mentés után frissül. Ha a kliens számolná, a felület és a
   szerver külön véleményen lehetne arról, mi élesíthető.
   ------------------------------------------------------------ */

const ECHO_TPL_STATE = {
  draft:    { label: 'Piszkozat',    tone: 'slate',   icon: 'Pencil' },
  review:   { label: 'Véleményezés', tone: 'blue',    icon: 'MessageSquare' },
  approved: { label: 'Jóváhagyva',   tone: 'violet',  icon: 'CheckCircle2' },
  live:     { label: 'Élesítve',     tone: 'green',   icon: 'Rocket' },
  closed:   { label: 'Archív',       tone: 'amber',   icon: 'Lock' },
};

/* A megengedett átmenetek — betű szerint az echo.template_version_freeze()
   triggerből (16_echo_reports.sql 7.3). Ha itt több lenne, a gomb csak
   szerverhibát tudna előállítani. */
const ECHO_TPL_NEXT = {
  draft:    [{ to: 'review',   label: 'Véleményezésre',   icon: 'ArrowRight' },
             { to: 'closed',   label: 'Archiválás',       icon: 'Ban' }],
  review:   [{ to: 'approved', label: 'Jóváhagyás',       icon: 'CheckCircle2' },
             { to: 'draft',    label: 'Vissza javításra', icon: 'Undo2' },
             { to: 'closed',   label: 'Archiválás',       icon: 'Ban' }],
  approved: [{ to: 'live',     label: 'Élesítés',         icon: 'Rocket', clean: true },
             { to: 'review',   label: 'Újranyitás',       icon: 'Undo2' },
             { to: 'closed',   label: 'Archiválás',       icon: 'Ban' }],
  live:     [{ to: 'closed',   label: 'Lezárás',          icon: 'Lock' }],
  closed:   [],
};

// A szerkeszthető kérdéstípusok. CSAK az az öt, amit az ECHO_Question ki is
// tud rajzolni — egy hatodik felvétele itt a kitöltőben "Ismeretlen
// kérdéstípus" dobozt eredményezne, azaz a szerkesztő olyat ígérne, amit a
// hallgató nem lát.
const ECHO_QTYPES = [
  { v: 'single',   label: 'Egyválasztós',  icon: 'Circle',   hint: 'Egy opció választható.' },
  { v: 'multi',    label: 'Többválasztós', icon: 'ListChecks', hint: 'Több opció; a max korlátoz.' },
  { v: 'scale',    label: 'Skála',         icon: 'SlidersHorizontal', hint: 'Számskála min/max felirattal.' },
  { v: 'longtext', label: 'Szöveges',      icon: 'Type',     hint: 'Szabad szöveg — moderálásra kerül.' },
  { v: 'skip',     label: 'Kihagyás-kapu', icon: 'CornerDownRight', hint: 'Nem kérdés, hanem kapu: „nem tudom értékelni”.' },
];

const ECHO_REPEATS = [
  { v: '',        label: 'Nincs (egyszer)' },
  { v: 'teacher', label: 'Oktatónként' },
  { v: 'goal',    label: 'Célonként' },
  { v: 'teacher_goal', label: 'Oktatónként és célonként' },
];

// A cond-ban használható KÖRNYEZETI kulcsok. Az echo.setting
// 'cond_context_keys' sorából mérve: has_goals, attendance_band, lang.
const ECHO_COND_CTX = ['has_goals', 'attendance_band', 'lang'];
const ECHO_COND_CTX_CIMKE = { has_goals: 'Célkitűzés megadása', attendance_band: 'Óralátogatási sáv', lang: 'Kitöltés nyelve' };
// Előre adott értékek a környezeti kulcsokhoz, mondatba illeszthető címkével.
const ECHO_COND_CTX_ERTEK = {
  has_goals: [{ k: 'true', v: true, cimke: 'megadott célkitűzést' }, { k: 'false', v: false, cimke: 'nem adott meg célkitűzést' }],
  lang: [{ k: 's:hu', v: 'hu', cimke: 'magyarul tölti ki' }, { k: 's:en', v: 'en', cimke: 'angolul tölti ki' }],
};
function ECHO_rovid(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/* ELŐNÉZETI KÖRNYEZET. A kérdőívszövegek helykitöltőket tartalmazhatnak, amiket
   a kitöltéskor a konkrét oktató/kurzus neve tölt ki. Az előnézetben minta
   értéket teszünk a helyükre, hogy a szerkesztő azt lássa, amit a hallgató.

   A BEHELYETTESÍTÉS MAGA NEM ITT VAN: az ECHO_tokenMap/ECHO_resolveTokens
   (2/c. szakasz) végzi, ugyanaz a kód, amit a kitöltő is használ. Itt csak a
   MINTAÉRTÉKEK állnak. Így a szerkesztő előnézete és a valódi kitöltés nem
   csúszhat szét: ha a feloldás megváltozik, mindkettő együtt változik.
   (Korábban két külön út volt, és a kitöltő NEM oldotta fel a tokeneket —
   a hallgató szó szerint a "[Oktató neve] erősségei" feliratot látta.) */
const ECHO_PREVIEW_CTX = {
  teacher: { name: 'Dr. Példa Anna' },
  course:  { name: 'Bevezetés a szoftverfejlesztésbe',
             name_en: 'Introduction to Software Engineering' },
  goal:    { text: 'a félév eleji célod' },
};
// A felületen kiírt minta ("pl. [Oktató neve] → …") ebből olvas.
const ECHO_TOKENS = ECHO_tokenMap(ECHO_PREVIEW_CTX);
function ECHO_tok(s) { return ECHO_applyTokens(s, ECHO_TOKENS); }

// Egy szerkesztett kérdés ELŐNÉZETI alakja: a help {hu,en} párja feloldva
// (az ECHO_Question sztringet vár, objektumot nem tudna kirajzolni).
// A tokenfeloldást az ECHO_Question végzi a ctx-ből — lásd ECHO_QPreview.
function ECHO_previewQuestion(q, lang) {
  const help = (q.help && typeof q.help === 'object') ? ECHO_txt(q.help, lang) : (q.help || '');
  return Object.assign({}, q, { help: help });
}

const ECHO_clone = (o) => JSON.parse(JSON.stringify(o));
function ECHO_uid(n) {
  let s = '';
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < (n || 8); i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
// Az opciók kétféle alakja ("szöveg" vagy {value,hu,en}) — a szerkesztő
// mindig objektummá normalizál, a `value` VÁLTOZATLAN megtartásával.
// Ez fontos: a beküldött érték a value, tehát ha az elmozdulna, a korábbi
// verziók válaszai más kulcsra mutatnának, mint az újak.
function ECHO_normOpts(list) {
  return (Array.isArray(list) ? list : []).map((o, i) => (
    (o && typeof o === 'object')
      ? { value: o.value != null ? o.value : (o.hu || String(i)), hu: o.hu || '', en: o.en || '' }
      : { value: String(o), hu: String(o), en: '' }
  ));
}
const ECHO_asArr = (a) => (Array.isArray(a) ? a : (a == null || a === '' ? [] : [a]));

// Az érték-mező parse-olása a megjelenítési feltételhez.
function ECHO_parseVal(s) {
  const t = String(s == null ? '' : s).trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/* ---- törlés megerősítéssel ----
   A törlés egy kattintásra azonnal megtörtént (a szakasznál a böngésző natív
   ablaka kérdezett). Most a gomb mellett nyíló kis kérdés erősíti meg; Escape
   vagy mellékattintás bezárja. */
function ECHO_TorlesGomb({ onTorol, cim, kerdes, meret, osztaly }) {
  const [nyit, setNyit] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!nyit) return;
    const kint = (e) => { if (ref.current && !ref.current.contains(e.target)) setNyit(false); };
    const esc = (e) => { if (e.key === 'Escape') setNyit(false); };
    document.addEventListener('mousedown', kint); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', kint); document.removeEventListener('keydown', esc); };
  }, [nyit]);
  return (
    <span className="relative inline-flex" ref={ref}>
      <button type="button" title={cim} aria-label={cim} aria-expanded={nyit} className={osztaly}
        onClick={(e) => { e.stopPropagation(); setNyit(v => !v); }}>
        <Lucide.Trash2 size={meret || 13} />
      </button>
      {nyit && (
        <div role="dialog" aria-label={cim} onClick={e => e.stopPropagation()} data-echo-torles-megerosites="1"
          className="absolute right-0 top-full mt-1.5 z-30 w-64 bg-white border border-slate-200 rounded-2xl shadow-xl p-3 text-left">
          <p className="text-xs font-bold text-slate-700 leading-snug">{kerdes || 'Biztosan törlöd?'}</p>
          <div className="flex justify-end gap-2 mt-3">
            <button type="button" onClick={() => setNyit(false)} className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-slate-500 hover:bg-slate-100">Mégse</button>
            <button type="button" autoFocus onClick={() => { setNyit(false); onTorol(); }}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-red-600 text-white hover:bg-red-700">Törlés</button>
          </div>
        </div>
      )}
    </span>
  );
}

/* ---- opció-szerkesztő ---- */
function ECHO_OptionEditor({ q, ro, onChange }) {
  const opts = ECHO_normOpts(q.options);
  const set = (arr) => onChange(arr);
  const move = (i, d) => {
    const j = i + d; if (j < 0 || j >= opts.length) return;
    const a = opts.slice(); const t = a[i]; a[i] = a[j]; a[j] = t; set(a);
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Válaszopciók ({opts.length})</span>
        {!ro && (
          <button onClick={() => set(opts.concat([{ value: 'opt_' + ECHO_uid(5), hu: '', en: '' }]))}
            className="text-[11px] font-black text-primary hover:underline flex items-center gap-1">
            <Lucide.Plus size={12} /> Opció
          </button>
        )}
      </div>
      {opts.length === 0 && (
        <p className="text-[11px] text-slate-400 font-bold mb-2">Nincs opció — választós kérdésnél ez ellenőrzési hiba.</p>
      )}
      <div className="space-y-2">
        {opts.map((o, i) => (
          <div key={i} className="border border-slate-100 rounded-2xl p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-[10px] font-black text-slate-300 w-5">{i + 1}.</span>
              <input className={U_input + ' py-1.5 text-xs font-mono'} value={o.value} disabled={ro}
                onChange={e => { const a = opts.slice(); a[i] = Object.assign({}, o, { value: e.target.value }); set(a); }}
                placeholder="tárolt érték (value)" />
              {!ro && (
                <>
                  <button onClick={() => move(i, -1)} className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center flex-none"><Lucide.ChevronUp size={14} /></button>
                  <button onClick={() => move(i, 1)} className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center flex-none"><Lucide.ChevronDown size={14} /></button>
                  <ECHO_TorlesGomb onTorol={() => set(opts.filter((_, k) => k !== i))} cim="Opció törlése" kerdes="Törlöd ezt a válaszopciót?" meret={14} osztaly="w-7 h-7 rounded-lg hover:bg-red-50 text-red-400 flex items-center justify-center flex-none" />
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input className={U_input + ' py-1.5 text-xs'} value={o.hu} disabled={ro} placeholder="magyar"
                onChange={e => { const a = opts.slice(); a[i] = Object.assign({}, o, { hu: e.target.value }); set(a); }} />
              <input className={U_input + ' py-1.5 text-xs ' + (o.en ? '' : 'border-amber-200 bg-amber-50/50')} value={o.en} disabled={ro} placeholder="angol (kötelező az élesítéshez)"
                onChange={e => { const a = opts.slice(); a[i] = Object.assign({}, o, { en: e.target.value }); set(a); }} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-slate-400 font-medium mt-2 leading-relaxed">
        A tárolt érték (value) a válaszba kerülő kulcs. Ha megváltoztatod, a korábbi
        válaszok más kulcsra mutatnak, mint az újak — ezért csak új kérdésnél írd át.
      </p>
    </div>
  );
}

/* ---- egy kapcsoló ---- */
function ECHO_Toggle({ label, hint, on, ro, onChange }) {
  return (
    <button type="button" disabled={ro} onClick={() => onChange(!on)}
      className={'w-full text-left rounded-2xl border-2 px-3.5 py-3 transition-all ' +
        (on ? 'border-primary bg-primary/5' : 'border-slate-100 bg-white hover:border-slate-200') +
        (ro ? ' opacity-60 pointer-events-none' : '')}>
      <div className="flex items-center gap-2">
        <span className={'w-4 h-4 rounded-md border-2 flex items-center justify-center flex-none ' + (on ? 'border-primary bg-primary' : 'border-slate-200')}>
          {on && <Lucide.Check size={11} className="text-white" />}
        </span>
        <span className={'text-xs font-black ' + (on ? 'text-primary' : 'text-slate-600')}>{label}</span>
      </div>
      {hint && <p className="text-[10px] text-slate-400 font-medium mt-1 leading-relaxed pl-6">{hint}</p>}
    </button>
  );
}

/* ---- kérdés-szerkesztő panel ---- */
function ECHO_QuestionPanel({ q, allIds, allQs, ro, onPatch, lang }) {
  if (!q) {
    return (
      <div className="bg-white rounded-3xl border border-slate-100 p-8 text-center">
        <Lucide.MousePointerClick size={22} className="text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-bold text-slate-400">Válassz egy kérdést a szerkezetből.</p>
      </div>
    );
  }
  const help = (q.help && typeof q.help === 'object') ? q.help : { hu: q.help || '', en: '' };
  const sc = q.scale || {};
  const scMin = Number(sc.min != null ? sc.min : 1);
  const scMax = Number(sc.max != null ? sc.max : 7);
  /* A cond kétféle alakja, amit az echo.template_validate() is elfogad:
       {"has_goals": true}            — kulcs→érték leképezés (a seed ezt használja)
       {"qid": "teacher_skip", ...}   — nevesített hivatkozás
     A szerkesztő MINDIG a leképezés-alakot írja vissza, de a nevesítettet is
     be tudja olvasni — különben egy kézzel írt feltételt csendben eldobna. */
  const condIsNamed = !!(q.cond && typeof q.cond === 'object' && q.cond.qid);
  const condKey = condIsNamed ? String(q.cond.qid)
    : (q.cond && typeof q.cond === 'object' ? (Object.keys(q.cond)[0] || '') : '');
  const condVal = condIsNamed ? (q.cond.val !== undefined ? q.cond.val : true)
    : (condKey ? q.cond[condKey] : '');
  const aud = ECHO_asArr(q.audience);

  /* A FELTÉTEL EMBERI NYELVEN. Eddig a kérdés belső azonosítója (q_x7k…) és egy
     nyers érték (true / null) volt a két mező — nehezen értelmezhető (hibajelentés).
     Most a kérdés SZÖVEGE és egy válaszlista áll ott, alatta egy kimondott mondat. */
  const kerdesek = (allQs || []).filter(x => x && x.id && x.id !== q.id);
  const refQ = condKey ? (kerdesek.find(x => x.id === condKey) || null) : null;
  const ertekOpciok = !condKey ? [] : (refQ
    ? [{ k: 'true', v: true, cimke: 'bármilyen választ adott' }, { k: 'null', v: null, cimke: 'üresen hagyta' }]
        .concat(ECHO_normOpts(refQ.options).map(o => ({ k: 'o:' + o.value, v: o.value, cimke: 'ezt választotta: ' + (o.hu || o.en || o.value) })))
    : (ECHO_COND_CTX_ERTEK[condKey] || [])).concat([{ k: '__egyeni', v: undefined, cimke: 'egyéni érték…' }]);
  const talalt = ertekOpciok.find(o => o.k !== '__egyeni' && JSON.stringify(o.v) === JSON.stringify(condVal));
  const ertekKulcs = talalt ? talalt.k : '__egyeni';
  const valasztErtek = (k) => {
    const o = ertekOpciok.find(x => x.k === k);
    if (!o || k === '__egyeni') { onPatch({ cond: { [condKey]: condVal === '' ? true : condVal } }); return; }
    onPatch({ cond: { [condKey]: o.v } });
  };
  const alanyNev = refQ ? '„' + ECHO_rovid(refQ.hu || refQ.id, 80) + '”' : (ECHO_COND_CTX_CIMKE[condKey] || condKey);
  const feltetelMondat = !condKey ? '' : (talalt
    ? (refQ ? 'A kérdés csak akkor jelenik meg, ha a kitöltő a(z) ' + alanyNev + ' kérdésnél ' + talalt.cimke + '.'
            : 'A kérdés csak akkor jelenik meg, ha a kitöltő ' + talalt.cimke + '.')
    : 'A kérdés csak akkor jelenik meg, ha ' + (refQ ? 'a(z) ' + alanyNev + ' kérdés válasza' : String(alanyNev).toLowerCase()) + ': ' + (condVal === null ? 'üres' : String(condVal)) + '.');

  const setScale = (patch) => onPatch({ scale: Object.assign({ min: scMin, max: scMax }, sc, patch) });

  return (
    <div className="bg-white rounded-3xl border border-slate-100 p-5 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest font-mono truncate">{q.id}</span>
        {ro && <UBadge tone="slate"><Lucide.Lock size={10} /> olvasó mód</UBadge>}
      </div>

      {/* típus */}
      <div>
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Kérdéstípus</span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {ECHO_QTYPES.map(t => {
            const Ic = Lucide[t.icon] || Lucide.Circle;
            const on = q.type === t.v;
            return (
              <button key={t.v} type="button" disabled={ro} onClick={() => onPatch({ type: t.v })}
                title={t.hint}
                className={'rounded-2xl border-2 px-3 py-2.5 text-left transition-all ' +
                  (on ? 'border-primary bg-primary/5 text-primary' : 'border-slate-100 bg-white text-slate-600 hover:border-slate-200') +
                  (ro ? ' opacity-60 pointer-events-none' : '')}>
                <Ic size={14} className="mb-1" />
                <p className="text-[11px] font-black">{t.label}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* kétnyelvű szöveg */}
      <div className="grid gap-3 sm:grid-cols-2">
        <UField label="Kérdés (magyar)">
          <textarea className={U_input + ' min-h-[70px] resize-y'} value={q.hu || ''} disabled={ro}
            onChange={e => onPatch({ hu: e.target.value })} />
        </UField>
        <UField label="Kérdés (angol)" hint={q.en ? '' : 'Hiánya élesítés-blokkoló hiba.'}>
          <textarea className={U_input + ' min-h-[70px] resize-y ' + (q.en ? '' : 'border-amber-200 bg-amber-50/50')}
            value={q.en || ''} disabled={ro} onChange={e => onPatch({ en: e.target.value })} />
        </UField>
        <UField label="Súgó (magyar)">
          <input className={U_input} value={help.hu || ''} disabled={ro}
            onChange={e => onPatch({ help: { hu: e.target.value, en: help.en || '' } })} />
        </UField>
        <UField label="Súgó (angol)">
          <input className={U_input} value={help.en || ''} disabled={ro}
            onChange={e => onPatch({ help: { hu: help.hu || '', en: e.target.value } })} />
        </UField>
      </div>

      {/* opciók */}
      {['single', 'multi', 'skip'].indexOf(q.type) >= 0 && (
        <div>
          <ECHO_OptionEditor q={q} ro={ro} onChange={arr => onPatch({ options: arr })} />
          {q.type === 'skip' && (
            <div className="mt-3 rounded-2xl bg-slate-50 border border-slate-100 p-3 space-y-2" data-echo-skip-sajat="1">
              <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
                A fenti opciók a kihagyás felkínált indokai. Ha a kitöltő saját indokot is írhat, kapcsold be:
              </p>
              <ECHO_Toggle label="Saját indok megadása" on={!!q.allowOther} ro={ro} onChange={v => onPatch({ allowOther: v })}
                hint="A saját indok szövegét az oktató nem látja; csak az adminisztrátori nyers nézetben jelenik meg." />
            </div>
          )}
        </div>
      )}

      {/* skála */}
      {q.type === 'scale' && (
        <div>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Skálabeállítás</span>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <UField label="Min érték">
              <input type="number" className={U_input} value={scMin} disabled={ro}
                onChange={e => setScale({ min: Number(e.target.value), points: Math.max(0, scMax - Number(e.target.value) + 1) })} />
            </UField>
            <UField label="Max érték">
              <input type="number" className={U_input} value={scMax} disabled={ro}
                onChange={e => setScale({ max: Number(e.target.value), points: Math.max(0, Number(e.target.value) - scMin + 1) })} />
            </UField>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <UField label="Alsó felirat (hu)">
              <input className={U_input} value={sc.min_hu || ''} disabled={ro} onChange={e => setScale({ min_hu: e.target.value })} />
            </UField>
            <UField label="Felső felirat (hu)">
              <input className={U_input} value={sc.max_hu || ''} disabled={ro} onChange={e => setScale({ max_hu: e.target.value })} />
            </UField>
            <UField label="Alsó felirat (en)">
              <input className={U_input} value={sc.min_en || ''} disabled={ro} onChange={e => setScale({ min_en: e.target.value })} />
            </UField>
            <UField label="Felső felirat (en)">
              <input className={U_input} value={sc.max_en || ''} disabled={ro} onChange={e => setScale({ max_en: e.target.value })} />
            </UField>
          </div>
          <p className="text-[11px] font-black text-slate-500">
            Fokozatszám: {Math.max(0, scMax - scMin + 1)}
            <span className="text-slate-400 font-medium"> — a kitöltő ennyi gombot lát. A min/max különbségéből számítjuk; a
            kitöltő komponens (ECHO_QScale) is ebből dolgozik, a `points` mező csak feljegyzés.</span>
          </p>
          {scMin >= scMax && (
            <p className="text-[11px] font-black text-red-500 mt-1.5">A min nem kisebb a maxnál — ez élesítés-blokkoló hiba.</p>
          )}
        </div>
      )}

      {/* kapcsolók */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-5 border-t border-slate-100">
        <ECHO_Toggle label="Kötelező" on={!!q.required} ro={ro} onChange={v => onPatch({ required: v })}
          hint="Feltétel mögötti kötelező kérdés élesítés-blokkoló hiba." />
        <ECHO_Toggle label="Moderált" on={!!q.moderated} ro={ro} onChange={v => onPatch({ moderated: v })}
          hint="A szöveg csak moderálás után kerül vissza az oktatóhoz." />
        <ECHO_Toggle label="Kevert sorrend" on={!!q.randomize} ro={ro} onChange={v => onPatch({ randomize: v })}
          hint="Az opciók sorrendje kitöltésenként más — a sorrendhatás ellen." />
        <ECHO_Toggle label="„Egyéb” engedése" on={!!q.allowOther} ro={ro} onChange={v => onPatch({ allowOther: v })}
          hint="Az egyéb szövegét az eredmény SOHA nem adja vissza, csak a darabszámot." />
      </div>

      {/* max + ismétlődés */}
      <div className="grid grid-cols-2 gap-3">
        <UField label="Max-limit"
          hint={q.type === 'multi' ? 'Többválasztósnál a max ≥ opciószám nem korlátoz — hiba.' : 'Szövegesnél a karakterkorlát.'}>
          <input type="number" className={U_input} value={q.max == null ? '' : q.max} disabled={ro}
            onChange={e => onPatch({ max: e.target.value === '' ? null : Number(e.target.value) })} />
        </UField>
        <UField label="Ismétlődés">
          <select className={U_input} value={q.repeat || ''} disabled={ro} onChange={e => onPatch({ repeat: e.target.value || null })}>
            {ECHO_REPEATS.map(r => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
        </UField>
      </div>

      {/* A kitöltőben nem működő kombinációk — élesítés előtt látszódjon. */}
      {q.type === 'skip' && q.repeat !== 'teacher' && (
        <div className="rounded-2xl bg-red-50 border border-red-100 px-3 py-2.5 text-[11px] font-bold text-red-700 leading-relaxed" data-echo-szerk-hiba="skip">
          A kihagyási kapu csak „oktatónként” ismétlődve működik: azt jelzi, hogy a kitöltő egy adott oktatót nem tud értékelni.
          Állítsd az Ismétlődést oktatónkéntire, vagy válassz másik kérdéstípust.
        </div>
      )}
      {q.repeat === 'goal' && (
        <div className="rounded-2xl bg-amber-50 border border-amber-100 px-3 py-2.5 text-[11px] font-bold text-amber-800 leading-relaxed" data-echo-szerk-figy="goal">
          Célonként ismétlődő kérdés: csak azok látják, akik a félév elején célt adtak meg — célonként egyszer.
        </div>
      )}
      {q.repeat === 'teacher_goal' && (
        <div className="rounded-2xl bg-amber-50 border border-amber-100 px-3 py-2.5 text-[11px] font-bold text-amber-800 leading-relaxed" data-echo-szerk-figy="teacher_goal">
          Oktatónként és célonként ismétlődő kérdés: minden oktatónál egyszer, és — akik a félév elején célt adtak meg — célonként is egyszer. A célonkénti válaszok összevontan kerülnek be.
        </div>
      )}

      {/* megjelenítési feltétel — emberi nyelven */}
      <div className="pt-5 border-t border-slate-100" data-echo-feltetel="1">
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Megjelenítési feltétel</span>
        <p className="text-[11px] text-slate-500 font-medium mb-2 leading-relaxed">Alapból minden kitöltő látja a kérdést. Ha feltételt adsz meg, csak az látja, akinek az előző válasza (vagy a kitöltés adata) megfelel.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UField label="Mitől függjön?">
            <select className={U_input} value={condKey} disabled={ro}
              onChange={e => { const k = e.target.value; const elso = ECHO_COND_CTX_ERTEK[k] && ECHO_COND_CTX_ERTEK[k][0]; onPatch({ cond: k ? { [k]: elso ? elso.v : true } : null }); }}>
              <option value="">Mindig jelenjen meg</option>
              <optgroup label="Egy korábbi kérdés válaszától">
                {kerdesek.map(x => <option key={x.id} value={x.id}>{ECHO_rovid(x.hu || x.id, 60)}</option>)}
              </optgroup>
              <optgroup label="A kitöltés adataitól">
                {ECHO_COND_CTX.map(k => <option key={k} value={k}>{ECHO_COND_CTX_CIMKE[k] || k}</option>)}
              </optgroup>
            </select>
          </UField>
          {condKey && (
            <UField label="Milyen válasznál?">
              <select className={U_input} value={ertekKulcs} disabled={ro} onChange={e => valasztErtek(e.target.value)}>
                {ertekOpciok.map(o => <option key={o.k} value={o.k}>{o.cimke}</option>)}
              </select>
            </UField>
          )}
        </div>
        {condKey && ertekKulcs === '__egyeni' && (
          <input className={U_input + ' font-mono text-xs mt-2'} disabled={ro}
            value={condVal === null ? 'null' : String(condVal)}
            onChange={e => onPatch({ cond: { [condKey]: ECHO_parseVal(e.target.value) } })}
            placeholder="egyéni érték (pl. true / null / szöveg)" />
        )}
        {condKey && (
          <p className="mt-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-[11px] font-semibold text-amber-900 leading-relaxed" data-echo-feltetel-mondat="1">
            {feltetelMondat}
          </p>
        )}
        {condKey && !refQ && ECHO_COND_CTX_ERTEK[condKey] && !talalt && (
          <p className="text-[11px] font-black text-red-500 mt-1.5" data-echo-feltetel-hiba="1">
            Érvénytelen érték ennél a feltételnél — így a kérdés senkinek nem jelenik meg. Válassz a listából.
          </p>
        )}
        {condKey && !refQ && ECHO_COND_CTX.indexOf(condKey) < 0 && (
          <p className="text-[11px] font-black text-red-500 mt-1.5">A hivatkozott kérdés nem létezik — ez élesítés-blokkoló hiba.</p>
        )}
      </div>

      {/* célközönség */}
      <div className="pt-5 border-t border-slate-100">
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Célközönség-címkék</span>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {aud.length === 0 && <span className="text-[11px] font-bold text-slate-400">Nincs szűkítés — mindenki látja.</span>}
          {aud.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider">
              {a}
              {!ro && <button onClick={() => onPatch({ audience: aud.filter((_, k) => k !== i) })} className="text-slate-400 hover:text-red-500"><Lucide.X size={11} /></button>}
            </span>
          ))}
        </div>
        {!ro && (
          <div className="flex flex-wrap gap-1.5">
            {['student', 'teacher', 'phd', 'part_time', 'international'].filter(t => aud.indexOf(t) < 0).map(t => (
              <button key={t} onClick={() => onPatch({ audience: aud.concat([t]) })}
                className="text-[10px] font-black uppercase tracking-wider text-primary bg-primary/5 hover:bg-primary/10 rounded-full px-2.5 py-1 flex items-center gap-1">
                <Lucide.Plus size={10} /> {t}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- a szerkesztő ---- */
function ECHO_Editor({ user }) {
  const [list, setList] = useState(null);     // echo_templates()
  const [vid, setVid] = useState('');
  const [doc, setDoc] = useState(null);       // echo_template_get()
  const [draft, setDraft] = useState(null);   // a szerkesztett compiled
  const [checks, setChecks] = useState([]);   // echo_template_validate()
  const [dirty, setDirty] = useState(false);
  const [si, setSi] = useState(0);
  const [qi, setQi] = useState(null);
  const [pv, setPv] = useState(null);         // előnézeti válaszérték
  const [pvMode, setPvMode] = useState('q');  // q | sec | all
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFrom, setNewFrom] = useState('');
  // A kérdőív neve draft állapotban szerkeszthető. Külön állapot, mert nem a
  // 'compiled' része: a sablonon él, és saját RPC menti (echo_template_rename).
  const [nameHu, setNameHu] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState(null);
  const lang = ECHO_lang();

  const loadList = async () => {
    setErr('');
    try { const d = await ECHO_api.templates(); setList(Array.isArray(d) ? d : []); }
    catch (e) { setList([]); setErr(ECHO_msg(e)); }
  };
  useEffect(() => { loadList(); }, []);

  const openVersion = async (id) => {
    if (!id) return;
    setBusy(true); setErr('');
    try {
      const d = await ECHO_api.templateGet(id);
      setVid(id); setDoc(d); setDraft(ECHO_clone(d.compiled || { sections: [] }));
      setChecks(Array.isArray(d.ellenorzes) ? d.ellenorzes : []);
      setDirty(false); setSi(0); setQi(null); setPv(null);
      setNameHu(d.name_hu || ''); setNameMsg(null);
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  // Átnevezés: fókusz elhagyásakor vagy Enterre ment. Csak akkor hív szervert,
  // ha tényleg változott a név, és üresre nem enged (a szerver is tiltja).
  const renameNow = async () => {
    if (!vid || !doc) return;
    const uj = (nameHu || '').trim();
    if (uj === (doc.name_hu || '')) { setNameMsg(null); return; }
    if (!uj) { setNameHu(doc.name_hu || ''); setNameMsg({ ok: false, text: 'A név nem lehet üres.' }); return; }
    setNameBusy(true); setNameMsg(null);
    try {
      const r = await ECHO_api.templateRename(vid, uj, null);
      setDoc({ ...doc, name_hu: r.name_hu });
      // A név a SABLONHOZ tartozik: ha több verzió is van, mindegyik címkéje ezzel változik.
      const tobbi = Number(r.erintett_tovabbi_verzio || 0);
      setNameMsg({ ok: true, text: tobbi > 0 ? 'Átnevezve — ' + tobbi + ' további verzió címkéje is ez lett.' : 'Átnevezve.' });
      await loadList();
    } catch (e) {
      setNameHu(doc.name_hu || '');
      setNameMsg({ ok: false, text: ECHO_msg(e) });
    } finally { setNameBusy(false); }
  };

  const save = async () => {
    if (!vid || !draft) return;
    setBusy(true); setErr('');
    try {
      const r = await ECHO_api.templateSave(vid, draft);
      setChecks(Array.isArray(r.ellenorzes) ? r.ellenorzes : []);
      setDirty(false); setToast('Mentve. Az ellenőrző lista frissült.');
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  const transition = async (to) => {
    if (!vid) return;
    if (dirty && !window.confirm('Mentetlen módosításaid vannak — az állapotváltás a MENTETT tartalommal dolgozik. Folytatod?')) return;
    setBusy(true); setErr('');
    try {
      const r = await ECHO_api.templateTransition(vid, to);
      setToast('Állapot: ' + r.from + ' → ' + r.to + (r.lezart_korabbi_live ? ' (' + r.lezart_korabbi_live + ' korábbi élő verzió lezárva)' : ''));
      await loadList(); await openVersion(vid);
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const r = await ECHO_api.templateCreate(newName, newFrom || null);
      setNewOpen(false); setNewName(''); setNewFrom('');
      await loadList(); await openVersion(r.id);
      setToast('Új verzió (v' + r.version + ') létrehozva piszkozatként.');
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(false); }
  };

  /* ---- a compiled mutálása ---- */
  const mut = (fn) => {
    if (!draft) return;
    const d = ECHO_clone(draft);
    if (!Array.isArray(d.sections)) d.sections = [];
    fn(d);
    setDraft(d); setDirty(true);
  };

  const sections = (draft && Array.isArray(draft.sections)) ? draft.sections : [];
  const sec = sections[si] || null;
  const q = (sec && Array.isArray(sec.questions)) ? (sec.questions[qi] || null) : null;
  const ro = !(doc && doc.szerkesztheto);

  /* A validációs találatok KÉRDÉS szerint. A kétsávos elrendezésben a hiba
     a saját kártyáján szólal meg, nem a képernyő másik szélén — ehhez kell
     a kerdes mező szerinti csoportosítás. A kérdéshez nem köthető találatok
     (üres kérdőív, ismétlődő azonosító) a jobb oldali listában maradnak. */
  const checkByQ = {};
  (checks || []).forEach(c => {
    if (!c || !c.kerdes) return;
    (checkByQ[c.kerdes] = checkByQ[c.kerdes] || []).push(c);
  });
  const hibaDb = (checks || []).filter(c => c && c.sulyossag === 'hiba').length;
  const allIds = [];
  sections.forEach(s => (s.questions || []).forEach(x => allIds.push(x.id)));
  const allQs = [];
  sections.forEach(s => (s.questions || []).forEach(x => allQs.push(x)));

  const addSection = () => mut(d => {
    d.sections.push({ id: 's_' + ECHO_uid(8), hu: 'Új szakasz', en: '', part: 'part2', audience: [], questions: [] });
    setSi(d.sections.length - 1); setQi(null);
  });
  const delSection = (i) => {
    mut(d => { d.sections.splice(i, 1); setSi(Math.max(0, i - 1)); setQi(null); });
  };
  const moveSection = (i, dd) => mut(d => {
    const j = i + dd; if (j < 0 || j >= d.sections.length) return;
    const t = d.sections[i]; d.sections[i] = d.sections[j]; d.sections[j] = t; setSi(j);
  });
  const patchSection = (i, patch) => mut(d => { d.sections[i] = Object.assign({}, d.sections[i], patch); });

  const addQuestion = (i, type) => mut(d => {
    const s = d.sections[i]; if (!s.questions) s.questions = [];
    s.questions.push({
      id: 'q_' + ECHO_uid(8), hu: 'Új kérdés', en: '', help: { hu: '', en: '' },
      type: type || 'single', options: type === 'scale' || type === 'longtext' ? [] : [],
      required: false, moderated: type === 'longtext', randomize: false, allowOther: false,
      max: null, repeat: null, cond: null,
      scale: type === 'scale' ? { min: 1, max: 7, points: 7, min_hu: '', max_hu: '', min_en: '', max_en: '' } : null,
      audience: [],
    });
    setQi(s.questions.length - 1); setPv(null);
  });
  const delQuestion = (i, k) => mut(d => { d.sections[i].questions.splice(k, 1); setQi(null); });
  const moveQuestion = (i, k, dd) => mut(d => {
    const qs = d.sections[i].questions; const j = k + dd;
    if (j < 0 || j >= qs.length) return;
    const t = qs[k]; qs[k] = qs[j]; qs[j] = t; setQi(j);
  });
  const moveQToSection = (i, k, target) => mut(d => {
    if (target === i) return;
    const item = d.sections[i].questions.splice(k, 1)[0];
    if (!d.sections[target].questions) d.sections[target].questions = [];
    d.sections[target].questions.push(item);
    setSi(target); setQi(d.sections[target].questions.length - 1);
  });
  const patchQuestion = (patch) => mut(d => {
    const qs = d.sections[si].questions;
    qs[qi] = Object.assign({}, qs[qi], patch);
    setPv(null);
  });

  // Az ellenőrzési találat → ugrás a helyére.
  const jumpTo = (c) => {
    const i = sections.findIndex(s => s.id === c.szakasz);
    if (i < 0) return;
    setSi(i);
    const k = (sections[i].questions || []).findIndex(x => x.id === c.kerdes);
    setQi(k >= 0 ? k : null);
  };

  const cleanCheck = checks.length === 0 && !dirty;

  /* ---- kirajzolás ---- */
  if (list === null) {
    return <div className="space-y-3"><SkeletonBar w="40%" h={16} /><SkeletonBar /><SkeletonBar w="70%" /></div>;
  }

  return (
    <div>
      <UToast msg={toast} onDone={() => setToast('')} />

      {err && (
        <div className="mb-5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {/* sablon- és verziólista */}
      <div className="bg-white rounded-3xl border border-slate-100 p-5 mb-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Lucide.Layers size={16} className="text-slate-400" />
            <h3 className="font-black text-slate-900 text-sm">Sablonok és verziók</h3>
          </div>
          <button onClick={() => { setNewOpen(true); setNewFrom(''); setNewName(''); }} className={U_btnGhost + ' py-2.5 px-4 text-sm'}>
            <Lucide.FilePlus2 size={15} /> Új verzió
          </button>
        </div>

        {list.length === 0 ? (
          <p className="text-sm text-slate-400 font-bold">Nincs sablon. Indíts egyet üresen.</p>
        ) : (
          <div className="space-y-4">
            {list.map(t => (
              <div key={t.id}>
                <p className="text-xs font-black text-slate-700 mb-2">
                  <ECHO_Src>{t.name_hu}</ECHO_Src>
                  <span className="text-slate-300 font-mono ml-2">{t.code}</span>
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px]">
                    <thead>
                      <tr className="text-left">
                        {['Verzió', 'Állapot', 'Szakasz / kérdés', 'Kampány', 'Ellenőrzés', ''].map((h, i) => (
                          <th key={i} className="px-3 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(t.verziok || []).map(v => {
                        const st = ECHO_TPL_STATE[v.state] || { label: v.state, tone: 'slate' };
                        const on = vid === v.id;
                        return (
                          <tr key={v.id} onClick={() => openVersion(v.id)}
                            className={'border-t border-slate-50 cursor-pointer transition-colors ' + (on ? 'bg-primary/5' : 'hover:bg-slate-50')}>
                            <td className="px-3 py-2.5 text-sm font-black text-slate-900">v{v.version}</td>
                            <td className="px-3 py-2.5"><UBadge tone={st.tone}>{st.label}</UBadge></td>
                            <td className="px-3 py-2.5 text-xs font-bold text-slate-500">{v.szakaszok} / {v.kerdesek}</td>
                            <td className="px-3 py-2.5 text-xs font-bold text-slate-500">{v.kampanyok}</td>
                            <td className="px-3 py-2.5">
                              {v.ellenorzes_hibak > 0
                                ? <UBadge tone="amber"><Lucide.AlertTriangle size={10} /> {v.ellenorzes_hibak}</UBadge>
                                : <UBadge tone="green"><Lucide.CheckCircle2 size={10} /> tiszta</UBadge>}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <Lucide.ChevronRight size={15} className="text-slate-300 inline" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!doc ? (
        <UEmpty icon={<Lucide.FileText size={28} />} title="Válassz egy verziót"
          subtitle="A szerkesztés csak piszkozat (draft) állapotban engedett; minden más állapotnál olvasó mód." />
      ) : (
        <>
          {/* verzió-fejléc + állapotgomb-sor */}
          <div className="bg-white rounded-3xl border border-slate-100 p-5 mb-6">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
              <div className="min-w-0">
                {ro ? (
                  <h3 className="font-black text-slate-900">
                    <ECHO_Src>{doc.name_hu}</ECHO_Src> <span className="text-slate-300">· v{doc.version}</span>
                  </h3>
                ) : (
                  <div className="flex items-center gap-2">
                    {/* A size NÉLKÜL az input a böngésző alapértelmezett ~20
                        karakteres belső szélességén marad, akármilyen hosszú a
                        név — a min-w/max-w csak korlátot ad, szélességet nem.
                        Mérve: az "OMHV alapkerdoiv (28/2023.)" névből 38 px
                        levágódott. A size a tartalomhoz igazítja, ugyanazon a
                        16–56 karakteres határon belül, amit az osztályok is
                        kifejeznek.

                        A felső határ fölött (a maxLength 120-at enged) a név
                        továbbra sem férne ki — de ott már NEM némán: a title
                        megmutatja a teljeset, az ellipszis pedig jelzi, hogy
                        van még. A néma levágás volt az eredeti hiba. */}
                    <input
                      value={nameHu}
                      onChange={e => setNameHu(e.target.value)}
                      onBlur={renameNow}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      maxLength={120}
                      aria-label="A kérdőív neve"
                      placeholder="A kérdőív neve"
                      size={Math.max(16, Math.min(56, (nameHu || '').length + 1))}
                      title={nameHu || 'A kérdőív neve'}
                      className="font-black text-slate-900 bg-transparent border-b-2 border-dashed border-slate-200
                                 focus:border-primary focus:outline-none px-0.5 py-0.5 min-w-[16ch] max-w-[56ch] text-ellipsis"
                    />
                    <span className="text-slate-300 font-black">· v{doc.version}</span>
                    {nameBusy && <Lucide.Loader2 size={13} className="animate-spin text-slate-300" />}
                    {nameMsg && (
                      <span className={'text-[11px] font-bold ' + (nameMsg.ok ? 'text-emerald-600' : 'text-rose-600')}>
                        {nameMsg.text}
                      </span>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  <UBadge tone={(ECHO_TPL_STATE[doc.state] || {}).tone || 'slate'}>
                    {(ECHO_TPL_STATE[doc.state] || {}).label || doc.state}
                  </UBadge>
                  {doc.kampanyok > 0 && <UBadge tone="blue">{doc.kampanyok} kampány használja</UBadge>}
                  {dirty && <UBadge tone="amber"><Lucide.Pencil size={10} /> mentetlen</UBadge>}
                  {doc.approved_by && (
                    <span className="text-[11px] font-bold text-slate-400">
                      jóváhagyta: <ECHO_Src>{doc.approved_by}</ECHO_Src> · {ECHO_dateTime(doc.approved_at)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {!ro && (
                  <button onClick={save} disabled={busy || !dirty} className={U_btnPrimary + ' py-2.5 px-4 text-sm'}>
                    {busy ? <Lucide.Loader2 size={15} className="animate-spin" /> : <Lucide.Save size={15} />} Mentés
                  </button>
                )}
                {(ECHO_TPL_NEXT[doc.state] || []).map(a => {
                  const Ic = Lucide[a.icon] || Lucide.ArrowRight;
                  const blocked = a.clean && !cleanCheck;
                  return (
                    <button key={a.to} onClick={() => transition(a.to)} disabled={busy || blocked}
                      title={blocked ? 'Élesítés csak üres ellenőrző listával, mentett állapotban.' : ''}
                      className={(a.to === 'live' ? U_btnPrimary : U_btnGhost) + ' py-2.5 px-4 text-sm'}>
                      <Ic size={15} /> {a.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {ro && (
              <div className="bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5">
                <Lucide.Lock size={15} className="text-slate-400 flex-none mt-0.5" />
                <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
                  Ez a verzió <strong>{(ECHO_TPL_STATE[doc.state] || {}).label || doc.state}</strong> állapotban van, ezért
                  OLVASÓ MÓD. A compiled mezőt nem csak az RPC védi: az echo.template_version_freeze()
                  trigger a jóváhagyott / élesített / archív verzió tartalmát a Dashboard SQL Editorból
                  írt UPDATE ellen is megvédi. Ha módosítanál, készíts új verziót.
                </p>
              </div>
            )}
          </div>

            {/* ===================================================================
                KÉTSÁVOS SZERKESZTŐ

                Korábban három sáv volt: Szerkezet | kérdés-szerkesztő | előnézet
                + ellenőrzés. Egy kérdés megnézéséhez két lépés kellett (kiválasztás
                balra, olvasás középen), a magyar és az angol szöveg nem látszott
                egymás mellett, és a hiba a képernyő másik szélén jelent meg, mint
                a kérdés, amire vonatkozott.

                Mostantól a szerkesztő EGY oszlop: a szakaszok fejlécek, a kérdések
                kártyák, a kiválasztott kártya helyben nyílik ki a teljes
                metaadatával. Az előnézet mellette marad, és követi a kiválasztást.
                A kérdéshez köthető hibák a saját kártyájukon szólalnak meg.
                =================================================================== */}
            <div className="grid gap-6 xl:grid-cols-12">

              {/* ---------------- BAL: a szerkesztő ---------------- */}
              <div className="xl:col-span-7 space-y-5">

                {sections.length === 0 && (
                  <div className="bg-white rounded-3xl border border-slate-100 p-10 text-center">
                    <p className="font-black text-slate-700">Nincs szakasz</p>
                    <p className="text-[12px] text-slate-400 mt-1">
                      Az üres kérdőív nem élesíthető — kezdd egy szakasszal.
                    </p>
                  </div>
                )}

                {sections.map((s, i) => (
                  <div key={s.id || i} className="space-y-2">

                    {/* szakaszfejléc */}
                    <div className="flex items-start gap-2 flex-wrap">
                      {/* Ugyanaz a kétnyelvű megjelenés, mint a kérdéskártyákon:
                          nagyban a magyar, alatta kicsiben az angol. Az angol
                          cím kötelező az élesítéshez, tehát a hiánya nem egy
                          külön címkében bújik meg, hanem ott áll a helyén. */}
                      <button onClick={() => setSi(si === i ? si : i)}
                        className="text-left min-w-0">
                        <span className="block text-[14px] font-black text-slate-900">
                          <ECHO_Src>{s.hu || '(névtelen szakasz)'}</ECHO_Src>
                        </span>
                        <span className={'block text-[11px] ' +
                          (s.en ? 'text-slate-400' : 'font-bold text-amber-600')}>
                          <ECHO_Src>{s.en || '— nincs angol cím, az élesítéshez kötelező —'}</ECHO_Src>
                        </span>
                      </button>
                      <span className="text-[10px] font-black uppercase tracking-wider rounded-lg px-2 py-0.5 bg-slate-100 text-slate-500 mt-0.5">
                        {(s.questions || []).length} kérdés
                      </span>
                      {(s.part || 'part2') === 'part1' && (
                        <span title="A válasz a hallgató nevéhez kötve tárolódik, és kimarad a névtelen halmazból — ezért nincs benne az oktatói eredményben."
                          className="text-[10px] font-black uppercase tracking-wider rounded-lg px-2 py-0.5 bg-indigo-50 text-indigo-700 mt-0.5">
                          célmeghatározás · nem névtelen
                        </span>
                      )}
                      {!ro && (
                        <div className="flex items-center gap-0.5 ml-auto">
                          <button onClick={() => setSi(si === i ? -1 : i)} title="Szakasz beállításai"
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center">
                            <Lucide.Settings2 size={14} />
                          </button>
                          <button onClick={() => moveSection(i, -1)} title="Feljebb"
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center">
                            <Lucide.ChevronUp size={14} />
                          </button>
                          <button onClick={() => moveSection(i, 1)} title="Lejjebb"
                            className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-400 flex items-center justify-center">
                            <Lucide.ChevronDown size={14} />
                          </button>
                          <ECHO_TorlesGomb onTorol={() => delSection(i)} cim="Szakasz törlése"
                            kerdes="Törlöd a szakaszt a benne lévő összes kérdéssel együtt?" meret={13}
                            osztaly="w-7 h-7 rounded-lg hover:bg-red-50 text-red-400 flex items-center justify-center" />
                        </div>
                      )}
                    </div>

                    {/* a szakasz saját beállításai — csak ha kinyitottad */}
                    {si === i && !ro && (
                      <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3">
                        <div className="grid sm:grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                              Szakaszcím · magyar
                            </label>
                            <input className={U_input + ' py-2 text-sm mt-1'} value={s.hu || ''} disabled={ro}
                              onChange={e => patchSection(i, { hu: e.target.value })}
                              placeholder="pl. Az oktatóról" />
                          </div>
                          <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                              Szakaszcím · angol <span className="text-primary">· kötelező</span>
                            </label>
                            <input className={U_input + ' py-2 text-sm mt-1 ' + (s.en ? '' : 'border-amber-200 bg-amber-50/50')}
                              value={s.en || ''} disabled={ro}
                              onChange={e => patchSection(i, { en: e.target.value })}
                              placeholder="pl. About the lecturer" />
                          </div>
                        </div>

                        {/* MIT JELENT A part VALÓJÁBAN — ÉS MIT NEM
                            NEM időzítés. Azt, hogy mikor tölthető ki, a KAMPÁNY
                            mondja meg: goals_open_at/goals_close_at a célokra,
                            opens_at/closes_at az értékelésre.

                            A part azt dönti el, HOVA kerül a válasz:
                              part1 → echo_save_goals() a student_goal.intro-ba
                                      írja, ami AZONOSÍTOTT sor, ÉS az
                                      echo_submit() kivágja a névtelen halmazból
                                      (23_echo_form_rules.sql: v_course_a - v_key).
                                      Enélkül ugyanaz a válasz ott állna az
                                      azonosított és a névtelen oldalon is, és a
                                      kettő összevethető lenne — ez deanonimizál.
                              part2 → a névtelen válaszhalmazba megy, és ez adja
                                      az oktatói eredményt.

                            A korábbi címke ("félév eleji / félév végi") az
                            időzítést sugallta, ami a kampány dolga. */}
                        <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                            Célmeghatározás/Értékelés
                          </label>
                          <select className={U_input + ' py-2 text-sm mt-1'} value={s.part || 'part2'} disabled={ro}
                            onChange={e => patchSection(i, { part: e.target.value })}>
                            <option value="part2">Névtelen értékelés — bekerül az oktatói eredménybe</option>
                            <option value="part1">Célmeghatározás — a hallgató nevéhez kötve, a névtelen halmazon kívül</option>
                          </select>
                          <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                            {(s.part || 'part2') === 'part1'
                              ? 'A válasz a hallgató saját céljai mellé kerül, névvel. A névtelen halmazból a rendszer kiveszi — ha mindkét helyen ott lenne, a kettő összevethető volna, és az visszafejthetővé tenné a kitöltőt. Ezért nem is jelenik meg az oktatói eredményben.'
                              : 'A válasz a névtelen halmazba megy. Ez adja az oktatói eredményt és a jegyzőkönyvet.'}
                          </p>
                          <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                            Azt, hogy <strong>mikor</strong> tölthető ki, nem itt kell megadni:
                            a kampánynak külön célmeghatározási és értékelési ablaka van.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* kérdés-kártyák */}
                    {(s.questions || []).map((x, k) => {
                      const nyitva = si === i && qi === k;
                      const hibak = checkByQ[x.id] || [];
                      const sulyos = hibak.some(c => c.sulyossag === 'hiba');
                      return (
                        <div key={x.id || k}
                          className={'bg-white rounded-2xl border transition-colors ' +
                            (nyitva ? 'border-primary/30 shadow-lg shadow-slate-900/5'
                                    : sulyos ? 'border-red-100' : 'border-slate-100')}>

                          {/* fejsor — összecsukva és kinyitva is ez látszik */}
                          <div className="flex items-start gap-2.5 p-3">
                            <button onClick={() => { setSi(i); setQi(nyitva ? null : k); setPv(null); }}
                              className="flex items-start gap-2.5 min-w-0 flex-1 text-left">
                              <span className={'w-7 h-7 rounded-lg flex-none flex items-center justify-center ' +
                                (nyitva ? 'bg-primary/10 text-primary'
                                        : sulyos ? 'bg-red-50 text-red-500' : 'bg-slate-50 text-slate-400')}>
                                <Lucide.HelpCircle size={15} />
                              </span>
                              {/* A kérdés szövege TÖRDELŐDIK, nem vágódik le.
                                  A hárommezős elrendezésben ez egy keskeny fában
                                  élt, ahol a truncate indokolt volt — a széles
                                  kártyán viszont mérve 205 pixel is eltűnt egy
                                  hosszabb kérdésből. Két sor után jelezzük, hogy
                                  van még, és a title megmutatja a teljeset. */}
                              <span className="min-w-0 flex-1">
                                <span className="block text-[13px] font-bold text-slate-800 line-clamp-2"
                                  title={x.hu || x.id}>
                                  <ECHO_Src>{x.hu || x.id}</ECHO_Src>
                                </span>
                                {sulyos ? (
                                  <span className="block text-[11px] font-bold text-red-600 line-clamp-2"
                                    title={hibak[0].uzenet}>
                                    <ECHO_Src>{hibak[0].uzenet}</ECHO_Src>
                                  </span>
                                ) : (
                                  <span className="block text-[11px] text-slate-400 line-clamp-2"
                                    title={x.en || 'Nincs megadva angol szöveg.'}>
                                    <ECHO_Src>{x.en || '— nincs angol szöveg —'}</ECHO_Src>
                                  </span>
                                )}
                              </span>
                            </button>
                            <span className="text-[10px] font-black uppercase tracking-wider rounded-lg px-2 py-0.5 bg-slate-50 text-slate-500 font-mono flex-none">
                              {x.id}
                            </span>
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex-none hidden sm:inline">
                              {x.type}{x.required ? ' · kötelező' : ''}
                            </span>
                            {!ro && (
                              <div className="flex items-center gap-0.5 flex-none">
                                <button onClick={() => moveQuestion(i, k, -1)} title="Feljebb"
                                  className="w-6 h-6 rounded hover:bg-slate-100 text-slate-300 flex items-center justify-center">
                                  <Lucide.ChevronUp size={13} />
                                </button>
                                <button onClick={() => moveQuestion(i, k, 1)} title="Lejjebb"
                                  className="w-6 h-6 rounded hover:bg-slate-100 text-slate-300 flex items-center justify-center">
                                  <Lucide.ChevronDown size={13} />
                                </button>
                                <ECHO_TorlesGomb onTorol={() => delQuestion(i, k)} cim="Kérdés törlése"
                                  kerdes="Törlöd ezt a kérdést?" meret={12}
                                  osztaly="w-6 h-6 rounded hover:bg-red-50 text-red-300 flex items-center justify-center" />
                              </div>
                            )}
                            <Lucide.ChevronDown size={15}
                              className={'flex-none transition-transform ' +
                                (nyitva ? 'rotate-180 text-primary' : 'text-slate-300')} />
                          </div>

                          {/* kinyitva: a teljes metaadat, helyben */}
                          {nyitva && (
                            <div className="border-t border-slate-50 p-4 space-y-3">
                              {!ro && sections.length > 1 && (
                                <UField label="Áthelyezés másik szakaszba">
                                  <select className={U_input + ' py-2 text-xs'} value={si}
                                    onChange={e => moveQToSection(si, qi, Number(e.target.value))}>
                                    {sections.map((ss, ii) => (
                                      <option key={ss.id || ii} value={ii}>{ss.hu || '(névtelen)'}</option>
                                    ))}
                                  </select>
                                </UField>
                              )}
                              <ECHO_QuestionPanel q={x} allIds={allIds} allQs={allQs} ro={ro}
                                onPatch={patchQuestion} lang={lang} />
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* új kérdés ebbe a szakaszba */}
                    {!ro && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {ECHO_QTYPES.map(t => (
                          <button key={t.v} onClick={() => addQuestion(i, t.v)} title={t.hint}
                            className="text-[10px] font-black uppercase tracking-wider text-primary bg-primary/5 hover:bg-primary/10 rounded-lg px-2.5 py-1.5 inline-flex items-center gap-1">
                            <Lucide.Plus size={10} /> {t.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {!ro && (
                  <button onClick={addSection}
                    className="inline-flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white text-slate-500 px-4 py-2.5 text-[13px] font-bold hover:border-primary hover:text-primary transition-colors">
                    <Lucide.Plus size={15} /> Szakasz hozzáadása
                  </button>
                )}
              </div>

              {/* ---------------- JOBB: előnézet és ellenőrzés ---------------- */}
              <div className="xl:col-span-5">
                <div className="xl:sticky xl:top-4 space-y-4">

                  <div className="bg-white rounded-3xl border border-slate-100 p-5">
                    <div className="flex items-center justify-between gap-2 mb-4">
                      <div className="flex items-center gap-2">
                        <Lucide.Eye size={16} className="text-slate-400" />
                        <h3 className="font-black text-slate-900 text-sm">Élő előnézet</h3>
                      </div>
                      <div className="flex gap-1">
                        {[{ v: 'q', l: 'Kérdés' }, { v: 'sec', l: 'Szakasz' }, { v: 'all', l: 'Teljes' }].map(m => (
                          <button key={m.v} onClick={() => setPvMode(m.v)}
                            className={'text-[10px] font-black uppercase tracking-wider rounded-lg px-2 py-1 ' +
                              (pvMode === m.v ? 'bg-primary/10 text-primary' : 'text-slate-400 hover:bg-slate-100')}>
                            {m.l}
                          </button>
                        ))}
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-400 font-medium mb-4 leading-relaxed">
                      Ugyanazokkal a komponensekkel rajzoljuk, amikkel a hallgató kitölt
                      (ECHO_Question). A helykitöltők ki vannak töltve mintaértékkel —
                      pl. [Oktató neve] → {ECHO_TOKENS['[Oktató neve]']}.
                    </p>

                    <div className="rounded-2xl border border-slate-100 p-3 xl:max-h-[calc(100vh-15rem)] xl:overflow-y-auto overscroll-contain" data-echo-elonezet="1">
                      {pvMode === 'q' && (q
                        ? <ECHO_Question q={ECHO_previewQuestion(q, lang)} index={(qi || 0) + 1}
                            value={pv} onChange={setPv} lang={lang} seed="preview" ctx={ECHO_PREVIEW_CTX} />
                        : <p className="text-xs font-bold text-slate-400 py-6 text-center">Nyiss ki egy kérdést a bal oldalon.</p>)}

                      {pvMode === 'sec' && (sec
                        ? <div>
                            <h4 className="text-sm font-black text-slate-800 mb-1"><ECHO_Src>{ECHO_txt(sec, lang)}</ECHO_Src></h4>
                            {(sec.questions || []).map((x, k) => (
                              <ECHO_Question key={x.id || k} q={ECHO_previewQuestion(x, lang)} index={k + 1}
                                value={undefined} onChange={() => {}} lang={lang} seed="preview" ctx={ECHO_PREVIEW_CTX} />
                            ))}
                          </div>
                        : <p className="text-xs font-bold text-slate-400 py-6 text-center">Nincs kiválasztott szakasz.</p>)}

                      {pvMode === 'all' && draft && <ECHO_FormPreview form={draft} lang={lang} />}
                    </div>

                    {/* A feltétel következménye kimondva. A cond mezőből ezt ma
                        fejben kellett kikövetkeztetni — egy rosszul beállított
                        feltétel csendben elrejti a kérdést a válaszadók egy része
                        elől, és csak a kampány végén derül ki. */}
                    {pvMode === 'q' && q && q.cond && (
                      <div className="mt-3 rounded-2xl bg-amber-50 border border-amber-100 p-3 flex gap-2">
                        <Lucide.GitBranch size={15} className="text-amber-700 flex-none mt-0.5" />
                        <p className="text-[11px] text-amber-900 leading-relaxed">
                          Ezt a kérdést nem mindenki látja: csak az, akire a beállított
                          feltétel illik. A többieknél a kérdőív a következő kérdéssel
                          folytatódik.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* ÉLESÍTÉS ELŐTTI ELLENŐRZÉS — a kérdéshez köthető találatok
                      már a saját kártyájukon is megjelentek; itt a teljes lista van,
                      beleértve azt, ami egyik kérdéshez sem tartozik. */}
                  <div className="bg-white rounded-3xl border border-slate-100 p-5">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2">
                        <Lucide.ShieldCheck size={16}
                          className={checks.length ? (hibaDb ? 'text-red-500' : 'text-amber-500') : 'text-emerald-500'} />
                        <h3 className="font-black text-slate-900 text-sm">Élesítés előtti ellenőrzés</h3>
                      </div>
                      <button onClick={async () => {
                        setBusy(true);
                        try { setChecks(await ECHO_api.templateValidate(vid) || []); }
                        catch (e) { setErr(ECHO_msg(e)); } finally { setBusy(false); }
                      }} disabled={busy}
                        className="text-[10px] font-black uppercase tracking-wider text-slate-400 hover:text-primary disabled:opacity-50">
                        Újrafuttatás
                      </button>
                    </div>

                    {checks.length === 0 ? (
                      <p className="text-[11px] font-bold text-emerald-700">Nincs hiba — a verzió élesíthető.</p>
                    ) : (
                      <div className="space-y-2">
                        <p className={'text-[11px] font-black mb-1 ' + (hibaDb ? 'text-red-600' : 'text-amber-600')}>
                          {checks.length} találat{hibaDb ? ` — ebből ${hibaDb} blokkolja az élesítést` : ''}
                        </p>
                        {checks.map((c, i) => (
                          <div key={i} className="rounded-2xl border border-slate-100 p-3">
                            <div className="flex items-center gap-2 mb-1">
                              <UBadge tone={c.sulyossag === 'hiba' ? 'red' : 'amber'}>{c.sulyossag}</UBadge>
                              <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider font-mono truncate">{c.kod}</span>
                            </div>
                            <p className="text-[11px] font-medium text-slate-600 leading-relaxed"><ECHO_Src>{c.uzenet}</ECHO_Src></p>
                            {(c.szakasz || c.kerdes) && (
                              <p className="text-[10px] font-bold text-slate-400 mt-1 font-mono">
                                {c.szakasz || '—'}{c.kerdes ? ' / ' + c.kerdes : ''}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              </div>
            </div>
        </>
      )}

      {/* ÚJ VERZIÓ — üresen vagy mély klónnal */}
      <UModal open={newOpen} onClose={() => setNewOpen(false)} max="max-w-lg"
        icon={<Lucide.FilePlus2 size={20} />} title="Új kérdőív-verzió"
        subtitle="Meglévőből mély klónnal, ÚJ kérdés-ID-kkal — vagy üresen">
        <div className="space-y-4">
          <UField label="Név / cím">
            <input className={U_input} value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="pl. OMHV alapkérdőív 2026/27/1" />
          </UField>
          <UField label="Kiindulás">
            <select className={U_input} value={newFrom} onChange={e => setNewFrom(e.target.value)}>
              <option value="">— üresen (új sablon, 1. verzió) —</option>
              {(list || []).map(t => (
                <optgroup key={t.id} label={t.name_hu}>
                  {(t.verziok || []).map(v => (
                    <option key={v.id} value={v.id}>
                      v{v.version} · {(ECHO_TPL_STATE[v.state] || {}).label || v.state} · {v.kerdesek} kérdés
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </UField>
          <div className="bg-slate-50 rounded-2xl px-4 py-3">
            <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
              A klónozás MINDEN kérdés-ID-t kicserél, és a megjelenítési feltételek
              hivatkozásait együtt írja át. Ha az ID-k megmaradnának, két különböző
              megfogalmazású kérdés válaszai ugyanabba a kulcsba folynának, és egy
              hosszmetszeti riport összeadná őket. Az új verzió mindig piszkozat.
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setNewOpen(false)} className={U_btnGhost}>Mégsem</button>
            <button onClick={create} disabled={busy || !newName.trim()} className={U_btnPrimary}>
              {busy ? <Lucide.Loader2 size={16} className="animate-spin" /> : <Lucide.Plus size={16} />} Létrehozás
            </button>
          </div>
        </div>
      </UModal>
    </div>
  );
}

/* ------------------------------------------------------------
   12.5 ECHO_RolesPanel — oktatói kötés és ECHO-szerepkörök
   ------------------------------------------------------------
   MI VOLT A BAJ, AMIT EZ A PANEL MEGSZÜNTET (mérve a replikán):
     select count(*) from echo.teacher where profile_id is null;  -->  4 / 4
   Vagyis az echo.my_teacher_id() minden fiókra NULL-t adott, és az oktatói
   eredménynézet — bár megépült — senkinek nem működött. A kötést eddig
   semmilyen felület nem tudta létrehozni.

   A PANEL KÉT DOLGOT CSINÁL, ÉS EZEK NEM UGYANAZ:
     1. KÖTÉS  (echo_teacher_link) — MELYIK FIÓK ez az oktató.
        Ez tölti fel az echo.teacher.profile_id-t, és ad hozzá 'OKTATO'
        grantot a tanszéki hatókörrel.
     2. GRANT  (echo_role_grant)   — MIT SZABAD NEKI az ECHO-ban.
        Nyolc szerepkör, hatókörrel és lejárattal.
   Kötés grant nélkül: látszik a menüpont, a szerver mögötte elutasít.
   Grant kötés nélkül: az OKTATO szerepkör nem talál kurzust. A panel
   MINDKÉT hiányt kiírja, nem hagyja csendben.

   AMIT A PANEL NEM CSINÁL: nem hoz létre echo.teacher sort (az a
   Neptun-szinkron dolga), és nem töröl grantot — a visszavonás lejárati
   idő beállítása, mert egy megtörtént felhatalmazás nem tehető meg
   nem történtté (19_echo_roles.sql, 5.2).
   ------------------------------------------------------------ */

const ECHO_ROLE_INFO = {
  OKTATO:        { label: 'Oktató',           hint: 'a saját kurzusainak saját bontása' },
  TANSZEKVEZETO: { label: 'Tanszékvezető',    hint: 'a hatókörébe eső tanszék oktatói' },
  DEKAN:         { label: 'Dékán',            hint: 'a hatókörébe eső kar' },
  MIR:           { label: 'Minőségirányítás', hint: 'intézményi szint, jegyzőkönyv' },
  REKTORI:       { label: 'Rektori',          hint: 'vezetői betekintés' },
  EHOK:          { label: 'EHÖK',             hint: 'hallgatói önkormányzat, aggregált' },
  MODERATOR:     { label: 'Moderátor',        hint: 'szöveges válaszok érvényessége (3. § (10))' },
  SYSADMIN:      { label: 'ECHO üzemeltető',  hint: 'szerepkörök kiosztása' },
};

function ECHO_roleLabel(r) { return (ECHO_ROLE_INFO[r] && ECHO_ROLE_INFO[r].label) || r; }

function ECHO_RolesPanel({ user }) {
  const [d, setD] = useState(null);      // echo_role_grants() válasza
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');  // melyik sor dolgozik éppen

  // kötés-szerkesztő: teacher.id -> kiválasztott profile id
  const [pick, setPick] = useState({});
  // grant-űrlap
  const [gPerson, setGPerson] = useState('');
  const [gRole, setGRole]     = useState('MIR');
  const [gScope, setGScope]   = useState('');
  const [gExp, setGExp]       = useState('');
  const [gIkt, setGIkt]       = useState('');

  const load = () => {
    setErr('');
    ECHO_api.roleGrants()
      .then(x => { setD(x); setPick({}); })
      .catch(e => { setD({ oktatok: [], grantok: [], profilok: [], egysegek: [], szerepkorok: [] }); setErr(ECHO_msg(e)); });
  };
  useEffect(() => { load(); }, []);

  const profiles = (d && d.profilok) || [];
  const orgs     = (d && d.egysegek) || [];
  const roles    = (d && Array.isArray(d.szerepkorok) && d.szerepkorok.length) ? d.szerepkorok : Object.keys(ECHO_ROLE_INFO);
  const mayGrant = !!(d && d.oszthatok);

  const profLabel = (p) => (p.email || '(nincs e-mail)') + (p.name ? ' · ' + p.name : '') + ' [' + p.role + ']';
  const orgLabel  = (o) => o.code + ' — ' + o.name + ' (' + o.kind + ')';

  const doLink = async (teacherId, profileId) => {
    setBusy(teacherId); setErr('');
    try {
      const r = await ECHO_api.teacherLink(teacherId, profileId || null);
      setToast(r && r.muvelet === 'bontas'
        ? 'A kötés bontva — az oktatói grant lejártra állt.'
        : 'Összekötve. Az OKTATO grant is megvan.');
      load();
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(''); }
  };

  const doGrant = async (revoke) => {
    if (!gPerson || !gRole) { setErr('Válassz fiókot és szerepkört.'); return; }
    setBusy('grant'); setErr('');
    try {
      const exp = revoke ? new Date().toISOString() : (gExp ? new Date(gExp + 'T23:59:59').toISOString() : null);
      const r = await ECHO_api.roleGrant(gPerson, gRole, gScope || null, exp, gIkt || null);
      setToast((r && r.muvelet === 'visszavonas') ? 'Visszavonva (a sor megmarad, lejárt).' : 'Kiosztva.');
      if (r && r.figyelmeztetes) setErr(r.figyelmeztetes);
      setGIkt('');
      load();
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(''); }
  };

  const revokeRow = async (g) => {
    setBusy(g.id); setErr('');
    try {
      await ECHO_api.roleGrant(g.person, g.role, g.scope_org || null, new Date().toISOString(), null);
      setToast('Visszavonva.');
      load();
    } catch (e) { setErr(ECHO_msg(e)); }
    finally { setBusy(''); }
  };

  if (d === null) {
    return <div className="space-y-3"><SkeletonBar w="40%" h={16} /><SkeletonBar /><SkeletonBar w="70%" /></div>;
  }

  const kotetlen = (d.oktatok || []).filter(t => !t.profile_id).length;

  return (
    <div>
      <UToast msg={toast} onDone={() => setToast('')} />

      {err && (
        <div className="mb-5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-sm font-bold text-red-600 flex gap-2">
          <Lucide.AlertCircle size={16} className="flex-none mt-0.5" /> {err}
        </div>
      )}

      {/* MIÉRT NEM A UniPortal SZEREPKÖRBŐL — kimondva, mert ez a panel
          legkevésbé nyilvánvaló döntése. */}
      <div className="mb-6 bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5">
        <Lucide.Info size={15} className="text-slate-400 flex-none mt-0.5" />
        <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
          Az ECHO-jogosultság KÜLÖN dimenzió: nem a UniPortal szerepköréből (SUPERADMIN,
          ADMIN, STUDENT…) származik, hanem kizárólag az itt kiosztott, iktatható, lejáró
          grantból. Egy SUPERADMIN fióknak sincs ECHO-szerepköre, amíg nem kap egyet —
          mérve: <ECHO_Src>echo.has_role('MIR')</ECHO_Src> SUPERADMIN-ként is hamis.
          A hatókör LEFELÉ nyílik: a karra szóló grant a kar tanszékeit is fedi,
          a tanszéki a kart nem.
        </p>
      </div>

      {/* ---------- 1. OKTATÓ ↔ FIÓK ---------- */}
      <div className="bg-white rounded-3xl border border-slate-100 p-5 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2">
            <Lucide.Link2 size={16} className="text-slate-400" />
            <h3 className="font-black text-slate-900 text-sm">Oktató ↔ fiók összekötés</h3>
          </div>
          {kotetlen > 0
            ? <UBadge tone="amber"><Lucide.AlertTriangle size={10} /> {kotetlen} oktató kötés nélkül</UBadge>
            : <UBadge tone="green"><Lucide.CheckCircle2 size={10} /> mindenki kötve</UBadge>}
        </div>
        <p className="text-[11px] text-slate-400 font-medium mb-4 leading-relaxed">
          Ez tölti fel az <ECHO_Src>echo.teacher.profile_id</ECHO_Src> mezőt, amitől az
          <ECHO_Src> echo.my_teacher_id()</ECHO_Src> értéket ad — enélkül az oktató minden
          eredmény-RPC-től ECHO_FORBIDDEN-t kap. Egy fiók legfeljebb EGY oktatói sorhoz
          köthető (részleges UNIQUE index tiltja a másodikat).
        </p>

        {(d.oktatok || []).length === 0 ? (
          <p className="text-sm text-slate-400 font-bold">
            Nincs oktatói sor. Az echo.teacher sorokat a Neptun-szinkron hozza létre — ez a panel
            csak a MEGLÉVŐKET köti fiókhoz.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="text-left">
                  {['Oktató', 'Szervezeti egység', 'Kurzus', 'Kötött fiók', 'Grant', ''].map((h, i) => (
                    <th key={i} className="px-3 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(d.oktatok || []).map(t => (
                  <tr key={t.id} className="border-t border-slate-50 align-top">
                    <td className="px-3 py-3">
                      <p className="text-sm font-black text-slate-900"><ECHO_Src>{t.name}</ECHO_Src></p>
                      <p className="text-[11px] font-mono text-slate-300">{t.code}</p>
                    </td>
                    <td className="px-3 py-3 text-xs font-bold text-slate-500">{t.org_name || '—'}</td>
                    <td className="px-3 py-3 text-xs font-bold text-slate-500">{t.kurzusok}</td>
                    <td className="px-3 py-3 min-w-[260px]">
                      {t.profile_id ? (
                        <div>
                          <p className="text-xs font-black text-slate-700">{t.profile_email}</p>
                          {t.profile_name && <p className="text-[11px] font-bold text-slate-400">{t.profile_name}</p>}
                        </div>
                      ) : (
                        <select className={U_input + ' py-2'} disabled={!mayGrant}
                          value={pick[t.id] || ''}
                          onChange={e => setPick(Object.assign({}, pick, { [t.id]: e.target.value }))}>
                          <option value="">— válassz fiókot —</option>
                          {profiles.map(p => <option key={p.id} value={p.id}>{profLabel(p)}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {t.profile_id
                        ? (t.van_oktato_grant
                            ? <UBadge tone="green"><Lucide.ShieldCheck size={10} /> OKTATO</UBadge>
                            : <UBadge tone="amber"><Lucide.ShieldAlert size={10} /> nincs élő grant</UBadge>)
                        : <span className="text-[11px] font-bold text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {t.profile_id ? (
                        <button disabled={!mayGrant || busy === t.id}
                          onClick={() => doLink(t.id, null)}
                          className={U_btnGhost + ' py-2 px-3 text-xs'}>
                          <Lucide.Unlink size={13} /> Kötés bontása
                        </button>
                      ) : (
                        <button disabled={!mayGrant || busy === t.id || !pick[t.id]}
                          onClick={() => doLink(t.id, pick[t.id])}
                          className={U_btnPrimary + ' py-2 px-3 text-xs'}>
                          <Lucide.Link size={13} /> Összeköt
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- 2. ECHO-SZEREPKÖRÖK ---------- */}
      <div className="bg-white rounded-3xl border border-slate-100 p-5 mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Lucide.ShieldCheck size={16} className="text-slate-400" />
          <h3 className="font-black text-slate-900 text-sm">ECHO-szerepkör kiosztása</h3>
        </div>
        <p className="text-[11px] text-slate-400 font-medium mb-4 leading-relaxed">
          A hatókör üresen hagyva intézményi szintű. A lejárat napra pontos; üresen hagyva
          határozatlan idejű. Az iktatószám a felhatalmazó dokumentum hivatkozása — a
          jogosultság így visszakereshető marad.
        </p>

        {!mayGrant && (
          <div className="mb-4 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 text-[12px] font-bold text-amber-700">
            Ezt a listát olvashatod (MIR jog), de kiosztani nem tudsz — ahhoz admin vagy
            ECHO SYSADMIN grant kell.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-4">
          <UField label="Fiók">
            <select className={U_input} value={gPerson} onChange={e => setGPerson(e.target.value)} disabled={!mayGrant}>
              <option value="">— válassz —</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{profLabel(p)}</option>)}
            </select>
          </UField>
          <UField label="Szerepkör" hint={(ECHO_ROLE_INFO[gRole] && ECHO_ROLE_INFO[gRole].hint) || ''}>
            <select className={U_input} value={gRole} onChange={e => setGRole(e.target.value)} disabled={!mayGrant}>
              {roles.map(r => <option key={r} value={r}>{ECHO_roleLabel(r)} ({r})</option>)}
            </select>
          </UField>
          <UField label="Hatókör" hint="üres = intézményi szint">
            <select className={U_input} value={gScope} onChange={e => setGScope(e.target.value)} disabled={!mayGrant}>
              <option value="">— intézményi —</option>
              {orgs.map(o => <option key={o.id} value={o.id}>{orgLabel(o)}</option>)}
            </select>
          </UField>
          <UField label="Lejárat" hint="üres = határozatlan">
            <input type="date" className={U_input} value={gExp} onChange={e => setGExp(e.target.value)} disabled={!mayGrant} />
          </UField>
          <UField label="Iktatószám">
            <input className={U_input} value={gIkt} maxLength={64} placeholder="pl. NJE/2026/OMHV-14"
              onChange={e => setGIkt(e.target.value)} disabled={!mayGrant} />
          </UField>
          <div className="flex items-end">
            <button disabled={!mayGrant || busy === 'grant'} onClick={() => doGrant(false)}
              className={U_btnPrimary + ' w-full'}>
              <Lucide.Plus size={15} /> Kiosztás
            </button>
          </div>
        </div>

        {/* a kiosztások */}
        {(d.grantok || []).length === 0 ? (
          <p className="text-sm text-slate-400 font-bold">
            Nincs egyetlen ECHO-grant sem. Ez a rendszer alapállapota: jogosultság csak
            explicit kiosztásból keletkezik.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px]">
              <thead>
                <tr className="text-left">
                  {['Fiók', 'Szerepkör', 'Hatókör', 'Kiosztva', 'Lejár', 'Iktatószám', ''].map((h, i) => (
                    <th key={i} className="px-3 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(d.grantok || []).map(g => (
                  <tr key={g.id} className={'border-t border-slate-50 ' + (g.aktiv ? '' : 'opacity-45')}>
                    <td className="px-3 py-2.5">
                      <p className="text-xs font-black text-slate-700">{g.person_email}</p>
                      {g.person_name && <p className="text-[11px] font-bold text-slate-400">{g.person_name}</p>}
                    </td>
                    <td className="px-3 py-2.5">
                      <UBadge tone={g.aktiv ? 'violet' : 'slate'}>{ECHO_roleLabel(g.role)}</UBadge>
                    </td>
                    <td className="px-3 py-2.5 text-xs font-bold text-slate-500">{g.scope_name || 'intézményi'}</td>
                    <td className="px-3 py-2.5 text-[11px] font-bold text-slate-400">
                      {ECHO_date(g.granted_at)}<br />
                      <span className="text-slate-300">{g.granted_by_email || '—'}</span>
                    </td>
                    <td className="px-3 py-2.5 text-[11px] font-bold text-slate-400">
                      {g.expires_at ? ECHO_dateTime(g.expires_at) : 'határozatlan'}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] font-mono text-slate-400">{g.iktatoszam || '—'}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {g.aktiv && (
                        <button disabled={!mayGrant || busy === g.id} onClick={() => revokeRow(g)}
                          className={U_btnGhost + ' py-2 px-3 text-xs'}>
                          <Lucide.ShieldOff size={13} /> Visszavonás
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-slate-50 rounded-2xl px-4 py-3 flex gap-2.5">
        <Lucide.Info size={15} className="text-slate-400 flex-none mt-0.5" />
        <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
          A visszavonás NEM sortörlés: a grant lejárati ideje áll a mostani időpontra, és a
          sor megmarad — a kiosztás ténye, ideje és kiosztója auditálható marad. Minden itteni
          művelet egy sort ír az <ECHO_Src>echo.access_log</ECHO_Src>-ba. A 16-os migráció
          eredmény- és moderálási RPC-inek kapuja EGYELŐRE <ECHO_Src>public.is_admin()</ECHO_Src>
          maradt: ezek hatókörös szerepkörre cserélése külön migráció dolga, MIUTÁN a grantok
          ki vannak osztva — különben a csere pillanatában senki nem tudna moderálni.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   13. ECHO_AdminView — MIR / admin, FÜLEKKEL
   ------------------------------------------------------------
   A kampánykezelés, a kérdőívszerkesztő és a moderálás egy menüpont alatt
   marad: mindhárom ugyanahhoz a jogosultsághoz (public.is_admin()) kötött,
   és a bal oldali menü 17 meglévő eleméhez nem akarunk továbbiakat tenni.
   ------------------------------------------------------------ */

const ECHO_ADMIN_TABS = [
  { id: 'campaigns',  label: 'Kampányok',        icon: 'Megaphone' },
  { id: 'editor',     label: 'Kérdőívszerkesztő', icon: 'FileText' },
  { id: 'moderation', label: 'Moderálás',        icon: 'Flag' },
  // 0.4 szelet (19_echo_roles.sql). Azért IDE kerül, és nem új menüpontba:
  // a bal oldali menü 17 eleméhez nem teszünk továbbiakat, és a kiosztás
  // ugyanahhoz a körhöz tartozik, mint a kampánykezelés.
  { id: 'roles',      label: 'Szerepkörök',      icon: 'ShieldCheck' },
];

function ECHO_AdminView({ user }) {
  const [tab, setTab] = useState('campaigns');

  if (tab === 'campaigns') {
    return (
      <div>
        <div className="px-4 sm:px-8 pt-4 sm:pt-8 max-w-6xl mx-auto">
          <ECHO_AdminTabs tab={tab} setTab={setTab} />
        </div>
        <ECHO_CampaignsPanel user={user} />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <ECHO_AdminTabs tab={tab} setTab={setTab} />
      <div className="mb-7">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
          {tab === 'editor' ? 'Kérdőívszerkesztő'
            : tab === 'roles' ? 'ECHO-szerepkörök és oktatói kötés'
            : 'Moderálási sor'}
        </h1>
        <p className="text-sm text-slate-400 font-medium mt-1">
          {tab === 'editor'
            ? 'Sablonok, verziók, állapotgép · a szerkesztés csak piszkozatban engedett'
            : tab === 'roles'
            ? 'Oktató ↔ fiók összekötés · hatókörös, lejáró, iktatható felhatalmazás'
            : 'Szöveges válaszok érvényessége · 3. § (10) · a szöveg nem törlődik'}
        </p>
      </div>
      {tab === 'editor'     && <ECHO_Editor user={user} />}
      {tab === 'moderation' && <ECHO_ModerationView user={user} />}
      {tab === 'roles'      && <ECHO_RolesPanel user={user} />}
    </div>
  );
}

function ECHO_AdminTabs({ tab, setTab }) {
  return (
    <div className="flex flex-wrap gap-2 mb-6">
      {ECHO_ADMIN_TABS.map(t => {
        const Ic = Lucide[t.icon] || Lucide.Circle;
        const on = tab === t.id;
        return (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={'inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-black transition-all ' +
              (on ? 'bg-primary text-white shadow-lg shadow-primary/10' : 'bg-white border border-slate-100 text-slate-500 hover:text-slate-800 hover:border-slate-200')}>
            <Ic size={15} /> {t.label}
          </button>
        );
      })}
    </div>
  );
}
