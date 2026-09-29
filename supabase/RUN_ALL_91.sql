-- ============================================================================
-- RUN_ALL_91.sql — a társszerzőségi gráf újraépítése élesben is lefut
-- ============================================================================
-- MI TÖRTÉNT: a 88–90 lefutott, a betöltő elindult, és a gráf-újraépítés ezt
-- adta: „DELETE requires a WHERE clause".
--
-- AZ OK: az éles Supabase a service_role és az authenticated szerepnél
-- biztonságos írás (safeupdate) módban fut, és elutasítja a WHERE nélküli
-- DELETE-et. A grants.coauthor_rebuild() pedig pont így törölte a gráfot,
-- mielőtt újraépítette volna. Helyi Postgresen ez lefutott — ezért nem bukott
-- ki a próbán.
--
-- A JAVÍTÁS: a szándékolt teljes törlés kiírt feltétellel megy (where true).
-- A modul többi törlése már eddig is szűkített volt, ezért máshol nincs teendő.
--
-- UGYANEBBEN A SZKRIPTBEN egy második, mért javítás: a metaadat-sor eddig
-- minden körben ugyanazokat a műveket adta vissza, amelyeket az OpenAlex nem
-- ismer (300-as mintán 93 ilyen) — így a betöltő beragadt volna rájuk. Mostantól
-- a megkérdezett mű 30 napra kikerül a sorból (próbálkozás-bélyeg), tehát a
-- betöltő halad tovább, de egy hónap múlva újra megnézi.
--
-- HARMADIK JAVÍTÁS ugyanitt: illesztési sor (grants_match_queue). Eddig az
-- illesztést csak az iroda tudta elindítani a felületről, az arculatok viszont
-- gépi körben készülnek — így elkészült arculat mellett is jelölt nélkül
-- maradhatott egy felhívás, pusztán azért, mert senki nem nyomta meg a gombot.
-- Mostantól a betöltő magától párosít, ha az arculatok frissebbek a találatnál.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 91 — tarsszerzosegi graf ujraepitve, <szám> el; metaadat-sor probabelyeggel; illesztesi sor.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
-- ============================================================================







-- ####################################################################
-- ### 91_grants_coauthor_fix.sql
-- ####################################################################

-- ============================================================
-- 91_grants_coauthor_fix.sql — WHERE nélküli DELETE a társszerzőségi gráfban
-- ============================================================
-- MI TÖRTÉNT: a 89-es migráció telepítése után a betöltő ezt kapta a
-- grants_semantic_rebuild_etl() hívására:
--     DELETE requires a WHERE clause
--
-- MIÉRT: a grants.coauthor_rebuild() a gráfot „letörlöm és újraépítem" módon
-- frissítette (`delete from grants.coauthor_edge;`). Ez sima Postgresen
-- működik — helyben le is futott —, de az ÉLES Supabase a service_role és az
-- authenticated szerepnél bekapcsolt „biztonságos írás" (safeupdate) módban
-- fut, amely elutasítja a WHERE nélküli DELETE-et és UPDATE-et. Ez a védelem
-- jó: pont az ilyen teljes törlést akadályozza meg véletlen esetben.
--
-- A JAVÍTÁS: a szándékolt teljes törlés KIÍRT feltétellel megy. A `where true`
-- nem gyengíti a védelmet — azt mondja ki, hogy a teljes törlés itt szándékos.
--
-- A modul többi törlése már eddig is szűkített (call_id, researcher_id,
-- work_id szerint), ezért máshol nincs teendő.
--
-- A MÁSODIK JAVÍTÁS — a metaadat-sor beragadása. MÉRVE az első éles körökben:
-- a sorban álló művek egy része az OpenAlexből nem hozható (nincs sem
-- OpenAlex-azonosítója, sem DOI-ja, vagy a DOI-ját az OpenAlex nem ismeri;
-- 300-as mintán 93 ilyen). A sor `absztrakt is null` szerint szűrt, tehát
-- ezek a művek MINDEN körben újra elöl álltak volna, és a betöltő a
-- huszadik körben is ugyanazt a 93-at kérdezte volna meg — a többi mű pedig
-- soha nem került volna sorra.
--
-- A megoldás egy próbálkozás-bélyeg: amit egyszer megkérdeztünk, az 30 napig
-- kikerül a sorból. Nem végleges kizárás: az OpenAlex utólag is felveheti a
-- művet, ezért egy hónap múlva újra megnézzük.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function grants.coauthor_rebuild()
returns integer
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_db integer;
begin
  -- Szándékolt teljes újraépítés. A `where true` azért kell, mert az éles
  -- Supabase a WHERE nélküli DELETE-et elutasítja (safeupdate).
  delete from grants.coauthor_edge where true;

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
-- Próbálkozás-bélyeg a metaadat-soron
-- ------------------------------------------------------------
alter table grants.researcher_work
  add column if not exists meta_proba timestamptz;

