-- ============================================================
-- 89_grants_semantic.sql — szemantikus illesztés a művek szövegéből
-- ============================================================
-- MIT AD: a művek absztraktja és társszerzői, a kutatói témakör-vektorok, a
-- felhívás arculatai, és a komponensekre bontott illesztési pontszám.
--
-- MIÉRT NEM pgvector: a doksi pgvectort írt, de itt a teljes állomány ~15 ezer
-- mű és ~1000 témakör-vektor. Ekkora halmaznál a közelítő index nem hoz semmit,
-- a kiterjesztés viszont éles DDL-t és séma-kötöttséget (extensions.vector)
-- követel. Ezért EGYSÉGHOSSZÚRA normált real[] tömböt tárolunk, és a koszinusz
-- hasonlóság sima skalárszorzat. Ha az állomány tízszereződik, a tárolás
-- változatlanul hagyása mellett is át lehet állni pgvectorra — a
-- grants.vek_dot() az egyetlen hely, amit ki kell cserélni.
--
-- KÉT ÚT EGY MOTORBAN: amíg egy kutatónak nincs beágyazása, a tartalmi
-- pontszám token-átfedésből jön (címek, témacímkék, absztraktok). Így a modul
-- ma is működik, és a beágyazás megjelenésével MAGÁTÓL pontosabb lesz. A
-- találat mindig megmondja, melyik úton keletkezett ('vektor' | 'token').
--
-- HATÁROK: a kemény jogosultsági feltételeket (határidő, országkör, konzorcium)
-- NEM a hasonlóság dönti el — azok SQL-szűrők, és a legjobb illeszkedés sem nyit
-- meg lezárt kaput. A tekintély és az illeszkedés soha nem olvad egy számba.
--
-- Futtatás után: 21_echo_harden_submit.sql újra.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Bővülő mű-adatok
-- ------------------------------------------------------------
alter table grants.researcher_work
  add column if not exists absztrakt        text,
  add column if not exists absztrakt_forras text,
  add column if not exists oa_url           text,
  add column if not exists idezet_norm      numeric(10,3),
  add column if not exists beagyazas_forras text;

comment on column grants.researcher_work.absztrakt is
  'A mű absztraktja. Ez a szemantikus illesztés alapja.';
comment on column grants.researcher_work.oa_url is
  'Nyílt hozzáférésű teljes szöveg hivatkozása. A PDF-et NEM tároljuk: zárt kiadói szöveget nem is töltünk le.';
comment on column grants.researcher_work.beagyazas_forras is
  'Mi ment be a beágyazásba: cim | cim_absztrakt | cim_absztrakt_szoveg.';

-- Társszerzők műenként. Külső (nem NJE-s) szerzőről csak név és azonosító
-- kerül be, profil nem épül belőle.
create table if not exists grants.work_author (
  work_id     uuid not null references grants.researcher_work(id) on delete cascade,
  sorszam     integer not null,
  nev         text not null,
  openalex_id text,
  orcid       text,
  intezmeny   text,
  nje         boolean not null default false,
  primary key (work_id, sorszam)
);
create index if not exists grants_work_author_oa_idx on grants.work_author (openalex_id) where openalex_id is not null;

-- Társszerzőségi gráf: a már tárolt művekből, közös DOI alapján. Nem
-- élő számítás, hanem újraépített tábla — a lefedés sokszor kérdezi.
create table if not exists grants.coauthor_edge (
  a_id       uuid not null references grants.researcher(id) on delete cascade,
  b_id       uuid not null references grants.researcher(id) on delete cascade,
  mu_db      integer not null default 0,
  utolso_ev  integer,
  frissitve  timestamptz not null default now(),
  primary key (a_id, b_id),
  constraint grants_coauthor_rend_ck check (a_id < b_id)
);

-- Pályázati előzmény. Nyilvános adat (OpenAlex works[].grants, CORDIS).
create table if not exists grants.researcher_grant (
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  forras        text not null
                  constraint grants_rgrant_forras_ck check (forras in ('openalex','cordis','kezi')),
  kulcs         text not null,
  cim           text,
  tamogato      text,
  azonosito     text,
  ev            integer,
  payload       jsonb not null default '{}'::jsonb,
  frissitve     timestamptz not null default now(),
  primary key (researcher_id, forras, kulcs)
);


-- ------------------------------------------------------------
-- 2. Vektorok
-- ------------------------------------------------------------
create table if not exists grants.work_vector (
  work_id   uuid primary key references grants.researcher_work(id) on delete cascade,
  hash      text not null,                       -- tartalom-hash: változatlan szöveget nem ágyazunk be újra
  modell    text not null,
  dim       integer not null,
  klaszter  integer,                             -- melyik kutatói témakörbe esett
  vektor    real[] not null,                     -- EGYSÉGHOSSZÚ
  frissitve timestamptz not null default now()
);
create index if not exists grants_work_vector_klaszter_idx on grants.work_vector (klaszter);

-- Kutatónként legfeljebb 3 témakör-vektor. Egy átlagvektor mindegyik
-- területtől távol esne, és a széles életművű kutató éppen semmire nem
-- illeszkedne — ezért nem átlagolunk.
create table if not exists grants.researcher_vector (
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  klaszter      integer not null,
  cimke         text,                            -- a témakör emberi neve (a legjellemzőbb címkékből)
  suly          numeric(6,3) not null default 0, -- részarány az életműben (0..1)
  mu_db         integer not null default 0,
  atlag_ev      numeric(7,2),
  modell        text,
  dim           integer,
  vektor        real[] not null,
  frissitve     timestamptz not null default now(),
  primary key (researcher_id, klaszter)
);

-- A felhívás arculatai: 3–6 külön elvárás, saját szövegrészlettel. A szöveg
-- LÁTHATÓ marad a felületen, hogy az iroda ellenőrizhesse: valóban ezt kéri a
-- felhívás.
create table if not exists grants.call_facet (
  id         uuid primary key default gen_random_uuid(),
  call_id    uuid not null references grants.call(id) on delete cascade,
  sorszam    integer not null,
  nev        text not null,
  szoveg     text,
  forras     text not null default 'modell'
               constraint grants_facet_forras_ck check (forras in ('modell','kezi')),
  modell     text,
  dim        integer,
  vektor     real[],
  created_at timestamptz not null default now(),
  constraint grants_facet_uq unique (call_id, sorszam)
);

