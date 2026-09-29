-- ============================================================================
-- RUN_ALL_88_90.sql — bevonási méltányosság, szemantikus illesztés, csapatajánló
-- ============================================================================
-- EZ A JÓVÁHAGYOTT TERV ELSŐ FELE: az adatbázis-réteg. Három migráció, ebben a
-- sorrendben, egyetlen szkriptben. Mindegyik önállóan is értelmes, de a 90-nek
-- kell a 89, a 89-nek pedig a 88 (a bevonási pontszám onnan jön).
--
--   88 — FELKÉRÉSI NAPLÓ ÉS BEVONÁSI MÉLTÁNYOSSÁG
--        grants.invite + grants.invite_event: ki, melyik felhívásra, milyen
--        arculatra, ki kérte fel, mikor, mi a válasz. Minden állapotváltás
--        naplózva. A bevonási pontszám a kevesebbet szerepelt kollégát hozza
--        előre, és aki még soha nem volt pályázatban, a maximumot kapja.
--        Dashboard: felhívás / kolléga / kar szerinti nézet, négy fejszám, és a
--        „még soha nem kértük fel" lista.
--
--   89 — SZEMANTIKUS ILLESZTÉS
--        A művek absztraktja, társszerzői és pályázati előzménye; kutatónként
--        legfeljebb 3 témakör-vektor (nem átlagvektor); a felhívás arculatai;
--        és a KOMPONENSEKRE bontott pontszám (tartalom, frissesség, súlypont,
--        tekintély, kapacitás, nyitottság, bevonás).
--        Amíg nincs beágyazás, a tartalmi pontszám token-átfedésből jön — így a
--        modul AZONNAL működik, és a beágyazás megjelenésével magától pontosabb
--        lesz. Minden találat megmondja, melyik úton keletkezett.
--
--   90 — CSAPATAJÁNLÁS
--        A csapat lefedéssel áll össze, nem rangsorból: mindig arra az
--        arculatra keresünk embert, amelyik a legközelebb áll az üresen
--        maradáshoz. Minden javaslatban egy hely fenntartva az újonnan
--        bevonható kollégának, és a zörejen belüli döntetlennél a kevesebbet
--        szerepelt nyer. A kimenet 2–3 VÁLTOZAT, plusz a lefedetlen arculatok
--        listája — ez mondja meg, mire kell külső partnert keresni.
--
-- AMI SZÁNDÉKOSAN NINCS BENNE: kollégák egymáshoz mért rangsora, egyéni
-- sikerarány-mutató. A napló nem teljesítményértékelés.
--
-- BIZTONSÁG: a szokásos rend — az ETL-függvényeket (beágyazás, klaszter,
-- arculat, absztrakt) KIZÁRÓLAG a service_role hívhatja, a bejelentkezett
-- felhasználó nem. A szkript ezt a végén ellenőrzi is.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 88 — felkeresi naplo, bevonasi pontszam, bevonasi dashboard.
--   NOTICE: 89 — szoveges profil: <szám> kutato, tarsszerzosegi el: <szám>
--   NOTICE: Rendben: 89 — szemantikus reteg, arculatok, komponenses illesztes.
--   NOTICE: Rendben: 90 — csapatajanlas lefedessel, 2-3 valtozat, fenntartott hely.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart. (a 21 újrafutásából)
--
-- Ha bármelyik NOTICE helyett EXCEPTION jön, a Supabase SQL Editor az EGÉSZ
-- szkriptet visszapörgeti — semmi nem marad félig kész.
-- ============================================================================



-- ####################################################################
-- ### 88_grants_invite.sql
-- ####################################################################

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


-- ####################################################################
-- ### 89_grants_semantic.sql
-- ####################################################################

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


-- ####################################################################
-- ### 90_grants_teams.sql
-- ####################################################################

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
