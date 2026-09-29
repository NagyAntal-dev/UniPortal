// ============================================================
// grants-fetch-calls — az EU Funding & Tenders portál betöltése
//
// MIÉRT EDGE FUNCTION: a betöltés nem felhasználói művelet, és a service_role
// kulcs soha nem kerülhet a böngészőbe. A katalógusba írni csak a service_role
// tud (77_grants_core.sql: grants_call_upsert / grants_etl_start / _finish).
//
// A FORRÁS (2026-09-23-án mérve, kulcs nélkül, sima GET):
//   https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/grantsTenders.json
//   130 MB, 11 162 tétel. Ebből 10 163 pályázat (type=1) és 999 közbeszerzés
//   (type=0). Nyitott 208, hamarosan nyíló 278 — plusz a 90 napon belül
//   lezártak (203), hogy a nálunk nyitottként szereplő felhívás valóban
//   zárttá váljon. Betöltendő tétel így ~689.
//
// MIÉRT SZELETEKBEN (mérve 2026-09-23)
//   Egy invokáció NEM tudja végigolvasni a 124 MB-ot: a tiszta olvasás is
//   WORKER_RESOURCE_LIMIT-tel elhal 40 és 124 MB között, feldolgozás nélkül.
//   A forrás nem tömörít (nincs Content-Encoding), viszont TUD byte-range
//   kérést (Accept-Ranges: bytes) és ad ETag-et. Ezért a betöltés szeletekben
//   megy: egy hívás ~16 MB-ot dolgoz fel, a felület pedig végigmegy a
//   szeleteken. A szeletek átfedéssel kérnek, és a határon lévő tételt az
//   ELŐZŐ szelet dolgozza fel (a következő eldobja a félbevágott elejét).
//
// FUTTATÁS
//   • a felületről: sb.functions.invoke('grants-fetch-calls', { body: {...} })
//     — a hívó jogosultságát a grants_context() dönti el (grants_office kell)
//   • ütemezőből: x-grants-cron: <GRANTS_CRON_SECRET>
//   • egy szelet:              { "szelet": 0, "szeletek": 8, "run": 12 }
//   • LÁNC (cronhoz): { "lanc": true } — a szelet végén a függvény maga hívja
//     a következőt, így EGY cron-bejegyzés elég, és a naplóban egy futás lesz.
//   • próbamenet írás nélkül:  { "dry": true }
//   • korlátozott menet:       { "max": 50 }
//   • csak olvasás mérése:     { "probe": "olvas", "maxMb": 20 }
//
// Deploy:  supabase functions deploy grants-fetch-calls
// Titkok:  nem kell hozzá új secret (a futtatókörnyezet adja a kulcsokat).
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createScanner, kell, mapItem } from './parser.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// A kulcsokat NEM '!'-tal vesszük át: ha egy projekten más a nevük (az új
// publishable/secret kulcsrendszer), a '!' csendben undefined-ot ad, és a
// createClient egy értelmezhetetlen 500-assal elhasal. Inkább megnevezzük.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
// Az ütemező azonosítása KÜLÖN titokkal, nem kulcs-összehasonlítással.
// MÉRVE 2026-09-23: a projekt által kiadott service_role kulcs NEM azonos azzal,
// amit a futtatókörnyezet SUPABASE_SERVICE_ROLE_KEY-ként ad — a kulcsegyezés
// tehát nem megbízható kapu. Beállítás: supabase secrets set GRANTS_CRON_SECRET=…
const CRON_SECRET = Deno.env.get('GRANTS_CRON_SECRET') ?? '';

const FORRAS = 'eu_portal';
const URL_ALAP = Deno.env.get('GRANTS_EU_URL')
  ?? 'https://ec.europa.eu/info/funding-tenders/opportunities/data/referenceData/grantsTenders.json';
const UA = Deno.env.get('GRANTS_USER_AGENT')
  ?? 'UniPortal-NJE-grants/1.0 (+https://nje.hu)';