-- A kutató szöveges ujjlenyomata: a beágyazás nélküli (token) út alapja.
create table if not exists grants.researcher_text (
  researcher_id uuid primary key references grants.researcher(id) on delete cascade,
  tokenek       text[] not null default '{}',
  mu_db         integer not null default 0,
  frissitve     timestamptz not null default now()
);

-- Az illesztés eredménye. KOMPONENSENKÉNT tárolva: egy találat így mindig
-- megmagyarázható, nem csak „87 pont".
create table if not exists grants.call_match (
  call_id       uuid not null references grants.call(id) on delete cascade,
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  facet_id      uuid not null references grants.call_facet(id) on delete cascade,
  ut            text not null
                  constraint grants_match_ut_ck check (ut in ('vektor','token')),
  tartalom      numeric(6,2) not null default 0,
  frissesseg    numeric(6,2) not null default 0,
  sulypont      numeric(6,2) not null default 0,
  tekintely     numeric(6,2) not null default 0,
  kapacitas     numeric(6,2) not null default 0,
  nyitottsag    numeric(6,2) not null default 0,
  bevonas       numeric(6,2) not null default 0,
  ossz          numeric(6,2) not null default 0,
  klaszter      integer,
  nyitott       boolean not null default false,  -- jelezte-e, hogy kérhető csapatba
  van_angol     boolean not null default false,  -- van-e angol nyelvű kimenete
  bizonyitek    jsonb not null default '[]'::jsonb,
  mikor         timestamptz not null default now(),
  primary key (call_id, researcher_id, facet_id)
);
create index if not exists grants_match_call_idx  on grants.call_match (call_id, ossz desc);
create index if not exists grants_match_res_idx   on grants.call_match (researcher_id, ossz desc);

insert into grants.setting (key, value, description) values
  ('pont_suly_tartalom',   '40', 'Az összesített illesztési pontszámban a tartalmi hasonlóság súlya.'),
  ('pont_suly_frissesseg', '12', 'A frissesség súlya.'),
  ('pont_suly_sulypont',    '8', 'A súlypont (központi vagy peremterület) súlya.'),
  ('pont_suly_tekintely',  '12', 'A tekintély súlya.'),
  ('pont_suly_kapacitas',   '8', 'A kapacitás súlya.'),
  ('pont_suly_nyitottsag',  '5', 'A nyílt hozzáférésű gyakorlat súlya.'),
  ('pont_suly_bevonas',    '15', 'A bevonási méltányosság súlya — ezzel hangolható a rotáció erőssége.'),
  ('frissesseg_felezes',    '4', 'A frissesség felezési ideje évben.'),
  ('beagyazas_modell', 'text-embedding-004', 'A beágyazó modell neve. A dimenziónak minden vektorban egyeznie kell.')
on conflict (key) do nothing;


-- ------------------------------------------------------------
-- 3. Vektor- és szövegműveletek
-- ------------------------------------------------------------
-- Egységhosszúra normálás. A tárolás mindig normált, így a koszinusz
-- hasonlóság sima skalárszorzat — ez az EGYETLEN hely, amit pgvectorra
-- átállásnál ki kell cserélni.
create or replace function grants.vek_norm(a real[])
returns real[]
language sql immutable
as $$
  select case when s.n is null or s.n = 0 then a
              else array(select (x::float8 / s.n)::real from unnest(a) x) end
    from (select sqrt(coalesce(sum(x::float8 * x::float8), 0)) n from unnest(a) x) s
$$;

create or replace function grants.vek_dot(a real[], b real[])
returns double precision
language sql immutable
as $$
  select coalesce(sum(a[i]::float8 * b[i]::float8), 0)
    from generate_subscripts(a, 1) i
   where i <= coalesce(array_length(b, 1), 0)
$$;

create or replace function grants.vek_jsonb(p jsonb)
returns real[]
language sql immutable
as $$
  select case when p is null or jsonb_typeof(p) <> 'array' then null
              else array(select x::real from jsonb_array_elements_text(p) x) end
$$;

-- Token-út: a beágyazás nélküli tartalmi pontszám alapja. Négynél rövidebb
-- szavakat elhagyunk (rag és kötőszó), így a maradék hordoz jelentést.
create or replace function grants.tokenek(p text)
returns text[]
language sql immutable
as $$
  select coalesce(array(
    select distinct t
      from unnest(regexp_split_to_array(lower(coalesce(p, '')), '[^0-9a-záéíóöőúüű]+')) t
     where length(t) >= 5), '{}'::text[])
$$;

-- Átfedés a felhívás arculatának tokenjeihez mérve: az ARCULAT a nevező, mert
-- azt kell lefedni, nem az életművet.
create or replace function grants.token_atfedes(p_kutato text[], p_arculat text[])
returns numeric
language sql immutable
as $$
  select case when coalesce(array_length(p_arculat, 1), 0) = 0 then 0
    else round(100.0 * (select count(*) from (select unnest(p_kutato) intersect select unnest(p_arculat)) t)
               / array_length(p_arculat, 1), 2) end
$$;


-- ------------------------------------------------------------
-- 4. Komponensek
-- ------------------------------------------------------------
-- Frissesség: felezési idő a beállításból (alapból 4 év).
create or replace function grants.frissesseg_pont(p_ev numeric)
returns numeric
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select case when p_ev is null then 40
    else greatest(0, least(100, round((100 * power(0.5,
           greatest(0, extract(year from now()) - p_ev)
           / greatest(1, grants.szam_beall('frissesseg_felezes', 4))))::numeric, 2))) end
$$;

