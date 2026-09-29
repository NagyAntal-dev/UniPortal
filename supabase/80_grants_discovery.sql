-- ============================================================
-- 80_grants_discovery.sql — kik vannak hozzánk affiliálva?
-- ============================================================
-- MIT AD: a felderítés adatbázis-oldalát. Az OpenAlex és az MTMT megkérdezése
-- után a talált szerzők NEM a kutatói törzsbe kerülnek, hanem egy külön
-- „felderített szerző" táblába, ahonnan döntés után lépnek be.
--
-- MIÉRT NEM EGYENESEN A TÖRZSBE: a két forrás az NJE-hez affiliált szerzőket
-- adja, ami nem ugyanaz, mint „a mi mai kutatónk". Van köztük, aki évekkel
-- ezelőtt volt itt, van, aki egyetlen társszerzős cikk miatt szerepel, és van
-- névazonosságból eredő hibás találat is. Ha ezek mind a törzsbe kerülnének,
-- a lista használhatatlanná válna, a javaslatok pedig olyan embereknek
-- szólnának, akik nincsenek is itt.
--
-- MÉRVE (2026-09-24, valódi lekérdezéssel):
--   • OpenAlex: 727 szerző NJE-affiliációval, ebből 421-nél ez a LEGUTOLSÓ
--     affiliáció, 382-nek van ORCID-je, 354-nek legalább 10 műve.
--   • MTMT: az NJE csomópont (mtid 20201) alatt 11 alegység; a szerzőket
--     egységenként kell kérdezni, mert az intézményi lekérdezés csak a
--     közvetlenül a felső csomóponthoz rendelteket adja. Így 306 egyedi
--     szerző jön ki (113 ORCID-del): NJE 48, GSZDI 90, GAMFK 58, PK 56,
--     GK 38, KVK 34, GTK 15, MI Tudásközpont 1.
--   • A két halmaz átfedése ORCID-en 70, névegyezésen 142 — vagyis a
--     forrásokat együtt kell kezelni, és 164 név CSAK az MTMT-ben van meg
--     (jellemzően magyar nyelvű termés).
--
-- A PÁROSÍTÁS JAVASLAT, NEM DÖNTÉS: ORCID-egyezésre és névegyezésre javaslunk
-- meglévő kutatót, de az összekötés kézi jóváhagyás.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Névnormalizálás a javaslatokhoz
-- ------------------------------------------------------------
-- Ékezetek összevonása és a tudományos címek elhagyása. NEM tökéletes
-- azonosítás — csak arra jó, hogy két alak összetartozását FELVETHESSE.
create or replace function grants.nev_norm(p text)
returns text
language sql immutable
as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(p, '')),
                       'áéíóöőúüűÁÉÍÓÖŐÚÜŰ', 'aeiooouuuaeiooouuu'),
             '\m(dr|prof|phd|dsc|csc|habil|med|univ)\.?\M', '', 'g'),
           '\s+', ' ', 'g')), '')
$$;


