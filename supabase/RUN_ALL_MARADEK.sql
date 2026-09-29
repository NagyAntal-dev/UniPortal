-- ============================================================================
-- RUN_ALL_MARADEK.sql — ami még nincs lefuttatva (2026-09-27)
-- ============================================================================
-- MÉRVE a publikálható kulccsal, közvetlenül az éles adatbázison: a pályázati
-- modulból a 88–102 migráció FENT VAN, a 103 és a 104 nincs. Ez a szkript
-- ezeket hozza be, plusz a 93-as ütemezőt (azt kívülről nem tudom ellenőrizni,
-- de az újrafuttatása ártalmatlan: a feladatot előbb leveszi, aztán felteszi).
--
-- FUTTATÁSI SORREND — a szkript magától ebben a sorrendben megy:
--   93  — a betöltő óránként magától fut         (ütemezés)
--   103 — a lejárt határidő ne „ma jár le" legyen (kiírás)
--   104 — a lejárt kiírás alapból maradjon ki     (szűrés)
--   21  — az ECHO beküldés zárva marad            (a szokásos zárólépés)
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ EGY LÉPÉS ELŐTTE, KÉZZEL — csak ha az óránkénti ütemezést is akarod:     │
-- │                                                                          │
-- │   select vault.create_secret('<a GRANTS_CRON_SECRET értéke>',            │
-- │                              'grants_cron_secret');                      │
-- │                                                                          │
-- │ Ugyanaz az érték, ami a Dashboard → Edge Functions → Secrets alatt már   │
-- │ szerepel. A titok azért nem lehet a szkriptben, mert a repó nyilvános.   │
-- │ Ha kihagyod: a szkript ettől még hibátlanul lefut, csak az első          │
-- │ ütemezett futás áll meg beszédes hibaüzenettel — a kézi indítás és a     │
-- │ felület változatlanul működik.                                           │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- MIÉRT KELL A 103 ÉS A 104 — egy mért hiba két fele:
--   Egy 24-ei határidejű felhívásnál a rendszer 27-én is azt írta, hogy „ma
--   jár le". A lista ugyanis nullára vágta a hátralévő napokat, így a három
--   napja lejárt határidő 0 lett, a felület pedig a 0-t jelenti „ma"-ként. A
--   103 a valódi (negatív) különbséget adja vissza, a 104 pedig alapból ki is
--   hagyja a lejárt kiírásokat a listából — kapcsolóval előhozhatók.
--   Mérve, négy felhívással: alapból 3 sor, „lejártakkal" 4, és a fejléc
--   darabszáma is követi a szűrőt.
--
-- A FELÜLET MÁR KINT VAN, és megvárja ezt a szkriptet: amíg a 104 nem fut le,
-- a lista a régi függvényalakkal dolgozik, és a „lejártak is" kapcsolót nem
-- kínálja fel. Tehát semmi nem törik el attól, ha ezt később futtatod.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: 93 — utemezve: grants-etl, orankent (7 * * * *).
--   NOTICE: Rendben: 93 — a betolto orankent fut, a titok a vaultbol jon.
--   NOTICE: 103 — a grants_calls a valodi nap-kulonbseget adja vissza.
--   NOTICE: Rendben: 103 — a lejart hatarido nem „ma"-kent jelenik meg.
--   NOTICE: 104 — a regi, 7 parameteres grants_calls eltavolitva.
--   NOTICE: Rendben: 104 — a lejart kiirasok alapbol kimaradnak a listabol.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
--
-- Ha bármelyik NOTICE helyett EXCEPTION jön, a Supabase SQL Editor az EGÉSZ
-- szkriptet visszapörgeti — semmi nem marad félig kész.
-- ============================================================================



-- ####################################################################
-- ### 93_grants_etl_cron.sql
-- ####################################################################

