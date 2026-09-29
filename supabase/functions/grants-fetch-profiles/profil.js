// ============================================================
// profil.js — egy kutató metaadatainak leképezése a két forrásból
//
// MIÉRT KÜLÖN FÁJL: így a leképezés Node-ból is futtatható, tehát az éles
// válaszokon MÉRHETŐ, nem csak feltételezett. A kiszolgáló (index.ts) csak az
// írást és a kötegelést végzi.
//
// MÉRT TÉNYEK (2026-09-24), amikre a leképezés épül:
//   • OpenAlex /authors/<id>: summary_stats (h_index, i10_index,
//     2yr_mean_citedness), és topics[] — mindegyikben count, subfield, field,
//     domain, tehát a témaprofil NÉGY szintje egyetlen kérésből kijön.
//     /works?filter=author.id:<id>: ~7,6 kB/mű, kurzoros lapozás.
//   • MTMT: a szerzői rekord template-je adja a közleményjegyzék pontos
//     szűrőjét: /api/publication?cond=authors;eq;<mtid>&cond=core;eq;true.
//     A lapozás size/page párral megy, a végét a paging.totalPages mondja meg.
//     Az Accept fejléc kötelezően application/vnd.mtmt2-1.0+json — sima
//     application/json esetén a szerver HTTP 406-ot ad.
//   • Egy MTMT-közlemény adja a DOI-t (identifiers[].idValue, ahol
//     source.name = 'DOI'), a kulcsszavakat, a független idézetszámot és az
//     SJR-kvartilist (ratings[].label ~ "sjr:Q2 (2026) Scopus - Finance ...").
//     A folyóirat neve a journal.label-ben van — `name` mező NINCS —, a végére
//     fűzött ISSN-ekkel, amiket levágunk.
// ============================================================

// Denóban a futtatókörnyezetből, Node-ból (mérés, teszt) üres alapértékkel.
const env = (k, alap = '') => {
  try { return (typeof Deno !== 'undefined' && Deno.env.get(k)) || alap; }
  catch { return alap; }
};
const OPENALEX_KEY = env('OPENALEX_API_KEY');
const UA = env('GRANTS_USER_AGENT',
  'UniPortal-NJE-grants/1.0 (+https://nje.hu; kecskemet.adatkozpont@gmail.com)');

export const MTMT_FEJ = { 'Accept': 'application/vnd.mtmt2-1.0+json', 'User-Agent': UA };
export const OA_FEJ = { 'Accept': 'application/json', 'User-Agent': UA };
export const MTMT_UTEM = 300;   // ms két MTMT-kérés között (nem a mi szerverünk)

/* SZERZŐI POZÍCIÓ — a séma szótára magyar: 'elso' | 'utolso' | 'kozepso' |
   'ismeretlen' (grants_work_pozicio_ck). A források angolul adják; ha a
   forrás szavát írnánk be, a CHECK az EGÉSZ köteget visszautasítja.
   MÉRVE 2026-09-25: emiatt egyetlen publikáció sem került be, miközben a
   témák és a metrikák átmentek — a felületen úgy látszott, mintha „találunk
   metaadatot, de publikációt nem". Ami nem ismerhető fel, az 'ismeretlen':
   a null is megengedett, de a kifejezett „nem tudjuk" többet mond. */
const POZICIO = { first: 'elso', last: 'utolso', middle: 'kozepso',
                  elso: 'elso', utolso: 'utolso', kozepso: 'kozepso' };
export const pozicioNev = (v) => POZICIO[String(v || '').toLowerCase()] || 'ismeretlen';
const varj = (ms) => new Promise((r) => setTimeout(r, ms));
export const MTMT_LAP = 50;   // mért: 100-as lapméret 2,1 MB/lap
export const NJE_ROR = 'https://ror.org/03n9qzd79';

/* A visszaadott alakzat (a 79/82 migráció RPC-inek szerződése):
     muvek:    [{ kulso_id, doi, cim, ev, tipus, forrasnev, idezet,
                  szerzoi_pozicio, nyelv, nyilt_hozzaferes, payload }]
     temak:    [{ szint: topic|subfield|field|domain, topic, suly, mu_db }]
     metrikak: [{ kulcs, szam? , szoveg? }]
*/

