-- ============================================================
-- SAML-duplikátumok ÖSSZEVONÁSA — a 79-es migráció ELŐTT létrejött,
-- fölösleges SSO-fiókok visszavezetése az importált fiókra.
--
-- MIÉRT:
--   A 79_saml_import_match.sql előtt a belépés csak az ePPN-t és az e-mailt
--   nézte, ezért aki a munkafüzetből importált fiókkal rendelkezett, ÚJ, ÜRES
--   fiókot kapott. A 79-es a JÖVŐBELI belépéseket rendezi; ez a szkript a MÁR
--   LÉTREJÖTT duplikátumokat.
--
-- MIT CSINÁL PÁRONKÉNT:
--   1. Az NJE-azonosítót (saml_identities) átkötjük az IMPORTÁLT fiókra.
--   2. Az importált fiók megkapja a VALÓDI e-mail-címet (a placeholder
--      …@nje-import.invalid helyett), és a jelszava véletlenre vált — ezt
--      egyébként a provision.js tenné meg, de az összevonás után a belépés
--      már az 'eppn' ágon fut, ami szándékosan nem nyúl a fiókhoz.
--   3. A fölösleges SSO-fiókot NYUGDÍJAZZUK: átnevezett cím + tiltás +
--      'rejected' profil. SZÁNDÉKOSAN NEM TÖRÖLJÜK — a profiles(id)-ra 57
--      tábla hivatkozik, a törlés kaszkádolna, és nem visszavonható.
--   4. Mindkét fiók munkameneteit visszavonjuk (újra be kell lépni).
--
-- MIT NEM CSINÁL:
--   Ha az SSO-fiókhoz BÁRMILYEN adat tartozik (a szkript minden idegen
--   kulcsot végigmér, nem egy kézzel írt listát), a tranzakció ELSZÁLL, és
--   semmi nem változik. Ilyenkor ember döntse el, mi legyen az adattal.
--   Kétértelmű (több jelöltes) oktatónevet nem von össze.
--
-- ELŐFELTÉTEL: a 79_saml_import_match.sql már lefutott (nje_name_key kell).
--
-- FUTTATÁS — ELŐBB MENTÉS! (sudo ./deploy/backup.sh)
--   Előnézet (nem ír semmit): a fájl végén a `commit;` helyett `rollback;`
--   Éles futtatás: változatlanul.
--
--   docker compose run --rm --entrypoint sh migrate \
--     -c 'psql -v ON_ERROR_STOP=1 -f /uniportal/migrations/diagnostics/79_saml_duplikatum_merge.sql'
--
--   Újrafuttatható: ami már össze van vonva, azt nem találja meg újra.
-- ============================================================

\set ON_ERROR_STOP on
begin;

-- Ne fusson végfelhasználói munkamenetben (RLS, auth.uid()).
do $$
begin
  if current_setting('request.jwt.claims', true) is not null then
    raise exception 'Ez a szkript adatbazis-tulajdonoskent futtatando, nem a REST API-n keresztul.';
  end if;
end $$;

-- ---------- 1. a párok összegyűjtése ----------
create temp table nje_merge on commit drop as
-- HALLGATÓ: az ePPN helyi része egy másik fiók Neptun-kódja.
select s.eppn,
       s.user_id      as sso_fiok,
       a.profile_id   as importalt_fiok,
       su.email       as valodi_email,
       'neptun'::text as mod
  from public.saml_identities s
  join auth.users su on su.id = s.user_id
  join public.student_attributes a
    on upper(btrim(a.neptun)) = upper(split_part(s.eppn, '@', 1))
  join public.profiles ip on ip.id = a.profile_id and ip.role = 'STUDENT'
 where a.profile_id <> s.user_id
union all
-- OKTATÓ: a név egyértelműen egy másik fiókhoz kötött oktatói sorra illik.
select s.eppn, s.user_id, t.profile_id, su.email, 'teacher_name'
  from public.saml_identities s
  join auth.users su on su.id = s.user_id
  join echo.teacher t
    on t.active and t.profile_id is not null
   and public.nje_name_key(t.name) = public.nje_name_key(s.display_name)
  join public.profiles ip on ip.id = t.profile_id
   and ip.role in ('TEACHER', 'ADMIN', 'SUPERADMIN')
 where t.profile_id <> s.user_id
   and (select count(*) from echo.teacher t2
         where t2.active and public.nje_name_key(t2.name) = public.nje_name_key(s.display_name)) = 1;

