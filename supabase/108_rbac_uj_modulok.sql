-- ============================================================================
-- 108_rbac_uj_modulok.sql — a 72 óta született menüpontok a modul-mátrixban
-- ----------------------------------------------------------------------------
-- MI VOLT EDDIG
--   A 72-es modul-katalógus a MAKKOR létező 26 menüpontot vette fel. Azóta öt
--   új nézet született, amelyek NEM kerültek a module_definition-be:
--
--     students        Hallgatók              (71_student_directory.sql)
--     shop            Webshop                (74_webshop.sql)
--     shop_admin      Webshop kezelése       (74/75)
--     grants_office   Pályázatfigyelő        (77_grants_core.sql)
--     grants_invites  Pályázati felkéréseim  (88_grants_invite.sql)
--
--   Következmény: a Jogosultságok -> Szerepkörök mátrixban nem jelentek meg,
--   tehát szerepkörönként se megadni, se elvenni nem lehetett őket. A
--   Pályázatfigyelőt ráadásul EGYETLEN nem-admin szerepkörnek sem lehetett
--   kiosztani: a grants.has_perm() a role_permission táblát olvassa, amit a
--   72 óta csak a mátrix sormentése (role_module_actions_set) ír — modul-sor
--   nélkül erre nem volt út.
--
-- MI LESZ
--   Az öt modul bekerül a katalógusba, és a mátrixban szerkeszthető.
--
-- MIT NEM CSINÁL — ÉS EZ A LÉNYEG (a 72-es elve)
--   • NEM változtat senki hozzáférésén. A kezdő jogok BITRE a mai, kódba
--     égetett menüszabályok (app.jsx canSeeView), lásd 2. szakasz.
--   • NEM tágít szerveroldali jogot ott, ahol a szerver nem a mátrixot nézi:
--       students    -> is_staff()            (71) — a mátrix csak SZŰKÍTHET
--       shop_admin  -> shop.is_manager()     (74) — a mátrix csak SZŰKÍTHET
--       shop        -> ügynök nem vásárolhat (74) — a mátrix csak SZŰKÍTHET
--     A felület ezeknél a mai szabály ÉS a mátrix metszetét mutatja, így egy
--     bepipált, de a szerver által úgysem engedett jog nem nyit üres menüt.
--   • A grants_office VALÓDI jog: a mátrix VIEW-ja a role_permission-on át
--     (72: role_module_actions_set szinkronja) a grants.has_perm()-ig ér.
--   • A Jogosultságok (access) és a Regisztrációk menüpont kimarad / marad a
--     kódba égetett ágon: biztonsági szabály, nem szerepkör-beállítás.
--   • A 'grants_reports' kulcs kimarad: a kari kimutatásnak még nincs
--     felülete, egy bepipálható, de látható hatás nélküli cella hamis
--     jogosultság-érzet volna (72, 2.3 szakasz elve).
--
-- MÁSODIK VÁLTOZÁS: my_module_permissions()
--   Innentől MINDEN aktív modul kulcsa szerepel a válaszban — amelyiken a
--   szerepkörnek nincs joga, ott üres tömbbel. A PERM_can szempontjából ez
--   azonos (üres tömb = nincs jog), de a felület így meg tudja különböztetni
--   a „nincs joga" és a „ez a migráció még nem futott le" állapotot
--   (perm.jsx: PERM_ismert). A GitHub Pages bundle és az adatbázis külön
--   ütemben frissül; enélkül egy új bundle a 108 ELŐTTI adatbázison eltüntetné
--   ezt az öt menüpontot mindenki elől.
--
-- ELŐFELTÉTEL: 72_rbac_actions.sql, 83_exchange_student.sql
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt).
-- Idempotens — biztonságosan újrafuttatható; a kezdő jogokat csak EGYSZER
-- írja be (rbac108_backfill_complete), tehát egy később a mátrixban
-- szándékosan elvett jogot újrafuttatás sem ad vissza.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.module_definition') is null
     or to_regclass('public.role_module_permission') is null then
    raise exception 'ELOFELTETEL: a 72_rbac_actions.sql nem futott le.';
  end if;
end $pre$;


