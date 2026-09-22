-- ============================================================================
-- RUN_ALL_73_74.sql — UniPortal · 2026-09-22
--
-- EGYBEN, EBBEN A SORRENDBEN futtatandó a Supabase SQL Editorban. Az élő
-- adatbázison 2026-09-22-én ellenőrizve: a 72-esig minden telepítve van,
-- a 73 és a 74 hiányzik.
--
--   1) 73_user_access.sql          Rendszer → Jogosultságok: egyéni menüjog
--                                  (user_permission) és munkakör (user_job)
--   2) 74_webshop.sql              Webshop: termékek, rendelés, jóváhagyás,
--                                  banki átutalás (NJE-WS közlemény), számla-
--                                  szám, visszatérítés; online fizetés
--                                  visszaigazolása csak szerveroldalról
--   3) 21_echo_harden_submit.sql   ÚJRA — ez mindig az utolsó
--
-- MIÉRT A 21 AZ UTOLSÓ
--   A Supabase alapértelmezett jogosztása MINDEN új public függvényt megnyit az
--   authenticated (és anon) szerepnek. Ha a 21 nem fut le a többi UTÁN, az
--   echo_submit újra hívhatóvá válik közvetlenül, és a kurzusértékelés
--   válaszai elveszítik a névtelenségüket.
--
-- ELŐFELTÉTEL
--   A 74 a 69-es (hírfolyam célközönség) szabályát használja — élesben megvan.
--
-- TUDNIVALÓK
--   * Minden rész IDEMPOTENS: újra lefuttatva sem változtat adatot.
--   * Nincs benne psql-parancs és tranzakciókezelés, a teljes tartalom
--     bemásolható az SQL Editorba.
--   * A futás végén „Rendben: 73 …”, „Rendben: 74 …” NOTICE-okat kell látni.
--   * Ha bármelyik rész hibával áll meg, a következők nem futnak le —
--     javítás után onnan folytatható.
--   * NEM része ennek a fájlnak a 12_rbac_flip.sql: az szándékos, külön döntés.
--
-- A fájl a három migráció szó szerinti tartalmát fűzi egybe; forrás:
--   supabase/73_user_access.sql, supabase/74_webshop.sql,
--   supabase/21_echo_harden_submit.sql
-- ============================================================================


-- ==========================================================================
--  1/3 — Egyéni jogosultság és munkakör
--  forrás: supabase/73_user_access.sql
-- ==========================================================================

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

-- ==========================================================================
--  2/3 — Webshop
--  forrás: supabase/74_webshop.sql
-- ==========================================================================

-- ============================================================================
-- 74_webshop.sql — egyetemi webshop (termékek, jegyzetek, parkolókártya)
--
-- MIT AD
--   Hallgatói oldal: katalógus, kosár, rendelés, rendeléseim, letöltés.
--   Ügyintézői oldal: termékek és kategóriák karbantartása, rendelések,
--   jóváhagyások (pl. parkolókártya), fizetés rögzítése, státuszok, számlaszám,
--   visszatérítés, eseménynapló, beállítások (banki adatok).
--
-- AZ ALAPELVEK
--   1. Az ÁR a szerveré. A kosárból csak termékazonosító és mennyiség jön; az
--      árat, az áfát és a nevet a rendelés pillanatában a termék sorából
--      vesszük, és a rendelési tételre MÁSOLJUK (pillanatkép). Egy későbbi
--      árváltozás így nem írja át a már leadott rendelést.
--   2. A készlet foglalás atomi: egyetlen UPDATE ... WHERE keszlet >= menny.
--      Két egyidejű rendelés nem tudja ugyanazt az utolsó darabot megvenni.
--   3. JÓVÁHAGYÁS A FIZETÉS ELŐTT. Ha egy tétel jóváhagyáshoz kötött (pl.
--      parkolókártya), a rendelés 'jovahagyasra_var' állapotban indul, és csak
--      a döntés után lesz fizethető. Így elutasításnál nincs visszatérítés.
--   4. A fizetés CSERÉLHETŐ réteg:
--        * 'atutalas' — közleményes banki átutalás az MBH-s számlára, a
--          közleményt (NJE-WS-00012-cc) a pénzügy veti össze a kivonattal;
--        * 'kartya' / 'qvik' — online szolgáltató (MBH VPOS, SimplePay,
--          Barion …). A visszaigazolást a szolgáltató szerveroldali
--          értesítése hozza egy Edge Function-ön át, amely az aláírást
--          ellenőrzi, majd a shop_payment_confirm()-ot hívja. Ez a függvény
--          CSAK a service_role-nak hívható — böngészőből nem lehet „fizetettnek”
--          jelölni egy rendelést.
--      Amíg a szolgáltatói szerződés nincs meg, a kártyás mód a beállításokban
--      KI van kapcsolva, és a felület nem is kínálja fel.
--   5. SZÁMLA: a webshop NEM állít ki számlát. Egy egyetemnek a számlát a
--      NAV Online Számla rendszerhez bekötött számlázó állítja ki (gazdasági
--      rendszer vagy számlázó szolgáltatás). A webshop a kiállított számla
--      SZÁMÁT és hivatkozását tárolja, és mutatja a vevőnek.
--
-- A KÖZLEMÉNY
--   NJE-WS-<5 jegyű rendelésszám>-<2 jegyű ellenőrző>. Az ellenőrző ugyanaz a
--   mod-97 képlet, mint a felvételi NJE-FV közleményénél — egy elgépelt számjegy
--   így a kivonat összevetésénél kiderül.
--
-- JOGOSULTSÁG
--   Vásárolni minden jóváhagyott fiók tud (az ügynök kivételével).
--   Kezelni: SUPERADMIN, ADMIN, FINANCE (shop.is_manager()).
--   A shop séma táblái közvetlenül nem érhetők el; minden a függvényeken át megy.
--
-- FÜGGŐSÉG: 07 (is_approved), 11 (has_role, my_role), 69 (feed_audience_match —
--           a termék célközönségéhez, ugyanaz a szabály, mint a hírfolyamé).
-- IDEMPOTENS: igen.
-- UTÁNA: a 21_echo_harden_submit.sql újrafuttatása (a szokásos szabály szerint).
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.has_role(text[])') is null or to_regprocedure('public.is_approved()') is null then
    raise exception 'ELOFELTETEL: hianyzik a has_role / is_approved (07, 11).';
  end if;
  if to_regprocedure('public.feed_audience_match(jsonb,uuid)') is null then
    raise exception 'ELOFELTETEL: eloszor a 69_feed_audience.sql-t kell lefuttatni (celkozonseg-szabaly).';
  end if;
end $pre$;

