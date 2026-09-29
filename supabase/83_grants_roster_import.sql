-- ============================================================
-- 83_grants_roster_import.sql — a validált oktatói lista betöltése a törzsbe
-- ============================================================
-- MIÉRT KELL, ÉS MIÉRT NEM ELÉG A 82-ES:
--   A 82-es `grants_researcher_sync_teachers_etl()` az oktatói nyilvántartásból
--   (echo.teacher) tölt. Élesben lefuttatva 2026-09-24-én 64 kutatót vitt be —
--   a validált lista viszont 273 nevet tartalmaz. Tehát a lista TÖBB, mint ami
--   a nyilvántartásban aktívan bent van, és a hiányzó 209 személyt máshonnan
--   kell felvinni.
--
-- MIÉRT A TÖRZSBE, ÉS NEM AZ OKTATÓI NYILVÁNTARTÁSBA:
--   Az echo.teacher-re az ECHO épül (jogosultsági kör, kurzus-oktató
--   hozzárendelés, kampányok). 209 új oktatói sor beírása oda olyan modult
--   érintene, amiről itt nincs döntés. A pályázati törzs ellenben pont arra
--   való, hogy oktatón kívül kutatót és PhD-hallgatót is tartalmazzon
--   (grants.researcher.teacher_id épp ezért nem kötelező). Aki a
--   nyilvántartásban is megvan, azt a kódja alapján ODAKÖTJÜK — így nem
--   duplázunk, és a kar/intézet onnan jön.
--
-- MIT AD:
--   • grants.researcher.kulso_kod — az intézményi kód (NJE…), hogy az újabb
--     validált lista ugyanazt a személyt találja meg, ne hozzon létre másodszor
--   • grants_researcher_import(p_items jsonb) — service_role, kötegelt,
--     ÚJRAFUTTATHATÓ. Egyeztetés sorrendje: intézményi kód → oktatói
--     nyilvántartás kódja → egyedi névegyezés. Több azonos nevűnél NEM dönt,
--     hanem jelenti — ott emberi döntés kell.
--   • a jelentésben MÉRT szám arról is, hogy a kód szerint hány személy van
--     meg a nyilvántartásban aktívan, hányan inaktívan és hányan egyáltalán
--     nem — e nélkül nem derül ki, hogy a lista és a regiszter miért tér el.
--
-- AMI SZÁNDÉKOSAN NEM TÖRTÉNIK MEG:
--   • a helykitöltő e-mailt (…@nje-import.invalid) nem írjuk be: nem
--     kapcsolattartási adat, és később élő címnek látszana
--   • az echo.teacher-t nem módosítjuk (sem új sor, sem aktiválás)
--   • a kurzusszám és az óraarány a listából METRIKA lesz (forras='kezi'),
--     nem tényadat a kurzustáblából — a kettő nem ugyanaz, és a profilban
--     látszik, hogy kézi listából jött
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Intézményi kód a törzsben
-- ------------------------------------------------------------
alter table grants.researcher add column if not exists kulso_kod text;

comment on column grants.researcher.kulso_kod is
  'Intézményi azonosító a validált listából (pl. NJE…). Erre egyeztetünk újrafuttatáskor, hogy ne duplázzunk. Nem ugyanaz, mint az echo.teacher.code — de ha egyezik, odakötjük a személyt.';

-- Egy kód egy személyhez tartozik. Részleges index: akinek nincs kódja
-- (felderítésből vagy kézzel vett fel), az nem ütközik.
create unique index if not exists grants_researcher_kulso_kod_uk
  on grants.researcher (lower(kulso_kod)) where kulso_kod is not null;


