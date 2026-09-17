-- ============================================================
-- UniPortal Pro — A regisztráció nem választhat magának szerepkört
--
-- MIÉRT:
--   A 07-es (és az azt felülíró 29-es) migráció handle_new_user() triggere
--   így vette át a szerepkört:
--
--       wanted_role := upper(coalesce(new.raw_user_meta_data->>'role', 'STUDENT'));
--
--   A raw_user_meta_data teljes egészében a kliens kezében van: ez az
--   auth.signUp() options.data mezője (index.html, "meta" objektum). Nincs
--   se engedélyezett lista, se CHECK megszorítás a profiles.role oszlopon,
--   tehát egy
--
--       POST /auth/v1/signup  {"data": {"role": "SUPERADMIN"}}
--
--   kérés a profiles.role oszlopba 'SUPERADMIN'-t ír.
--
--   Önmagában ez még nem ad jogot: a has_role() approval_status='approved'-ot
--   is kér, az új fiók pedig 'pending'. A kört a jóváhagyó felület zárja be:
--   a regisztrációs sorban a szerepkör-választó ALAPÉRTELMEZÉSE a kért
--   szerepkör, és van egy kattintásos "jóváhagyás a kért szerepkörrel" gomb.
--   Aki végigpörgeti a sort, észrevétlenül oszt ki SUPERADMIN jogot.
--
--   Ugyanez áll az "agencyId" mezőre: egy hallgatói regisztráció előre
--   ráköthette magát egy létező ügynökségre, és jóváhagyás után a my_agency()
--   azt az ügynökséget adta vissza — azzal együtt minden ügynöki RLS-szabály.
--
-- MIT CSINÁL:
--   1. A handle_new_user() a kért szerepkört a ('STUDENT','AGENT') listára
--      szorítja. A KÉRT érték nem vész el: a requested_role oszlopba kerül,
--      ahol a jóváhagyó látja — ott adat, nem jogosultság.
--   2. Az "agencyId" mezőt csak ÜGYNÖKI regisztrációnál veszi át.
--   3. A profiles.role oszlopra idegenkulcsot tesz a role_definition(kod)
--      táblára, NOT VALID módon. A NOT VALID a MEGLÉVŐ sorokat békén hagyja
--      (a demó adatokban lehet ismeretlen szerepkör), az ÚJ beszúrásokat és
--      módosításokat viszont ellenőrzi. Azért idegenkulcs és nem CHECK, mert
--      a 39-es migráció szándékosan bővíthetővé tette a szerepkörlistát.
--
--   A törzs egyébként BETŰRE azonos a 29-es migrációéval — csak a szerepkör
--   és az ügynökség-azonosító átvétele változott.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt),
--   vagy: Supabase dashboard → SQL Editor → New query → beilleszt → Run
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. a sign-up trigger ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wanted_role text;
  requested   text;
  is_super    boolean;
  ag_id       text;
  ag_name     text;
  ag_countries text[];
