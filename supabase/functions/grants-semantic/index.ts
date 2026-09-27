// ============================================================
// grants-semantic — a szemantikus illesztés adatbetöltője
// ============================================================
// MIT TÖLT BE, NÉGY LÉPÉSBEN (mind külön hívható):
//   mod: 'meta'      — absztrakt, társszerzők, nyílt hozzáférésű hivatkozás és
//                      pályázati előzmény az OpenAlexből, 50-es kötegekben
//   mod: 'beagyazas' — a megváltozott szövegű művek beágyazása (grants-ai)
//   mod: 'klaszter'  — kutatónként legfeljebb 3 témakör-vektor a művek
//                      vektoraiból (k-közép, a betöltőben)
//   mod: 'arculat'   — a nyitott felhívások 3–6 arculatra bontása (grants-ai),
//                      és az arculatok beágyazása
//   mod: 'illesztes' — a friss arculatú felhívások újrapárosítása
//   mod: 'reszletek' — beadandó dokumentumok és elvárt eredmények (KPI) az
//                      EU téma-részlet végpontjáról. `call_ids` megadásával
//                      egyetlen felhívásra is, frissességtől függetlenül —
//                      erre épül a felületen a frissítés gomb.
//   mod: 'csapat'    — csapatjavaslat MINDEN felhívásra, nem csak a megnyitottra
//   mod: 'mind'      — mind a hat, időkeretre vágva
//
// MIÉRT ITT ÉS NEM AZ ADATBÁZISBAN: a klaszterezés iteratív számítás, a
// beágyazás külső szolgáltatás. Az adatbázis azt tartja, ami eldőlt: vektort,
// klasztercímkét, súlyt. A pontozás viszont SQL — a jogosultságot és a
// rangsort nem hálózatra bízzuk.
//
// AMIT SOSEM TÁROLUNK: zárt kiadói teljes szöveget. A nyílt hozzáférésű
// művnél is csak a HIVATKOZÁST tartjuk meg — a PDF-et nem töltjük le.
//
// Jogosultság: pályázati irodai jog (grants_context) VAGY x-grants-cron titok.
// Titkok: GEMINI_API_KEY (a grants-ai használja), OPENALEX_API_KEY (opcionális).
// Deploy: supabase functions deploy grants-semantic
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-grants-cron',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('GRANTS_CRON_SECRET') ?? '';
const OPENALEX_KEY = Deno.env.get('OPENALEX_API_KEY') ?? '';
const UA = Deno.env.get('GRANTS_USER_AGENT')
  ?? 'UniPortal-NJE-grants/1.0 (+https://nje.hu; kecskemet.adatkozpont@gmail.com)';

// Egy futás időkerete. Az Edge Function-nak véges ideje van, ezért minden
// lépés megnézi, van-e még idő — és a maradékot a hívó következő köre viszi.
const IDOKERET_MS = 110_000;

const varj = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* A JWT középső szegmenséből a szerep. Csak OLVASSUK — az aláírás ellenőrzése
   a platformé (verify_jwt), ezért ide már csak érvényes token jut el. */
function jwtSzerep(token: string): string | null {
  try {
    const resz = token.split('.');
    if (resz.length !== 3) return null;
    const b64 = resz[1].replace(/-/g, '+').replace(/_/g, '/');
    const padolt = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const d = JSON.parse(atob(padolt));
    return typeof d?.role === 'string' ? d.role : null;
  } catch {
    return null;
  }
}

/* ---------- OpenAlex ---------- */
function oaUrl(ut: string, p: Record<string, string>) {
  const u = new URL(`https://api.openalex.org/${ut}`);
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  if (OPENALEX_KEY) u.searchParams.set('api_key', OPENALEX_KEY);
  return u.toString();
}

async function oaKer(url: string) {
  for (let proba = 1; proba <= 4; proba++) {
    try {
      const v = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': UA } });
      if (v.status === 429 || v.status >= 500) throw new Error('OpenAlex ' + v.status);
      if (!v.ok) throw new Error(`OpenAlex ${v.status}: ${(await v.text()).slice(0, 200)}`);
      return await v.json();
    } catch (e) {
      if (proba === 4) throw e;
      await varj(proba * 800);
    }
  }
  throw new Error('OpenAlex: elérhetetlen');
}

/* Az OpenAlex az absztraktot INVERTÁLT indexként adja (szó → pozíciók).
   Ebből áll össze a szöveg; a hiányzó pozíció nem hiba, csak rövidebb mondat. */
function absztraktBol(inv: Record<string, number[]> | null | undefined) {
  if (!inv || typeof inv !== 'object') return null;
  const helyek: string[] = [];
  for (const [szo, pozk] of Object.entries(inv)) {
    for (const p of (pozk ?? [])) if (Number.isInteger(p) && p >= 0 && p < 20000) helyek[p] = szo;
  }
  const t = helyek.filter((x) => typeof x === 'string').join(' ').replace(/\s+/g, ' ').trim();
  return t.length >= 40 ? t : null;
}

