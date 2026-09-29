-- ============================================================
-- 84_grants_name_key.sql — sorrendfüggetlen névegyeztetés + kötegelt összekötés
-- ============================================================
-- MI A HIBA, ÉS MIÉRT MOST DERÜLT KI:
--   A 80-as `grants.nev_norm()` kisbetűsít, ékezetet és titulust vesz le, de a
--   SZAVAK SORRENDJÉT megtartja. A magyar névsorrend viszont fordítva van, mint
--   amit az OpenAlex ír: a validált listánk „Kovács János", az OpenAlex
--   „János Kovács". Az egyenlőségvizsgálat így szinte semmit nem talál.
--
--   MÉRVE 2026-09-24-én, a 273 fős validált listán a betöltött felderítés
--   ellen (egyértelmű, mindkét oldalon egyedi névegyezés):
--                       sorrendfüggő      sorrendfüggetlen kulccsal
--       OpenAlex (727)        3                    81
--       MTMT     (306)       28                    82
--   Tehát a sorrendfüggő egyeztetés a találatok ~80%-át elveszíti. A hiba
--   csendes volt: nem hibázott, csak nem talált.
--
-- MIT AD:
--   • grants.nev_kulcs() — a név szavai ABC-sorrendben, ékezet és titulus
--     nélkül. Sorrendfüggetlen összehasonlításra, NEM megjelenítésre.
--   • grants_match_roster() újradefiniálva erre a kulcsra. Az ORCID-út
--     változatlan (ORCID + névátfedés = kötés; ORCID egyezés névkonfliktussal
--     = csak jelzés). A névegyezés továbbra is CSAK javaslat, és csak akkor,
--     ha a kulcs MINDKÉT oldalon egyedi.
--   • grants_roster_bulk_link() — a névjavaslatok kötegelt elfogadása arra a
--     szűk körre, ahol a gépi döntés védhető: a kulcs mindkét oldalon egyedi,
--     a kutató validált, és (kérésre) a forrás szerint az NJE a legutolsó
--     affiliáció. Minden kötés visszavonható (Azonosító törlése a profilban).
--
-- MIÉRT MARAD A NÉV CSAK JAVASLAT: a névazonosság nem személyazonosság. A
-- kötegelt elfogadás is emberi döntés — csak egyszerre sokról szól, és a
-- felület pontosan kiírja, mit fogad el.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. A sorrendfüggetlen névkulcs
-- ------------------------------------------------------------
create or replace function grants.nev_kulcs(p text)
returns text
language sql immutable
set search_path = grants, public, pg_temp
as $$
  -- A nev_norm már levette az ékezetet és a titulust; itt a szavakat rendezzük,
  -- és a 2 karakternél rövidebbeket (kezdőbetűk: „J.") elhagyjuk, mert azok
  -- nem azonosítanak.
  select nullif((select string_agg(t, ' ' order by t)
                   from unnest(regexp_split_to_array(
                          regexp_replace(grants.nev_norm(p), '[^a-z0-9 ]', ' ', 'g'), '\s+')) t
                  where length(t) >= 2), '')
$$;

comment on function grants.nev_kulcs(text) is
  'A név szavai ABC-sorrendben, ékezet/titulus nélkül, a 2 karakternél rövidebbek elhagyva. Sorrendfüggetlen egyeztetésre — a magyar "Kovács János" és az OpenAlex "János Kovács" ugyanezt a kulcsot adja.';


-- ------------------------------------------------------------
-- 2. A párosítás a névkulcsra
-- ------------------------------------------------------------
create or replace function public.grants_match_roster(p_forras text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  d record;
  v_res uuid;
  v_kulcs text;
  v_db integer;
  v_kotve integer := 0;
  v_javasolt integer := 0;
  v_konflikt integer := 0;
  v_tobbes integer := 0;
  v_forrasban_tobbes integer := 0;
begin
  perform grants.require_office();

  for d in select * from grants.discovered_author
            where allapot = 'uj'
              and (p_forras is null or forras = p_forras)
            order by coalesce(mu_db, 0) desc
  loop
    v_res := null;

    -- 1) ORCID: a legerősebb jel, de névellenőrzéssel.
    if d.orcid is not null then
      select id into v_res from grants.researcher
       where lower(orcid) = lower(d.orcid)
         and (case when d.forras = 'openalex' then openalex_id else mtmt_id end) is null
       limit 1;
      if v_res is not null and not grants.nev_atfedes(d.nev, (select nev from grants.researcher where id = v_res)) then
        -- ORCID egyezik, a név nem: adathiba valahol. Javaslat, nem kötés.
        update grants.discovered_author
           set javasolt_researcher_id = v_res, javaslat_ok = 'orcid_nevkonflikt'
         where id = d.id;
        v_konflikt := v_konflikt + 1;
        continue;
      end if;
    end if;

    if v_res is not null then
      if d.forras = 'openalex' then
        update grants.researcher set openalex_id = d.kulso_id, orcid = coalesce(orcid, d.orcid),
               utolso_szinkron = null, updated_at = now() where id = v_res;
      else
        update grants.researcher set mtmt_id = d.kulso_id, orcid = coalesce(orcid, d.orcid),
               utolso_szinkron = null, updated_at = now() where id = v_res;
      end if;
      update grants.discovered_author
         set allapot = 'osszekotve', researcher_id = v_res, javaslat_ok = 'orcid',
             dontes_at = now(), dontes_by = auth.uid()
       where id = d.id;
      v_kotve := v_kotve + 1;
      continue;
    end if;

    -- 2) Név: SORRENDFÜGGETLEN kulcson, és csak ha MINDKÉT oldalon egyedi.
    v_kulcs := grants.nev_kulcs(d.nev);
    if v_kulcs is null then continue; end if;

    -- Egyedi-e a forrásban? Két azonos nevű felderített szerzőnél a gép nem
    -- tudja, melyik a mi emberünk.
    select count(*) into v_db from grants.discovered_author x
     where x.forras = d.forras and grants.nev_kulcs(x.nev) = v_kulcs
       and x.allapot <> 'kihagyva';
    if v_db > 1 then
      v_forrasban_tobbes := v_forrasban_tobbes + 1;
      continue;
    end if;

    -- Egyedi-e a törzsben?
    select count(*) into v_db from grants.researcher r
     where grants.nev_kulcs(r.nev) = v_kulcs;
    if v_db = 1 then
      select id into v_res from grants.researcher r
       where grants.nev_kulcs(r.nev) = v_kulcs
         and (case when d.forras = 'openalex' then r.openalex_id else r.mtmt_id end) is null;
      if v_res is not null then
        update grants.discovered_author
           set javasolt_researcher_id = v_res, javaslat_ok = 'nev'
         where id = d.id;
        v_javasolt := v_javasolt + 1;
      end if;
    elsif v_db > 1 then
      v_tobbes := v_tobbes + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'orcid_alapjan_kotve', v_kotve,
    'nev_alapjan_javasolt', v_javasolt,
    'orcid_nevkonfliktus', v_konflikt,
    'tobb_azonos_nevu_a_torzsben', v_tobbes,
    'tobb_azonos_nevu_a_forrasban', v_forrasban_tobbes,
    'osszekotott_kutato', (select count(*) from grants.researcher
                            where openalex_id is not null or mtmt_id is not null));
