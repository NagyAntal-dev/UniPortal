-- ============================================================
-- 90_grants_teams.sql — csapatajánlás lefedéssel, nem rangsorból
-- ============================================================
-- MIÉRT NEM RANGSOR: egy pályázatot nem a legjobb öt egyéni találat nyer meg,
-- hanem egy csapat, amely LEFEDI a felhívás összes elvárt kompetenciáját. Öt
-- hasonló profilú kutató együtt kevesebb, mint három egymást kiegészítő.
--
-- HOGYAN: a 89-es migráció arculatokra bontja a felhívást és arculatonként
-- pontoz. Itt a csapat úgy áll össze, hogy mindig arra az arculatra keresünk
-- embert, amelyik a legközelebb áll az ÜRESEN MARADÁSHOZ. Így egy közepes
-- összesített pontszámú kutató is bejut, ha ő az egyetlen, aki egy elvárást hoz.
--
-- BEVONÁSI MÉLTÁNYOSSÁG (88): minden ajánlott csapatban legalább egy hely
-- újonnan bevonható kollégának van fenntartva, és közel egyenlő illeszkedésnél
-- (a zörejen belül) a kevesebbet szerepelt nyer.
--
-- AMIT A MÉLTÁNYOSSÁG NEM ÍR FELÜL — szándékosan:
--   * a vezetőjelöltet (bizonyított utolsó szerzőség vagy pályázati előzmény),
--   * a kemény jogosultsági kapukat,
--   * azt az arculatot, amelyre házon belül EGYETLEN alkalmas ember van.
--
-- A KIMENET 2–3 VÁLTOZAT, nem egy csapat: az iroda összehasonlít, nem elfogad.
-- És kiírja azt az arculatot, amelyre nincs házon belüli jelölt — ez nem
-- hibaüzenet, hanem a legfontosabb kimenet.
--
-- Futtatás után: 21_echo_harden_submit.sql újra.
-- ============================================================

create table if not exists grants.call_team (
  id          uuid primary key default gen_random_uuid(),
  call_id     uuid not null references grants.call(id) on delete cascade,
  valtozat    text not null
                constraint grants_team_valtozat_ck
                check (valtozat in ('lefedes','vezetos','ketkar')),
  nev         text not null,
  indoklas    text,
  meret       integer not null default 0,
  lefedett     integer not null default 0,     -- hány arculatot fed le
  arculat_db   integer not null default 0,     -- ennyiből
  ures_arculat jsonb not null default '[]'::jsonb,
  atlag_ossz   numeric(6,2),
  ujonnan_db   integer not null default 0,     -- hány eddig soha fel nem kért tag
  kar_db       integer not null default 0,
  letrehozta  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint grants_team_uq unique (call_id, valtozat)
);

create table if not exists grants.call_team_member (
  team_id       uuid not null references grants.call_team(id) on delete cascade,
  researcher_id uuid not null references grants.researcher(id) on delete cascade,
  facet_id      uuid references grants.call_facet(id) on delete set null,
  szerep        text not null default 'tag'
                  constraint grants_team_szerep_ck check (szerep in ('vezeto','tag','tanacsado')),
  ossz          numeric(6,2),
  bevonas       numeric(6,2),
  ujonnan       boolean not null default false,
  primary key (team_id, researcher_id)
);

insert into grants.setting (key, value, description) values
  ('csapat_min_meret',      '3', 'A javasolt csapat legkisebb mérete.'),
  ('csapat_max_meret',      '6', 'A javasolt csapat legnagyobb mérete.'),
  ('csapat_tie_zorej',      '3', 'Ennél kisebb pontszám-különbség döntetlen: ilyenkor a kevesebbet szerepelt nyer.'),
  ('csapat_kapacitas_min', '20', 'Ez alatti kapacitásnál a kolléga nem kerül be a javaslatba.')
on conflict (key) do nothing;


-- ------------------------------------------------------------
-- Vezetői alkalmasság: BIZONYÍTOTT tapasztalat, nem beosztás.
-- ------------------------------------------------------------
create or replace function grants.vezeto_alkalmas(p_researcher uuid)
returns boolean
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select exists (select 1 from grants.researcher_work w
                  where w.researcher_id = p_researcher and w.szerzoi_pozicio = 'utolso')
      or exists (select 1 from grants.researcher_grant g where g.researcher_id = p_researcher)
      or exists (select 1 from grants.invite i
                  where i.researcher_id = p_researcher and i.szerep = 'vezeto'
                    and i.allapot in ('elfogadta','beadva','nyert'))