-- ------------------------------------------------------------
-- 2. A kötegelt import
-- ------------------------------------------------------------
-- Egy tétel alakja:
--   { "kod": "NJE001", "nev": "…", "cim": "dr.", "email": "…",
--     "tipus": "oktato", "kar": null, "intezet": null,
--     "metrikak": [{"kulcs":"kurzus_db","szam":7}, …] }
create or replace function public.grants_researcher_import(p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_it        jsonb;
  v_kod       text;
  v_nev       text;
  v_email     text;
  v_tipus     text;
  v_teacher   uuid;
  v_aktiv     boolean;
  v_res       uuid;
  v_talalat   integer;
  v_uj        integer := 0;
  v_frissitve integer := 0;
  v_kod_kotes integer := 0;
  v_nev_kotes integer := 0;
  v_tobbes    integer := 0;
  v_kihagyva  integer := 0;
  v_reg_aktiv integer := 0;
  v_reg_inakt integer := 0;
  v_reg_nincs integer := 0;
  v_nevtelen  integer := 0;
  v_tobbes_nevek text[] := '{}';
begin
  foreach v_it in array array(select jsonb_array_elements(coalesce(p_items, '[]'::jsonb)))
  loop
    v_kod   := nullif(btrim(coalesce(v_it->>'kod', '')), '');
    v_nev   := nullif(btrim(coalesce(v_it->>'nev', '')), '');
    v_email := nullif(btrim(lower(coalesce(v_it->>'email', ''))), '');
    v_tipus := coalesce(nullif(v_it->>'tipus', ''), 'oktato');
    if v_tipus not in ('oktato','kutato','phd','asszisztens','egyeb') then
      v_tipus := 'egyeb';
    end if;
    -- A helykitöltő cím nem kapcsolattartási adat.
    if v_email is null or v_email like '%@nje-import.invalid' then v_email := null; end if;

    if v_nev is null then
      -- Név nélkül nincs mit felvinni: kód alapján sem tudnánk ellenőrizni,
      -- hogy kiről van szó.
      v_nevtelen := v_nevtelen + 1;
      continue;
    end if;

    -- Megvan-e a kód az oktatói nyilvántartásban? Ezt MÉRJÜK, mert ez mondja
    -- meg, miért tér el a validált lista és a regiszter.
    v_teacher := null; v_aktiv := null;
    if v_kod is not null then
      select t.id, t.active into v_teacher, v_aktiv
        from echo.teacher t where lower(t.code) = lower(v_kod) limit 1;
    end if;
    if v_teacher is null then v_reg_nincs := v_reg_nincs + 1;
    elsif v_aktiv then v_reg_aktiv := v_reg_aktiv + 1;
    else v_reg_inakt := v_reg_inakt + 1;
    end if;

    -- 1) Egyeztetés az intézményi kódra (újrafuttatás esetén ez fog találni).
    v_res := null;
    if v_kod is not null then
      select id into v_res from grants.researcher where lower(kulso_kod) = lower(v_kod) limit 1;
    end if;

    -- 2) Egyeztetés az oktatói nyilvántartás azonosítójára: aki onnan már
    --    bekerült a törzsbe, azt NE vegyük fel másodszor.
    if v_res is null and v_teacher is not null then
      select id into v_res from grants.researcher where teacher_id = v_teacher limit 1;
      if v_res is not null then v_kod_kotes := v_kod_kotes + 1; end if;
    end if;

    -- 3) Egyeztetés névre — de CSAK ha egyetlen találat van. Két azonos nevű
    --    személynél a gép nem dönthet: ilyenkor jelentünk, és nem írunk.
    if v_res is null then
      select count(*) into v_talalat from grants.researcher r
       where grants.nev_norm(r.nev) = grants.nev_norm(v_nev);
      if v_talalat = 1 then
        select id into v_res from grants.researcher r
         where grants.nev_norm(r.nev) = grants.nev_norm(v_nev);
        v_nev_kotes := v_nev_kotes + 1;
      elsif v_talalat > 1 then
        v_tobbes := v_tobbes + 1;
        if array_length(v_tobbes_nevek, 1) is null or array_length(v_tobbes_nevek, 1) < 20 then
          v_tobbes_nevek := array_append(v_tobbes_nevek, v_nev);
        end if;
        continue;
      end if;
    end if;

    if v_res is null then
      insert into grants.researcher (nev, cim, email, tipus, kar, intezet, teacher_id,
                                     kulso_kod, allapot, validalt, validalt_at)
      values (v_nev, nullif(btrim(coalesce(v_it->>'cim','')), ''), v_email, v_tipus,
              nullif(btrim(coalesce(v_it->>'kar','')), ''),
              nullif(btrim(coalesce(v_it->>'intezet','')), ''),
              v_teacher, v_kod, 'aktiv', true, now())
      returning id into v_res;
      v_uj := v_uj + 1;
    else
      -- A meglévő adatot NEM írjuk felül üressel: a listában a cím és a
      -- szervezeti egység üres, a törzsben lehet, hogy már megvan.
      update grants.researcher r
         set kulso_kod   = coalesce(r.kulso_kod, v_kod),
             teacher_id  = coalesce(r.teacher_id, v_teacher),
             cim         = coalesce(r.cim, nullif(btrim(coalesce(v_it->>'cim','')), '')),
             email       = coalesce(r.email, v_email),
             kar         = coalesce(r.kar, nullif(btrim(coalesce(v_it->>'kar','')), '')),
             intezet     = coalesce(r.intezet, nullif(btrim(coalesce(v_it->>'intezet','')), '')),
             validalt    = true,
             validalt_at = coalesce(r.validalt_at, now()),
             updated_at  = now()
       where r.id = v_res;
      v_frissitve := v_frissitve + 1;
    end if;

    -- A listából jövő számok KÉZI forrásként: a kurzusszám itt nem a
    -- kurzustáblából van, és ez a profilban is látszik.
    if jsonb_typeof(v_it->'metrikak') = 'array' and jsonb_array_length(v_it->'metrikak') > 0 then
      perform public.grants_metrics_set(v_res, 'kezi', v_it->'metrikak');
    end if;
  end loop;

  return jsonb_build_object(
    'uj', v_uj, 'frissitve', v_frissitve,
    'oktatoi_nyilvantartashoz_kotve', v_kod_kotes,
    'nev_alapjan_egyeztetve', v_nev_kotes,
    'tobb_azonos_nevu_kihagyva', v_tobbes,
    'tobb_azonos_nevu_peldak', to_jsonb(v_tobbes_nevek),
    'nev_nelkul_kihagyva', v_nevtelen,
    'kihagyva', v_kihagyva,
    'regiszterben_aktiv', v_reg_aktiv,
    'regiszterben_inaktiv', v_reg_inakt,
    'regiszterben_nincs', v_reg_nincs,
    'torzs_osszesen', (select count(*) from grants.researcher),
    'torzs_validalt', (select count(*) from grants.researcher where validalt));
