-- ============================================================================
--  kollegium_teszt_fiok.sql — minta felhasználó a kollégiumi adatok kezelésére
-- ============================================================================
--
--  BELÉPÉS
--    e-mail:  kollegium@teszt.hu
--    jelszó:  NINCS A FÁJLBAN. Futtatás előtt írd be a v_pw sorba; jelszóval kitöltve NE commitold (a repó nyilvános).
--
--  MIT KAP, ÉS MIÉRT ÉPPEN AZT
--  A kollégiumi modulban ÖT szerepkör van (26_dorm.sql, 1.x szakasz), és
--  szándékosan nem egy "mindenes" van köztük:
--    GONDNOK       — saját épülete: szobák, be-/kiköltöztetés, kulcs, leltár,
--                    hibajegy lezárása — LAKÓNÉVVEL          [épülethez kötött]
--    KARBANTARTO   — hibajegyek és munkalapok — LAKÓNÉV NÉLKÜL
--    KOLI_ADMIN    — férőhelykiosztás, szerződés, várólista, díj  [intézményi]
--    INGATLAN      — bérleti szerződés, rezsi — LAKÓNÉVSORT EGYÁLTALÁN NEM LÁT
--    KOLI_SYSADMIN — grantok és katalógusok kezelése
--
--  Ez a fiók HÁROM kiosztást kap:
--    KOLI_ADMIN (intézményi) — férőhely, szerződés, várólista, díj + LAKÓNÉV
--    GONDNOK    (egy épület) — szoba, be-/kiköltöztetés, kulcs, leltár
--    INGATLAN   (intézményi) — bérleti szerződés, rezsi, bérbeadó
--
--  MIÉRT PONTOSAN EZ A HÁROM — a felület fülkapuiból visszafejtve
--  (features/dorm.jsx:2015-2019):
--    canNames    = GONDNOK | KOLI_ADMIN | KOLI_SYSADMIN     -> lakónév
--    canAllocate = KOLI_ADMIN | KOLI_SYSADMIN               -> férőhelykiosztás
--    canEstate   = admin | INGATLAN                         -> Bérlemények
--    canEditBld  = admin | KOLI_ADMIN | KOLI_SYSADMIN | INGATLAN
--    canSysadm   = admin | KOLI_SYSADMIN                    -> grantok, katalógus
--  KOLI_ADMIN + GONDNOK önmagában MINDENT megnyit, EGYET kivéve: a
--  Bérleményeket. Azt csak az INGATLAN nyitja — ezért kell a harmadik.
--
--  A KOLI_SYSADMIN-t SZÁNDÉKOSAN nem adjuk meg. Az nem adatkezelés, hanem
--  JOGOSZTÁS: dorm.can_grant() = is_admin() OR KOLI_SYSADMIN, vagyis aki
--  megkapja, magának is adhat bármit, és a katalógusokat is átírhatja.
--  Egy mintafiókban ez elmosná azt, amit be akarunk mutatni.
--
--  A szerepkörök ÖSSZEADÓDNAK, elvenni nem tudnak: a dorm.can_see_residents()
--  és a többi kapu tiszta OR. Az INGATLAN tehát NEM veszi el a lakónév-látást,
--  amit a KOLI_ADMIN ad — hiába szól a szerepkör leírása arról, hogy az
--  INGATLAN önmagában nem lát névsort.
--
--  ALKALMAZÁS-SZEREPKÖR: 'KOLLEGIUM', egy ÚJ bejegyzés a szerepkör-katalógusban.
--  MÉRVE: a kollégiumi RPC-k (dorm_*) csak public.is_approved()-ot és a dorm
--  grantot kérik — alkalmazás-szerepkört NEM. A menüszűrés pedig a kollégiumi
--  grantot a szerepkör-jogosultságok ELŐTT vizsgálja (app.jsx). Ezért ennek a
--  fióknak nem kell ADMIN: a kollégiumi menüket a grant nyitja meg, minden mást
--  pedig a katalógusbeli jogosultsága dönt el. Így a fiók PONTOSAN annyit lát,
--  amennyit egy kollégiumi ügyintézőnek látnia kell — ez a modul
--  szerepkör-elválasztásának a bemutatása is.
--
--  EGY KIOSZTÁS VISSZAVONÁSA: a modul soha nem töröl sort, hanem lejárat:
--      update dorm.role_grant set expires_at = now()
--       where person = (select id from public.profiles where email='kollegium@teszt.hu')
--         and role = 'INGATLAN';
--  (a dorm.has_role() a lejárt grantot kizárja — a nyom viszont megmarad)
--
--  A TELJES FIÓK TÖRLÉSE:
--      delete from auth.users where email = 'kollegium@teszt.hu';
--      (a profil és a grantok kaszkádolnak)
-- ============================================================================

