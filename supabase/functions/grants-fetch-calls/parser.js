// ============================================================
// parser.js — az EU referencia-állomány FOLYAMATOS feldolgozása
//
// MIÉRT ÍGY, ÉS NEM EGYSZERŰBBEN
//   A forrás 2026-09-23-án 130 MB volt, 11 162 tétellel. Két korlát szorít:
//     • memória: a fájl egészben nem olvasható be egy Edge Functionben;
//     • CPU: az Edge Function invokációnkénti számítási kerete SZŰK. Az első
//       változat karakterenként szkennelt (zárójel-mélység + string-állapot),
//       és élesben WORKER_RESOURCE_LIMIT hibával elhasalt 5,6 másodperc után
//       (mérve). 130 millió karakter JS-ciklusban nem járható.
//
//   Ezért a mostani változat NATÍV műveletekre épül:
//     1. a tételeket a tördelés adta határolóval vágjuk (indexOf, nem ciklus);
//     2. a tétel szövegén CSAK néhány szűk minta fut (állapot, típus, határidő);
//     3. JSON.parse KIZÁRÓLAG a néhány száz érdekes tételre hívódik, nem
//        mind a 11 ezerre.
//
//   MIÉRT BIZTONSÁGOS A HATÁROLÓRA VÁGÁS: a határoló LITERÁLIS ÚJSORT
//   tartalmaz, a JSON pedig nyers újsort nem engedhet szöveg belsejében (ott
//   csak \n escape állhat). Egy cím vagy leírás tehát SOHA nem tartalmazhatja
//   a határolót — hamis vágás kizárt, nem csak valószínűtlen.
//
//   A kulcsok NEM ábécésorrendben állnak (a sorrend: type, ccm2Id, identifier,
//   title, …), ezért a tételszintű mezőket a BEHÚZÁS azonosítja: a tétel saját
//   kulcsai hat szóközzel állnak, a beágyazottak (pl. actions[].status)
//   nyolccal vagy többel.
//
// MIÉRT KÜLÖN FÁJL, ÉS MIÉRT .js: ez a modul legkockázatosabb része, ezért
// tesztelhetőnek kell lennie. Node-ból közvetlenül futtatható, a Deno pedig
// importálja.
// ============================================================

/** Ennyi napra visszamenőleg hozzuk be a LEZÁRT felhívásokat is. */
export const FRISS_ZART_NAP = 90;

/** A portál nyilvános témalapja — a felhívás leírása ott olvasható. */
export const TOPIC_URL =
  'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/';

/* A legkülső tételek határolója a forrás tördelésében (4 szóköz).
   A beágyazott objektumok 6 vagy több szóközzel állnak, ezért nem illeszkednek.
   Mérve 2026-09-23: a 4 MB-os minta 400 ilyen határolót tartalmazott, ami
   tételenként ~10 KB — egyezik a 11 162 tétel / 130 MB aránnyal. */
const SEP = '\n    }, {\n';
const VEG = '\n    } ]';

/* A TÉTELSZINTŰ kulcsok hat szóközzel vannak behúzva, a beágyazottak nyolccal
   vagy többel — ez a horgony. Mérve 2026-09-23 egy 600 KB-os mintán: 139 tétel,
   139 hatszóközös `type` és `deadlineDatesLong`, 138 hatszóközös `status`,
   szemben 69 nyolcszóközös (beágyazott, actions[].status) előfordulással.
   A kulcsok NEM ábécésorrendben állnak (a sorrend: type, ccm2Id, identifier,
   title, …), ezért a behúzás az egyetlen megbízható jel. */
const HORGONY = '(?:^|\\n)      ';
const ALLAPOT_MINTA = new RegExp(HORGONY + '"status" : \\{[^}]*"abbreviation" : "([A-Za-z]+)"');
const TIPUS_MINTA = new RegExp(HORGONY + '"type" : (\\d+)');
const HATARIDO_MINTA = new RegExp(HORGONY + '"deadlineDatesLong" : \\[([^\\]]*)\\]');

/**
 * Darabokban érkező JSON-ból kivágja azokat a tételeket, amelyek ÉRDEKESEK.
 * A szűrés már itt megtörténik, mert a kihagyott tételt nem is érdemes
 * JSON-ként értelmezni.
 *
 * @param {number} mostMs   a „most" időpont (tesztelhetőség)
 * @param {number} frissNap ennyi napra visszamenőleg kellenek a lezártak
 * @param {{kezdo?: boolean}} opts
 *        kezdo=true  → a folyam a fájl elejéről jön, a tömb fejét meg kell találni;
 *        kezdo=false → a folyam a fájl KÖZEPÉRŐL jön (byte-range szelet), ezért az
 *        első, félbevágott tételt el kell dobni: az előző szelet dolgozza fel.
 */