-- ============================================================================
-- 1. SZAKASZ — A MODULOK
-- ============================================================================
-- A csoport a MENU_GROUPS kulcsa (app.jsx), a sorrend a csoporton belüli hely.
-- Az actions: csak az, amire TÉNYLEGESEN van mit kapcsolni.
insert into public.module_definition (kod, nev, csoport, sorrend, actions, leiras) values
  -- students: a nyilvántartás csak olvasható (71: minden RPC olvasó). A USE
  -- a CSV-export — az adatot visz ki, ezt külön kell tudni engedélyezni (a
  -- reports modul mintájára).
  ('students',       'Hallgatók',             'kepzes',    55,
   array['VIEW','USE'],
   'Hallgatói nyilvántartás. A USE a CSV-export. Csak ügyintéző (is_staff) '
   'érheti el — a mátrix ezen belül szűkíthet.'),
  -- shop: a vásárlás a szerveren nem a mátrixon múlik, ezért csak VIEW.
  ('shop',           'Webshop',               'altalanos', 65,
   array['VIEW'],
   'Webshop. Ügynöki fiók nem vásárolhat (74) — a mátrix ezen belül szűkíthet.'),
  -- shop_admin: a szerver shop.is_manager()-t kér (SUPERADMIN/ADMIN/FINANCE).
  ('shop_admin',     'Webshop kezelése',      'penzugy',   105,
   array['VIEW'],
   'Termékek, rendelések, befizetések. Csak ADMIN és FINANCE kezelheti '
   '(shop.is_manager) — a mátrix ezen belül szűkíthet.'),
  -- grants_office: a szerveren EGY kapu van (grants.require_office), ezért
  -- egyetlen művelet. A VIEW itt valódi jog: a role_permission-on át a
  -- grants.has_perm() is ezt nézi.
  ('grants_office',  'Pályázatfigyelő',       'kutatas',   152,
   array['VIEW'],
   'Pályázati iroda: felhívások, csapatajánló, felkérések, konzorciumkeresés. '
   'A megtekintés egyben a teljes irodai jog (grants.require_office).'),
  -- grants_invites: a kolléga a SAJÁT felkéréseit látja; a szerver a
  -- tulajdonost nézi, nem szerepkört.
  ('grants_invites', 'Pályázati felkéréseim', 'kutatas',   154,
   array['VIEW'],
   'A kolléga saját pályázati felkérései és válasza. Ügynöki fiók nem látja.')
on conflict (kod) do update
  set nev = excluded.nev, csoport = excluded.csoport, sorrend = excluded.sorrend,
      actions = excluded.actions, leiras = excluded.leiras, updated_at = now();


-- ============================================================================
-- 2. SZAKASZ — KEZDŐ JOGOK: „A MAI ÁLLAPOT RÖGZÍTÉSE"
-- ============================================================================
-- Soronként a mai canSeeView-ág, amit rögzít. SUPERADMIN-nak nincs sora (72).
-- Az EXCHANGE_STUDENT a canSeeView legelején CSAK a student_portalt látja,
-- ezért egyik sort sem kapja.

-- 2.1 ADMIN: minden új modulon minden művelet (72, 4.3 mintája).
insert into public.role_module_permission (role_kod, module_kod, action)
select 'ADMIN', md.kod, a.kod
  from public.module_definition md
  cross join unnest(md.actions) as a(kod)
 where md.kod in ('students','shop','shop_admin','grants_office','grants_invites')
   and exists (select 1 from public.role_definition where kod = 'ADMIN')
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbac108_backfill_complete')
on conflict do nothing;

-- 2.2 students — app.jsx: ['SUPERADMIN','ADMIN','ADMISSIONS','FINANCE'].
insert into public.role_module_permission (role_kod, module_kod, action)
select r.kod, 'students', a.kod
  from public.role_definition r
  cross join (values ('VIEW'), ('USE')) as a(kod)
 where r.kod in ('ADMISSIONS', 'FINANCE')
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbac108_backfill_complete')
on conflict do nothing;

-- 2.3 shop és grants_invites — app.jsx: role !== 'AGENT'. MINDEN ma létező
-- szerepkör megkapja (az egyedi, szuperadmin által létrehozottak is), mert ma
-- mind látja.
insert into public.role_module_permission (role_kod, module_kod, action)
select r.kod, m.kod, 'VIEW'
  from public.role_definition r
  cross join (values ('shop'), ('grants_invites')) as m(kod)
 where r.kod not in ('SUPERADMIN', 'AGENT', 'EXCHANGE_STUDENT')
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbac108_backfill_complete')
on conflict do nothing;

-- 2.4 shop_admin — app.jsx: ['SUPERADMIN','ADMIN','FINANCE'].
insert into public.role_module_permission (role_kod, module_kod, action)
select r.kod, 'shop_admin', 'VIEW'
  from public.role_definition r
 where r.kod = 'FINANCE'
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbac108_backfill_complete')
on conflict do nothing;