// A témaszintek súlya mindig RÉSZARÁNY, nem darabszám: így két különböző
// termelékenységű kutató profilja összehasonlítható.
export function temakSzintenkent(parok, szint, max) {
  const csoport = new Map();
  for (const p of parok) {
    const nev = (p.nev ?? '').trim();
    if (!nev) continue;
    csoport.set(nev, (csoport.get(nev) ?? 0) + (p.db || 0));
  }
  // Az összeg CSAK a megnevezett tételeket számolja: különben egy névtelen
  // sor csendben lenyomná az összes súlyt, és nem 1-re összegződnének.
  const ossz = [...csoport.values()].reduce((a, b) => a + b, 0);
  return [...csoport.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([topic, db]) => ({
      szint, topic, mu_db: db,
      suly: ossz > 0 ? Math.round((db / ossz) * 10000) / 10000 : 0,
    }));
}


export function oaUrl(ut, p) {
  const u = new URL(`https://api.openalex.org/${ut}`);
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  if (OPENALEX_KEY) u.searchParams.set('api_key', OPENALEX_KEY);
  return u.toString();
}

export async function oaKer(url) {
  const v = await fetch(url, { headers: OA_FEJ });
  if (!v.ok) throw new Error(`OpenAlex ${v.status}: ${(await v.text()).slice(0, 200)}`);
  return await v.json();
}