export function createScanner(mostMs = Date.now(), frissNap = FRISS_ZART_NAP, opts = {}) {
  const kezdo = opts.kezdo !== false;
  let buf = '';
  let started = kezdo ? false : true;
  let elsoElhagyva = kezdo ? true : false;
  let done = false;
  let hibas = 0;      // értelmezhetetlen tétel
  let olvasott = 0;   // ennyi tételt LÁTTUNK (szűrés előtt)
  let kihagyott = 0;  // ennyit a szűk minta kizárt, parse nélkül
  let horgonyHiany = 0;  // ennyinél nem illeszkedett a behúzás-horgony
  const zartHatar = mostMs - frissNap * 86400000;

  /** A tétel szövegéből eldönti, kell-e egyáltalán JSON-ként értelmezni.
      Ha a horgony NEM illeszkedik (a forrás tördelése változott), inkább
      értelmezzük a tételt, mint hogy csendben kihagyjuk: a pontos ellenőrzés
      (`kell`) így is elvégzi a szűrést, csak több CPU-ért. */
  const erdekes = (reszlet) => {
    const t = TIPUS_MINTA.exec(reszlet);
    if (!t) { horgonyHiany++; return true; }
    if (t[1] !== '1') return false;                 // közbeszerzés vagy ismeretlen
    const a = ALLAPOT_MINTA.exec(reszlet);
    if (!a) { horgonyHiany++; return true; }
    const st = a[1];
    if (st === 'Open' || st === 'Forthcoming') return true;
    if (st !== 'Closed') return false;
    // Lezárt: csak ha a határidő a friss ablakban van — enélkül a nálunk
    // nyitottként szereplő felhívás soha nem válna zárttá.
    const h = HATARIDO_MINTA.exec(reszlet);
    if (!h || !h[1].trim()) return false;
    let max = 0;
    for (const sz of h[1].split(',')) {
      const n = parseInt(sz, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max >= zartHatar;
  };

  const feldolgoz = (reszlet, ki) => {
    olvasott++;
    if (!erdekes(reszlet)) { kihagyott++; return; }
    try {
      ki.push(JSON.parse('{' + reszlet + '}'));
    } catch (_e) {
      hibas++;   // egy hibás tétel ne buktassa el az egész futást
    }
  };

  return {
    get hibasDb() { return hibas; },
    get olvasottDb() { return olvasott; },
    get kihagyottDb() { return kihagyott; },
    get horgonyHianyDb() { return horgonyHiany; },
    get vege() { return done; },

    /** @param {string} chunk @returns {object[]} a darabban befejeződött ÉRDEKES tételek */
    push(chunk) {
      const ki = [];
      if (done) return ki;
      buf += chunk;

      if (!started) {
        const k = buf.indexOf('"GrantTenderObj"');
        if (k < 0) {
          if (buf.length > 4096) buf = buf.slice(-64);
          return ki;
        }
        const b = buf.indexOf('{', buf.indexOf('[', k));
        if (b < 0) return ki;
        buf = buf.slice(b + 1);   // az első tétel nyitó kapcsos zárójelét elhagyjuk
        started = true;
      }

      // Szelet közepéről indulva az első határolóig minden az ELŐZŐ szelet
      // tétele — eldobjuk, hogy ne értelmezzünk félbevágott objektumot.
      if (!elsoElhagyva) {
        const e = buf.indexOf(SEP);
        if (e < 0) {
          if (buf.length > 8 * 1024 * 1024) {
            throw new Error('A szeletben 8 MB-on belül nincs tételhatároló.');
          }
          return ki;
        }
        buf = buf.slice(e + SEP.length);
        elsoElhagyva = true;
      }

      // Egy pozíciómutatóval haladunk, és CSAK darabonként egyszer vágjuk a
      // puffert. A tételenkénti slice V8-ban „sliced string”-et hagy maga
      // után, ami a szülő szövegre mutat, és így a memória észrevétlenül nő.
      let pos = 0;
      let idx;
      while ((idx = buf.indexOf(SEP, pos)) >= 0) {
        feldolgoz(buf.slice(pos, idx), ki);
        pos = idx + SEP.length;
      }
      if (pos > 0) buf = buf.substring(pos);

      const v = buf.indexOf(VEG);
      if (v >= 0) {
        feldolgoz(buf.slice(0, v), ki);
        done = true;
        buf = '';
        return ki;
      }

      // Ha a tördelés megváltozna, a puffer korlátlanul nőne, és a függvény
      // csendben nulla tételt töltene be. Ezt inkább hangosan elbukjuk.
      if (buf.length > 8 * 1024 * 1024) {
        throw new Error('A forrás tördelése megváltozott: 8 MB-on belül nem találtam '
                      + 'tételhatárolót. A parser.js SEP mintáját kell frissíteni.');
      }
      return ki;
    },
  };
}

/** Az EU-állapotból a katalógus állapota. */
export function allapotra(abbr) {
  switch (abbr) {
    case 'Open': return 'nyitott';
    case 'Forthcoming': return 'hamarosan';
    case 'Closed': return 'zart';
    default: return 'ismeretlen';
  }
}

/**
 * Betöltjük-e ezt a tételt? A szkenner szűk mintája már szűrt, de a
 * JSON-ná értelmezett tételen ELLENŐRIZZÜK is: a minta gyors, ez a pontos.
 */
export function kell(o, mostMs = Date.now(), frissZartNap = FRISS_ZART_NAP) {
  if (!o || o.type !== 1) return false;
  const st = o.status && o.status.abbreviation;
  if (st === 'Open' || st === 'Forthcoming') return true;
  if (st !== 'Closed') return false;
  const hat = (o.deadlineDatesLong || []).filter((h) => typeof h === 'number');
  if (!hat.length) return false;
  return Math.max(...hat) >= mostMs - frissZartNap * 86400000;
}

const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

/** Egy EU-tétel → a grants_call_upsert mezőkészlete. */
export function mapItem(o) {
  const hat = (o.deadlineDatesLong || [])
    .filter((h) => typeof h === 'number' && h > 0)
    .sort((a, b) => a - b)
    .map(iso);

  // A programDivision hierarchia: az UTOLSÓ elem a legpontosabb
  // (HORIZON → HORIZON.3 Innovative Europe → …).
  const div = Array.isArray(o.programmeDivision) ? o.programmeDivision : [];
  const utolsoDiv = div.length ? div[div.length - 1] : null;

  const akcio = Array.isArray(o.topicActions) && o.topicActions.length ? o.topicActions[0] : null;
  const tipus = akcio
    ? (akcio.abbreviation || akcio.description || null)
    : (((o.actions || [])[0] || {}).types || [{}])[0].typeOfAction || null;

  // Leírás NINCS ebben az állományban (a témalapon olvasható, arra hivatkozunk).
  // A címkék viszont keresésre és szűrésre használhatók, ezért azok kerülnek ide.
  const cimkek = [].concat(o.tags || [], o.keywords || []).filter((t) => typeof t === 'string');
  const kivonat = cimkek.length ? 'Címkék: ' + cimkek.slice(0, 12).join(', ') : null;

  return {
    azonosito: o.identifier,
    cim: o.title,
    program: (o.frameworkProgramme || {}).abbreviation || null,
    alprogram: utolsoDiv ? (utolsoDiv.description || utolsoDiv.abbreviation) : null,
    tipus,
    felhivas_azonosito: o.callIdentifier || null,
    felhivas_cim: o.callTitle || null,
    allapot: allapotra(o.status && o.status.abbreviation),
    nyitas: iso(o.plannedOpeningDateLong),
    hataridok: hat,
    kivonat,
    url: o.identifier ? TOPIC_URL + String(o.identifier).toLowerCase() : null,
    partnerkereses: o.allowPartnerSearch === true,
    // A nyers payloadból CSAK az értelmes rész: a latestInfos HTML-hírfolyama
    // és a links tömb tételenként több kilobájt, és semmit nem adnak hozzá.
    payload: {
      identifier: o.identifier,
      ccm2Id: o.ccm2Id,
      type: o.type,
      status: o.status || null,
      frameworkProgramme: o.frameworkProgramme || null,
      programmeDivision: div,
      topicActions: o.topicActions || [],
      topicMGAs: o.topicMGAs || [],
      callIdentifier: o.callIdentifier || null,
      deadlineDatesLong: o.deadlineDatesLong || [],
      plannedOpeningDateLong: o.plannedOpeningDateLong || null,
      publicationDateLong: o.publicationDateLong || null,
      tags: o.tags || [],
      keywords: o.keywords || [],
      sme: o.sme === true,
      allowPartnerSearch: o.allowPartnerSearch === true,
      _forras: 'eu_portal/grantsTenders.json',
      _betoltve: new Date().toISOString(),
    },
  };
}
