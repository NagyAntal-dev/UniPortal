-- ============================================================
-- 78_grants_calendar.sql — határidő-naptár a pályázatfigyelőhöz
-- ============================================================
-- MIT AD:
--   • public.grants_deadlines(tól, ig, …) — a megadott időszak MINDEN
--     határidejét adja, felhívásonként akár többet (kétszakaszos pályázat,
--     fordulók). A katalóguslista ezt nem tudja: az felhívásonként EGY
--     sort ad a legközelebbi határidővel, ami naptárhoz nem elég.
--   • public.grants_deadline_months(tól, ig) — hónaponkénti darabszám a
--     naptár léptetéséhez (hogy látszódjon, melyik hónapban van egyáltalán
--     mit keresni).
--
-- MIÉRT SZERVEROLDALI SZŰRÉS: 2026-09-23-án 689 felhívás és ~1100 határidő
-- van a katalógusban, és ez nőni fog. A teljes lista letöltése és kliensen
-- szűrése ugyanazt a hibát ismételné, amit az EU-betöltőnél már megmértünk:
-- a nagy adathalmazt ott kell szűrni, ahol van.
--
-- JOGOSULTSÁG: ugyanaz, mint a katalógusnál — grants_office (a törzsben
-- ellenőrizve), az ETL-függvényekkel ellentétben authenticated hívhatja.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. A határidők egy időszakra
-- ------------------------------------------------------------
-- Egy sor = EGY határidő. A felhívás adatai ismétlődnek, mert a naptárban a
-- határidő a rendezőelv, nem a felhívás.
create or replace function public.grants_deadlines(
  p_tol      date    default null,
  p_ig       date    default null,
  p_allapot  text    default null,
  p_program  text    default null,
  p_forras   text    default null,
  p_limit    integer default 500
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_tol  date    := coalesce(p_tol, date_trunc('month', now())::date);
  v_ig   date    := coalesce(p_ig, (date_trunc('month', now()) + interval '1 month - 1 day')::date);
  v_lim  integer := least(greatest(coalesce(p_limit, 500), 1), 3000);
  v_out  jsonb;
  v_ossz integer;
begin
  perform grants.require_office();
  if v_ig < v_tol then
    raise exception 'GRANTS_BAD_INPUT: a záró dátum nem lehet a kezdő előtt.';
  end if;
  -- Egy ésszerű felső korlát: a naptár hónapokban lépteti magát, egy év
  -- fölötti időszakra nincs értelme mindent egyszerre lekérni.
  if v_ig - v_tol > 400 then
    raise exception 'GRANTS_BAD_INPUT: legfeljebb 400 napos időszak kérdezhető egyszerre.';
  end if;

  select count(*) into v_ossz
    from grants.call_deadline d
    join grants.call c on c.id = d.call_id
   where c.archivalt = false
     and d.hatarido::date between v_tol and v_ig
     and (p_allapot is null or c.allapot = p_allapot)
     and (p_program is null or c.program = p_program)
     and (p_forras  is null or c.source_kod = p_forras);

  select coalesce(jsonb_agg(x order by hat, cim), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'call_id',    c.id,
             'azonosito',  c.kulso_azonosito,
             'cim',        c.cim,
             'program',    c.program,
             'alprogram',  c.alprogram,
             'allapot',    c.allapot,
             'forras',     c.source_kod,
             'url',        c.url,
             'partnerkereses', c.partnerkereses,
             'sorszam',    d.sorszam,
             -- Hány határidő tartozik ehhez a felhíváshoz összesen: ebből tudja
             -- a felület kiírni, hogy ez a "2. forduló a háromból".
             'hatarido_db', (select count(*) from grants.call_deadline d2 where d2.call_id = c.id),
             'hatarido',   d.hatarido,
             'nap',        d.hatarido::date,
             'hatralevo_nap', d.hatarido::date - current_date,
             'megjegyzes', d.megjegyzes
           ) as x,
           d.hatarido as hat, c.cim as cim
      from grants.call_deadline d
      join grants.call c on c.id = d.call_id
     where c.archivalt = false
       and d.hatarido::date between v_tol and v_ig
       and (p_allapot is null or c.allapot = p_allapot)
       and (p_program is null or c.program = p_program)
       and (p_forras  is null or c.source_kod = p_forras)
     order by d.hatarido, c.cim
     limit v_lim
  ) t;

  return jsonb_build_object(
    'tol', v_tol, 'ig', v_ig, 'ossz', v_ossz,
    'mutatva', jsonb_array_length(v_out), 'hatar', v_lim,
    'sorok', v_out,
    -- Naponkénti darabszám: a naptárrács ebből színez, és nem kell hozzá a
    -- teljes sorlistát végignézni a kliensen.
    'naponta', (select coalesce(jsonb_object_agg(nap::text, db), '{}'::jsonb)
                  from (select d.hatarido::date as nap, count(*) as db
                          from grants.call_deadline d
                          join grants.call c on c.id = d.call_id
                         where c.archivalt = false
                           and d.hatarido::date between v_tol and v_ig
                           and (p_allapot is null or c.allapot = p_allapot)
                           and (p_program is null or c.program = p_program)
                           and (p_forras  is null or c.source_kod = p_forras)
                         group by 1) n));
end $$;


-- ------------------------------------------------------------
-- 2. Hónaponkénti darabszám a léptetéshez
-- ------------------------------------------------------------
create or replace function public.grants_deadline_months(
  p_tol date default null,
  p_ig  date default null
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_tol date := coalesce(p_tol, (date_trunc('month', now()) - interval '6 months')::date);
  v_ig  date := coalesce(p_ig,  (date_trunc('month', now()) + interval '18 months')::date);
begin
  perform grants.require_office();
  return (
    select coalesce(jsonb_agg(jsonb_build_object('honap', h, 'db', db) order by h), '[]'::jsonb)
      from (select to_char(date_trunc('month', d.hatarido), 'YYYY-MM') as h, count(*) as db
              from grants.call_deadline d
              join grants.call c on c.id = d.call_id
             where c.archivalt = false
               and d.hatarido::date between v_tol and v_ig
             group by 1) t);
end $$;


-- ------------------------------------------------------------
-- 3. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
begin
  foreach f in array array[
    'public.grants_deadlines(date,date,text,text,text,integer)',
    'public.grants_deadline_months(date,date)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

do $chk$
begin
  if has_function_privilege('anon', 'public.grants_deadlines(date,date,text,text,text,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a hatarido-naptarat.';
  end if;
  raise notice 'Rendben: 78 — hatarido-naptar (grants_deadlines, grants_deadline_months).';
end $chk$;
