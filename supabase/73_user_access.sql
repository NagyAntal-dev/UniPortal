-- ============================================================================
-- 73_user_access.sql — egyéni jogosultság és munkakör
--
-- MI VAN MÁR MEG
--   * szerepkör → menüpont            (39_role_admin.sql, role_permission)
--   * csoport   → menüpont            (38_student_groups.sql, group_permission)
--   Mindkettő CSAK ADHAT menüpontot; a menüszűrő utolsó szava a `false`.
--
-- MI ÚJ ITT
--   1. user_permission — EGY EMBERNEK adott plusz menüpont. Ugyanaz az elv:
--      csak ad, elvenni nem tud. Erre azért van szükség, mert egy kivételt ma
--      csak úgy lehet kezelni, hogy vagy az egész szerepkör kap egy menüpontot
--      (mindenki más is), vagy létre kell hozni egy egyfős csoportot.
--   2. user_job — MUNKAKÖR: beosztás, szervezeti egység, megjegyzés. Nem a
--      profiles táblába kerül, mert azt egy MÁSIK ALKALMAZÁS IS HASZNÁLJA
--      ebben a Supabase projektben (lásd 38_student_groups.sql indoklása).
--      A munkakör LEÍRÁS, nem jogosultság: önmagában semmit nem nyit meg.
--
-- KI ÍRHAT
--   * jogosultság (user_permission): SZUPERADMIN. Ugyanaz a kör, mint a
--     csoport- és szerepkör-jogosultságnál — ez az, amivel hozzáférést lehet
--     osztani, tehát nem mehet lejjebb.
--   * munkakör (user_job): admin is. Ez adminisztratív adat, nem hozzáférés.
--   * a SUPERADMIN saját sorát senki nem tudja „kiüresíteni”: a menüszűrő a
--     szuperadminnál a táblákat meg sem nézi (39), itt is tiltjuk a felvitelt,
--     hogy ne keletkezzen félrevezető, hatástalan bejegyzés.
--
-- KI OLVASHAT
--   * a SAJÁT jogait és munkakörét mindenki (a felület ebből építi a menüt);
--   * a teljes listát az admin (a „Jogosultságok” képernyő).
--
-- FÜGGŐSÉG: 07 (is_approved), 11 (is_admin, is_superadmin, my_role),
--           38_student_groups, 39_role_admin.
-- IDEMPOTENS: igen.
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.is_superadmin()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'ELOFELTETEL: hianyzik az is_superadmin / is_admin (07, 11).';
  end if;
  if to_regclass('public.role_permission') is null then
    raise exception 'ELOFELTETEL: hianyzik a 39_role_admin.sql.';
  end if;
  if to_regclass('public.group_permission') is null then
    raise exception 'ELOFELTETEL: hianyzik a 38_student_groups.sql.';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1) Táblák
-- ---------------------------------------------------------------------------
create table if not exists public.user_permission (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  permission text not null,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  primary key (profile_id, permission),
  constraint user_permission_shape_ck check (permission ~ '^[a-z0-9_]{2,40}$')
);
create index if not exists user_permission_profile_idx on public.user_permission (profile_id);

comment on table public.user_permission is
  'Egy embernek adott PLUSZ menüpont (73). Csak ad, elvenni nem tud — a '
  'menüszűrő utolsó szava a tiltás.';

create table if not exists public.user_job (
  profile_id        uuid primary key references public.profiles(id) on delete cascade,
  munkakor          text,
  szervezeti_egyseg text,
  megjegyzes        text,
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);

comment on table public.user_job is
  'Munkakör és szervezeti egység (73). LEÍRÁS, nem jogosultság: önmagában '
  'egyetlen képernyőt sem nyit meg.';

-- ---------------------------------------------------------------------------
-- 2) Sorszintű biztonság — a saját sort mindenki látja, a többit az admin
-- ---------------------------------------------------------------------------
alter table public.user_permission enable row level security;
alter table public.user_job        enable row level security;