end $$;


-- ------------------------------------------------------------
-- 3. A névjavaslatok kötegelt elfogadása
-- ------------------------------------------------------------
-- Ugyanazt teszi, mint a `grants_discovered_link` egyenként, csak a szűk,
-- védhető körre: egyedi névkulcs mindkét oldalon, validált kutató, és kérésre
-- csak akkor, ha a forrás szerint az NJE a legutolsó affiliáció.
create or replace function public.grants_roster_bulk_link(
  p_forras                 text    default null,
  p_csak_utolso_affiliacio boolean default true,
  p_csak_validalt          boolean default true,
  p_min_mu                 integer default 0,
  p_limit                  integer default 200
) returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  d record;
  v_kotve integer := 0;
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  perform grants.require_office();

  for d in
    select da.id, da.forras, da.kulso_id, da.orcid, da.javasolt_researcher_id
      from grants.discovered_author da
      join grants.researcher r on r.id = da.javasolt_researcher_id
     where da.allapot = 'uj'
       and da.javaslat_ok = 'nev'
       and da.javasolt_researcher_id is not null
       and (p_forras is null or da.forras = p_forras)
       and (coalesce(p_csak_validalt, true) = false or r.validalt = true)
       and (coalesce(p_csak_utolso_affiliacio, true) = false or da.utolso_affiliacio = true)
       and coalesce(da.mu_db, 0) >= greatest(coalesce(p_min_mu, 0), 0)
       -- Az azonosító még szabad annál a kutatónál.
       and (case when da.forras = 'openalex' then r.openalex_id else r.mtmt_id end) is null
       -- A névkulcs mindkét oldalon egyedi: a javaslat születése óta is.
       and (select count(*) from grants.discovered_author x
             where x.forras = da.forras and x.allapot <> 'kihagyva'
               and grants.nev_kulcs(x.nev) = grants.nev_kulcs(da.nev)) = 1
       and (select count(*) from grants.researcher y
             where grants.nev_kulcs(y.nev) = grants.nev_kulcs(da.nev)) = 1
     order by coalesce(da.mu_db, 0) desc
     limit v_lim
  loop
    if d.forras = 'openalex' then
      update grants.researcher set openalex_id = d.kulso_id, orcid = coalesce(orcid, d.orcid),
             utolso_szinkron = null, updated_at = now() where id = d.javasolt_researcher_id;
    else
      update grants.researcher set mtmt_id = d.kulso_id, orcid = coalesce(orcid, d.orcid),
             utolso_szinkron = null, updated_at = now() where id = d.javasolt_researcher_id;
    end if;
    update grants.discovered_author
       set allapot = 'osszekotve', researcher_id = d.javasolt_researcher_id,
           dontes_at = now(), dontes_by = auth.uid()
     where id = d.id;
    v_kotve := v_kotve + 1;
  end loop;

  return jsonb_build_object(
    'osszekotve', v_kotve,
    'maradt_nev_javaslat', (select count(*) from grants.discovered_author
                             where allapot = 'uj' and javaslat_ok = 'nev'
                               and (p_forras is null or forras = p_forras)),
    'osszekotott_kutato', (select count(*) from grants.researcher
                            where openalex_id is not null or mtmt_id is not null));
