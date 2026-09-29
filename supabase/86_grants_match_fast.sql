-- ============================================================
-- 86_grants_match_fast.sql — a párosítás időkorlát nélkül
-- ============================================================
-- MI TÖRTÉNT: a „Párosítás a felderítéssel" élesben
--   canceling statement due to statement timeout
-- hibával állt le.
--
-- MIÉRT: a 84-es `grants_match_roster()` SORONKÉNT dolgozott, és minden egyes
-- felderített szerzőnél KÉTSZER végigszámolta a teljes táblát, mindannyiszor
-- újraszámolva a `grants.nev_kulcs()` értéket (regex + tömbrendezés). Élesben
-- 1033 felderített sor × (1033 + 336) sor = ~1,4 millió kulcsszámítás.
-- MÉRVE a saját gépemen, szintetikus (rövid, ékezet nélküli) neveken:
-- 5,56 másodperc — éles adaton, hosszabb magyar nevekkel és hálózaton át ez
-- bőven a PostgREST időkorlátja fölé megy.
--
-- A JAVÍTÁS: a kulcsot MINDEN sorra EGYSZER számoljuk ki, ideiglenes táblába,
-- és onnan halmazműveletekkel (join, group by) dolgozunk. Ugyanaz a szabály,
-- ugyanaz az eredmény — csak nem négyzetes.
--
-- AMI NEM VÁLTOZIK (a döntési szabály):
--   • ORCID-egyezés + névátfedés  → automatikus összekötés
--   • ORCID-egyezés névkonfliktussal → CSAK jelzés, nem kötés
--   • névegyezés → CSAK javaslat, és csak ha a kulcs MINDKÉT oldalon egyedi
--   • több azonos nevű → a gép nem dönt, csak számol
--
-- PLUSZ: a `..._etl` végű, service_role-nak adott változatok. Ezek ugyanazt
-- csinálják, de nem kérnek irodai jogot — így a párosítás és a kötegelt
-- összekötés ütemezhető, illetve kívülről is lefuttatható, ha a felületen
-- időkorlátba futna.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Indexek a névkulcsra
-- ------------------------------------------------------------
-- A kulcs IMMUTABLE, tehát indexelhető. Az index nem a fenti négyzetes bajt
-- oldja meg (azt a halmazműveletre írás), hanem az egyedi lekérdezéseket
-- gyorsítja — például amikor a felület egyetlen névre keres rá.
do $$
begin
  begin
    create index if not exists grants_discovered_nevkulcs_idx
      on grants.discovered_author (forras, grants.nev_kulcs(nev));
    create index if not exists grants_researcher_nevkulcs_idx
      on grants.researcher (grants.nev_kulcs(nev));
  exception when others then
    -- Ha a szerver nem engedi az indexet a függvényre, attól a párosítás még
    -- működik: a gyorsaság a halmazműveletből jön, nem az indexből.
    raise notice 'A nevkulcs-index nem jott letre (%). A parositas enelkul is fut.', sqlerrm;
  end;
end $$;


-- ------------------------------------------------------------
-- 2. A párosítás — halmazműveletekkel
-- ------------------------------------------------------------
-- Közös törzs: a döntési logika EGY helyen. A két külső függvény (irodai és
-- service_role) csak a jogosultság-ellenőrzésben tér el.
create or replace function grants.match_roster_run(p_forras text)
returns jsonb
language plpgsql volatile
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_kotve integer := 0;
  v_javasolt integer := 0;
  v_konflikt integer := 0;
  v_tobbes integer := 0;
  v_forrasban_tobbes integer := 0;