export async function oaProfil(oaId, maxMu) {
  const id = oaId.replace(/^https:\/\/openalex\.org\//, '');

  // 1) A szerzői rekord: összesítők és a kész témaprofil.
  const sz = await oaKer(oaUrl(`authors/${id}`, {
    select: 'id,display_name,orcid,works_count,cited_by_count,summary_stats,topics,affiliations',
  }));
  const st = sz.summary_stats ?? {};
  const metrikak = [
    { kulcs: 'mu_db', szam: sz.works_count ?? null },
    { kulcs: 'idezet', szam: sz.cited_by_count ?? null },
    { kulcs: 'h_index', szam: st.h_index ?? null },
    { kulcs: 'i10', szam: st.i10_index ?? null },
    { kulcs: 'ket_ev_atlagos_idezet', szam: st['2yr_mean_citedness'] ?? null },
  ];
  if (sz.orcid) metrikak.push({ kulcs: 'orcid', szoveg: String(sz.orcid) });

  // Mikor volt NJE-affiliációja? A pályázati irodának ez mondja meg, hogy az
  // adat a MI intézményünkhöz tartozó időszakról szól-e.
  const nje = (sz.affiliations ?? []).find((a) =>
    (a.institution?.ror ?? '') === NJE_ROR);
  if (nje?.years?.length) {
    const evek = nje.years.slice().sort((a, b) => a - b);
    metrikak.push({ kulcs: 'nje_affiliacio', szoveg: `${evek[0]}–${evek[evek.length - 1]}` });
    metrikak.push({ kulcs: 'nje_affiliacio_ev_db', szam: evek.length });
  }

  const topics = sz.topics ?? [];
  const nevbol = (v) =>
    typeof v === 'string' ? v : (v?.display_name ?? null);
  const temak = [
    ...temakSzintenkent(topics.map((t) => ({ nev: t.display_name ?? null, db: t.count ?? 0 })), 'topic', 20),
    ...temakSzintenkent(topics.map((t) => ({ nev: nevbol(t.subfield), db: t.count ?? 0 })), 'subfield', 10),
    ...temakSzintenkent(topics.map((t) => ({ nev: nevbol(t.field), db: t.count ?? 0 })), 'field', 8),
    ...temakSzintenkent(topics.map((t) => ({ nev: nevbol(t.domain), db: t.count ?? 0 })), 'domain', 4),
  ];

  // 2) A művek, kurzoros lapozással.
  const muvek = [];
  let cursor = '*';
  let lapok = 0;
  while (cursor && muvek.length < maxMu) {
    const d = await oaKer(oaUrl('works', {
      filter: `author.id:${id}`,
      'per-page': String(Math.min(200, maxMu - muvek.length)),
      cursor,
      select: 'id,doi,display_name,publication_year,type,cited_by_count,language,'
            + 'open_access,primary_location,authorships,topics',
    }));
    lapok++;
    for (const w of (d.results ?? [])) {
      const sajat = (w.authorships ?? []).find((a) =>
        String(a.author?.id ?? '').endsWith(id));
      const t0 = (w.topics ?? [])[0];
      muvek.push({
        kulso_id: String(w.id ?? '').replace(/^https:\/\/openalex\.org\//, ''),
        doi: w.doi ? String(w.doi).replace(/^https:\/\/doi\.org\//, '') : null,
        cim: w.display_name ?? null,
        ev: w.publication_year ?? null,
        tipus: w.type ?? null,
        forrasnev: w.primary_location?.source?.display_name ?? null,
        idezet: w.cited_by_count ?? null,
        szerzoi_pozicio: pozicioNev(sajat?.author_position),
        nyelv: w.language ?? null,
        nyilt_hozzaferes: w.open_access?.is_oa ?? null,
        // Szűk payload: a teljes OpenAlex-rekord ~7,6 kB, 273 kutatónál ez
        // önmagában gigabájtos nagyságrend lenne.
        payload: {
          oa_status: w.open_access?.oa_status ?? null,
          szerzo_db: (w.authorships ?? []).length,
          levelezo: (w.authorships ?? []).some((a) => a.is_corresponding === true),
          topic: t0?.display_name ?? null,
          field: nevbol(t0?.field) ?? null,
          _forras: 'openalex/works',
        },
      });
      if (muvek.length >= maxMu) break;
    }
    cursor = d.meta?.next_cursor ?? null;
    if (!(d.results ?? []).length) break;
  }

  return { muvek, temak, metrikak, lapok };
}


export async function mtmtKer(ut) {
  const v = await fetch(`https://m2.mtmt.hu/api/${ut}`, { headers: MTMT_FEJ });
  if (!v.ok) throw new Error(`MTMT ${v.status} (${ut.slice(0, 60)}): ${(await v.text()).slice(0, 160)}`);
  return await v.json();
}

// A folyóirat neve a label-ben van, a végére fűzött ISSN-ekkel:
// "INTERNATIONAL JOURNAL OF FINANCIAL STUDIES 2227-7072 2227-7072".
export function folyoiratNev(j) {
  const l = (j?.label ?? '').trim();
  if (!l) return null;
  return l.replace(/(\s+\d{4}-\d{3}[\dxX])+$/,'').trim() || null;
}

export async function mtmtProfil(mtid, maxMu) {
  // 1) Szerzői rekord: az MTMT saját összesítői a TELJES pályaműre.
  // MÉRT: az egyelemű MTMT-végpont a rekordot `content` alatt adja vissza
  // (objektumként, nem listaként) — a lapozott végpontokon a `content` lista.
  const valasz = await mtmtKer(`author/${encodeURIComponent(mtid)}`);
  const a = (valasz && valasz.content && !Array.isArray(valasz.content))
    ? valasz.content : valasz;
  const metrikak = [
    { kulcs: 'mu_db', szam: a.publicationCount ?? null },
    { kulcs: 'idezet', szam: a.citationCount ?? null },
    { kulcs: 'fuggetlen_idezet', szam: a.independentCitationCount ?? null },
    { kulcs: 'scopus_idezet', szam: a.scopusCitationCount ?? null },
    { kulcs: 'wos_idezet', szam: a.wosCitationCount ?? null },
    { kulcs: 'idezo_mu_db', szam: a.citingPubCount ?? null },
  ];
  for (const t of (a.pubStats?.types ?? [])) {
    // Csak a pályázatokban számító típusok, üres sorok nélkül.
    const kulcsok = {
      24: 'folyoiratcikk_db', 23: 'konyv_db', 25: 'konyvreszlet_db',
      31: 'konferenciakozlemeny_db', 26: 'oltalmi_forma_db', 33: 'kutatasi_adat_db',
    };
    const k = kulcsok[t.code];
    if (k && (t.count ?? 0) > 0) metrikak.push({ kulcs: k, szam: t.count });
  }
  const evek = (a.pubStats?.years ?? []).filter((y) => (y.publicationCount ?? 0) > 0)
    .map((y) => y.year);
  if (evek.length) {
    metrikak.push({ kulcs: 'elso_kozlemeny_ev', szam: Math.min(...evek) });
    metrikak.push({ kulcs: 'utolso_kozlemeny_ev', szam: Math.max(...evek) });
  }
  const terulet = (a.disciplines ?? [])[0]?.label ?? null;
  if (terulet) metrikak.push({ kulcs: 'tudomanyterulet', szoveg: String(terulet) });
  const fokozat = (a.degrees ?? [])[0]?.label ?? null;
  if (fokozat) metrikak.push({ kulcs: 'fokozat', szoveg: String(fokozat) });

  // 2) Közleményjegyzék. A szerzői rekord template-je adja meg a pontos
  //    szűrőt: cond=authors;eq;<mtid> és cond=core;eq;true.
  const muvek = [];
  const kulcsszavak = [];
  const kvartilis = new Map();
  let lap = 1;
  let lapok = 0;
  let osszLap = 1;
  while (lap <= osszLap && muvek.length < maxMu) {
    if (lap > 1) await varj(MTMT_UTEM);
    const d = await mtmtKer(
      `publication?cond=authors;eq;${encodeURIComponent(mtid)}&cond=core;eq;true`
      + `&sort=publishedYear,desc&size=${MTMT_LAP}&page=${lap}`);
    osszLap = d.paging?.totalPages ?? 1;
    lapok++;
    for (const p of (d.content ?? [])) {
      const doi = (p.identifiers ?? []).find((i) =>
        (i.source?.name ?? '') === 'DOI')?.idValue ?? null;
      const sajat = (p.authorships ?? []).find((s) =>
        String(s.author?.mtid ?? '') === String(mtid));
      const pozicio = !sajat ? 'ismeretlen'
        : sajat.first ? 'elso' : sajat.last ? 'utolso' : 'kozepso';
      const sjr = (p.ratings ?? [])
        .map((r) => /sjr:(Q[1-4])/.exec(r.label ?? '')?.[1])
        .find((q) => !!q) ?? null;
      if (sjr) kvartilis.set(sjr, (kvartilis.get(sjr) ?? 0) + 1);
      for (const k of (p.keywords ?? [])) kulcsszavak.push({ nev: k.label ?? null, db: 1 });

      muvek.push({
        kulso_id: String(p.mtid ?? ''),
        doi,
        cim: p.title ?? p.label ?? null,
        ev: p.publishedYear ?? null,
        tipus: p.type?.label ?? null,
        forrasnev: folyoiratNev(p.journal),
        idezet: p.citationCount ?? null,
        szerzoi_pozicio: pozicio,
        nyelv: (p.languages ?? [])[0]?.nameEng ?? (p.languages ?? [])[0]?.label ?? null,
        nyilt_hozzaferes: p.oaType ? p.oaType !== 'NONE' : null,
        payload: {
          kategoria: p.category?.label ?? null,
          altipus: p.subType?.name ?? null,
          fuggetlen_idezet: p.independentCitationCount ?? null,
          scopus_idezet: p.scopusCitationCount ?? null,
          sjr_kvartilis: sjr,
          szerzo_db: p.authorCount ?? null,
          levelezo: sajat?.corresponding === true,
          kotet: p.volume ?? null,
          oa_tipus: p.oaType ?? null,
          _forras: 'mtmt/publication',
        },
      });
      if (muvek.length >= maxMu) break;
    }
    lap++;
    if (!(d.content ?? []).length) break;
  }
  for (const [q, db] of kvartilis) metrikak.push({ kulcs: `${q.toLowerCase()}_db`, szam: db });

  // Témaprofil: a közlemények kulcsszavai adják a topic szintet, a szerzői
  // rekord tudományterülete a field szintet. Az MTMT-ben nincs OpenAlex-szerű
  // témahierarchia, ezért itt csak ez a két szint van — nem gyártunk hozzá
  // olyan szintet, ami az adatban nincs.
  const temak = [
    ...temakSzintenkent(kulcsszavak, 'topic', 25),
    ...(terulet ? temakSzintenkent([{ nev: String(terulet), db: 1 }], 'field', 1) : []),
  ];

  return { muvek, temak, metrikak, lapok };
}

