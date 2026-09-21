-- ============================================================================
-- 72_rbac_actions.sql — akció-szintű jogosultság: modul × művelet × szerepkör
-- ----------------------------------------------------------------------------
-- MI VOLT EDDIG
--   A 39_role_admin.sql óta a role_permission(role_kod, permission) tábla
--   tárolta, melyik szerepkör melyik MENÜPONTOT látja. A permission egy lapos
--   AppView-azonosító ('feed', 'programs', 'echo_admin', …). Művelet-fogalom
--   nem volt: aki látott egy modult, az azon belül mindent tehetett, amit a
--   kódba égetett szerepkör-lista és a 11-es rbac_ policy-k engedtek.
--   Következmény: "olvashat, de nem szerkeszthet" szerepkört nem lehetett
--   létrehozni, és a szerkesztési jog kódba égetett tömbökben élt
--   (app.jsx:1859, :3374 — canEditStatus).
--
-- MI LESZ
--   Modulonként ÖT művelet: VIEW, USE, CREATE, EDIT, DELETE. Szerepkörönként
--   szerkeszthető, és három rétegben kikényszeríthető:
--     1. felület      — features/perm.jsx (PERM_can)
--     2. restriktív RLS — 73_rbac_enforce_rls.sql
--     3. RPC-őrök      — 74_rbac_enforce_rpc.sql
--   Ez a fájl a KÖZÖS ALAP: táblák, seed, backfill, predikátumok, admin RPC-k.
--   Önmagában SEMMIT nem kényszerít ki. A 2. és 3. réteg külön migráció.
--
-- MIT NEM CSINÁL — ÉS EZ A LÉNYEG
--   • NEM változtat senki hozzáférésén. A mátrix kezdőállapota BITRE a mai
--     viselkedés: a 4. szakasz backfillje a role_permission sorokból és a
--     ma kódba égetett menülistákból (app.jsx:12666-12670) dolgozik.
--     Ugyanaz az elv, amit a 11-es és a 39-es fejléce is kimond.
--   • NEM dobja el a role_permission táblát, és nem nyúl a 86 permisszív
--     rbac_ policy-hez. Az új réteg FÖLÉ kerül restriktívként (73), tehát a
--     mai "ki melyik SORT látja" logika érvényben marad.
--   • NEM érinti az echo.role_grant és a dorm.role_grant dimenziót. A 19-es
--     fejléce kimondja: "AZ ECHO-JOG SOHA NEM SZÁRMAZIK A UniPortal
--     SUPERADMIN-BÓL." A modul-mátrix MELLETTÜK él, nem helyettük.
--   • NEM nyúl a másik alkalmazás tábláihoz (prefs, publications,
--     publication_files) — egyetlen táblalistában sem szerepelnek.
--   • NEM vezet be több szerepkört fiókonként. A profiles.role marad egy érték.
--
-- A SZUPERADMIN HOZZÁFÉRÉSE NEM SZERKESZTHETŐ
--   Se a rbac_can(), se a felület nem nézi a táblát SUPERADMIN esetén, és a
--   SUPERADMIN nem is kap sort. Ugyanaz az érv, mint a 39-esben: ha elvehető
--   lenne, ki tudná zárni magát abból a képernyőből is, amivel a hibát
--   javítaná — és nem maradna út vissza.
--
-- MIÉRT rbac_ ELŐTAGGAL
--   A public sémát egy MÁSIK alkalmazás is használja. Egy csupasz
--   public.can(text, text) generikus név, ami pont abba a csapdába lép,
--   amiért a 11-es 0. szakasza létezik. A 0. szakasz itt is előellenőriz.
--
-- ELŐFELTÉTEL: 39_role_admin.sql (role_definition), 11_rbac_additive.sql
--   (is_approved, my_role, is_superadmin).
--
-- VISSZAVONÁS: select public.rbac_actions_rollback();
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt),
--   vagy: Supabase dashboard -> SQL Editor -> New query -> beilleszt -> Run.
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================================

set search_path = public;


-- ============================================================================
-- 0. SZAKASZ — NÉVÜTKÖZÉS-ELŐELLENŐRZÉS
-- ============================================================================
-- A 11-es 0. szakaszának mintájára. A public sémát egy másik alkalmazás is
-- használja, ezért MEGTAGADJUK a futást, ha az általunk létrehozandó nevek
-- közül bármelyik MÁR létezik, de nem a mienk (nem tartalmazza a jelölőt).
-- A jelölő a függvénytörzsben lévő 'rbac_can' / 'rbac_module' szó, illetve a
-- táblákon egy comment.

do $rbac_pre$
declare
  v_utkozes text := '';
  r         record;
begin
  -- ---------- 0.1 függvénynevek ----------
  for r in
    select p.oid::regprocedure::text as sig, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('rbac_can', 'rbac_can_any', 'rbac_require',
                         'rbac_can_role', 'my_module_permissions',
                         'role_action_set', 'role_module_actions_set',
                         'role_matrix', 'module_save', 'rbac_enforce_set',
                         'rbac_enforce_state', 'rbac_actions_rollback')
  loop
    -- A SAJÁT korábbi futásunk nem ütközés: azt a create or replace felülírja.
    -- Jelölő = a törzs hivatkozik a 72-es valamelyik objektumára. Mind a
    -- tizenhárom függvényünk legalább egyre hivatkozik; egy idegen,
    -- véletlenül egyező nevű függvény egyre sem.
    if position('role_module_permission' in r.prosrc) = 0
       and position('module_definition'  in r.prosrc) = 0
       and position('rbac_setting'       in r.prosrc) = 0
       and position('rbac_can'           in r.prosrc) = 0
       and position('rbac_action'        in r.prosrc) = 0 then
      v_utkozes := v_utkozes || '  függvény: ' || r.sig || E'\n';
    end if;
  end loop;

  -- ---------- 0.2 táblanevek ----------
  for r in
    select c.relname, obj_description(c.oid, 'pg_class') as leiras
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm')
       and c.relname in ('module_definition', 'rbac_action', 'rbac_setting',
                         'role_module_permission', 'rbac_permission_audit',
                         'rbacx_table_module', 'rbac_rpc_guard')
  loop
    if coalesce(r.leiras, '') not like '%[UniPortal RBAC]%' then
      v_utkozes := v_utkozes || '  tábla: public.' || r.relname || E'\n';
    end if;
  end loop;

  if v_utkozes <> '' then
    raise exception
      E'MEGTAGADVA — névütközés a public sémában. A public sémát egy MÁSIK\n'
      'alkalmazás is használja, ezért nem írjuk felül az alábbiakat:\n%'
      'Nevezd át a másik alkalmazás objektumait, vagy módosítsd ezt a\n'
      'migrációt más előtagra.', v_utkozes;
  end if;

  raise notice 'Rendben: nincs névütközés.';
end $rbac_pre$;


-- ============================================================================
-- 1. SZAKASZ — TÁBLÁK
-- ============================================================================
-- A művelet-lista TÁBLA és nem enum. Ugyanaz az érv, amit a 19_echo_roles.sql
-- kimond: "az enum bővítése Postgresben nem vonható vissza tranzakción belül,
-- a CHECK igen". Egy táblát ráadásul a felület is le tud kérdezni.

create table if not exists public.rbac_action (
  kod     text primary key,
  nev     text not null,
  sorrend integer not null,
  leiras  text,
  constraint rbac_action_kod_ck check (kod ~ '^[A-Z]{3,12}$')
);

comment on table public.rbac_action is
  '[UniPortal RBAC] A jogosultsági műveletek: VIEW, USE, CREATE, EDIT, DELETE.';

-- ---------------------------------------------------------------------------
-- A modulok katalógusa. A kod SZÁNDÉKOSAN ugyanaz, mint az app.jsx AppView
-- azonosítója és a role_permission.permission értéke — így a menüszűrő régi
-- ága és az új mátrix ugyanarra a kulcsra hivatkozik.
--
-- Az actions oszlop azért kell, mert nem minden modulon értelmes mind az öt
-- művelet: a reports-on nincs DELETE, a consents naplója csak olvasható. A
-- mátrix-felület ebből tudja, mely cellát rajzolja ki EGYÁLTALÁN — enélkül a
-- szuperadmin olyan jogot pipálna be, aminek nincs hatása, és azt hinné, van.
-- ---------------------------------------------------------------------------
create table if not exists public.module_definition (
  kod        text primary key,
  nev        text not null,
  csoport    text,
  sorrend    integer not null default 100,
  aktiv      boolean not null default true,
  actions    text[] not null default array['VIEW'],
  leiras     text,
  updated_at timestamptz not null default now(),
  constraint module_definition_kod_ck check (kod ~ '^[a-z0-9_]{2,40}$'),
  constraint module_definition_actions_ck check (array_length(actions, 1) >= 1)
);

comment on table public.module_definition is
  '[UniPortal RBAC] A modulok katalógusa. A kod az app.jsx AppView azonosítója.';
comment on column public.module_definition.csoport is
  'Az app.jsx MENU_GROUPS kulcsa — a mátrix ez szerint csoportosít.';
comment on column public.module_definition.actions is
  'Mely műveletek ÉRTELMESEK ezen a modulon. A felület csak ezeket rajzolja ki.';

-- ---------------------------------------------------------------------------
-- A mátrix maga. Egy sor = egy szerepkör egy modulon egy műveletet végezhet.
-- A SUPERADMIN-nak SZÁNDÉKOSAN nincs sora: a rbac_can() nála a táblát meg sem
-- nézi (lásd 3. szakasz).
-- ---------------------------------------------------------------------------
create table if not exists public.role_module_permission (
  role_kod   text not null references public.role_definition(kod) on delete cascade,
  module_kod text not null references public.module_definition(kod) on delete cascade,
  action     text not null references public.rbac_action(kod),
  granted_by uuid,
  granted_at timestamptz not null default now(),
  primary key (role_kod, module_kod, action)
);