end $$;


-- ------------------------------------------------------------
-- 3. A kód megjelenítése a listában és a profilban
-- ------------------------------------------------------------
-- A 82-es lista- és profilfüggvény egészül ki a kóddal. Csak ennyi változik,
-- ezért itt nem definiáljuk újra az egészet: a jsonb-t kiegészítjük.
create or replace function grants.researcher_mutatok(p_researcher uuid)
returns jsonb
language sql stable
set search_path = grants, public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'mu_db',    (select count(*) from grants.researcher_work w where w.researcher_id = p_researcher),
    'idezet',   (select coalesce(sum(w.idezet), 0) from grants.researcher_work w where w.researcher_id = p_researcher),
    'h_index',  grants.h_index(p_researcher),
    'elso_ev',  (select min(w.ev) from grants.researcher_work w where w.researcher_id = p_researcher),
    'utolso_ev',(select max(w.ev) from grants.researcher_work w where w.researcher_id = p_researcher),
    'topic_db', (select count(*) from grants.researcher_topic t where t.researcher_id = p_researcher),
    'jelolt_db',(select count(*) from grants.identity_candidate c
                  where c.researcher_id = p_researcher and c.allapot = 'javasolt'),
    'kod',      (select r.kulso_kod from grants.researcher r where r.id = p_researcher),
    -- Kurzusszám az oktatói nyilvántartásból: ez mondja meg, ki tanít ma.
    -- Akit csak a validált listából vettünk fel, annál ez 0 — ott a lista
    -- saját kurzusszáma a 'kezi' metrikák között van.
    'kurzus_db',(select count(*) from echo.course_teacher ct
                  where ct.teacher_id = (select teacher_id from grants.researcher
                                          where id = p_researcher)),
    'metrikak', (select coalesce(jsonb_object_agg(f.forras, f.ertekek), '{}'::jsonb)
                   from (select m.forras,
                                jsonb_object_agg(m.kulcs,
                                  coalesce(to_jsonb(m.szam), to_jsonb(m.szoveg))) as ertekek
                           from grants.researcher_metric m
                          where m.researcher_id = p_researcher
                          group by m.forras) f),
    'forras_idezet', (select max(m.szam) from grants.researcher_metric m
                       where m.researcher_id = p_researcher and m.kulcs = 'idezet'
                         and m.forras <> 'kezi'),
    'forras_mu_db',  (select max(m.szam) from grants.researcher_metric m
                       where m.researcher_id = p_researcher and m.kulcs = 'mu_db'
                         and m.forras <> 'kezi'),
    'forras_h_index',(select max(m.szam) from grants.researcher_metric m
                       where m.researcher_id = p_researcher and m.kulcs = 'h_index'
                         and m.forras <> 'kezi'))
