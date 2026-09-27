-- ============================================================
-- 101_grants_details_mind.sql — a részletek a lejárt felhívásokra is
-- ============================================================
-- MI TÖRTÉNT: a részletek letöltése 634 felhívásra lefutott, hibátlanul, és a
-- sor kiürült — a felületen mégis „Még nem töltöttük le a kiíró oldaláról"
-- állt, gyakorlatilag minden megnyitott felhívásnál.
--
-- AZ OK, MÉRVE: a 99-es sor csak azt adta vissza, aminek a következő
-- határideje a JÖVŐBEN van (`kovetkezo_hatarido >= now()`). A felhívás-lista
-- viszont a legközelebbi határidő szerint rendez — tehát elöl épp azok állnak,
-- amelyeknek a határideje az imént járt le. Ezek kimaradtak a letöltésből, és
-- pont ezeket nyitja meg először a felhasználó. A sor „kiürült" jelzése igaz
-- volt, csak a sor nem arra a halmazra vonatkozott, amit a felület mutat.
--
-- A JAVÍTÁS: a részleteket MINDEN nem archivált EU-felhívásra lekérjük, a
-- határidőtől függetlenül. Ez amúgy is helyesebb: a lejárt kiírás szövege a
-- következő évi pályázat előkészítéséhez a legértékesebb olvasmány, és az
-- értékelési küszöbök sem évülnek el egy nap alatt.
--
-- A frissítési rend nem változik: amit egyszer lehoztunk, azt 30 napig nem
-- kérdezzük újra.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

create or replace function public.grants_call_details_queue(p_limit integer default 20, p_napok integer default 30)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim,
                                    'azonosito', coalesce(c.payload->>'identifier', c.kulso_azonosito),
                                    'hatarido', c.kovetkezo_hatarido) as sor
            from grants.call c
           where c.archivalt = false
             and c.source_kod = 'eu_portal'
             -- HATÁRIDŐ-FÜGGETLEN: a lejárt kiírás szövege a jövő évi
             -- pályázat előkészítéséhez a legfontosabb forrás, és a
             -- felhívás-lista is mutatja őket.
             and coalesce(c.payload->>'identifier', c.kulso_azonosito) is not null
             and (c.reszletek_frissitve is null
                  or c.reszletek_frissitve < now() - (greatest(coalesce(p_napok, 30), 1) * interval '1 day'))
           -- A közelgő határidő megy elöl, a lejártak a sor végén.
           order by (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido < now()),
                    c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 20), 1), 100)) t
$$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text := 'public.grants_call_details_queue(integer,integer)';
begin
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_call_details_queue(integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is olvashatja az ETL-sort.';
  end if;
  raise notice 'Rendben: 101 — a reszletek a lejart felhivasokra is lejonnek.';
end $chk$;