\echo ''
\echo '=== Osszevonasra jelolt parok ==='
select mod, eppn, valodi_email, sso_fiok, importalt_fiok from nje_merge order by mod, eppn;

-- ---------- 2. épség-ellenőrzések ----------
do $$
declare v_n int;
begin
  if (select count(*) from nje_merge) = 0 then
    raise notice 'Nincs osszevonandó par — a szkript nem valtoztat semmit.';
    return;
  end if;
  -- Egy SSO-fiók egy célfiókhoz, és fordítva.
  if exists (select 1 from nje_merge group by sso_fiok having count(distinct importalt_fiok) > 1)
     or exists (select 1 from nje_merge group by importalt_fiok having count(distinct sso_fiok) > 1) then
    raise exception 'Ketertelmu parositas: egy fiok tobb celponthoz illik. Kezi dontes kell.';
  end if;
  -- A célfiók nem lehet már egy MÁSIK NJE-azonosítóhoz kötve (unique user_id).
  select count(*) into v_n from nje_merge m
    join public.saml_identities s2 on s2.user_id = m.importalt_fiok;
  if v_n > 0 then
    raise exception 'A celfiokhoz mar tartozik NJE-azonosito (% db). Kezi dontes kell.', v_n;
  end if;
  -- A célfiók legyen ép: létező, jóváhagyott, nem tiltott.
  if exists (
    select 1 from nje_merge m
      join auth.users u on u.id = m.importalt_fiok
      left join public.profiles p on p.id = m.importalt_fiok
     where p.id is null or p.approval_status <> 'approved'
        or u.deleted_at is not null or u.banned_until > now()) then
    raise exception 'A celfiok hianyzik, nincs jovahagyva vagy tiltott.';
  end if;
  if exists (select 1 from nje_merge where coalesce(btrim(valodi_email), '') = '') then
    raise exception 'Van par valodi e-mail-cim nelkul.';
  end if;
end $$;

-- ---------- 3. ÜRES-E az SSO-fiók? ----------
-- A profiles(id)-ra 57 tábla hivatkozik, ezért NEM kézzel írt listát
-- ellenőrzünk: végigmegyünk MINDEN idegen kulcson, ami a profiles-ra vagy az
-- auth.users-re mutat. Az engedélyezett táblák azok, amelyek maguk a fiókot
-- írják le (profil, azonosság, munkamenet) — minden más TARTALOM, és a
-- nyugdíjazás elvenné a gazdáját.
do $$
declare
  r     record;
  n     bigint;
  ssok  uuid[];
  bajok text := '';
begin
  select coalesce(array_agg(sso_fiok), '{}') into ssok from nje_merge;
  if cardinality(ssok) = 0 then return; end if;

  for r in
    select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)
       and array_length(c.conkey, 1) = 1
       -- OID-ot hasonlítunk, NEM szöveget: a regclass szöveges alakja a
       -- search_path miatt elhagyja a "public." előtagot, ezért egy
       -- 'public.profiles' listaelem SOHA nem illeszkedne. (Ugyanez a csapda
       -- a 99_harden_grants.sql-ben is ki van mondva a regprocedure-re.)
       -- A to_regclass() a nem létező táblákra NULL-t ad, nem hibát — a
       -- GoTrue-verziók eltérő segédtáblái így nem törik el a szkriptet.
       and c.conrelid <> all (array_remove(array[
             to_regclass('public.profiles'),      to_regclass('public.saml_identities'),
             to_regclass('public.saml_link_review'),
             to_regclass('auth.identities'),      to_regclass('auth.sessions'),
             to_regclass('auth.refresh_tokens'),  to_regclass('auth.mfa_factors'),
             to_regclass('auth.mfa_amr_claims'),  to_regclass('auth.one_time_tokens')
           ]::oid[], null))
  loop
    execute format('select count(*) from %s where %I = any($1)', r.tbl, r.col)
      into n using ssok;
    if n > 0 then
      bajok := bajok || format('%s.%s: %s sor; ', r.tbl, r.col, n);
    end if;
  end loop;

  if bajok <> '' then
    raise exception E'Az osszevonandó SSO-fiok(ok)hoz ADAT tartozik, ezert nem nyugdijazom.\nKezi dontes kell, mi legyen vele: %', bajok;
  end if;
  raise notice 'Az SSO-fiokok uresek — a nyugdijazas biztonsagos.';