/* ---------- a modellréteg: soha nem hívunk szolgáltatót közvetlenül ---------- */
async function aiHivas(test: unknown) {
  const v = await fetch(`${SUPABASE_URL}/functions/v1/grants-ai`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_KEY}`,
      ...(CRON_SECRET ? { 'x-grants-cron': CRON_SECRET } : {}),
    },
    body: JSON.stringify(test),
  });
  const nyers = await v.text();
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(nyers); } catch { throw new Error('grants-ai: nem JSON válasz: ' + nyers.slice(0, 200)); }
  if (!v.ok || d.ok === false) throw new Error('grants-ai: ' + String(d.hiba ?? v.status));
  return d;
}

/* ---------- k-közép: kutatónként legfeljebb 3 témakör ----------
   MIÉRT NEM ÁTLAG: egy kutatónak jellemzően két-három külön területe van, és az
   életmű átlagvektora mindegyiktől távol esik — a széles életművű kutató éppen
   semmire nem illeszkedne. A vektorok egységhosszúak, ezért a koszinusz
   hasonlóság skalárszorzat, a centroidot pedig újra normáljuk. */
function dot(a: number[], b: number[]) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
function normal(v: number[]) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n === 0 ? v : v.map((x) => x / n);
}

function kozep(vektorok: number[][], k: number, korok = 12) {
  const n = vektorok.length;
  if (n === 0) return [];
  if (k >= n) return vektorok.map((v, i) => ({ kozep: v, tagok: [i] }));
  // Kezdőpontok: a legelső vektor, majd mindig a meglévőktől legtávolabbi
  // (k-means++ szellemében, de determinisztikusan — a futás legyen ismételhető).
  const kozepek: number[][] = [vektorok[0]];
  while (kozepek.length < k) {
    let best = -1, bestTav = -2;
    for (let i = 0; i < n; i++) {
      const kozelseg = Math.max(...kozepek.map((c) => dot(c, vektorok[i])));
      if (1 - kozelseg > bestTav) { bestTav = 1 - kozelseg; best = i; }
    }
    if (best < 0) break;
    kozepek.push(vektorok[best]);
  }
  let hozzarendel: number[] = new Array(n).fill(0);
  for (let kor = 0; kor < korok; kor++) {
    let valtozott = false;
    for (let i = 0; i < n; i++) {
      let bi = 0, bs = -2;
      for (let c = 0; c < kozepek.length; c++) {
        const s = dot(kozepek[c], vektorok[i]);
        if (s > bs) { bs = s; bi = c; }
      }
      if (hozzarendel[i] !== bi) { hozzarendel[i] = bi; valtozott = true; }
    }
    for (let c = 0; c < kozepek.length; c++) {
      const tagok = vektorok.filter((_, i) => hozzarendel[i] === c);
      if (!tagok.length) continue;
      const osszeg = new Array(tagok[0].length).fill(0);
      for (const v of tagok) for (let j = 0; j < osszeg.length; j++) osszeg[j] += v[j];
      kozepek[c] = normal(osszeg.map((x) => x / tagok.length));
    }
    if (!valtozott) break;
  }
  return kozepek.map((c, ci) => ({
    kozep: c,
    tagok: hozzarendel.map((h, i) => (h === ci ? i : -1)).filter((i) => i >= 0),
  })).filter((x) => x.tagok.length > 0);
}

/* A témakör emberi neve: a csoportba eső művek címeiből a leggyakoribb
   tartalmas szavak. Nem modellhívás — egy címke nem ér egy kérést. */
const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'using', 'based', 'into', 'their', 'this',
  'that', 'study', 'analysis', 'effect', 'effects', 'system', 'systems', 'method', 'methods',
  'approach', 'novel', 'new', 'review', 'case', 'data', 'model', 'models', 'application',
  'applications', 'research', 'paper', 'results', 'egy', 'the']);
function cimke(cimek: string[]) {
  const db = new Map<string, number>();
  for (const c of cimek) {
    for (const szo of String(c ?? '').toLowerCase().split(/[^0-9a-záéíóöőúüű]+/)) {
      if (szo.length < 5 || STOP.has(szo)) continue;
      db.set(szo, (db.get(szo) ?? 0) + 1);
    }
  }
  return [...db.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]).join(', ') || null;
}

/* ============================================================
   A négy lépés
   ============================================================ */

/* 1) META: absztrakt, társszerzők, OA-hivatkozás, pályázati előzmény.
   Az OpenAlex 50 művet ad egy kérésre (openalex_id OR-szűrő), tehát 9000 mű
   ~180 kérés — ez az egyetlen mód, hogy ne műenként kérdezzünk. */
async function metaLepes(sb: ReturnType<typeof createClient>, hatarido: number, limit: number) {
  const { data: sor, error } = await sb.rpc('grants_meta_queue', { p_limit: limit });
  if (error) throw new Error('grants_meta_queue: ' + error.message);
  const varo = (sor ?? []) as Array<Record<string, unknown>>;
  // Két úton kérdezünk: az OpenAlex-műveket a saját azonosítójukkal, a
  // többit (jellemzően MTMT-ből jött művek) DOI szerint. MÉRVE: a sor 88%-a
  // MTMT-sor volt, tehát a DOI-út nélkül a munka nagy része kimaradna.
  const oaSorok  = varo.filter((x) => x.forras === 'openalex' && x.kulso_id);
  const doiSorok = varo.filter((x) => !(x.forras === 'openalex' && x.kulso_id) && x.doi);
  const kotegek: Array<{ mod: 'id' | 'doi'; sorok: Array<Record<string, unknown>> }> = [];
  for (let i = 0; i < oaSorok.length; i += 50) kotegek.push({ mod: 'id', sorok: oaSorok.slice(i, i + 50) });
  for (let i = 0; i < doiSorok.length; i += 50) kotegek.push({ mod: 'doi', sorok: doiSorok.slice(i, i + 50) });

  let mu = 0, szerzo = 0, palyazat = 0, keres = 0, doi_talalat = 0, jelolt = 0;
  const palyazatok = new Map<string, Array<Record<string, unknown>>>();
  const tisztaDoi = (v: unknown) =>
    String(v ?? '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();

  for (const kt of kotegek) {
    if (Date.now() > hatarido) break;
    const koteg = kt.sorok;
    const d = await oaKer(oaUrl('works', {
      filter: kt.mod === 'id'
        ? 'openalex_id:' + koteg.map((x) => String(x.kulso_id)).join('|')
        : 'doi:' + koteg.map((x) => tisztaDoi(x.doi)).join('|'),
      'per-page': '50',
      // MÉRVE 2026-09-25: az OpenAlex a pályázati mezőt 'awards'-nak hívja
      // (a 'grants' select-mezőt elutasítja), és ad valódi FWCI-t is.
      select: 'id,doi,abstract_inverted_index,authorships,best_oa_location,awards,language,'
            + 'fwci,open_access',
    }));
    keres++;
    const szerint = new Map<string, Record<string, unknown>>();
    for (const w of (d.results ?? [])) {
      if (kt.mod === 'id') szerint.set(String(w.id ?? '').replace(/^https:\/\/openalex\.org\//, ''), w);
      else if (w.doi) szerint.set(tisztaDoi(w.doi), w);
    }

    const tetelek: Array<Record<string, unknown>> = [];
    for (const k of koteg) {
      const w = kt.mod === 'id' ? szerint.get(String(k.kulso_id)) : szerint.get(tisztaDoi(k.doi));
      if (!w) {
        // Megkérdeztük, de az OpenAlex nem ismeri. Üres tételt küldünk, hogy
        // megkapja a próbálkozás-bélyeget és kikerüljön a sorból — különben
        // minden körben újra ő állna elöl, és a többi mű nem kerülne sorra.
        tetelek.push({ work_id: k.work_id });
        continue;
      }
      if (kt.mod === 'doi') doi_talalat++;
      const abs = absztraktBol(w.abstract_inverted_index as Record<string, number[]>);
      const oa = w.best_oa_location as Record<string, unknown> | null;
      // Mezőre normált idézetesség: az OpenAlex FWCI-je (1,0 = a terület
      // átlaga). Ez teszi összemérhetővé a bölcsész és az orvos idézetszámát.
      const fwci = typeof w.fwci === 'number' ? w.fwci : null;
      tetelek.push({
        work_id: k.work_id,
        absztrakt: abs,
        absztrakt_forras: abs ? 'openalex' : null,
        // CSAK a hivatkozás: zárt kiadói PDF-et nem töltünk le és nem tárolunk.
        oa_url: (oa?.pdf_url as string) ?? (oa?.landing_page_url as string) ?? null,
        nyelv: (w.language as string) ?? null,
        idezet_norm: fwci === null ? null : Math.round(fwci * 1000) / 1000,
        szerzok: ((w.authorships ?? []) as Array<Record<string, unknown>>).slice(0, 60).map((a) => {
          const int = ((a.institutions ?? []) as Array<Record<string, unknown>>)[0];
          const szerzoObj = a.author as Record<string, unknown> | undefined;
          return {
            nev: (szerzoObj?.display_name as string) ?? '',
            openalex_id: String(szerzoObj?.id ?? '').replace(/^https:\/\/openalex\.org\//, '') || null,
            orcid: (szerzoObj?.orcid as string) ?? null,
            intezmeny: (int?.display_name as string) ?? null,
            // Külső szerzőről CSAK név és azonosító kerül be, profil nem épül belőle.
            nje: String(int?.ror ?? '').includes('03n9qzd79'),
          };
        }).filter((x) => x.nev),
      });
      szerzo += (tetelek[tetelek.length - 1].szerzok as unknown[]).length;

      for (const g of ((w.awards ?? []) as Array<Record<string, unknown>>)) {
        const rid = String(k.researcher_id);
        // A kulcs a támogató és a pályázati szám párosa: ugyanaz a pályázat
        // több művön is szerepel, és csak egyszer akarjuk bevinni.
        const kulcs = [g.funder_id, g.funder_award_id, g.id].filter(Boolean).join('|');
        if (!kulcs) continue;
        if (!palyazatok.has(rid)) palyazatok.set(rid, []);
        palyazatok.get(rid)!.push({
          forras: 'openalex', kulcs,
          cim: (g.display_name as string) ?? (g.funder_award_id as string) ?? null,
          tamogato: (g.funder_display_name as string) ?? null,
          azonosito: (g.funder_award_id as string) ?? null,
          payload: { funder_id: g.funder_id ?? null, award_id: g.id ?? null },
        });
      }
    }

    if (tetelek.length) {
      const { data: r, error: e2 } = await sb.rpc('grants_work_meta_set', { p_items: tetelek });
      if (e2) throw new Error('grants_work_meta_set: ' + e2.message);
      mu += Number((r as Record<string, number>)?.mu ?? 0);
      jelolt += Number((r as Record<string, number>)?.jelolt ?? 0);
    }
    await varj(120);
  }

  // Amit az OpenAlexből meg sem lehet kérdezni (nincs OpenAlex-azonosítója és
  // nincs DOI-ja — jellemzően MTMT-ből jött magyar nyelvű közlemény), az is
  // megkapja a próbálkozás-bélyeget. Különben minden körben ő állna elöl, és a
  // sor soha nem ürülne ki. MÉRVE: bélyeg nélkül a 9. körtől már csak ilyenek
  // jöttek vissza, körönként 500 sorral és nulla eredménnyel.
  const nemKerdezheto = varo.filter((x) =>
    !(x.forras === 'openalex' && x.kulso_id) && !x.doi);
  for (let i = 0; i < nemKerdezheto.length; i += 200) {
    if (Date.now() > hatarido) break;
    const { error: e5 } = await sb.rpc('grants_work_meta_set',
      { p_items: nemKerdezheto.slice(i, i + 200).map((x) => ({ work_id: x.work_id })) });
    if (e5) throw new Error('grants_work_meta_set (megjelölés): ' + e5.message);
  }

  for (const [rid, lista] of palyazatok) {
    if (Date.now() > hatarido) break;
    // Egy pályázat több művön is szerepel: kulcs szerint egyszer visszük be.
    const egyedi = [...new Map(lista.map((x) => [x.kulcs, x])).values()];
    const { data: r, error: e3 } = await sb.rpc('grants_researcher_grants_set',
      { p_researcher: rid, p_items: egyedi });
    if (e3) throw new Error('grants_researcher_grants_set: ' + e3.message);
    palyazat += Number((r as Record<string, number>)?.palyazat ?? 0);
  }

  return { sorban: varo.length, oa_keres: keres, mu, jelolt, szerzo, palyazat,
           azonositoval: oaSorok.length, doival: doiSorok.length, doi_talalat,
           // Erre a műre se azonosító, se DOI nincs: OpenAlexből nem hozható.
           nem_kereshato: varo.length - oaSorok.length - doiSorok.length };
}

/* 2) BEÁGYAZÁS: csak a megváltozott szövegű művek. Változatlan absztraktot soha
   nem ágyazunk be újra — ezt a tartalom-hash biztosítja a sor oldalán. */
async function beagyazasLepes(sb: ReturnType<typeof createClient>, hatarido: number, limit: number) {
  const { data: sor, error } = await sb.rpc('grants_embed_queue', { p_limit: limit });
  if (error) throw new Error('grants_embed_queue: ' + error.message);
  const varo = (sor ?? []) as Array<Record<string, unknown>>;
  let db = 0, dim = 0, keres = 0;

  for (let i = 0; i < varo.length; i += 25) {
    if (Date.now() > hatarido) break;
    const koteg = varo.slice(i, i + 25);
    // Cím ÉS absztrakt együtt: a cím a téma, az absztrakt a módszer.
    const szovegek = koteg.map((x) => `${x.cim ?? ''}\n\n${x.absztrakt ?? ''}`.trim());
    const r = await aiHivas({ beagyazas: { szovegek, celra: 'dokumentum' } });
    keres++;
    const vektorok = (r.vektorok ?? []) as number[][];
    dim = Number(r.dim ?? dim);
    const tetelek = koteg.map((x, j) => ({
      work_id: x.work_id, hash: x.hash, modell: String(r.model ?? 'ismeretlen'),
      vektor: vektorok[j] ?? [],
    })).filter((x) => x.vektor.length > 0);
    if (!tetelek.length) continue;
    const { data: ki, error: e2 } = await sb.rpc('grants_work_vector_set', { p_items: tetelek });
    if (e2) throw new Error('grants_work_vector_set: ' + e2.message);
    db += Number((ki as Record<string, number>)?.mu_vektor ?? 0);
  }
  return { sorban: varo.length, beagyazva: db, dim, ai_keres: keres };
}

/* 3) KLASZTER: kutatónként legfeljebb 3 témakör-vektor. A súly a csoport
   részaránya az életműben — ebből lesz a „súlypont" komponens. */
async function klaszterLepes(sb: ReturnType<typeof createClient>, hatarido: number, limit: number) {
  const { data: sor, error } = await sb.rpc('grants_cluster_queue', { p_limit: limit });
  if (error) throw new Error('grants_cluster_queue: ' + error.message);
  const varo = (sor ?? []) as Array<Record<string, unknown>>;
  let kutato = 0, klaszter = 0;

  for (const k of varo) {
    if (Date.now() > hatarido) break;
    const { data: muvek, error: e2 } = await sb.rpc('grants_work_vectors_get',
      { p_researcher: k.researcher_id, p_limit: 400 });
    if (e2) throw new Error('grants_work_vectors_get: ' + e2.message);
    const lista = (muvek ?? []) as Array<Record<string, unknown>>;
    const vektorok = lista.map((x) => ((x.vektor ?? []) as number[]));
    if (vektorok.length < 3) continue;

    const k3 = Math.min(3, Math.max(1, Math.floor(vektorok.length / 3)));
    const csoportok = kozep(vektorok, k3);
    const tetelek = csoportok.map((c, ci) => {
      const evek = c.tagok.map((i) => Number(lista[i].ev)).filter((x) => Number.isFinite(x) && x > 1900);
      return {
        klaszter: ci + 1,
        cimke: cimke(c.tagok.map((i) => String(lista[i].cim ?? ''))),
        suly: Math.round((c.tagok.length / vektorok.length) * 1000) / 1000,
        mu_db: c.tagok.length,
        atlag_ev: evek.length ? Math.round((evek.reduce((a, b) => a + b, 0) / evek.length) * 100) / 100 : null,
        modell: 'k-kozep',
        vektor: c.kozep,
      };
    });
    // FONTOS A SORREND. A művek klaszter-jelölése MEGY ELŐBB, a kutatói
    // vektor UTÁNA. Fordítva a jelölés frissebbre állítaná a mű vektorát,
    // mint a kutatóét, és a sor (ami épp ezt a két időbélyeget hasonlítja)
    // minden körben ugyanazt a kutatót adná vissza. MÉRVE: három kör, mindig
    // ugyanaz az 50 kutató és 114 klaszter.
    const jeloles: Array<Record<string, unknown>> = [];
    csoportok.forEach((c, ci) => {
      for (const i of c.tagok) {
        jeloles.push({ work_id: lista[i].work_id, hash: 'valtozatlan', modell: 'k-kozep',
                       klaszter: ci + 1, vektor: vektorok[i] });
      }
    });
    for (let i = 0; i < jeloles.length; i += 100) {
      const { error: e4 } = await sb.rpc('grants_work_vector_set', { p_items: jeloles.slice(i, i + 100) });
      if (e4) throw new Error('grants_work_vector_set (klaszter): ' + e4.message);
    }

    const { error: e3 } = await sb.rpc('grants_researcher_vector_set',
      { p_researcher: k.researcher_id, p_items: tetelek });
    if (e3) throw new Error('grants_researcher_vector_set: ' + e3.message);

    kutato++; klaszter += tetelek.length;
  }
  return { sorban: varo.length, kutato, klaszter };
}

/* 4) ARCULAT: a nyitott felhívások 3–6 elvárásra bontva, majd az arculatok
   beágyazása. A felhívás oldalán KÉRDÉS-beágyazást kérünk (aszimmetrikus). */
async function arculatLepes(sb: ReturnType<typeof createClient>, hatarido: number, limit: number,
                            callIds?: string[]) {
  let varo: Array<Record<string, unknown>>;
  if (callIds && callIds.length) {
    // Újragenerálás megadott felhívásokra: a sor csak az arculat NÉLKÜLIEKET
    // adja, ezért a javított kérdés nem érné el a meglévőket.
    const { data, error } = await sb.rpc('grants_match_report_etl',
      { p_limit: callIds.length, p_jelolt: 1, p_call: null });
    if (error) throw new Error('grants_match_report_etl: ' + error.message);
    const ismert = new Map<string, Record<string, unknown>>();
    for (const c of ((data ?? []) as Array<Record<string, unknown>>)) ismert.set(String(c.call_id), c);
    varo = callIds.map((id) => {
      const c = ismert.get(id) ?? {};
      return { call_id: id, cim: c.felhivas ?? null, program: c.program ?? null,
               kivonat: null, payload: {} };
    });
  } else {
    const { data: sor, error } = await sb.rpc('grants_facet_queue', { p_limit: limit });
    if (error) throw new Error('grants_facet_queue: ' + error.message);
    varo = (sor ?? []) as Array<Record<string, unknown>>;
  }
  let felhivas = 0, arculat = 0, hiba = 0;
  const hibak: string[] = [];

  for (const c of varo) {
    if (Date.now() > hatarido) break;
    try {
      const p = (c.payload ?? {}) as Record<string, unknown>;
      const r = await aiHivas({
        feladat: 'felhivas_arculatok',
        adat: {
          cim: c.cim, cim_en: c.cim_en, program: c.program, tipus: c.tipus,
          kedvezmenyezett: c.kedvezmenyezett,
          kivonat: c.kivonat,
          // A téma-részletekből jövő elvárt eredmény és hatókör a legjobb
          // forrás; ha még nincs meg, a payload, végül a kivonat marad.
          elvart_eredmeny: c.elvart_eredmeny || null,
          hatokor: c.hatokor || null,
          szoveg: String(c.elvart_eredmeny || '').concat(
                    c.hatokor ? '\n\n' + String(c.hatokor) : '').trim()
                  || String(p.description ?? p.leiras ?? p.szoveg ?? '').slice(0, 12000) || null,
        },
      });
      const lista = (((r.eredmeny ?? {}) as Record<string, unknown>).arculatok ?? []) as Array<Record<string, string>>;
      const arcok = lista.filter((x) => x && x.nev).slice(0, 6);
      if (arcok.length < 2) { hiba++; hibak.push(String(c.cim).slice(0, 60) + ': kevesebb mint két arculat'); continue; }

      // CSAK a felhívás saját (angol) szövegét ágyazzuk be. Az arculat magyar
      // neve a felületnek szól; beágyazva a magyar nyelv felé húzná a vektort,
      // és a magyar nyelvű, tárgyban távoli művek kerülnének közel.
      const be = await aiHivas({
        beagyazas: { szovegek: arcok.map((a) => (a.szoveg && a.szoveg.trim() ? a.szoveg : a.nev).trim()),
                     celra: 'kerdes' },
      });
      const vektorok = (be.vektorok ?? []) as number[][];
      const tetelek = arcok.map((a, i) => ({
        sorszam: i + 1, nev: a.nev, szoveg: a.szoveg ?? null, forras: 'modell',
        modell: String(be.model ?? ''), vektor: vektorok[i] ?? null,
      }));
      const { error: e2 } = await sb.rpc('grants_call_facet_set', { p_call: c.call_id, p_items: tetelek });
      if (e2) throw new Error('grants_call_facet_set: ' + e2.message);
      felhivas++; arculat += tetelek.length;
    } catch (e) {
      hiba++;
      hibak.push(String(c.cim).slice(0, 60) + ': ' + (e instanceof Error ? e.message : String(e)).slice(0, 120));
    }
  }
  return { sorban: varo.length, felhivas, arculat, hiba, hibak: hibak.slice(0, 5) };
}

/* 5) ILLESZTÉS: a friss arculatú felhívások újrapárosítása. Ez zárja a láncot —
   e nélkül az arculat elkészül, de találat csak akkor lesz, ha valaki megnyomja
   a gombot a felületen. */
async function illesztesLepes(sb: ReturnType<typeof createClient>, hatarido: number, limit: number) {
  const { data: sor, error } = await sb.rpc('grants_match_queue', { p_limit: limit });
  if (error) throw new Error('grants_match_queue: ' + error.message);
  const varo = (sor ?? []) as Array<Record<string, unknown>>;
  let felhivas = 0, talalat = 0, hiba = 0;
  const ures: string[] = [];
  const hibak: string[] = [];

  for (const c of varo) {
    if (Date.now() > hatarido) break;
    const { data: r, error: e2 } = await sb.rpc('grants_call_match_etl',
      { p_call: c.call_id, p_csak_nyitott: false });
    if (e2) { hiba++; if (hibak.length < 3) hibak.push(String(e2.message).slice(0, 200)); continue; }
    const d = (r ?? {}) as Record<string, unknown>;
    felhivas++;
    talalat += Number(d.talalat_db ?? 0);
    // Amelyik arculatra nincs házon belüli jelölt, az a legfontosabb kimenet:
    // oda külső partnert kell keresni.
    for (const a of ((d.ures_arculatok ?? []) as string[])) {
      ures.push(`${String(c.cim).slice(0, 40)}: ${a}`);
    }
  }
  return { sorban: varo.length, felhivas, talalat, hiba, hibak,
           ures_arculatok: ures.slice(0, 10) };
}

/* 6) CSAPAT: minden felhívásra előáll a javaslat, nem csak arra, amelyiket
   valaki megnyitotta. Így a listán is ott a név, mielőtt bárki belépne. */
async function csapatLepes(sb: ReturnType<typeof createClient>, hatarido: number, limit: number) {
  const { data: sor, error } = await sb.rpc('grants_team_queue', { p_limit: limit });
  if (error) throw new Error('grants_team_queue: ' + error.message);
  const varo = (sor ?? []) as Array<Record<string, unknown>>;
  let felhivas = 0, csapat = 0, ures = 0, hiba = 0;
  const hibak: string[] = [];

  for (const c of varo) {
    if (Date.now() > hatarido) break;
    const { data: r, error: e2 } = await sb.rpc('grants_team_suggest_etl',
      { p_call: c.call_id, p_csak_nyitott: false });
    if (e2) { hiba++; if (hibak.length < 3) hibak.push(String(e2.message).slice(0, 160)); continue; }
    const d = (r ?? {}) as Record<string, unknown>;
    const lista = (d.csapatok ?? []) as unknown[];
    felhivas++;
    csapat += lista.length;
    // „Senki nem emelkedik ki" — ez érdemi válasz, nem hiba: ezt a felhívást
    // kívülről kell építeni.
    if (!lista.length) ures++;
  }
  return { sorban: varo.length, felhivas, csapat, jelolt_nelkul: ures, hiba, hibak };
}

/* ---------- EU téma-részletek ----------
   MÉRVE 2026-09-25: a portál téma-részlet végpontja kulcs nélkül elérhető,
   felhívásonként ~45 kB, és ez tartalmazza azt, amit a tömeges állomány nem:
   a beadandó dokumentumokat névvel és linkkel, valamint az „Expected Outcome"
   és „Scope" szakaszokat — a felhívás KPI-jait. */
const HTML_ENTITAS: Record<string, string> = {
  '&nbsp;': ' ', '&#xa0;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&rsquo;': '\u2019', '&ndash;': '–', '&mdash;': '—',
};
function szovegge(html: string | null | undefined) {
  let t = String(html ?? '');
  t = t.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  for (const [k, v] of Object.entries(HTML_ENTITAS)) t = t.split(k).join(v);
  t = t.replace(/&#x?[0-9a-f]+;/gi, ' ');
  return t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/* A dokumentum fajtája a nevéből. Nem tökéletes besorolás, de az irodának ez
   mondja meg, mit keres: űrlapot, költségvetést vagy szerződésmintát. */
function dokTipus(nev: string) {
  const n = nev.toLowerCase();
  if (/application form|part a|part b/.test(n)) return 'urlap';
  if (/budget/.test(n)) return 'koltsegvetes';
  if (/evaluation form/.test(n)) return 'ertekelo';
  if (/\bmga\b|grant agreement/.test(n)) return 'szerzodes';
  if (/work programme|general annex/.test(n)) return 'munkaprogram';
  if (/guide|manual|faq|guidance/.test(n)) return 'utmutato';
  return 'egyeb';
}

/* A portál válaszát a Deno futtatókörnyezet néha nem tudja végigolvasni
   („error reading a body from connection") — ugyanaz az URL curl-lel hibátlan.
   MÉRVE: a tömörítés kikapcsolása és a bájtszintű olvasás megoldja. Az
   újrapróba azért van, mert a portál időnként lezárja a kapcsolatot. */
async function euKer(url: string) {
  let utolso = '';
  for (let proba = 1; proba <= 3; proba++) {
    try {
      const v = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          // Tömörítetlen válasz: a csonkolt gzip-folyam okozta a hibát.
          'Accept-Encoding': 'identity',
          'User-Agent': UA,
        },
      });
      if (!v.ok) throw new Error('HTTP ' + v.status);
      // Bájtszinten olvassuk, és utána dekódolunk: így a folyam végét is
      // megvárjuk, mielőtt JSON-ként értelmeznénk.
      const buf = await v.arrayBuffer();
      return JSON.parse(new TextDecoder('utf-8').decode(buf));
    } catch (e) {
      utolso = e instanceof Error ? e.message : String(e);
      if (proba < 3) await varj(proba * 700);
    }
  }
  throw new Error(utolso);
}

async function reszletekLepes(sb: ReturnType<typeof createClient>, hatarido: number, limit: number,
                              callIds?: string[]) {
  let varo: Array<Record<string, unknown>> = [];
  if (callIds && callIds.length) {
    // Kérésre indított frissítés: a frissesség nem számít, mert az iroda épp
    // most akarja látni az aktuális állapotot.
    for (const id of callIds.slice(0, 10)) {
      const { data, error } = await sb.rpc('grants_call_details_queue',
        { p_limit: 1, p_napok: 30, p_call: id });
      if (error) throw new Error('grants_call_details_queue: ' + error.message);
      for (const x of ((data ?? []) as Array<Record<string, unknown>>)) varo.push(x);
    }
  } else {
    const { data: sor, error } = await sb.rpc('grants_call_details_queue', { p_limit: limit, p_napok: 30 });
    if (error) throw new Error('grants_call_details_queue: ' + error.message);
    varo = (sor ?? []) as Array<Record<string, unknown>>;
  }
  let felhivas = 0, dok = 0, kpi = 0, hiba = 0;
  const hibak: string[] = [];

  for (const c of varo) {
    if (Date.now() > hatarido) break;
    const azon = String(c.azonosito ?? '').toLowerCase();
    if (!azon) continue;
    try {
      const j = await euKer(
        `https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/${encodeURIComponent(azon)}.json`);
      const d = (j?.TopicDetails ?? {}) as Record<string, unknown>;

      // Az „Expected Outcome" és a „Scope" egy mezőben jön, egymás után.
      const leiras = szovegge(d.description as string);
      const i = leiras.search(/\bScope\s*:/i);
      const elvart = (i > 0 ? leiras.slice(0, i) : leiras).replace(/^Expected Outcome\s*:?\s*/i, '').trim();
      const hatokor = i > 0 ? leiras.slice(i).replace(/^Scope\s*:?\s*/i, '').trim() : '';

      const felt = String(d.conditions ?? '');
      const feltSzoveg = szovegge(felt);
      const ertM = feltSzoveg.match(/Award criteria, scoring and thresholds([\s\S]{0,900})/i);
      const oldM = feltSzoveg.match(/(Proposal page limit[\s\S]{0,400})/i);

      // A dokumentumok a feltételek HTML-jében, horgonyokként állnak.
      const dokok: Array<Record<string, unknown>> = [];
      const latott = new Set<string>();
      const kezd = felt.toLowerCase().indexOf('application and evaluation forms');
      const szakasz = kezd >= 0 ? felt.slice(kezd) : felt;
      const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(szakasz)) !== null && dokok.length < 30) {
        const nev = szovegge(m[2]).slice(0, 160);
        if (!nev || latott.has(nev)) continue;
        latott.add(nev);
        dokok.push({ nev, url: m[1], tipus: dokTipus(nev), fajl: /\.(pdf|docx?|xlsx?|zip)(\?|$)/i.test(m[1]) });
      }
      // Ami csak hivatkozás egy mellékletre („described in Annex D"), az is
      // fontos az irodának — de NEM fájl, és ezt ki is mondjuk.
      for (const am of feltSzoveg.matchAll(/described in ((?:General )?Annex [A-Z])/gi)) {
        const nev = 'Hivatkozás: ' + am[1];
        if (latott.has(nev) || dokok.length >= 40) continue;
        latott.add(nev);
        dokok.push({ nev, url: null, tipus: 'munkaprogram', fajl: false,
                     megjegyzes: 'A Work Programme általános mellékletében található.' });
      }

      const { data: r, error: e2 } = await sb.rpc('grants_call_details_set', {
        p_call: c.call_id,
        p_adat: {
          elvart_eredmeny: elvart.slice(0, 20000),
          hatokor: hatokor.slice(0, 20000),
          ertekeles: (ertM ? ertM[1] : '').trim().slice(0, 4000),
          oldalkorlat: (oldM ? oldM[1] : '').trim().slice(0, 1000),
          dokumentumok: dokok,
        },
      });
      if (e2) throw new Error('grants_call_details_set: ' + e2.message);
      felhivas++;
      dok += Number((r as Record<string, number>)?.dokumentum ?? 0);
      if (elvart) kpi++;
      await varj(200);
    } catch (e) {
      hiba++;
      if (hibak.length < 3) hibak.push(String(c.cim).slice(0, 40) + ': ' + (e instanceof Error ? e.message : String(e)).slice(0, 90));
      // A hibát is eltesszük, hogy a sor ne kérdezze újra egy hónapig.
      await sb.rpc('grants_call_details_set',
        { p_call: c.call_id, p_adat: { hiba: (e instanceof Error ? e.message : String(e)).slice(0, 200) } });
    }
  }
  return { sorban: varo.length, felhivas, dokumentum: dok, kpi, hiba, hibak };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ hiba: 'Csak POST.' }, 405);
  if (!SERVICE_KEY) return json({ hiba: 'Nincs SUPABASE_SERVICE_ROLE_KEY.' }, 500);

  let test: Record<string, unknown> = {};
  try { test = await req.json(); } catch { /* üres törzs is jó */ }

  // Ki hívhatja: pályázati irodai jog VAGY az ütemező titka.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const utemezo = CRON_SECRET !== '' && (req.headers.get('x-grants-cron') ?? '') === CRON_SECRET;
  // A kulcs szöveges egyezése nem elég: a projekt tarthat legacy JWT-t és új
  // formátumú kulcsot is, és a kettő nem azonos szöveg. A JWT ALÁÍRÁSÁT a
  // platform már ellenőrizte, mire idejutunk — ezért a benne álló szerep
  // megbízható jelzés arra, hogy szolgáltatási hívás érkezett.
  const szolgaltatas = token !== '' && (token === SERVICE_KEY || jwtSzerep(token) === 'service_role');
  if (!utemezo) {
    if (!token) return json({ hiba: 'Hiányzó Authorization fejléc.' }, 401);
    if (!szolgaltatas) {
      const hivo = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data, error } = await hivo.rpc('grants_context');
      if (error) return json({ hiba: 'A jogosultság nem ellenőrizhető: ' + error.message }, 401);
      if (!data || (data as Record<string, unknown>).kezelo !== true) {
        return json({ hiba: 'Ehhez pályázati irodai jogosultság kell (grants_office).' }, 403);
      }
    }
  }

  // Az ETL a grants sémát csak service_role RPC-n keresztül éri el.
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const mod = String(test.mod ?? 'mind');
  const limit = Math.max(1, Math.min(500, Number(test.limit ?? 200)));
  const hatarido = Date.now() + IDOKERET_MS;
  const kezdet = Date.now();
  const ki: Record<string, unknown> = { ok: true, mod };

  try {
    if (mod === 'meta' || mod === 'mind') ki.meta = await metaLepes(sb, hatarido, limit);
    if (mod === 'beagyazas' || mod === 'mind') ki.beagyazas = await beagyazasLepes(sb, hatarido, limit);
    if (mod === 'klaszter' || mod === 'mind') ki.klaszter = await klaszterLepes(sb, hatarido, Math.min(50, limit));
    // A részletek MEGELŐZIK az arculatokat: a gazdagabb szövegből pontosabb
    // arculat készül, és a sorrend így egy körben hoz eredményt.
    if (mod === 'reszletek' || mod === 'mind') {
      const idk = Array.isArray((test as { call_ids?: unknown }).call_ids)
        ? ((test as { call_ids: unknown[] }).call_ids).map((x) => String(x)) : undefined;
      ki.reszletek = await reszletekLepes(sb, hatarido, Math.min(20, limit), idk);
    }
    if (mod === 'arculat' || mod === 'mind') {
      const idk = Array.isArray((test as { call_ids?: unknown }).call_ids)
        ? ((test as { call_ids: unknown[] }).call_ids).map((x) => String(x)) : undefined;
      ki.arculat = await arculatLepes(sb, hatarido, Math.min(10, limit), idk);
    }
    if (mod === 'illesztes' || mod === 'mind') ki.illesztes = await illesztesLepes(sb, hatarido, Math.min(25, limit));
    if (mod === 'csapat' || mod === 'mind') ki.csapat = await csapatLepes(sb, hatarido, Math.min(25, limit));
    if (!['meta', 'beagyazas', 'klaszter', 'reszletek', 'arculat', 'illesztes', 'csapat', 'mind'].includes(mod)) {
      return json({ hiba: 'Ismeretlen mód: ' + mod
                          + '. Lehetséges: meta, beagyazas, klaszter, reszletek, arculat, illesztes, csapat, mind.' }, 400);
    }
    // A szöveges ujjlenyomat és a társszerzőségi gráf az új absztraktokból
    // épül újra — e nélkül a token-út nem látná az új adatot.
    if (mod === 'mind' || mod === 'meta') {
      const { data: r, error: eu } = await sb.rpc('grants_semantic_rebuild_etl', { p_mit: 'mind' });
      ki.ujraepites = eu ? { hiba: eu.message } : (r ?? null);
    }
    ki.masodperc = Math.round((Date.now() - kezdet) / 1000);
    ki.idokeret_elfogyott = Date.now() > hatarido;
    return json(ki);
  } catch (e) {
    return json({ ok: false, mod, hiba: e instanceof Error ? e.message : String(e),
                  reszeredmeny: ki, masodperc: Math.round((Date.now() - kezdet) / 1000) }, 502);
  }
});