-- ---------- 1. Alkalmazás-szerepkör a katalógusba ----------
-- A 39-es migráció épp azért tette szerkeszthetővé a szerepköröket, hogy ilyet
-- fel lehessen venni. A superadmin felületről utólag is bővíthető.
insert into public.role_definition (kod, nev, leiras, szin, sorrend, beepitett, aktiv)
values ('KOLLEGIUM', 'Kollégium',
        'Kollégiumi ügyintéző. A kollégiumi menüket a dorm.role_grant kiosztás '
        'nyitja meg, nem ez a szerepkör — itt csak azt állítjuk be, mit lát '
        'RAJTUK KÍVÜL.', '#0ea5e9', 60, false, true)
on conflict (kod) do update
  set nev = excluded.nev, leiras = excluded.leiras, aktiv = true;

-- Amit a kollégiumi menükön KÍVÜL lát. Szándékosan kevés: a Hírfolyam a
-- belépés utáni kezdőnézet, enélkül üres képernyőre érkezne.
insert into public.role_permission (role_kod, permission)
values ('KOLLEGIUM', 'feed'), ('KOLLEGIUM', 'assistant')
on conflict do nothing;


-- ---------- 2. A fiók ----------
do $$
declare
  v_id    uuid := 'c1a0de00-0000-4000-8000-00000000d0d0';
  v_email text := 'kollegium@teszt.hu';
  v_pw    text := '<UJ_JELSZO_IDE>';
  v_hash  text := crypt(v_pw, gen_salt('bf'));
  v_ep    uuid;
  v_n     int;
begin
  if v_pw = '<UJ_JELSZO_IDE>' or length(v_pw) < 12 then
    raise exception 'Futtatás előtt adj meg új, legalább 12 karakteres jelszót a v_pw sorban (a fájlt jelszóval ne commitold).';
  end if;
  -- A GoTrue a varchar mezőket Go string-be olvassa: NULL-ra "Database error
  -- querying schema" hibát ad, helyes jelszóval is. Ezért ÜRES SZÖVEG.
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current)
  values (
    v_id, '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated', v_email, v_hash,
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"role":"KOLLEGIUM","name":"Kollégiumi adatkezelő (teszt)"}'::jsonb,
    '', '', '', '', '')
  on conflict (id) do update
    set encrypted_password = excluded.encrypted_password,
        email_confirmed_at = now();

  insert into auth.identities (id, user_id, provider, provider_id, identity_data,
                               created_at, updated_at)
  values (gen_random_uuid(), v_id, 'email', v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          now(), now())
  on conflict do nothing;

  -- A profilt trigger hozza létre 'pending' állapotban; itt jóváhagyjuk.
  -- Ha a trigger valamiért nem futott le, magunk szúrjuk be.
  insert into public.profiles (id, email, name, role, approval_status, approved_at)
  values (v_id, v_email, 'Kollégiumi adatkezelő (teszt)', 'KOLLEGIUM', 'approved', now())
  on conflict (id) do update
    set role = 'KOLLEGIUM', approval_status = 'approved',
        approved_at = now(), name = 'Kollégiumi adatkezelő (teszt)';

  -- ---------- 3. Kollégiumi kiosztások ----------
  -- KÖZVETLEN beszúrás, nem a dorm_role_grant() RPC-n át: az RPC
  -- dorm.can_grant()-ot kér (is_admin() vagy KOLI_SYSADMIN), az SQL Editorban
  -- viszont auth.uid() = NULL, tehát az RPC 'DORM_FORBIDDEN'-nel elutasítana.
  -- A tábla egyedi indexei kezelik az ismétlést:
  --   dorm_role_grant_global_uidx  (person, role) where scope_building is null
  --   dorm_role_grant_scoped_uidx  (person, role, scope_building)

  -- (a) KOLI_ADMIN — intézményi hatókör (scope_building = null)
  insert into dorm.role_grant (person, role, scope_building, megjegyzes)
  values (v_id, 'KOLI_ADMIN', null, 'Minta fiók — kollégiumi adatkezelés')
  on conflict do nothing;

  -- (b) INGATLAN — intézményi. Enélkül a "Bérlemények" fül nem nyílik meg
  --     (features/dorm.jsx:2017), pedig a bérleti szerződés és a rezsi is
  --     kollégiumi adat.
  insert into dorm.role_grant (person, role, scope_building, megjegyzes)
  values (v_id, 'INGATLAN', null, 'Minta fiók — bérlemények, rezsi')
  on conflict do nothing;

  -- (c) GONDNOK — egy konkrét épületre. A legtöbb szobával rendelkezőt
  --     választjuk, hogy a fiókkal legyen mit nézni. SZÁNDÉKOSAN épülethez
  --     kötött: így a hatókör-korlátozás is látszik a mintán.
  select b.id into v_ep
    from dorm.building b
    left join dorm.room r on r.building_id = b.id
   group by b.id
   order by count(r.id) desc, b.name
   limit 1;

  if v_ep is not null then
    insert into dorm.role_grant (person, role, scope_building, megjegyzes)
    values (v_id, 'GONDNOK', v_ep, 'Minta fiók — gondnoki jogosultság egy épületre')
    on conflict do nothing;
  end if;

  select count(*) into v_n from dorm.role_grant where person = v_id;
  raise notice 'Kesz: % (%). Kollegiumi kiosztas: % db. Epulet: %',
               'kollegium@teszt.hu', '(jelszó: a v_pw sor szerint)', v_n,
               coalesce((select name from dorm.building where id = v_ep), '(nincs)');
