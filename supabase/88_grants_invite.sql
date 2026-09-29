-- ============================================================
-- 88_grants_invite.sql — felkérési napló, bevonási méltányosság, dashboard
-- ============================================================
-- MIÉRT: a pusztán illeszkedésre optimalizáló ajánló mindig ugyanazt a tíz
-- embert hozza. A modul célfunkciója NEM „a legjobb csapat", hanem „a legjobb
-- csapat, amelyik a lehető legtöbb kollégát vonja be az év során". Ehhez két
-- dolog kell: egy napló arról, kit mikor mire kértünk fel, és egy pontszám,
-- ami a kevesebbet szerepelt kollégát előre hozza.
--
-- MIT AD:
--   grants.invite          — egy felkérés egy felhívásra (állapotgéppel)
--   grants.invite_event    — minden állapotváltás naplózva (ki, mikor)
--   grants.bevonas_pont()  — 0..100, annál magasabb, minél kevésbé terhelt
--   grants.kapacitas_pont()— 0..100, oktatási terhelés + futó pályázatok
--   dashboard RPC-k        — felhívás / kolléga / kar szerinti nézet,
--                            fejszámok, és a „még soha nem kértük fel" lista
--
-- AMIT SZÁNDÉKOSAN NEM AD: kollégák egymáshoz mért rangsora, egyéni
-- sikerarány-mutató, és bármilyen nézet, ami a naplót teljesítményértékelésként
-- olvasná. A napló azért van, hogy több embert vonjunk be.
--
-- JOGOSULTSÁG: grants_office mindent lát és léptet. grants_reports a SAJÁT
-- karát látja (a hívó saját kutatói sorának kar mezője alapján — a profiles
-- táblán nincs kar). Minden más bejelentkezett felhasználó kizárólag a saját
-- felkéréseit látja, és a sajátjára válaszolhat.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Táblák
-- ------------------------------------------------------------
create table if not exists grants.invite (
  id             uuid primary key default gen_random_uuid(),
  call_id        uuid not null references grants.call(id) on delete cascade,
  researcher_id  uuid not null references grants.researcher(id) on delete cascade,
  -- Melyik elvárásra (arculatra) kértük fel. A 89/90 migráció tölti gépileg,
  -- de kézzel is írható: az iroda tudja, mit kért.
  arculat        text,
  szerep         text not null default 'tag'
                   constraint grants_invite_szerep_ck
                   check (szerep in ('vezeto','tag','tanacsado')),
  allapot        text not null default 'javasolt'
                   constraint grants_invite_allapot_ck
                   check (allapot in ('javasolt','felkerve','elfogadta','visszalepett',
                                      'lejart','beadva','nyert','nem_nyert','visszavonva')),
  -- Meddig várjuk a választ. Ebből lesz a 'lejart' állapot — ami NEM döntés,
  -- hanem elmaradt ügyintézés, ezért külön állapot a 'visszalepett'-től.
  hatarido       date,
  -- A 90_grants_teams.sql csapatjavaslatához tartozik. Nincs idegen kulcs:
  -- így ez a migráció önállóan is futtatható.
  team_id        uuid,
  felkerte       uuid references public.profiles(id) on delete set null,
  felkerve_mikor timestamptz,
  valasz_mikor   timestamptz,
  megjegyzes     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Egy kollégát egy felhívásra egyszer kérünk fel. Az arculat ezen belül
  -- változhat (átsorolás), új sort nem nyitunk.
  constraint grants_invite_uq unique (call_id, researcher_id)
);
create index if not exists grants_invite_call_idx      on grants.invite (call_id, allapot);
create index if not exists grants_invite_researcher_idx on grants.invite (researcher_id, created_at desc);
create index if not exists grants_invite_allapot_idx    on grants.invite (allapot, hatarido);

create table if not exists grants.invite_event (
  id           bigserial primary key,
  invite_id    uuid not null references grants.invite(id) on delete cascade,
  mikor        timestamptz not null default now(),
  ki           uuid references public.profiles(id) on delete set null,
  regi_allapot text,
  uj_allapot   text not null,
  megjegyzes   text
);
create index if not exists grants_invite_event_idx on grants.invite_event (invite_id, mikor desc);

