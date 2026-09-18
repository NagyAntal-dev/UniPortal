-- 72 ellenőrzés: akció-szintű RBAC — megvan-e minden, és nem vett-e el semmit.
-- Futtatás: Supabase -> SQL Editor -> New query -> beilleszt -> Run.
-- A 39_ellenorzes.sql szerkezetét követi.

-- ---------------------------------------------------------------------------
-- 1. Objektumok, mai állapot, védelem
-- ---------------------------------------------------------------------------
with o(s, mit, nev, t) as (values
  (1, 'Műveletek táblája',      'rbac_action',             'tab'),
  (2, 'Modulok katalógusa',     'module_definition',       'tab'),
  (3, 'A mátrix',               'role_module_permission',  'tab'),
  (4, 'Vészkapcsoló',           'rbac_setting',            'tab'),
  (5, 'Napló',                  'rbac_permission_audit',   'tab'),
  (6, 'Jogosultság-vizsgálat',  'rbac_can',                'fn'),
  (7, 'Több modul VAGY-ral',    'rbac_can_any',            'fn'),
  (8, 'Kikényszerítés RPC-ben', 'rbac_require',            'fn'),
  (9, 'Mérőeszköz szerepkörre', 'rbac_can_role',           'fn'),
  (10,'Saját jogaim',           'my_module_permissions',   'fn'),
  (11,'Egy cella állítása',     'role_action_set',         'fn'),
  (12,'Egy modulsor állítása',  'role_module_actions_set', 'fn'),
  (13,'A teljes mátrix',        'role_matrix',             'fn'),
  (14,'Modul mentése',          'module_save',             'fn'),
  (15,'Vészkapcsoló állítása',  'rbac_enforce_set',        'fn'),
  (16,'Vészkapcsoló állása',    'rbac_enforce_state',      'fn'),
  (17,'Visszavonó',             'rbac_actions_rollback',   'fn')
),
letezik as (
  select o.s, o.mit, o.nev,
         case when case o.t
           when 'tab' then exists (select 1 from pg_tables
                                    where schemaname = 'public' and tablename = o.nev)
           when 'fn'  then exists (select 1 from pg_proc p
                                    join pg_namespace n on n.oid = p.pronamespace
                                   where n.nspname = 'public' and p.proname = o.nev)
         end then 'OK' else '!! HIÁNYZIK' end
    from o
),
allapot as (
  select 30 + row_number() over (order by rd.sorrend),
         'Szerepkör: ' || rd.nev, rd.kod,
         coalesce(count(rmp.action), 0)::text || ' jog · '
           || coalesce(count(distinct rmp.module_kod), 0)::text || ' modul'
           || case when rd.kod = 'SUPERADMIN'
                   then '   (nem a táblából — mindent szabad)' else '' end
    from public.role_definition rd
    left join public.role_module_permission rmp on rmp.role_kod = rd.kod
   group by rd.kod, rd.nev, rd.sorrend
),
vedelem as (
  select 60, 'A SUPERADMIN joga nem elvehető', 'role_module_permission',
         case when exists (select 1 from public.role_module_permission
                            where role_kod = 'SUPERADMIN')
              then '!! van sora a táblában — tehát elvehető lenne'
              else 'OK — nincs, és a rbac_can() nem is nézi' end
  union all
  select 61, 'Hatás nélküli jog (a modulon értelmetlen művelet)', 'actions',
         coalesce((select count(*)::text || ' db  !! ELTÉR'
                     from public.role_module_permission rmp
                     join public.module_definition md on md.kod = rmp.module_kod
                    where not (rmp.action = any (md.actions))
                    having count(*) > 0), 'OK — nincs')
  union all
  select 62, 'Vészkapcsoló', 'rbacx_enforce',
         case coalesce((select ertek from public.rbac_setting
                         where kulcs = 'rbacx_enforce'), '(nincs sor)')
           when 'on' then 'OK — a kikényszerítés él'
           else '!! KI VAN KAPCSOLVA — a restriktív RLS és az RPC-őrök mindent átengednek' end
  union all
  select 63, 'Modulok / műveletek száma', 'seed',
         (select count(*)::text from public.module_definition where aktiv) || ' modul · '
           || (select count(*)::text from public.rbac_action) || ' művelet'
           || case when (select count(*) from public.module_definition where aktiv) >= 26
                    and (select count(*) from public.rbac_action) = 5
                   then '   OK' else '   !! ELTÉR (elvárt: 26 / 5)' end
)
select mit as "mit ellenőrzünk", nev as "objektum", allapot as "állapot"
  from (select * from letezik
        union all select * from allapot
        union all select * from vedelem) x(s, mit, nev, allapot)
 order by s;