end $$;

-- A PostgREST sema-gyorsitotara: uj sor nem igenyli, de artalmatlan.
notify pgrst, 'reload schema';


-- ============================================================================
--  ELLENŐRZÉS — futtasd le, és küldd vissza a táblát
-- ============================================================================
select 'a fiok letrejott' as mit_ellenorzunk,
       coalesce((select email from auth.users where email='kollegium@teszt.hu'), '(nincs)') as ertek,
       case when exists (select 1 from auth.users where email='kollegium@teszt.hu')
            then 'OK' else 'HIBA' end as allapot
union all
select 'a belepes nem fog "Database error"-t adni',
       case when exists (select 1 from auth.users
                          where email='kollegium@teszt.hu'
                            and confirmation_token is not null
                            and recovery_token is not null
                            and email_change is not null)
            then 'a szoveges mezok ki vannak toltve' else 'NULL maradt valamelyik' end,
       case when exists (select 1 from auth.users
                          where email='kollegium@teszt.hu'
                            and confirmation_token is not null and recovery_token is not null
                            and email_change is not null)
            then 'OK' else 'HIBA — GoTrue elutasitana' end
union all
select 'a profil jovahagyott',
       coalesce((select role||' / '||approval_status from public.profiles
                  where email='kollegium@teszt.hu'), '(nincs)'),
       case when exists (select 1 from public.profiles
                          where email='kollegium@teszt.hu' and approval_status='approved')
            then 'OK' else 'HIBA' end
union all
select 'kollegiumi kiosztas: '||g.role,
       coalesce((select b.name from dorm.building b where b.id=g.scope_building), 'intezmenyi (minden epulet)'),
       'OK'
  from dorm.role_grant g
  join public.profiles p on p.id = g.person
 where p.email = 'kollegium@teszt.hu'
union all
select 'a szerepkor a katalogusban',
       coalesce((select kod||' — '||nev from public.role_definition where kod='KOLLEGIUM'), '(nincs)'),
       case when exists (select 1 from public.role_definition where kod='KOLLEGIUM' and aktiv)
            then 'OK' else 'HIBA' end
union all
select 'amit a kollegiumi menukon KIVUL lat',
       coalesce((select string_agg(permission, ', ' order by permission)
                   from public.role_permission where role_kod='KOLLEGIUM'), '(semmit)'),
       'INFO';


-- ============================================================================
--  HA TÖBBET KELL ADNI  (kikommentezve)
-- ============================================================================
-- További épület gondnoki joga:
--   insert into dorm.role_grant (person, role, scope_building)
--   select p.id, 'GONDNOK', b.id from public.profiles p, dorm.building b
--    where p.email='kollegium@teszt.hu' and b.name='Izsáki úti Kollégium'
--   on conflict do nothing;
--
-- Karbantartás (hibajegyek, LAKÓNÉV NÉLKÜL):
--   insert into dorm.role_grant (person, role, scope_building)
--   select id, 'KARBANTARTO', null from public.profiles where email='kollegium@teszt.hu'
--   on conflict do nothing;
--
-- JOGOSZTÁS (óvatosan: ezzel magának is adhat bármit):
--   insert into dorm.role_grant (person, role, scope_building)
--   select id, 'KOLI_SYSADMIN', null from public.profiles where email='kollegium@teszt.hu'
--   on conflict do nothing;