$$;


-- ------------------------------------------------------------
-- A lefedés algoritmusa
-- ------------------------------------------------------------
create or replace function grants.team_build(p_call uuid, p_valtozat text, p_csak_nyitott boolean default false)
returns uuid
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare
  v_min integer; v_max integer; v_zorej numeric; v_kapmin numeric;
  v_team uuid; f record; c record;
  v_db integer := 0; v_kar_elso text; v_fenntart integer := 0; v_hely integer;
begin
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;
  if not exists (select 1 from grants.call_match where call_id = p_call) then
    raise exception 'GRANTS_HIBA: ehhez a felhíváshoz még nincs illesztés — előbb a párosítást kell lefuttatni.';
  end if;

  v_min    := grants.szam_beall('csapat_min_meret', 3)::integer;
  v_max    := grants.szam_beall('csapat_max_meret', 6)::integer;
  v_zorej  := greatest(1, grants.szam_beall('csapat_tie_zorej', 3));
  v_kapmin := grants.szam_beall('csapat_kapacitas_min', 20);

  -- A jelöltek. A 'sav' a döntetlen-kezelés: a zörejen belüli különbség egy
  -- sávba esik, és a sávon BELÜL a kevesebbet szerepelt nyer — nem a magasabb
  -- h-indexű.
  drop table if exists _jel;
  create temp table _jel as
    select m.facet_id, m.researcher_id, m.ossz, m.bevonas, m.tekintely, m.kapacitas,
           r.kar, r.nev,
           floor(m.ossz / v_zorej) as sav,
           not exists (select 1 from grants.invite i
                        where i.researcher_id = m.researcher_id
                          and grants.invite_valodi(i.allapot)) as ujonnan,
           grants.vezeto_alkalmas(m.researcher_id) as vezetheti
      from grants.call_match m
      join grants.researcher r on r.id = m.researcher_id
     where m.call_id = p_call
       and m.kapacitas >= v_kapmin
       and (not coalesce(p_csak_nyitott, false) or m.nyitott);

  drop table if exists _arcs;
  create temp table _arcs as
    select f2.id, f2.nev, f2.sorszam, (select count(*) from _jel j where j.facet_id = f2.id) as db
      from grants.call_facet f2 where f2.call_id = p_call;

  delete from grants.call_team where call_id = p_call and valtozat = p_valtozat;
  insert into grants.call_team (call_id, valtozat, nev, letrehozta)
  values (p_call, p_valtozat,
          case p_valtozat when 'lefedes' then 'Széles lefedés'
                          when 'vezetos' then 'Erős vezető'
                          else 'Két kar' end,
          auth.uid())
  returning id into v_team;

  -- Egy hely fenntartva az újonnan bevonható kollégának — tapasztalt vezető
  -- MELLÉ, nem helyette. Ezért a lefedés eggyel kevesebb helyre dolgozik.
  if exists (select 1 from _jel j where j.ujonnan) then v_fenntart := 1; end if;
  v_hely := greatest(v_min, v_max - v_fenntart);

  -- 1) Az 'erős vezető' változat a legjobb vezetőjelölttel kezd.
  if p_valtozat = 'vezetos' then
    select j.* into c from _jel j where j.vezetheti
     order by j.tekintely desc, j.ossz desc limit 1;
    if c.researcher_id is not null then
      insert into grants.call_team_member (team_id, researcher_id, facet_id, szerep, ossz, bevonas, ujonnan)
      values (v_team, c.researcher_id, c.facet_id, 'vezeto', c.ossz, c.bevonas, c.ujonnan);
      v_db := 1; v_kar_elso := c.kar;
    end if;
  end if;

  -- 2) Lefedés: mindig arra az arculatra keresünk embert, amelyik a legközelebb
  -- áll az ÜRESEN MARADÁSHOZ (legkevesebb jelölt).
  for f in select a.id, a.nev, a.db from _arcs a order by a.db asc, a.sorszam loop
    exit when v_db >= v_hely;
    continue when exists (select 1 from grants.call_team_member t
                           where t.team_id = v_team and t.facet_id = f.id);
    select j.* into c
      from _jel j
     where j.facet_id = f.id
       and not exists (select 1 from grants.call_team_member t
                        where t.team_id = v_team and t.researcher_id = j.researcher_id)
       -- A 'két kar' változatban a második tag más karról jön.
       and (p_valtozat <> 'ketkar' or v_db <> 1 or v_kar_elso is null
            or coalesce(j.kar, '') <> coalesce(v_kar_elso, ''))
     order by j.sav desc, j.bevonas desc, j.ossz desc
     limit 1;
    continue when c.researcher_id is null;
    insert into grants.call_team_member (team_id, researcher_id, facet_id, szerep, ossz, bevonas, ujonnan)
    values (v_team, c.researcher_id, c.facet_id, 'tag', c.ossz, c.bevonas, c.ujonnan);
    v_db := v_db + 1;
    if v_kar_elso is null then v_kar_elso := c.kar; end if;
  end loop;

  -- 3) Ha a minimumot nem érte el: a legjobb maradék jelöltek.
  while v_db < v_min loop
    select j.* into c from _jel j
     where not exists (select 1 from grants.call_team_member t
                        where t.team_id = v_team and t.researcher_id = j.researcher_id)
     order by j.sav desc, j.bevonas desc, j.ossz desc limit 1;
    exit when c.researcher_id is null;
    insert into grants.call_team_member (team_id, researcher_id, facet_id, szerep, ossz, bevonas, ujonnan)
    values (v_team, c.researcher_id, c.facet_id, 'tag', c.ossz, c.bevonas, c.ujonnan);
    v_db := v_db + 1;
  end loop;

  -- 4) A fenntartott hely. Ha a lefedésbe már bekerült újonnan bevonható
  -- kolléga, a hely a legjobb maradékra megy — nem hagyjuk kihasználatlanul.
  if v_db < v_max then
    if not exists (select 1 from grants.call_team_member t where t.team_id = v_team and t.ujonnan) then
      select j.* into c from _jel j
       where j.ujonnan
         and not exists (select 1 from grants.call_team_member t
                          where t.team_id = v_team and t.researcher_id = j.researcher_id)
       order by j.ossz desc limit 1;
    else
      select j.* into c from _jel j
       where not exists (select 1 from grants.call_team_member t
                          where t.team_id = v_team and t.researcher_id = j.researcher_id)
       order by j.sav desc, j.bevonas desc, j.ossz desc limit 1;
    end if;
    if c.researcher_id is not null then
      insert into grants.call_team_member (team_id, researcher_id, facet_id, szerep, ossz, bevonas, ujonnan)
      values (v_team, c.researcher_id, c.facet_id, 'tag', c.ossz, c.bevonas, c.ujonnan);
      v_db := v_db + 1;
    end if;
  end if;

  -- 5) Vezető kijelölése, ha még nincs. Bizonyított tapasztalat kell hozzá —
  -- ezt a bevonási méltányosság NEM írja felül.
  if not exists (select 1 from grants.call_team_member where team_id = v_team and szerep = 'vezeto') then
    update grants.call_team_member t set szerep = 'vezeto'
     where t.team_id = v_team
       and t.researcher_id = (select t2.researcher_id
                                from grants.call_team_member t2
                               where t2.team_id = v_team
                                 and grants.vezeto_alkalmas(t2.researcher_id)
                               order by t2.ossz desc nulls last limit 1);
  end if;

  -- 6) Összesítők a csapatra.
  update grants.call_team t
     set meret      = (select count(*) from grants.call_team_member m where m.team_id = t.id),
         lefedett   = (select count(distinct m.facet_id) from grants.call_team_member m
                        where m.team_id = t.id and m.facet_id is not null),
         arculat_db = (select count(*) from _arcs),
         atlag_ossz = (select round(avg(m.ossz), 2) from grants.call_team_member m where m.team_id = t.id),
         ujonnan_db = (select count(*) from grants.call_team_member m where m.team_id = t.id and m.ujonnan),
         kar_db     = (select count(distinct coalesce(r.kar, '(nincs)'))
                         from grants.call_team_member m
                         join grants.researcher r on r.id = m.researcher_id
                        where m.team_id = t.id),
         -- EZ A LEGFONTOSABB KIMENET: a lefedetlen arculatok, és hogy volt-e
         -- rájuk egyáltalán házon belüli jelölt. Ahol nincs, oda külső
         -- partnert kell keresni — itt fordul át a modul konzorciumkeresésbe.
         ures_arculat = (select coalesce(jsonb_agg(jsonb_build_object(
                                  'nev', a.nev, 'van_jelolt', a.db > 0, 'jelolt_db', a.db)
                                  order by a.sorszam), '[]'::jsonb)
                           from _arcs a
                          where not exists (select 1 from grants.call_team_member m
                                             where m.team_id = t.id and m.facet_id = a.id))
   where t.id = v_team;

  update grants.call_team t
     set indoklas = format('%s arculatból %s lefedve, %s kar, %s újonnan bevont kolléga, átlagos illeszkedés %s pont.',
                           t.arculat_db, t.lefedett, t.kar_db, t.ujonnan_db, coalesce(t.atlag_ossz, 0))
   where t.id = v_team;

  return v_team;
