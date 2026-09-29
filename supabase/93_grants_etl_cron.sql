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