create schema if not exists shop;
revoke all on schema shop from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1) Táblák
-- ---------------------------------------------------------------------------
create table if not exists shop.setting (
  kulcs      text primary key,
  ertek      jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

insert into shop.setting (kulcs, ertek) values
  ('bank',     '{"kedvezmenyezett": null, "bank": "MBH Bank Nyrt.", "szamlaszam": null, "iban": null}'::jsonb),
  ('kartya',   '{"aktiv": false, "szolgaltato": null, "megjegyzes": "Szolgáltatói szerződés és Edge Function kell hozzá."}'::jsonb),
  ('qvik',     '{"aktiv": false}'::jsonb),
  ('fizetes',  '{"hatarido_nap": 8}'::jsonb),
  ('szamlazas','{"mod": "kezi", "megjegyzes": "A számlát a gazdasági rendszer állítja ki; a webshop a számla számát tárolja."}'::jsonb)
on conflict (kulcs) do nothing;

create table if not exists shop.category (
  id       uuid primary key default gen_random_uuid(),
  nev      text not null,
  leiras   text,
  sorrend  int not null default 100,
  aktiv    boolean not null default true,
  created_at timestamptz not null default now(),
  constraint shop_category_nev_uniq unique (nev)
);

create table if not exists shop.product (
  id              uuid primary key default gen_random_uuid(),
  sku             text,
  nev             text not null,
  leiras          text,
  category_id     uuid references shop.category(id) on delete set null,
  tipus           text not null default 'fizikai'
                    check (tipus in ('fizikai', 'digitalis', 'parkolokartya', 'szolgaltatas')),
  ar_huf          integer not null check (ar_huf >= 0),
  afa_kulcs       text not null default '27' check (afa_kulcs in ('27', '18', '5', '0', 'AAM', 'TAM')),
  keszlet         integer check (keszlet is null or keszlet >= 0),   -- NULL = korlátlan
  max_rendelesenkent integer check (max_rendelesenkent is null or max_rendelesenkent > 0),
  jovahagyas_kell boolean not null default false,
  -- A vásárláskor bekérendő adatok, pl. parkolókártyánál a rendszám:
  --   [{"kulcs":"rendszam","cimke":"Rendszám","kotelezo":true,"tipus":"rendszam"}]
  mezok           jsonb not null default '[]'::jsonb,
  kep_url         text,
  fajl_utvonal    text,        -- digitális terméknél a shop-files tárolóban
  celkozonseg     jsonb,       -- NULL = mindenki (ugyanaz a szabály, mint a hírfolyamnál)
  aktiv           boolean not null default true,
  sorrend         int not null default 100,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists shop_product_sku_uidx on shop.product (sku) where sku is not null;

create table if not exists shop.orders (
  id                 uuid primary key default gen_random_uuid(),
  ref_no             bigint generated by default as identity,
  vevo               uuid not null references public.profiles(id) on delete restrict,
  vevo_email         text,
  vevo_nev           text,
  szamlazasi_adatok  jsonb not null default '{}'::jsonb,
  osszeg_huf         integer not null default 0,
  allapot            text not null default 'fizetesre_var'
                       check (allapot in ('jovahagyasra_var', 'fizetesre_var', 'fizetve', 'teljesitve',
                                          'lemondva', 'elutasitva', 'visszaterites', 'visszateritve')),
  fizetesi_mod       text not null default 'atutalas' check (fizetesi_mod in ('atutalas', 'kartya', 'qvik', 'kezi')),
  fizetesi_kozlemeny text,
  fizetesi_hatarido  timestamptz,
  fizetve_at         timestamptz,
  kulso_azonosito    text,        -- szolgáltatói tranzakció vagy banki hivatkozás
  szamla_szam        text,
  szamla_url         text,
  megjegyzes         text,        -- ügyintézői belső megjegyzés
  vevo_megjegyzes    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists shop_orders_ref_uidx on shop.orders (ref_no);
create index if not exists shop_orders_vevo_idx on shop.orders (vevo);
create index if not exists shop_orders_allapot_idx on shop.orders (allapot);

create table if not exists shop.order_item (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references shop.orders(id) on delete cascade,
  product_id   uuid references shop.product(id) on delete set null,
  nev          text not null,
  tipus        text not null,
  egysegar_huf integer not null,
  afa_kulcs    text not null,
  mennyiseg    integer not null check (mennyiseg > 0),
  adatok       jsonb not null default '{}'::jsonb,
  jovahagyas   text check (jovahagyas is null or jovahagyas in ('var', 'jovahagyva', 'elutasitva')),
  dontotte     uuid,
  dontes_at    timestamptz,
  indoklas     text
);
create index if not exists shop_order_item_order_idx on shop.order_item (order_id);

create table if not exists shop.order_event (
  id        bigint generated by default as identity primary key,
  order_id  uuid not null references shop.orders(id) on delete cascade,
  tipus     text not null,
  reszletek jsonb not null default '{}'::jsonb,
  ki        uuid,
  mikor     timestamptz not null default now()
);
create index if not exists shop_order_event_order_idx on shop.order_event (order_id);

create table if not exists shop.payment (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references shop.orders(id) on delete restrict,
  szolgaltato     text not null,
  osszeg_huf      integer not null,
  allapot         text not null check (allapot in ('sikeres', 'sikertelen', 'visszaterites')),
  kulso_azonosito text,
  nyers           jsonb,
  created_at      timestamptz not null default now()
);
create unique index if not exists shop_payment_kulso_uidx on shop.payment (szolgaltato, kulso_azonosito)
  where kulso_azonosito is not null;

revoke all on all tables in schema shop from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Segédek
-- ---------------------------------------------------------------------------
create or replace function shop.is_manager()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_role('SUPERADMIN', 'ADMIN', 'FINANCE')
$$;

create or replace function shop.kozlemeny(p_ref bigint)
returns text language sql immutable set search_path = pg_temp as $$
  select 'NJE-WS-' || lpad(p_ref::text, 5, '0') || '-' || lpad((98 - ((p_ref * 100) % 97))::text, 2, '0')
$$;

create or replace function shop.naplo(p_order uuid, p_tipus text, p_reszletek jsonb default '{}'::jsonb)
returns void language sql volatile security definer set search_path = shop, public, pg_temp as $$
  insert into shop.order_event (order_id, tipus, reszletek, ki) values (p_order, p_tipus, coalesce(p_reszletek, '{}'::jsonb), auth.uid())
$$;

create or replace function shop.lathato(p_aud jsonb)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_aud is null or shop.is_manager() or public.feed_audience_match(p_aud, auth.uid())
$$;

-- Egy rendelés teljes képe (tételek, események nélkül / eseményekkel)
create or replace function shop.order_json(p_order uuid, p_esemenyek boolean default false)
returns jsonb language sql stable security definer set search_path = shop, public, pg_temp as $$
  select jsonb_build_object(
    'id', o.id, 'ref_no', o.ref_no, 'rendelesszam', 'WS-' || lpad(o.ref_no::text, 5, '0'),
    'vevo', o.vevo, 'vevo_email', o.vevo_email, 'vevo_nev', o.vevo_nev,
    'szamlazasi_adatok', o.szamlazasi_adatok, 'osszeg_huf', o.osszeg_huf,
    'allapot', o.allapot, 'fizetesi_mod', o.fizetesi_mod,
    'fizetesi_kozlemeny', o.fizetesi_kozlemeny, 'fizetesi_hatarido', o.fizetesi_hatarido,
    'fizetve_at', o.fizetve_at, 'kulso_azonosito', o.kulso_azonosito,
    'szamla_szam', o.szamla_szam, 'szamla_url', o.szamla_url,
    'vevo_megjegyzes', o.vevo_megjegyzes,
    'megjegyzes', case when shop.is_manager() then o.megjegyzes else null end,
    'created_at', o.created_at, 'updated_at', o.updated_at,
    'tetelek', coalesce((select jsonb_agg(jsonb_build_object(
                   'id', i.id, 'product_id', i.product_id, 'nev', i.nev, 'tipus', i.tipus,
                   'egysegar_huf', i.egysegar_huf, 'afa_kulcs', i.afa_kulcs, 'mennyiseg', i.mennyiseg,
                   'adatok', i.adatok, 'jovahagyas', i.jovahagyas, 'dontes_at', i.dontes_at, 'indoklas', i.indoklas,
                   'letoltheto', (i.tipus = 'digitalis' and o.allapot in ('fizetve', 'teljesitve')
                                  and coalesce(i.jovahagyas, 'jovahagyva') = 'jovahagyva'
                                  and exists (select 1 from shop.product p where p.id = i.product_id and p.fajl_utvonal is not null)))
                 order by i.nev) from shop.order_item i where i.order_id = o.id), '[]'::jsonb),
    'esemenyek', case when p_esemenyek then
                   coalesce((select jsonb_agg(jsonb_build_object('tipus', e.tipus, 'reszletek', e.reszletek, 'mikor', e.mikor,
                               'ki', (select coalesce(nullif(pr.name, ''), pr.email) from public.profiles pr where pr.id = e.ki))
                             order by e.mikor desc, e.id desc) from shop.order_event e where e.order_id = o.id), '[]'::jsonb)
                 else null end)
  from shop.orders o where o.id = p_order
$$;

-- A készlet visszaadása (lemondás, elutasítás)
create or replace function shop.keszlet_vissza(p_item uuid)
returns void language plpgsql volatile security definer set search_path = shop, public, pg_temp as $$
declare i shop.order_item%rowtype;
begin
  select * into i from shop.order_item where id = p_item;
  if i.product_id is not null then
    update shop.product set keszlet = keszlet + i.mennyiseg where id = i.product_id and keszlet is not null;
  end if;
end $$;

-- A rendelés összegének újraszámolása (az elutasított tételek nélkül)
create or replace function shop.osszeg_ujra(p_order uuid)
returns integer language sql volatile security definer set search_path = shop, public, pg_temp as $$
  update shop.orders o
     set osszeg_huf = coalesce((select sum(i.egysegar_huf * i.mennyiseg) from shop.order_item i
                                 where i.order_id = o.id and coalesce(i.jovahagyas, '') <> 'elutasitva'), 0),
         updated_at = now()
   where o.id = p_order
  returning osszeg_huf
$$;

-- ---------------------------------------------------------------------------
-- 3) HALLGATÓI függvények
-- ---------------------------------------------------------------------------
create or replace function public.shop_catalog()
returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then raise exception 'SHOP_NOT_AUTHENTICATED'; end if;
  if not public.is_approved() then raise exception 'SHOP_NOT_APPROVED'; end if;

  select jsonb_build_object(
    'kategoriak', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nev', c.nev, 'leiras', c.leiras)
                                              order by c.sorrend, c.nev)
                              from shop.category c where c.aktiv), '[]'::jsonb),
    'termekek', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', p.id, 'sku', p.sku, 'nev', p.nev, 'leiras', p.leiras, 'category_id', p.category_id,
                  'tipus', p.tipus, 'ar_huf', p.ar_huf, 'afa_kulcs', p.afa_kulcs,
                  'keszlet', p.keszlet, 'elfogyott', (p.keszlet is not null and p.keszlet = 0),
                  'max_rendelesenkent', p.max_rendelesenkent, 'jovahagyas_kell', p.jovahagyas_kell,
                  'mezok', p.mezok, 'kep_url', p.kep_url, 'digitalis_fajl', (p.fajl_utvonal is not null))
                  order by p.sorrend, p.nev)
                from shop.product p
               where p.aktiv and shop.lathato(p.celkozonseg)), '[]'::jsonb),
    -- A fizetéshez szükséges adatok: a banki adatokat a vevőnek LÁTNIA kell.
    'fizetes', jsonb_build_object(
      'bank',    (select ertek from shop.setting where kulcs = 'bank'),
      'kartya',  coalesce(((select ertek from shop.setting where kulcs = 'kartya') ->> 'aktiv')::boolean, false),
      'qvik',    coalesce(((select ertek from shop.setting where kulcs = 'qvik') ->> 'aktiv')::boolean, false),
      'hatarido_nap', coalesce(((select ertek from shop.setting where kulcs = 'fizetes') ->> 'hatarido_nap')::int, 8))
  ) into v_out;
  return v_out;
