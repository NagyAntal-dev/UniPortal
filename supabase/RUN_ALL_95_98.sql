-- ============================================================================
-- RUN_ALL_95_98.sql — a kutatóválasztás logikájának javítása
-- ============================================================================
-- MIÉRT EGY SZKRIPT NÉGY MIGRÁCIÓBÓL: ugyanannak a hibának a négy oka. A
-- rendszer olyan kollégákat javasolt, akiknek semmi közük a felhíváshoz.
-- Sorban, MÉRT okokkal:
--
--   95 — A PONTSZÁM ABSZOLÚT VOLT, PEDIG CSAK RELATÍVAN JELENT VALAMIT.
--        A beágyazási tér anizotrop: két tetszőleges szöveg koszinusza is 0,6
--        körül van. A tartalmi pontszám szórása 2,95 volt — tehát nem
--        különböztetett meg senkit. Mostantól arculaton belül középre igazítva
--        számol (z-érték), és csak a mezőnyből kiemelkedő jelölt kerül listára.
--
--   96 — A CSAPATJAVASLAT CSAK GOMBNYOMÁSRA KÉSZÜLT, és zsákutcába futott, ha
--        még nem volt illesztés. Mostantól magától párosít, minden felhívásra
--        legyárt javaslatot, és a listakártyán kiírja a NEVEKET.
--
--   97 — A SÚLYOZÁS ENGEDTE, HOGY TÉMÁTÓL FÜGGETLEN KOMPONENSEK DÖNTSENEK.
--        A hét komponensből négy semmit nem tud a felhívásról. A bevonás teljes
--        kilengése 16,6 pontot mozdított, egy szórásnyi témakülönbség 6-ot —
--        vagyis a méltányosság elnyomta a szakmai illeszkedést. Az új súlyokkal
--        a bevonás pont annyit mozdít, mint egy szórásnyi témakülönbség:
--        döntetlennél dönt, a kompetencia helyett nem.
--
--   98 — A LEGFONTOSABB: A KUTATÓ TÉMAKÖR-ÁTLAGÁHOZ HASONLÍTOTTUNK.
--        Egy vegyes életmű középpontja mindentől középtávolra esik, és pont azt
--        a jelet mossa el, amiért az egészet csináljuk. MÉRVE, ugyanazzal a
--        modellel, egy repülőgépes arculatra:
--            repülőgép-szerkezeti cikk 0,771 · áramlástan 0,661
--            szenzorhálózat 0,556 · pénzügyi felmérés 0,546 · HR-beszámoló 0,542
--          → egyedi művekre a szórás 0,089; témakör-átlagokra élesben 0,0295.
--        Háromszoros különbség: a modell tud különbséget tenni, az átlagolás
--        dobta el. Mostantól az előszűrés megy a középpontokkal, a DÖNTÉS pedig
--        a kutató legjobb KONKRÉT MŰVÉHEZ mért hasonlósággal — és a bizonyíték
--        is onnan jön, tehát a „miért ő" mindig valódi művet nevez meg.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 95 — a tartalmi pontszam arculaton belul kozepre igazitva, tekintely suly 8.
--   NOTICE: Rendben: 96 — csapatjavaslat magatol, sorral es nevekkel a kartyakon.
--   NOTICE: Rendben: 97 — 1 szorasnyi temakulonbseg 6.7 pont, a bevonas teljes kilengese 5.9 pont.
--   NOTICE: Rendben: 98 — eloszures kozepponttal, dontes a konkret muvel.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
--
-- Ha a 95-öt vagy a 96-ot már futtattad, ez akkor is biztonságos: minden lépés
-- újrafuttatható, és a beállításokat csak akkor írja át, ha még az eredeti
-- alapértéken állnak.
--
-- FUTÁS UTÁN: újragenerálom az arculatokat, újra párosítok, legyártom a
-- csapatjavaslatokat minden felhívásra, és kiírom a listát — nevekkel és azzal
-- a művel, amire a javaslat épül.
-- ============================================================================



-- ####################################################################
-- ### 95_grants_match_calibration.sql
-- ####################################################################

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


-- ####################################################################
-- ### 96_grants_team_auto.sql
-- ####################################################################