-- Tekintély: a területen belüli súly. Külön komponens, hogy SOHA ne olvadjon
-- össze az illeszkedéssel — különben a pályakezdő eltűnne.
create or replace function grants.tekintely_pont(p_researcher uuid)
returns numeric
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare h integer; norm numeric; poz numeric; db integer;
begin
  h := coalesce(grants.h_index(p_researcher), 0);
  select count(*), avg(w.idezet_norm),
         100.0 * count(*) filter (where w.szerzoi_pozicio in ('elso','utolso')) / greatest(count(*), 1)
    into db, norm, poz
    from grants.researcher_work w where w.researcher_id = p_researcher;
  if coalesce(db, 0) = 0 then return 0; end if;
  return round(0.5 * least(100, h * 8)
             + 0.3 * least(100, coalesce(norm, 1) * 50)
             + 0.2 * coalesce(poz, 0), 2);
end $$;

-- Nyílt hozzáférésű gyakorlat: a Horizon elvárásaihoz illeszkedés jelzője.
create or replace function grants.nyitottsag_pont(p_researcher uuid)
returns numeric
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select case when count(*) = 0 then 0
    else round(100.0 * count(*) filter (where w.nyilt_hozzaferes) / count(*), 2) end
    from grants.researcher_work w where w.researcher_id = p_researcher
$$;

-- A magyar nyelvű művet nem büntetjük, de az EU-pályázathoz angol kimenet kell:
-- ezt KÜLÖN, látható jelzésként adjuk vissza, nem pontlevonásként.
create or replace function grants.van_angol_mu(p_researcher uuid)
returns boolean
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select exists (select 1 from grants.researcher_work w
                  where w.researcher_id = p_researcher
                    and (lower(coalesce(w.nyelv, '')) like 'en%'))
$$;


-- ------------------------------------------------------------
-- 5. Szöveges ujjlenyomat és társszerzőségi gráf újraépítése
-- ------------------------------------------------------------
create or replace function grants.researcher_text_rebuild(p_researcher uuid default null)
returns integer
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_db integer;
begin
  insert into grants.researcher_text (researcher_id, tokenek, mu_db, frissitve)
  select r.id, grants.tokenek(x.szoveg), coalesce(x.db, 0), now()
    from grants.researcher r
    cross join lateral (
      select coalesce(string_agg(coalesce(w.cim, '') || ' ' || coalesce(w.absztrakt, ''), ' '), '')
             || ' ' || coalesce((select string_agg(t.topic, ' ')
                                   from grants.researcher_topic t where t.researcher_id = r.id), '')
             || ' ' || coalesce((select string_agg(s.ertek, ' ')
                                   from grants.researcher_skill s where s.researcher_id = r.id), '') as szoveg,
             count(*) as db
        from (select w2.cim, w2.absztrakt
                from grants.researcher_work w2
               where w2.researcher_id = r.id
               order by w2.ev desc nulls last
               limit 80) w) x
   where r.allapot = 'aktiv' and (p_researcher is null or r.id = p_researcher)
  on conflict (researcher_id) do update
     set tokenek = excluded.tokenek, mu_db = excluded.mu_db, frissitve = now();
  get diagnostics v_db = row_count;
  return v_db;
end $$;

-- Az él akkor létezik, ha ugyanazon a DOI-n szerepel két NJE-s kutató. Ez
-- egyszerre mutatja a ma is működő részcsapatokat és a STRUKTURÁLIS LYUKAKAT:
-- két témában közeli egység, amely még soha nem publikált együtt.
create or replace function grants.coauthor_rebuild()
returns integer
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_db integer;
begin
  delete from grants.coauthor_edge;
  insert into grants.coauthor_edge (a_id, b_id, mu_db, utolso_ev, frissitve)
  select least(a.researcher_id, b.researcher_id), greatest(a.researcher_id, b.researcher_id),
         count(distinct lower(a.doi)), max(greatest(coalesce(a.ev, 0), coalesce(b.ev, 0))), now()
    from grants.researcher_work a
    join grants.researcher_work b
      on lower(a.doi) = lower(b.doi) and a.researcher_id < b.researcher_id
   where a.doi is not null and btrim(a.doi) <> ''
   group by least(a.researcher_id, b.researcher_id), greatest(a.researcher_id, b.researcher_id);
  get diagnostics v_db = row_count;
  return v_db;
end $$;


-- ------------------------------------------------------------
-- 6. Az illesztőmotor
-- ------------------------------------------------------------
insert into grants.setting (key, value, description) values
  ('match_min_tartalom', '5', 'Ennél kisebb tartalmi pontszámnál nem tárolunk találatot.')
on conflict (key) do nothing;