drop policy if exists up_select on public.user_permission;
create policy up_select on public.user_permission for select
  using (public.is_admin() or public.is_superadmin() or profile_id = auth.uid());
drop policy if exists up_write on public.user_permission;
create policy up_write on public.user_permission for all
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists uj_select on public.user_job;
create policy uj_select on public.user_job for select
  using (public.is_staff() or profile_id = auth.uid());
drop policy if exists uj_write on public.user_job;
create policy uj_write on public.user_job for all
  using (public.is_admin() or public.is_superadmin())
  with check (public.is_admin() or public.is_superadmin());

grant select on public.user_permission, public.user_job to authenticated;

-- ---------------------------------------------------------------------------
-- 3) A saját plusz jogaim — ezt hívja a felület a menü felépítéséhez
-- ---------------------------------------------------------------------------
create or replace function public.my_user_permissions()
returns text[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select array_agg(permission order by permission)
                     from public.user_permission where profile_id = auth.uid()), '{}'::text[])
$$;

-- ---------------------------------------------------------------------------
-- 4) A képernyő listája: ki, milyen szerepkörrel, munkakörrel, jogokkal
-- ---------------------------------------------------------------------------
create or replace function public.access_user_list(
  p_q text default null, p_szerep text default null, p_limit int default 100, p_offset int default 0
) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_q    text := nullif(btrim(coalesce(p_q, '')), '');
  v_sz   text := nullif(btrim(coalesce(p_szerep, '')), '');
  v_lim  int  := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off  int  := greatest(coalesce(p_offset, 0), 0);
  v_ossz int;
  v_out  jsonb;
begin
  if auth.uid() is null then raise exception 'ACC_NOT_AUTHENTICATED'; end if;
  if not (public.is_admin() or public.is_superadmin()) then raise exception 'ACC_FORBIDDEN'; end if;

  select count(*) into v_ossz
    from public.profiles p
    left join public.user_job j on j.profile_id = p.id
   where (v_sz is null or coalesce(p.role, '') = v_sz)
     and (v_q is null or p.email ilike '%'||v_q||'%' or coalesce(p.name, '') ilike '%'||v_q||'%'
          or coalesce(j.munkakor, '') ilike '%'||v_q||'%');

  select coalesce(jsonb_agg(x order by x->>'nev'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'id', p.id, 'nev', coalesce(nullif(p.name, ''), p.email), 'email', p.email,
             'szerep', p.role, 'allapot', p.approval_status,
             'munkakor', j.munkakor, 'szervezeti_egyseg', j.szervezeti_egyseg,
             'csoportok', coalesce((select array_agg(g.nev order by g.nev)
                                      from public.groups_of(p.id) g), '{}'::text[]),
             'egyeni_jog_db', (select count(*) from public.user_permission u where u.profile_id = p.id)) as x
      from public.profiles p
      left join public.user_job j on j.profile_id = p.id
     where (v_sz is null or coalesce(p.role, '') = v_sz)
       and (v_q is null or p.email ilike '%'||v_q||'%' or coalesce(p.name, '') ilike '%'||v_q||'%'
            or coalesce(j.munkakor, '') ilike '%'||v_q||'%')
     order by coalesce(nullif(p.name, ''), p.email)
     limit v_lim offset v_off
  ) s;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_out),
                            'hatar', v_lim, 'eltolas', v_off, 'sorok', v_out);
end $$;