end $$;

-- Rendelés leadása. p_items: [{"product_id": "...", "mennyiseg": 1, "adatok": {"rendszam": "ABC-123"}}]
create or replace function public.shop_order_create(
  p_items jsonb, p_szamlazas jsonb default '{}'::jsonb,
  p_fizetesi_mod text default 'atutalas', p_megjegyzes text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare
  v_me     uuid := auth.uid();
  v_p      public.profiles%rowtype;
  v_order  uuid;
  v_ref    bigint;
  v_tetel  jsonb;
  v_prod   shop.product%rowtype;
  v_menny  int;
  v_adatok jsonb;
  v_mezo   jsonb;
  v_ertek  text;
  v_jovah  boolean := false;
  v_hat    int;
  v_bank   jsonb;
begin
  if v_me is null then raise exception 'SHOP_NOT_AUTHENTICATED'; end if;
  if not public.is_approved() then raise exception 'SHOP_NOT_APPROVED'; end if;
  select * into v_p from public.profiles where id = v_me;
  if v_p.role = 'AGENT' then raise exception 'SHOP_FORBIDDEN: ugynoki fiokkal nem lehet vasarolni.'; end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'SHOP_EMPTY_CART';
  end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'SHOP_TOO_MANY_ITEMS'; end if;

  p_fizetesi_mod := coalesce(p_fizetesi_mod, 'atutalas');
  if p_fizetesi_mod not in ('atutalas', 'kartya', 'qvik') then raise exception 'SHOP_BAD_PAYMENT_METHOD'; end if;
  if p_fizetesi_mod = 'kartya' and not coalesce(((select ertek from shop.setting where kulcs = 'kartya') ->> 'aktiv')::boolean, false) then
    raise exception 'SHOP_PAYMENT_METHOD_OFF: a kartyas fizetes meg nincs bekapcsolva.';
  end if;
  if p_fizetesi_mod = 'qvik' and not coalesce(((select ertek from shop.setting where kulcs = 'qvik') ->> 'aktiv')::boolean, false) then
    raise exception 'SHOP_PAYMENT_METHOD_OFF: a qvik fizetes meg nincs bekapcsolva.';
  end if;
  if p_fizetesi_mod = 'atutalas' then
    select ertek into v_bank from shop.setting where kulcs = 'bank';
    if coalesce(v_bank ->> 'szamlaszam', '') = '' and coalesce(v_bank ->> 'iban', '') = '' then
      raise exception 'SHOP_NO_BANK_DETAILS: a banki atutalashoz meg nincs megadva a szamlaszam.';
    end if;
  end if;

  select coalesce((ertek ->> 'hatarido_nap')::int, 8) into v_hat from shop.setting where kulcs = 'fizetes';

  insert into shop.orders (vevo, vevo_email, vevo_nev, szamlazasi_adatok, fizetesi_mod, vevo_megjegyzes)
  values (v_me, v_p.email, coalesce(nullif(v_p.name, ''), v_p.email),
          coalesce(p_szamlazas, '{}'::jsonb), p_fizetesi_mod, nullif(btrim(coalesce(p_megjegyzes, '')), ''))
  returning id, ref_no into v_order, v_ref;

  for v_tetel in select * from jsonb_array_elements(p_items)
  loop
    select * into v_prod from shop.product
     where id = nullif(v_tetel ->> 'product_id', '')::uuid and aktiv;
    if v_prod.id is null or not shop.lathato(v_prod.celkozonseg) then
      raise exception 'SHOP_PRODUCT_UNAVAILABLE: %', coalesce(v_tetel ->> 'product_id', '?');
    end if;
    v_menny := greatest(coalesce((v_tetel ->> 'mennyiseg')::int, 1), 1);
    if v_prod.max_rendelesenkent is not null and v_menny > v_prod.max_rendelesenkent then
      raise exception 'SHOP_LIMIT: % — legfeljebb % db rendelheto.', v_prod.nev, v_prod.max_rendelesenkent;
    end if;

    -- A bekérendő adatok ellenőrzése a termék mezőlistája szerint
    v_adatok := case when jsonb_typeof(v_tetel -> 'adatok') = 'object' then v_tetel -> 'adatok' else '{}'::jsonb end;
    for v_mezo in select * from jsonb_array_elements(coalesce(v_prod.mezok, '[]'::jsonb))
    loop
      v_ertek := btrim(coalesce(v_adatok ->> (v_mezo ->> 'kulcs'), ''));
      if coalesce((v_mezo ->> 'kotelezo')::boolean, false) and v_ertek = '' then
        raise exception 'SHOP_FIELD_REQUIRED: % — %', v_prod.nev, coalesce(v_mezo ->> 'cimke', v_mezo ->> 'kulcs');
      end if;
      if v_mezo ->> 'tipus' = 'rendszam' and v_ertek <> '' then
        v_ertek := upper(regexp_replace(v_ertek, '\s+', '', 'g'));
        if v_ertek !~ '^[A-Z0-9-]{4,10}$' then
          raise exception 'SHOP_FIELD_INVALID: % — ervenytelen rendszam: %', v_prod.nev, v_ertek;
        end if;
        v_adatok := jsonb_set(v_adatok, array[v_mezo ->> 'kulcs'], to_jsonb(v_ertek));
      end if;
    end loop;

    -- Atomi készletfoglalás
    if v_prod.keszlet is not null then
      update shop.product set keszlet = keszlet - v_menny
       where id = v_prod.id and keszlet >= v_menny;
      if not found then raise exception 'SHOP_OUT_OF_STOCK: %', v_prod.nev; end if;
    end if;

    insert into shop.order_item (order_id, product_id, nev, tipus, egysegar_huf, afa_kulcs, mennyiseg, adatok, jovahagyas)
    values (v_order, v_prod.id, v_prod.nev, v_prod.tipus, v_prod.ar_huf, v_prod.afa_kulcs, v_menny, v_adatok,
            case when v_prod.jovahagyas_kell then 'var' else null end);
    if v_prod.jovahagyas_kell then v_jovah := true; end if;
  end loop;

  perform shop.osszeg_ujra(v_order);
  update shop.orders
     set fizetesi_kozlemeny = shop.kozlemeny(v_ref),
         allapot = case when v_jovah then 'jovahagyasra_var' else 'fizetesre_var' end,
         fizetesi_hatarido = case when v_jovah then null else now() + make_interval(days => v_hat) end
   where id = v_order;

  -- Ingyenes (0 Ft-os) és jóváhagyás nélküli rendelés: nincs mit fizetni.
  update shop.orders set allapot = 'fizetve', fizetve_at = now(), fizetesi_mod = 'kezi'
   where id = v_order and osszeg_huf = 0 and allapot = 'fizetesre_var';

  perform shop.naplo(v_order, 'letrehozva', jsonb_build_object('tetelek', jsonb_array_length(p_items), 'fizetesi_mod', p_fizetesi_mod));
  return shop.order_json(v_order);
end $$;

create or replace function public.shop_my_orders()
returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
declare v_out jsonb;
begin
  if auth.uid() is null then raise exception 'SHOP_NOT_AUTHENTICATED'; end if;
  select coalesce(jsonb_agg(shop.order_json(o.id) order by o.created_at desc), '[]'::jsonb) into v_out
    from shop.orders o where o.vevo = auth.uid();
  return v_out;
end $$;

-- A vevő a még ki nem fizetett rendelését lemondhatja
create or replace function public.shop_order_cancel(p_order uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare o shop.orders%rowtype; i record;
begin
  if auth.uid() is null then raise exception 'SHOP_NOT_AUTHENTICATED'; end if;
  select * into o from shop.orders where id = p_order for update;
  if o.id is null or (o.vevo <> auth.uid() and not shop.is_manager()) then raise exception 'SHOP_NOT_FOUND'; end if;
  if o.allapot not in ('jovahagyasra_var', 'fizetesre_var') then
    raise exception 'SHOP_BAD_STATE: csak fizetes elott mondhato le (most: %).', o.allapot;
  end if;
  for i in select id from shop.order_item where order_id = p_order and coalesce(jovahagyas, '') <> 'elutasitva'
  loop perform shop.keszlet_vissza(i.id); end loop;
  update shop.orders set allapot = 'lemondva', updated_at = now() where id = p_order;
  perform shop.naplo(p_order, 'lemondva', jsonb_build_object('ki_mondta_le', case when o.vevo = auth.uid() then 'vevo' else 'ugyintezo' end));
  return shop.order_json(p_order);
end $$;

-- Digitális termék letöltési útvonala — csak a kifizetett, saját tételhez.
-- A tényleges letöltés a Storage aláírt URL-jével megy; a tároló szabálya
-- (lent) ugyanezt a feltételt ellenőrzi, tehát az útvonal ismerete kevés.
create or replace function public.shop_download_path(p_item uuid)
returns text
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
declare v_ut text;
begin
  if auth.uid() is null then raise exception 'SHOP_NOT_AUTHENTICATED'; end if;
  select p.fajl_utvonal into v_ut
    from shop.order_item i
    join shop.orders o on o.id = i.order_id
    join shop.product p on p.id = i.product_id
   where i.id = p_item and i.tipus = 'digitalis'
     and (o.vevo = auth.uid() or shop.is_manager())
     and o.allapot in ('fizetve', 'teljesitve')
     and coalesce(i.jovahagyas, 'jovahagyva') = 'jovahagyva';
  if v_ut is null then raise exception 'SHOP_NOT_DOWNLOADABLE'; end if;
  return v_ut;
end $$;

-- ---------------------------------------------------------------------------
-- 4) ÜGYINTÉZŐI függvények
-- ---------------------------------------------------------------------------
create or replace function public.shop_admin_catalog()
returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  return jsonb_build_object(
    'kategoriak', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object(
                     'termek_db', (select count(*) from shop.product p where p.category_id = c.id))
                   order by c.sorrend, c.nev) from shop.category c), '[]'::jsonb),
    'termekek', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
                     'eladott_db', (select coalesce(sum(i.mennyiseg), 0) from shop.order_item i
                                     join shop.orders o on o.id = i.order_id
                                    where i.product_id = p.id and o.allapot in ('fizetve', 'teljesitve')))
                   order by p.sorrend, p.nev) from shop.product p), '[]'::jsonb),
    'beallitasok', coalesce((select jsonb_object_agg(kulcs, ertek) from shop.setting), '{}'::jsonb));