create or replace function grants.call_match_run(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare
  f record; r record;
  w_tart numeric; w_fris numeric; w_sp numeric; w_tek numeric; w_kap numeric; w_nyi numeric; w_bev numeric;
  w_ossz numeric; v_min numeric;
  v_dot double precision; v_kl integer; v_ksuly numeric; v_kev numeric;
  v_tart numeric; v_fris numeric; v_sp numeric; v_ossz numeric; v_ut text; v_biz jsonb;
  v_sor integer := 0; v_vekt integer := 0; v_tok integer := 0; v_kut integer := 0;
  v_start timestamptz := clock_timestamp();
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
  if not exists (select 1 from grants.call_facet where call_id = p_call) then
    raise exception 'GRANTS_HIBA: ehhez a felhíváshoz még nincs arculat — először arculatokra kell bontani.';
  end if;

  w_tart := grants.szam_beall('pont_suly_tartalom',   40);
  w_fris := grants.szam_beall('pont_suly_frissesseg', 12);
  w_sp   := grants.szam_beall('pont_suly_sulypont',    8);
  w_tek  := grants.szam_beall('pont_suly_tekintely',  12);
  w_kap  := grants.szam_beall('pont_suly_kapacitas',   8);
  w_nyi  := grants.szam_beall('pont_suly_nyitottsag',  5);
  w_bev  := grants.szam_beall('pont_suly_bevonas',    15);
  w_ossz := greatest(1, w_tart + w_fris + w_sp + w_tek + w_kap + w_nyi + w_bev);
  v_min  := grants.szam_beall('match_min_tartalom',    5);

  delete from grants.call_match where call_id = p_call;

  drop table if exists _arc;
  create temp table _arc as
    select cf.id, cf.nev, cf.vektor,
           grants.tokenek(coalesce(cf.nev, '') || ' ' || coalesce(cf.szoveg, '')) as tok
      from grants.call_facet cf where cf.call_id = p_call;

  -- A kutatói komponensek egyszer számolódnak, arculattól függetlenül.
  for r in select rr.id, rr.csapatkereses,
                  grants.tekintely_pont(rr.id)  as tek,
                  grants.kapacitas_pont(rr.id)  as kap,
                  grants.nyitottsag_pont(rr.id) as nyi,
                  grants.bevonas_pont(rr.id)    as bev,
                  grants.van_angol_mu(rr.id)    as angol,
                  coalesce((select t.tokenek from grants.researcher_text t
                             where t.researcher_id = rr.id), '{}'::text[]) as tok,
                  (select max(w.ev) from grants.researcher_work w where w.researcher_id = rr.id) as utolso_ev
             from grants.researcher rr
            where rr.allapot = 'aktiv' and rr.gepi_epites = true
              and (not coalesce(p_csak_nyitott, false) or rr.csapatkereses = true)
  loop
    v_kut := v_kut + 1;

    for f in select a.id, a.nev, a.vektor, a.tok from _arc a loop
      v_dot := null; v_kl := null; v_ksuly := null; v_kev := null;

      if f.vektor is not null then
        select rv.klaszter, grants.vek_dot(rv.vektor, f.vektor), rv.suly, rv.atlag_ev
          into v_kl, v_dot, v_ksuly, v_kev
          from grants.researcher_vector rv
         where rv.researcher_id = r.id
         order by grants.vek_dot(rv.vektor, f.vektor) desc
         limit 1;
      end if;

      if v_dot is not null then
        -- Vektorút: a LEGJOBB témakörhöz mérünk, nem az életmű átlagához.
        v_ut   := 'vektor';
        v_tart := round(greatest(0, least(100, v_dot * 100))::numeric, 2);
        v_fris := grants.frissesseg_pont(v_kev);
        v_sp   := round(least(100, coalesce(v_ksuly, 0) * 100), 2);
        v_vekt := v_vekt + 1;
      else
        -- Tokenút: amíg nincs beágyazás. A súlypont nem mérhető, ezért semleges.
        v_ut   := 'token';
        v_tart := grants.token_atfedes(r.tok, f.tok);
        v_fris := grants.frissesseg_pont(r.utolso_ev);
        v_sp   := 50;
        v_tok  := v_tok + 1;
      end if;

      continue when v_tart < v_min;

      if v_ut = 'vektor' then
        select coalesce(jsonb_agg(jsonb_build_object('cim', z.cim, 'ev', z.ev, 'doi', z.doi,
                                                    'hasonlosag', round((z.d * 100)::numeric, 1))
                                  order by z.d desc), '[]'::jsonb)
          into v_biz
          from (select w.cim, w.ev, w.doi, grants.vek_dot(wv.vektor, f.vektor) as d
                  from grants.researcher_work w
                  join grants.work_vector wv on wv.work_id = w.id
                 where w.researcher_id = r.id
                   and (v_kl is null or wv.klaszter is null or wv.klaszter = v_kl)
                 order by grants.vek_dot(wv.vektor, f.vektor) desc
                 limit 3) z;
      else
        select coalesce(jsonb_agg(jsonb_build_object('cim', z.cim, 'ev', z.ev, 'doi', z.doi)
                                  order by z.ev desc nulls last), '[]'::jsonb)
          into v_biz
          from (select w.cim, w.ev, w.doi from grants.researcher_work w
                 where w.researcher_id = r.id order by w.ev desc nulls last limit 3) z;
      end if;

      v_ossz := round((w_tart * v_tart + w_fris * v_fris + w_sp * v_sp + w_tek * r.tek
                     + w_kap * r.kap + w_nyi * r.nyi + w_bev * r.bev) / w_ossz, 2);

      insert into grants.call_match (call_id, researcher_id, facet_id, ut, tartalom, frissesseg,
                                     sulypont, tekintely, kapacitas, nyitottsag, bevonas, ossz,
                                     klaszter, nyitott, van_angol, bizonyitek, mikor)
      values (p_call, r.id, f.id, v_ut, v_tart, v_fris, v_sp, r.tek, r.kap, r.nyi, r.bev, v_ossz,
              v_kl, coalesce(r.csapatkereses, false), coalesce(r.angol, false), v_biz, now());
      v_sor := v_sor + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'call_id', p_call,
    'arculat_db', (select count(*) from _arc),
    'kutato_db', v_kut,
    'talalat_db', v_sor,
    'vektor_par', v_vekt,
    'token_par', v_tok,
    -- EZ A LEGFONTOSABB KIMENET: amelyik arculatra nincs házon belüli jelölt,
    -- oda külső partnert kell keresni.
    'ures_arculatok', (select coalesce(jsonb_agg(a.nev order by a.nev), '[]'::jsonb) from _arc a
                        where not exists (select 1 from grants.call_match m
                                           where m.call_id = p_call and m.facet_id = a.id)),
    'ido_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric, 1));
end $$;


-- ------------------------------------------------------------
-- 7. ETL: mit kell letölteni, és hova kerül
-- ------------------------------------------------------------
create or replace function grants.mu_hash(p_cim text, p_abs text)
returns text
language sql immutable
as $$ select md5(coalesce(btrim(p_cim), '') || '|' || coalesce(btrim(p_abs), '')) $$;

-- Beágyazási sor: csak az, aminek van absztraktja (a cím önmagában kevés
-- jelentést hordoz a ráfordításhoz), és aminek a szövege MEGVÁLTOZOTT.
-- Változatlan absztraktot soha nem ágyazunk be újra.
create or replace function public.grants_embed_queue(p_limit integer default 200)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.ev desc nulls last), '[]'::jsonb)
    from (select w.ev,
                 jsonb_build_object('work_id', w.id, 'researcher_id', w.researcher_id,
                                    'cim', w.cim, 'absztrakt', w.absztrakt, 'ev', w.ev,
                                    'hash', grants.mu_hash(w.cim, w.absztrakt)) as sor
            from grants.researcher_work w
            left join grants.work_vector v on v.work_id = w.id
           where w.absztrakt is not null
             and length(btrim(w.absztrakt)) >= 80
             and (v.work_id is null or v.hash <> grants.mu_hash(w.cim, w.absztrakt))
           order by w.ev desc nulls last
           limit least(greatest(coalesce(p_limit, 200), 1), 500)) t