$$;

-- A lista sorai kapják meg a kódot is (a rendezés és a szűrés nem változik).
do $$
declare v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'grants_researchers' and p.pronargs = 9;
  if v_src is null then
    raise exception 'HIBA: a 82-es grants_researchers() nem talalhato — futtasd elobb a 82-est.';
  end if;
  if position('''kod'', m->''kod''' in v_src) = 0 then
    v_src := replace(v_src,
      '''kurzus_db'', m->''kurzus_db'', ''metrikak'', m->''metrikak'',',
      '''kurzus_db'', m->''kurzus_db'', ''metrikak'', m->''metrikak'', ''kod'', m->''kod'',');
    execute v_src;
    raise notice 'A kutatoi lista mostantol az intezmenyi kodot is visszaadja.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 4. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  execute 'revoke all on function grants.researcher_mutatok(uuid) from public';
  if has_anon then execute 'revoke all on function grants.researcher_mutatok(uuid) from anon'; end if;
  if has_auth then execute 'revoke all on function grants.researcher_mutatok(uuid) from authenticated'; end if;

  -- Az import service_role-only: ez tömegesen ír személyeket a törzsbe.
  execute 'revoke all on function public.grants_researcher_import(jsonb) from public';
  if has_anon then execute 'revoke all on function public.grants_researcher_import(jsonb) from anon'; end if;
  if has_auth then execute 'revoke all on function public.grants_researcher_import(jsonb) from authenticated'; end if;
  if has_srv  then execute 'grant execute on function public.grants_researcher_import(jsonb) to service_role'; end if;

  -- A 82-es lista újradefiniálva: az anon jogot itt is le kell venni.
  execute 'revoke all on function public.grants_researchers(text,text,text,text,text,integer,integer,text,text) from public';
  if has_anon then execute 'revoke all on function public.grants_researchers(text,text,text,text,text,integer,integer,text,text) from anon'; end if;
  if has_auth then execute 'grant execute on function public.grants_researchers(text,text,text,text,text,integer,integer,text,text) to authenticated'; end if;
end $grants$;

do $chk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_researcher_import(jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is tolthet be kutatoi listat.';
  end if;
  if has_function_privilege('anon', 'public.grants_researchers(text,text,text,text,text,integer,integer,text,text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a kutatoi listat.';
  end if;
  raise notice 'Rendben: 83 — validalt lista importja (service_role), intezmenyi kod a torzsben.';
end $chk$;