comment on column grants.researcher_work.meta_proba is
  'Mikor kérdeztük meg utoljára a külső forrástól a metaadatát. A sor 30 napig kihagyja — így a nem megtalálható művek nem ragasztják be a betöltőt.';

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
             -- Amit egyszer megkérdeztünk, az 30 napig kimarad.
             and (w.meta_proba is null or w.meta_proba < now() - interval '30 days')
           order by w.ev desc nulls last
           limit least(greatest(coalesce(p_limit, 200), 1), 500)) t
$$;

-- A bélyeget a betöltő írja: MINDEN átadott műre, akkor is, ha nem talált
-- hozzá absztraktot — különben pont a megtalálhatatlanok maradnának a sorban.
create or replace function public.grants_work_meta_set(p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; sz jsonb; v_mu integer := 0; v_sz integer := 0; v_jelolt integer := 0;
        v_id uuid; v_i integer;
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
           beagyazas_forras = coalesce(nullif(it->>'beagyazas_forras',''), w.beagyazas_forras),
           meta_proba       = now()
     where w.id = v_id;
    if not found then continue; end if;
    v_jelolt := v_jelolt + 1;
    if nullif(btrim(coalesce(it->>'absztrakt','')),'') is not null then v_mu := v_mu + 1; end if;

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
  return jsonb_build_object('mu', v_mu, 'szerzo', v_sz, 'jelolt', v_jelolt);
end $$;

-- ------------------------------------------------------------
-- Illesztési sor: mely felhívásokat kell (újra) párosítani
-- ------------------------------------------------------------
-- MIÉRT KELL: eddig az illesztést csak az iroda tudta elindítani a felületről.
-- Az arculatok viszont gépi körben készülnek (grants-semantic), és a friss
-- arculatokhoz friss találat kell — e nélkül az iroda olyan felhívást lát
-- arculatokkal, amelyhez nincs jelölt, pedig csak senki nem nyomta meg a
-- gombot. Ez a sor teszi a láncot teljessé: arculat → illesztés → csapat.
create or replace function public.grants_match_queue(p_limit integer default 10)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim,
                                    'arculat_db', (select count(*) from grants.call_facet f
                                                    where f.call_id = c.id),
                                    'hatarido', c.kovetkezo_hatarido) as sor
            from grants.call c
           where c.archivalt = false
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
             and exists (select 1 from grants.call_facet f where f.call_id = c.id)
             -- Nincs még találat, VAGY az arculat frissebb, mint a legutóbbi
             -- illesztés (tehát az arculatok azóta változtak).
             and (not exists (select 1 from grants.call_match m where m.call_id = c.id)
                  or (select max(f.created_at) from grants.call_facet f where f.call_id = c.id)
                     > (select max(m.mikor) from grants.call_match m where m.call_id = c.id))
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 10), 1), 50)) t
$$;