-- A hangolható értékek a beállításokban élnek, nem a kódban: az iroda állítja,
-- mennyire agresszív a rotáció.
insert into grants.setting (key, value, description) values
  ('bevonas_alap_pont',      '88', 'Bevonási pontszám kiindulása annál, aki már volt pályázatban.'),
  ('bevonas_teher_pont',     '22', 'Ennyivel csökken a bevonási pontszám minden idei aktív felkérés után.'),
  ('bevonas_min_pont',        '8', 'A bevonási pontszám alsó korlátja.'),
  ('kapacitas_kurzus_pont',   '8', 'Ennyit von le a kapacitásból egy futó félévi kurzus.'),
  ('kapacitas_projekt_pont', '18', 'Ennyit von le a kapacitásból egy futó (elfogadott vagy beadott) pályázat.'),
  ('felkeres_valasz_nap',    '14', 'Ennyi nap után jár le egy megválaszolatlan felkérés.')
on conflict (key) do nothing;


-- ------------------------------------------------------------
-- 2. Segédfüggvények
-- ------------------------------------------------------------
-- Számbeállítás olvasása úgy, hogy egy elírt érték ne döntse el a motort.
create or replace function grants.szam_beall(p_key text, p_alap numeric)
returns numeric
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v text; n numeric;
begin
  select value into v from grants.setting where key = p_key;
  if v is null or btrim(v) = '' then return p_alap; end if;
  begin
    n := btrim(v)::numeric;
  exception when others then
    return p_alap;
  end;
  return n;
end $$;

-- A hívó saját kutatói sora. Elsődlegesen a fiókkötés, másodlagosan az e-mail.
create or replace function grants.sajat_researcher()
returns uuid
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select r.id
    from grants.researcher r
   where auth.uid() is not null
     and (r.profile_id = auth.uid()
          or (r.email is not null
              and lower(btrim(r.email)) = (select lower(btrim(p.email)) from public.profiles p where p.id = auth.uid())))
   order by (r.profile_id = auth.uid()) desc, r.created_at
   limit 1
$$;

create or replace function grants.sajat_kar()
returns text
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select nullif(btrim(r.kar), '') from grants.researcher r where r.id = grants.sajat_researcher()
$$;

-- Ki nézheti a bevonási kimutatásokat: az iroda, vagy a kari vezető (a saját
-- karára). A saját felkéréseihez ez NEM kell — arra külön RPC van.
create or replace function grants.require_reports()
returns void
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'GRANTS_NOT_AUTHENTICATED'; end if;
  if grants.is_office() then return; end if;
  if grants.has_perm('grants_reports') and grants.sajat_kar() is not null then return; end if;
  raise exception 'GRANTS_FORBIDDEN: ehhez a kimutatáshoz pályázati irodai (grants_office) vagy kari (grants_reports) jogosultság kell.';
end $$;

-- Valódi felkérés = amit az iroda ki is küldött. A 'javasolt' még csak a motor
-- ötlete, a 'visszavonva' pedig visszavett — egyik sem terhelés, és egyik sem
-- számít bevonásnak.
create or replace function grants.invite_valodi(p_allapot text)
returns boolean
language sql immutable
as $$ select p_allapot is not null and p_allapot not in ('javasolt','visszavonva') $$;

create or replace function grants.invite_atmenet_ok(p_regi text, p_uj text)
returns boolean
language sql immutable
as $$
  select case p_regi
    when 'javasolt'     then p_uj in ('felkerve','visszavonva')
    when 'felkerve'     then p_uj in ('elfogadta','visszalepett','lejart','visszavonva')
    when 'elfogadta'    then p_uj in ('beadva','visszalepett','visszavonva')
    when 'lejart'       then p_uj in ('felkerve','visszavonva')
    when 'visszalepett' then p_uj in ('felkerve','visszavonva')
    when 'beadva'       then p_uj in ('nyert','nem_nyert','visszavonva')
    else false
  end
$$;

-- Bevonási statisztika egy kollégáról. Ez a napló EGYETLEN összesítése, amit a
-- motor használ — szándékosan nem tartalmaz sikerarányt.
create or replace function grants.bevonas_stat(p_researcher uuid)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select jsonb_build_object(
    'idei_teher',      count(*) filter (where i.allapot in ('felkerve','elfogadta','beadva','nyert')
                                          and extract(year from coalesce(i.felkerve_mikor, i.created_at))
                                              = extract(year from now())),
    'idei_felkeres',   count(*) filter (where grants.invite_valodi(i.allapot)
                                          and extract(year from coalesce(i.felkerve_mikor, i.created_at))
                                              = extract(year from now())),
    'osszes_felkeres', count(*) filter (where grants.invite_valodi(i.allapot)),
    'elfogadott',      count(*) filter (where i.allapot in ('elfogadta','beadva','nyert','nem_nyert')),
    'futo',            count(*) filter (where i.allapot in ('elfogadta','beadva')),
    'nyert',           count(*) filter (where i.allapot = 'nyert'),
    'javasolt',        count(*) filter (where i.allapot = 'javasolt'),
    'volt_mar',        count(*) filter (where grants.invite_valodi(i.allapot)) > 0,
    'utolso',          max(coalesce(i.felkerve_mikor, i.created_at)))
    from grants.invite i
   where i.researcher_id = p_researcher
