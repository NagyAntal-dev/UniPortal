// ============================================================
// grants-fetch-profiles — metaadat-letöltés a törzsben lévő kutatókról
//
// Akit a törzsben már összekötöttünk egy forrással (OpenAlex-szerző vagy MTMT
// mtid), arról itt töltjük le a művek listáját, a témaprofilt és a forrás saját
// összesítőit. A 79-es és 82-es migráció RPC-in ír, service_role kulccsal — a
// grants séma a kliensek felől zárt, ETL is csak RPC-n keresztül ér hozzá.
//
// MÉRT TÉNYEK, amikre a megoldás épül (2026-09-24):
//   • OpenAlex /authors/<id>: summary_stats (h_index, i10_index,
//     2yr_mean_citedness) és topics[] — mindegyikben count + subfield/field/
//     domain, tehát a témaprofil NÉGY szintje egyetlen kérésből kijön.
//     /works?filter=author.id:<id> kurzoros lapozással, ~7,6 kB/mű.
//   • MTMT: a szerzői rekord maga adja meg a közleményjegyzék URL-jét:
//     /api/publication?cond=authors;eq;<mtid>&cond=core;eq;true — lapozás
//     size/page párral, a paging.totalPages mondja meg a végét. Egy 164
//     közleményes szerző 2,1 MB-ot ad 100-as lapmérettel, ezért 50 a lapméret
//     és kötegelve írunk, hogy ne fusson bele a worker memórialimitjébe.
//     Az Accept fejléc kötelezően a saját típus: application/json esetén 406.
//   • Egy MTMT-közlemény rekordja adja a DOI-t (identifiers[].idValue), a
//     kulcsszavakat, a független idézetszámot és az SJR-kvartilist
//     (ratings[].label ~ "sjr:Q2 (2026) ..."). A folyóirat neve a label-ben
//     van, a végére fűzött ISSN-ekkel — azokat levágjuk.
//
// MIÉRT KÖTEGEL: egy hívás alatt nem szabad 273 kutatót végigkérdezni — a
// 124 MB-os EU-fájlnál megmért WORKER_RESOURCE_LIMIT ugyanez a korlát. Ezért
// hívásonként néhány kutató (koteg), és önláncolás, ha kérik.
//
// FUTTATÁS
//   {}                                  — a soron következő 8 kutató, minden forrásból
//   { "koteg": 20, "napok": 7 }          — 20 kutató, akit 7 napnál régebben szinkronizáltunk
//   { "forras": "openalex" }             — csak az egyik forrás
//   { "csak": ["<researcher uuid>"] }    — célzottan, a szinkron-idő figyelmen kívül
//   { "lanc": true }                     — a hívás után önállóan folytatja, amíg van dolga
//   { "dry": true }                      — letölt és megszámol, de NEM ír
//
// Jogosultság: pályázati irodai jog (grants_context) VAGY x-grants-cron titok.
// Deploy: supabase functions deploy grants-fetch-profiles
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
// A leképezés külön modulban van, hogy Node-ból is mérhető legyen.
import { oaProfil, mtmtProfil } from './profil.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('GRANTS_CRON_SECRET') ?? '';
// Ennyi mű megy egy grants_works_upsert hívásban. A kérés törzse így marad
// kezelhető méretű akkor is, ha valakinek több száz közleménye van.
const IRAS_KOTEG = 100;