begin
  -- A kulcsot soronként EGYSZER számoljuk ki.
  create temporary table _d on commit drop as
    select id, forras, kulso_id, nev, orcid, grants.nev_kulcs(nev) as k
      from grants.discovered_author
     where allapot = 'uj' and (p_forras is null or forras = p_forras);

  create temporary table _r on commit drop as
    select id, nev, orcid, openalex_id, mtmt_id, grants.nev_kulcs(nev) as k
      from grants.researcher;

  -- A forrásbeli egyediséghez a KIHAGYOTTAKON kívül minden sor számít, nem
  -- csak az eldöntetlenek — különben egy korábban összekötött névrokon
  -- eltűnne a számolásból.
  create temporary table _dk on commit drop as
    select forras, grants.nev_kulcs(nev) as k, count(*) as n
      from grants.discovered_author
     where allapot <> 'kihagyva'
     group by 1, 2;

  create temporary table _rk on commit drop as
    select k, count(*) as n from _r group by 1;

  -- 1) ORCID-párok. Egy felderített sorhoz legfeljebb egy kutató.
  create temporary table _orcid on commit drop as
    select distinct on (d.id)
           d.id as d_id, d.forras, d.kulso_id, d.orcid, d.nev as d_nev,
           r.id as r_id, r.nev as r_nev,
           grants.nev_atfedes(d.nev, r.nev) as nev_ok
      from _d d
      join _r r on d.orcid is not null and r.orcid is not null
                and lower(r.orcid) = lower(d.orcid)
     where (case when d.forras = 'openalex' then r.openalex_id else r.mtmt_id end) is null
     order by d.id, r.id;

  -- 1/a ORCID + név stimmel → kötés
  update grants.researcher r
     set openalex_id = o.kulso_id, orcid = coalesce(r.orcid, o.orcid),
         utolso_szinkron = null, updated_at = now()
    from _orcid o
   where o.nev_ok and o.forras = 'openalex' and r.id = o.r_id;

  update grants.researcher r
     set mtmt_id = o.kulso_id, orcid = coalesce(r.orcid, o.orcid),
         utolso_szinkron = null, updated_at = now()
    from _orcid o
   where o.nev_ok and o.forras = 'mtmt' and r.id = o.r_id;

  update grants.discovered_author d
     set allapot = 'osszekotve', researcher_id = o.r_id, javaslat_ok = 'orcid',
         dontes_at = now(), dontes_by = auth.uid()
    from _orcid o
   where o.nev_ok and d.id = o.d_id;
  get diagnostics v_kotve = row_count;

  -- 1/b ORCID egyezik, a név nem → csak jelzés
  update grants.discovered_author d
     set javasolt_researcher_id = o.r_id, javaslat_ok = 'orcid_nevkonflikt'
    from _orcid o
   where not o.nev_ok and d.id = o.d_id;
  get diagnostics v_konflikt = row_count;

  -- 2) Névegyezés — csak ott, ahol ORCID nem döntött, és a kulcs MINDKÉT
  --    oldalon egyedi, és a kutatónál még szabad az adott forrás azonosítója.
  update grants.discovered_author da
     set javasolt_researcher_id = t.r_id, javaslat_ok = 'nev'
    from (
      select d.id as d_id, r.id as r_id
        from _d d
        join _dk dk on dk.forras = d.forras and dk.k = d.k and dk.n = 1
        join _rk rk on rk.k = d.k and rk.n = 1
        join _r  r  on r.k = d.k
       where d.k is not null
         and not exists (select 1 from _orcid o where o.d_id = d.id)
         and (case when d.forras = 'openalex' then r.openalex_id else r.mtmt_id end) is null
    ) t
   where da.id = t.d_id;
  get diagnostics v_javasolt = row_count;

  -- 3) Amit a gép nem dönthet el — csak számoljuk, hogy látszódjon
  -- A két számláló DISZJUNKT, mint a 84-esben: ha már a forrásban is több
  -- azonos nevű van, ott a törzsoldalt meg sem nézzük — különben ugyanaz a
  -- sor mindkét számban benne lenne, és a jelentés többet mutatna a valósnál.
  select count(*) into v_tobbes
    from _d d
    join _dk dk on dk.forras = d.forras and dk.k = d.k and dk.n = 1
    join _rk rk on rk.k = d.k
   where d.k is not null and rk.n > 1
     and not exists (select 1 from _orcid o where o.d_id = d.id);

  select count(*) into v_forrasban_tobbes
    from _d d join _dk dk on dk.forras = d.forras and dk.k = d.k
   where d.k is not null and dk.n > 1
     and not exists (select 1 from _orcid o where o.d_id = d.id);

  return jsonb_build_object(
    'orcid_alapjan_kotve', v_kotve,
    'nev_alapjan_javasolt', v_javasolt,
    'orcid_nevkonfliktus', v_konflikt,
    'tobb_azonos_nevu_a_torzsben', v_tobbes,
    'tobb_azonos_nevu_a_forrasban', v_forrasban_tobbes,
    'osszekotott_kutato', (select count(*) from grants.researcher
                            where openalex_id is not null or mtmt_id is not null));
end $$;