-- Van-e a két névben közös, legalább 3 betűs tag? A magyar és a nyugati
-- névsorrend miatt a sorrendet nem nézzük, csak a halmazt.
--
-- MIÉRT KELL: 2026-09-24-én mérve az MTMT és az OpenAlex a
-- 0009-0001-0257-4812 ORCID-en KÉT MÁS nevet mutat („Varga Erika", illetve
-- „Eugen Varga"). Vagyis egy ORCID-egyezés is lehet hibás adatbevitel
-- eredménye — ezért az ORCID-re épülő automatikus kötés is csak akkor
-- érvényes, ha a nevek is átfedik egymást.
create or replace function grants.nev_atfedes(a text, b text)
returns boolean
language sql immutable
as $$
  select exists (
    select 1
      from unnest(string_to_array(grants.nev_norm(a), ' ')) x
      join unnest(string_to_array(grants.nev_norm(b), ' ')) y on x = y
     where length(x) >= 3)
$$;


-- ------------------------------------------------------------
-- 2. Felderített szerzők
-- ------------------------------------------------------------
create table if not exists grants.discovered_author (
  id            uuid primary key default gen_random_uuid(),
  forras        text not null
                  constraint grants_disc_forras_ck check (forras in ('openalex','mtmt')),
  kulso_id      text not null,
  nev           text,
  nev_valtozatok text[],
  orcid         text,
  intezmeny     text,
  szervezeti_egyseg text,                       -- MTMT: melyik alegység alatt találtuk
  mu_db         integer,
  idezet        integer,
  h_index       integer,
  utolso_affiliacio boolean,                    -- OpenAlex: az NJE a LEGUTOLSÓ affiliációja
  temak         jsonb not null default '[]'::jsonb,
  payload       jsonb not null default '{}'::jsonb,
  allapot       text not null default 'uj'
                  constraint grants_disc_allapot_ck check (allapot in ('uj','osszekotve','kihagyva')),
  researcher_id uuid references grants.researcher(id) on delete set null,
  javasolt_researcher_id uuid references grants.researcher(id) on delete set null,
  javaslat_ok   text,                           -- 'orcid' | 'nev' | null
  kihagyas_oka  text,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  dontes_at     timestamptz,
  dontes_by     uuid,
  constraint grants_disc_kulcs_uq unique (forras, kulso_id)
);
create index if not exists grants_disc_allapot_idx on grants.discovered_author (forras, allapot, mu_db desc);
create index if not exists grants_disc_nev_idx     on grants.discovered_author (grants.nev_norm(nev));

comment on table grants.discovered_author is
  'Az OpenAlex/MTMT szerint az NJE-hez affiliált szerzők. NEM a kutatói törzs: ide a forrás állítása kerül, a törzsbe csak kézi döntés után lép be egy személy.';


-- ------------------------------------------------------------
-- 3. Betöltés (service_role — a felderítő Edge Function)
-- ------------------------------------------------------------
create or replace function public.grants_discovered_upsert(p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_it    jsonb;
  v_uj    integer := 0;
  v_mod   integer := 0;
  v_kot   integer := 0;
  v_id    uuid;
  v_orcid text;
  v_res   uuid;
  v_javas uuid;
  v_ok    text;
  v_letez boolean;
begin
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if nullif(btrim(coalesce(v_it->>'kulso_id','')), '') is null then continue; end if;
    v_orcid := grants.orcid_norm(v_it->>'orcid');
    v_res := null; v_javas := null; v_ok := null;

    -- Már összekötött kutató? Ekkor a felderítés csak megerősíti, amit tudunk.
    if p_forras = 'openalex' then
      select id into v_res from grants.researcher where openalex_id = v_it->>'kulso_id';
    else
      select id into v_res from grants.researcher where mtmt_id = v_it->>'kulso_id';
    end if;

    -- Javaslat: először ORCID (személyhez kötött), utána EGYEDI névegyezés.
    if v_res is null and v_orcid is not null then
      select id into v_javas from grants.researcher where lower(orcid) = lower(v_orcid);
      if v_javas is not null then
        -- ORCID egyezik: általában ez a legerősebb jel. DE ha a nevek egyáltalán
        -- nem fedik egymást, az adathiba (mérve: van ilyen), ezért jelöljük, és
        -- a kötegelt felvétel kihagyja.
        if grants.nev_atfedes(v_it->>'nev', (select nev from grants.researcher where id = v_javas)) then
          v_ok := 'orcid';
        else
          v_ok := 'orcid_nevkonflikt';
        end if;
      end if;
    end if;
    if v_res is null and v_javas is null and v_it->>'nev' is not null then
      select r.id into v_javas
        from grants.researcher r
       where grants.nev_norm(r.nev) = grants.nev_norm(v_it->>'nev')
       limit 2;
      -- Csak akkor javaslunk nevet, ha PONTOSAN EGY találat van: két azonos
      -- nevű kutatónál a gép nem tud dönteni, és nem is szabad.
      if v_javas is not null
         and (select count(*) from grants.researcher r2
               where grants.nev_norm(r2.nev) = grants.nev_norm(v_it->>'nev')) = 1 then
        v_ok := 'nev';
      else
        v_javas := null;
      end if;
    end if;

    select exists (select 1 from grants.discovered_author
                    where forras = p_forras and kulso_id = v_it->>'kulso_id') into v_letez;

    insert into grants.discovered_author (
      forras, kulso_id, nev, nev_valtozatok, orcid, intezmeny, szervezeti_egyseg,
      mu_db, idezet, h_index, utolso_affiliacio, temak, payload,
      allapot, researcher_id, javasolt_researcher_id, javaslat_ok)
    values (
      p_forras, v_it->>'kulso_id', nullif(v_it->>'nev',''),
      case when v_it ? 'nev_valtozatok'
           then (select array_agg(x) from jsonb_array_elements_text(v_it->'nev_valtozatok') x)
           else null end,
      v_orcid, nullif(v_it->>'intezmeny',''), nullif(v_it->>'szervezeti_egyseg',''),
      nullif(v_it->>'mu_db','')::integer, nullif(v_it->>'idezet','')::integer,
      nullif(v_it->>'h_index','')::integer, (v_it->>'utolso_affiliacio')::boolean,
      coalesce(v_it->'temak', '[]'::jsonb), coalesce(v_it->'payload', '{}'::jsonb),
      case when v_res is not null then 'osszekotve' else 'uj' end, v_res, v_javas, v_ok)
    on conflict (forras, kulso_id) do update
       set nev = coalesce(excluded.nev, grants.discovered_author.nev),
           nev_valtozatok = coalesce(excluded.nev_valtozatok, grants.discovered_author.nev_valtozatok),
           orcid = coalesce(excluded.orcid, grants.discovered_author.orcid),
           intezmeny = coalesce(excluded.intezmeny, grants.discovered_author.intezmeny),
           szervezeti_egyseg = coalesce(excluded.szervezeti_egyseg, grants.discovered_author.szervezeti_egyseg),
           mu_db = excluded.mu_db, idezet = excluded.idezet, h_index = excluded.h_index,
           utolso_affiliacio = excluded.utolso_affiliacio,
           temak = excluded.temak, payload = excluded.payload,
           -- A KIHAGYOTT és az ÖSSZEKÖTÖTT döntést a betöltés nem írja vissza:
           -- ami egyszer eldőlt, azt csak ember változtathatja meg.
           researcher_id = coalesce(grants.discovered_author.researcher_id, excluded.researcher_id),
           javasolt_researcher_id = case when grants.discovered_author.allapot = 'uj'
                                         then excluded.javasolt_researcher_id
                                         else grants.discovered_author.javasolt_researcher_id end,
           javaslat_ok = case when grants.discovered_author.allapot = 'uj'
                              then excluded.javaslat_ok else grants.discovered_author.javaslat_ok end,
           allapot = case when grants.discovered_author.allapot = 'uj' and excluded.researcher_id is not null
                          then 'osszekotve' else grants.discovered_author.allapot end,
           last_seen = now()
    returning id into v_id;

    if v_letez then v_mod := v_mod + 1; else v_uj := v_uj + 1; end if;
    if v_res is not null then v_kot := v_kot + 1; end if;
  end loop;

  return jsonb_build_object('uj', v_uj, 'frissitve', v_mod, 'mar_osszekotve', v_kot);
end $$;


-- ------------------------------------------------------------
-- 4. Olvasás (iroda)
-- ------------------------------------------------------------
create or replace function public.grants_discovered(
  p_forras  text    default null,
  p_q       text    default null,
  p_allapot text    default 'uj',
  p_min_mu  integer default null,
  p_limit   integer default 100,
  p_offset  integer default 0
) returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_q   text    := nullif(btrim(coalesce(p_q, '')), '');
  v_ossz integer;
  v_sorok jsonb;
begin
  perform grants.require_office();

  select count(*) into v_ossz
    from grants.discovered_author d
   where (p_forras  is null or d.forras = p_forras)
     and (p_allapot is null or d.allapot = p_allapot)
     and (p_min_mu  is null or coalesce(d.mu_db, 0) >= p_min_mu)
     and (v_q is null or d.nev ilike '%' || v_q || '%' or coalesce(d.orcid,'') ilike '%' || v_q || '%');

  select coalesce(jsonb_agg(x order by rend, nev), '[]'::jsonb) into v_sorok
  from (
    select jsonb_build_object(
             'id', d.id, 'forras', d.forras, 'kulso_id', d.kulso_id,
             'nev', d.nev, 'nev_valtozatok', to_jsonb(coalesce(d.nev_valtozatok, '{}')),
             'orcid', d.orcid, 'intezmeny', d.intezmeny,
             'szervezeti_egyseg', d.szervezeti_egyseg,
             'mu_db', d.mu_db, 'idezet', d.idezet, 'h_index', d.h_index,
             'utolso_affiliacio', d.utolso_affiliacio,
             'temak', d.temak, 'allapot', d.allapot,
             'javaslat_ok', d.javaslat_ok,
             'javasolt_nev', (select r.nev from grants.researcher r where r.id = d.javasolt_researcher_id),
             'javasolt_id', d.javasolt_researcher_id,
             'kutato_nev', (select r.nev from grants.researcher r where r.id = d.researcher_id),
             'kutato_id', d.researcher_id,
             'kihagyas_oka', d.kihagyas_oka,
             'first_seen', d.first_seen, 'last_seen', d.last_seen
           ) as x,
           -- Előre azok, akiknél van javaslat: ott a döntés egy kattintás.
           case when d.javasolt_researcher_id is not null then 0 else 1 end as rend,
           coalesce(d.nev, '') as nev
      from grants.discovered_author d
     where (p_forras  is null or d.forras = p_forras)
       and (p_allapot is null or d.allapot = p_allapot)
       and (p_min_mu  is null or coalesce(d.mu_db, 0) >= p_min_mu)
       and (v_q is null or d.nev ilike '%' || v_q || '%' or coalesce(d.orcid,'') ilike '%' || v_q || '%')
     order by rend, coalesce(d.mu_db, 0) desc, d.nev
     limit v_lim offset v_off
  ) t;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_sorok),
                            'hatar', v_lim, 'eltolas', v_off, 'sorok', v_sorok);