-- ============================================================
-- 96_grants_team_auto.sql — csapatjavaslat magától, minden felhívásra
-- ============================================================
-- MIÉRT: a csapatjavaslat eddig gombnyomásra készült. Aki megnyomta egy olyan
-- felhíváson, amelyen még nem futott illesztés, ezt kapta:
--     „GRANTS_HIBA: ehhez a felhíváshoz még nincs illesztés"
-- Ez technikailag igaz volt, de zsákutca: a felhasználónak kellett kitalálnia,
-- hogy előbb az arculatokat, aztán az illesztést kell lefuttatnia.
--
-- MIT VÁLTOZTAT:
--   1) A csapatajánló MAGÁTÓL lefuttatja az illesztést, ha még nincs találat.
--      Csak akkor áll meg, ha arculat sincs — mert azt nem lehet kitalálni.
--   2) Új sor (grants_team_queue): mely felhívásokhoz kell csapatjavaslat.
--      Ebből az ütemezett kör MINDEN felhívásra előállítja a javaslatokat, nem
--      csak arra, amelyiket valaki megnyitotta.
--   3) Új áttekintő (grants_team_overview): felhívásonként a javasolt csapat
--      NEVEKKEL — ezt írja ki a felület a kártyákra, hogy a listán is látszódjon,
--      kit javasolunk, ne csak a megnyitott felhívásnál.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. A csapatépítő ne fusson zsákutcába
-- ------------------------------------------------------------
create or replace function grants.team_keszit(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '180s'
as $$
declare v_karok integer; v_id uuid; v_illesztett jsonb := null;
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
  if not exists (select 1 from grants.call_facet where call_id = p_call) then
    raise exception 'GRANTS_HIBA: ehhez a felhíváshoz még nincs arculat. Az arculatokat a gépi kör készíti, vagy kézzel megadhatók.';
  end if;

  -- Ha nincs találat, előbb párosítunk. A felhasználónak nem kell tudnia, hogy
  -- a kettő két külön lépés.
  if not exists (select 1 from grants.call_match where call_id = p_call) then
    v_illesztett := grants.call_match_run(p_call, p_csak_nyitott);
  end if;

  if not exists (select 1 from grants.call_match where call_id = p_call) then
    -- Lefutott az illesztés, de senki nem emelkedett ki: ez ÉRDEMI válasz,
    -- nem hiba. Ilyenkor csapat sincs, és ezt ki is mondjuk.
    delete from grants.call_team where call_id = p_call;
    return jsonb_build_object('csapatok', '[]'::jsonb, 'illesztes', v_illesztett,
      'uzenet', 'Erre a felhívásra egyetlen kolléga sem emelkedik ki a mezőnyből — a csapatot kívülről kell építeni.');
  end if;

  v_id := grants.team_build(p_call, 'lefedes', p_csak_nyitott);
  v_id := grants.team_build(p_call, 'vezetos', p_csak_nyitott);

  select count(distinct r.kar) into v_karok
    from grants.call_match m join grants.researcher r on r.id = m.researcher_id
   where m.call_id = p_call and nullif(btrim(coalesce(r.kar, '')), '') is not null;
  if coalesce(v_karok, 0) >= 2 then
    v_id := grants.team_build(p_call, 'ketkar', p_csak_nyitott);
  else
    delete from grants.call_team where call_id = p_call and valtozat = 'ketkar';
  end if;

  return jsonb_build_object('csapatok', grants.team_lista(p_call), 'illesztes', v_illesztett);
end $$;

-- A csapatok kiolvasása egy helyen: a felület, az ETL és az áttekintő
-- UGYANAZT az alakot kapja.
create or replace function grants.team_lista(p_call uuid)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'valtozat', t.valtozat, 'nev', t.nev, 'indoklas', t.indoklas,
           'meret', t.meret, 'lefedett', t.lefedett, 'arculat_db', t.arculat_db,
           'atlag_ossz', t.atlag_ossz, 'ujonnan_db', t.ujonnan_db, 'kar_db', t.kar_db,
           'ures_arculat', t.ures_arculat,
           'tagok', coalesce((select jsonb_agg(jsonb_build_object(
                      'researcher_id', m.researcher_id, 'nev', r.nev, 'kar', r.kar,
                      'intezet', r.intezet, 'szerep', m.szerep, 'ossz', m.ossz,
                      'bevonas', m.bevonas, 'ujonnan', m.ujonnan, 'arculat', f.nev,
                      'felkerve', exists (select 1 from grants.invite i
                                           where i.call_id = t.call_id
                                             and i.researcher_id = m.researcher_id))
                      order by (m.szerep = 'vezeto') desc, m.ossz desc)
               from grants.call_team_member m
               join grants.researcher r on r.id = m.researcher_id
               left join grants.call_facet f on f.id = m.facet_id
              where m.team_id = t.id), '[]'::jsonb))
           order by t.valtozat), '[]'::jsonb)
    from grants.call_team t where t.call_id = p_call
$$;