// Egy köteg mérete. 200 tételnél a kérés törzse néhány száz kilobájt, a
// tranzakció rövid — egy elhasalt köteg nem visz magával 700 tételt.
const KOTEG = 200;

// Egy invokáció ennyi bájtot dolgoz fel. Mérve: 40 MB tiszta olvasás 4 s alatt
// rendben volt, 124 MB már WORKER_RESOURCE_LIMIT — 16 MB kényelmes tartalék.
const SZELET_BAJT = 16 * 1024 * 1024;
// Átfedés a szeletek között: egy tétel ~10 KB, ez bőven elég, hogy a határon
// álló tétel egészben megérkezzen.
const ATFEDES = 256 * 1024;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ hiba: 'Csak POST.' }, 405);

  let test: Record<string, unknown> = {};
  try { test = await req.json(); } catch { /* üres törzs is jó */ }
  const dry = test.dry === true;
  const max = typeof test.max === 'number' && test.max > 0 ? test.max : 0;

  // Melyik szakaszban vagyunk — a hibaüzenet ezt is visszaadja, hogy ne
  // „non-2xx status code” legyen a diagnózis, hanem az, hogy hol állt meg.
  let szakasz = 'indulas';

  const hianyzo: string[] = [];
  if (!SUPABASE_URL) hianyzo.push('SUPABASE_URL');
  if (!ANON_KEY) hianyzo.push('SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) hianyzo.push('SUPABASE_SERVICE_ROLE_KEY');
  if (hianyzo.length) {
    return json({ ok: false, szakasz, hiba: 'Hiányzó környezeti változó: ' + hianyzo.join(', ')
      + '. Ezeket a futtatókörnyezet adja; ha a projekt az új kulcsrendszert használja, '
      + 'a nevük más lehet.' }, 500);
  }

  // --- ki hívhatja ---
  const fejlec = req.headers.get('Authorization') ?? '';
  const token = fejlec.replace(/^Bearer\s+/i, '');
  const cronFejlec = req.headers.get('x-grants-cron') ?? '';
  const utemezo = (CRON_SECRET !== '' && cronFejlec === CRON_SECRET) || token === SERVICE_KEY;

  if (!utemezo) {
    szakasz = 'jogosultsag';
    if (!token) return json({ hiba: 'Hiányzó Authorization fejléc.', szakasz }, 401);
    // A jogosultságot NEM itt találjuk ki: a grants_context() mondja meg, és az
    // ugyanazt a három szintet (szerepkör / csoport / egyéni) nézi, mint a menü.
    const hivo = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await hivo.rpc('grants_context');
    if (error) return json({ hiba: 'A jogosultság nem ellenőrizhető: ' + error.message, szakasz }, 401);
    if (!data || data.kezelo !== true) {
      return json({ hiba: 'Ehhez pályázati irodai jogosultság kell (grants_office).', szakasz }, 403);
    }
  }

  szakasz = 'szolgaltatasi_kliens';
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- futás nyitása (csak az ELSŐ szeletnél; a többi ugyanabba naplóz) ---
  szakasz = 'futas_indul';
  const szelet = typeof test.szelet === 'number' && test.szelet >= 0 ? test.szelet : 0;
  let runId: number | null = typeof test.run === 'number' ? test.run : null;
  if (!dry && runId === null) {
    const { data, error } = await svc.rpc('grants_etl_start', { p_source: FORRAS });
    if (error) return json({ hiba: 'A futás nem indítható: ' + error.message, szakasz }, 500);
    runId = data as number;
  }

  const szamok = { olvasott: 0, kivalasztott: 0, uj: 0, modosult: 0, valtozatlan: 0, hibas_tetel: 0, koteg: 0 };
  const kezdet = Date.now();
  // Láncolt futás: a szelet végén magunkat hívjuk a következő szelettel.
  // Ehhez a cron-titok kell (a saját hívás is átmegy a kapun), és MAX 20
  // láncszem, hogy egy hibás állapot ne indítson végtelen kört.
  const lanc = test.lanc === true && CRON_SECRET !== '';
  const lancHossz = typeof test.lanc_hossz === 'number' ? test.lanc_hossz : 0;


  const koteget_kuld = async (tetelek: unknown[]) => {
    if (!tetelek.length) return;
    szamok.koteg++;
    if (dry) return;
    const { data, error } = await svc.rpc('grants_call_upsert', {
      p_source: FORRAS, p_items: tetelek, p_run: runId,
    });
    if (error) throw new Error('Betöltési hiba a ' + szamok.koteg + '. kötegnél: ' + error.message);
    szamok.uj += data?.uj ?? 0;
    szamok.modosult += data?.modosult ?? 0;
    szamok.valtozatlan += data?.valtozatlan ?? 0;
  };

  // --- MÉRŐMÓD: csak olvassuk a folyamot, semmit nem dolgozunk fel. Ezzel
  // dönthető el, hogy a letöltés vagy a feldolgozás üti-e meg az erőforrás-
  // korlátot. { "probe": "olvas", "maxMb": 20 }
  if (test.probe === 'olvas') {
    const maxMb = typeof test.maxMb === 'number' && test.maxMb > 0 ? test.maxMb : 0;
    const v = await fetch(URL_ALAP, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!v.ok || !v.body) return json({ ok: false, hiba: 'A forrás ' + v.status + ' választ adott.' }, 500);
    const r = v.body.getReader();
    let bajt = 0;
    let darab = 0;
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      bajt += value.byteLength;
      darab++;
      if (maxMb && bajt >= maxMb * 1048576) { await r.cancel(); break; }
    }
    return json({ ok: true, probe: 'olvas', bajt, mb: +(bajt / 1048576).toFixed(1), darab,
                  masodperc: Math.round((Date.now() - kezdet) / 1000) });
  }

  try {
    // --- a fájl mérete és verziója ---
    szakasz = 'fejlec';
    const fej = await fetch(URL_ALAP, { method: 'HEAD', headers: { 'User-Agent': UA } });
    if (!fej.ok) throw new Error(`A forrás HEAD kérésre ${fej.status} választ adott.`);
    const teljes = Number(fej.headers.get('content-length') || '0');
    const etag = fej.headers.get('etag') || '';
    if (!teljes) throw new Error('A forrás nem adta meg a fájl méretét (content-length).');

    const szeletek = typeof test.szeletek === 'number' && test.szeletek > 0
      ? test.szeletek
      : Math.max(1, Math.ceil(teljes / SZELET_BAJT));
    if (szelet >= szeletek) throw new Error(`Nincs ilyen szelet: ${szelet} (összesen ${szeletek}).`);

    const egy = Math.ceil(teljes / szeletek);
    const kezdoBajt = szelet * egy;
    const sajatBajt = Math.min(egy, teljes - kezdoBajt);          // ennyi tartozik ehhez a szelethez
    const vegBajt = Math.min(teljes - 1, kezdoBajt + sajatBajt + ATFEDES - 1);

    szakasz = 'letoltes';
    const valasz = await fetch(URL_ALAP, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json',
                 'Range': `bytes=${kezdoBajt}-${vegBajt}` },
    });
    if (valasz.status !== 206 && valasz.status !== 200) {
      throw new Error(`A forrás ${valasz.status} választ adott a byte-range kérésre.`);
    }
    if (!valasz.body) throw new Error('A forrás üres választ adott.');

    szakasz = 'feldolgozas';
    const olvaso = valasz.body.getReader();
    const dekoder = new TextDecoder('utf-8');
    // A szelet közepéről induló folyamnál az első, félbevágott tételt eldobjuk.
    const szkenner = createScanner(Date.now(), undefined, { kezdo: szelet === 0 });
    let puffer: unknown[] = [];
    const most = Date.now();
    let bajt = 0;

    while (true) {
      const { done, value } = await olvaso.read();
      if (done) break;
      bajt += value.byteLength;
      const tetelek = szkenner.push(dekoder.decode(value, { stream: true }));
      for (const o of tetelek) {
        szamok.olvasott++;
        if (!kell(o, most)) continue;
        puffer.push(mapItem(o));
        szamok.kivalasztott++;
        if (max && szamok.kivalasztott >= max) break;
      }
      if (puffer.length >= KOTEG) {
        await koteget_kuld(puffer);
        puffer = [];
      }
      if (max && szamok.kivalasztott >= max) { await olvaso.cancel(); break; }
      if (szkenner.vege) break;
      // A saját szakaszunkon túl már a KÖVETKEZŐ szelet tételei jönnek: megállunk.
      // A határon álló tételt még feldolgoztuk — a következő szelet pedig
      // eldobja a félbevágott elejét, így nincs kimaradás és nincs kettőzés.
      if (bajt > sajatBajt) { await olvaso.cancel(); break; }
    }
    await koteget_kuld(puffer);
    szamok.hibas_tetel = szkenner.hibasDb;
    // A szkenner SAJÁT számlálói: ezek mondják meg, hogy a szelet egyáltalán
    // látott-e tételeket. Enélkül a „0 találat” és a „nem is szkennelt”
    // megkülönböztethetetlen.
    const szkennerSzamok = { tetel_latott: szkenner.olvasottDb,
                             minta_kizart: szkenner.kihagyottDb,
                             horgony_hiany: szkenner.horgonyHianyDb };

    szakasz = 'zaras';
    const utolso = szelet >= szeletek - 1 || szkenner.vege;
    const reszletek = { ...szamok, ...szkennerSzamok, szelet, szeletek, bajt,
                        masodperc: Math.round((Date.now() - kezdet) / 1000), dry, max };
    // A naplót csak az UTOLSÓ szelet zárja le — egy betöltés = egy naplósor.
    if (!dry && utolso) {
      await svc.rpc('grants_etl_finish', { p_run: runId, p_ok: true, p_hiba: null, p_reszletek: reszletek });
    }
    // A lánc következő szemét NEM várjuk meg: a válasz azonnal megy, a hívás
    // pedig a háttérben fut tovább (EdgeRuntime.waitUntil). Ha a lánc bárhol
    // megszakad, a futás 'fut' állapotban marad, és a másnapi cron újrakezdi —
    // a betöltés idempotens, tehát ez nem okoz kárt.
    let lancolt = false;
    if (lanc && !utolso && lancHossz < 20) {
      const kovetkezoTest = { szelet: szelet + 1, szeletek, run: runId, lanc: true,
                              lanc_hossz: lancHossz + 1, ...(dry ? { dry: true } : {}) };
      const hivas = fetch(`${SUPABASE_URL}/functions/v1/grants-fetch-calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-grants-cron': CRON_SECRET,
                   'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': ANON_KEY },
        body: JSON.stringify(kovetkezoTest),
      }).catch(() => undefined);
      // @ts-ignore — a Supabase futtatókörnyezet adja
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(hivas);
      } else {
        await hivas;
      }
      lancolt = true;
    }

    return json({ ok: true, forras: FORRAS, etag, teljes, run: runId, lancolt,
                  kovetkezo: utolso ? null : szelet + 1, ...reszletek });

  } catch (e) {
    const uzenet = e instanceof Error ? e.message : String(e);
    if (!dry && runId !== null) {
      await svc.rpc('grants_etl_finish', {
        p_run: runId, p_ok: false, p_hiba: uzenet,
        p_reszletek: { ...szamok, masodperc: Math.round((Date.now() - kezdet) / 1000) },
      });
    }
    // A részeredmény megmarad: ami már betöltődött, az bent van, és a naplóban
    // látszik, hol állt meg. Így egy félbeszakadt futás nem kezdi elölről.
    return json({ ok: false, szakasz, hiba: uzenet, szelet, ...szamok,
                  masodperc: Math.round((Date.now() - kezdet) / 1000) }, 500);
  }
});
