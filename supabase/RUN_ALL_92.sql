-- ============================================================================
-- RUN_ALL_92.sql — az illesztés beleférjen az időkeretbe
-- ============================================================================
-- HOL TARTUNK: a 88–91 lefutott, a betöltő végigment a törzsön. MÉRVE:
--     absztrakt         : 5 700 mű
--     társszerző        : ~24 000 sor
--     pályázati előzmény: ~800 tétel
--     beágyazás         : 5 800 mű, 768 dimenzió (gemini-embedding-001)
--     témakör-vektor    : 212 kutatónak, összesen 490
--     arculat           : 13 felhívás, 43 arculat
--
-- AMI ELBUKOTT: az illesztés. Mind a 13 felhívásnál ugyanaz jött, pontosan 8
-- másodpercnél: „canceling statement due to statement timeout".
--
-- AZ OK — két helyen számoltuk feleslegesen sokszor a 768 dimenziós
-- skalárszorzatot:
--   1) a témakör kiválasztásánál a szorzat a SELECT-ben ÉS az ORDER BY-ban is
--      ott volt, tehát kétszer futott;
--   2) a bizonyíték („mire alapozzuk") a kutató ÖSSZES művére kiszámolta a
--      hasonlóságot — egy 200 műves kutatónál arculatonként 400 szorzat.
--
-- A JAVÍTÁS: a szorzat egyszer fut, a bizonyíték a témakör 12 legfrissebb
-- művéből válogat, és a függvény saját, megemelt utasítás-időkorlátot kap
-- (180 s) — ez szándékosan hosszú számítás, nem felhasználói lekérdezés.
--
-- AMI NEM VÁLTOZIK: a pontszám képlete, a komponensek, a küszöb és a kimenet
-- alakja. Szintetikus adaton újramérve a rewrite UGYANAZT a pontszámot és
-- ugyanazt az üres arculatot adja, mint előtte.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 92 — az illesztes egyszer szamol, korlatos bizonyitekkal, megemelt idokorlattal.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
--
-- FUTÁS UTÁN: szólj, és lefuttatom az illesztést — utána lesz először valódi
-- jelölt a felhívások arculataira.
-- ============================================================================



-- ####################################################################
-- ### 92_grants_match_speed.sql
-- ####################################################################

-- ============================================================
-- 92_grants_match_speed.sql — az illesztés beleférjen az időkeretbe
-- ============================================================
-- MI TÖRTÉNT: az első éles illesztési kör mind a 13 arculatos felhívásnál
-- ugyanazt adta: „canceling statement due to statement timeout" — pontosan 8
-- másodpercnél, tehát a szerepkör állításánál.
--
-- MIÉRT: két helyen számoltuk feleslegesen sokszor a 768 dimenziós
-- skalárszorzatot.
--   1) A témakör kiválasztásánál a vek_dot() a SELECT-ben ÉS az ORDER BY-ban is
--      szerepelt — ugyanaz a szorzat kétszer futott le.
--   2) A bizonyíték (mire alapozzuk a találatot) a kutató ÖSSZES művére
--      kiszámolta a hasonlóságot, szintén kétszer, majd a legjobb hármat tartotta
--      meg. Egy 200 műves kutatónál ez arculatonként 400 szorzat — 336 kutatóra
--      és 3-4 arculatra vetítve milliós nagyságrend.
--
-- A JAVÍTÁS:
--   * a szorzat MINDIG egyszer fut (lateral segédlekérdezésben),
--   * a bizonyítékot a találatot adó témakör 12 LEGFRISSEBB művéből válogatjuk
--     (a régi mű úgysem lenne jó érv), tehát arculatonként legfeljebb 12 szorzat,
--   * és a függvény kap egy saját, megemelt utasítás-időkorlátot: ez szándékosan
--     hosszú számítás, nem egy felhasználói lekérdezés.
--
-- AMI NEM VÁLTOZIK: a pontszám képlete, a komponensek, a küszöb, a kemény
-- kapuk és a kimenet alakja. Ez teljesítményjavítás, nem új szabály.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function grants.call_match_run(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
-- Szándékosan hosszú futás: az egész törzset végigméri egy felhívásra.
set statement_timeout = '180s'
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
        -- A szorzat EGYSZER fut: a lateral segédlekérdezés kiszámolja, és utána
        -- csak rendezünk rá. (Korábban a select és az order by is kiszámolta.)
        select x.klaszter, x.d, x.suly, x.atlag_ev
          into v_kl, v_dot, v_ksuly, v_kev
          from (select rv.klaszter, rv.suly, rv.atlag_ev, grants.vek_dot(rv.vektor, f.vektor) as d
                  from grants.researcher_vector rv
                 where rv.researcher_id = r.id) x
         order by x.d desc
         limit 1;
      end if;

      if v_dot is not null then
        v_ut   := 'vektor';
        v_tart := round(greatest(0, least(100, v_dot * 100))::numeric, 2);
        v_fris := grants.frissesseg_pont(v_kev);
        v_sp   := round(least(100, coalesce(v_ksuly, 0) * 100), 2);
        v_vekt := v_vekt + 1;
      else
        v_ut   := 'token';
        v_tart := grants.token_atfedes(r.tok, f.tok);
        v_fris := grants.frissesseg_pont(r.utolso_ev);
        v_sp   := 50;
        v_tok  := v_tok + 1;
      end if;

      continue when v_tart < v_min;

      if v_ut = 'vektor' then
        -- A bizonyíték a témakör 12 LEGFRISSEBB művéből jön. A régi mű úgysem
        -- lenne jó érv, és így a szorzatok száma arculatonként korlátos.
        select coalesce(jsonb_agg(jsonb_build_object('cim', z.cim, 'ev', z.ev, 'doi', z.doi,
                                                    'hasonlosag', round((z.d * 100)::numeric, 1))
                                  order by z.d desc), '[]'::jsonb)
          into v_biz
          from (select y.cim, y.ev, y.doi, grants.vek_dot(y.vektor, f.vektor) as d
                  from (select w.cim, w.ev, w.doi, wv.vektor
                          from grants.researcher_work w
                          join grants.work_vector wv on wv.work_id = w.id
                         where w.researcher_id = r.id
                           and (v_kl is null or wv.klaszter is null or wv.klaszter = v_kl)
                         order by w.ev desc nulls last
                         limit 12) y
                 order by grants.vek_dot(y.vektor, f.vektor) desc
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
    'ures_arculatok', (select coalesce(jsonb_agg(a.nev order by a.nev), '[]'::jsonb) from _arc a
                        where not exists (select 1 from grants.call_match m
                                           where m.call_id = p_call and m.facet_id = a.id)),
    'ido_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric, 1));
end $$;

-- A hívó burkolók is kapjanak időt: a korlát a LEGKÜLSŐ hívásnál számít.
create or replace function public.grants_call_match(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '180s'
as $$
begin
  perform grants.require_office();
  return grants.call_match_run(p_call, p_csak_nyitott);
end $$;

create or replace function public.grants_call_match_etl(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '180s'
as $$
begin
  return grants.call_match_run(p_call, p_csak_nyitott);
end $$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text;
begin
  f := 'grants.call_match_run(uuid,boolean)';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;

  f := 'public.grants_call_match(uuid,boolean)';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('grant execute on function %s to authenticated', f); end if;

  f := 'public.grants_call_match_etl(uuid,boolean)';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_call_match_etl(uuid,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is futtathatja az ETL-illesztest.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.grants_call_match(uuid,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja az illesztest.';
  end if;
  raise notice 'Rendben: 92 — az illesztes egyszer szamol, korlatos bizonyitekkal, megemelt idokorlattal.';
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