end $$;


-- ------------------------------------------------------------
-- 4. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
begin
  execute 'revoke all on function grants.nev_kulcs(text) from public';
  if has_anon then execute 'revoke all on function grants.nev_kulcs(text) from anon'; end if;

  foreach f in array array[
    'public.grants_match_roster(text)',
    'public.grants_roster_bulk_link(text,boolean,boolean,integer,integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

do $chk$
declare v_p text; v_o text;
begin
  -- A lényeg egy sorban: a magyar és az angol névsorrend ugyanezt a kulcsot adja.
  v_p := grants.nev_kulcs('Dr. Kovács János');
  v_o := grants.nev_kulcs('János Kovács');
  if v_p is distinct from v_o then
    raise exception 'HIBA: a nevkulcs sorrendfuggo maradt ("%" <> "%").', v_p, v_o;
  end if;
  if grants.nev_kulcs('J. Kovács') <> 'kovacs' then
    raise exception 'HIBA: a kezdobetu nem tunt el a kulcsbol ("%").', grants.nev_kulcs('J. Kovács');
  end if;
  if has_function_privilege('anon', 'public.grants_roster_bulk_link(text,boolean,boolean,integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a kotegelt osszekotest.';
  end if;
  raise notice 'Rendben: 84 — sorrendfuggetlen nevkulcs, ujra-parositas, kotegelt osszekotes.';
end $chk$;
