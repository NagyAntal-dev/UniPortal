-- ============================================================
-- DIAGNOSZTIKA — SAML-lel létrejött fiókok, amelyek egy importált fiók
-- DUPLIKÁTUMÁNAK látszanak. CSAK OLVAS, semmit nem módosít.
--
-- MIÉRT:
--   A 79_saml_import_match.sql előtt a belépés csak az ePPN-t és az e-mailt
--   nézte. Mivel a munkafüzetből importált fiókok bejelentkezési neve
--   placeholder (…@nje-import.invalid), egy hallgató ÚJ, ÜRES fiókot kapott,
--   miközben az importált fiókja a kurzusfelvételeivel együtt árván maradt.
--
--   Ez a szkript megmondja, KELL-E egyáltalán összevonó szkriptet írni:
--   ha a 4. szakasz 0 sort ad, a 79-es migráció önmagában elég, és nincs mit
--   helyrehozni.
--
-- FUTTATÁS (Supabase SQL Editor vagy psql), a 79-es migráció UTÁN:
--   psql "$DATABASE_URL" -f supabase/diagnostics/79_saml_duplikatum_diag.sql
-- ============================================================

\echo ''
\echo '=== 1. Mennyi importalt fiok van, es mennyi kozuluk mar atvett? ==='

select
  count(*) filter (where u.email like '%@nje-import.invalid')            as meg_placeholder,
  count(*) filter (where s.eppn is not null)                            as mar_sso_val_belepett,
  count(*)                                                              as osszes_importalt
from public.profiles p
join auth.users u on u.id = p.id
left join public.saml_identities s on s.user_id = p.id
where p.approved_by in ('nje-workbook-import', 'nje-sso')
   or u.raw_user_meta_data->>'import_source' = 'nje-workbook';

\echo ''
\echo '=== 2. Hallgatoi duplikatumok: SSO-fiok, amelynek ePPN-je egy MASIK ==='
\echo '===    fiok Neptun-kodja. Ezeket kellene osszevonni.                ==='

select
  s.eppn                       as sso_eppn,
  s.user_id                    as sso_fiok,
  su.email                     as sso_email,
  a.profile_id                 as importalt_fiok,
  iu.email                     as importalt_email,
  a.neptun,
  (select count(*) from echo.enrollment e where e.student_key = a.profile_id) as importalt_kurzusfelvetel,
  (select count(*) from echo.enrollment e where e.student_key = s.user_id)    as sso_kurzusfelvetel
from public.saml_identities s
join auth.users su on su.id = s.user_id
join public.student_attributes a
  on upper(btrim(a.neptun)) = upper(split_part(s.eppn, '@', 1))
join auth.users iu on iu.id = a.profile_id
where a.profile_id <> s.user_id
order by importalt_kurzusfelvetel desc;

\echo ''
\echo '=== 3. Oktatoi duplikatumok: SSO-fiok, amelynek a neve egyertelmuen ==='
\echo '===    egy MASIK fiokhoz kotott oktatoi sorra illik.                ==='

select
  s.eppn                as sso_eppn,
  s.user_id             as sso_fiok,
  s.display_name,
  t.id                  as oktatoi_sor,
  t.name                as oktatoi_nev,
  t.profile_id          as importalt_fiok,
  (select count(*) from echo.course_teacher ct where ct.teacher_id = t.id) as kurzusai
from public.saml_identities s
join echo.teacher t
  on t.active
 and t.profile_id is not null
 and public.nje_name_key(t.name) = public.nje_name_key(s.display_name)
where t.profile_id <> s.user_id
  -- Csak az egyertelmu esetek: ha tobb oktatoi sor illik a nevre, az
  -- osszevonas amugy sem automatizalhato.
  and (select count(*) from echo.teacher t2
        where t2.active and public.nje_name_key(t2.name) = public.nje_name_key(s.display_name)) = 1
order by kurzusai desc;

\echo ''
\echo '=== 4. OSSZEGZES — ha mindket szam 0, nincs mit helyrehozni. ==='

with hallgato as (
  select 1 from public.saml_identities s
  join public.student_attributes a
    on upper(btrim(a.neptun)) = upper(split_part(s.eppn, '@', 1))
  where a.profile_id <> s.user_id
), oktato as (
  select 1 from public.saml_identities s
  join echo.teacher t
    on t.active and t.profile_id is not null
   and public.nje_name_key(t.name) = public.nje_name_key(s.display_name)
  where t.profile_id <> s.user_id
)
select (select count(*) from hallgato) as hallgatoi_duplikatum,
       (select count(*) from oktato)   as oktatoi_duplikatum,
       (select count(*) from public.saml_link_review where resolved_at is null) as nyitott_elbiralas;

\echo ''
\echo '=== 5. Nyitott kezi elbiralasok okonkent ==='

select reason, count(*) as db, min(created_at) as legkorabbi
from public.saml_link_review
where resolved_at is null
group by reason
order by db desc;