$$;

-- Bevonási pontszám: nem a múlt érdeme, hanem a múlt TERHELÉSE számít.
-- Aki még soha nem volt pályázatban, a maximumot kapja — ez a belépő
-- szándékolt támogatása. Aki 'nem_nyert' felkérést zárt, nem visel terhet:
-- nem rajta múlt, hogy a pályázat nem valósult meg.
create or replace function grants.bevonas_pont(p_researcher uuid)
returns numeric
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare s jsonb; teher integer; osszes integer;
begin
  s := grants.bevonas_stat(p_researcher);
  teher  := coalesce((s->>'idei_teher')::integer, 0);
  osszes := coalesce((s->>'osszes_felkeres')::integer, 0);
  if osszes = 0 then return 100; end if;
  return greatest(grants.szam_beall('bevonas_min_pont', 8),
                  grants.szam_beall('bevonas_alap_pont', 88)
                  - grants.szam_beall('bevonas_teher_pont', 22) * teher);
end $$;

-- Kapacitás: van-e egyáltalán ideje. Oktatási terhelés a FUTÓ félévből, plusz
-- a már futó pályázatok. Ez belső adat: a kutató nyilvános profilján nem
-- jelenik meg, csak az irodai nézetben.
create or replace function grants.kapacitas_pont(p_researcher uuid)
returns numeric
language plpgsql stable security definer
set search_path = grants, public, echo, pg_temp
as $$
declare kurzus integer := 0; futo integer := 0;
begin
  select count(*) into kurzus
    from grants.researcher r
    join echo.course_teacher ct on ct.teacher_id = r.teacher_id
    join echo.course c          on c.id = ct.course_id
   where r.id = p_researcher
     and r.teacher_id is not null
     and c.term = (select max(term) from echo.course);

  select count(*) into futo
    from grants.invite i
   where i.researcher_id = p_researcher and i.allapot in ('elfogadta','beadva');

  return greatest(0, 100
                  - coalesce(kurzus, 0) * grants.szam_beall('kapacitas_kurzus_pont', 8)
                  - coalesce(futo, 0)   * grants.szam_beall('kapacitas_projekt_pont', 18));
end $$;


