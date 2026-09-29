-- ============================================================
-- 98_grants_rerank.sql — a konkrét mű döntsön, ne a témakör átlaga
-- ============================================================
-- MI A BAJ: az illesztés eddig a kutató TÉMAKÖR-KÖZÉPPONTJÁHOZ hasonlította a
-- felhívás arculatát. A középpont egy vegyes életműnél mindentől középtávolra
-- esik, és pont azt a jelet mossa el, amiért az egészet csináljuk.
--
-- MÉRVE 2026-09-25-én, ugyanazzal a modellel, egy repülőgépes arculatra:
--     repülőgép-szerkezeti cikk   0,771
--     áramlástani (UAV szárny)    0,661
--     szenzorhálózat              0,556
--     pénzügyi felmérés           0,546
--     HR-műhelybeszámoló          0,542
--   → egyedi MŰVEKRE a szórás 0,089, a terjedelem 0,229.
-- Ugyanez élesben, témakör-középpontokra: szórás 0,0295 — HÁROMSZOR kisebb.
-- Vagyis a modell tud különbséget tenni; az átlagolás dobta el a különbséget.
--
-- A JAVÍTÁS — keress, aztán rangsorolj újra (retrieve & re-rank):
--   1) Előszűrés a témakör-középpontokkal (olcsó): arculatonként a legjobb N
--      jelölt bekerül a rövid listára.
--   2) A rövid listán a pontszám a kutató LEGJOBB KONKRÉT MŰVÉHEZ mért
--      hasonlóság — nem az átlaghoz. Ez a szám dönt.
--   3) A középre igazítás (95) ezen a rövid listán fut: az arculatra jellemző
--      mezőnyhöz képest mérünk.
--   4) A bizonyíték innen jön ingyen: pontosan az a három mű, amelyik a
--      legközelebb áll — tehát a „miért ő" mindig valódi művet nevez meg.
--
-- MELLÉKHASZON: a bizonyítékot nem kell külön kiszámolni (a 95 még külön
-- menetben tette), és a rövid lista miatt az egész kevesebb szorzatot igényel.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

insert into grants.setting (key, value, description) values
  ('match_rerank_db', '40', 'Arculatonként ennyi jelölt kerül a rövid listára, ahol a konkrét művekhez mérünk.'),
  ('match_rerank_mu', '60', 'Kutatónként ennyi legfrissebb beágyazott művet nézünk az újrarangsoroláskor.')
on conflict (key) do nothing;