end $$;


-- ------------------------------------------------------------
-- Irodai felület
-- ------------------------------------------------------------
create or replace function public.grants_teams(p_call uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_office();
  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', t.id, 'valtozat', t.valtozat, 'nev', t.nev, 'indoklas', t.indoklas,
                   'meret', t.meret, 'lefedett', t.lefedett, 'arculat_db', t.arculat_db,
                   'atlag_ossz', t.atlag_ossz, 'ujonnan_db', t.ujonnan_db, 'kar_db', t.kar_db,
                   'ures_arculat', t.ures_arculat,
                   'tagok', coalesce((
                      select jsonb_agg(jsonb_build_object(
                               'researcher_id', m.researcher_id, 'nev', r.nev, 'kar', r.kar,
                               'intezet', r.intezet, 'szerep', m.szerep, 'ossz', m.ossz,
                               'bevonas', m.bevonas, 'ujonnan', m.ujonnan,
                               'arculat', f.nev,
                               'felkerve', exists (select 1 from grants.invite i
                                                    where i.call_id = t.call_id
                                                      and i.researcher_id = m.researcher_id))
                               order by (m.szerep = 'vezeto') desc, m.ossz desc)
                        from grants.call_team_member m
                        join grants.researcher r on r.id = m.researcher_id
                        left join grants.call_facet f on f.id = m.facet_id
                       where m.team_id = t.id), '[]'::jsonb))
                   order by t.valtozat), '[]'::jsonb)
            from grants.call_team t where t.call_id = p_call);