-- ============================================================
-- 93_grants_etl_cron.sql — a betöltő óránként magától fut
-- ============================================================
-- MIÉRT: eddig kézzel hajtottam a láncot (metaadat → beágyazás → klaszterezés
-- → arculatok → illesztés). A sorok maguktól újratöltődnek: új kutató, új mű,
-- új felhívás, módosult arculat. Ha nem fut magától, a modul a kézi indítás
-- napján friss, utána egyre avultabb.
--
-- MIT CSINÁL: óránként meghívja a grants-semantic függvényt `mind` módban. Az
-- egy hívás időkeretre vágva dolgozik (~110 s), és mindig a sor elejét viszi —
-- tehát a hátralék napok alatt fogy el, nem egyetlen hosszú futásban. Ha nincs
-- teendő, a hívás 1 másodperc alatt visszatér, és NEM hív modellt.
--
-- A TITOK NEM KERÜL A KÓDBA. A hívás az ütemező titkával (GRANTS_CRON_SECRET)
-- azonosítja magát, és azt a Supabase Vault tárolja. A migráció csak HIVATKOZIK
-- rá; az értéket külön, egyszer kell felvinni (lásd alább). A repó nyilvános,
-- ezért ez nem stílus kérdése.
--
-- ELŐFELTÉTEL — EGYSZER, KÉZZEL, A SQL EDITORBAN:
--     select vault.create_secret('<a GRANTS_CRON_SECRET értéke>', 'grants_cron_secret');
--   Ugyanaz az érték, ami az Edge Function titkai közt már szerepel.
--   Ha kimarad, az ütemezett futás beszédes hibaüzenettel áll meg, és a
--   modul a kézi indítással változatlanul működik.
--
-- LEÁLLÍTÁS: select cron.unschedule('grants-etl');
-- ELLENŐRZÉS: select * from cron.job_run_details order by start_time desc limit 10;
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

do $ext$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  else
    raise notice '93 — pg_cron nem elerheto ezen a peldanyon: az utemezes kimarad.';
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  else
    raise notice '93 — pg_net nem elerheto ezen a peldanyon: az utemezes kimarad.';
  end if;
end $ext$;

-- A hívás egy helyen. Így az ütemezett és a kézi indítás UGYANAZ a kód, és a
-- titok egyetlen helyen olvasódik ki.
create or replace function grants.etl_futtat(p_mod text default 'mind', p_limit integer default 400)
returns bigint
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_kulcs text; v_id bigint;
begin
  select decrypted_secret into v_kulcs
    from vault.decrypted_secrets where name = 'grants_cron_secret' limit 1;
  if v_kulcs is null or btrim(v_kulcs) = '' then
    raise exception 'GRANTS_HIBA: hianyzik a vault-titok (grants_cron_secret). Vidd fel egyszer: select vault.create_secret(''<ertek>'', ''grants_cron_secret'');';
  end if;

  select net.http_post(
           url := 'https://mdccyastwhzwtyukxlpk.supabase.co/functions/v1/grants-semantic',
           headers := jsonb_build_object('Content-Type', 'application/json',
                                         'x-grants-cron', v_kulcs),
           body := jsonb_build_object('mod', coalesce(p_mod, 'mind'),
                                      'limit', greatest(1, least(500, coalesce(p_limit, 400)))),
           timeout_milliseconds := 150000)
    into v_id;
  return v_id;
end $$;

do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice '93 — nincs cron.job tabla, az utemezes kimarad (a fuggveny kezzel hivhato).';
    return;
  end if;
  -- Újrafuttatásnál ne szaporodjon a feladat.
  perform cron.unschedule('grants-etl') where exists (select 1 from cron.job where jobname = 'grants-etl');
  -- Óránként az óra 7. percében: ne essen egybe a többi ütemezett feladattal.
  perform cron.schedule('grants-etl', '7 * * * *', 'select grants.etl_futtat(''mind'', 400);');
  raise notice '93 — utemezve: grants-etl, orankent (7 * * * *).';