-- A beágyazó modell neve a beállításban: mérve 2026-09-25-én a
-- text-embedding-004 már nem elérhető ezen a kulcson (404), a stabil modell a
-- gemini-embedding-001. A beállítás tájékoztató: a modellt a betöltő
-- függvényének környezete dönti el (GRANTS_EMBED_MODEL).
update grants.setting
   set value = 'gemini-embedding-001', updated_at = now()
 where key = 'beagyazas_modell' and value = 'text-embedding-004';

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text;
begin
  f := 'grants.coauthor_rebuild()';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;

  -- Az újradefiniált ETL-függvények: a create or replace MEGTARTJA a régi
  -- jogosultságot, de a Supabase alapértelmezése miatt újra le kell venni az
  -- anon és az authenticated jogát.
  foreach f in array array[
    'public.grants_meta_queue(integer)',
    'public.grants_work_meta_set(jsonb)',
    'public.grants_match_queue(integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
    if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $grants$;

do $chk$
declare v_el integer; f text;
begin
  foreach f in array array['public.grants_meta_queue(integer)', 'public.grants_work_meta_set(jsonb)',
                           'public.grants_match_queue(integer)'] loop
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', f, 'execute') then
      raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is hivhatja: %', f;
    end if;
  end loop;
  v_el := grants.coauthor_rebuild();
  raise notice 'Rendben: 91 — tarsszerzosegi graf ujraepitve, % el; metaadat-sor probabelyeggel; illesztesi sor.', v_el;
end $chk$;


-- ####################################################################
-- ### 21_echo_harden_submit.sql
-- ####################################################################

-- ============================================================
-- UniPortal Pro — ECHO: az anonim beküldés jogosultságának lezárása
-- ------------------------------------------------------------
-- MIÉRT KELL:
--   Az ECHO anonimitásának egyik tartóoszlopa, hogy a beküldés NEM a hallgató
--   munkamenetével fut: az echo_submit() kizárólag 'anon' joggal hívható, így
--   egy JWT-t hordozó kérés jogosultsági hibával elhasal, és a hallgató
--   azonosítója nem kerül a tranzakciós naplóba és a platform edge-logjába.
--
--   A 15_echo_core.sql ezt CSAK azzal éri el, hogy megadja a jogot az anon-nak
--   (1712. sor) — de SOHA NEM VONJA VISSZA az authenticated-tól. A Supabase
--   alapértelmezett jogosztása (alter default privileges … grant execute on
--   functions to anon, authenticated, service_role) viszont MINDEN új publikus
--   függvényre ad authenticated végrehajtási jogot. Ha ez a projekten él, akkor
--   az echo_submit bejelentkezve is hívható, és a garancia csendben elveszik.
--
--   MÉRVE: egy tiszta adatbázison, ahol a migrációk UTÁN lefutott egy tömeges
--   'grant all on all functions in schema public to anon, authenticated' —
--   ami pontosan azt utánozza, amit a platform tesz —, az echo_submit
--   jogosultsága 'anon=X authenticated=X service_role=X' lett.
--
-- MIT CSINÁL:
--   Visszavonja a végrehajtási jogot mindenkitől, majd kizárólag az anon-nak adja
--   vissza. Beállítja az alapértelmezett jogosztást is, hogy egy jövőbeli
--   platform-művelet ne nyissa vissza. A végén ellenőriz.
--
-- FUTTATÁSI SORREND: ez az UTOLSÓ migráció. Minden alkalommal futtasd újra,
-- amikor bármilyen új ECHO-migráció felment.
--
-- Idempotens — biztonságosan újrafuttatható, és futtatandó MINDEN olyan
-- alkalommal, amikor új ECHO-migráció ment fel.
-- ============================================================

-- ---------- 1. a beküldő függvény lezárása ----------
do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'echo_submit'
  loop
    execute format('revoke all on function %s from public, authenticated, service_role', fn);
    execute format('grant execute on function %s to anon', fn);
    raise notice 'Lezarva es anon-ra szukitve: %', fn;
  end loop;
end $$;

-- ---------- 2. a jegykiadó marad authenticated ----------
-- Ez SZÁNDÉKOSAN azonosított: itt még nincs válasz, tehát nincs mit korrelálni.
do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'echo_issue_ticket'
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ---------- 3. ellenőrzés ----------
with a as (
  select p.proname,
         coalesce(array_to_string(p.proacl, ' '), '(alapertelmezett)') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('echo_submit', 'echo_issue_ticket')
)
select proname as fuggveny, acl,
       case
         when proname = 'echo_submit'
           then case when acl like '%anon=X%' and acl not like '%authenticated=X%'
                     then 'OK — csak anon' else '*** BAJ: bejelentkezve is hivhato ***' end
         when proname = 'echo_issue_ticket'
           then case when acl like '%authenticated=X%' and acl not like '%anon=X%'
                     then 'OK — csak authenticated' else '*** BAJ ***' end
       end as allapot
from a order by proname;
