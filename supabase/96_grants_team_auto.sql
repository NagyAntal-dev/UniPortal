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