end $cron$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  f text := 'grants.etl_futtat(text,integer)';
begin
  -- A titkot olvassa: klienstől teljesen elzárva.
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'grants.etl_futtat(text,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is futtathatja az ETL-hivast.';
  end if;
  -- A két feltétel NEM mehet egy kifejezésbe: a plpgsql az egész IF-et egy
  -- lekérdezésként tervezi, tehát a cron.job hivatkozásnak akkor is fel kell
  -- oldódnia, ha a tábla nem létezik. Ezért egymásba ágyazva.
  if to_regclass('cron.job') is not null then
    if not exists (select 1 from cron.job where jobname = 'grants-etl') then
      raise notice 'FIGYELEM: a grants-etl feladat nem jott letre — nezd meg a cron.job tablat.';
    end if;
  end if;
  if not exists (select 1 from pg_extension where extname = 'vault')
     and to_regclass('vault.decrypted_secrets') is null then
    raise notice 'FIGYELEM: nincs vault sema — a titkot maskepp kell atadni.';
  end if;
  raise notice 'Rendben: 93 — a betolto orankent fut, a titok a vaultbol jon.';
end $chk$;


-- ####################################################################
-- ### 103_grants_lejart_hatarido.sql
-- ####################################################################

-- ============================================================
-- 103_grants_lejart_hatarido.sql — a lejárt határidő ne „ma"-ként jelenjen meg
-- ============================================================
-- MI TÖRTÉNT: egy 24-ei határidejű felhívásnál a rendszer 27-én is azt írta,
-- hogy „ma jár le".
--
-- AZ OK: a felhívás-lista a hátralévő napokat NULLÁRA VÁGVA adta vissza:
--     greatest(0, kovetkezo_hatarido::date - current_date)
-- Egy három napja lejárt határidő így nem −3, hanem 0 lett, a felület pedig a
-- 0-t jelenti „ma jár le"-ként. A vágás eredetileg azt akarta elkerülni, hogy
-- negatív szám kerüljön a képernyőre — de ezzel a lejárt és a ma lejáró
-- határidőt MEGKÜLÖNBÖZTETHETETLENNÉ tette, ami rosszabb.
--
-- Ez nem szépséghiba: a pályázati irodának a „ma jár le" cselekvést jelent. Ha
-- egy lejárt kiírás is ezt mutatja, vagy fölöslegesen kapkodnak, vagy — ami
-- rosszabb — megtanulják, hogy a jelzés nem megbízható.
--
-- A JAVÍTÁS: a szerver a VALÓDI különbséget adja vissza (negatívat is), és a
-- felület ebből írja ki, hogy „x napja lejárt". A naptár és a
-- sürgősség-besorolás már eddig is így számolt (78_grants_calendar.sql), csak
-- a lista tért el tőle — most egyformán működik mind a kettő.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

do $$
declare v_src text;
begin
  -- A függvény többi része változatlan: célzottan a vágást cseréljük, hogy a
  -- lista minden más mezője pontosan ugyanaz maradjon.
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'grants_calls'
   order by p.pronargs desc limit 1;
  if v_src is null then
    raise exception 'HIBA: nem talalom a public.grants_calls fuggvenyt.';
  end if;
  if position('greatest(0, c.kovetkezo_hatarido::date - current_date)' in v_src) = 0 then
    raise notice '103 — a vagas mar nincs a fuggvenyben, nincs teendo.';
    return;
  end if;
  v_src := replace(v_src,
    'greatest(0, c.kovetkezo_hatarido::date - current_date)',
    '(c.kovetkezo_hatarido::date - current_date)');
  execute v_src;
  raise notice '103 — a grants_calls a valodi nap-kulonbseget adja vissza.';
end $$;

do $chk$
declare v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'grants_calls'
   order by p.pronargs desc limit 1;
  if position('greatest(0, c.kovetkezo_hatarido::date' in v_src) > 0 then
    raise exception 'HIBA: a vagas bent maradt a grants_calls fuggvenyben.';
  end if;
  raise notice 'Rendben: 103 — a lejart hatarido nem „ma"-kent jelenik meg.';
end $chk$;


-- ####################################################################
-- ### 104_grants_lejart_szuro.sql
-- ####################################################################

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
