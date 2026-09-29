-- ============================================================
-- 95_grants_match_calibration.sql — a tartalmi pontszám kalibrálása
-- ============================================================
-- MI DERÜLT KI AZ ELSŐ VALÓDI TALÁLATI LISTÁBÓL (mérve 2026-09-25, 13 felhívás,
-- 3763 találat):
--   * a tartalmi pontszám szórása 2,95 volt (54,6–70,9, átlag 64,8) — vagyis a
--     nyers koszinusz szerint MINDENKI nagyjából ugyanannyira illik MINDENHEZ;
--   * ezért a sorrendet nem a téma döntötte el, hanem a tekintély (92–96):
--     129 dobogós helyből 125-öt ugyanaz a NÉGY ember vitt el;
--   * egy repülőgépes védelmi felhívás első jelöltjét egy HR-műhelybeszámoló
--     és egy pénzügyi felmérés alapján ajánlotta a rendszer.
--
-- MIÉRT: a beágyazási tér anizotrop — a vektorok egy szűk kúpban állnak, és két
-- tetszőleges szöveg koszinusza is 0,6 körül van. Az ABSZOLÚT érték tehát alig
-- hordoz jelentést; a RELATÍV annál inkább: az számít, hogy valaki mennyivel áll
-- közelebb a mezőny átlagánál.
--
-- A JAVÍTÁS — három lépés:
--   1) A tartalmi pontszám arculatonként KÖZÉPRE IGAZÍTVA számol:
--        z = (nyers − átlag) / szórás,  tartalom = 50 + 12,5·z (0..100 közé vágva)
--      Így az átlagos jelölt 50 pontot kap, a +2 szórásnyi 75-öt, a −2 szórásnyi
--      25-öt. A nyers koszinuszt is eltesszük (tartalom_nyers), hogy az érték
--      utólag is ellenőrizhető legyen.
--   2) „Nincs házon belüli jelölt" mostantól ÉRTELMES mérce: az az arculat, ahol
--      a legjobb jelölt sem emelkedik ki (z < 1). Eddig az abszolút 5 pontos
--      küszöb sosem teljesült, mert mindenki 60 fölött volt — ezért NEM is
--      jelzett soha üres arculatot, pedig volt.
--   3) A tekintély súlya 12-ről 8-ra csökken. Nem azért, mert nem számít, hanem
--      mert egy 40 pontos súlyú, 3 pont szórású komponens mellett egy 12 pontos
--      súlyú, 50 pont szórású komponens VESZI ÁT a döntést. A kalibrálás után a
--      tartalom szórása 25 körül lesz, tehát visszakerül a helyére.
--
-- AMI NEM VÁLTOZIK: a komponensek listája, a bevonási méltányosság, a kemény
-- kapuk, a bizonyíték fogalma és a kimenet alakja.
--
-- MELLÉKHASZON: a bizonyíték (melyik műre alapozzuk) mostantól csak a
-- megjelenített élmezőnyre számolódik ki, nem minden sorra — ez a lépés eddig a
-- futásidő nagy részét vitte.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

alter table grants.call_match
  add column if not exists tartalom_nyers numeric(6,2);

comment on column grants.call_match.tartalom_nyers is
  'A nyers hasonlóság (koszinusz·100 vagy token-átfedés). A tartalom oszlop ennek az arculaton belüli, középre igazított változata.';

insert into grants.setting (key, value, description) values
  ('match_min_z', '0.5', 'Ennél kisebb z-értéknél (arculaton belüli szórás-egység) nem tárolunk találatot. 0,5 = a mezőnyből félszórásnyira kiemelkedők.'),
  ('match_min_nyers', '20', 'Nyers hasonlósági padló: ez alatt a találat akkor sem kerül be, ha a mezőnyhöz képest kiemelkedő.'),
  ('match_kiemelkedo_z', '1.0', 'Ennyi szórásnyi kiemelkedés kell ahhoz, hogy egy arculatot lefedettnek tekintsünk.'),
  ('match_bizonyitek_db', '10', 'Arculatonként ennyi élmezőnybeli jelölthez számolunk bizonyítékot.')
on conflict (key) do nothing;

update grants.setting set value = '8', updated_at = now()
 where key = 'pont_suly_tekintely' and value = '12';