end $$;

create or replace function public.shop_category_save(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  if coalesce(btrim(p ->> 'nev'), '') = '' then raise exception 'SHOP_FIELD_REQUIRED: nev'; end if;
  if v_id is null then
    insert into shop.category (nev, leiras, sorrend, aktiv)
    values (btrim(p ->> 'nev'), nullif(p ->> 'leiras', ''), coalesce((p ->> 'sorrend')::int, 100), coalesce((p ->> 'aktiv')::boolean, true))
    returning id into v_id;
  else
    update shop.category set nev = btrim(p ->> 'nev'), leiras = nullif(p ->> 'leiras', ''),
           sorrend = coalesce((p ->> 'sorrend')::int, sorrend), aktiv = coalesce((p ->> 'aktiv')::boolean, aktiv)
     where id = v_id;
    if not found then raise exception 'SHOP_NOT_FOUND'; end if;
  end if;
  return (select to_jsonb(c) from shop.category c where c.id = v_id);
end $$;

create or replace function public.shop_product_save(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  if coalesce(btrim(p ->> 'nev'), '') = '' then raise exception 'SHOP_FIELD_REQUIRED: nev'; end if;
  if (p ->> 'ar_huf') is null or (p ->> 'ar_huf')::int < 0 then raise exception 'SHOP_FIELD_REQUIRED: ar_huf'; end if;
  if p ? 'mezok' and jsonb_typeof(p -> 'mezok') <> 'array' then raise exception 'SHOP_FIELD_INVALID: mezok'; end if;

  if v_id is null then
    insert into shop.product (sku, nev, leiras, category_id, tipus, ar_huf, afa_kulcs, keszlet, max_rendelesenkent,
                              jovahagyas_kell, mezok, kep_url, fajl_utvonal, celkozonseg, aktiv, sorrend, created_by)
    values (nullif(btrim(coalesce(p ->> 'sku', '')), ''), btrim(p ->> 'nev'), nullif(p ->> 'leiras', ''),
            nullif(p ->> 'category_id', '')::uuid, coalesce(p ->> 'tipus', 'fizikai'), (p ->> 'ar_huf')::int,
            coalesce(p ->> 'afa_kulcs', '27'), nullif(p ->> 'keszlet', '')::int, nullif(p ->> 'max_rendelesenkent', '')::int,
            coalesce((p ->> 'jovahagyas_kell')::boolean, false), coalesce(p -> 'mezok', '[]'::jsonb),
            nullif(p ->> 'kep_url', ''), nullif(p ->> 'fajl_utvonal', ''),
            case when jsonb_typeof(p -> 'celkozonseg') = 'object' then p -> 'celkozonseg' else null end,
            coalesce((p ->> 'aktiv')::boolean, true), coalesce((p ->> 'sorrend')::int, 100), auth.uid())
    returning id into v_id;
  else
    update shop.product set
      sku = nullif(btrim(coalesce(p ->> 'sku', '')), ''), nev = btrim(p ->> 'nev'), leiras = nullif(p ->> 'leiras', ''),
      category_id = nullif(p ->> 'category_id', '')::uuid, tipus = coalesce(p ->> 'tipus', tipus),
      ar_huf = (p ->> 'ar_huf')::int, afa_kulcs = coalesce(p ->> 'afa_kulcs', afa_kulcs),
      keszlet = nullif(p ->> 'keszlet', '')::int, max_rendelesenkent = nullif(p ->> 'max_rendelesenkent', '')::int,
      jovahagyas_kell = coalesce((p ->> 'jovahagyas_kell')::boolean, jovahagyas_kell),
      mezok = coalesce(p -> 'mezok', mezok), kep_url = nullif(p ->> 'kep_url', ''),
      fajl_utvonal = nullif(p ->> 'fajl_utvonal', ''),
      celkozonseg = case when jsonb_typeof(p -> 'celkozonseg') = 'object' then p -> 'celkozonseg' else null end,
      aktiv = coalesce((p ->> 'aktiv')::boolean, aktiv), sorrend = coalesce((p ->> 'sorrend')::int, sorrend),
      updated_at = now()
     where id = v_id;
    if not found then raise exception 'SHOP_NOT_FOUND'; end if;
  end if;
  return (select to_jsonb(x) from shop.product x where x.id = v_id);
end $$;

create or replace function public.shop_setting_save(p_kulcs text, p_ertek jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  if p_kulcs not in ('bank', 'kartya', 'qvik', 'fizetes', 'szamlazas') then raise exception 'SHOP_BAD_SETTING'; end if;
  if jsonb_typeof(p_ertek) <> 'object' then raise exception 'SHOP_FIELD_INVALID: ertek'; end if;
  -- A kártyás / qvik fizetést böngészőből NEM lehet bekapcsolni: ahhoz
  -- szolgáltatói szerződés, titkos kulcs és a visszaigazoló Edge Function kell.
  -- A bekapcsolás a telepítés része (service_role), nem egy kapcsoló a felületen.
  if p_kulcs in ('kartya', 'qvik') and coalesce((p_ertek ->> 'aktiv')::boolean, false)
     and not coalesce(((select ertek from shop.setting where kulcs = p_kulcs) ->> 'aktiv')::boolean, false) then
    raise exception 'SHOP_PAYMENT_SETUP: az online fizetes bekapcsolasa a szolgaltatoi bekotes resze, nem feluleti kapcsolo.';
  end if;
  insert into shop.setting (kulcs, ertek, updated_by) values (p_kulcs, p_ertek, auth.uid())
  on conflict (kulcs) do update set ertek = excluded.ertek, updated_by = auth.uid(), updated_at = now();
  return (select jsonb_object_agg(kulcs, ertek) from shop.setting);
end $$;

create or replace function public.shop_admin_orders(
  p_q text default null, p_allapot text default null, p_limit int default 50, p_offset int default 0
) returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
declare
  v_q   text := nullif(btrim(coalesce(p_q, '')), '');
  v_al  text := nullif(btrim(coalesce(p_allapot, '')), '');
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_off int := greatest(coalesce(p_offset, 0), 0);
  v_ossz int; v_out jsonb; v_stat jsonb;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;

  select count(*) into v_ossz from shop.orders o
   where (v_al is null or o.allapot = v_al)
     and (v_q is null or o.vevo_email ilike '%'||v_q||'%' or coalesce(o.vevo_nev, '') ilike '%'||v_q||'%'
          or coalesce(o.fizetesi_kozlemeny, '') ilike '%'||v_q||'%' or ('WS-' || lpad(o.ref_no::text, 5, '0')) ilike '%'||v_q||'%'
          or coalesce(o.szamla_szam, '') ilike '%'||v_q||'%'
          or exists (select 1 from shop.order_item i where i.order_id = o.id and i.adatok::text ilike '%'||v_q||'%'));

  select coalesce(jsonb_agg(shop.order_json(s.id) order by s.created_at desc), '[]'::jsonb) into v_out
    from (select o.id, o.created_at from shop.orders o
           where (v_al is null or o.allapot = v_al)
             and (v_q is null or o.vevo_email ilike '%'||v_q||'%' or coalesce(o.vevo_nev, '') ilike '%'||v_q||'%'
                  or coalesce(o.fizetesi_kozlemeny, '') ilike '%'||v_q||'%' or ('WS-' || lpad(o.ref_no::text, 5, '0')) ilike '%'||v_q||'%'
                  or coalesce(o.szamla_szam, '') ilike '%'||v_q||'%'
                  or exists (select 1 from shop.order_item i where i.order_id = o.id and i.adatok::text ilike '%'||v_q||'%'))
           order by o.created_at desc limit v_lim offset v_off) s;

  select jsonb_build_object(
    'allapotok', coalesce((select jsonb_object_agg(allapot, db) from (select allapot, count(*) db from shop.orders group by 1) a), '{}'::jsonb),
    'bevetel_huf', (select coalesce(sum(osszeg_huf), 0) from shop.orders where allapot in ('fizetve', 'teljesitve')),
    'bevetel_30_nap_huf', (select coalesce(sum(osszeg_huf), 0) from shop.orders
                            where allapot in ('fizetve', 'teljesitve') and fizetve_at >= now() - interval '30 days'),
    'szamla_nelkul', (select count(*) from shop.orders where allapot in ('fizetve', 'teljesitve') and szamla_szam is null),
    'jovahagyasra_var', (select count(*) from shop.order_item i join shop.orders o on o.id = i.order_id
                          where i.jovahagyas = 'var' and o.allapot = 'jovahagyasra_var'),
    'lejart_fizetes', (select count(*) from shop.orders where allapot = 'fizetesre_var' and fizetesi_hatarido < now())
  ) into v_stat;

  return jsonb_build_object('ossz', v_ossz, 'mutatva', jsonb_array_length(v_out), 'sorok', v_out, 'stat', v_stat);
end $$;

create or replace function public.shop_order_get(p_order uuid)
returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
begin
  if not shop.is_manager() and not exists (select 1 from shop.orders where id = p_order and vevo = auth.uid()) then
    raise exception 'SHOP_NOT_FOUND';
  end if;
  return shop.order_json(p_order, shop.is_manager());
end $$;

-- Jóváhagyás / elutasítás tételenként. Ha minden jóváhagyandó tétel eldőlt:
-- van jóváhagyott (vagy jóváhagyás nélküli) tétel → fizethető; mind elutasítva → elutasítva.
create or replace function public.shop_item_decide(p_item uuid, p_dontes text, p_indoklas text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare i shop.order_item%rowtype; o shop.orders%rowtype; v_hat int; v_marad int; v_el int;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  if p_dontes not in ('jovahagyva', 'elutasitva') then raise exception 'SHOP_BAD_DECISION'; end if;
  select * into i from shop.order_item where id = p_item;
  if i.id is null then raise exception 'SHOP_NOT_FOUND'; end if;
  select * into o from shop.orders where id = i.order_id for update;
  if o.allapot <> 'jovahagyasra_var' or i.jovahagyas is null then
    raise exception 'SHOP_BAD_STATE: ez a tetel most nem varakozik jovahagyasra.';
  end if;
  if p_dontes = 'elutasitva' and coalesce(btrim(p_indoklas), '') = '' then
    raise exception 'SHOP_FIELD_REQUIRED: az elutasitashoz indoklas kell (a vevo latja).';
  end if;

  update shop.order_item set jovahagyas = p_dontes, dontotte = auth.uid(), dontes_at = now(),
         indoklas = nullif(btrim(coalesce(p_indoklas, '')), '') where id = p_item;
  if p_dontes = 'elutasitva' then perform shop.keszlet_vissza(p_item); end if;
  perform shop.naplo(o.id, 'tetel_' || p_dontes, jsonb_build_object('tetel', i.nev, 'indoklas', p_indoklas));

  select count(*) into v_marad from shop.order_item where order_id = o.id and jovahagyas = 'var';
  if v_marad = 0 then
    perform shop.osszeg_ujra(o.id);
    select count(*) into v_el from shop.order_item where order_id = o.id and coalesce(jovahagyas, 'jovahagyva') <> 'elutasitva';
    select coalesce((ertek ->> 'hatarido_nap')::int, 8) into v_hat from shop.setting where kulcs = 'fizetes';
    if v_el = 0 then
      update shop.orders set allapot = 'elutasitva', updated_at = now() where id = o.id;
      perform shop.naplo(o.id, 'elutasitva', '{}'::jsonb);
    else
      update shop.orders set allapot = case when osszeg_huf = 0 then 'fizetve' else 'fizetesre_var' end,
             fizetve_at = case when osszeg_huf = 0 then now() else fizetve_at end,
             fizetesi_hatarido = now() + make_interval(days => v_hat), updated_at = now()
       where id = o.id;
      perform shop.naplo(o.id, 'fizetheto', '{}'::jsonb);
    end if;
  end if;
  return shop.order_json(o.id, true);
end $$;

-- Fizetés kézi rögzítése (banki kivonat alapján, vagy készpénz a pénztárban)
create or replace function public.shop_order_mark_paid(
  p_order uuid, p_kulso_azonosito text default null, p_megjegyzes text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare o shop.orders%rowtype; v_csak_digit boolean;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  select * into o from shop.orders where id = p_order for update;
  if o.id is null then raise exception 'SHOP_NOT_FOUND'; end if;
  if o.allapot <> 'fizetesre_var' then raise exception 'SHOP_BAD_STATE: csak fizetesre varo rendeles jelolheto fizetettnek (most: %).', o.allapot; end if;

  select bool_and(tipus = 'digitalis') into v_csak_digit from shop.order_item
   where order_id = p_order and coalesce(jovahagyas, 'jovahagyva') <> 'elutasitva';

  update shop.orders
     set allapot = case when coalesce(v_csak_digit, false) then 'teljesitve' else 'fizetve' end,
         fizetve_at = now(), kulso_azonosito = nullif(btrim(coalesce(p_kulso_azonosito, '')), ''),
         updated_at = now()
   where id = p_order;
  insert into shop.payment (order_id, szolgaltato, osszeg_huf, allapot, kulso_azonosito, nyers)
  values (p_order, 'kezi_' || o.fizetesi_mod, o.osszeg_huf, 'sikeres', nullif(btrim(coalesce(p_kulso_azonosito, '')), ''),
          jsonb_build_object('megjegyzes', p_megjegyzes, 'rogzitette', auth.uid()));
  perform shop.naplo(p_order, 'fizetve', jsonb_build_object('mod', 'kezi', 'hivatkozas', p_kulso_azonosito, 'megjegyzes', p_megjegyzes));
  return shop.order_json(p_order, true);
end $$;

-- Státuszváltás a teljesítéshez és a visszatérítéshez
create or replace function public.shop_order_set_status(p_order uuid, p_allapot text, p_megjegyzes text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare o shop.orders%rowtype; i record; v_ok boolean;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  select * into o from shop.orders where id = p_order for update;
  if o.id is null then raise exception 'SHOP_NOT_FOUND'; end if;

  -- Engedélyezett átmenetek (a lemondást a shop_order_cancel végzi)
  v_ok := (o.allapot = 'fizetve'      and p_allapot in ('teljesitve', 'visszaterites'))
       or (o.allapot = 'teljesitve'   and p_allapot = 'visszaterites')
       or (o.allapot = 'visszaterites' and p_allapot = 'visszateritve');
  if not v_ok then raise exception 'SHOP_BAD_TRANSITION: % -> %', o.allapot, p_allapot; end if;
  if p_allapot in ('visszaterites', 'visszateritve') and coalesce(btrim(p_megjegyzes), '') = '' then
    raise exception 'SHOP_FIELD_REQUIRED: a visszateriteshez indoklas / hivatkozas kell.';
  end if;

  if p_allapot = 'visszaterites' and o.allapot = 'fizetve' then
    -- még nem adtuk át: a készlet visszajár
    for i in select id from shop.order_item where order_id = p_order and coalesce(jovahagyas, '') <> 'elutasitva'
    loop perform shop.keszlet_vissza(i.id); end loop;
  end if;

  update shop.orders set allapot = p_allapot, updated_at = now() where id = p_order;
  if p_allapot = 'visszateritve' then
    insert into shop.payment (order_id, szolgaltato, osszeg_huf, allapot, nyers)
    values (p_order, 'kezi_' || o.fizetesi_mod, -o.osszeg_huf, 'visszaterites', jsonb_build_object('megjegyzes', p_megjegyzes));
  end if;
  perform shop.naplo(p_order, p_allapot, jsonb_build_object('megjegyzes', p_megjegyzes));
  return shop.order_json(p_order, true);
end $$;

-- A számlázó rendszerben kiállított számla száma és hivatkozása
create or replace function public.shop_order_set_invoice(p_order uuid, p_szamla_szam text, p_szamla_url text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare o shop.orders%rowtype;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  select * into o from shop.orders where id = p_order for update;
  if o.id is null then raise exception 'SHOP_NOT_FOUND'; end if;
  if o.allapot not in ('fizetve', 'teljesitve', 'visszaterites', 'visszateritve') then
    raise exception 'SHOP_BAD_STATE: szamlaszam csak kifizetett rendeleshez rogzitheto.';
  end if;
  if p_szamla_url is not null and btrim(p_szamla_url) <> '' and p_szamla_url !~* '^https://' then
    raise exception 'SHOP_FIELD_INVALID: a szamla hivatkozasa https:// kell legyen.';
  end if;
  update shop.orders set szamla_szam = nullif(btrim(coalesce(p_szamla_szam, '')), ''),
         szamla_url = nullif(btrim(coalesce(p_szamla_url, '')), ''), updated_at = now()
   where id = p_order;
  perform shop.naplo(p_order, 'szamla', jsonb_build_object('szamla_szam', p_szamla_szam));
  return shop.order_json(p_order, true);
end $$;

create or replace function public.shop_order_note(p_order uuid, p_megjegyzes text)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  update shop.orders set megjegyzes = nullif(btrim(coalesce(p_megjegyzes, '')), ''), updated_at = now() where id = p_order;
  if not found then raise exception 'SHOP_NOT_FOUND'; end if;
  return shop.order_json(p_order, true);
end $$;

-- A lejárt fizetési határidejű rendelések lemondása (készlet vissza)
create or replace function public.shop_expire_unpaid()
returns integer
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare r record; i record; n int := 0;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  for r in select id from shop.orders where allapot = 'fizetesre_var' and fizetesi_hatarido < now() for update
  loop
    for i in select id from shop.order_item where order_id = r.id and coalesce(jovahagyas, '') <> 'elutasitva'
    loop perform shop.keszlet_vissza(i.id); end loop;
    update shop.orders set allapot = 'lemondva', updated_at = now() where id = r.id;
    perform shop.naplo(r.id, 'lemondva', jsonb_build_object('ok', 'lejart fizetesi hatarido'));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 5) ONLINE FIZETÉS VISSZAIGAZOLÁSA — CSAK a szerveroldali értesítés hívhatja
--    Az Edge Function a szolgáltató aláírását ellenőrzi, és csak utána hívja.
--    Idempotens: ugyanaz a (szolgáltató, tranzakció) párosítás másodszor nem
--    könyvel. Az összeg eltérése elutasítás, nem „majdnem jó”.
-- ---------------------------------------------------------------------------
create or replace function public.shop_payment_confirm(
  p_order uuid, p_szolgaltato text, p_kulso_azonosito text, p_osszeg_huf integer,
  p_sikeres boolean, p_nyers jsonb default '{}'::jsonb
) returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare o shop.orders%rowtype; v_csak_digit boolean;
begin
  select * into o from shop.orders where id = p_order for update;
  if o.id is null then raise exception 'SHOP_NOT_FOUND'; end if;
  if exists (select 1 from shop.payment where szolgaltato = p_szolgaltato and kulso_azonosito = p_kulso_azonosito) then
    return shop.order_json(p_order);   -- már feldolgozva
  end if;
  insert into shop.payment (order_id, szolgaltato, osszeg_huf, allapot, kulso_azonosito, nyers)
  values (p_order, p_szolgaltato, p_osszeg_huf, case when p_sikeres then 'sikeres' else 'sikertelen' end,
          p_kulso_azonosito, coalesce(p_nyers, '{}'::jsonb));
  if not p_sikeres then
    perform shop.naplo(p_order, 'fizetes_sikertelen', jsonb_build_object('szolgaltato', p_szolgaltato));
    return shop.order_json(p_order);
  end if;
  if o.allapot <> 'fizetesre_var' then
    perform shop.naplo(p_order, 'fizetes_rossz_allapotban', jsonb_build_object('allapot', o.allapot, 'szolgaltato', p_szolgaltato));
    raise exception 'SHOP_BAD_STATE: %', o.allapot;
  end if;
  if p_osszeg_huf <> o.osszeg_huf then
    perform shop.naplo(p_order, 'fizetes_osszeg_elter', jsonb_build_object('varhato', o.osszeg_huf, 'kapott', p_osszeg_huf));
    raise exception 'SHOP_AMOUNT_MISMATCH';
  end if;
  select bool_and(tipus = 'digitalis') into v_csak_digit from shop.order_item
   where order_id = p_order and coalesce(jovahagyas, 'jovahagyva') <> 'elutasitva';
  update shop.orders set allapot = case when coalesce(v_csak_digit, false) then 'teljesitve' else 'fizetve' end,
         fizetve_at = now(), kulso_azonosito = p_kulso_azonosito, updated_at = now()
   where id = p_order;
  perform shop.naplo(p_order, 'fizetve', jsonb_build_object('mod', p_szolgaltato, 'hivatkozas', p_kulso_azonosito));
  return shop.order_json(p_order);
end $$;

-- A tároló szabálya a hívó jogán futna, a shop táblái viszont zártak —
-- ezért a feltétel egy definer függvényben van.
create or replace function shop.fajl_olvashato(p_nev text)
returns boolean language sql stable security definer set search_path = shop, public, pg_temp as $$
  select shop.is_manager()
      or exists (select 1 from shop.order_item i
                   join shop.orders o on o.id = i.order_id
                   join shop.product p on p.id = i.product_id
                  where o.vevo = auth.uid() and p.fajl_utvonal = p_nev
                    and i.tipus = 'digitalis' and o.allapot in ('fizetve', 'teljesitve')
                    and coalesce(i.jovahagyas, 'jovahagyva') = 'jovahagyva')
$$;

-- ---------------------------------------------------------------------------
-- 6) Digitális fájlok tárolója — privát; olvasni csak a kifizetett vevő és a kezelő tud
-- ---------------------------------------------------------------------------
do $st$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Nincs storage sema — a digitalis termekek taroloja kimarad.';
    return;
  end if;
  insert into storage.buckets (id, name, public) values ('shop-files', 'shop-files', false)
  on conflict (id) do nothing;

  execute 'drop policy if exists shop_files_read on storage.objects';
  execute $p$create policy shop_files_read on storage.objects for select to authenticated
    using (bucket_id = 'shop-files' and shop.fajl_olvashato(storage.objects.name))$p$;
  execute 'drop policy if exists shop_files_write on storage.objects';
  execute $p$create policy shop_files_write on storage.objects for all to authenticated
    using (bucket_id = 'shop-files' and shop.is_manager())
    with check (bucket_id = 'shop-files' and shop.is_manager())$p$;
end $st$;

-- A tároló szabálya a shop sémában lévő függvényt hívja — a hívó szerepkörnek
-- kell hozzá USAGE (a táblák maradnak zárva: csak a függvény fut, definer joggal).
grant usage on schema shop to authenticated;
grant execute on function shop.is_manager() to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Jogosultságok
-- ---------------------------------------------------------------------------
revoke all on all functions in schema shop from public, anon;
revoke all on all functions in schema shop from authenticated;
grant execute on function shop.is_manager() to authenticated;
grant execute on function shop.fajl_olvashato(text) to authenticated;

do $g$
declare f text;
begin
  foreach f in array array[
    'public.shop_catalog()', 'public.shop_order_create(jsonb, jsonb, text, text)', 'public.shop_my_orders()',
    'public.shop_order_cancel(uuid)', 'public.shop_download_path(uuid)', 'public.shop_admin_catalog()',
    'public.shop_category_save(jsonb)', 'public.shop_product_save(jsonb)', 'public.shop_setting_save(text, jsonb)',
    'public.shop_admin_orders(text, text, int, int)', 'public.shop_order_get(uuid)',
    'public.shop_item_decide(uuid, text, text)', 'public.shop_order_mark_paid(uuid, text, text)',
    'public.shop_order_set_status(uuid, text, text)', 'public.shop_order_set_invoice(uuid, text, text)',
    'public.shop_order_note(uuid, text)', 'public.shop_expire_unpaid()']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;

-- A fizetés-visszaigazolás CSAK a szerveroldalé.
revoke all on function public.shop_payment_confirm(uuid, text, text, integer, boolean, jsonb) from public, anon, authenticated;
do $sr$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.shop_payment_confirm(uuid, text, text, integer, boolean, jsonb) to service_role';
  end if;
end $sr$;

do $chk$
begin
  if has_function_privilege('authenticated', 'public.shop_payment_confirm(uuid, text, text, integer, boolean, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.shop_order_create(jsonb, jsonb, text, text)', 'execute')
     or has_table_privilege('authenticated', 'shop.orders', 'select') then
    raise exception 'BIZTONSAGI HIBA: a webshop jogosultsagai tul tagok.';
  end if;
  raise notice 'Rendben: 74 — webshop (katalogus, rendeles, jovahagyas, fizetes, szamla).';
end $chk$;

-- ==========================================================================
--  3/3 — ECHO beküldés védelme (ÚJRA, mindig utolsó)
--  forrás: supabase/21_echo_harden_submit.sql
-- ==========================================================================

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