end $$;

-- ---------- 4. az összevonás ----------
-- a) A valódi cím felszabadítása: az SSO-fiók átnevezése és tiltása.
--    (Az auth.users.email UNIQUE, ezért ennek MEG KELL előznie a c) lépést.)
update auth.users u
   set email             = 'merged-' || u.id::text || '@nje-import.invalid',
       banned_until      = 'infinity'::timestamptz,
       raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('merged_into', m.importalt_fiok::text,
                                                 'merged_at', now()::text)
  from nje_merge m
 where u.id = m.sso_fiok;

update auth.identities i
   set identity_data = coalesce(i.identity_data, '{}'::jsonb)
                       || jsonb_build_object('email', u.email)
  from nje_merge m join auth.users u on u.id = m.sso_fiok
 where i.user_id = m.sso_fiok and i.provider = 'email';

update public.profiles p
   set email           = u.email,
       approval_status = 'rejected',
       rejected_reason = 'SAML-duplikatum: osszevonva ide: ' || m.importalt_fiok::text
  from nje_merge m join auth.users u on u.id = m.sso_fiok
 where p.id = m.sso_fiok;

-- b) Az NJE-azonosító átkötése az importált fiókra.
update public.saml_identities s
   set user_id = m.importalt_fiok
  from nje_merge m
 where s.user_id = m.sso_fiok;

-- c) Az importált fiók megkapja a valódi címet.
update auth.users u
   set email              = m.valodi_email,
       email_confirmed_at = coalesce(u.email_confirmed_at, now())
  from nje_merge m
 where u.id = m.importalt_fiok;

update auth.identities i
   set identity_data = coalesce(i.identity_data, '{}'::jsonb)
                       || jsonb_build_object('email', m.valodi_email, 'email_verified', true)
  from nje_merge m
 where i.user_id = m.importalt_fiok and i.provider = 'email';

update public.profiles p
   set email = m.valodi_email
  from nje_merge m
 where p.id = m.importalt_fiok;

-- d) A credentials.csv-ben kiosztott jelszó ÉRVÉNYTELENÍTÉSE. Az összevonás
--    után a belépés az 'eppn' ágon fut, ami szándékosan nem nyúl a fiókhoz —
--    tehát a régi jelszó itt és most kell hogy megszűnjön.
do $$
begin
  begin
    -- Supabase-en a pgcrypto az extensions sémában van.
    execute 'update auth.users u set encrypted_password ='
         || ' crypt(gen_random_uuid()::text, gen_salt(''bf''))'
         || ' from nje_merge m where u.id = m.importalt_fiok';
  exception when undefined_function then
    -- Tartalék: bcrypt ALAKÚ, de egyetlen jelszóval sem egyező érték.
    execute 'update auth.users u set encrypted_password ='
         || ' ''$2a$10$'' || replace(gen_random_uuid()::text || gen_random_uuid()::text, ''-'', '''')'
         || ' from nje_merge m where u.id = m.importalt_fiok';
    raise notice 'A pgcrypto nem elerheto — a jelszo ervenytelenitese tartalek modon tortent.';
  end;
end $$;

-- e) Munkamenetek visszavonása mindkét oldalon: újra be kell lépni.
delete from auth.sessions
 where user_id in (select sso_fiok from nje_merge)
    or user_id in (select importalt_fiok from nje_merge);

-- ---------- 5. eredmény ----------
\echo ''
\echo '=== Eredmeny ==='
select m.mod,
       m.eppn,
       u.email                                as celfiok_uj_cime,
       p.role                                 as celfiok_szerepkore,
       (select count(*) from echo.enrollment e where e.student_key = m.importalt_fiok) as kurzusfelvetel,
       (select count(*) from public.saml_identities s where s.user_id = m.importalt_fiok) as nje_azonosito
  from nje_merge m
  join auth.users u on u.id = m.importalt_fiok
  join public.profiles p on p.id = m.importalt_fiok
 order by m.mod, m.eppn;

\echo ''
\echo '=== Ellenorzes: maradt-e duplikatum? (0 a jo) ==='
select count(*) as maradt_hallgatoi
  from public.saml_identities s
  join public.student_attributes a
    on upper(btrim(a.neptun)) = upper(split_part(s.eppn, '@', 1))
 where a.profile_id <> s.user_id;

-- ELŐNÉZETHEZ: cseréld a `commit;`-et `rollback;`-re.
commit;