const varj = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ hiba: 'Csak POST.' }, 405);

  let test: Record<string, unknown> = {};
  try { test = await req.json(); } catch { /* üres törzs is jó */ }
  const koteg = Math.min(Math.max(Number(test.koteg ?? 8) || 8, 1), 40);
  const napok = Math.max(Number(test.napok ?? 7) || 0, 0);
  const maxMu = Math.min(Math.max(Number(test.max_mu ?? 300) || 300, 10), 1000);
  const forras = String(test.forras ?? 'mind');
  const csak = Array.isArray(test.csak) ? (test.csak as string[]).slice(0, 40) : null;
  const lanc = test.lanc === true;
  const dry = test.dry === true;

  if (!['mind', 'openalex', 'mtmt'].includes(forras)) {
    return json({ hiba: 'A forrás csak mind, openalex vagy mtmt lehet.' }, 400);
  }

  // --- ki hívhatja ---
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const utemezo = CRON_SECRET !== '' && (req.headers.get('x-grants-cron') ?? '') === CRON_SECRET;
  if (!utemezo) {
    if (!token) return json({ hiba: 'Hiányzó Authorization fejléc.' }, 401);
    const hivo = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await hivo.rpc('grants_context');
    if (error) return json({ hiba: 'A jogosultság nem ellenőrizhető: ' + error.message }, 401);
    if (!data || data.kezelo !== true) {
      return json({ hiba: 'Ehhez pályázati irodai jogosultság kell (grants_office).' }, 403);
    }
  }

  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const kezdet = Date.now();

  // Kiket dolgozunk fel? Célzott hívásnál a megadott kutatókat, egyébként a
  // soron következőket. A grants séma zárt, ezért ez is RPC.
  let kutatok: { id: string; openalex_id: string | null; mtmt_id: string | null }[] = [];
  {
    const { data, error } = await svc.rpc('grants_researchers_to_sync', {
      p_limit: csak ? 200 : koteg, p_napok: csak ? 0 : napok,
    });
    if (error) return json({ hiba: 'A feldolgozandó kör nem kérdezhető: ' + error.message }, 500);
    kutatok = (data ?? []) as typeof kutatok;
    if (csak) kutatok = kutatok.filter((k) => csak.includes(k.id));
    // Akinek egyik forrásból sincs azonosítója, arról nincs mit letölteni.
    kutatok = kutatok.filter((k) =>
      (forras !== 'mtmt' && k.openalex_id) || (forras !== 'openalex' && k.mtmt_id));
    kutatok = kutatok.slice(0, koteg);
  }

  if (!kutatok.length) {
    /* MIÉRT NEM TALÁL SEMMIT: metaadatot csak arról a kutatóról lehet letölteni,
       akit összekötöttünk egy forrással. A törzsbe felvitt személynek addig
       nincs openalex_id / mtmt_id mezője, amíg a párosítás és az összekötés le
       nem futott — MÉRVE 2026-09-25-én: 200 mintavett kutatóból 0-nak volt
       azonosítója, a gomb pedig „0 kutató, 0 mű" üzenettel tért vissza, ami
       úgy hangzott, mintha nem lenne mit letölteni. A válasz ezért most
       megmondja, hány kutató vár összekötésre, és mi a következő lépés. */
    const { data: ossz } = await svc.rpc('grants_researchers_to_sync', { p_limit: 200, p_napok: napok });
    const varo = ((ossz ?? []) as { openalex_id: string | null; mtmt_id: string | null }[]);
    const osszekotetlen = varo.filter((k) => !k.openalex_id && !k.mtmt_id).length;
    return json({ ok: true, feldolgozva: 0, kutato: 0, mu: 0, maradt: 0,
                  osszekotetlen,
                  /* A 87-es migráció óta a sor CSAK összekötött kutatót ad vissza,
                     tehát az „osszekotetlen" ág már csak akkor szólal meg, ha a
                     87 valamiért nincs bent. Az üres eset normál üzenete ezért
                     azt mondja meg, ami igaz: az összekötöttek adata friss —
                     akinek nincs azonosítója, az a Törzs listán a „Nincs
                     összekötött azonosító" szűrővel kereshető elő. */
                  uzenet: osszekotetlen > 0
                    ? `Nincs egyetlen ÖSSZEKÖTÖTT kutató sem: ${osszekotetlen} kutatónak nincs `
                      + 'OpenAlex- vagy MTMT-azonosítója. Metaadatot csak összekötött kutatóról lehet '
                      + 'letölteni — előbb futtasd a „Párosítás a felderítéssel", majd a '
                      + '„Névjavaslatok elfogadása" lépést.'
                    : 'Minden összekötött kutató adata friss. Akinek nincs forrásazonosítója, azt a '
                      + 'Törzs listán a „Nincs összekötött azonosító" szűrővel találod meg.',
                  masodperc: 0, dry });
  }

  let runId: number | null = null;
  if (!dry) {
    const { data, error } = await svc.rpc('grants_etl_start', {
      p_source: forras === 'mtmt' ? 'mtmt' : 'openalex',
    });
    if (error) return json({ hiba: 'A futás nem indítható: ' + error.message }, 500);
    runId = data as number;
  }

  const osszeg = { kutato: 0, mu: 0, tema: 0, metrika: 0, hiba: 0 };
  const hibak: { id: string; forras: string; hiba: string }[] = [];

  for (const k of kutatok) {
    const forrasok: [string, string][] = [];
    if (forras !== 'mtmt' && k.openalex_id) forrasok.push(['openalex', k.openalex_id]);
    if (forras !== 'openalex' && k.mtmt_id) forrasok.push(['mtmt', k.mtmt_id]);
    let sikeres = false;

    for (const [f, kulsoId] of forrasok) {
      try {
        const p = f === 'openalex' ? await oaProfil(kulsoId, maxMu) : await mtmtProfil(kulsoId, maxMu);
        if (!dry) {
          for (let i = 0; i < p.muvek.length; i += IRAS_KOTEG) {
            const { error } = await svc.rpc('grants_works_upsert', {
              p_researcher: k.id, p_forras: f, p_items: p.muvek.slice(i, i + IRAS_KOTEG),
            });
            if (error) throw new Error('művek írása: ' + error.message);
          }
          // Üres művel is fut: így a szinkron ideje akkor is frissül, ha a
          // forrás egyetlen közleményt sem adott — különben örökké újrapróbálná.
          if (!p.muvek.length) {
            const { error } = await svc.rpc('grants_works_upsert',
              { p_researcher: k.id, p_forras: f, p_items: [] });
            if (error) throw new Error('szinkron-idő frissítése: ' + error.message);
          }
          const t = await svc.rpc('grants_topics_set',
            { p_researcher: k.id, p_forras: f, p_items: p.temak });
          if (t.error) throw new Error('témák írása: ' + t.error.message);
          const m = await svc.rpc('grants_metrics_set', {
            p_researcher: k.id, p_forras: f,
            p_items: p.metrikak.filter((x) => x.szam != null || x.szoveg != null),
          });
          if (m.error) throw new Error('metrikák írása: ' + m.error.message);
        }
        osszeg.mu += p.muvek.length;
        osszeg.tema += p.temak.length;
        osszeg.metrika += p.metrikak.length;
        sikeres = true;
      } catch (e) {
        const uzenet = e instanceof Error ? e.message : String(e);
        osszeg.hiba++;
        hibak.push({ id: k.id, forras: f, hiba: uzenet.slice(0, 300) });
        // A hibát a kutatóra is rávezetjük, hogy a felületen látszódjon —
        // de csak ha egyetlen forrás sem sikerült, különben egy MTMT-hiba
        // eltakarná a jó OpenAlex-adatot.
      }
    }
    if (sikeres) osszeg.kutato++;
    else if (!dry) {
      const okok = hibak.filter((h) => h.id === k.id).map((h) => `${h.forras}: ${h.hiba}`).join(' | ');
      await svc.rpc('grants_researcher_sync_error',
        { p_researcher: k.id, p_hiba: okok.slice(0, 500) || 'ismeretlen hiba' });
    }
  }

  // Maradt-e dolgunk? Ezt a felület is kiírja, és a lánc is ettől folytatódik.
  let maradt = 0;
  {
    const { data } = await svc.rpc('grants_researchers_to_sync', { p_limit: 200, p_napok: napok });
    maradt = ((data ?? []) as { openalex_id: string | null; mtmt_id: string | null }[])
      .filter((k) => k.openalex_id || k.mtmt_id).length;
  }

  const reszletek = {
    forras, koteg: kutatok.length, ...osszeg, maradt, dry,
    masodperc: Math.round((Date.now() - kezdet) / 1000),
    hibak: hibak.slice(0, 5),
  };
  if (!dry && runId !== null) {
    await svc.rpc('grants_etl_finish', {
      p_run: runId, p_ok: osszeg.hiba === 0, p_hiba: hibak.length ? hibak[0].hiba : null,
      p_reszletek: reszletek,
    });
  }

  // Önláncolás: a válasz azonnal megy, a következő köteg a háttérben indul.
  if (lanc && maradt > 0 && !dry) {
    const folytat = async () => {
      await varj(1000);
      await fetch(`${SUPABASE_URL}/functions/v1/grants-fetch-profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'x-grants-cron': CRON_SECRET,
        },
        body: JSON.stringify({ koteg, napok, max_mu: maxMu, forras, lanc: true }),
      }).catch(() => { /* a lánc megszakadhat; a következő futás folytatja */ });
    };
    // @ts-ignore: az EdgeRuntime csak éles környezetben van
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(folytat());
  }

  return json({ ok: true, ...reszletek });
});
