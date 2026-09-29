// ============================================================
// grants-discover — kik vannak az NJE-hez affiliálva?
//
// Két forrást kérdez, és a talált szerzőket a grants.discovered_author táblába
// írja (80_grants_discovery.sql). A kutatói TÖRZSBE innen csak kézi döntés
// után lép be valaki: a forrás affiliációt állít, nem munkaviszonyt.
//
// MÉRT TÉNYEK, amikre a megoldás épül (2026-09-24):
//   • OpenAlex: 727 szerző NJE-affiliációval (421-nél ez a legutolsó
//     affiliáció, 382-nek van ORCID-je). Kurzoros lapozás, 200/lap.
//   • MTMT: az `Accept: application/json` fejlécre HTTP 406-ot ad — a saját
//     típusát kell kérni (application/vnd.mtmt2-1.0+json). Az intézményi
//     lekérdezés csak a KÖZVETLENÜL a felső csomóponthoz rendelt személyeket
//     adja, ezért az intézményfát be kell járni: /api/institute/20201 →
//     children[].link → /api/divisioncontainment/<mtid> → child.mtid.
//     Így 306 egyedi szerző jön ki 12 egységből.
//
// FUTTATÁS
//   { "forras": "openalex" }              — teljes OpenAlex-felderítés
//   { "forras": "mtmt" }                  — MTMT intézményfa + szerzők
//   { "forras": "openalex", "dry": true } — nem ír, csak megszámol
//
// Jogosultság: pályázati irodai jog (grants_context) VAGY x-grants-cron titok.
// Deploy: supabase functions deploy grants-discover
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

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
// Az OpenAlex 2026 februárja óta kulcsot kér a produktív használathoz. Kulcs
// nélkül is működik kisebb napi kerettel, ezért nem kötelező.
const OPENALEX_KEY = Deno.env.get('OPENALEX_API_KEY') ?? '';

const UA = Deno.env.get('GRANTS_USER_AGENT')
  ?? 'UniPortal-NJE-grants/1.0 (+https://nje.hu; kecskemet.adatkozpont@gmail.com)';
const NJE_ROR = 'https://ror.org/03n9qzd79';
const NJE_OA = 'I4210142209';
const NJE_MTMT = 20201;
const KOTEG = 200;