create or replace function public.grants_team_suggest(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '180s'
as $$
declare v jsonb;
begin
  perform grants.require_office();
  v := grants.team_keszit(p_call, p_csak_nyitott);
  -- A felület a csapatok tömbjét várja; az üzenet külön ágon megy.
  return v->'csapatok';
end $$;

create or replace function public.grants_team_suggest_etl(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '180s'
as $$
begin
  return grants.team_keszit(p_call, p_csak_nyitott);
end $$;


-- ------------------------------------------------------------
-- 2. Sor: mely felhívásokhoz kell (friss) csapatjavaslat
-- ------------------------------------------------------------
create or replace function public.grants_team_queue(p_limit integer default 10)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim,
                                    'hatarido', c.kovetkezo_hatarido) as sor
            from grants.call c
           where c.archivalt = false
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
             and exists (select 1 from grants.call_facet f where f.call_id = c.id)
             -- Nincs még javaslat, VAGY az illesztés frissebb, mint a javaslat.
             and (not exists (select 1 from grants.call_team t where t.call_id = c.id)
                  or coalesce((select max(m.mikor) from grants.call_match m where m.call_id = c.id),
                              now())
                     > (select max(t.created_at) from grants.call_team t where t.call_id = c.id))
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 10), 1), 50)) t
$$;