-- 2.5 grants_office — a szerver szabálya: role_permission sor (77). Akinek
-- ma ott joga van, az a mátrixban is megkapja.
insert into public.role_module_permission (role_kod, module_kod, action)
select rp.role_kod, 'grants_office', 'VIEW'
  from public.role_permission rp
  join public.role_definition r on r.kod = rp.role_kod
 where rp.permission = 'grants_office'
   and rp.role_kod <> 'SUPERADMIN'
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbac108_backfill_complete')
on conflict do nothing;

-- 2.6 A régi role_permission táblát a VIEW-val szinkronban tartjuk (72, 5.2):
-- a my_role_permissions() innentől ezekből a sorokból is dolgozik, a
-- grants.has_perm() pedig a role_permission-t olvassa.
insert into public.role_permission (role_kod, permission)
select rmp.role_kod, rmp.module_kod
  from public.role_module_permission rmp
 where rmp.module_kod in ('students','shop','shop_admin','grants_office','grants_invites')
   and rmp.action = 'VIEW'
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbac108_backfill_complete')
on conflict do nothing;

-- 2.7 Ellenőrzés — CSAK az első futáskor. Utána a mátrix a szuperadminé:
-- egy szándékosan elvett jog újrafuttatáskor nem hiba.
do $elso$
declare v_hiany text;
begin
  if exists (select 1 from public.rbac_setting where kulcs = 'rbac108_backfill_complete') then
    return;
  end if;
  -- Aki ma role_permission alapján a Pályázatfigyelőt látja, annak a mátrixban
  -- is meg kell lennie — különben a szinkron a következő mentéskor elvenné.
  select string_agg(rp.role_kod, ', ') into v_hiany
    from public.role_permission rp
    join public.role_definition r on r.kod = rp.role_kod
   where rp.permission = 'grants_office' and rp.role_kod <> 'SUPERADMIN'
     and not exists (select 1 from public.role_module_permission m
                      where m.role_kod = rp.role_kod and m.module_kod = 'grants_office'
                        and m.action = 'VIEW');
  if v_hiany is not null then
    raise exception '108: a grants_office jog hiányzik a mátrixból: %', v_hiany;
  end if;
  if exists (select 1 from public.role_module_permission
              where role_kod in ('AGENT', 'EXCHANGE_STUDENT')
                and module_kod in ('students','shop','shop_admin','grants_office','grants_invites')) then
    raise exception '108: AGENT/EXCHANGE_STUDENT kezdő jogot kapott egy új modulon.';
  end if;
end $elso$;

insert into public.rbac_setting (kulcs, ertek)
values ('rbac108_backfill_complete', 'on') on conflict do nothing;


-- ============================================================================
-- 3. SZAKASZ — my_module_permissions(): minden aktív modul kulcsa
-- ============================================================================
-- A törzs a 72-es 3.5-ös változata; az egyetlen különbség, hogy a jog nélküli
-- aktív modul is szerepel, üres tömbbel. Indoklás a fejlécben.
create or replace function public.my_module_permissions()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case
    when public.is_superadmin()
      then jsonb_build_object('*',
             jsonb_build_array('VIEW','USE','CREATE','EDIT','DELETE'))
    when not public.is_approved()
      then '{}'::jsonb
    else coalesce(
      (select jsonb_object_agg(md.kod, coalesce(x.actions, '[]'::jsonb))
         from public.module_definition md
         left join (select rmp.module_kod,
                           jsonb_agg(rmp.action order by ra.sorrend) as actions
                      from public.role_module_permission rmp
                      join public.role_definition rd on rd.kod = rmp.role_kod and rd.aktiv
                      join public.rbac_action     ra on ra.kod = rmp.action
                     where rmp.role_kod = public.my_role()
                     group by rmp.module_kod) x on x.module_kod = md.kod
        where md.aktiv),
      '{}'::jsonb)
  end
$$;

comment on function public.my_module_permissions() is
  'A hívó teljes jogosultsági képe egy jsonb objektumban. Minden aktív modul '
  'kulcsa szerepel (jog nélkül üres tömbbel). SUPERADMIN-nál {"*": [...]}.';

revoke all on function public.my_module_permissions() from public, anon;
grant execute on function public.my_module_permissions() to authenticated;


-- ============================================================================
-- 4. SZAKASZ — ELLENŐRZÉS
-- ============================================================================
do $chk$
declare v_mod int;
begin
  select count(*) into v_mod from public.module_definition
   where kod in ('students','shop','shop_admin','grants_office','grants_invites') and aktiv;
  if v_mod <> 5 then
    raise exception '108: % az 5 új modulból aktív.', v_mod;
  end if;
  raise notice 'Rendben: 108 — 5 új modul a mátrixban (students, shop, shop_admin, grants_office, grants_invites).';
end $chk$;