-- ------------------------------------------------------------
-- 3. Felkérések kezelése (iroda)
-- ------------------------------------------------------------
-- A rendszer SENKIT nem kér fel automatikusan: a 'javasolt' a motor ötlete,
-- minden további állapot emberi döntés.
create or replace function public.grants_invite_create(p_adat jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_id uuid; v_allapot text; v_call uuid; v_res uuid; v_nap integer;
begin
  perform grants.require_office();
  v_call := nullif(p_adat->>'call_id','')::uuid;
  v_res  := nullif(p_adat->>'researcher_id','')::uuid;
  if v_call is null or v_res is null then
    raise exception 'GRANTS_HIBA: a felhívás és a kutató azonosítója kötelező.';
  end if;
  v_allapot := coalesce(nullif(p_adat->>'allapot',''), 'javasolt');
  if v_allapot not in ('javasolt','felkerve') then
    raise exception 'GRANTS_HIBA: új felkérés csak javasolt vagy felkerve állapotban nyitható.';
  end if;
  v_nap := grants.szam_beall('felkeres_valasz_nap', 14)::integer;

  -- Ha már van sora, az iroda korábbi döntése erősebb: csak átsorolunk, az
  -- állapotot nem nyitjuk újra, és állapotesemény sem keletkezik.
  if exists (select 1 from grants.invite where call_id = v_call and researcher_id = v_res) then
    update grants.invite
       set arculat    = coalesce(nullif(btrim(coalesce(p_adat->>'arculat','')),''), arculat),
           szerep     = coalesce(nullif(p_adat->>'szerep',''), szerep),
           team_id    = coalesce(nullif(p_adat->>'team_id','')::uuid, team_id),
           megjegyzes = coalesce(nullif(btrim(coalesce(p_adat->>'megjegyzes','')),''), megjegyzes),
           updated_at = now()
     where call_id = v_call and researcher_id = v_res
    returning id, allapot into v_id, v_allapot;
    return jsonb_build_object('id', v_id, 'allapot', v_allapot, 'uj', false);
  end if;

  insert into grants.invite (call_id, researcher_id, arculat, szerep, allapot, hatarido, team_id,
                             felkerte, felkerve_mikor, megjegyzes)
  values (v_call, v_res,
          nullif(btrim(coalesce(p_adat->>'arculat','')),''),
          coalesce(nullif(p_adat->>'szerep',''), 'tag'),
          v_allapot,
          coalesce(nullif(p_adat->>'hatarido','')::date,
                   case when v_allapot = 'felkerve' then (current_date + v_nap) end),
          nullif(p_adat->>'team_id','')::uuid,
          auth.uid(),
          case when v_allapot = 'felkerve' then now() end,
          nullif(btrim(coalesce(p_adat->>'megjegyzes','')),''))
  returning id into v_id;

  insert into grants.invite_event (invite_id, ki, regi_allapot, uj_allapot, megjegyzes)
  values (v_id, auth.uid(), null, v_allapot, nullif(btrim(coalesce(p_adat->>'megjegyzes','')),''));

  return jsonb_build_object('id', v_id, 'allapot', v_allapot, 'uj', true);
end $$;

-- Kötegelt felvétel egy csapatjavaslatból. Ami már bent van, azt nem nyitja
-- újra — az iroda korábbi döntése erősebb, mint a motor javaslata.
create or replace function public.grants_invite_bulk(p_call uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_uj integer := 0; v_meglevo integer := 0; it jsonb; v_res uuid;
begin
  perform grants.require_office();
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;

  for it in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_res := nullif(it->>'researcher_id','')::uuid;
    continue when v_res is null;
    if exists (select 1 from grants.invite where call_id = p_call and researcher_id = v_res) then
      v_meglevo := v_meglevo + 1;
      continue;
    end if;
    perform public.grants_invite_create(
      jsonb_build_object('call_id', p_call, 'researcher_id', v_res,
                         'arculat', it->>'arculat', 'szerep', coalesce(it->>'szerep','tag'),
                         'team_id', it->>'team_id', 'allapot', 'javasolt'));
    v_uj := v_uj + 1;
  end loop;

  return jsonb_build_object('uj', v_uj, 'meglevo', v_meglevo);
end $$;

-- Állapotléptetés. Minden váltás naplózódik: ki léptette és mikor.
create or replace function public.grants_invite_set(p_id uuid, p_allapot text, p_megjegyzes text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_regi text; v_nap integer;
begin
  perform grants.require_office();
  select allapot into v_regi from grants.invite where id = p_id;
  if v_regi is null then raise exception 'GRANTS_HIBA: nincs ilyen felkérés.'; end if;
  if v_regi = p_allapot then return jsonb_build_object('id', p_id, 'allapot', v_regi, 'valtozott', false); end if;
  if not grants.invite_atmenet_ok(v_regi, p_allapot) then
    raise exception 'GRANTS_HIBA: a % állapotból nem lehet %-ra lépni.', v_regi, p_allapot;
  end if;
  v_nap := grants.szam_beall('felkeres_valasz_nap', 14)::integer;

  update grants.invite
     set allapot        = p_allapot,
         felkerve_mikor = case when p_allapot = 'felkerve' then now() else felkerve_mikor end,
         hatarido       = case when p_allapot = 'felkerve' then (current_date + v_nap) else hatarido end,
         valasz_mikor   = case when p_allapot in ('elfogadta','visszalepett') then now() else valasz_mikor end,
         felkerte       = case when p_allapot = 'felkerve' then auth.uid() else felkerte end,
         megjegyzes     = coalesce(nullif(btrim(coalesce(p_megjegyzes,'')),''), megjegyzes),
         updated_at     = now()
   where id = p_id;

  insert into grants.invite_event (invite_id, ki, regi_allapot, uj_allapot, megjegyzes)
  values (p_id, auth.uid(), v_regi, p_allapot, nullif(btrim(coalesce(p_megjegyzes,'')),''));

  return jsonb_build_object('id', p_id, 'allapot', p_allapot, 'valtozott', true);
end $$;

-- Átsorolás: más arculat, más szerep, más határidő — állapotváltás nélkül.
create or replace function public.grants_invite_update(p_adat jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_id uuid;
begin
  perform grants.require_office();
  v_id := nullif(p_adat->>'id','')::uuid;
  if v_id is null then raise exception 'GRANTS_HIBA: a felkérés azonosítója kötelező.'; end if;

  update grants.invite
     set arculat    = case when p_adat ? 'arculat' then nullif(btrim(coalesce(p_adat->>'arculat','')),'') else arculat end,
         szerep     = coalesce(nullif(p_adat->>'szerep',''), szerep),
         hatarido   = case when p_adat ? 'hatarido' then nullif(p_adat->>'hatarido','')::date else hatarido end,
         megjegyzes = case when p_adat ? 'megjegyzes' then nullif(btrim(coalesce(p_adat->>'megjegyzes','')),'') else megjegyzes end,
         team_id    = case when p_adat ? 'team_id' then nullif(p_adat->>'team_id','')::uuid else team_id end,
         updated_at = now()
   where id = v_id;
  if not found then raise exception 'GRANTS_HIBA: nincs ilyen felkérés.'; end if;
  return jsonb_build_object('id', v_id);
end $$;

-- A megválaszolatlan felkérések lejáratása. Nem törlés és nem visszalépés:
-- külön állapot, mert az irodának mást jelent.
create or replace function public.grants_invite_expire()
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_db integer := 0; r record;
begin
  perform grants.require_office();
  for r in select id, allapot from grants.invite
            where allapot = 'felkerve' and hatarido is not null and hatarido < current_date loop
    update grants.invite set allapot = 'lejart', updated_at = now() where id = r.id;
    insert into grants.invite_event (invite_id, ki, regi_allapot, uj_allapot, megjegyzes)
    values (r.id, auth.uid(), r.allapot, 'lejart', 'határidő lejárt');
    v_db := v_db + 1;
  end loop;
  return jsonb_build_object('lejart', v_db);
end $$;


-- ------------------------------------------------------------
-- 4. Nézetek: felhívás szerint, kolléga szerint, kar szerint
-- ------------------------------------------------------------
create or replace function public.grants_invite_list(
  p_call       uuid    default null,
  p_researcher uuid    default null,
  p_allapot    text    default null,
  p_kar        text    default null,
  p_limit      integer default 200)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_office boolean; v_kar text; v_sajat uuid; v_res jsonb;
begin
  if auth.uid() is null then raise exception 'GRANTS_NOT_AUTHENTICATED'; end if;
  v_office := grants.is_office();
  v_sajat  := grants.sajat_researcher();
  if not v_office then
    if grants.has_perm('grants_reports') then v_kar := grants.sajat_kar(); end if;
    if v_kar is null and v_sajat is null then
      raise exception 'GRANTS_FORBIDDEN: ehhez a listához pályázati irodai vagy kari jogosultság kell.';
    end if;
  end if;

  select coalesce(jsonb_agg(t.sor order by t.rend desc), '[]'::jsonb) into v_res
    from (select i.updated_at as rend,
                 jsonb_build_object(
                   'id', i.id,
                   'call_id', i.call_id,
                   'felhivas', c.cim,
                   'felhivas_hatarido', c.kovetkezo_hatarido,
                   'researcher_id', i.researcher_id,
                   'nev', r.nev,
                   'kar', r.kar,
                   'intezet', r.intezet,
                   'arculat', i.arculat,
                   'szerep', i.szerep,
                   'allapot', i.allapot,
                   'valasz_hatarido', i.hatarido,
                   'felkerve_mikor', i.felkerve_mikor,
                   'valasz_mikor', i.valasz_mikor,
                   'megjegyzes', i.megjegyzes,
                   'team_id', i.team_id,
                   'bevonas_pont', round(grants.bevonas_pont(r.id))) sor
            from grants.invite i
            join grants.researcher r on r.id = i.researcher_id
            join grants.call c       on c.id = i.call_id
           where (p_call is null or i.call_id = p_call)
             and (p_researcher is null or i.researcher_id = p_researcher)
             and (p_allapot is null or i.allapot = p_allapot)
             and (p_kar is null or r.kar = p_kar)
             and (v_office
                  or (v_kar is not null and r.kar = v_kar)
                  or (v_sajat is not null and i.researcher_id = v_sajat))
           order by i.updated_at desc
           limit least(greatest(coalesce(p_limit, 200), 1), 500)) t;

  return v_res;
end $$;

-- „Felhívás szerint": egy pályázat csapata arculatonként, minden tag
-- állapotával. Ez az a nézet, amiről az iroda látja, mi hiányzik a beadáshoz.
create or replace function public.grants_invite_call_view(p_call uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_call jsonb; v_arc jsonb; v_ossz jsonb;
begin
  perform grants.require_reports();
  if p_call is null then raise exception 'GRANTS_HIBA: a felhívás azonosítója kötelező.'; end if;

  select jsonb_build_object('id', c.id, 'cim', c.cim, 'program', c.program,
                            'hatarido', c.kovetkezo_hatarido, 'allapot', c.allapot)
    into v_call from grants.call c where c.id = p_call;
  if v_call is null then raise exception 'GRANTS_HIBA: nincs ilyen felhívás.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('arculat', a.arculat, 'tagok', a.tagok)
                            order by a.arculat nulls last), '[]'::jsonb)
    into v_arc
    from (select coalesce(i.arculat, '(nincs arculat)') as arculat,
                 jsonb_agg(jsonb_build_object(
                   'id', i.id, 'researcher_id', r.id, 'nev', r.nev, 'kar', r.kar,
                   'szerep', i.szerep, 'allapot', i.allapot,
                   'valasz_hatarido', i.hatarido,
                   'bevonas_pont', round(grants.bevonas_pont(r.id)))
                   order by i.szerep, r.nev) as tagok
            from grants.invite i
            join grants.researcher r on r.id = i.researcher_id
           where i.call_id = p_call
           group by coalesce(i.arculat, '(nincs arculat)')) a;

  select coalesce(jsonb_object_agg(x.allapot, x.db), '{}'::jsonb) into v_ossz
    from (select allapot, count(*) db from grants.invite where call_id = p_call group by allapot) x;

  return jsonb_build_object('felhivas', v_call, 'arculatok', v_arc, 'allapotok', v_ossz);
end $$;

-- A kollégáé: a saját felkérései. Ehhez nem kell irodai jogosultság — ezért nem
-- érheti váratlanul, hogy négy pályázatban szerepel.
create or replace function public.grants_my_invites()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_sajat uuid; v_res jsonb;
begin
  if auth.uid() is null then raise exception 'GRANTS_NOT_AUTHENTICATED'; end if;
  v_sajat := grants.sajat_researcher();
  if v_sajat is null then
    return jsonb_build_object('kutato', null, 'felkeresek', '[]'::jsonb, 'stat', '{}'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'call_id', i.call_id, 'felhivas', c.cim,
           'felhivas_hatarido', c.kovetkezo_hatarido, 'url', c.url,
           'arculat', i.arculat, 'szerep', i.szerep, 'allapot', i.allapot,
           'valasz_hatarido', i.hatarido, 'felkerve_mikor', i.felkerve_mikor,
           'megjegyzes', i.megjegyzes,
           'valaszolhat', i.allapot = 'felkerve')
           order by i.updated_at desc), '[]'::jsonb)
    into v_res
    from grants.invite i join grants.call c on c.id = i.call_id
   where i.researcher_id = v_sajat and i.allapot <> 'javasolt';

  return jsonb_build_object(
    'kutato', (select jsonb_build_object('id', r.id, 'nev', r.nev, 'kar', r.kar)
                 from grants.researcher r where r.id = v_sajat),
    'felkeresek', v_res,
    'stat', grants.bevonas_stat(v_sajat));
end $$;

-- A kolléga a SAJÁT felkérésére válaszol. Csak elfogadás vagy visszalépés:
-- minden más állapot az irodáé.
create or replace function public.grants_invite_respond(p_id uuid, p_valasz text, p_megjegyzes text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare v_sajat uuid; v_regi text;
begin
  if auth.uid() is null then raise exception 'GRANTS_NOT_AUTHENTICATED'; end if;
  if p_valasz not in ('elfogadta','visszalepett') then
    raise exception 'GRANTS_HIBA: a válasz csak elfogadta vagy visszalepett lehet.';
  end if;
  v_sajat := grants.sajat_researcher();
  select allapot into v_regi from grants.invite where id = p_id and researcher_id = v_sajat;
  if v_regi is null then raise exception 'GRANTS_HIBA: nincs ilyen saját felkérés.'; end if;
  if v_regi <> 'felkerve' then
    raise exception 'GRANTS_HIBA: erre a felkérésre már nem lehet válaszolni (állapot: %).', v_regi;
  end if;

  update grants.invite
     set allapot = p_valasz, valasz_mikor = now(),
         megjegyzes = coalesce(nullif(btrim(coalesce(p_megjegyzes,'')),''), megjegyzes),
         updated_at = now()
   where id = p_id;

  insert into grants.invite_event (invite_id, ki, regi_allapot, uj_allapot, megjegyzes)
  values (p_id, auth.uid(), v_regi, p_valasz, nullif(btrim(coalesce(p_megjegyzes,'')),''));

  return jsonb_build_object('id', p_id, 'allapot', p_valasz);
end $$;

create or replace function public.grants_invite_history(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_res uuid; v_sajat uuid;
begin
  if auth.uid() is null then raise exception 'GRANTS_NOT_AUTHENTICATED'; end if;
  select researcher_id into v_res from grants.invite where id = p_id;
  if v_res is null then raise exception 'GRANTS_HIBA: nincs ilyen felkérés.'; end if;
  v_sajat := grants.sajat_researcher();
  if not grants.is_office() and (v_sajat is null or v_sajat <> v_res) then
    perform grants.require_reports();
  end if;

  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'mikor', e.mikor, 'regi', e.regi_allapot, 'uj', e.uj_allapot,
                   'megjegyzes', e.megjegyzes,
                   'ki', (select p.name from public.profiles p where p.id = e.ki))
                   order by e.mikor), '[]'::jsonb)
            from grants.invite_event e where e.invite_id = p_id);