begin
  is_super    := lower(new.email) = public.superadmin_email();

  -- A raw_user_meta_data a KLIENSTŐL jön (auth.signUp options.data), tehát
  -- szabadon választható: ide bármit be lehet írni, 'SUPERADMIN'-t is.
  -- Önregisztrálni csak jelentkezőként vagy ügynökként lehet, minden más
  -- kérésből STUDENT lesz. A KÉRT szerepkör a requested_role oszlopban marad
  -- meg — ott adat, amit a jóváhagyó lát, nem pedig jogosultság.
  requested   := upper(coalesce(new.raw_user_meta_data->>'role', 'STUDENT'));
  wanted_role := case when requested in ('STUDENT', 'AGENT') then requested else 'STUDENT' end;

  -- Az ügynökség-azonosítót csak ÜGYNÖKI regisztrációnál vesszük át. Enélkül
  -- egy hallgatói regisztráció előre ráköthetné magát egy létező ügynökségre,
  -- és jóváhagyás után a my_agency() azt az ügynökséget adná vissza.
  ag_id       := case when wanted_role = 'AGENT'
                      then nullif(new.raw_user_meta_data->>'agencyId', '')
                      else null end;

  -- Önregisztráló ügynök, aki NEM egy meglévő ügynökséghez csatlakozik:
  -- neki nyitunk egy függőben lévő ügynökség-sort.
  if wanted_role = 'AGENT' and not is_super and ag_id is null then
    ag_name := nullif(trim(coalesce(new.raw_user_meta_data->>'agencyName', '')), '');
    if ag_name is null then
      ag_name := coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));
    end if;

    -- 'countries_of_recruitment': tömb vagy vesszős lista is jöhet.
    begin
      if jsonb_typeof(new.raw_user_meta_data->'agencyCountries') = 'array' then
        select coalesce(array_agg(trim(v)), '{}')
          into ag_countries
          from jsonb_array_elements_text(new.raw_user_meta_data->'agencyCountries') v
         where trim(v) <> '';
      else
        select coalesce(array_agg(trim(v)), '{}')
          into ag_countries
          from unnest(string_to_array(coalesce(new.raw_user_meta_data->>'agencyCountries', ''), ',')) v
         where trim(v) <> '';
      end if;
    exception when others then
      ag_countries := '{}';
    end;

    ag_id := 'AG-' || substr(md5(new.id::text), 1, 10);
  end if;

  -- A SORREND KÖTÖTT, és mérésből tanultuk meg: az agencies."requested_by"
  -- a profiles(id)-ra mutat, tehát a PROFIL SORNAK ELŐBB kell megszületnie.
  -- Fordított sorrendben az idegenkulcs azonnal eldobja az egész
  -- önregisztrációt ("agencies_requested_by_fkey"), és az ügynök egyáltalán
  -- nem tud regisztrálni. A profiles."agencyId" nem idegenkulcs, ezért
  -- előre beírható a még nem létező ügynökség azonosítója.
  insert into public.profiles (id, email, name, role, requested_role, "agencyId", approval_status, approved_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    case when is_super then 'SUPERADMIN' else wanted_role end,
    requested,
    ag_id,
    case when is_super then 'approved' else 'pending' end,
    case when is_super then now() else null end
  )
  on conflict (id) do nothing;

  -- Most már van mire hivatkoznia a requested_by-nak.
  if ag_name is not null then
    insert into public."agencies"
      (id, name, "commissionRate", "contactPerson", email, status,
       "country_of_origin", "countries_of_recruitment",
       "approval_status", "requested_by", "requested_at", "self_registered")
    values
      (ag_id, ag_name, 0,
       coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
       new.email, 'Pending',
       nullif(trim(coalesce(new.raw_user_meta_data->>'agencyCountry', '')), ''),
       coalesce(ag_countries, '{}'),
       'pending', new.id, now(), true)
    on conflict (id) do nothing;
  end if;

  return new;
end $$;

-- ---------- 2. a szerepkör csak létező szerepkör lehet ----------
-- NOT VALID: a meglévő sorokat nem bántja (a demó adatokban lehet olyan
-- szerepkör, ami nincs a role_definition-ben), az újakat viszont ellenőrzi.
-- Ha egyszer kiderül, hogy minden sor rendben van, a megszorítás
-- véglegesíthető:  alter table public.profiles validate constraint profiles_role_fkey;
do $blk$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_role_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_role_fkey
      foreign key (role) references public.role_definition(kod)
      on update cascade
      not valid;
    raise notice 'Rendben: profiles.role -> role_definition(kod) idegenkulcs felveve (NOT VALID).';
  end if;
exception when others then
  -- Ha a role_definition meg nem letezik (regi adatbazis), ne alljon meg a
  -- migracio: a tenyleges vedelmet az 1. pont clampje adja.
  raise warning 'A profiles.role idegenkulcs nem jott letre: %', sqlerrm;
end $blk$;

-- ---------- 3. ellenőrzés ----------
do $blk$
declare
  src text;
begin
  select prosrc into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'handle_new_user';

  if src is null then
    raise exception 'BIZTONSAGI HIBA: nincs handle_new_user fuggveny.';
  end if;
  if src not like '%in (''STUDENT'', ''AGENT'')%' then
    raise exception 'BIZTONSAGI HIBA: a handle_new_user nem szoritja a kert szerepkort STUDENT/AGENT-re.';
  end if;
  if src like '%wanted_role := upper(coalesce(new.raw_user_meta_data->>''role''%' then
    raise exception 'BIZTONSAGI HIBA: a handle_new_user meg mindig kozvetlenul veszi at a kliens szerepkoret.';
  end if;

  raise notice 'Rendben: a regisztracio csak STUDENT vagy AGENT szerepkort kerhet, a kert ertek a requested_role oszlopban marad.';
end $blk$;