$$;

create or replace function public.grants_work_vector_set(p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; v_db integer := 0; v_vek real[];
begin
  for it in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_vek := grants.vek_jsonb(it->'vektor');
    continue when v_vek is null or coalesce(array_length(v_vek, 1), 0) = 0;
    insert into grants.work_vector (work_id, hash, modell, dim, klaszter, vektor, frissitve)
    values ((it->>'work_id')::uuid,
            coalesce(nullif(it->>'hash',''), 'nincs'),
            coalesce(nullif(it->>'modell',''), 'ismeretlen'),
            array_length(v_vek, 1),
            nullif(it->>'klaszter','')::integer,
            grants.vek_norm(v_vek), now())
    on conflict (work_id) do update
       set hash = excluded.hash, modell = excluded.modell, dim = excluded.dim,
           klaszter = coalesce(excluded.klaszter, work_vector.klaszter),
           vektor = excluded.vektor, frissitve = now();
    v_db := v_db + 1;
  end loop;
  return jsonb_build_object('mu_vektor', v_db);
end $$;

-- Klaszterezési sor: akinek legalább 3 beágyazott műve van, és a művei
-- frissebbek, mint a témakör-vektorai.
create or replace function public.grants_cluster_queue(p_limit integer default 50)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('researcher_id', t.id, 'nev', t.nev, 'mu_db', t.db)
                            order by t.db desc), '[]'::jsonb)
    from (select r.id, r.nev, count(v.work_id) db,
                 max(v.frissitve) mu_frissitve,
                 (select max(rv.frissitve) from grants.researcher_vector rv where rv.researcher_id = r.id) vek_frissitve
            from grants.researcher r
            join grants.researcher_work w on w.researcher_id = r.id
            join grants.work_vector v     on v.work_id = w.id
           where r.allapot = 'aktiv' and r.gepi_epites = true
           group by r.id, r.nev
          having count(v.work_id) >= 3
             and ((select max(rv.frissitve) from grants.researcher_vector rv
                    where rv.researcher_id = r.id) is null
                  or max(v.frissitve) > (select max(rv.frissitve) from grants.researcher_vector rv
                                          where rv.researcher_id = r.id))
          order by count(v.work_id) desc
           limit least(greatest(coalesce(p_limit, 50), 1), 200)) t
$$;

-- A kutató témakör-vektorai. Kutatónként legfeljebb 3: a betöltő klaszterez, a
-- tábla csak az eredményt tartja.
create or replace function public.grants_researcher_vector_set(p_researcher uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; v_db integer := 0; v_vek real[]; v_kl integer;
begin
  if p_researcher is null then raise exception 'GRANTS_HIBA: a kutató azonosítója kötelező.'; end if;
  delete from grants.researcher_vector where researcher_id = p_researcher;
  for it in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_vek := grants.vek_jsonb(it->'vektor');
    continue when v_vek is null or coalesce(array_length(v_vek, 1), 0) = 0;
    v_kl := coalesce(nullif(it->>'klaszter','')::integer, v_db + 1);
    insert into grants.researcher_vector (researcher_id, klaszter, cimke, suly, mu_db, atlag_ev,
                                          modell, dim, vektor, frissitve)
    values (p_researcher, v_kl,
            nullif(btrim(coalesce(it->>'cimke','')),''),
            least(1, greatest(0, coalesce(nullif(it->>'suly','')::numeric, 0))),
            coalesce(nullif(it->>'mu_db','')::integer, 0),
            nullif(it->>'atlag_ev','')::numeric,
            nullif(it->>'modell',''),
            array_length(v_vek, 1),
            grants.vek_norm(v_vek), now())
    on conflict (researcher_id, klaszter) do update
       set cimke = excluded.cimke, suly = excluded.suly, mu_db = excluded.mu_db,
           atlag_ev = excluded.atlag_ev, vektor = excluded.vektor, frissitve = now();
    v_db := v_db + 1;
  end loop;
  -- A művek klaszter-jelölését a grants_work_vector_set írja (klaszter kulcs):
  -- így a bizonyíték a találatot adó témakörből jön, nem az életmű egészéből.
  return jsonb_build_object('klaszter_db', v_db);
end $$;

-- Absztrakt, nyílt hozzáférés, társszerzők, mezőre normált idézet.
create or replace function public.grants_work_meta_set(p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; sz jsonb; v_mu integer := 0; v_sz integer := 0; v_id uuid; v_i integer;
begin
  for it in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_id := nullif(it->>'work_id','')::uuid;
    continue when v_id is null;

    update grants.researcher_work w
       set absztrakt        = coalesce(nullif(btrim(coalesce(it->>'absztrakt','')),''), w.absztrakt),
           absztrakt_forras = coalesce(nullif(it->>'absztrakt_forras',''), w.absztrakt_forras),
           oa_url           = coalesce(nullif(it->>'oa_url',''), w.oa_url),
           nyelv            = coalesce(nullif(it->>'nyelv',''), w.nyelv),
           idezet_norm      = coalesce(nullif(it->>'idezet_norm','')::numeric, w.idezet_norm),
           beagyazas_forras = coalesce(nullif(it->>'beagyazas_forras',''), w.beagyazas_forras)
     where w.id = v_id;
    if not found then continue; end if;
    v_mu := v_mu + 1;

    if jsonb_typeof(it->'szerzok') = 'array' then
      delete from grants.work_author where work_id = v_id;
      v_i := 0;
      for sz in select jsonb_array_elements(it->'szerzok') loop
        v_i := v_i + 1;
        continue when coalesce(btrim(sz->>'nev'), '') = '';
        insert into grants.work_author (work_id, sorszam, nev, openalex_id, orcid, intezmeny, nje)
        values (v_id, v_i, btrim(sz->>'nev'),
                nullif(sz->>'openalex_id',''), nullif(sz->>'orcid',''),
                nullif(sz->>'intezmeny',''), coalesce((sz->>'nje')::boolean, false))
        on conflict (work_id, sorszam) do nothing;
        v_sz := v_sz + 1;
      end loop;
    end if;
  end loop;
  return jsonb_build_object('mu', v_mu, 'szerzo', v_sz);
end $$;

create or replace function public.grants_researcher_grants_set(p_researcher uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; v_db integer := 0;
begin
  if p_researcher is null then raise exception 'GRANTS_HIBA: a kutató azonosítója kötelező.'; end if;
  for it in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(btrim(it->>'kulcs'), '') = '';
    insert into grants.researcher_grant (researcher_id, forras, kulcs, cim, tamogato, azonosito, ev, payload, frissitve)
    values (p_researcher, coalesce(nullif(it->>'forras',''), 'openalex'), btrim(it->>'kulcs'),
            nullif(it->>'cim',''), nullif(it->>'tamogato',''), nullif(it->>'azonosito',''),
            nullif(it->>'ev','')::integer, coalesce(it->'payload', '{}'::jsonb), now())
    on conflict (researcher_id, forras, kulcs) do update
       set cim = coalesce(excluded.cim, researcher_grant.cim),
           tamogato = coalesce(excluded.tamogato, researcher_grant.tamogato),
           azonosito = coalesce(excluded.azonosito, researcher_grant.azonosito),
           ev = coalesce(excluded.ev, researcher_grant.ev),
           payload = excluded.payload, frissitve = now();
    v_db := v_db + 1;
  end loop;
  return jsonb_build_object('palyazat', v_db);
end $$;

-- Arculat-sor: a nyitott felhívások, amelyeket még nem bontottunk arculatokra.
create or replace function public.grants_facet_queue(p_limit integer default 5)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim, 'cim_en', c.cim_en,
                                    'program', c.program, 'tipus', c.tipus,
                                    'kivonat', c.kivonat, 'url', c.url,
                                    'hatarido', c.kovetkezo_hatarido,
                                    'kedvezmenyezett', c.kedvezmenyezett,
                                    'payload', c.payload) as sor
            from grants.call c
           where c.archivalt = false
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
             and not exists (select 1 from grants.call_facet f where f.call_id = c.id)
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 5), 1), 25)) t
$$;