end $$;

create or replace function public.grants_discovery_stats()
returns jsonb
language plpgsql stable security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_out jsonb;
begin
  perform grants.require_office();
  select jsonb_build_object(
    'forrasonkent', (select coalesce(jsonb_object_agg(f, x), '{}'::jsonb)
       from (select forras f, jsonb_build_object(
                      'osszes', count(*),
                      'uj', count(*) filter (where allapot = 'uj'),
                      'osszekotve', count(*) filter (where allapot = 'osszekotve'),
                      'kihagyva', count(*) filter (where allapot = 'kihagyva'),
                      'javaslattal', count(*) filter (where allapot = 'uj' and javasolt_researcher_id is not null),
                      'orcid', count(*) filter (where orcid is not null),
                      'tiz_mu_felett', count(*) filter (where coalesce(mu_db,0) >= 10)) x
               from grants.discovered_author group by forras) t),
    'kutato_db', (select count(*) from grants.researcher),
    'osszekotott_kutato', (select count(*) from grants.researcher
                            where openalex_id is not null or mtmt_id is not null)
  ) into v_out;
  return v_out;
end $$;


-- ------------------------------------------------------------
-- 5. Döntések (iroda)
-- ------------------------------------------------------------
-- Összekötés meglévő kutatóval. Ha p_researcher null, a JAVASOLT kutatóval.
create or replace function public.grants_discovered_link(p_id uuid, p_researcher uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare d grants.discovered_author%rowtype; v_res uuid;
begin
  perform grants.require_office();
  select * into d from grants.discovered_author where id = p_id for update;
  if not found then raise exception 'GRANTS_DISCOVERED_NOT_FOUND'; end if;
  v_res := coalesce(p_researcher, d.javasolt_researcher_id);
  if v_res is null then
    raise exception 'GRANTS_BAD_INPUT: nincs megadva és nincs javasolt kutató sem.';
  end if;
  if not exists (select 1 from grants.researcher where id = v_res) then
    raise exception 'GRANTS_RESEARCHER_NOT_FOUND';
  end if;

  if d.forras = 'openalex' then
    update grants.researcher
       set openalex_id = d.kulso_id,
           orcid = coalesce(orcid, d.orcid),
           utolso_szinkron = null, updated_at = now()
     where id = v_res;
  else
    update grants.researcher
       set mtmt_id = d.kulso_id,
           orcid = coalesce(orcid, d.orcid),
           utolso_szinkron = null, updated_at = now()
     where id = v_res;
  end if;

  update grants.discovered_author
     set allapot = 'osszekotve', researcher_id = v_res,
         dontes_at = now(), dontes_by = auth.uid()
   where id = p_id;

  return jsonb_build_object('ok', true, 'kutato_id', v_res,
                            'kutato_nev', (select nev from grants.researcher where id = v_res));
end $$;

-- ÚJ kutató a felderített szerzőből. A típus alapértelmezésben 'kutato',
-- mert a forrás publikációs affiliációt állít, nem munkaviszonyt.
create or replace function public.grants_discovered_create(p_id uuid, p_tipus text default 'kutato')
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare d grants.discovered_author%rowtype; v_res uuid;
begin
  perform grants.require_office();
  select * into d from grants.discovered_author where id = p_id for update;
  if not found then raise exception 'GRANTS_DISCOVERED_NOT_FOUND'; end if;
  if d.allapot = 'osszekotve' then
    raise exception 'GRANTS_ALREADY_LINKED: ez a szerző már egy kutatóhoz tartozik.';
  end if;
  if nullif(btrim(coalesce(d.nev,'')), '') is null then
    raise exception 'GRANTS_BAD_INPUT: a felderített szerzőnek nincs neve, így nem vehető fel.';
  end if;

  insert into grants.researcher (nev, tipus, orcid,
                                 openalex_id, mtmt_id, intezet, gepi_epites)
  values (d.nev, coalesce(nullif(p_tipus,''), 'kutato'), d.orcid,
          case when d.forras = 'openalex' then d.kulso_id end,
          case when d.forras = 'mtmt'     then d.kulso_id end,
          d.szervezeti_egyseg, true)
  returning id into v_res;

  update grants.discovered_author
     set allapot = 'osszekotve', researcher_id = v_res,
         dontes_at = now(), dontes_by = auth.uid()
   where id = p_id;

  -- A MÁSIK forrásban ugyanez a személy ORCID alapján felismerhető: ott is
  -- felajánljuk, hogy ehhez a (most létrejött) kutatóhoz tartozik.
  if d.orcid is not null then
    update grants.discovered_author
       set javasolt_researcher_id = v_res, javaslat_ok = 'orcid'
     where allapot = 'uj' and lower(orcid) = lower(d.orcid) and id <> p_id;
  end if;

  return jsonb_build_object('ok', true, 'kutato_id', v_res, 'kutato_nev', d.nev);
end $$;

create or replace function public.grants_discovered_ignore(p_id uuid, p_ok text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
begin
  perform grants.require_office();
  update grants.discovered_author
     set allapot = 'kihagyva', kihagyas_oka = nullif(btrim(coalesce(p_ok,'')), ''),
         dontes_at = now(), dontes_by = auth.uid()
   where id = p_id;
  if not found then raise exception 'GRANTS_DISCOVERED_NOT_FOUND'; end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- Kötegelt felvétel: a forrás szerinti aktív, legalább N művel rendelkező, még
-- nem eldöntött szerzőkből kutatói rekord. AKINÉL VAN JAVASLAT, azt kihagyja —
-- ott előbb az emberi döntés kell, különben kettőzést csinálnánk.
create or replace function public.grants_discovered_bulk_create(
  p_forras text,
  p_min_mu integer default 5,
  p_csak_utolso_affiliacio boolean default true,
  p_limit  integer default 200
) returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare r record; v_db integer := 0; v_res uuid;
begin
  perform grants.require_office();
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;

  for r in select * from grants.discovered_author d
            where d.forras = p_forras
              and d.allapot = 'uj'
              and d.javasolt_researcher_id is null
              and coalesce(d.mu_db, 0) >= greatest(coalesce(p_min_mu, 0), 0)
              and (not coalesce(p_csak_utolso_affiliacio, true)
                   or d.utolso_affiliacio is not false)
              and nullif(btrim(coalesce(d.nev,'')), '') is not null
            order by coalesce(d.mu_db, 0) desc
            limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  loop
    begin
      insert into grants.researcher (nev, tipus, orcid, openalex_id, mtmt_id, intezet, gepi_epites)
      values (r.nev, 'kutato', r.orcid,
              case when r.forras = 'openalex' then r.kulso_id end,
              case when r.forras = 'mtmt'     then r.kulso_id end,
              r.szervezeti_egyseg, true)
      returning id into v_res;
    exception when unique_violation then
      -- Ugyanaz az ORCID már bent van: akkor összekötés, nem új rekord.
      select id into v_res from grants.researcher where lower(orcid) = lower(r.orcid);
      if v_res is null then continue; end if;
      if r.forras = 'openalex' then
        update grants.researcher set openalex_id = coalesce(openalex_id, r.kulso_id) where id = v_res;
      else
        update grants.researcher set mtmt_id = coalesce(mtmt_id, r.kulso_id) where id = v_res;
      end if;
    end;
    update grants.discovered_author
       set allapot = 'osszekotve', researcher_id = v_res, dontes_at = now(), dontes_by = auth.uid()
     where id = r.id;
    v_db := v_db + 1;
  end loop;

  return jsonb_build_object('felvett', v_db,
                            'kutato_db', (select count(*) from grants.researcher));
end $$;


-- ------------------------------------------------------------
-- 6. Jogosultságok
-- ------------------------------------------------------------
do $grants$
declare
  f text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_srv  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  execute 'revoke all on function grants.nev_norm(text) from public';
  if has_anon then execute 'revoke all on function grants.nev_norm(text) from anon'; end if;
  if has_auth then execute 'revoke all on function grants.nev_norm(text) from authenticated'; end if;

  foreach f in array array[
    'public.grants_discovered(text,text,text,integer,integer,integer)',
    'public.grants_discovery_stats()',
    'public.grants_discovered_link(uuid,uuid)',
    'public.grants_discovered_create(uuid,text)',
    'public.grants_discovered_ignore(uuid,text)',
    'public.grants_discovered_bulk_create(text,integer,boolean,integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if has_anon then execute format('revoke all on function %s from anon', f); end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- A betöltő CSAK a service_role-nak.
  execute 'revoke all on function public.grants_discovered_upsert(text,jsonb) from public';
  if has_anon then execute 'revoke all on function public.grants_discovered_upsert(text,jsonb) from anon'; end if;
  if has_auth then execute 'revoke all on function public.grants_discovered_upsert(text,jsonb) from authenticated'; end if;
  if has_srv  then execute 'grant execute on function public.grants_discovered_upsert(text,jsonb) to service_role'; end if;
end $grants$;

do $$
declare t text;
begin
  for t in select format('grants.%I', tablename) from pg_tables where schemaname = 'grants' loop
    execute format('revoke all on table %s from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %s from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %s from authenticated', t);
    end if;
  end loop;
end $$;

-- Az MTMT-forrás gépi gyűjtését az egyetem döntése nyitja meg: a saját
-- intézményi körünkre kérdezünk (mtid 20201 és alegységei), mérsékelt ütemmel.
update grants.source
   set gepi_gyujtes = true,
       jogi_megjegyzes = 'Saját intézményi kör (mtid 20201 és alegységei), mérsékelt ütemmel. '
                       || 'Az adatra nincs nyílt licenc, ezért a rendszeres gyűjtés kereteit az '
                       || 'MTA KIK-kel írásban egyeztetni kell — a jelenlegi felderítés az egyetem '
                       || 'saját adatszolgáltatói körére szorítkozik.'
 where kod = 'mtmt';

insert into grants.source (kod, nev, tipus, url, leiras, gepi_gyujtes, jogi_megjegyzes) values
  ('openalex', 'OpenAlex (kutatói profilok)', 'api', 'https://api.openalex.org',
   'Publikációs metaadat CC0 licenc alatt. 2026-09-23-án mérve: az NJE-hez 771 szerző '
   'van affiliálva, ebből 389-nek van ORCID-je. 2026 februárja óta API-kulcs kell a '
   'produktív használathoz; az ingyenes szint a mi méretünkben elég.',
   true, 'CC0 licenc, helyben tárolható.')
on conflict (kod) do nothing;

-- A 79-es migráció automatikus ORCID-kötését is szigorítjuk ugyanezzel az
-- ellenőrzéssel: a név egyezése nélkül nem kötünk, csak javaslatot rögzítünk.
create or replace function public.grants_candidates_upsert(
  p_researcher uuid, p_forras text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = grants, public, extensions, pg_temp
as $$
declare v_it jsonb; v_uj integer := 0; v_auto integer := 0; v_konflikt integer := 0; v_nev text;
begin
  if p_forras not in ('openalex','mtmt') then
    raise exception 'GRANTS_BAD_INPUT: ismeretlen forrás: %', p_forras;
  end if;
  select nev into v_nev from grants.researcher where id = p_researcher;
  if v_nev is null then raise exception 'GRANTS_RESEARCHER_NOT_FOUND'; end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into grants.identity_candidate (researcher_id, forras, kulso_id, nev, intezmeny,
                                            orcid, mu_db, idezet, pontszam, indok, allapot)
    values (p_researcher, p_forras, v_it->>'kulso_id', nullif(v_it->>'nev',''),
            nullif(v_it->>'intezmeny',''), grants.orcid_norm(v_it->>'orcid'),
            nullif(v_it->>'mu_db','')::integer, nullif(v_it->>'idezet','')::integer,
            nullif(v_it->>'pontszam','')::numeric, coalesce(v_it->'indok', '{}'::jsonb),
            case when coalesce(v_it->>'orcid_egyezik','') = 'true'
                      and grants.nev_atfedes(v_it->>'nev', v_nev)
                 then 'megerositve' else 'javasolt' end)
    on conflict (researcher_id, forras, kulso_id) do update
       set nev = excluded.nev, intezmeny = excluded.intezmeny, orcid = excluded.orcid,
           mu_db = excluded.mu_db, idezet = excluded.idezet,
           pontszam = excluded.pontszam, indok = excluded.indok;
    v_uj := v_uj + 1;

    if coalesce(v_it->>'orcid_egyezik','') = 'true' then
      if grants.nev_atfedes(v_it->>'nev', v_nev) then
        v_auto := v_auto + 1;
        if p_forras = 'openalex' then
          update grants.researcher set openalex_id = v_it->>'kulso_id',
                 orcid = coalesce(orcid, grants.orcid_norm(v_it->>'orcid')), updated_at = now()
           where id = p_researcher and openalex_id is null;
        else
          update grants.researcher set mtmt_id = v_it->>'kulso_id', updated_at = now()
           where id = p_researcher and mtmt_id is null;
        end if;
      else
        -- ORCID egyezik, a név nem: ez adathiba valahol. Nem kötünk, jelezzük.
        v_konflikt := v_konflikt + 1;
        update grants.identity_candidate
           set indok = indok || jsonb_build_object('figyelmeztetes',
                 'Az ORCID egyezik, de a nevek nem fedik egymást — ellenőrizni kell.')
         where researcher_id = p_researcher and forras = p_forras and kulso_id = v_it->>'kulso_id';
      end if;
    end if;
  end loop;
  return jsonb_build_object('rogzitve', v_uj, 'orcid_alapjan_kotve', v_auto,
                            'orcid_nevkonfliktus', v_konflikt);
end $$;

do $grants2$
declare has_anon boolean := exists (select 1 from pg_roles where rolname='anon');
        has_auth boolean := exists (select 1 from pg_roles where rolname='authenticated');
        has_srv  boolean := exists (select 1 from pg_roles where rolname='service_role');
begin
  execute 'revoke all on function public.grants_candidates_upsert(uuid,text,jsonb) from public';
  if has_anon then execute 'revoke all on function public.grants_candidates_upsert(uuid,text,jsonb) from anon'; end if;
  if has_auth then execute 'revoke all on function public.grants_candidates_upsert(uuid,text,jsonb) from authenticated'; end if;
  if has_srv  then execute 'grant execute on function public.grants_candidates_upsert(uuid,text,jsonb) to service_role'; end if;
  execute 'revoke all on function grants.nev_atfedes(text,text) from public';
  if has_anon then execute 'revoke all on function grants.nev_atfedes(text,text) from anon'; end if;
  if has_auth then execute 'revoke all on function grants.nev_atfedes(text,text) from authenticated'; end if;
end $grants2$;

do $chk$
begin
  if has_function_privilege('anon', 'public.grants_discovered(text,text,text,integer,integer,integer)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a felderitesi listat.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.grants_discovered_upsert(text,jsonb)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: bejelentkezett felhasznalo is tolthet be felderitett szerzot.';
  end if;
  raise notice 'Rendben: 80 — felderites (discovered_author), forrasok: openalex, mtmt.';
end $chk$;