comment on table public.role_module_permission is
  '[UniPortal RBAC] szerepkör × modul × művelet. A SUPERADMIN-nak nincs sora.';

create index if not exists role_module_permission_lookup_idx
  on public.role_module_permission (role_kod, module_kod, action);

-- ---------------------------------------------------------------------------
-- VÉSZKAPCSOLÓ. Egyetlen UPDATE kinyitja MINDKÉT kikényszerítési réteget
-- (a restriktív RLS-t és az RPC-őröket is), mert mindkettő a rbac_can()-ra
-- épül. Se DDL, se zárolás, se deploy, se PostgREST-újratöltés.
--
-- MIÉRT NEM session-GUC (current_setting('app.rbac', true)):
--   az munkamenetenkénti és nem tartós, ráadásul BÁRMI átállíthatja, ami SET-et
--   tud kiadni — vagyis maga a kliens is. Egy vészkapcsoló, amit a védett fél
--   is elhúzhat, nem vészkapcsoló.
-- ---------------------------------------------------------------------------
create table if not exists public.rbac_setting (
  kulcs      text primary key,
  ertek      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table public.rbac_setting is
  '[UniPortal RBAC] Vészkapcsoló. rbacx_enforce = on|off. Csak szuperadmin.';

-- ---------------------------------------------------------------------------
-- Napló. Append-only: csak INSERT policy készül rá, UPDATE/DELETE nem — a
-- 11-es auditLogs mintájára, ahol ez szintén szándékos.
-- A neve azért rbac_permission_audit és nem rbac_audit, hogy a 11-es
-- rbac_auditlogs_* POLICY-neveivel ne keveredjen össze olvasáskor.
-- ---------------------------------------------------------------------------
create table if not exists public.rbac_permission_audit (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  altal      uuid,
  altal_email text,
  role_kod   text,
  module_kod text,
  action     text,
  megadva    boolean,
  megjegyzes text
);

comment on table public.rbac_permission_audit is
  '[UniPortal RBAC] Jogosultság-változások naplója. Append-only.';

create index if not exists rbac_permission_audit_at_idx
  on public.rbac_permission_audit (at desc);


-- ============================================================================
-- 2. SZAKASZ — A MŰVELETEK ÉS A MODULOK SEEDJE
-- ============================================================================

-- ---------- 2.1 az öt művelet ----------
-- A szemantikát itt írjuk le EGY helyen, mert a felület a leírást megjeleníti.
-- A USE azért külön művelet a VIEW-tól, mert sok modulon van olyan lépés, ami
-- nem rekord-CRUD (interjúfoglalás, kérdőív-beküldés, riport-export, döntés).
-- Aki csak olvasni jöhet be, annak ezeket sem szabad.
insert into public.rbac_action (kod, nev, sorrend, leiras) values
  ('VIEW',   'Megtekintés', 10,
   'A modul megnyitható és adatai olvashatók. Enélkül a menüpont sem látszik.'),
  ('USE',    'Használat',   20,
   'A modul munkafolyamat-műveletei: beküldés, foglalás, export, döntés, üzenetküldés. Nem rekord-CRUD.'),
  ('CREATE', 'Létrehozás',  30, 'Új rekord létrehozása.'),
  ('EDIT',   'Szerkesztés', 40, 'Meglévő rekord módosítása.'),
  ('DELETE', 'Törlés',      50, 'Rekord törlése.')
on conflict (kod) do update
  set nev = excluded.nev, sorrend = excluded.sorrend, leiras = excluded.leiras;

-- ---------- 2.2 a vészkapcsoló alapállása ----------
-- 'on' = a kikényszerítés él. A 72-es önmagában nem kényszerít ki semmit,
-- tehát ez itt még nem érezhető; a 73/74-es fogja használni.
insert into public.rbac_setting (kulcs, ertek) values ('rbacx_enforce', 'on')
on conflict (kulcs) do nothing;

-- ---------- 2.3 a 26 modul ----------
-- A lista BETŰRE az app.jsx MENU_ITEMS-e (:79-110), a csoport az ottani
-- MENU_GROUPS (:117-126), a sorrend a MENU_ITEMS sorrendje.
--
-- Az actions oszlop indoklása modulonként ott áll, ahol nem mind az öt szerepel.
-- Az elv: csak azt a műveletet vesszük fel, amire a modulon TÉNYLEGESEN van
-- mit kapcsolni. Egy be nem pipálható cella hamis biztonságérzet; egy hatás
-- nélkül bepipálható cella pedig hamis jogosultság-érzet.
insert into public.module_definition (kod, nev, csoport, sorrend, actions, leiras) values
  ('feed',            'Hírfolyam',                'altalanos', 10,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Kampusz-hírfolyam: hírek, események, jegyigénylés.'),
  ('programs',        'Programok',                'kepzes',    20,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Programkatalógus és a rá adott jelentkezések.'),
  ('trainings',       'Képzések',                 'kepzes',    30,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Féléves képzések. Ugyanaz a nézet, más hatókör (scope=degrees).'),
  ('courses',         'Kurzusok',                 'kepzes',    40,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Kurzusnyilvántartás és kurzusfelvétel.'),
  -- teachers: USE nincs — az oktatói nyilvántartás tisztán törzsadat-CRUD,
  -- nincs rajta munkafolyamat-lépés, amit külön engedélyezni lehetne.
  ('teachers',        'Oktatók',                  'kepzes',    50,
   array['VIEW','CREATE','EDIT','DELETE'],
   'Oktatói nyilvántartás (törzsadat).'),
  ('assistant',       'AI Asszisztens',           'altalanos', 60,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'AI asszisztens és a hozzá tartozó tudásbázis (kb_documents).'),
  ('agent_portal',    'Ügynök és partner portál', 'partner',   70,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Ügynökségek, jutalékperiódusok, partnerszámlák.'),
  ('admissions_core', 'Jelentkezés és Felvételi', 'felveteli', 80,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'A felvételi folyamat, a jelentkezők és a hozzájuk tartozó levelezés.'),
  ('engagement_crm',  'Kommunikáció és CRM',      'partner',   90,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Kampányok, üzenetküldés, WhatsApp.'),
  ('finance',         'Pénzügyek',                'penzugy',  100,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Díjak, befizetések, számlák, integrációk.'),
  -- immigration / evaluation: CREATE és DELETE nincs. A vízum-checklist és a
  -- bírálat a students soron BELÜLI JSONB (visaChecklist, evaluation), nem
  -- önálló rekord — létrehozni és törölni nincs mit.
  ('immigration',     'Vízum és Compliance',      'felveteli', 110,
   array['VIEW','USE','EDIT'],
   'Vízumügyintézés és megfelelőség. A checklist a jelentkező során belül él.'),
  ('evaluation',      'Felvételi Bírálat',        'felveteli', 120,
   array['VIEW','USE','EDIT'],
   'Felvételi bírálat és pontozás. A students.evaluation JSONB-ben él.'),
  ('interviews',      'Interjú Foglalás',         'felveteli', 130,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Interjú-idősávok, elérhetőség, foglalás, felvételek.')
on conflict (kod) do update
  set nev = excluded.nev, csoport = excluded.csoport, sorrend = excluded.sorrend,
      actions = excluded.actions, leiras = excluded.leiras, updated_at = now();

insert into public.module_definition (kod, nev, csoport, sorrend, actions, leiras) values
  ('marketing_leads', 'Marketing és Lead kezelés', 'partner',   140,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Érdeklődők és marketingkampányok.'),
  -- student_portal: DELETE nincs — a 11-es rbac_program_applications_delete
  -- szándékosan csak ügyintézőnek engedi: "egy beadott jelentkezést a
  -- jelentkező ne tüntethessen el, miután elbírálás alá került".
  ('student_portal',  'Hallgatói Portál',          'felveteli', 150,
   array['VIEW','USE','CREATE','EDIT'],
   'A jelentkező és a hallgató saját felülete.'),
  -- reports / intelligence: olvasó modulok, nincs saját rekordjuk.
  -- A USE itt az EXPORTÁLÁS — azt külön kell tudni engedélyezni, mert az
  -- adatot visz ki az intézményből.
  ('reports',         'Riportok',                  'penzugy',  160,
   array['VIEW','USE'],
   'Riportok megtekintése és exportálása. A USE az exportálás.'),
  ('intelligence',    'Intelligence',              'penzugy',  170,
   array['VIEW','USE'],
   'Adatminőség, biztonság, csalásmegelőzés.'),
  ('system_admin',    'Rendszerkezelés',           'rendszer', 180,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Eseménynapló, jogosultsági mátrix, API és webhookok.'),
  -- registrations: CREATE és DELETE nincs. Fiókot a regisztráció hoz létre,
  -- fiókot pedig nem törlünk: az elutasítás STÁTUSZ (approval_status), nem
  -- sortörlés — a 07-es óta így van. A USE a jóváhagyás/elutasítás, az EDIT a
  -- szerepkör- és besorolás-módosítás.
  ('registrations',   'Regisztrációk',             'rendszer', 190,
   array['VIEW','USE','EDIT'],
   'Regisztrációk jóváhagyása, szerepkörök és csoportok kiosztása.'),
  -- echo_student: a kitöltő. A USE a beküldés. CRUD nincs rajta: a válasz
  -- anonim és megváltoztathatatlan (15/21/23-as migráció).
  ('echo_student',    'Kurzusértékelés',           'echo',     200,
   array['VIEW','USE'],
   'Kurzusértékelő kérdőív kitöltése (OMHV).'),
  ('echo_admin',      'ECHO kampányok',            'echo',     210,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'ECHO kampánykezelés, kérdőívek, moderálás.'),
  ('echo_teacher',    'Oktatói eredmények',        'echo',     220,
   array['VIEW','USE'],
   'Oktatói eredménynézet és visszajelzés.'),
  ('dorm_ops',        'Kollégium',                 'kollegium', 230,
   array['VIEW','USE','CREATE','EDIT','DELETE'],
   'Kollégiumi üzemeltetés: épületek, szobák, elhelyezés.'),
  -- dorm_maintenance: DELETE nincs — a hibabejelentés és a hozzá tartozó
  -- esemény-napló (dorm.issue_event) nem tüntethető el.
  ('dorm_maintenance','Karbantartás',              'kollegium', 240,
   array['VIEW','USE','CREATE','EDIT'],
   'Kollégiumi hibabejelentések és karbantartás.'),
  ('dorm_student',    'Szállásom',                 'kollegium', 250,
   array['VIEW','USE'],
   'A lakó saját kollégiumi felülete.'),
  -- consents: napló. Se USE, se CRUD — a consent_log a 59-es
  -- consent_log_immutable triggere szerint eleve megváltoztathatatlan.
  ('consents',        'Hozzájárulási napló',       'rendszer', 260,
   array['VIEW'],
   'Jogi hozzájárulások naplója. Csak olvasható.')
on conflict (kod) do update
  set nev = excluded.nev, csoport = excluded.csoport, sorrend = excluded.sorrend,
      actions = excluded.actions, leiras = excluded.leiras, updated_at = now();

-- A dorm_* és echo_* modulokon a modul-mátrix SZÁNDÉKOSAN csak a menü-
-- láthatóságot (VIEW) vezérli: ott az elsődleges kapu a saját, hatókörös
-- grant-dimenzió (echo.role_grant, dorm.role_grant). Két, külön seedelt kapu
-- előbb-utóbb ellentmondana egymásnak.

do $rbac_modcheck$
declare n int; m int;
begin
  select count(*) into n from public.module_definition where aktiv;
  select count(*) into m from public.rbac_action;
  if n < 26 then
    raise exception 'A modul-seed nem teljes: % aktív modul, elvárt legalább 26.', n;
  end if;
  if m <> 5 then
    raise exception 'A művelet-seed nem teljes: % művelet, elvárt 5.', m;
  end if;
  raise notice 'Rendben: % aktív modul, % művelet.', n, m;
end $rbac_modcheck$;


-- ============================================================================
-- 3. SZAKASZ — A KÖZPONTI PREDIKÁTUMOK
-- ============================================================================
-- Mind SECURITY DEFINER és rögzített search_path, a 11-es 1. szakaszának
-- mintájára: a profiles saját RLS-ét megkerülik, így nincs rekurzió, amikor
-- egy profiles-policy vagy egy másik tábla policy-je hívja őket.
--
-- A szerepkört a PROFILES SORBÓL olvassuk (my_role()), NEM a JWT-ből — a
-- 11-es fejléce ezt kimondja: "a JWT claim-ek a token élettartama alatt nem
-- frissülnek, egy visszavont szerepkör így még órákig érvényes maradna".

-- ---------------------------------------------------------------------------
-- 3.1 rbac_can() — az egyetlen igazságforrás
-- ---------------------------------------------------------------------------
-- Három ág, ebben a sorrendben:
--
--   0. VÉSZKAPCSOLÓ. Ha a rbac_setting.rbacx_enforce nem 'on', a függvény
--      MINDENRE igazat ad. Mivel a rbac_require() és a 73-as restriktív
--      policy-k is ezt hívják, egyetlen UPDATE kinyitja mindkét réteget.
--      Se DDL, se zárolás, se deploy, se PostgREST-újratöltés.
--
--   1. SUPERADMIN. A táblát meg sem nézzük. Ez nem kényelmi döntés: ha a
--      szuperadmin jogát a mátrixból el lehetne venni, ki tudná zárni magát
--      abból a képernyőből is, amivel visszaállítaná.
--
--   2. Jóváhagyott fiók ÉS van illeszkedő sor. Az is_approved() BEÉPÜL ide —
--      nem redundancia: így egyetlen hívó sem felejtheti el, és egy 'pending'
--      fiók a mátrixban kapott jogokkal sem ér el semmit. A has_role()-t
--      szándékosan NEM hívjuk: az szerepkör-listát vár, nem modult.
--
-- A rd.aktiv és md.aktiv join azért kell, hogy egy kikapcsolt szerepkör vagy
-- modul azonnal hatástalanná váljon, a sorok törlése nélkül.
create or replace function public.rbac_can(p_module text, p_action text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    coalesce((select s.ertek from public.rbac_setting s
               where s.kulcs = 'rbacx_enforce'), 'on') <> 'on'
    or public.is_superadmin()
    or (public.is_approved() and exists (
          select 1
            from public.role_module_permission rmp
            join public.role_definition   rd on rd.kod = rmp.role_kod   and rd.aktiv
            join public.module_definition md on md.kod = rmp.module_kod and md.aktiv
           where rmp.role_kod   = public.my_role()
             and rmp.module_kod = p_module
             and rmp.action     = upper(p_action)))
$$;

comment on function public.rbac_can(text, text) is
  'Igaz, ha a bejelentkezett fiók a megadott modulon a megadott műveletet végezheti.';

-- ---------------------------------------------------------------------------
-- 3.2 rbac_can_any() — több modul VAGY-kapcsolata
-- ---------------------------------------------------------------------------
-- A 73-as restriktív policy-i ezt hívják. MIÉRT KELL: egy tábla több modulhoz
-- tartozhat. A "leads" az ügyintézőnek marketing_leads, a "students" a
-- jelentkezőnek student_portal és az ügyintézőnek admissions_core. Egyetlen
-- modulra szűkíteni azt jelentené, hogy a hallgatónak 'admissions_core:EDIT'-et
-- kellene adni — ami a mátrixon félrevezető, és a jog hatóköre is nagyobb
-- lenne a szükségesnél.
create or replace function public.rbac_can_any(p_modules text[], p_action text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from unnest(coalesce(p_modules, '{}'::text[])) m
     where public.rbac_can(m, p_action)
  )
$$;

-- ---------------------------------------------------------------------------
-- 3.3 rbac_require() — a kikényszerítés az RPC-kben
-- ---------------------------------------------------------------------------
-- A 42501 (insufficient_privilege) SQLSTATE szándékos: a felület
-- hibafordítója (features/roles.jsx ROLE_PGERR, és a többi modul párja) ezt
-- már ma is "Ehhez a művelethez nincs jogosultsága"-ra fordítja.
create or replace function public.rbac_require(p_module text, p_action text)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.rbac_can(p_module, p_action) then
    raise exception 'Ehhez a művelethez nincs jogosultsága (% / %).',
      p_module, upper(p_action) using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3.4 rbac_can_role() — szerepkör-paraméteres változat, A VERIFIKÁCIÓHOZ
-- ---------------------------------------------------------------------------
-- MIÉRT KELL: a 72/73 bevezetésének fő bizonyítéka az, hogy MIND A HAT
-- szerepkör megkapta a mai jogait. Azt JWT-imitáció nélkül csak így lehet
-- végigmérni egy lekérdezéssel. A jóváhagyás-vizsgálat itt NINCS benne: ez
-- nem hozzáférési kapu, hanem mérőeszköz — a bejelentkezett fiók jogát
-- továbbra is kizárólag a rbac_can() dönti el.
create or replace function public.rbac_can_role(p_role text, p_module text, p_action text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_role = 'SUPERADMIN'
     or exists (
          select 1
            from public.role_module_permission rmp
            join public.role_definition   rd on rd.kod = rmp.role_kod   and rd.aktiv
            join public.module_definition md on md.kod = rmp.module_kod and md.aktiv
           where rmp.role_kod   = p_role
             and rmp.module_kod = p_module
             and rmp.action     = upper(p_action))
$$;

comment on function public.rbac_can_role(text, text, text) is
  'Mérőeszköz a verifikációhoz: adott SZEREPKÖR jogát adja vissza, nem a hívóét.';

-- ---------------------------------------------------------------------------
-- 3.5 my_module_permissions() — a felület EGY hívásból megkapja a teljes képet
-- ---------------------------------------------------------------------------
-- Alak: { "feed": ["VIEW","USE","CREATE"], "finance": ["VIEW"], … }
-- SUPERADMIN-nál: { "*": ["VIEW","USE","CREATE","EDIT","DELETE"] } — a
-- csillag azt jelenti, hogy minden modulon minden szabad. A felület
-- (features/perm.jsx) ezt a kulcsot külön kezeli, és így NEM kell 26 × 5
-- sort átküldeni annak, akinek mindent szabad.
--
-- MIÉRT jsonb és nem táblás visszatérés: a loadProfile egyetlen rpc()-hívással
-- tölti be, a másik négy jogosultság-RPC mintája szerint (app.jsx:12291-12354).
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
      (select jsonb_object_agg(x.module_kod, x.actions)
         from (select rmp.module_kod,
                      jsonb_agg(rmp.action order by ra.sorrend) as actions
                 from public.role_module_permission rmp
                 join public.role_definition   rd on rd.kod = rmp.role_kod   and rd.aktiv
                 join public.module_definition md on md.kod = rmp.module_kod and md.aktiv
                 join public.rbac_action       ra on ra.kod = rmp.action
                where rmp.role_kod = public.my_role()
                group by rmp.module_kod) x),
      '{}'::jsonb)
  end
$$;

comment on function public.my_module_permissions() is
  'A hívó teljes jogosultsági képe egy jsonb objektumban. SUPERADMIN-nál {"*": [...]}.';

-- ---------------------------------------------------------------------------
-- 3.6 A szerveroldali hívó nem zárható ki — de NEM itt engedjük be
-- ---------------------------------------------------------------------------
-- A deploy/make-superadmin.sh, a deploy/reset-data.sql és a migrációk JWT
-- NÉLKÜL hívnak, ahol az auth.uid() NULL, tehát a rbac_can() hamis.
-- A 67-es migráció is_trusted_caller() függvénye pont ezt a helyzetet
-- ismeri fel (nincs request.method / request.jwt.claims GUC).
--
-- A kikényszerítés ezért a HÍVÓ OLDALON ágazik el, a 74-es mintája szerint:
--     if not public.is_trusted_caller() then
--       perform public.rbac_require('finance', 'EDIT');
--     end if;
--
-- MIÉRT NEM a rbac_can()-ba építjük be: a rbac_can() a 73-as RLS-kifejezéseiben
-- is szerepel, és ott a "megbízható hívó" fogalom nem adhat jogot — a
-- service_role és a táblatulajdonos amúgy is megkerüli az RLS-t, tehát
-- odatenni csak gyengítés lenne, haszon nélkül.


-- ============================================================================
-- 4. SZAKASZ — BACKFILL: "A MAI ÁLLAPOT RÖGZÍTÉSE"
-- ============================================================================
-- Ez a szakasz a migráció lelke. A 39-es fejléce ugyanezt így mondja ki:
-- "A KIINDULÁS BITRE AZONOS a mai beégetett listákkal — a migráció önmagában
-- egyetlen felhasználó láthatóságán sem változtat."
--
-- Négy lépés:
--   4.1  role_permission -> VIEW + USE        (a mai menü-láthatóság)
--   4.2  a KÓDBA ÉGETETT menüágak -> VIEW+USE (amit a role_permission nem tud)
--   4.3  ADMIN -> minden modulon minden       (ma is mindent lát és tehet)
--   4.4  CREATE / EDIT / DELETE a többieknek, a mai RLS és RPC szerint
--
-- A SUPERADMIN SZÁNDÉKOSAN nem kap egyetlen sort sem.

-- ---------------------------------------------------------------------------
-- 4.1 A mai menü-láthatóság: role_permission -> VIEW és USE
-- ---------------------------------------------------------------------------
-- MIÉRT JÁR A USE IS AUTOMATIKUSAN: ma nincs művelet-fogalom, tehát aki látja
-- a modult, az a modul munkafolyamat-lépéseit is használja (foglal, beküld,
-- exportál). Ha itt csak VIEW-t adnánk, a bevezetés ELVENNE valamit — épp azt,
-- amit a fejléc megtilt. A szűkítés a szuperadmin dolga, kattintással.
insert into public.role_module_permission (role_kod, module_kod, action)
select rp.role_kod, rp.permission, a.kod
  from public.role_permission rp
  join public.module_definition md on md.kod = rp.permission
  cross join (values ('VIEW'), ('USE')) as a(kod)
 where rp.role_kod <> 'SUPERADMIN'
   and a.kod = any (md.actions)
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbacx_backfill_complete')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4.2 A kódba égetett menüágak (app.jsx:12583-12650)
-- ---------------------------------------------------------------------------
-- Ezek a modulok a menüszűrőben a role_permission-tól FÜGGETLENÜL, kódba
-- égetett szerepkör-listával dőlnek el — tehát a role_permission-ban nincs
-- róluk sor, mégis látszanak. Ha nem vennénk fel őket, a 4. blokk akció-szintű
-- gombtiltása elvenné a Kurzusok/Oktatók/ECHO/Kollégium műveleteit azoktól,
-- akik ma használják.
--
-- A menüszűrő ezeknél a VIEW-nál ELŐBB dönt, és úgy is marad: azok saját
-- biztonsági szabályok (ECHO- és kollégiumi grantok), nem mátrix-kérdés.
-- Ezek a sorok tehát nem a menüt vezérlik, hanem a MŰVELETEKET rajtuk.
insert into public.role_module_permission (role_kod, module_kod, action)
select v.szerep, v.modul, a.kod
  from (values
    -- teachers: az ügyintézői négyes (app.jsx:12603-12605). A hallgató és az
    -- oktató SZÁNDÉKOSAN nem látja: nekik nincs mit kezdeniük a törzsadattal.
    ('ADMISSIONS', 'teachers'),      ('FINANCE', 'teachers'),
    -- courses: ügyintéző + hallgató (app.jsx:12606-12613). A hallgató MÁST lát
    -- (a saját kurzusait, CRS_StudentView), de ugyanazt a modult.
    ('ADMISSIONS', 'courses'),       ('FINANCE', 'courses'),
    ('STUDENT',    'courses'),
    -- echo_student: mindenki az AGENT kivételével (app.jsx:12595-12598).
    ('ADMISSIONS', 'echo_student'),  ('FINANCE', 'echo_student'),
    ('STUDENT',    'echo_student'),
    -- echo_teacher: az ügyintézői négyes (app.jsx:12627-12630).
    ('ADMISSIONS', 'echo_teacher'),  ('FINANCE', 'echo_teacher'),
    -- dorm_student: mindenki az AGENT kivételével (app.jsx:12648).
    ('ADMISSIONS', 'dorm_student'),  ('FINANCE', 'dorm_student'),
    ('STUDENT',    'dorm_student')
  ) as v(szerep, modul)
  join public.module_definition md on md.kod = v.modul
  cross join (values ('VIEW'), ('USE')) as a(kod)
 where a.kod = any (md.actions)
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbacx_backfill_complete')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4.3 ADMIN: minden modulon minden művelet
-- ---------------------------------------------------------------------------
-- A 39-es is így tette: "Az ADMIN és a SUPERADMIN eddig MINDENT látott. Az
-- ADMIN-nak ezt kiírjuk, hogy szerkeszthető legyen; a SUPERADMIN-t
-- szándékosan NEM — az ő hozzáférése nem a táblából jön."
insert into public.role_module_permission (role_kod, module_kod, action)
select 'ADMIN', md.kod, a.kod
  from public.module_definition md
  cross join unnest(md.actions) as a(kod)
 where exists (select 1 from public.role_definition where kod = 'ADMIN')
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbacx_backfill_complete')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4.4 CREATE / EDIT / DELETE — a mai RLS és RPC szerint, soronként indokolva
-- ---------------------------------------------------------------------------
-- Minden sor mellé odaírjuk, MELYIK mai szabály indokolja. Ez nem
-- dokumentációs fényűzés: a 73-as restriktív policy-i ezekre a sorokra
-- támaszkodnak, és ha valaki egy sort "kijavít", a mérés megmondja, mi
-- romlott el — de csak akkor, ha tudja, miért volt ott.
--
-- AMI ELSŐ OLVASATRA FURCSA, ÉS MÉGIS HELYES
--   A modul-szemcsézettség DURVÁBB, mint a permisszív rétegé. Ezért a FINANCE
--   megkap olyan jogot, aminek a menüjében nyoma sincs (admissions_core), és
--   az ADMISSIONS olyat, aminek a permisszív padlója amúgy sem engedi
--   (marketing_leads DELETE a marketingCampaigns táblán).
--   EZ KONSTRUKCIÓBÓL BIZTONSÁGOS: a permisszív rbac_ réteg a PADLÓ, a
--   restriktív rbacx_ réteg csak KIVONNI tud. Egy modul-jog tehát nem ad
--   hozzáférést, csak nem vesz el. A mátrix-felület ezt kiírja, hogy senki ne
--   "javítsa ki".
--
-- AGENT: SZÁNDÉKOSAN egyetlen sor sem szerepel alább. Az ügynök ma egyetlen
--   táblán sem ír: az agencies írása is_admin(), a students és a
--   program_applications felé pedig csak OLVASÁSA van
--   (is_my_agency_student_email). A VIEW és a USE a 4.1-ből megvan.
-- Átmeneti tábla, a 99_harden_grants.sql mintájára (nincs "on commit drop":
-- így a fájl a Supabase SQL Editorban is fut, ahol a szakaszok külön
-- tranzakcióba eshetnek).
create temporary table if not exists _rbac_cud (
  szerep text, modul text, muvelet text
);
truncate _rbac_cud;

-- ---------- ADMISSIONS (is_admissions + is_staff) ----------
insert into _rbac_cud values
  -- feed: rbac_feed_posts_insert/update/delete = is_admissions() (11:766-772).
  -- Az insert-et a 69_feed_audience.sql újraírja, ugyanazzal a kapuval.
  ('ADMISSIONS', 'feed',            'CREATE'),
  ('ADMISSIONS', 'feed',            'EDIT'),
  ('ADMISSIONS', 'feed',            'DELETE'),
  -- programs: rbac_programs_insert/update = is_admissions() (11, 9.1 hurok).
  -- DELETE NEM: a rbac_programs_delete is_admin(). Egy program kivétele a
  -- katalógusból visszafordíthatatlan, és jelentkezések függnek tőle.
  ('ADMISSIONS', 'programs',        'CREATE'),
  ('ADMISSIONS', 'programs',        'EDIT'),
  -- A programs tábla degree sorai a Képzések modulhoz tartoznak.
  ('ADMISSIONS', 'trainings',       'CREATE'),
  ('ADMISSIONS', 'trainings',       'EDIT'),
  -- admissions_core: rbac_students_insert/update = is_staff() (11:631,635);
  -- rbac_process_messages_delete és rbac_program_applications_delete = is_staff()
  -- (11:691,883). A students DELETE is_admin() — az a permisszív padló dolga.
  ('ADMISSIONS', 'admissions_core', 'CREATE'),
  ('ADMISSIONS', 'admissions_core', 'EDIT'),
  ('ADMISSIONS', 'admissions_core', 'DELETE'),
  -- evaluation / immigration: a bírálat és a vízum-checklist a students soron
  -- BELÜL él (evaluation, visaChecklist JSONB). Az írást a
  -- rbac_students_update = is_staff() engedi, a jelentkezőt pedig a
  -- students_protect_identity_trg zárja ki ezekből az oszlopokból (11, 10.1).
  ('ADMISSIONS', 'evaluation',      'EDIT'),
  ('ADMISSIONS', 'immigration',     'EDIT'),
  -- interviews: rbac_interviewslots_insert/delete = is_staff() (11:510,516);
  -- rbac_videointerviewquestions_insert/update = is_admissions() (11:458).
  -- A videoInterviewQuestions DELETE is_admin() — padló.
  ('ADMISSIONS', 'interviews',      'CREATE'),
  ('ADMISSIONS', 'interviews',      'EDIT'),
  ('ADMISSIONS', 'interviews',      'DELETE'),
  -- engagement_crm: rbac_campaigns_insert/update = is_admissions() (11, 3.3).
  -- DELETE NEM: a rbac_campaigns_delete is_admin().
  ('ADMISSIONS', 'engagement_crm',  'CREATE'),
  ('ADMISSIONS', 'engagement_crm',  'EDIT'),
  -- marketing_leads: rbac_leads_insert/update/DELETE mind is_admissions()
  -- (11, 3.6) — a leads a kevés tábla, ahol az ADMISSIONS törölhet is.
  ('ADMISSIONS', 'marketing_leads', 'CREATE'),
  ('ADMISSIONS', 'marketing_leads', 'EDIT'),
  ('ADMISSIONS', 'marketing_leads', 'DELETE'),
  -- assistant: a tudásbázis (kb_documents) a 9.1 hurokban van a programs-szal
  -- együtt: insert/update = is_admissions(), delete = is_admin().
  ('ADMISSIONS', 'assistant',       'CREATE'),
  ('ADMISSIONS', 'assistant',       'EDIT'),
  -- courses / teachers: az echo_course_save, az echo_course_delete és az
  -- echo_teacher_save mind is_staff()-ot kér (43, 54). Az echo_teacher_delete
  -- viszont is_admin() — ezért a teachers DELETE itt nem szerepel.
  ('ADMISSIONS', 'courses',         'CREATE'),
  ('ADMISSIONS', 'courses',         'EDIT'),
  ('ADMISSIONS', 'courses',         'DELETE'),
  ('ADMISSIONS', 'teachers',        'CREATE'),
  ('ADMISSIONS', 'teachers',        'EDIT');

-- ---------- FINANCE (is_finance + is_staff) ----------
insert into _rbac_cud values
  -- event_rsvps/ticket_claims UPDATE = is_staff(); a feed_posts írását
  -- továbbra is az is_admissions() permisszív kapu szűkíti.
  ('FINANCE', 'feed',            'EDIT'),
  -- finance: rbac_payments_insert/update/delete és
  -- rbac_invoices_insert/update/delete mind is_finance() (11:555-582).
  ('FINANCE', 'finance',         'CREATE'),
  ('FINANCE', 'finance',         'EDIT'),
  ('FINANCE', 'finance',         'DELETE'),
  -- interviews: rbac_interviewslots_insert/update/delete = is_staff() (11, 4.1).
  ('FINANCE', 'interviews',      'CREATE'),
  ('FINANCE', 'interviews',      'EDIT'),
  ('FINANCE', 'interviews',      'DELETE'),
  -- admissions_core: EZ AZ A HÁROM SOR, AMI FURCSÁN NÉZ KI — ÉS MÉGIS KELL.
  -- A rbac_students_insert = is_staff(), és az is_staff() TARTALMAZZA a
  -- FINANCE-t (11:295). Ezt nem ez a migráció döntötte el: a 11-es fejléce
  -- (B) pontja írja le, miért — a markPaymentPaid a students.status-t is
  -- írja, tehát a pénzügy hozzáér a jelentkezői sorhoz. Ugyanez a
  -- process_messages és a program_applications írására és törlésére.
  -- A FINANCE-nak ehhez NINCS admissions_core VIEW-ja, és nem is kap: a
  -- menüje nem változik. A mátrix két tengelye szándékosan független, és a
  -- felület ezt ki is írja.
  ('FINANCE', 'admissions_core', 'CREATE'),
  ('FINANCE', 'admissions_core', 'EDIT'),
  ('FINANCE', 'admissions_core', 'DELETE'),
  -- courses / teachers: ua., mint az ADMISSIONS-nál — is_staff().
  ('FINANCE', 'courses',         'CREATE'),
  ('FINANCE', 'courses',         'EDIT'),
  ('FINANCE', 'courses',         'DELETE'),
  ('FINANCE', 'teachers',        'CREATE'),
  ('FINANCE', 'teachers',        'EDIT');

-- ---------- STUDENT ----------
insert into _rbac_cud values
  -- student_portal: a jelentkező a SAJÁT sorát hozza létre és írja —
  -- rbac_program_applications_insert/update (11:876,879),
  -- rbac_admission_processes_insert/update (11:665,668),
  -- rbac_students_update (11:635, id- vagy e-mail-egyezésre).
  -- A SOR-KAPUT a permisszív réteg tartja: ez a jog nem nyit idegen sort.
  -- DELETE NINCS: a 11-es kimondja, hogy "egy beadott jelentkezést a
  -- jelentkező ne tüntethessen el, miután elbírálás alá került".
  ('STUDENT', 'student_portal', 'CREATE'),
  ('STUDENT', 'student_portal', 'EDIT');

-- ---------- a bejegyzés ----------
-- A md.actions szűrő azért kell, hogy egy elírás (pl. 'reports'/'DELETE')
-- ne tudjon hatás nélküli sort létrehozni: csak a modulon ÉRTELMES művelet
-- kerül be. Ami kimarad, arra a lenti ellenőrzés figyelmeztet.
insert into public.role_module_permission (role_kod, module_kod, action)
select c.szerep, c.modul, c.muvelet
  from _rbac_cud c
  join public.role_definition   rd on rd.kod = c.szerep
  join public.module_definition md on md.kod = c.modul
 where c.muvelet = any (md.actions)
   and not exists (select 1 from public.rbac_setting where kulcs = 'rbacx_backfill_complete')
on conflict do nothing;

do $rbac_cudcheck$
declare v_kihagyva text;
begin
  select string_agg(format('%s/%s/%s', c.szerep, c.modul, c.muvelet), ', ')
    into v_kihagyva
    from _rbac_cud c
    left join public.role_definition   rd on rd.kod = c.szerep
    left join public.module_definition md on md.kod = c.modul
   where rd.kod is null
      or md.kod is null
      or not (c.muvelet = any (md.actions));
  if v_kihagyva is not null then
    raise warning 'A backfillből KIMARADT (nem létező szerepkör/modul, vagy a modulon nem értelmes művelet): %', v_kihagyva;
  end if;
end $rbac_cudcheck$;

-- A backfill csak egyszer fut: egy újrafuttatás nem adhatja vissza a
-- szuperadmin által azóta elvett VIEW/USE/CREATE/EDIT/DELETE jogokat.
insert into public.rbac_setting(kulcs, ertek)
values ('rbacx_backfill_complete', 'on') on conflict do nothing;


-- ============================================================================
-- 5. SZAKASZ — VISSZAFELÉ KOMPATIBILITÁS
-- ============================================================================
-- A 39-es két függvénye a role_permission táblát olvasta/írta. Innentől az új
-- mátrix VIEW-sorai a forrás, hogy EGY igazságforrás legyen.
--
-- MIÉRT NEM DOBJUK EL A role_permission TÁBLÁT:
--   • egy még nem frissített bundle (a böngésző gyorsítótárából) továbbra is
--     hívhatja a role_permission_set-et és olvashatja a táblát;
--   • a 39-es role_admin_rollback() útja így épen marad.
--   A tábla tehát MEGMARAD, de innentől senki nem olvassa döntéshez.

-- ---------- 5.1 my_role_permissions(): a VIEW-sorokból ----------
-- A viselkedés BETŰRE ugyanaz, mint a 39-esben: SUPERADMIN-nál null (a
-- menüszűrő nála meg sem nézi), egyébként a modulok tömbje.
create or replace function public.my_role_permissions()
returns text[]
language sql stable security definer set search_path = public
as $$
  select case
    when public.my_role() = 'SUPERADMIN' then null
    else (select array_agg(distinct rmp.module_kod order by rmp.module_kod)
            from public.role_module_permission rmp
            join public.role_definition   rd on rd.kod = rmp.role_kod   and rd.aktiv
            join public.module_definition md on md.kod = rmp.module_kod and md.aktiv
           where rmp.role_kod = public.my_role()
             and rmp.action   = 'VIEW')
  end
$$;

comment on function public.my_role_permissions() is
  '[UniPortal RBAC] A 39-es függvénye, innentől a role_module_permission VIEW-soraiból.';

-- ---------- 5.2 role_permission_set(): a VIEW műveletet állítja ----------
-- A régi felület (és a 39-es dokumentációja) szerint ez "egy menüpont be- vagy
-- kikapcsolása". A menüpont-láthatóság innentől a VIEW művelet, tehát ez a
-- függvény azt állítja. A SUPERADMIN-tiltás és a szuperadmin-kötés szó szerint
-- a 39-esből marad.
create or replace function public.role_permission_set(
  p_kod text, p_permission text, p_ad boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Jogosultságot csak szuperadmin állíthat.' using errcode = '42501';
  end if;
  if p_kod = 'SUPERADMIN' then
    raise exception
      'A SUPERADMIN hozzáférése szándékosan nem szerkeszthető — enélkül ki '
      'lehetne zárni magadat abból a képernyőből is, amivel visszaállítanád.'
      using errcode = '42501';
  end if;
  -- Az új mátrixon a VIEW a menüpont-láthatóság.
  perform public.role_action_set(p_kod, p_permission, 'VIEW', p_ad);
  -- A régi táblát is szinkronban tartjuk, hogy egy még nem frissített
  -- bundle ugyanazt lássa. Döntéshez senki nem olvassa.
  if p_ad then
    insert into public.role_permission(role_kod, permission, granted_by)
    values (p_kod, p_permission, auth.uid()) on conflict do nothing;
  else
    delete from public.role_permission
     where role_kod = p_kod and permission = p_permission;
  end if;
  return true;
end $$;


-- ============================================================================
-- 6. SZAKASZ — ADMIN RPC-K
-- ============================================================================
-- Mind szuperadminhoz kötve, 42501-gyel, és mind refuzálja a SUPERADMIN
-- szerepkört — a 39-es role_permission_set szó szerinti indoklásával.

-- ---------- 6.1 egy cella állítása ----------
create or replace function public.role_action_set(
  p_role text, p_module text, p_action text, p_ad boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_actions text[];
begin
  if not public.is_superadmin() then
    raise exception 'Jogosultságot csak szuperadmin állíthat.' using errcode = '42501';
  end if;
  if p_role = 'SUPERADMIN' then
    raise exception
      'A SUPERADMIN hozzáférése szándékosan nem szerkeszthető — enélkül ki '
      'lehetne zárni magadat abból a képernyőből is, amivel visszaállítanád.'
      using errcode = '42501';
  end if;

  select actions into v_actions from public.module_definition where kod = p_module;
  if v_actions is null then
    raise exception 'Nincs ilyen modul: %', p_module using errcode = '02000';
  end if;
  -- Hatás nélküli jogot nem engedünk bepipálni: az hamis biztonságérzet.
  if not (upper(p_action) = any (v_actions)) then
    raise exception
      'A(z) "%" műveletnek ezen a modulon (%) nincs értelme. Értelmes műveletek: %.',
      upper(p_action), p_module, array_to_string(v_actions, ', ')
      using errcode = '22023';
  end if;

  if p_ad then
    insert into public.role_module_permission (role_kod, module_kod, action, granted_by)
    values (p_role, p_module, upper(p_action), auth.uid())
    on conflict do nothing;
  else
    delete from public.role_module_permission
     where role_kod = p_role and module_kod = p_module and action = upper(p_action);
  end if;

  insert into public.rbac_permission_audit
    (altal, altal_email, role_kod, module_kod, action, megadva)
  values (auth.uid(), public.my_email(), p_role, p_module, upper(p_action), p_ad);

  return true;
end $$;

-- ---------- 6.2 egy teljes sor (modul) állítása egy körben ----------
-- A mátrix-felület ezt használja: egy modulsor öt cellája EGY körútban
-- mentődik, nem ötben. Nem csak sebesség: így a sor állapota atomi, és nem
-- fordulhat elő, hogy egy félúton megszakadt mentés után a sor felében új,
-- felében régi jog van.
create or replace function public.role_module_actions_set(
  p_role text, p_module text, p_actions text[])
returns text[]
language plpgsql security definer set search_path = public
as $$
declare
  v_actions text[];
  v_kert    text[];
  v_a       text;
begin
  if not public.is_superadmin() then
    raise exception 'Jogosultságot csak szuperadmin állíthat.' using errcode = '42501';
  end if;
  if p_role = 'SUPERADMIN' then
    raise exception
      'A SUPERADMIN hozzáférése szándékosan nem szerkeszthető — enélkül ki '
      'lehetne zárni magadat abból a képernyőből is, amivel visszaállítanád.'
      using errcode = '42501';
  end if;

  select actions into v_actions from public.module_definition where kod = p_module;
  if v_actions is null then
    raise exception 'Nincs ilyen modul: %', p_module using errcode = '02000';
  end if;

  -- A kért listát a modulon ÉRTELMES műveletekre szűkítjük, és nagybetűsítjük.
  select coalesce(array_agg(distinct upper(x)), '{}'::text[])
    into v_kert
    from unnest(coalesce(p_actions, '{}'::text[])) x
   where upper(x) = any (v_actions);

  -- Elvétel: ami eddig volt, de a kért listában nincs.
  for v_a in
    select rmp.action from public.role_module_permission rmp
     where rmp.role_kod = p_role and rmp.module_kod = p_module
       and not (rmp.action = any (v_kert))
  loop
    delete from public.role_module_permission
     where role_kod = p_role and module_kod = p_module and action = v_a;
    insert into public.rbac_permission_audit
      (altal, altal_email, role_kod, module_kod, action, megadva)
    values (auth.uid(), public.my_email(), p_role, p_module, v_a, false);
  end loop;

  -- Hozzáadás: ami a kért listában van, de eddig nem volt.
  foreach v_a in array v_kert loop
    insert into public.role_module_permission (role_kod, module_kod, action, granted_by)
    values (p_role, p_module, v_a, auth.uid())
    on conflict do nothing;
    if found then
      insert into public.rbac_permission_audit
        (altal, altal_email, role_kod, module_kod, action, megadva)
      values (auth.uid(), public.my_email(), p_role, p_module, v_a, true);
    end if;
  end loop;

  -- A régi role_permission táblát a VIEW-val szinkronban tartjuk (5.2 indoklása).
  if 'VIEW' = any (v_kert) then
    insert into public.role_permission (role_kod, permission, granted_by)
    values (p_role, p_module, auth.uid()) on conflict do nothing;
  else
    delete from public.role_permission
     where role_kod = p_role and permission = p_module;
  end if;

  return v_kert;
end $$;

-- ---------- 6.3 a teljes mátrix egy hívásban ----------
-- A felület ezt tölti be a Szerepkörök fülön. Minden jóváhagyott fiók
-- olvashatja (a táblák select policy-je is ezt engedi): a mátrix nem titok,
-- a szerkesztése az.
--
-- A superadmin kulcs azért van benne, hogy a felület ki tudja írni, MIÉRT nem
-- szerkeszthető az a sor — ne csak hiányozzon róla a gomb.
create or replace function public.role_matrix()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object('kod', kod, 'nev', nev, 'leiras', leiras)
                       order by sorrend)
        from public.rbac_action), '[]'::jsonb),
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kod', kod, 'nev', nev, 'csoport', csoport,
               'actions', to_jsonb(actions), 'aktiv', aktiv, 'leiras', leiras)
                       order by sorrend)
        from public.module_definition), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kod', kod, 'nev', nev, 'leiras', leiras, 'szin', szin,
               'aktiv', aktiv, 'beepitett', beepitett,
               'superadmin', kod = 'SUPERADMIN')
                       order by sorrend)
        from public.role_definition), '[]'::jsonb),
    'grants', coalesce((
      select jsonb_object_agg(g.role_kod, g.modulok)
        from (select rmp.role_kod,
                     jsonb_object_agg(rmp.module_kod, rmp.actions) as modulok
                from (select role_kod, module_kod,
                             jsonb_agg(action order by action) as actions
                        from public.role_module_permission
                       group by role_kod, module_kod) rmp
               group by rmp.role_kod) g), '{}'::jsonb)
  )
$$;

comment on function public.role_matrix() is
  '[UniPortal RBAC] A teljes mátrix egy hívásban: műveletek, modulok, szerepkörök, jogok.';

-- ---------- 6.4 modul felvétele vagy módosítása deploy nélkül ----------
-- MIÉRT KELL: egy új menüpont ma kódváltozás. A modul-katalógus viszont
-- adat — ha egy új modul megjelenik a felületen, a mátrixban is meg kell
-- tudni jelenni anélkül, hogy ehhez migrációt írnánk.
create or replace function public.module_save(
  p_kod     text,
  p_nev     text    default null,
  p_csoport text    default null,
  p_sorrend integer default null,
  p_aktiv   boolean default null,
  p_actions text[]  default null,
  p_leiras  text    default null)
returns public.module_definition
language plpgsql security definer set search_path = public
as $$
declare v_m public.module_definition; v_a text[];
begin
  if not public.is_superadmin() then
    raise exception 'Modult csak szuperadmin szerkeszthet.' using errcode = '42501';
  end if;

  if p_actions is not null then
    select coalesce(array_agg(distinct upper(x)), '{}'::text[]) into v_a
      from unnest(p_actions) x
     where upper(x) in (select kod from public.rbac_action);
    if array_length(v_a, 1) is null then
      raise exception 'Legalább egy érvényes műveletet meg kell adni (VIEW, USE, CREATE, EDIT, DELETE).'
        using errcode = '22023';
    end if;
  end if;

  select * into v_m from public.module_definition where kod = p_kod;

  if v_m.kod is null then
    if nullif(btrim(coalesce(p_nev, '')), '') is null then
      raise exception 'Az új modulnak kell megnevezés.' using errcode = '22023';
    end if;
    insert into public.module_definition (kod, nev, csoport, sorrend, actions, leiras)
    values (lower(btrim(p_kod)), btrim(p_nev), p_csoport,
            coalesce(p_sorrend, 100), coalesce(v_a, array['VIEW']), p_leiras)
    returning * into v_m;
    return v_m;
  end if;

  update public.module_definition
     set nev     = coalesce(btrim(p_nev), nev),
         csoport = coalesce(p_csoport, csoport),
         sorrend = coalesce(p_sorrend, sorrend),
         aktiv   = coalesce(p_aktiv, aktiv),
         actions = coalesce(v_a, actions),
         leiras  = coalesce(p_leiras, leiras),
         updated_at = now()
   where kod = p_kod
  returning * into v_m;
  return v_m;
end $$;

-- ---------- 6.5 a vészkapcsoló szentesített útja ----------
-- MIÉRT RPC ÉS NEM KÉZI UPDATE: így a felületről is elhúzható, hajnali
-- kettőkor, psql és SQL Editor nélkül — és minden állítás bekerül a naplóba.
-- A kikapcsolás MINDKÉT kikényszerítési réteget kinyitja (restriktív RLS és
-- RPC-őrök), mert mindkettő a rbac_can()-ra épül.
create or replace function public.rbac_enforce_set(p_be boolean)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'A jogosultsági kikényszerítést csak szuperadmin állíthatja.'
      using errcode = '42501';
  end if;

  insert into public.rbac_setting (kulcs, ertek, updated_at, updated_by)
  values ('rbacx_enforce', case when p_be then 'on' else 'off' end, now(), auth.uid())
  on conflict (kulcs) do update
    set ertek = excluded.ertek, updated_at = now(), updated_by = auth.uid();

  insert into public.rbac_permission_audit
    (altal, altal_email, megadva, megjegyzes)
  values (auth.uid(), public.my_email(), p_be,
          case when p_be
               then 'A jogosultsági kikényszerítés BEKAPCSOLVA.'
               else 'A jogosultsági kikényszerítés KIKAPCSOLVA (vészkapcsoló).' end);

  return case when p_be
              then 'A kikényszerítés bekapcsolva.'
              else 'A kikényszerítés KIKAPCSOLVA. A restriktív RLS és az RPC-őrök mindent átengednek.' end;
end $$;

-- ---------- 6.6 a vészkapcsoló állása, olvasásra ----------
-- A felület ezt mutatja a Szerepkörök fülön: ha ki van kapcsolva, azt LÁTNI
-- kell, különben valaki hetekig abban a hitben él, hogy a mátrix működik.
create or replace function public.rbac_enforce_state()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_rpc boolean := false;
begin
  if to_regclass('public.rbac_rpc_guard') is not null then
    select exists (select 1 from public.rbac_rpc_guard where aktiv) into v_rpc;
  end if;
  return jsonb_build_object(
    'enforce',    coalesce((select ertek from public.rbac_setting
                             where kulcs = 'rbacx_enforce'), 'on') = 'on',
    'updated_at', (select updated_at from public.rbac_setting where kulcs = 'rbacx_enforce'),
    'rls_layer',  exists (select 1 from pg_policies
                           where schemaname = 'public' and policyname like 'rbacx\_%'),
    'rpc_layer',  v_rpc
  );
end
$$;


-- ============================================================================
-- 7. SZAKASZ — SORSZINTŰ BIZTONSÁG ÉS JOGOSULTSÁGOK
-- ============================================================================
-- A 39-es rd_select / rd_write mintája: OLVASNI minden jóváhagyott fiók tudja
-- (a felület ebből rajzolja a mátrixot és a címkéket), ÍRNI csak RPC-n át,
-- szuperadminként.
--
-- A rbac_setting KIVÉTEL: azt olvasni sem szabad másnak. Egy vészkapcsoló
-- állása önmagában is információ arról, hogy épp nyitva van-e a rendszer.

alter table public.rbac_action            enable row level security;
alter table public.module_definition      enable row level security;
alter table public.role_module_permission enable row level security;
alter table public.rbac_permission_audit  enable row level security;
alter table public.rbac_setting           enable row level security;

drop policy if exists ra_select on public.rbac_action;
create policy ra_select on public.rbac_action
  for select to authenticated using (public.is_approved());
drop policy if exists ra_write on public.rbac_action;
create policy ra_write on public.rbac_action
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists md_select on public.module_definition;
create policy md_select on public.module_definition
  for select to authenticated using (public.is_approved());
drop policy if exists md_write on public.module_definition;
create policy md_write on public.module_definition
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists rmp_select on public.role_module_permission;
create policy rmp_select on public.role_module_permission
  for select to authenticated using (public.is_approved());
drop policy if exists rmp_write on public.role_module_permission;
create policy rmp_write on public.role_module_permission
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- A napló APPEND-ONLY: van select és insert policy, UPDATE és DELETE
-- SZÁNDÉKOSAN NINCS — a 11-es auditLogs mintájára (11:722). Egy hamisítható
-- vagy visszamenőleg tisztítható jogosultsági napló többet árt, mint használ.
drop policy if exists rpa_select on public.rbac_permission_audit;
create policy rpa_select on public.rbac_permission_audit
  for select to authenticated using (public.is_superadmin());
drop policy if exists rpa_insert on public.rbac_permission_audit;
create policy rpa_insert on public.rbac_permission_audit
  for insert to authenticated with check (public.is_superadmin());

-- A vészkapcsoló: se olvasás, se írás másnak. Az állását a
-- rbac_enforce_state() RPC adja meg — az SECURITY DEFINER, tehát megkerüli
-- ezt a policy-t, és pontosan annyit ad vissza, amennyit a felületnek látnia kell.
drop policy if exists rs_all on public.rbac_setting;
create policy rs_all on public.rbac_setting
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

grant select on public.rbac_action, public.module_definition,
               public.role_module_permission to authenticated;
grant select on public.rbac_permission_audit to authenticated;
-- A rbac_setting-re SZÁNDÉKOSAN nincs tábla-grant: kizárólag SECURITY DEFINER
-- függvényen keresztül érhető el.

-- ---------- 7.2 függvény-grantok, a házi rituálé szerint ----------
-- A revoke SZÁNDÉKOSAN "from public, anon" — a 99_harden_grants.sql minden
-- indításkor felmér, mit tud az authenticated, és azt adja vissza. Amit itt
-- nem adunk meg, azt ő sem fogja.
revoke all on function public.rbac_can(text, text)                          from public, anon;
revoke all on function public.rbac_can_any(text[], text)                    from public, anon;
revoke all on function public.rbac_require(text, text)                      from public, anon;
revoke all on function public.rbac_can_role(text, text, text)               from public, anon;
revoke all on function public.my_module_permissions()                       from public, anon;
revoke all on function public.my_role_permissions()                         from public, anon;
revoke all on function public.role_permission_set(text, text, boolean)      from public, anon;
revoke all on function public.role_action_set(text, text, text, boolean)    from public, anon;
revoke all on function public.role_module_actions_set(text, text, text[])   from public, anon;
revoke all on function public.role_matrix()                                 from public, anon;
revoke all on function public.module_save(text, text, text, integer, boolean, text[], text) from public, anon;
revoke all on function public.rbac_enforce_set(boolean)                     from public, anon;
revoke all on function public.rbac_enforce_state()                          from public, anon;

grant execute on function public.rbac_can(text, text)                          to authenticated;
grant execute on function public.rbac_can_any(text[], text)                    to authenticated;
grant execute on function public.rbac_require(text, text)                      to authenticated;
grant execute on function public.rbac_can_role(text, text, text)               to authenticated;
grant execute on function public.my_module_permissions()                       to authenticated;
grant execute on function public.my_role_permissions()                         to authenticated;
grant execute on function public.role_permission_set(text, text, boolean)      to authenticated;
grant execute on function public.role_action_set(text, text, text, boolean)    to authenticated;
grant execute on function public.role_module_actions_set(text, text, text[])   to authenticated;
grant execute on function public.role_matrix()                                 to authenticated;
grant execute on function public.module_save(text, text, text, integer, boolean, text[], text) to authenticated;
grant execute on function public.rbac_enforce_set(boolean)                     to authenticated;
grant execute on function public.rbac_enforce_state()                          to authenticated;


-- ============================================================================
-- 8. SZAKASZ — VISSZAVONÁS
-- ============================================================================
-- select public.rbac_actions_rollback();
--
-- FIGYELEM, EZ A LÉNYEGE: a visszavonás NEM ELÉG a táblák eldobásához. Az
-- 5. szakasz ÁTÍRTA a 39-es my_role_permissions() és role_permission_set()
-- törzsét, hogy az új mátrixot olvassák. Ha csak a táblákat dobnánk el, a menü
-- egy nem létező táblára hivatkozó függvényt hívna, és MINDENKI nulla
-- menüpontot kapna — a visszavonás rontana, nem javítana.
-- Ezért ez a függvény ELŐBB visszaírja a 39-es eredeti törzseket, és csak
-- UTÁNA dobja el, amit a 72-es hozott.
--
-- A 73-as (restriktív RLS) és a 74-es (RPC-őrök) visszavonása NEM itt van:
-- azokat a 75_rbac_actions_rollback.sql végzi, mert azok DDL-t is bontanak.
create or replace function public.rbac_actions_rollback()
returns text
language plpgsql security definer set search_path = public
as $$
declare n_policy int := 0;
begin
  if not public.is_superadmin() then
    raise exception 'Csak szuperadmin vonhatja vissza.' using errcode = '42501';
  end if;

  -- ---------- 8.1 a 73-as maradványainak ellenőrzése ----------
  -- Ha a restriktív réteg még él, a visszavonás kihúzná alóla a rbac_can()-t,
  -- és MINDEN lekérdezés elhasalna "permission denied for function"-nal.
  select count(*) into n_policy from pg_policies
   where schemaname = 'public' and policyname like 'rbacx\_%';
  if n_policy > 0 then
    raise exception
      'MEGTAGADVA: még % darab rbacx_ policy él a 73-as migrációból. '
      'Futtasd ELŐBB a 75_rbac_actions_rollback.sql-t, utána ezt.', n_policy
      using errcode = '55000';
  end if;

  -- A PL/pgSQL hívások nem mind szerepelnek a pg_depend-ben. A DROP
  -- önmagában ezért nem védi meg a 74-es RPC-ket a hiányzó függvénytől.
  if exists (select 1 from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname <> 'rbac_actions_rollback'
        and position('public.rbac_require(' in prosrc) > 0) then
    raise exception 'MEGTAGADVA: RPC-őrök még élnek. Futtasd ELŐBB a 75_rbac_actions_rollback.sql-t.'
      using errcode = '55000';
  end if;

  -- ---------- 8.2 a 39-es eredeti törzsének visszaírása ----------
  -- BETŰRE a 39_role_admin.sql 108. és 173. sorától.
  execute $f1$
    create or replace function public.my_role_permissions()
    returns text[]
    language sql stable security definer set search_path = public
    as $body$
      select case
        when public.my_role() = 'SUPERADMIN' then null
        else (select array_agg(rp.permission order by rp.permission)
                from public.role_permission rp
                join public.role_definition rd on rd.kod = rp.role_kod and rd.aktiv
               where rp.role_kod = public.my_role())
      end
    $body$;
  $f1$;

  execute $f2$
    create or replace function public.role_permission_set(
      p_kod text, p_permission text, p_ad boolean)
    returns boolean
    language plpgsql security definer set search_path = public
    as $body$
    begin
      if not public.is_superadmin() then
        raise exception 'Jogosultságot csak szuperadmin állíthat.' using errcode = '42501';
      end if;
      if p_kod = 'SUPERADMIN' then
        raise exception
          'A SUPERADMIN hozzáférése szándékosan nem szerkeszthető — enélkül ki '
          'lehetne zárni magadat abból a képernyőből is, amivel visszaállítanád.'
          using errcode = '42501';
      end if;
      if p_ad then
        insert into public.role_permission(role_kod, permission, granted_by)
        values (p_kod, p_permission, auth.uid()) on conflict do nothing;
      else
        delete from public.role_permission where role_kod = p_kod and permission = p_permission;
      end if;
      return true;
    end
    $body$;
  $f2$;

  -- ---------- 8.3 a 72-es függvényeinek eldobása ----------
  -- CASCADE NÉLKÜL, SZÁNDÉKOSAN: ha bármi még hivatkozik rájuk (egy kézzel
  -- felvitt policy, egy 74-es őr), a drop HIBÁT AD, és a visszavonás megáll.
  -- Egy cascade itt csendben elvinné azt a szabályt is, ami épp védett valamit.
  drop function if exists public.rbac_can(text, text);
  drop function if exists public.rbac_can_any(text[], text);
  drop function if exists public.rbac_require(text, text);
  drop function if exists public.rbac_can_role(text, text, text);
  drop function if exists public.my_module_permissions();
  drop function if exists public.role_action_set(text, text, text, boolean);
  drop function if exists public.role_module_actions_set(text, text, text[]);
  drop function if exists public.role_matrix();
  drop function if exists public.module_save(text, text, text, integer, boolean, text[], text);
  drop function if exists public.rbac_enforce_set(boolean);
  drop function if exists public.rbac_enforce_state();

  -- ---------- 8.4 a 72-es tábláinak eldobása ----------
  -- A naplót SZÁNDÉKOSAN MEGHAGYJUK: az bizonyíték arról, ki mit állított.
  -- Egy visszavonás nem törölhet naplót.
  drop table if exists public.rbacx_table_module;
  drop table if exists public.role_module_permission cascade;
  drop table if exists public.module_definition cascade;
  drop table if exists public.rbac_action cascade;
  drop table if exists public.rbac_setting cascade;

  return 'A 72-es visszavonva. A menü visszaáll a role_permission táblára. '
      || 'A rbac_permission_audit napló SZÁNDÉKOSAN megmaradt.';
end $$;

revoke all on function public.rbac_actions_rollback() from public, anon;
grant execute on function public.rbac_actions_rollback() to authenticated;


-- ============================================================================
-- 9. SZAKASZ — ELLENŐRZÉS
-- ============================================================================
-- A házi forma: mit / ertek / elvart / allapot. A LÉNYEG a 9.2: bizonyítani,
-- hogy a bevezetés SENKITŐL nem vett el semmit.

-- ---------- 9.1 a modul objektumai megvannak-e ----------
with o(s, mit, nev, t) as (values
  (1, 'Műveletek táblája',        'rbac_action',             'tab'),
  (2, 'Modulok katalógusa',       'module_definition',       'tab'),
  (3, 'A mátrix',                 'role_module_permission',  'tab'),
  (4, 'Vészkapcsoló',             'rbac_setting',            'tab'),
  (5, 'Napló',                    'rbac_permission_audit',   'tab'),
  (6, 'Jogosultság-vizsgálat',    'rbac_can',                'fn'),
  (7, 'Több modul VAGY-ral',      'rbac_can_any',            'fn'),
  (8, 'Kikényszerítés RPC-ben',   'rbac_require',            'fn'),
  (9, 'Mérőeszköz szerepkörre',   'rbac_can_role',           'fn'),
  (10,'Saját jogaim',             'my_module_permissions',   'fn'),
  (11,'Egy cella állítása',       'role_action_set',         'fn'),
  (12,'Egy modulsor állítása',    'role_module_actions_set', 'fn'),
  (13,'A teljes mátrix',          'role_matrix',             'fn'),
  (14,'Modul mentése',            'module_save',             'fn'),
  (15,'Vészkapcsoló állítása',    'rbac_enforce_set',        'fn'),
  (16,'Vészkapcsoló állása',      'rbac_enforce_state',      'fn'),
  (17,'Visszavonó',               'rbac_actions_rollback',   'fn')
)
select o.mit as "mit ellenőrzünk", o.nev as "objektum",
       case when case o.t
         when 'tab' then exists (select 1 from pg_tables
                                  where schemaname = 'public' and tablename = o.nev)
         when 'fn'  then exists (select 1 from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public' and p.proname = o.nev)
       end then 'OK' else '*** HIÁNYZIK ***' end as "állapot"
  from o order by o.s;

-- ---------- 9.2 A BIZONYÍTÁS: nem vettünk el semmit ----------
-- Minden role_permission sorra (= minden mai menüpontra) meg kell lennie a
-- VIEW jognak az új mátrixban. Ha egyetlen sor is kimaradt, valaki holnap
-- kevesebbet lát, mint ma — és ezt itt, futtatáskor kell megtudni, nem a
-- bejelentésből.
select 'Mai menüpont VIEW nélkül maradt'                  as "mit ellenőrzünk",
       count(*)::text                                     as "érték",
       '0'                                                as "elvárt",
       case when count(*) = 0 then 'OK'
            else '*** ELTÉR — ' || string_agg(rp.role_kod || '/' || rp.permission, ', ') || ' ***'
       end                                                as "állapot"
  from public.role_permission rp
  join public.module_definition md on md.kod = rp.permission
 where rp.role_kod <> 'SUPERADMIN'
   and not exists (
     select 1 from public.role_module_permission rmp
      where rmp.role_kod = rp.role_kod and rmp.module_kod = rp.permission
        and rmp.action = 'VIEW');

-- A szerepkörönkénti összesítés, emberi szemnek. A SUPERADMIN sora
-- SZÁNDÉKOSAN 0 — nála a rbac_can() a táblát meg sem nézi.
select 'Szerepkör: ' || rd.nev                            as "mit ellenőrzünk",
       rd.kod                                             as "objektum",
       coalesce(count(rmp.action), 0)::text || ' jog · '
         || coalesce(count(distinct rmp.module_kod), 0)::text || ' modul'
         || case when rd.kod = 'SUPERADMIN'
                 then '   (nem a táblából — mindent szabad)' else '' end
                                                          as "állapot"
  from public.role_definition rd
  left join public.role_module_permission rmp on rmp.role_kod = rd.kod
 group by rd.kod, rd.nev, rd.sorrend
 order by rd.sorrend;

-- ---------- 9.3 a szuperadmin kizárhatatlansága ----------
select 'A SUPERADMIN-nak nincs sora a mátrixban'  as "mit ellenőrzünk",
       (select count(*)::text from public.role_module_permission
         where role_kod = 'SUPERADMIN')           as "érték",
       '0'                                        as "elvárt",
       case when exists (select 1 from public.role_module_permission
                          where role_kod = 'SUPERADMIN')
            then '*** ELTÉR — van sora, tehát elvehető lenne ***'
            else 'OK — nincs, és a rbac_can() nem is nézi' end as "állapot"
union all
select 'Hatás nélküli jog a mátrixban',
       (select count(*)::text
          from public.role_module_permission rmp
          join public.module_definition md on md.kod = rmp.module_kod
         where not (rmp.action = any (md.actions))),
       '0',
       case when exists (select 1 from public.role_module_permission rmp
                          join public.module_definition md on md.kod = rmp.module_kod
                         where not (rmp.action = any (md.actions)))
            then '*** ELTÉR — olyan jog, aminek a modulon nincs értelme ***'
            else 'OK' end
union all
select 'Vészkapcsoló állása', 
       coalesce((select ertek from public.rbac_setting where kulcs = 'rbacx_enforce'), '(nincs)'),
       'on',
       case when coalesce((select ertek from public.rbac_setting
                            where kulcs = 'rbacx_enforce'), '') = 'on'
            then 'OK' else '*** A KIKÉNYSZERÍTÉS KI VAN KAPCSOLVA ***' end;

do $rbac_kesz$
begin
  raise notice 'Rendben: a 72-es lefutott. A kikényszerítés a 73-as és a 74-es dolga.';
end $rbac_kesz$;