end $$;

-- 2–3 változat egy hívásban. Az iroda összehasonlít, nem elfogad.
create or replace function public.grants_team_suggest(p_call uuid, p_csak_nyitott boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_karok integer; v_id uuid;
begin
  perform grants.require_office();
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

  return public.grants_teams(p_call);
end $$;

create or replace function public.grants_team_delete(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
begin
  perform grants.require_office();
  delete from grants.call_team where id = p_id;
  return jsonb_build_object('torolve', found);
end $$;

-- A javaslatból felkérés. A rendszer SENKIT nem kér fel automatikusan: a
-- sorok 'javasolt' állapotban nyílnak, a kiküldés az iroda döntése.
create or replace function public.grants_team_invite(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_call uuid; v_items jsonb;
begin
  perform grants.require_office();
  select call_id into v_call from grants.call_team where id = p_id;
  if v_call is null then raise exception 'GRANTS_HIBA: nincs ilyen csapatjavaslat.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'researcher_id', m.researcher_id, 'szerep', m.szerep,
           'arculat', f.nev, 'team_id', p_id)), '[]'::jsonb)
    into v_items
    from grants.call_team_member m
    left join grants.call_facet f on f.id = m.facet_id
   where m.team_id = p_id;

  return public.grants_invite_bulk(v_call, v_items);
end $$;


-- ------------------------------------------------------------
-- Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  f text;
begin
  foreach f in array array[
    'grants.vezeto_alkalmas(uuid)', 'grants.team_build(uuid,text,boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  foreach f in array array[
    'public.grants_teams(uuid)',
    'public.grants_team_suggest(uuid,boolean)',
    'public.grants_team_delete(uuid)',
    'public.grants_team_invite(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.grants_team_suggest(uuid,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a csapatajanlot.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'grants.team_build(uuid,text,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: a belso csapatepito kozvetlenul hivhato.';
  end if;
  raise notice 'Rendben: 90 — csapatajanlas lefedessel, 2-3 valtozat, fenntartott hely.';
end $chk$;
