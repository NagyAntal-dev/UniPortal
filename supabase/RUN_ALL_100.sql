-- ============================================================================
-- RUN_ALL_100.sql — a pontozás hangolása az iroda kezébe
-- ============================================================================
-- MIÉRT: a súlyok eddig migrációval voltak állíthatók, tehát minden
-- finomhangoláshoz fejlesztő kellett. Rossz munkamegosztás: hogy a tekintély
-- vagy a méltányosság mennyit nyomjon a latban, az IRODAI döntés.
--
-- MIT AD: a Pályázatfigyelő → Beállítások képernyőn egy „Pontozás és
-- csapatösszeállítás" panel 18 hangolható értékkel, négy csoportban (súlyok,
-- küszöbök, csapat, bevonás). Fölötte két szám élőben:
--     „egy szórásnyi témakülönbség hány pontot mozdít"
--     „a bevonás teljes kilengése hány pontot mozdít"
-- Ha a második nagyobb, a felület KIÍRJA, hogy a méltányosság elnyomja a
-- szakmai illeszkedést — pontosan az a hiba, ami az első éles listát elrontotta.
--
-- Mentéskor választható, hogy a meglévő találatok újraszámoljanak: ilyenkor a
-- találatokat NEM töröljük (a képernyő ne ürüljön ki), csak megjelöljük az
-- időpontot, és a gépi kör minden felhívást újraszámol.
--
-- ÉRVÉNYESÍTÉS (mind a három mérve): nem hangolható kulcs elutasítva, a
-- tartományon kívüli érték elutasítva, a nulla összsúly elutasítva.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: Rendben: 100 — a pontozas sulyai a feluletrol hangolhatok.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
-- ============================================================================



-- ####################################################################
-- ### 100_grants_pontozas_ui.sql
-- ####################################################################

-- ============================================================
-- 100_grants_pontozas_ui.sql — a pontozás súlyai az iroda kezébe
-- ============================================================
-- MIÉRT: a súlyok eddig migrációval voltak hangolhatók, tehát minden
-- finomhangoláshoz fejlesztő kellett. Ez rossz munkamegosztás: hogy a
-- tekintély vagy a méltányosság mennyit nyomjon a latban, az IRODAI döntés,
-- nem fejlesztői. A hangolás így ott is történjen, ahol a következményét látják.
--
-- MIT AD:
--   grants_scoring_get()  — a hangolható értékek, csoportosítva, alapértékkel,
--                           tartománnyal és magyarázattal;
--   grants_scoring_save() — mentés érvényesítéssel (csak szám, csak a
--                           felsorolt kulcsok, csak értelmes tartományban),
--                           és opcionálisan az összes találat érvénytelenítése;
--   a találat-sor kiegészítése: ha a súlyok változtak, minden felhívás
--   újraszámolásra kerül a következő gépi körben — e nélkül a régi pontszámok
--   maradnának a képernyőn, és az iroda azt hinné, nem történt semmi.
--
-- AMIT NEM ENGEDÜNK: nulla összsúlyt (nullával osztanánk), negatív súlyt, és
-- olyan kulcsot, ami nem a pontozáshoz tartozik.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

insert into grants.setting (key, value, description) values
  ('pont_valtozott', '', 'Mikor módosultak utoljára a pontozás súlyai. Ennél régebbi találat újraszámolásra vár.')
on conflict (key) do nothing;