-- ---------------------------------------------------------------------------
-- 5) Egy ember hozzáférése — honnan mit kap
--    A 'honnan' a lényeg: ugyanaz a menüpont jöhet a szerepkörből, a
--    csoportból és egyénileg is. Aki nem látja, MIÉRT van joga, az vagy
--    feleslegesen ad újat, vagy hiába vesz el.
-- ---------------------------------------------------------------------------
create or replace function public.access_user_get(p_profile uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_p     public.profiles%rowtype;
  v_j     public.user_job%rowtype;
  v_szerep text[];
  v_csop  jsonb;
  v_egyeni text[];
begin
  if auth.uid() is null then raise exception 'ACC_NOT_AUTHENTICATED'; end if;
  if not (public.is_admin() or public.is_superadmin()) then raise exception 'ACC_FORBIDDEN'; end if;

  select * into v_p from public.profiles where id = p_profile;
  if not found then raise exception 'ACC_NOT_FOUND'; end if;
  select * into v_j from public.user_job where profile_id = p_profile;

  select coalesce(array_agg(rp.permission order by rp.permission), '{}'::text[]) into v_szerep
    from public.role_permission rp
    join public.role_definition rd on rd.kod = rp.role_kod and rd.aktiv
   where rp.role_kod = v_p.role;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'nev', g.nev, 'tipus', g.tipus,
           'jogok', coalesce((select array_agg(gp.permission order by gp.permission)
                                from public.group_permission gp where gp.group_id = g.id), '{}'::text[]))
         order by g.nev), '[]'::jsonb) into v_csop
    from public.groups_of(p_profile) g;

  select coalesce(array_agg(permission order by permission), '{}'::text[]) into v_egyeni
    from public.user_permission where profile_id = p_profile;

  return jsonb_build_object(
    'profil', jsonb_build_object('id', v_p.id, 'nev', coalesce(nullif(v_p.name, ''), v_p.email),
                'email', v_p.email, 'szerep', v_p.role, 'allapot', v_p.approval_status,
                'regisztralt', v_p.created_at),
    'munkakor', jsonb_build_object('munkakor', v_j.munkakor, 'szervezeti_egyseg', v_j.szervezeti_egyseg,
                'megjegyzes', v_j.megjegyzes, 'frissitve', v_j.updated_at),
    'szerep_jogok', v_szerep,
    'csoportok', v_csop,
    'egyeni_jogok', v_egyeni,
    -- A szuperadminnál a menüszűrő ezeket a táblákat meg sem nézi: mindent lát.
    'mindent_lat', (v_p.role = 'SUPERADMIN'));
end $$;

-- ---------------------------------------------------------------------------
-- 6) Egyéni jog adása / elvétele — SZUPERADMIN
-- ---------------------------------------------------------------------------
create or replace function public.access_user_permission_set(
  p_profile uuid, p_permission text, p_ad boolean
) returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare v_role text;
begin
  if auth.uid() is null then raise exception 'ACC_NOT_AUTHENTICATED'; end if;
  if not public.is_superadmin() then raise exception 'ACC_FORBIDDEN: egyeni jogot csak szuperadmin allithat.'; end if;
  if coalesce(p_permission, '') !~ '^[a-z0-9_]{2,40}$' then raise exception 'ACC_BAD_PERMISSION'; end if;

  select role into v_role from public.profiles where id = p_profile;
  if v_role is null then raise exception 'ACC_NOT_FOUND'; end if;
  -- A szuperadmin úgyis mindent lát: a bejegyzés hatástalan lenne, és azt a
  -- látszatot keltené, hogy az elvételével korlátozható.
  if v_role = 'SUPERADMIN' then raise exception 'ACC_SUPERADMIN_FIX: a szuperadmin hozzaferese nem allithato.'; end if;

  if coalesce(p_ad, false) then
    insert into public.user_permission (profile_id, permission, granted_by)
    values (p_profile, p_permission, auth.uid())
    on conflict (profile_id, permission) do nothing;
  else
    delete from public.user_permission where profile_id = p_profile and permission = p_permission;
  end if;

  return public.access_user_get(p_profile);
end $$;

