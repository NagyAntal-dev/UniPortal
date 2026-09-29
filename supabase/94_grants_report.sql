-- ============================================================
-- 94_grants_report.sql — „kit melyik felhívásra" egy lekérdezésben
-- ============================================================
-- MIÉRT: a találatok eddig csak az irodai felületen látszottak, mert minden
-- olvasó RPC auth.uid()-t kíván. Az ütemezett futásnak és a heti
-- összefoglalónak viszont nincs bejelentkezett felhasználója — ezért kell egy
-- szolgáltatási olvasó, amely UGYANAZT a tartalmat adja vissza, csak gép
-- számára.
--
-- MIT AD: felhívásonként az arculatok, arculatonként a legjobb jelöltek —
-- névvel, karral, komponensekkel, és azzal a művel, amire a találat épül.
-- Plusz a csapatjavaslat szolgáltatási változata, hogy az ütemezett kör a
-- csapatokat is elő tudja készíteni.
--
-- AMI NEM VÁLTOZIK: a pontszám, a küszöb, a jogosultsági rend. A jelentés
-- ugyanabból a grants.call_match táblából olvas, amit a felület mutat.
--
-- ADATVÉDELEM: a jelentés kutatói neveket ad vissza — ezért KIZÁRÓLAG a
-- service_role hívhatja, a bejelentkezett felhasználó nem (ő a saját
-- jogosultsága szerinti irodai nézetet kapja, változatlanul).
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function public.grants_match_report_etl(
  p_limit   integer default 10,   -- hány felhívás
  p_jelolt  integer default 5,    -- arculatonként hány jelölt
  p_call    uuid    default null) -- vagy egyetlen felhívás
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object(
                   'call_id', c.id,
                   'felhivas', c.cim,
                   'program', c.program,
                   'hatarido', c.kovetkezo_hatarido,
                   'url', c.url,
                   'talalat_db', (select count(*) from grants.call_match m where m.call_id = c.id),
                   'arculatok', coalesce((
                      select jsonb_agg(jsonb_build_object(
                               'arculat', f.nev,
                               'szoveg', left(coalesce(f.szoveg, ''), 160),
                               'jelolt_db', (select count(*) from grants.call_match m2
                                              where m2.call_id = c.id and m2.facet_id = f.id),
                               'jeloltek', coalesce((
                                  select jsonb_agg(jsonb_build_object(
                                           'nev', r.nev, 'kar', r.kar, 'intezet', r.intezet,
                                           'ossz', m.ossz, 'tartalom', m.tartalom,
                                           'frissesseg', m.frissesseg, 'tekintely', m.tekintely,
                                           'kapacitas', m.kapacitas, 'bevonas', m.bevonas,
                                           'ut', m.ut, 'van_angol', m.van_angol,
                                           'nyitott', m.nyitott,
                                           -- Soha nem kértük még fel valódi felkéréssel?
                                           'ujonnan', not exists (select 1 from grants.invite i
                                                                   where i.researcher_id = m.researcher_id
                                                                     and grants.invite_valodi(i.allapot)),
                                           'mar_felkerve', exists (select 1 from grants.invite i
                                                                    where i.call_id = c.id
                                                                      and i.researcher_id = m.researcher_id),
                                           -- Mire alapozzuk: a legjobb bizonyíték címe és éve.
                                           'mire', (m.bizonyitek->0->>'cim'),
                                           'mire_ev', (m.bizonyitek->0->>'ev'))
                                           order by m.ossz desc)
                                    from (select * from grants.call_match mm
                                           where mm.call_id = c.id and mm.facet_id = f.id
                                           order by mm.ossz desc
                                           limit least(greatest(coalesce(p_jelolt, 5), 1), 25)) m
                                    join grants.researcher r on r.id = m.researcher_id), '[]'::jsonb))
                               order by f.sorszam)
                        from grants.call_facet f where f.call_id = c.id), '[]'::jsonb)) as sor
            from grants.call c
           where c.archivalt = false
             and (p_call is null or c.id = p_call)
             and (p_call is not null
                  or (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now()))
             and exists (select 1 from grants.call_match m where m.call_id = c.id)
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 10), 1), 50)) t
$$;

-- A csapatajánló szolgáltatási változata: ugyanaz a lefedés, ugyanazok a
-- megszorítások, csak bejelentkezett felhasználó nélkül — így az ütemezett kör
-- is elő tudja készíteni a javaslatokat.
create or replace function public.grants_team_suggest_etl(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
set statement_timeout = '180s'
as $$
declare v_karok integer; v_id uuid;
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
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

  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'valtozat', t.valtozat, 'nev', t.nev, 'indoklas', t.indoklas,
                   'meret', t.meret, 'lefedett', t.lefedett, 'arculat_db', t.arculat_db,
                   'ujonnan_db', t.ujonnan_db, 'kar_db', t.kar_db,
                   'ures_arculat', t.ures_arculat,
                   'tagok', coalesce((select jsonb_agg(jsonb_build_object(
                              'nev', r.nev, 'kar', r.kar, 'szerep', cm.szerep,
                              'arculat', f.nev, 'ossz', cm.ossz, 'ujonnan', cm.ujonnan)
                              order by (cm.szerep = 'vezeto') desc, cm.ossz desc)
                       from grants.call_team_member cm
                       join grants.researcher r on r.id = cm.researcher_id
                       left join grants.call_facet f on f.id = cm.facet_id
                      where cm.team_id = t.id), '[]'::jsonb))
                   order by t.valtozat), '[]'::jsonb)
            from grants.call_team t where t.call_id = p_call);
end $$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text;
begin
  foreach f in array array[
    'public.grants_match_report_etl(integer,integer,uuid)',
    'public.grants_team_suggest_etl(uuid,boolean)'
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
    'public.grants_match_report_etl(integer,integer,uuid)',
    'public.grants_team_suggest_etl(uuid,boolean)'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', f, 'execute') then
      raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is hivhatja a neveket ado jelentest: %', f;
    end if;
  end loop;
  raise notice 'Rendben: 94 — szolgaltatasi jelentes es csapatajanlo (csak service_role).';
end $chk$;