create or replace function public.grants_call_facet_set(p_call uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; v_db integer := 0; v_vek real[];
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
  delete from grants.call_facet where call_id = p_call;
  for it in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(btrim(it->>'nev'), '') = '';
    v_db := v_db + 1;
    v_vek := grants.vek_jsonb(it->'vektor');
    insert into grants.call_facet (call_id, sorszam, nev, szoveg, forras, modell, dim, vektor)
    values (p_call, coalesce(nullif(it->>'sorszam','')::integer, v_db),
            btrim(it->>'nev'), nullif(btrim(coalesce(it->>'szoveg','')),''),
            coalesce(nullif(it->>'forras',''), 'modell'), nullif(it->>'modell',''),
            case when v_vek is null then null else array_length(v_vek, 1) end,
            case when v_vek is null then null else grants.vek_norm(v_vek) end);
  end loop;
  return jsonb_build_object('arculat', v_db);
end $$;


-- Metaadat-sor: melyik műhöz kell még absztrakt és társszerzőlista. A forrás
-- azonosítója kell hozzá — DOI-ból is lehet kérdezni, de az OpenAlex a saját
-- azonosítójával kötegelhető (egy kérés 50 műre).
create or replace function public.grants_meta_queue(p_limit integer default 200)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.ev desc nulls last), '[]'::jsonb)
    from (select w.ev,
                 jsonb_build_object('work_id', w.id, 'researcher_id', w.researcher_id,
                                    'forras', w.forras, 'kulso_id', w.kulso_id,
                                    'doi', w.doi, 'cim', w.cim, 'ev', w.ev) as sor
            from grants.researcher_work w
           where w.absztrakt is null
             and (w.kulso_id is not null or w.doi is not null)
           order by w.ev desc nulls last
           limit least(greatest(coalesce(p_limit, 200), 1), 500)) t
$$;

-- Egy kutató műveinek vektorai — ebből klaszterez a betöltő. Kifelé csak az,
-- ami a klaszterezéshez kell: azonosító, év és a vektor.
create or replace function public.grants_work_vectors_get(p_researcher uuid, p_limit integer default 400)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'work_id', v.work_id, 'ev', w.ev, 'cim', w.cim,
           'pozicio', w.szerzoi_pozicio, 'vektor', to_jsonb(v.vektor))
           order by w.ev desc nulls last), '[]'::jsonb)
    from grants.work_vector v
    join grants.researcher_work w on w.id = v.work_id
   where w.researcher_id = p_researcher
     and w.id in (select w2.id from grants.researcher_work w2
                   where w2.researcher_id = p_researcher
                   order by w2.ev desc nulls last
                   limit least(greatest(coalesce(p_limit, 400), 1), 1000))
$$;


-- ------------------------------------------------------------
-- 8. Irodai felület
-- ------------------------------------------------------------
create or replace function public.grants_call_facets(p_call uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_office();
  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', f.id, 'sorszam', f.sorszam, 'nev', f.nev, 'szoveg', f.szoveg,
                   'forras', f.forras, 'van_vektor', f.vektor is not null,
                   'talalat_db', (select count(*) from grants.call_match m where m.facet_id = f.id))
                   order by f.sorszam), '[]'::jsonb)
            from grants.call_facet f where f.call_id = p_call);
end $$;