-- ------------------------------------------------------------
-- 3. Áttekintő: a kártyákra kiírandó nevek
-- ------------------------------------------------------------
-- A lista nézetnek nem a teljes csapatszerkezet kell, hanem az, hogy egy
-- pillantással látszódjon: kit javaslunk erre a felhívásra, és mi hiányzik.
create or replace function public.grants_team_overview(
  p_q text default null, p_limit integer default 40, p_csak_javaslattal boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_office();
  return (select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object(
                   'call_id', c.id, 'cim', c.cim, 'program', c.program,
                   'hatarido', c.kovetkezo_hatarido, 'url', c.url,
                   'arculat_db', (select count(*) from grants.call_facet f where f.call_id = c.id),
                   'talalat_db', (select count(*) from grants.call_match m where m.call_id = c.id),
                   'felkert_db', (select count(*) from grants.invite i
                                   where i.call_id = c.id and grants.invite_valodi(i.allapot)),
                   -- A „széles lefedés" változat a lista nézet alapja; ha nincs,
                   -- a legelső elérhető javaslat.
                   'csapat', (select jsonb_build_object(
                                'valtozat', ct.valtozat, 'nev', ct.nev,
                                'meret', ct.meret, 'lefedett', ct.lefedett,
                                'arculat_db', ct.arculat_db, 'ujonnan_db', ct.ujonnan_db,
                                'kar_db', ct.kar_db, 'ures_arculat', ct.ures_arculat,
                                'tagok', coalesce((select jsonb_agg(jsonb_build_object(
                                           'researcher_id', m.researcher_id, 'nev', r.nev,
                                           'kar', r.kar, 'szerep', m.szerep, 'ossz', m.ossz,
                                           'ujonnan', m.ujonnan, 'arculat', f.nev,
                                           'felkerve', exists (select 1 from grants.invite i
                                                                where i.call_id = c.id
                                                                  and i.researcher_id = m.researcher_id))
                                           order by (m.szerep = 'vezeto') desc, m.ossz desc)
                                    from grants.call_team_member m
                                    join grants.researcher r on r.id = m.researcher_id
                                    left join grants.call_facet f on f.id = m.facet_id
                                   where m.team_id = ct.id), '[]'::jsonb))
                               from grants.call_team ct
                              where ct.call_id = c.id
                              order by (ct.valtozat = 'lefedes') desc, ct.lefedett desc
                              limit 1)) as sor
            from grants.call c
           where c.archivalt = false
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
             and (p_q is null or btrim(p_q) = '' or c.cim ilike '%' || btrim(p_q) || '%')
             and (not coalesce(p_csak_javaslattal, false)
                  or exists (select 1 from grants.call_team t where t.call_id = c.id))
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 40), 1), 100)) t);
end $$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text;
begin
  foreach f in array array['grants.team_keszit(uuid,boolean)', 'grants.team_lista(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  foreach f in array array[
    'public.grants_team_suggest(uuid,boolean)',
    'public.grants_team_overview(text,integer,boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;

  foreach f in array array[
    'public.grants_team_suggest_etl(uuid,boolean)',
    'public.grants_team_queue(integer)'
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
  foreach f in array array['public.grants_team_suggest_etl(uuid,boolean)', 'public.grants_team_queue(integer)'] loop
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', f, 'execute') then
      raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is hivhatja az ETL-t: %', f;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.grants_team_overview(text,integer,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon lathatja a csapatjavaslatokat.';
  end if;
  raise notice 'Rendben: 96 — csapatjavaslat magatol, sorral es nevekkel a kartyakon.';
end $chk$;


-- ####################################################################
-- ### 97_grants_suly_ujrahangolas.sql
-- ####################################################################

-- ============================================================
-- 97_grants_suly_ujrahangolas.sql — a téma döntsön, a méltányosság csak
--                                    döntetlennél
-- ============================================================
-- MIÉRT: a hét pontszám-komponensből NÉGY semmit nem tud a felhívásról
-- (tekintély, kapacitás, nyitottság, bevonás). A régi súlyokkal ezek együtt 36
-- pontot vittek a 83-ból, és a kilengésük nagyobb volt, mint a tartalomé:
--
--   komponens   súly   tipikus kilengés   hatás az összpontszámra
--   tartalom     40    ±1 szórás = 12,5   6,0 pont
--   bevonás      15    8 → 100 = 92       16,6 pont      ← ez dönt!
--   tekintély    12    50 → 96 = 46       6,6 pont
--
-- Vagyis egy soha fel nem kért, közepesen illeszkedő kolléga megelőzte a
-- témában erőset, aki már két pályázatban benne volt. A terv ezzel szemben azt
-- mondja: a méltányosság a ZÖREJEN BELÜL dönt, nem a kompetencia helyett.
--
-- AZ ÚJ SÚLYOK ÉS AZ ARITMETIKA (összeg 93):
--   tartalom 50  → 1 szórásnyi témakülönbség 6,7 pont
--   bevonás   6  → a teljes kilengés        5,9 pont   ≈ 1 szórásnyi téma
--   tekintély 8, kapacitás 6, nyitottság 3, frissesség 12, súlypont 8
--
-- Így a bevonás pontosan annyit mozdít, amennyi egy szórásnyi témakülönbség:
-- két hasonlóan illeszkedő jelölt közül a kevesebbet szerepeltet hozza előre,
-- de a témában lényegesen jobbat NEM előzi meg.
--
-- A BEVONÁS EZZEL NEM GYENGÜL — csak a helyére kerül. A csapatépítő továbbra is
-- fenntart egy helyet az újonnan bevonható kollégának, és a döntetlen-sávon
-- belül a kevesebbet szerepelt nyer (90_grants_teams.sql). A méltányosság ott
-- szerkezeti szabály, itt pedig rangsor-finomhangolás.
--
-- MIND A HÉT ÉRTÉK A BEÁLLÍTÁSOKBAN MARAD: az iroda bármikor átállíthatja, ha
-- más egyensúlyt akar. Ez a migráció csak az alapértelmezést hangolja.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- Csak az alapértelmezésen változtatunk: ha az iroda már kézzel átállította,
-- azt tiszteletben tartjuk (a where feltétel a régi alapértéket nézi).
update grants.setting set value = '50', updated_at = now()
 where key = 'pont_suly_tartalom'   and value = '40';
update grants.setting set value = '6',  updated_at = now()
 where key = 'pont_suly_bevonas'    and value = '15';
update grants.setting set value = '6',  updated_at = now()
 where key = 'pont_suly_kapacitas'  and value = '8';
update grants.setting set value = '3',  updated_at = now()
 where key = 'pont_suly_nyitottsag' and value = '5';

update grants.setting
   set description = 'A tartalmi hasonlóság súlya. Ez a legnagyobb: a téma döntsön.'
 where key = 'pont_suly_tartalom';
update grants.setting
   set description = 'A bevonási méltányosság súlya. Szándékosan akkora, hogy a teljes kilengése ~1 szórásnyi témakülönbséggel érjen fel: döntetlennél dönt, a kompetencia helyett nem.'
 where key = 'pont_suly_bevonas';

do $chk$
declare v_tart numeric; v_bev numeric; v_ossz numeric;
begin
  v_tart := grants.szam_beall('pont_suly_tartalom', 50);
  v_bev  := grants.szam_beall('pont_suly_bevonas', 6);
  v_ossz := v_tart + grants.szam_beall('pont_suly_frissesseg', 12)
          + grants.szam_beall('pont_suly_sulypont', 8) + grants.szam_beall('pont_suly_tekintely', 8)
          + grants.szam_beall('pont_suly_kapacitas', 6) + grants.szam_beall('pont_suly_nyitottsag', 3)
          + v_bev;
  -- A mérce: egy szórásnyi témakülönbség (12,5 pont tartalom) legalább annyit
  -- mozdítson, mint a bevonás TELJES kilengése (92 pont). Ha ez nem áll, a
  -- méltányosság újra elnyomná a szakmai illeszkedést.
  if (12.5 * v_tart / v_ossz) < (92 * v_bev / v_ossz) * 0.9 then
    raise exception 'ARANY HIBA: a bevonas tobbet mozdit, mint egy szorasnyi temakulonbseg (tartalom=%, bevonas=%).', v_tart, v_bev;
  end if;
  raise notice 'Rendben: 97 — 1 szorasnyi temakulonbseg % pont, a bevonas teljes kilengese % pont.',
    round(12.5 * v_tart / v_ossz, 1), round(92 * v_bev / v_ossz, 1);
end $chk$;


-- ####################################################################
-- ### 98_grants_rerank.sql
-- ####################################################################

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