end $$;


-- ------------------------------------------------------------
-- 5. Bevonási fejszámok és a „még soha nem kértük fel" lista
-- ------------------------------------------------------------
-- Mind a négy fejszám a BEVONÁSRÓL szól, nem a teljesítményről.
create or replace function public.grants_participation_stats(p_ev integer default null)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare
  v_ev integer; v_torzs integer; v_bevont integer; v_karok integer;
  v_elso integer; v_felk integer; v_karonkent jsonb; v_allapot jsonb; v_futo integer;
begin
  perform grants.require_reports();
  v_ev := coalesce(p_ev, extract(year from now())::integer);

  select count(*) into v_torzs from grants.researcher where allapot = 'aktiv';

  select count(distinct i.researcher_id) into v_bevont
    from grants.invite i
   where grants.invite_valodi(i.allapot)
     and extract(year from coalesce(i.felkerve_mikor, i.created_at))::integer = v_ev;

  select count(distinct coalesce(nullif(btrim(r.kar), ''), '(nincs megadva)')) into v_karok
    from grants.invite i
    join grants.researcher r on r.id = i.researcher_id
   where grants.invite_valodi(i.allapot)
     and extract(year from coalesce(i.felkerve_mikor, i.created_at))::integer = v_ev;

  -- „Első pályázatuk": akinek a legelső valódi felkérése ebben az évben volt.
  select count(*) into v_elso from (
    select i.researcher_id
      from grants.invite i
     where grants.invite_valodi(i.allapot)
     group by i.researcher_id
    having min(extract(year from coalesce(i.felkerve_mikor, i.created_at))::integer) = v_ev) t;

  select count(*) into v_felk
    from grants.invite i
   where grants.invite_valodi(i.allapot)
     and extract(year from coalesce(i.felkerve_mikor, i.created_at))::integer = v_ev;

  select count(*) into v_futo from grants.invite where allapot in ('elfogadta','beadva');

  select coalesce(jsonb_agg(x.sor order by x.kar), '[]'::jsonb) into v_karonkent
    from (select t.kar,
                 jsonb_build_object('kar', t.kar, 'torzstag', count(*),
                                    'bevont', count(*) filter (where t.bevont),
                                    'arany', round(100.0 * count(*) filter (where t.bevont) / count(*))) sor
            from (select coalesce(nullif(btrim(r.kar), ''), '(nincs megadva)') kar,
                         exists (select 1 from grants.invite i
                                  where i.researcher_id = r.id
                                    and grants.invite_valodi(i.allapot)
                                    and extract(year from coalesce(i.felkerve_mikor, i.created_at))::integer = v_ev) bevont
                    from grants.researcher r where r.allapot = 'aktiv') t
           group by t.kar) x;

  select coalesce(jsonb_object_agg(y.allapot, y.db), '{}'::jsonb) into v_allapot
    from (select i.allapot, count(*) db
            from grants.invite i
           where extract(year from coalesce(i.felkerve_mikor, i.created_at))::integer = v_ev
           group by i.allapot) y;

  return jsonb_build_object(
    'ev', v_ev,
    'torzstag', v_torzs,
    'bevont', v_bevont,
    'bevont_arany', case when v_torzs > 0 then round(100.0 * v_bevont / v_torzs) else 0 end,
    'karok', v_karok,
    'elso_palyazo', v_elso,
    'felkeres_db', v_felk,
    'atlag_felkeres', case when v_bevont > 0 then round(v_felk::numeric / v_bevont, 2) else 0 end,
    'futo_reszvetel', v_futo,
    'karonkent', v_karonkent,
    'allapotok', v_allapot);