create or replace function grants.call_match_run(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '180s'
as $$
declare
  f record; r record; b record;
  w_tart numeric; w_fris numeric; w_sp numeric; w_tek numeric; w_kap numeric; w_nyi numeric; w_bev numeric;
  w_ossz numeric; v_minz numeric; v_minny numeric; v_kiemz numeric; v_bizdb integer;
  v_dot double precision; v_kl integer; v_ksuly numeric; v_kev numeric;
  v_sor integer := 0; v_vekt integer := 0; v_tok integer := 0; v_kut integer := 0;
  v_biz jsonb; v_start timestamptz := clock_timestamp();
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
  if not exists (select 1 from grants.call_facet where call_id = p_call) then
    raise exception 'GRANTS_HIBA: ehhez a felhíváshoz még nincs arculat — először arculatokra kell bontani.';
  end if;

  w_tart := grants.szam_beall('pont_suly_tartalom',   40);
  w_fris := grants.szam_beall('pont_suly_frissesseg', 12);
  w_sp   := grants.szam_beall('pont_suly_sulypont',    8);
  w_tek  := grants.szam_beall('pont_suly_tekintely',   8);
  w_kap  := grants.szam_beall('pont_suly_kapacitas',   8);
  w_nyi  := grants.szam_beall('pont_suly_nyitottsag',  5);
  w_bev  := grants.szam_beall('pont_suly_bevonas',    15);
  w_ossz := greatest(1, w_tart + w_fris + w_sp + w_tek + w_kap + w_nyi + w_bev);
  v_minz   := grants.szam_beall('match_min_z', 0.5);
  v_minny  := grants.szam_beall('match_min_nyers', 20);
  v_kiemz  := grants.szam_beall('match_kiemelkedo_z', 1.0);
  v_bizdb  := grants.szam_beall('match_bizonyitek_db', 10)::integer;

  delete from grants.call_match where call_id = p_call;

  drop table if exists _arc;
  create temp table _arc as
    select cf.id, cf.nev, cf.vektor,
           -- CSAK a felhívás saját (angol) szövege megy az illesztésbe: az
           -- arculat magyar NEVE a felületnek szól, és beágyazva csak zaj.
           grants.tokenek(coalesce(nullif(btrim(cf.szoveg), ''), cf.nev)) as tok
      from grants.call_facet cf where cf.call_id = p_call;

  -- ---------- 1. menet: nyers hasonlóság ----------
  drop table if exists _nyers;
  create temp table _nyers (
    facet_id uuid, researcher_id uuid, ut text, nyers numeric, klaszter integer,
    ksuly numeric, kev numeric, tek numeric, kap numeric, nyi numeric, bev numeric,
    angol boolean, nyitott boolean, utolso_ev numeric);

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
        select x.klaszter, x.d, x.suly, x.atlag_ev
          into v_kl, v_dot, v_ksuly, v_kev
          from (select rv.klaszter, rv.suly, rv.atlag_ev, grants.vek_dot(rv.vektor, f.vektor) as d
                  from grants.researcher_vector rv where rv.researcher_id = r.id) x
         order by x.d desc limit 1;
      end if;

      if v_dot is not null then
        v_vekt := v_vekt + 1;
        insert into _nyers values (f.id, r.id, 'vektor',
          round(greatest(0, least(100, v_dot * 100))::numeric, 3), v_kl, v_ksuly, v_kev,
          r.tek, r.kap, r.nyi, r.bev, coalesce(r.angol, false),
          coalesce(r.csapatkereses, false), r.utolso_ev);
      else
        v_tok := v_tok + 1;
        insert into _nyers values (f.id, r.id, 'token',
          grants.token_atfedes(r.tok, f.tok), null, null, null,
          r.tek, r.kap, r.nyi, r.bev, coalesce(r.angol, false),
          coalesce(r.csapatkereses, false), r.utolso_ev);
      end if;
    end loop;
  end loop;

  -- ---------- 2. menet: arculaton belüli középre igazítás ----------
  -- A két út (beágyazás és szóegyezés) skálája más, ezért KÜLÖN-KÜLÖN
  -- igazodik középre; így a kettő egy listában összemérhető.
  drop table if exists _stat;
  create temp table _stat as
    select facet_id, ut, avg(nyers) as atl,
           greatest(coalesce(stddev_pop(nyers), 0), 0.001) as szo
      from _nyers group by facet_id, ut;

  insert into grants.call_match (call_id, researcher_id, facet_id, ut, tartalom, tartalom_nyers,
                                 frissesseg, sulypont, tekintely, kapacitas, nyitottsag, bevonas,
                                 ossz, klaszter, nyitott, van_angol, bizonyitek, mikor)
  select p_call, n.researcher_id, n.facet_id, n.ut,
         z.tartalom, n.nyers,
         z.fris,
         z.sp,
         n.tek, n.kap, n.nyi, n.bev,
         round((w_tart * z.tartalom + w_fris * z.fris + w_sp * z.sp + w_tek * n.tek
              + w_kap * n.kap + w_nyi * n.nyi + w_bev * n.bev) / w_ossz, 2),
         n.klaszter, n.nyitott, n.angol, '[]'::jsonb, now()
    from _nyers n
    join _stat s on s.facet_id = n.facet_id and s.ut = n.ut
    cross join lateral (
      select (n.nyers - s.atl) / s.szo as z) zz
    cross join lateral (
      select round(greatest(0, least(100, 50 + 12.5 * zz.z))::numeric, 2) as tartalom,
             case when n.ut = 'vektor' then grants.frissesseg_pont(n.kev)
                  else grants.frissesseg_pont(n.utolso_ev) end as fris,
             case when n.ut = 'vektor' then round(least(100, coalesce(n.ksuly, 0) * 100), 2)
                  else 50 end as sp) z
   -- Két feltétel: emelkedjen ki a mezőnyből ÉS legyen egyáltalán jele.
   -- A szóegyezésnél a nulla átfedés semmit nem jelent, a beágyazásnál pedig a
   -- tér anizotrópiája miatt egy alacsony nyers érték sem hordoz állítást.
   where zz.z >= v_minz
     and n.nyers > case when n.ut = 'token' then 0 else v_minny end;
  get diagnostics v_sor = row_count;

  -- ---------- 3. menet: bizonyíték csak az élmezőnyre ----------
  -- Eddig minden sorra kiszámoltuk, pedig csak a megjelenített jelölteknél
  -- látszik. Arculatonként az első néhány sorra korlátozva a futásidő töredéke.
  for b in select m.researcher_id, m.facet_id, m.klaszter, m.ut, cf.vektor
             from (select mm.*, row_number() over (partition by mm.facet_id order by mm.ossz desc) as rn
                     from grants.call_match mm where mm.call_id = p_call) m
             join grants.call_facet cf on cf.id = m.facet_id
            where m.rn <= greatest(1, v_bizdb)
  loop
    if b.ut = 'vektor' and b.vektor is not null then
      select coalesce(jsonb_agg(jsonb_build_object('cim', z.cim, 'ev', z.ev, 'doi', z.doi,
                                                   'hasonlosag', round((z.d * 100)::numeric, 1))
                                order by z.d desc), '[]'::jsonb)
        into v_biz
        from (select y.cim, y.ev, y.doi, grants.vek_dot(y.vektor, b.vektor) as d
                from (select w.cim, w.ev, w.doi, wv.vektor
                        from grants.researcher_work w
                        join grants.work_vector wv on wv.work_id = w.id
                       where w.researcher_id = b.researcher_id
                         and (b.klaszter is null or wv.klaszter is null or wv.klaszter = b.klaszter)
                       order by w.ev desc nulls last limit 12) y
               order by grants.vek_dot(y.vektor, b.vektor) desc limit 3) z;
    else
      select coalesce(jsonb_agg(jsonb_build_object('cim', z.cim, 'ev', z.ev, 'doi', z.doi)
                                order by z.ev desc nulls last), '[]'::jsonb)
        into v_biz
        from (select w.cim, w.ev, w.doi from grants.researcher_work w
               where w.researcher_id = b.researcher_id order by w.ev desc nulls last limit 3) z;
    end if;
    update grants.call_match set bizonyitek = v_biz
     where call_id = p_call and researcher_id = b.researcher_id and facet_id = b.facet_id;
  end loop;

  return jsonb_build_object(
    'call_id', p_call,
    'arculat_db', (select count(*) from _arc),
    'kutato_db', v_kut,
    'talalat_db', v_sor,
    'vektor_par', v_vekt,
    'token_par', v_tok,
    'tartalom_szoras', (select round(coalesce(stddev_pop(tartalom), 0), 2)
                          from grants.call_match where call_id = p_call),
    -- Üres arculat = ahol a legjobb jelölt sem emelkedik ki a mezőnyből.
    -- Ez az egyetlen értelmes mérce: abszolút koszinusszal sosem jelzett volna.
    'ures_arculatok', (select coalesce(jsonb_agg(a.nev order by a.nev), '[]'::jsonb)
                         from _arc a
                        where coalesce((select max((n.nyers - s.atl) / s.szo)
                                          from _nyers n join _stat s
                                            on s.facet_id = n.facet_id and s.ut = n.ut
                                         where n.facet_id = a.id), 0) < v_kiemz),
    'ido_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric, 1));
end $$;

do $chk$
begin
  raise notice 'Rendben: 95 — a tartalmi pontszam arculaton belul kozepre igazitva, tekintely suly 8.';
end $chk$;