create or replace function public.grants_match_roster(p_forras text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  perform grants.require_office();
  return grants.match_roster_run(p_forras);
end $$;

-- Ugyanaz irodai jog nélkül, service_role-nak: ütemezéshez és ahhoz, hogy a
-- felület időkorlátja se akadályozza meg a lefuttatását.
create or replace function public.grants_match_roster_etl(p_forras text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  return grants.match_roster_run(p_forras);
end $$;


-- ------------------------------------------------------------
-- 3. A kötegelt összekötés — szintén halmazművelettel
-- ------------------------------------------------------------
create or replace function grants.roster_bulk_link_run(
  p_forras text, p_csak_utolso_affiliacio boolean, p_csak_validalt boolean,
  p_min_mu integer, p_limit integer)
returns jsonb
language plpgsql volatile
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_kotve integer := 0;
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  create temporary table _jel on commit drop as
    with d as (
      select da.id, da.forras, da.kulso_id, da.orcid, da.javasolt_researcher_id,
             da.mu_db, da.utolso_affiliacio, grants.nev_kulcs(da.nev) as k
        from grants.discovered_author da
       where da.allapot = 'uj' and da.javaslat_ok = 'nev'
         and da.javasolt_researcher_id is not null
         and (p_forras is null or da.forras = p_forras)
         and (coalesce(p_csak_utolso_affiliacio, true) = false or da.utolso_affiliacio = true)
         and coalesce(da.mu_db, 0) >= greatest(coalesce(p_min_mu, 0), 0)
    ),
    dk as (select forras, grants.nev_kulcs(nev) as k, count(*) n
             from grants.discovered_author where allapot <> 'kihagyva' group by 1, 2),
    rk as (select grants.nev_kulcs(nev) as k, count(*) n from grants.researcher group by 1)
    select d.id, d.forras, d.kulso_id, d.orcid, d.javasolt_researcher_id as r_id
      from d
      join grants.researcher r on r.id = d.javasolt_researcher_id
      join dk on dk.forras = d.forras and dk.k = d.k and dk.n = 1
      join rk on rk.k = d.k and rk.n = 1
     where (coalesce(p_csak_validalt, true) = false or r.validalt = true)
       and (case when d.forras = 'openalex' then r.openalex_id else r.mtmt_id end) is null
     order by coalesce(d.mu_db, 0) desc
     limit v_lim;

  update grants.researcher r
     set openalex_id = j.kulso_id, orcid = coalesce(r.orcid, j.orcid),
         utolso_szinkron = null, updated_at = now()
    from _jel j where j.forras = 'openalex' and r.id = j.r_id;

  update grants.researcher r
     set mtmt_id = j.kulso_id, orcid = coalesce(r.orcid, j.orcid),
         utolso_szinkron = null, updated_at = now()
    from _jel j where j.forras = 'mtmt' and r.id = j.r_id;

  update grants.discovered_author d
     set allapot = 'osszekotve', researcher_id = j.r_id,
         dontes_at = now(), dontes_by = auth.uid()
    from _jel j where d.id = j.id;
  get diagnostics v_kotve = row_count;

  return jsonb_build_object(
    'osszekotve', v_kotve,
    'maradt_nev_javaslat', (select count(*) from grants.discovered_author
                             where allapot = 'uj' and javaslat_ok = 'nev'
                               and (p_forras is null or forras = p_forras)),
    'osszekotott_kutato', (select count(*) from grants.researcher
                            where openalex_id is not null or mtmt_id is not null));
end $$;

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
begin
  perform grants.require_office();
  return grants.roster_bulk_link_run(p_forras, p_csak_utolso_affiliacio, p_csak_validalt, p_min_mu, p_limit);
end $$;

create or replace function public.grants_roster_bulk_link_etl(
  p_forras                 text    default null,
  p_csak_utolso_affiliacio boolean default true,
  p_csak_validalt          boolean default true,
  p_min_mu                 integer default 0,
  p_limit                  integer default 1000
) returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  return grants.roster_bulk_link_run(p_forras, p_csak_utolso_affiliacio, p_csak_validalt, p_min_mu, p_limit);
end $$;


-- ------------------------------------------------------------
-- 4. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  -- A belső törzsek senkinek: csak a két burkolón át hívhatók.
  foreach f in array array[
    'grants.match_roster_run(text)',
    'grants.roster_bulk_link_run(text,boolean,boolean,integer,integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;

  -- Irodai változatok
  foreach f in array array[
    'public.grants_match_roster(text)',
    'public.grants_roster_bulk_link(text,boolean,boolean,integer,integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- ETL-változatok: KIZÁRÓLAG service_role
  foreach f in array array[
    'public.grants_match_roster_etl(text)',
    'public.grants_roster_bulk_link_etl(text,boolean,boolean,integer,integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', f); end if;
    if has_srv  then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $grants$;

do $chk$
begin
  if has_function_privilege('anon', 'public.grants_match_roster(text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a parositast.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_match_roster_etl(text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is futtathatja az ETL-parositast.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated',
         'public.grants_roster_bulk_link_etl(text,boolean,boolean,integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is futtathatja az ETL-osszekotest.';
  end if;
  raise notice 'Rendben: 86 — parositas es kotegelt osszekotes halmazmuvelettel, ETL-valtozatokkal.';
end $chk$;