-- Az iroda kézzel is megadhatja vagy javíthatja az arculatokat. A vektor ilyenkor
-- üresen marad: a beágyazást a következő gépi kör pótolja.
create or replace function public.grants_facets_save(p_call uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; v_db integer := 0;
begin
  perform grants.require_office();
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
  delete from grants.call_facet where call_id = p_call;
  for it in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(btrim(it->>'nev'), '') = '';
    v_db := v_db + 1;
    insert into grants.call_facet (call_id, sorszam, nev, szoveg, forras)
    values (p_call, v_db, btrim(it->>'nev'), nullif(btrim(coalesce(it->>'szoveg','')),''), 'kezi');
  end loop;
  return jsonb_build_object('arculat', v_db);
end $$;

create or replace function public.grants_call_match(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_office();
  return grants.call_match_run(p_call, p_csak_nyitott);
end $$;

create or replace function public.grants_call_match_etl(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
begin
  return grants.call_match_run(p_call, p_csak_nyitott);
end $$;

-- A találatok olvasása. Arculatonként rendezve, hogy látszódjon, melyik
-- elvárásra ki jön szóba — és melyikre senki.
create or replace function public.grants_call_matches(
  p_call uuid, p_facet uuid default null, p_limit integer default 10)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_res jsonb;
begin
  perform grants.require_office();
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'facet_id', f.id, 'arculat', f.nev, 'sorszam', f.sorszam, 'szoveg', f.szoveg,
           'jeloltek', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'researcher_id', m.researcher_id, 'nev', r.nev, 'kar', r.kar,
                       'intezet', r.intezet, 'ut', m.ut,
                       'ossz', m.ossz, 'tartalom', m.tartalom, 'frissesseg', m.frissesseg,
                       'sulypont', m.sulypont, 'tekintely', m.tekintely, 'kapacitas', m.kapacitas,
                       'nyitottsag', m.nyitottsag, 'bevonas', m.bevonas,
                       'nyitott', m.nyitott, 'van_angol', m.van_angol,
                       'bizonyitek', m.bizonyitek,
                       'felkerve', exists (select 1 from grants.invite i
                                            where i.call_id = p_call and i.researcher_id = m.researcher_id))
                       order by m.ossz desc)
                from (select * from grants.call_match m2
                       where m2.call_id = p_call and m2.facet_id = f.id
                       order by m2.ossz desc
                       limit least(greatest(coalesce(p_limit, 10), 1), 50)) m
                join grants.researcher r on r.id = m.researcher_id), '[]'::jsonb))
           order by f.sorszam), '[]'::jsonb)
    into v_res
    from grants.call_facet f
   where f.call_id = p_call and (p_facet is null or f.id = p_facet);

  return v_res;
end $$;

-- Egy kollégához: mely felhívások illenek rá. Ez adja a „még soha nem kértük
-- fel" listához a mellékelt felhívást.
create or replace function public.grants_researcher_matches(p_researcher uuid, p_limit integer default 5)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_reports();
  return (select coalesce(jsonb_agg(t.sor order by t.ossz desc), '[]'::jsonb)
            from (select m.ossz,
                         jsonb_build_object('call_id', c.id, 'felhivas', c.cim,
                                            'hatarido', c.kovetkezo_hatarido, 'url', c.url,
                                            'arculat', f.nev, 'ossz', m.ossz, 'ut', m.ut,
                                            'tartalom', m.tartalom,
                                            'felkerve', exists (select 1 from grants.invite i
                                                                 where i.call_id = c.id
                                                                   and i.researcher_id = p_researcher)) sor
                    from grants.call_match m
                    join grants.call c       on c.id = m.call_id
                    join grants.call_facet f on f.id = m.facet_id
                   where m.researcher_id = p_researcher
                     and c.archivalt = false
                     and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
                   order by m.ossz desc
                   limit least(greatest(coalesce(p_limit, 5), 1), 25)) t);
end $$;

-- Mennyi adat van egyáltalán. E nélkül az iroda nem tudja megítélni, miért
-- gyenge egy találat: azért, mert nincs illeszkedés, vagy mert nincs adat.
create or replace function public.grants_semantic_stats()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_reports();
  return jsonb_build_object(
    'mu_db',           (select count(*) from grants.researcher_work),
    'absztrakt_db',    (select count(*) from grants.researcher_work where absztrakt is not null),
    'oa_link_db',      (select count(*) from grants.researcher_work where oa_url is not null),
    'vektor_db',       (select count(*) from grants.work_vector),
    'szerzo_db',       (select count(*) from grants.work_author),
    'palyazat_db',     (select count(*) from grants.researcher_grant),
    'kutato_db',       (select count(*) from grants.researcher where allapot = 'aktiv'),
    'klaszterezett',   (select count(distinct researcher_id) from grants.researcher_vector),
    'szoveges_profil', (select count(*) from grants.researcher_text where mu_db > 0),
    'nyitott_csapatra',(select count(*) from grants.researcher where allapot = 'aktiv' and csapatkereses),
    'arculat_db',      (select count(*) from grants.call_facet),
    'arculatos_felhivas', (select count(distinct call_id) from grants.call_facet),
    'talalat_db',      (select count(*) from grants.call_match),
    'el_db',           (select count(*) from grants.coauthor_edge),
    'utolso_beagyazas',(select max(frissitve) from grants.work_vector),
    'utolso_klaszter', (select max(frissitve) from grants.researcher_vector));
end $$;

-- Társszerzőségi gráf egy kutató körül: kik a ma is működő partnerei.
create or replace function public.grants_coauthor_graph(p_researcher uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_reports();
  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'researcher_id', r.id, 'nev', r.nev, 'kar', r.kar,
                   'mu_db', e.mu_db, 'utolso_ev', nullif(e.utolso_ev, 0))
                   order by e.mu_db desc), '[]'::jsonb)
            from grants.coauthor_edge e
            join grants.researcher r
              on r.id = case when e.a_id = p_researcher then e.b_id else e.a_id end
           where e.a_id = p_researcher or e.b_id = p_researcher);
end $$;