-- A hangolható értékek egy helyen. Ez a lista a SZERZŐDÉS a felülettel: ami
-- itt nincs benne, azt a felületről nem lehet átírni.
create or replace function grants.pontozas_kulcsok()
returns table (kulcs text, csoport text, cimke text, alap numeric, minimum numeric, maximum numeric, tizedes boolean)
language sql immutable
as $$
  values
    ('pont_suly_tartalom',    'suly',   'Tartalmi illeszkedés',        50, 0, 100, false),
    ('pont_suly_frissesseg',  'suly',   'Frissesség',                  12, 0, 100, false),
    ('pont_suly_sulypont',    'suly',   'Súlypont (mennyire központi)', 8, 0, 100, false),
    ('pont_suly_tekintely',   'suly',   'Tekintély',                    8, 0, 100, false),
    ('pont_suly_kapacitas',   'suly',   'Kapacitás',                    6, 0, 100, false),
    ('pont_suly_nyitottsag',  'suly',   'Nyílt hozzáférés',             3, 0, 100, false),
    ('pont_suly_bevonas',     'suly',   'Bevonási méltányosság',        6, 0, 100, false),
    ('match_min_z',           'kuszob', 'Listára kerülés küszöbe (szórásban)', 0.5, -2, 3, true),
    ('match_kiemelkedo_z',    'kuszob', 'Lefedettnek számít (szórásban)',      1.0, 0, 4, true),
    ('match_min_nyers',       'kuszob', 'Nyers hasonlósági padló',             20, 0, 100, false),
    ('match_rerank_db',       'kuszob', 'Rövid lista mérete arculatonként',    40, 5, 200, false),
    ('csapat_min_meret',      'csapat', 'Legkisebb csapatméret',                3, 2, 10, false),
    ('csapat_max_meret',      'csapat', 'Legnagyobb csapatméret',               6, 2, 12, false),
    ('csapat_tie_zorej',      'csapat', 'Döntetlen-sáv (pont)',                 3, 0, 20, true),
    ('csapat_kapacitas_min',  'csapat', 'Kapacitás alsó határa',               20, 0, 100, false),
    ('bevonas_alap_pont',     'bevonas','Kiindulás annál, aki már pályázott',  88, 0, 100, false),
    ('bevonas_teher_pont',    'bevonas','Levonás idei felkérésenként',         22, 0, 100, false),
    ('bevonas_min_pont',      'bevonas','A bevonási pontszám alsó korlátja',    8, 0, 100, false)
$$;

create or replace function public.grants_scoring_get()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, pg_temp
as $$
declare v_tart numeric; v_bev numeric; v_ossz numeric;
begin
  perform grants.require_office();
  v_tart := grants.szam_beall('pont_suly_tartalom', 50);
  v_bev  := grants.szam_beall('pont_suly_bevonas', 6);
  select sum(grants.szam_beall(k.kulcs, k.alap)) into v_ossz
    from grants.pontozas_kulcsok() k where k.csoport = 'suly';

  return jsonb_build_object(
    'ertekek', (select coalesce(jsonb_agg(jsonb_build_object(
                  'kulcs', k.kulcs, 'csoport', k.csoport, 'cimke', k.cimke,
                  'ertek', grants.szam_beall(k.kulcs, k.alap),
                  'alap', k.alap, 'min', k.minimum, 'max', k.maximum, 'tizedes', k.tizedes,
                  'leiras', (select s.description from grants.setting s where s.key = k.kulcs))
                  order by k.csoport, k.cimke), '[]'::jsonb)
                from grants.pontozas_kulcsok() k),
    'suly_ossz', v_ossz,
    -- A két szám, amiből eldönthető, hogy a téma dönt-e: egy szórásnyi
    -- témakülönbség hány pontot mozdít az összpontszámon, és mennyit a
    -- bevonás teljes kilengése. Ha a második nagyobb, a méltányosság elnyomja
    -- a szakmai illeszkedést.
    'egy_szoras_pont', case when coalesce(v_ossz,0) > 0 then round(12.5 * v_tart / v_ossz, 1) else 0 end,
    'bevonas_kilenges', case when coalesce(v_ossz,0) > 0 then round(92 * v_bev / v_ossz, 1) else 0 end,
    'valtozott', (select nullif(s.value, '') from grants.setting s where s.key = 'pont_valtozott'),
    'talalat_db', (select count(*) from grants.call_match),
    'felhivas_db', (select count(distinct call_id) from grants.call_match));
end $$;