-- ---------------------------------------------------------------------------
-- 2. A BIZONYÍTÁS: a bevezetés nem vett el semmit
-- ---------------------------------------------------------------------------
-- Minden mai menüpontnak (role_permission sor) meg kell lennie VIEW jogként.
-- Ha itt bármi kijön, valaki HOLNAP kevesebbet lát, mint MA.
select 'Mai menüpont VIEW nélkül'                as "mit ellenőrzünk",
       count(*)::text                            as "érték",
       '0'                                       as "elvárt",
       case when count(*) = 0 then 'OK'
            else '!! ELTÉR — ' || string_agg(rp.role_kod || '/' || rp.permission, ', ') end
                                                 as "állapot"
  from public.role_permission rp
  join public.module_definition md on md.kod = rp.permission
 where rp.role_kod <> 'SUPERADMIN'
   and not exists (select 1 from public.role_module_permission rmp
                    where rmp.role_kod = rp.role_kod
                      and rmp.module_kod = rp.permission
                      and rmp.action = 'VIEW');

-- ---------------------------------------------------------------------------
-- 3. A mátrix, emberi szemnek: szerepkör × modul, művelet-betűkkel
-- ---------------------------------------------------------------------------
-- V=VIEW  U=USE  C=CREATE  E=EDIT  D=DELETE
-- A szürke pont (.) azt jelenti: a modulon ÉRTELMES a művelet, de nincs megadva.
-- A kötőjel (-) azt: a modulon nem is értelmes.
select rd.kod                                    as "szerepkör",
       md.csoport                                as "csoport",
       md.kod                                    as "modul",
       string_agg(
         case
           when not (ra.kod = any (md.actions)) then '-'
           when exists (select 1 from public.role_module_permission rmp
                         where rmp.role_kod = rd.kod and rmp.module_kod = md.kod
                           and rmp.action = ra.kod) then left(ra.kod, 1)
           else '.'
         end, '' order by ra.sorrend)            as "V U C E D"
  from public.role_definition rd
  cross join public.module_definition md
  cross join public.rbac_action ra
 where rd.aktiv and md.aktiv and rd.kod <> 'SUPERADMIN'
 group by rd.kod, rd.sorrend, md.csoport, md.kod, md.sorrend
having string_agg(case when exists (select 1 from public.role_module_permission rmp
                                     where rmp.role_kod = rd.kod and rmp.module_kod = md.kod
                                       and rmp.action = ra.kod) then 'x' else '' end, '') <> ''
 order by rd.sorrend, md.sorrend;

-- ---------------------------------------------------------------------------
-- 4. Szerepkör-imitáció (KÉZI, kommentben — írás is van benne)
-- ---------------------------------------------------------------------------
-- A felületen KATTINTÁSSAL nem ellenőrizhető: a features/data-layer.jsx
-- dlInsert/dlUpdate minden hibát elkap és localStorage-ra vált, tehát egy
-- MEGTAGADOTT írás SIKERESNEK látszik (11_rbac_additive.sql fejléc, D pont).
-- A hiteles forrás ez a blokk, illetve a Supabase-napló.
--
-- begin;
--   set local role authenticated;
--   set local "request.jwt.claims" = '{"sub":"<profil-uuid>","role":"authenticated"}';
--
--   select public.my_role(), public.is_approved();
--   select public.rbac_can('feed','CREATE'), public.rbac_can('finance','DELETE');
--   select public.my_module_permissions();
--
--   -- írás-próbák (a 73-as után van értelme):
--   insert into public.feed_posts (id, title) values ('t','t');
--   update public.students set city = city where id = '<sajat>';
-- rollback;
--
-- A HAT szerepkör mátrixa JWT nélkül is végigmérhető:
select rd.kod                                                  as "szerepkör",
       md.kod                                                  as "modul",
       public.rbac_can_role(rd.kod, md.kod, 'EDIT')::text       as "EDIT",
       public.rbac_can_role(rd.kod, md.kod, 'DELETE')::text     as "DELETE"
  from public.role_definition rd
  cross join public.module_definition md
 where rd.aktiv and md.aktiv
   and md.kod in ('admissions_core', 'finance', 'feed', 'programs', 'interviews')
 order by rd.sorrend, md.sorrend;