-- STRUKTURÁLIS LYUKAK: témában közel álló kollégák, akik még soha nem
-- publikáltak együtt. Ez felhívás nélkül is önálló haszon.
create or replace function public.grants_coauthor_gaps(p_limit integer default 20)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_reports();
  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'a_id', t.a, 'a_nev', ra.nev, 'a_kar', ra.kar,
                   'b_id', t.b, 'b_nev', rb.nev, 'b_kar', rb.kar,
                   'kozos_tema', t.kozos, 'atfedes', round(t.suly, 3))
                   order by t.suly desc), '[]'::jsonb)
            from (select a.researcher_id a, b.researcher_id b,
                         count(*) kozos, sum(least(a.suly, b.suly)) suly
                    from grants.researcher_topic a
                    join grants.researcher_topic b
                      on b.topic = a.topic and b.szint = a.szint and b.researcher_id > a.researcher_id
                   where a.szint = 'subfield'
                   group by a.researcher_id, b.researcher_id
                  having count(*) >= 2
                     and not exists (select 1 from grants.coauthor_edge e
                                      where e.a_id = least(a.researcher_id, b.researcher_id)
                                        and e.b_id = greatest(a.researcher_id, b.researcher_id))
                   order by sum(least(a.suly, b.suly)) desc
                   limit least(greatest(coalesce(p_limit, 20), 1), 100)) t
            join grants.researcher ra on ra.id = t.a
            join grants.researcher rb on rb.id = t.b);
end $$;

create or replace function public.grants_semantic_rebuild(p_mit text default 'mind')
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_txt integer := 0; v_el integer := 0;
begin
  perform grants.require_office();
  if p_mit in ('mind','szoveg') then v_txt := grants.researcher_text_rebuild(null); end if;
  if p_mit in ('mind','graf')   then v_el  := grants.coauthor_rebuild(); end if;
  return jsonb_build_object('szoveges_profil', v_txt, 'el', v_el);
end $$;

create or replace function public.grants_semantic_rebuild_etl(p_mit text default 'mind')
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_txt integer := 0; v_el integer := 0;
begin
  if p_mit in ('mind','szoveg') then v_txt := grants.researcher_text_rebuild(null); end if;
  if p_mit in ('mind','graf')   then v_el  := grants.coauthor_rebuild(); end if;
  return jsonb_build_object('szoveges_profil', v_txt, 'el', v_el);
end $$;


-- ------------------------------------------------------------
-- 9. Első feltöltés: a token-út azonnal működjön
-- ------------------------------------------------------------
do $init$
declare v_txt integer; v_el integer;
begin
  v_txt := grants.researcher_text_rebuild(null);
  v_el  := grants.coauthor_rebuild();
  raise notice '89 — szoveges profil: % kutato, tarsszerzosegi el: %', v_txt, v_el;
end $init$;


-- ------------------------------------------------------------
-- 10. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text;
begin
  -- Belső: a klienstől teljesen elzárva.
  foreach f in array array[
    'grants.vek_norm(real[])', 'grants.vek_dot(real[],real[])', 'grants.vek_jsonb(jsonb)',
    'grants.tokenek(text)', 'grants.token_atfedes(text[],text[])',
    'grants.frissesseg_pont(numeric)', 'grants.tekintely_pont(uuid)',
    'grants.nyitottsag_pont(uuid)', 'grants.van_angol_mu(uuid)',
    'grants.researcher_text_rebuild(uuid)', 'grants.coauthor_rebuild()',
    'grants.mu_hash(text,text)', 'grants.call_match_run(uuid,boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  -- Irodai / kari RPC-k: a jogosultságot mindegyik maga ellenőrzi.
  foreach f in array array[
    'public.grants_call_facets(uuid)',
    'public.grants_facets_save(uuid,jsonb)',
    'public.grants_call_match(uuid,boolean)',
    'public.grants_call_matches(uuid,uuid,integer)',
    'public.grants_researcher_matches(uuid,integer)',
    'public.grants_semantic_stats()',
    'public.grants_coauthor_graph(uuid)',
    'public.grants_coauthor_gaps(integer)',
    'public.grants_semantic_rebuild(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;

  -- ETL: kizárólag service_role. Ezek nem kérdezik az auth.uid()-t, ezért
  -- bejelentkezett felhasználó SEM hívhatja őket.
  foreach f in array array[
    'public.grants_embed_queue(integer)',
    'public.grants_work_vector_set(jsonb)',
    'public.grants_cluster_queue(integer)',
    'public.grants_researcher_vector_set(uuid,jsonb)',
    'public.grants_work_meta_set(jsonb)',
    'public.grants_researcher_grants_set(uuid,jsonb)',
    'public.grants_facet_queue(integer)',
    'public.grants_meta_queue(integer)',
    'public.grants_work_vectors_get(uuid,integer)',
    'public.grants_call_facet_set(uuid,jsonb)',
    'public.grants_call_match_etl(uuid,boolean)',
    'public.grants_semantic_rebuild_etl(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
    if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $grants$;

do $chk$
declare f text;
begin
  foreach f in array array[
    'public.grants_embed_queue(integer)',
    'public.grants_work_vector_set(jsonb)',
    'public.grants_researcher_vector_set(uuid,jsonb)',
    'public.grants_work_meta_set(jsonb)',
    'public.grants_call_facet_set(uuid,jsonb)',
    'public.grants_call_match_etl(uuid,boolean)',
    'public.grants_semantic_rebuild_etl(text)',
    'public.grants_meta_queue(integer)',
    'public.grants_work_vectors_get(uuid,integer)'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', f, 'execute') then
      raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is hivhatja az ETL-fuggvenyt: %', f;
    end if;
  end loop;

  foreach f in array array[
    'public.grants_call_matches(uuid,uuid,integer)',
    'public.grants_semantic_stats()',
    'public.grants_coauthor_gaps(integer)'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_function_privilege('anon', f, 'execute') then
      raise exception 'BIZTONSAGI HIBA: az anon hivhatja: %', f;
    end if;
  end loop;

  raise notice 'Rendben: 89 — szemantikus reteg, arculatok, komponenses illesztes.';
end $chk$;