create or replace function public.grants_scoring_save(p_ertekek jsonb, p_ujraszamol boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, pg_temp
as $$
declare it jsonb; k record; v numeric; v_db integer := 0; v_ossz numeric := 0;
begin
  perform grants.require_office();
  if jsonb_typeof(p_ertekek) <> 'object' then
    raise exception 'GRANTS_HIBA: az értékeket kulcs-érték párokban kell átadni.';
  end if;

  for it in select jsonb_build_object('k', kv.key, 'v', kv.value)
              from jsonb_each_text(p_ertekek) kv loop
    select * into k from grants.pontozas_kulcsok() x where x.kulcs = it->>'k';
    if k.kulcs is null then
      raise exception 'GRANTS_HIBA: ez a beállítás nem hangolható a felületről: %', it->>'k';
    end if;
    begin
      v := btrim(it->>'v')::numeric;
    exception when others then
      raise exception 'GRANTS_HIBA: a(z) "%" értéke nem szám: %', k.cimke, it->>'v';
    end;
    if v < k.minimum or v > k.maximum then
      raise exception 'GRANTS_HIBA: a(z) "%" értéke % és % között lehet (kapott: %).',
        k.cimke, k.minimum, k.maximum, v;
    end if;
    update grants.setting
       set value = trim(trailing '.' from to_char(v, 'FM999990.999')),
           updated_at = now(), updated_by = auth.uid()
     where key = k.kulcs;
    v_db := v_db + 1;
  end loop;

  -- Nulla összsúllyal nullával osztanánk a pontszám képletében.
  select sum(grants.szam_beall(x.kulcs, x.alap)) into v_ossz
    from grants.pontozas_kulcsok() x where x.csoport = 'suly';
  if coalesce(v_ossz, 0) <= 0 then
    raise exception 'GRANTS_HIBA: a súlyok összege nem lehet nulla — legalább egy komponensnek súlyt kell kapnia.';
  end if;

  if coalesce(p_ujraszamol, false) then
    -- A meglévő találatok a RÉGI súlyokkal készültek. Nem töröljük őket (a
    -- képernyő ne ürüljön ki), hanem megjelöljük az időpontot: a sor ettől
    -- kezdve minden felhívást újraszámolásra ad a gépi körnek.
    update grants.setting set value = to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
           updated_at = now(), updated_by = auth.uid()
     where key = 'pont_valtozott';
  end if;

  return jsonb_build_object('mentve', v_db, 'suly_ossz', v_ossz,
                            'ujraszamolas', coalesce(p_ujraszamol, false));
end $$;

-- A sor vegye figyelembe, hogy a súlyok változtak.
create or replace function public.grants_match_queue(p_limit integer default 10)
returns jsonb
language sql stable security definer
set search_path = grants, public, pg_temp
as $$
  select coalesce(jsonb_agg(t.sor order by t.hatarido nulls last), '[]'::jsonb)
    from (select c.kovetkezo_hatarido as hatarido,
                 jsonb_build_object('call_id', c.id, 'cim', c.cim,
                                    'arculat_db', (select count(*) from grants.call_facet f
                                                    where f.call_id = c.id),
                                    'hatarido', c.kovetkezo_hatarido) as sor
            from grants.call c
           where c.archivalt = false
             and (c.kovetkezo_hatarido is null or c.kovetkezo_hatarido >= now())
             and exists (select 1 from grants.call_facet f where f.call_id = c.id)
             and (not exists (select 1 from grants.call_match m where m.call_id = c.id)
                  -- az arculatok frissebbek, mint a találat
                  or (select max(f.created_at) from grants.call_facet f where f.call_id = c.id)
                     > (select max(m.mikor) from grants.call_match m where m.call_id = c.id)
                  -- VAGY a súlyokat azóta állították át
                  or (select max(m.mikor) from grants.call_match m where m.call_id = c.id)
                     < coalesce((select nullif(s.value, '')::timestamptz
                                   from grants.setting s where s.key = 'pont_valtozott'),
                                '-infinity'::timestamptz))
           order by c.kovetkezo_hatarido nulls last
           limit least(greatest(coalesce(p_limit, 10), 1), 50)) t
$$;

do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  f text;
begin
  f := 'grants.pontozas_kulcsok()';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;

  foreach f in array array['public.grants_scoring_get()', 'public.grants_scoring_save(jsonb,boolean)'] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;

  f := 'public.grants_match_queue(integer)';
  execute format('revoke all on function %s from public', f);
  if has_anon then execute format('revoke all on function %s from anon', f); end if;
  if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.grants_scoring_save(jsonb,boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon atirhatja a pontozas sulyait.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_match_queue(integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is olvashatja az ETL-sort.';
  end if;
  raise notice 'Rendben: 100 — a pontozas sulyai a feluletrol hangolhatok.';
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