-- ---------------------------------------------------------------------------
-- 7) Munkakör mentése — admin is
--    NULL = „ne változtass”, üres szöveg = „töröld” (a 40-es migráció elve).
-- ---------------------------------------------------------------------------
create or replace function public.access_user_job_set(
  p_profile uuid, p_munkakor text default null,
  p_szervezeti_egyseg text default null, p_megjegyzes text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'ACC_NOT_AUTHENTICATED'; end if;
  if not (public.is_admin() or public.is_superadmin()) then raise exception 'ACC_FORBIDDEN'; end if;
  if not exists (select 1 from public.profiles where id = p_profile) then raise exception 'ACC_NOT_FOUND'; end if;

  insert into public.user_job (profile_id, munkakor, szervezeti_egyseg, megjegyzes, updated_by)
  values (p_profile, nullif(btrim(coalesce(p_munkakor, '')), ''),
                     nullif(btrim(coalesce(p_szervezeti_egyseg, '')), ''),
                     nullif(btrim(coalesce(p_megjegyzes, '')), ''), auth.uid())
  on conflict (profile_id) do update
    set munkakor          = case when p_munkakor is null then public.user_job.munkakor
                                 else nullif(btrim(p_munkakor), '') end,
        szervezeti_egyseg = case when p_szervezeti_egyseg is null then public.user_job.szervezeti_egyseg
                                 else nullif(btrim(p_szervezeti_egyseg), '') end,
        megjegyzes        = case when p_megjegyzes is null then public.user_job.megjegyzes
                                 else nullif(btrim(p_megjegyzes), '') end,
        updated_by = auth.uid(), updated_at = now();

  return public.access_user_get(p_profile);
end $$;

-- ---------------------------------------------------------------------------
-- 8) Munkakör-javaslatok a beviteli mezőhöz (ami már elő szokott fordulni)
-- ---------------------------------------------------------------------------
create or replace function public.access_job_options()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then raise exception 'ACC_NOT_AUTHENTICATED'; end if;
  if not (public.is_admin() or public.is_superadmin()) then raise exception 'ACC_FORBIDDEN'; end if;
  select jsonb_build_object(
    'munkakor', (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                   from (select munkakor v, count(*) n from public.user_job
                          where munkakor is not null group by 1) t),
    'szervezeti_egyseg', (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                   from (select szervezeti_egyseg v, count(*) n from public.user_job
                          where szervezeti_egyseg is not null group by 1) t),
    'szerep', (select coalesce(jsonb_agg(jsonb_build_object('ertek', v, 'db', n) order by n desc), '[]'::jsonb)
                   from (select role v, count(*) n from public.profiles where role is not null group by 1) t)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 9) Jogosultságok
-- ---------------------------------------------------------------------------
revoke all on function public.my_user_permissions()                            from public, anon;
revoke all on function public.access_user_list(text, text, int, int)           from public, anon;
revoke all on function public.access_user_get(uuid)                            from public, anon;
revoke all on function public.access_user_permission_set(uuid, text, boolean)  from public, anon;
revoke all on function public.access_user_job_set(uuid, text, text, text)      from public, anon;
revoke all on function public.access_job_options()                             from public, anon;
grant execute on function public.my_user_permissions()                            to authenticated;
grant execute on function public.access_user_list(text, text, int, int)           to authenticated;
grant execute on function public.access_user_get(uuid)                            to authenticated;
grant execute on function public.access_user_permission_set(uuid, text, boolean)  to authenticated;
grant execute on function public.access_user_job_set(uuid, text, text, text)      to authenticated;
grant execute on function public.access_job_options()                             to authenticated;

do $chk$
begin
  if has_function_privilege('anon', 'public.access_user_list(text, text, int, int)', 'execute')
     or has_function_privilege('anon', 'public.access_user_permission_set(uuid, text, boolean)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a jogosultsag-kezelo fuggvenyeket.';
  end if;
  raise notice 'Rendben: 73 — egyeni jogosultsag (user_permission) es munkakor (user_job).';
end $chk$;