end $$;

-- Ez a modul lényege: az egyetlen lista, ami cselekvésre hív.
create or replace function public.grants_never_invited(
  p_kar      text    default null,
  p_kereses  text    default null,
  p_limit    integer default 50)
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_kar text; v_res jsonb;
begin
  perform grants.require_reports();
  -- A kari vezető a saját karát látja, akkor is, ha mást kérdez.
  if not grants.is_office() then v_kar := grants.sajat_kar(); else v_kar := nullif(btrim(coalesce(p_kar,'')),''); end if;

  select coalesce(jsonb_agg(t.sor order by t.mu_db desc, t.nev), '[]'::jsonb) into v_res
    from (select jsonb_build_object(
                   'id', r.id, 'nev', r.nev, 'kar', r.kar, 'intezet', r.intezet,
                   'tipus', r.tipus,
                   'van_azonosito', (r.openalex_id is not null or r.mtmt_id is not null or r.orcid is not null),
                   'mu_db', (select count(*) from grants.researcher_work w where w.researcher_id = r.id),
                   'utolso_ev', (select max(w.ev) from grants.researcher_work w where w.researcher_id = r.id),
                   'kapacitas_pont', round(grants.kapacitas_pont(r.id)),
                   'bevonas_pont', round(grants.bevonas_pont(r.id))) sor,
                 (select count(*) from grants.researcher_work w where w.researcher_id = r.id) mu_db,
                 r.nev
            from grants.researcher r
           where r.allapot = 'aktiv'
             and (v_kar is null or r.kar = v_kar)
             and (p_kereses is null or btrim(p_kereses) = ''
                  or r.nev ilike '%' || btrim(p_kereses) || '%'
                  or coalesce(r.intezet,'') ilike '%' || btrim(p_kereses) || '%')
             and not exists (select 1 from grants.invite i
                              where i.researcher_id = r.id and grants.invite_valodi(i.allapot))
           order by (select count(*) from grants.researcher_work w where w.researcher_id = r.id) desc, r.nev
           limit least(greatest(coalesce(p_limit, 50), 1), 300)) t;

  return v_res;
