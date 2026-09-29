-- ============================================================
-- 104_grants_lejart_szuro.sql — a lejárt kiírás alapból ne zavarjon
-- ============================================================
-- MIÉRT: a „nyitott" állapot a KIÍRÓ saját jelzése, és a legutóbbi betöltés óta
-- lejárhatott a határidő. Ezért a lista élén — ami a legközelebbi határidő
-- szerint rendez — épp a tegnap lejárt kiírások álltak. A 103-as javítás után
-- ezek már helyesen „3 napja lejárt"-ként jelennek meg, de továbbra is ők
-- foglalják az első helyeket, pedig már nem lehet rájuk pályázni.
--
-- A JAVÍTÁS: a lista alapból elhagyja a lejárt határidejűeket, és egy
-- kapcsolóval előhozhatók. A NULL határidejű (még nem nyitott, tervezett)
-- kiírás MARAD — az nem lejárt, csak még nincs dátuma.
--
-- A régi, hétparaméteres alakot el KELL dobni: két azonos nevű függvény mellett
-- a nevesített hívás nem egyértelmű, és a PostgREST hibával áll le (ugyanaz a
-- csapda, mint a 82-esben és a 102-esben). A szkript ezt ellenőrzi is.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function public.grants_calls(
  p_q        text    default null,
  p_allapot  text    default null,
  p_program  text    default null,
  p_source   text    default null,
  p_napon_belul integer default null,
  p_limit    integer default 100,
  p_offset   integer default 0,
  -- Lejárt kiírás csak kérésre (104).
  p_lejart   boolean default false
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_lim  integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off  integer := greatest(coalesce(p_offset, 0), 0);
  v_q    text    := nullif(btrim(coalesce(p_q, '')), '');
  v_ossz integer;
  v_sorok jsonb;
begin
  perform grants.require_office();

  -- A szűrés EGY lekérdezésben, temp tábla nélkül: ez a függvény stable, és
  -- egy stable függvényben a DDL nemcsak illetlen, hanem meg is buktathatja
  -- a hívást read-only tranzakcióban.
  select count(*) into v_ossz
    from grants.call c
   where c.archivalt = false
     -- A „nyitott" állapot a KIÍRÓ jelzése; a határidő azóta lejárhatott.
     -- Alapból elhagyjuk őket, mert a lista a legközelebbi határidő szerint
     -- rendez, és különben épp a lejártak állnának elöl. A NULL határidejű
     -- (tervezett) kiírás MARAD: az nem lejárt, csak még nincs dátuma.
     and (p_lejart is true or c.kovetkezo_hatarido is null
          or c.kovetkezo_hatarido::date >= current_date)
     and (p_allapot is null or c.allapot = p_allapot)
     and (p_program is null or c.program = p_program)
     and (p_source  is null or c.source_kod = p_source)
     and (p_napon_belul is null
          or (c.kovetkezo_hatarido is not null
              and c.kovetkezo_hatarido < now() + (p_napon_belul * interval '1 day')))
     and (v_q is null
          or c.cim ilike '%' || v_q || '%'
          or coalesce(c.cim_en, '') ilike '%' || v_q || '%'
          or coalesce(c.kivonat, '') ilike '%' || v_q || '%'
          or c.kulso_azonosito ilike '%' || v_q || '%');

  select coalesce(jsonb_agg(x order by rendez, hat, cim), '[]'::jsonb) into v_sorok
  from (
    select jsonb_build_object(
             'id', c.id, 'azonosito', c.kulso_azonosito, 'cim', c.cim, 'cim_en', c.cim_en,
             'program', c.program, 'alprogram', c.alprogram, 'tipus', c.tipus,
             'felhivas_azonosito', c.felhivas_azonosito,
             'allapot', c.allapot, 'nyitas', c.nyitas,
             'hatarido', c.kovetkezo_hatarido, 'utolso_hatarido', c.utolso_hatarido,
             -- Nap-különbség DÁTUMBÓL: az interval nem konvertálható egészre.
             'hatralevo_nap', case when c.kovetkezo_hatarido is null then null
                                   else (c.kovetkezo_hatarido::date - current_date) end,
             'keret_eur', c.keret_eur, 'keret_huf', c.keret_huf,
             'orszagkor', c.orszagkor, 'kedvezmenyezett', c.kedvezmenyezett,
             'kivonat', left(coalesce(c.kivonat, ''), 400),
             'url', c.url, 'partnerkereses', c.partnerkereses,
             'forras', c.source_kod, 'forras_nev', s.nev,
             'hataridok', (select coalesce(jsonb_agg(d.hatarido order by d.sorszam), '[]'::jsonb)
                             from grants.call_deadline d where d.call_id = c.id),
             'valtozott', (select max(ch.mikor) from grants.call_change ch where ch.call_id = c.id),
             'first_seen', c.first_seen, 'last_seen', c.last_seen
           ) as x,
           -- Nyitott elöl, azon belül a legközelebbi határidő.
           case c.allapot when 'nyitott' then 0 when 'hamarosan' then 1 else 2 end as rendez,
           coalesce(c.kovetkezo_hatarido, 'infinity'::timestamptz) as hat,
           c.cim as cim
      from grants.call c
      join grants.source s on s.kod = c.source_kod
     where c.archivalt = false
     -- A „nyitott" állapot a KIÍRÓ jelzése; a határidő azóta lejárhatott.
     -- Alapból elhagyjuk őket, mert a lista a legközelebbi határidő szerint
     -- rendez, és különben épp a lejártak állnának elöl. A NULL határidejű
     -- (tervezett) kiírás MARAD: az nem lejárt, csak még nincs dátuma.
     and (p_lejart is true or c.kovetkezo_hatarido is null
          or c.kovetkezo_hatarido::date >= current_date)
       and (p_allapot is null or c.allapot = p_allapot)
       and (p_program is null or c.program = p_program)
       and (p_source  is null or c.source_kod = p_source)
       and (p_napon_belul is null
            or (c.kovetkezo_hatarido is not null
                and c.kovetkezo_hatarido < now() + (p_napon_belul * interval '1 day')))
       and (v_q is null
            or c.cim ilike '%' || v_q || '%'
            or coalesce(c.cim_en, '') ilike '%' || v_q || '%'
            or coalesce(c.kivonat, '') ilike '%' || v_q || '%'
            or c.kulso_azonosito ilike '%' || v_q || '%')
     order by rendez, hat, c.cim
     limit v_lim offset v_off
  ) t;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_sorok),
                            'hatar', v_lim, 'eltolas', v_off, 'sorok', v_sorok);
end $$;



-- A régi alak eltávolítása: különben a nevesített hívás kétértelmű.
do $regi$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'grants_calls' and p.pronargs = 7) then
    execute 'drop function public.grants_calls(text,text,text,text,integer,integer,integer)';
    raise notice '104 — a regi, 7 parameteres grants_calls eltavolitva.';
  end if;
end $regi$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  f text := 'public.grants_calls(text,text,text,text,integer,integer,integer,boolean)';
begin
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'grants_calls' and p.pronargs = 7) then
    raise exception 'HIBA: a regi, 7 parameteres grants_calls bent maradt — a hivas ketertelmu lenne.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon',
         'public.grants_calls(text,text,text,text,integer,integer,integer,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon lekerdezheti a felhivas-listat.';
  end if;
  raise notice 'Rendben: 104 — a lejart kiirasok alapbol kimaradnak a listabol.';
end $chk$;