create or replace function grants.call_match_run(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '240s'
as $$
declare
  f record; r record; b record;
  w_tart numeric; w_fris numeric; w_sp numeric; w_tek numeric; w_kap numeric; w_nyi numeric; w_bev numeric;
  w_ossz numeric; v_minz numeric; v_minny numeric; v_kiemz numeric;
  v_rerank integer; v_rmu integer;
  v_dot double precision; v_kl integer; v_ksuly numeric; v_kev numeric;
  v_sor integer := 0; v_vekt integer := 0; v_tok integer := 0; v_kut integer := 0; v_ujra integer := 0;
  v_start timestamptz := clock_timestamp();
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
  if not exists (select 1 from grants.call_facet where call_id = p_call) then
    raise exception 'GRANTS_HIBA: ehhez a felhíváshoz még nincs arculat — először arculatokra kell bontani.';
  end if;

  w_tart := grants.szam_beall('pont_suly_tartalom',   50);
  w_fris := grants.szam_beall('pont_suly_frissesseg', 12);
  w_sp   := grants.szam_beall('pont_suly_sulypont',    8);
  w_tek  := grants.szam_beall('pont_suly_tekintely',   8);
  w_kap  := grants.szam_beall('pont_suly_kapacitas',   6);
  w_nyi  := grants.szam_beall('pont_suly_nyitottsag',  3);
  w_bev  := grants.szam_beall('pont_suly_bevonas',     6);
  w_ossz := greatest(1, w_tart + w_fris + w_sp + w_tek + w_kap + w_nyi + w_bev);
  v_minz   := grants.szam_beall('match_min_z', 0.5);
  v_minny  := grants.szam_beall('match_min_nyers', 20);
  v_kiemz  := grants.szam_beall('match_kiemelkedo_z', 1.0);
  v_rerank := grants.szam_beall('match_rerank_db', 40)::integer;
  v_rmu    := grants.szam_beall('match_rerank_mu', 60)::integer;

  delete from grants.call_match where call_id = p_call;

  drop table if exists _arc;
  create temp table _arc as
    select cf.id, cf.nev, cf.vektor,
           grants.tokenek(coalesce(nullif(btrim(cf.szoveg), ''), cf.nev)) as tok
      from grants.call_facet cf where cf.call_id = p_call;

  -- ---------- 1. menet: olcsó előszűrés a témakör-középpontokkal ----------
  drop table if exists _nyers;
  create temp table _nyers (
    facet_id uuid, researcher_id uuid, ut text, nyers numeric, klaszter integer,
    ksuly numeric, kev numeric, tek numeric, kap numeric, nyi numeric, bev numeric,
    angol boolean, nyitott boolean, utolso_ev numeric, biz jsonb);

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
        select x.klaszter, x.d, x.suly, x.atlag_ev into v_kl, v_dot, v_ksuly, v_kev
          from (select rv.klaszter, rv.suly, rv.atlag_ev, grants.vek_dot(rv.vektor, f.vektor) as d
                  from grants.researcher_vector rv where rv.researcher_id = r.id) x
         order by x.d desc limit 1;
      end if;

      if v_dot is not null then
        v_vekt := v_vekt + 1;
        insert into _nyers values (f.id, r.id, 'vektor',
          round(greatest(0, least(100, v_dot * 100))::numeric, 3), v_kl, v_ksuly, v_kev,
          r.tek, r.kap, r.nyi, r.bev, coalesce(r.angol, false),
          coalesce(r.csapatkereses, false), r.utolso_ev, '[]'::jsonb);
      else
        v_tok := v_tok + 1;
        insert into _nyers values (f.id, r.id, 'token',
          grants.token_atfedes(r.tok, f.tok), null, null, null,
          r.tek, r.kap, r.nyi, r.bev, coalesce(r.angol, false),
          coalesce(r.csapatkereses, false), r.utolso_ev, '[]'::jsonb);
      end if;
    end loop;
  end loop;

  -- ---------- 2. menet: a rövid listán a KONKRÉT MŰ dönt ----------
  drop table if exists _rov;
  create temp table _rov as
    select x.* from (select n.*, row_number() over (partition by n.facet_id order by n.nyers desc) as rn
                       from _nyers n) x
     where x.rn <= greatest(5, v_rerank);

  for b in select v.facet_id, v.researcher_id, v.ut, a.vektor
             from _rov v join _arc a on a.id = v.facet_id
            where v.ut = 'vektor' and a.vektor is not null
  loop
    -- A legjobb három konkrét mű: az első adja a pontszámot, mind a három a
    -- bizonyítékot. Így a „miért ő" mindig valódi művet nevez meg.
    declare v_best numeric; v_biz jsonb;
    begin
      select coalesce(jsonb_agg(jsonb_build_object('cim', z.cim, 'ev', z.ev, 'doi', z.doi,
                                                   'hasonlosag', round((z.d * 100)::numeric, 1))
                                order by z.d desc), '[]'::jsonb),
             round((max(z.d) * 100)::numeric, 3)
        into v_biz, v_best
        from (select y.cim, y.ev, y.doi, grants.vek_dot(y.vektor, b.vektor) as d
                from (select w.cim, w.ev, w.doi, wv.vektor
                        from grants.researcher_work w
                        join grants.work_vector wv on wv.work_id = w.id
                       where w.researcher_id = b.researcher_id
                       order by w.ev desc nulls last
                       limit greatest(5, v_rmu)) y
               order by grants.vek_dot(y.vektor, b.vektor) desc
               limit 3) z;
      if v_best is not null then
        update _rov set nyers = v_best, biz = v_biz
         where facet_id = b.facet_id and researcher_id = b.researcher_id;
        v_ujra := v_ujra + 1;
      end if;
    end;
  end loop;

  -- ---------- 3. menet: középre igazítás a RÖVID LISTÁN ----------
  drop table if exists _stat;
  create temp table _stat as
    select facet_id, ut, avg(nyers) as atl,
           greatest(coalesce(stddev_pop(nyers), 0), 0.001) as szo
      from _rov group by facet_id, ut;

  insert into grants.call_match (call_id, researcher_id, facet_id, ut, tartalom, tartalom_nyers,
                                 frissesseg, sulypont, tekintely, kapacitas, nyitottsag, bevonas,
                                 ossz, klaszter, nyitott, van_angol, bizonyitek, mikor)
  select p_call, n.researcher_id, n.facet_id, n.ut, z.tartalom, n.nyers, z.fris, z.sp,
         n.tek, n.kap, n.nyi, n.bev,
         round((w_tart * z.tartalom + w_fris * z.fris + w_sp * z.sp + w_tek * n.tek
              + w_kap * n.kap + w_nyi * n.nyi + w_bev * n.bev) / w_ossz, 2),
         n.klaszter, n.nyitott, n.angol, n.biz, now()
    from _rov n
    join _stat s on s.facet_id = n.facet_id and s.ut = n.ut
    cross join lateral (select (n.nyers - s.atl) / s.szo as z) zz
    cross join lateral (
      select round(greatest(0, least(100, 50 + 12.5 * zz.z))::numeric, 2) as tartalom,
             case when n.ut = 'vektor' then grants.frissesseg_pont(n.kev)
                  else grants.frissesseg_pont(n.utolso_ev) end as fris,
             case when n.ut = 'vektor' then round(least(100, coalesce(n.ksuly, 0) * 100), 2)
                  else 50 end as sp) z
   where zz.z >= v_minz
     and n.nyers > case when n.ut = 'token' then 0 else v_minny end;
  get diagnostics v_sor = row_count;

  return jsonb_build_object(
    'call_id', p_call,
    'arculat_db', (select count(*) from _arc),
    'kutato_db', v_kut,
    'talalat_db', v_sor,
    'ujrarangsorolt', v_ujra,
    'vektor_par', v_vekt,
    'token_par', v_tok,
    'tartalom_szoras', (select round(coalesce(stddev_pop(tartalom), 0), 2)
                          from grants.call_match where call_id = p_call),
    'nyers_szoras', (select round(coalesce(stddev_pop(nyers), 0), 3) from _rov),
    'ures_arculatok', (select coalesce(jsonb_agg(a.nev order by a.nev), '[]'::jsonb)
                         from _arc a
                        where coalesce((select max((n.nyers - s.atl) / s.szo)
                                          from _rov n join _stat s
                                            on s.facet_id = n.facet_id and s.ut = n.ut
                                         where n.facet_id = a.id), 0) < v_kiemz),
    'ido_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric, 1));
end $$;

do $chk$
begin
  raise notice 'Rendben: 98 — eloszures kozepponttal, dontes a konkret muvel.';
end $chk$;