end $$;


-- ------------------------------------------------------------
-- 6. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  f text;
begin
  -- Belső segédfüggvények: a klienstől teljesen elzárva.
  foreach f in array array[
    'grants.szam_beall(text,numeric)', 'grants.sajat_researcher()', 'grants.sajat_kar()',
    'grants.require_reports()', 'grants.invite_valodi(text)', 'grants.invite_atmenet_ok(text,text)',
    'grants.bevonas_stat(uuid)', 'grants.bevonas_pont(uuid)', 'grants.kapacitas_pont(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  -- A publikus RPC-k: a jogosultságot MINDEGYIK maga ellenőrzi (iroda / kari /
  -- saját), ezért a bejelentkezett felhasználó hívhatja őket.
  foreach f in array array[
    'public.grants_invite_create(jsonb)',
    'public.grants_invite_bulk(uuid,jsonb)',
    'public.grants_invite_set(uuid,text,text)',
    'public.grants_invite_update(jsonb)',
    'public.grants_invite_expire()',
    'public.grants_invite_list(uuid,uuid,text,text,integer)',
    'public.grants_invite_call_view(uuid)',
    'public.grants_my_invites()',
    'public.grants_invite_respond(uuid,text,text)',
    'public.grants_invite_history(uuid)',
    'public.grants_participation_stats(integer)',
    'public.grants_never_invited(text,text,integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $grants$;

do $chk$
declare f text;
begin
  foreach f in array array[
    'public.grants_invite_create(jsonb)',
    'public.grants_invite_set(uuid,text,text)',
    'public.grants_invite_list(uuid,uuid,text,text,integer)',
    'public.grants_participation_stats(integer)',
    'public.grants_never_invited(text,text,integer)'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_function_privilege('anon', f, 'execute') then
      raise exception 'BIZTONSAGI HIBA: az anon hivhatja: %', f;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'grants.bevonas_pont(uuid)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: a belso bevonasi pontszam kozvetlenul hivhato.';
  end if;
  raise notice 'Rendben: 88 — felkeresi naplo, bevonasi pontszam, bevonasi dashboard.';
end $chk$;