const varj = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- OpenAlex ---------------- */
async function openalexSzerzok(max: number) {
  const mezok = 'id,display_name,display_name_alternatives,orcid,works_count,cited_by_count,'
              + 'summary_stats,last_known_institutions,topics';
  const ki: Record<string, unknown>[] = [];
  let cursor: string | null = '*';
  let lap = 0;
  while (cursor && ki.length < max) {
    const u = new URL('https://api.openalex.org/authors');
    u.searchParams.set('filter', `affiliations.institution.ror:${NJE_ROR}`);
    u.searchParams.set('per-page', '200');
    u.searchParams.set('select', mezok);
    u.searchParams.set('cursor', cursor);
    if (OPENALEX_KEY) u.searchParams.set('api_key', OPENALEX_KEY);
    const v = await fetch(u.toString(), { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!v.ok) throw new Error(`OpenAlex ${v.status}: ${(await v.text()).slice(0, 200)}`);
    const d = await v.json();
    lap++;
    for (const a of (d.results ?? [])) {
      const utolso = (a.last_known_institutions ?? []).some((i: { id?: string }) =>
        String(i.id ?? '').endsWith(NJE_OA));
      ki.push({
        kulso_id: String(a.id ?? '').replace(/^https:\/\/openalex\.org\//, ''),
        nev: a.display_name ?? null,
        nev_valtozatok: (a.display_name_alternatives ?? []).slice(0, 20),
        orcid: a.orcid ?? null,
        intezmeny: (a.last_known_institutions ?? [])[0]?.display_name ?? null,
        mu_db: a.works_count ?? null,
        idezet: a.cited_by_count ?? null,
        h_index: a.summary_stats?.h_index ?? null,
        utolso_affiliacio: utolso,
        // Csak a legfontosabb néhány téma: a teljes lista tételenként kilobájtos.
        temak: (a.topics ?? []).slice(0, 8).map((t: { display_name?: string; count?: number }) =>
          ({ topic: t.display_name ?? null, db: t.count ?? null })),
        payload: {
          openalex_id: a.id, orcid: a.orcid,
          last_known_institutions: (a.last_known_institutions ?? []).map(
            (i: { id?: string; display_name?: string }) => ({ id: i.id, nev: i.display_name })),
          summary_stats: a.summary_stats ?? null,
          _forras: 'openalex/authors', _felderitve: new Date().toISOString(),
        },
      });
      if (ki.length >= max) break;
    }
    cursor = d.meta?.next_cursor ?? null;
    if (cursor) await varj(200);
  }
  return { tetelek: ki, lapok: lap };
}

/* ---------------- MTMT ---------------- */
const MTMT_FEJ = {
  'User-Agent': UA,
  // MÉRVE: application/json → HTTP 406. A saját típusát kell kérni.
  'Accept': 'application/vnd.mtmt2-1.0+json',
};

async function mtmtKeres(url: string) {
  await varj(300);   // önkéntes ütemkorlát: a forrás nem közöl limitet
  const v = await fetch(url, { headers: MTMT_FEJ });
  if (!v.ok) throw new Error(`MTMT ${v.status} (${url}): ${(await v.text()).slice(0, 150)}`);
  return await v.json();
}

/** Az intézményfa: a felső csomópont és MINDEN alegysége, tetszőleges mélyen.
 *
 *  MIÉRT REKURZÍV. A korábbi változat egy szintet járt be: az NJE csomópontot
 *  és a 11 közvetlen gyerekét (karok, tudásközpontok). A valóságban a fa
 *  háromszintű — kar alatt TANSZÉK —, és sok oktató a tanszékhez van kötve,
 *  nem a karhoz. MÉRVE 2026-09-25: egy szinttel 12 egység, teljes bejárással
 *  39; az egy szintes felderítés így például a GAMFK Anyagtechnológia és
 *  Innovatív Járművek és Anyagok Tanszékének oktatóit kihagyta — köztük egy
 *  77 publikációs kutatót. A mélységkorlát csak védőháló egy körkörös fa
 *  ellen; a valódi fa három szintű.
 */
async function mtmtEgysegek() {
  const egysegek: { mtid: number; nev: string }[] = [];
  const latott = new Set<number>();
  const sor: { mtid: number; szint: number }[] = [{ mtid: NJE_MTMT, szint: 0 }];
  while (sor.length) {
    const { mtid, szint } = sor.shift()!;
    if (latott.has(mtid) || szint > 5) continue;
    latott.add(mtid);
    let inst: Record<string, unknown> | undefined;
    try {
      inst = (await mtmtKeres(`https://m2.mtmt.hu/api/institute/${mtid}?labelLang=hun`)).content;
    } catch (_e) { continue; }   // egy hibás egység ne buktassa el a felderítést
    egysegek.push({ mtid, nev: String(inst?.label ?? mtid) });
    for (const ch of ((inst?.children ?? []) as Record<string, unknown>[])) {
      const cid = String(ch.link ?? '').split('/').filter(Boolean).pop();
      if (!cid || !/^\d+$/.test(cid)) continue;
      try {
        const dc = (await mtmtKeres(`https://m2.mtmt.hu/api/divisioncontainment/${cid}?labelLang=hun`)).content;
        const gyerek = dc?.child ?? dc?.institute;
        if (gyerek?.mtid && !latott.has(Number(gyerek.mtid))) {
          sor.push({ mtid: Number(gyerek.mtid), szint: szint + 1 });
        }
      } catch (_e) { /* ugyanígy */ }
    }
  }
  return egysegek;
}

/** Az MTMT label „Bárczi Judit (Pénzügyek)" alakú: a zárójeles rész szakterület. */
function mtmtNev(a: Record<string, unknown>) {
  const cs = String(a.familyName ?? '').trim();
  const u = String(a.givenName ?? '').trim();
  if (cs && u) return { nev: `${cs} ${u}`, szakterulet: zarojeles(String(a.label ?? '')) };
  const label = String(a.label ?? '').trim();
  return { nev: label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label, szakterulet: zarojeles(label) };
}
const zarojeles = (s: string) => (s.match(/\(([^)]*)\)\s*$/) ?? [])[1] ?? null;

function mtmtOrcid(a: Record<string, unknown>) {
  for (const i of ((a.identifiers ?? []) as Record<string, unknown>[])) {
    const nev = ((i.source ?? {}) as Record<string, unknown>).name;
    if (nev === 'ORCID' && i.idValue) return String(i.idValue);
  }
  return null;
}

async function mtmtSzerzok(max: number) {
  const egysegek = await mtmtEgysegek();
  const latott = new Set<string>();
  const ki: Record<string, unknown>[] = [];
  for (const e of egysegek) {
    if (ki.length >= max) break;
    let d: Record<string, unknown>;
    try {
      d = await mtmtKeres(
        `https://m2.mtmt.hu/api/author?cond=affiliations.worksFor;in;${e.mtid}&size=200&labelLang=hun`);
    } catch (_err) { continue; }
    for (const a of ((d.content ?? []) as Record<string, unknown>[])) {
      const id = String(a.mtid ?? '');
      if (!id || latott.has(id)) continue;
      latott.add(id);
      const { nev, szakterulet } = mtmtNev(a);
      ki.push({
        kulso_id: id,
        nev,
        orcid: mtmtOrcid(a),
        intezmeny: 'Neumann János Egyetem',
        szervezeti_egyseg: e.nev,
        mu_db: a.publicationCount ?? null,
        idezet: a.citationCount ?? null,
        /* JELENLEGI AFFILIÁCIÓ. Az OpenAlexnél ez azt jelenti, hogy az NJE a
           legutolsó ismert affiliáció; az MTMT-nél viszont a lekérdezés MAGA
           szűr az NJE intézményfájára (affiliations.worksFor), tehát aki
           visszajön, az MOST is hozzánk tartozik. Enélkül a mező üres maradt,
           és a kötegelt összekötés — amely alapértelmezés szerint csak a
           jelenlegi affiliációt fogadja el — minden MTMT-sort kihagyott. */
        utolso_affiliacio: true,
        temak: szakterulet ? [{ topic: szakterulet, db: null }] : [],
        payload: {
          mtid: a.mtid, label: a.label, szakterulet,
          disciplines: a.disciplines ?? null, degrees: a.degrees ?? null,
          publicationCount: a.publicationCount ?? null,
          citationCount: a.citationCount ?? null,
          scopusCitationCount: a.scopusCitationCount ?? null,
          wosCitationCount: a.wosCitationCount ?? null,
          egyseg_mtid: e.mtid,
          _forras: 'mtmt/author', _felderitve: new Date().toISOString(),
        },
      });
      if (ki.length >= max) break;
    }
  }
  return { tetelek: ki, egysegek: egysegek.length };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ hiba: 'Csak POST.' }, 405);

  let test: Record<string, unknown> = {};
  try { test = await req.json(); } catch { /* üres törzs is jó */ }
  const forras = String(test.forras ?? 'openalex');
  const dry = test.dry === true;
  const max = typeof test.max === 'number' && test.max > 0 ? test.max : 5000;

  if (!['openalex', 'mtmt'].includes(forras)) {
    return json({ hiba: 'A forrás csak openalex vagy mtmt lehet.' }, 400);
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
  let runId: number | null = null;
  if (!dry) {
    const { data, error } = await svc.rpc('grants_etl_start', { p_source: forras });
    if (error) return json({ hiba: 'A futás nem indítható: ' + error.message }, 500);
    runId = data as number;
  }

  try {
    const eredmeny = forras === 'openalex' ? await openalexSzerzok(max) : await mtmtSzerzok(max);
    const tetelek = eredmeny.tetelek;
    const osszeg = { uj: 0, frissitve: 0, mar_osszekotve: 0 };

    if (!dry) {
      for (let i = 0; i < tetelek.length; i += KOTEG) {
        const { data, error } = await svc.rpc('grants_discovered_upsert', {
          p_forras: forras, p_items: tetelek.slice(i, i + KOTEG),
        });
        if (error) throw new Error('Betöltési hiba: ' + error.message);
        osszeg.uj += data?.uj ?? 0;
        osszeg.frissitve += data?.frissitve ?? 0;
        osszeg.mar_osszekotve += data?.mar_osszekotve ?? 0;
      }
    }

    const reszletek = {
      forras, talalt: tetelek.length, ...osszeg,
      orcid_db: tetelek.filter((t) => t.orcid).length,
      lapok: (eredmeny as { lapok?: number }).lapok ?? null,
      egysegek: (eredmeny as { egysegek?: number }).egysegek ?? null,
      masodperc: Math.round((Date.now() - kezdet) / 1000), dry,
    };
    if (!dry) {
      await svc.rpc('grants_etl_finish', {
        p_run: runId, p_ok: true, p_hiba: null, p_reszletek: reszletek,
      });
    }
    return json({ ok: true, ...reszletek });

  } catch (e) {
    const uzenet = e instanceof Error ? e.message : String(e);
    if (!dry && runId !== null) {
      await svc.rpc('grants_etl_finish', { p_run: runId, p_ok: false, p_hiba: uzenet, p_reszletek: {} });
    }
    return json({ ok: false, forras, hiba: uzenet,
                  masodperc: Math.round((Date.now() - kezdet) / 1000) }, 500);
  }
});
