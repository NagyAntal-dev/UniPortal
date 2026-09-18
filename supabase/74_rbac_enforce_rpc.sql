-- ============================================================================
-- 74_rbac_enforce_rpc.sql — modul-akció kapu az ÍRÓ RPC-ken (3. réteg)
-- ----------------------------------------------------------------------------
-- MIÉRT KELL: a SECURITY DEFINER RPC-k MEGKERÜLIK az RLS-t, tehát a 73-as
--   restriktív policy-i rájuk nem hatnak. Amit a felhasználó RPC-n át ír, azt
--   csak magában az RPC-ben lehet megfogni.
--
-- MIT CSINÁL: 26 író RPC törzsébe beszúr EGY kaput, a plpgsql blokk első
--   utasításaként:
--
--       if not public.is_trusted_caller() then
--         perform public.rbac_require('<modul>', '<művelet>');
--       end if;
--
--   A törzs MINDEN MÁS SORA BETŰRE az eredeti migrációból való. Nem kézzel
--   másoltuk: egy szkript vette át az ŐKET UTOLSÓKÉNT DEFINIÁLÓ migrációból
--   (a manifest sorrendje szerint), és a beszúrást soronkénti diffel
--   ellenőriztük — mind a 26 törzsnél pontosan 9 sor jött hozzá, és egy sem
--   tűnt el. Ha egy jövőbeli migráció átírja valamelyik függvényt, ez a fájl
--   elavul; ezt a deploy/migrate/verify.sql lintere minden indulásnál jelzi.
--
-- MIT NEM CSINÁL — ÉS MIÉRT
--   • NEM generál burkolót futásidőben, és NEM nevez át semmit `__raw`-ra.
--     Az az út három hibán bukott el: (1) egy `security invoker` függvényt
--     `security definer` burkolóba tenni CSENDBEN kikapcsolja benne az RLS-t;
--     (2) egy RLS-policy-ből hivatkozott függvény átnevezése „permission
--     denied for function" hibával leviszi az egész alkalmazást; (3) egy
--     jövőbeli `create or replace` szó nélkül eltávolítaná az őrt.
--     Ez a fájl ezzel szemben sima, olvasható, diffelhető SQL.
--   • NEM őriz olyan RPC-t, amely az ECHO vagy a KOLLÉGIUM saját, hatókörös
--     grant-dimenzióját vizsgálja (echo.has_role, dorm.has_role, …). Azoknak a
--     role_module_permission-ban NINCS megfelelője, tehát két, külön seedelt
--     kapu előbb-utóbb ellentmondana egymásnak. A kiválasztás gépi volt: csak
--     olyan függvény került be, amely NYERS UniPortal-predikátumra
--     (is_admin / is_staff / is_admissions / is_finance) utasít el.
--   • NEM őriz OLVASÓ RPC-t. Az 1. fázis csak az írást szigorítja.
--   • NEM őriz `is_superadmin()`-hoz kötött függvényt (role_save,
--     group_permission_set, a *_rollback-ok). Azok kapuja már ma SZŰKEBB,
--     mint bármely modul-jog; egy modul-ellenőrzés ott csak zaj lenne.
--
-- MIÉRT NEM VESZ EL SEMMIT: a 72-es backfill minden szerepkörnek megadta azt a
--   modul-műveletet, amit ma a fenti predikátumok engednek. A kapu tehát ma
--   minden olyan hívónál átmegy, aki eddig is átment. A bizonyítás:
--   supabase/diagnostics/72_pglite_ellenorzes.mjs 9.2 szakasza.
--
-- ELŐFELTÉTEL: 72_rbac_actions.sql (rbac_require), 67_agency_guard_fix.sql
--   (is_trusted_caller)
-- VISSZAVONÁS: supabase/75_rbac_actions_rollback.sql
-- FUTTATÁS: a migrate szolgáltatás automatikusan, vagy SQL Editor -> Run.
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================================

set search_path = public;


-- ============================================================================
-- 0. SZAKASZ — ELŐFELTÉTEL
-- ============================================================================
do $rpc_pre$
begin
  if to_regprocedure('public.rbac_require(text, text)') is null then
    raise exception
      'MEGTAGADVA: a 72_rbac_actions.sql nem futott le (nincs rbac_require). Futtasd elobb azt.';
  end if;
  if to_regprocedure('public.is_trusted_caller()') is null then
    raise exception
      'MEGTAGADVA: a 67_agency_guard_fix.sql nem futott le (nincs is_trusted_caller).';
  end if;
  raise notice 'Rendben: az elofeltetelek megvannak.';
end $rpc_pre$;


-- ============================================================================
-- 1. SZAKASZ — A DEKLARÁLT SZÁNDÉK TÁBLÁJA
-- ============================================================================
-- Ez a tábla NEM generál semmit. Nyilvántartás: melyik RPC-nek melyik
-- modul-műveletet KELL ellenőriznie. A deploy/migrate/verify.sql lintere
-- ebből dolgozik, és minden indulásnál megmondja, ha egy függvényből kikerült
-- a kapu (például mert egy jövőbeli migráció újraírta a törzsét).
create table if not exists public.rbac_rpc_guard (
  proc_name  text not null,
  module_kod text not null,
  action     text not null,
  indoklas   text,
  aktiv      boolean not null default true,
  primary key (proc_name, module_kod, action)
);

comment on table public.rbac_rpc_guard is
  '[UniPortal RBAC] Melyik író RPC-nek melyik modul-műveletet kell ellenőriznie.';

alter table public.rbac_rpc_guard enable row level security;
drop policy if exists rrg_select on public.rbac_rpc_guard;
create policy rrg_select on public.rbac_rpc_guard
  for select to authenticated using (public.is_approved());
drop policy if exists rrg_write on public.rbac_rpc_guard;
create policy rrg_write on public.rbac_rpc_guard
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
grant select on public.rbac_rpc_guard to authenticated;

insert into public.rbac_rpc_guard (proc_name, module_kod, action, indoklas) values
  ('admission_decide', 'admissions_core', 'USE',
   'felvételi döntés: felvéve / elutasítva / visszalépett'),
  ('student_program_decide', 'admissions_core', 'USE',
   'szak-szintű felvételi döntés'),
  ('student_program_enrol', 'admissions_core', 'EDIT',
   'beiratkozás rögzítése'),
  ('student_program_link', 'admissions_core', 'EDIT',
   'jelentkezés és szak összekötése'),
  ('student_attributes_save', 'registrations', 'EDIT',
   'hallgatói besorolás (tagozat, szint, szak, kar)'),
  ('group_save', 'registrations', 'EDIT',
   'csoport létrehozása és módosítása'),
  ('group_member_set', 'registrations', 'EDIT',
   'csoporttagság állítása'),
  ('agency_decide', 'agent_portal', 'USE',
   'ügynökségi regisztráció elbírálása'),
  ('agency_period_set_state', 'agent_portal', 'EDIT',
   'jutalék-periódus zárása és nyitása'),
  ('agency_commission_issue', 'agent_portal', 'USE',
   'jutalék-számlaigénylés kiküldése'),
  ('agency_invoice_decide', 'finance', 'USE',
   'partnerszámla elbírálása (jóváhagyás, kifizetés)'),
  ('echo_course_save', 'courses', 'EDIT',
   'kurzus felvitele és módosítása'),
  ('echo_course_delete', 'courses', 'DELETE',
   'kurzus törlése'),
  ('echo_course_enroll', 'courses', 'USE',
   'kurzusfelvétel rögzítése'),
  ('echo_course_teacher_set', 'courses', 'EDIT',
   'kurzus oktatójának beállítása'),
  ('echo_teacher_save', 'teachers', 'EDIT',
   'oktató felvitele és módosítása'),
  ('echo_teacher_delete', 'teachers', 'DELETE',
   'oktató törlése'),
  ('echo_teacher_set_active', 'teachers', 'EDIT',
   'oktató aktiválása és inaktiválása'),
  ('echo_teacher_course_set', 'teachers', 'EDIT',
   'oktató kurzus-hozzárendelése'),
  ('echo_campaign_create', 'echo_admin', 'CREATE',
   'ECHO kampány létrehozása'),
  ('echo_campaign_update', 'echo_admin', 'EDIT',
   'ECHO kampány módosítása'),
  ('echo_campaign_transition', 'echo_admin', 'USE',
   'ECHO kampány állapotváltása'),
  ('echo_campaign_audience_set', 'echo_admin', 'EDIT',
   'ECHO kampány célközönségének beállítása'),
  ('echo_question_bank_save', 'echo_admin', 'EDIT',
   'ECHO kérdésbank mentése'),
  ('echo_template_save', 'echo_admin', 'EDIT',
   'ECHO kérdőív-sablon mentése'),
  ('echo_export_log', 'reports', 'USE',
   'eredmény-export naplózása (adat visz ki)')
on conflict (proc_name, module_kod, action) do update
  set indoklas = excluded.indoklas, aktiv = true;


-- ============================================================================
-- 2. SZAKASZ — A FÜGGVÉNYEK
-- ============================================================================
-- Minden blokk fölött ott van, MELYIK migrációból való a törzs. A `create or
-- replace` MEGTARTJA a meglévő grantokat, ezért itt nem kell újra megadni
-- őket — a 99_harden_grants.sql amúgy is minden indulásnál felméri, mit tud az
-- authenticated, és azt adja vissza.


-- ---------------------------------------------------------------------------
-- admission_decide  ->  admissions_core : USE
-- Felvételi döntés: felvéve / elutasítva / visszalépett
-- A törzs forrása: 60_admission_decision_terms.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.admission_decide(
  p_id         text,
  p_outcome    text,
  p_program_id text default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row      public.admission_processes;
  v_allowed  text[];
  v_program  text := nullif(btrim(coalesce(p_program_id, '')), '');
  v_decision jsonb;
  v_name     text;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('admissions_core', 'USE');
  end if;
  if not coalesce(public.is_admissions(), false) then
    raise exception 'Felvételi döntést csak a felvételi iroda munkatársa hozhat.' using errcode = '42501';
  end if;
  if coalesce(p_outcome, '') not in ('admitted', 'rejected', 'withdrawn', 'pending') then
    raise exception 'Ismeretlen döntés: % (admitted / rejected / withdrawn / pending).', p_outcome using errcode = '22023';
  end if;

  select * into v_row from public.admission_processes where id = p_id for update;
  if v_row.id is null then
    raise exception 'Nincs ilyen felvételi folyamat: %', p_id using errcode = '02000';
  end if;

  select array_agg(distinct s.x) into v_allowed
    from (
      select v_row.program_id as x
      union all
      select jsonb_array_elements_text(case when jsonb_typeof(v_row.data -> 'program_ids') = 'array' then v_row.data -> 'program_ids' else '[]'::jsonb end)
      union all
      select jsonb_array_elements_text(case when jsonb_typeof(v_row.data -> 'programs') = 'array' then v_row.data -> 'programs' else '[]'::jsonb end)
    ) s
   where nullif(btrim(coalesce(s.x, '')), '') is not null;

  if p_outcome = 'admitted' then
    if v_program is null then
      if coalesce(array_length(v_allowed, 1), 0) = 1 then
        v_program := v_allowed[1];
      else
        raise exception 'Felvételnél meg kell adni, melyik képzésre vettük fel a jelentkezőt.' using errcode = '22023';
      end if;
    elsif not (v_program = any (coalesce(v_allowed, '{}'::text[]))) then
      raise exception 'A(z) "%" képzés nem szerepel a jelentkező által megjelölt képzések között.', v_program using errcode = '22023';
    end if;
  else
    v_program := null;
  end if;

  select coalesce(nullif(btrim(pr.name), ''), pr.email) into v_name from public.profiles pr where pr.id = auth.uid();

  if p_outcome = 'pending' then
    update public.admission_processes
       set data = coalesce(data, '{}'::jsonb) - 'decision', updated_at = now()
     where id = p_id;
    return jsonb_build_object('id', p_id, 'decision', null);
  end if;

  v_decision := jsonb_build_object(
    'outcome',   p_outcome,
    'programId', v_program,
    'note',      nullif(btrim(coalesce(p_note, '')), ''),
    'at',        now(),
    'by',        auth.uid(),
    'byName',    v_name);

  update public.admission_processes
     set data = jsonb_set(coalesce(data, '{}'::jsonb), '{decision}', v_decision, true),
         updated_at = now()
   where id = p_id;

  return jsonb_build_object('id', p_id, 'decision', v_decision);
end
$fn$;


-- ---------------------------------------------------------------------------
-- student_program_decide  ->  admissions_core : USE
-- Szak-szintű felvételi döntés
-- A törzs forrása: 32_multi_program.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.student_program_decide(
  p_id       text,
  p_decision text,
  p_note     text default null)
returns public.student_program
language plpgsql security definer set search_path = public
as $$
declare v_sor public.student_program;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('admissions_core', 'USE');
  end if;
  if not public.is_admissions() and not public.is_admin() and not public.is_superadmin() then
    raise exception 'Csak a Felvételi Iroda dönthet jelentkezésről.' using errcode = '42501';
  end if;
  if p_decision not in ('Pending','Admitted','Rejected','Waitlisted','Withdrawn') then
    raise exception 'Ismeretlen döntés: %', p_decision using errcode = '22023';
  end if;

  update public.student_program
     set decision   = p_decision,
         decided_at = case when p_decision = 'Pending' then null else now() end,
         decided_by = case when p_decision = 'Pending' then null else auth.uid() end,
         note       = coalesce(p_note, note),
         enrolled   = case when p_decision <> 'Admitted' then false else enrolled end
   where id = p_id
  returning * into v_sor;

  if v_sor.id is null then
    raise exception 'Nincs ilyen jelentkezés: %', p_id using errcode = '02000';
  end if;
  return v_sor;
end $$;


-- ---------------------------------------------------------------------------
-- student_program_enrol  ->  admissions_core : EDIT
-- Beiratkozás rögzítése
-- A törzs forrása: 32_multi_program.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.student_program_enrol(p_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_sor      public.student_program;
  v_policy   text := public.student_program_setting_text('dual_admission_policy','applicant_chooses');
  v_masik    integer;
  v_elso     text;
  v_lezart   integer := 0;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('admissions_core', 'EDIT');
  end if;
  select * into v_sor from public.student_program where id = p_id;
  if v_sor.id is null then
    raise exception 'Nincs ilyen jelentkezés: %', p_id using errcode = '02000';
  end if;

  -- Jelentkező a sajátjára, ügyintéző bármelyikre.
  if not public.is_staff() and v_sor.student_id is distinct from public.my_student_id() then
    raise exception 'Csak a saját jelentkezésére iratkozhat be.' using errcode = '42501';
  end if;

  if v_sor.decision <> 'Admitted' then
    raise exception 'Beiratkozni csak felvett szakra lehet. A jelentkezés állapota: "%".',
      v_sor.decision using errcode = '42501';
  end if;

  select count(*) into v_masik
    from public.student_program
   where student_id = v_sor.student_id and id <> p_id
     and decision = 'Admitted' and enrolled = false;

  if v_policy = 'first_preference_wins' and v_masik > 0 then
    select id into v_elso
      from public.student_program
     where student_id = v_sor.student_id and decision = 'Admitted'
     order by preference asc, created_at asc
     limit 1;
    if v_elso is distinct from p_id then
      raise exception
        'Az intézményi szabály szerint az 1. helyen jelölt szak az irányadó. '
        'Ezen a jelentkezésen nem lehet beiratkozni.'
        using errcode = '42501';
    end if;
  end if;

  update public.student_program set enrolled = true where id = p_id;

  if v_policy in ('applicant_chooses','first_preference_wins') then
    update public.student_program
       set decision = 'Withdrawn', enrolled = false,
           note = coalesce(note,'') ||
                  case when coalesce(note,'') = '' then '' else ' | ' end ||
                  'Automatikusan lezárva: a jelentkező másik szakra iratkozott be.'
     where student_id = v_sor.student_id
       and id <> p_id
       and decision in ('Admitted','Pending','Waitlisted');
    get diagnostics v_lezart = row_count;
  end if;

  -- A SZEMÉLY-szintű beiratkozási dátumot csak akkor írjuk, ha a fő státusz
  -- már "Accepted". A 25-ös migráció students_enrollment_guard őre ezt
  -- amúgy is kikényszeríti — nem harcolunk vele, hanem igazodunk hozzá:
  -- a program-szintű beiratkozás ettől függetlenül rögzül.
  update public.students set enrolled_at = current_date
   where id = v_sor.student_id
     and enrolled_at is null
     and status = 'Accepted';

  return jsonb_build_object(
    'id', p_id,
    'student_id', v_sor.student_id,
    'policy', v_policy,
    'lezart_masik_jelentkezes', v_lezart);
end $$;


-- ---------------------------------------------------------------------------
-- student_program_link  ->  admissions_core : EDIT
-- Jelentkezés és szak összekötése
-- A törzs forrása: 32_multi_program.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.student_program_link(p_id text, p_program_id text)
returns public.student_program
language plpgsql security definer set search_path = public
as $$
declare v_sor public.student_program;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('admissions_core', 'EDIT');
  end if;
  if not public.is_staff() then
    raise exception 'Csak ügyintéző kötheti a katalógushoz.' using errcode = '42501';
  end if;
  update public.student_program
     set program_id = p_program_id, program_label = null
   where id = p_id
  returning * into v_sor;
  if v_sor.id is null then
    raise exception 'Nincs ilyen jelentkezés: %', p_id using errcode = '02000';
  end if;
  return v_sor;
end $$;


-- ---------------------------------------------------------------------------
-- student_attributes_save  ->  registrations : EDIT
-- Hallgatói besorolás (tagozat, szint, szak, kar)
-- A törzs forrása: 40_attributes_edit.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.student_attributes_save(
  p_profile       uuid,
  p_tagozat       text default null,
  p_kepzesi_szint text default null,
  p_szak          text default null,
  p_kar           text default null,
  p_neptun        text default null)
returns public.student_attributes
language plpgsql security definer set search_path = public
as $$
declare
  v_r public.student_attributes;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('registrations', 'EDIT');
  end if;
  if not public.is_admin() and not public.is_superadmin() then
    raise exception 'A besorolást csak admin vagy szuperadmin módosíthatja.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'Nincs ilyen fiók.' using errcode = '02000';
  end if;

  insert into public.student_attributes (profile_id, tagozat, kepzesi_szint, szak, kar, neptun, forras)
  values (p_profile,
          nullif(btrim(coalesce(p_tagozat, '')), ''),
          nullif(btrim(coalesce(p_kepzesi_szint, '')), ''),
          nullif(btrim(coalesce(p_szak, '')), ''),
          nullif(btrim(coalesce(p_kar, '')), ''),
          nullif(btrim(coalesce(p_neptun, '')), ''),
          'kezi')
  on conflict (profile_id) do update set
    -- NULL = ne változtass; üres szöveg = töröld.
    tagozat       = case when p_tagozat       is null then public.student_attributes.tagozat
                         else nullif(btrim(p_tagozat), '') end,
    kepzesi_szint = case when p_kepzesi_szint is null then public.student_attributes.kepzesi_szint
                         else nullif(btrim(p_kepzesi_szint), '') end,
    szak          = case when p_szak          is null then public.student_attributes.szak
                         else nullif(btrim(p_szak), '') end,
    kar           = case when p_kar           is null then public.student_attributes.kar
                         else nullif(btrim(p_kar), '') end,
    neptun        = case when p_neptun        is null then public.student_attributes.neptun
                         else nullif(btrim(p_neptun), '') end,
    updated_at    = now()
  returning * into v_r;

  return v_r;
end $$;


-- ---------------------------------------------------------------------------
-- group_save  ->  registrations : EDIT
-- Csoport létrehozása és módosítása
-- A törzs forrása: 38_student_groups.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.group_save(
  p_id      text default null,
  p_nev     text default null,
  p_leiras  text default null,
  p_tipus   text default 'kezi',
  p_szabaly jsonb default null,
  p_szin    text default null)
returns public.user_group
language plpgsql security definer set search_path = public
as $$
declare v_g public.user_group;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('registrations', 'EDIT');
  end if;
  if not public.is_admin() and not public.is_superadmin() then
    raise exception 'Csoportot csak admin kezelhet.' using errcode = '42501';
  end if;
  if p_tipus not in ('kezi', 'szabaly') then
    raise exception 'Ismeretlen csoporttípus: %', p_tipus using errcode = '22023';
  end if;
  if p_tipus = 'szabaly' and p_szabaly is null then
    raise exception 'Szabály alapú csoporthoz szabály is kell.' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.user_group(nev, leiras, tipus, szabaly, szin, created_by)
    values (btrim(p_nev), p_leiras, p_tipus,
            case when p_tipus = 'szabaly' then p_szabaly else null end,
            p_szin, auth.uid())
    returning * into v_g;
  else
    update public.user_group
       set nev     = coalesce(btrim(p_nev), nev),
           leiras  = coalesce(p_leiras, leiras),
           tipus   = coalesce(p_tipus, tipus),
           szabaly = case when coalesce(p_tipus, tipus) = 'szabaly'
                          then coalesce(p_szabaly, szabaly) else null end,
           szin    = coalesce(p_szin, szin),
           updated_at = now()
     where id = p_id
    returning * into v_g;
    if v_g.id is null then raise exception 'Nincs ilyen csoport: %', p_id using errcode='02000'; end if;
  end if;
  return v_g;
end $$;


-- ---------------------------------------------------------------------------
-- group_member_set  ->  registrations : EDIT
-- Csoporttagság állítása
-- A törzs forrása: 38_student_groups.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.group_member_set(
  p_group text, p_profile uuid, p_tag boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('registrations', 'EDIT');
  end if;
  if not public.is_admin() and not public.is_superadmin() then
    raise exception 'Csoporttagságot csak admin állíthat.' using errcode = '42501';
  end if;
  if exists (select 1 from public.user_group where id = p_group and tipus = 'szabaly') then
    raise exception
      'Ez szabály alapú csoport — a tagság a szabályból következik, kézzel nem állítható.'
      using errcode = '42501';
  end if;
  if p_tag then
    insert into public.user_group_member(group_id, profile_id, added_by)
    values (p_group, p_profile, auth.uid())
    on conflict do nothing;
  else
    delete from public.user_group_member where group_id = p_group and profile_id = p_profile;
  end if;
  return true;
end $$;


-- ---------------------------------------------------------------------------
-- agency_decide  ->  agent_portal : USE
-- Ügynökségi regisztráció elbírálása
-- A törzs forrása: 67_agency_guard_fix.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.agency_decide(
  p_agency   text,
  p_decision text,
  p_reason   text default null,
  p_rate     numeric default null
) returns public."agencies"
language plpgsql security definer set search_path = public as $$
declare
  ag public."agencies";
  who       text;
  jwt_saved text;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('agent_portal', 'USE');
  end if;
  if not (public.is_admin() or public.is_trusted_caller()) then
    raise exception 'Csak SUPERADMIN vagy ADMIN dönthet ügynökségi regisztrációról.'
      using errcode = 'insufficient_privilege';
  end if;
  -- A döntéshozó nevét MOST rögzítjük: lentebb a JWT-t átmenetileg kiütjük,
  -- és utána a my_email() már nem tudná megmondani, ki döntött.
  who := coalesce(nullif(public.my_email(), ''), 'system (SQL)');
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Ismeretlen döntés: % (approved vagy rejected lehet).', p_decision
      using errcode = 'check_violation';
  end if;
  if p_decision = 'rejected' and coalesce(trim(p_reason), '') = '' then
    raise exception 'Az elutasításhoz indoklás kell.' using errcode = 'check_violation';
  end if;

  update public."agencies" a
     set "approval_status" = p_decision,
         "status"          = case when p_decision = 'approved' then 'Active' else 'Rejected' end,
         "commissionRate"  = case when p_decision = 'approved' and p_rate is not null
                                  then p_rate else a."commissionRate" end,
         "rejected_reason" = case when p_decision = 'rejected' then trim(p_reason) else null end,
         "decided_at"      = now(),
         "decided_by"      = who
   where a.id = p_agency
  returning * into ag;

  if ag.id is null then
    raise exception 'Nincs ilyen ügynökség: %', p_agency using errcode = 'no_data_found';
  end if;

  -- A hozzá tartozó fiókok együtt mozognak az ügynökséggel.
  --
  -- MÉRVE, ÉS EZÉRT NÉZ KI ÍGY: a 11-es migráció profiles_protect_privileges
  -- triggere NÉMÁN visszaírja az approval_status-t mindenkinek, aki nem
  -- SUPERADMIN és van JWT-je (nem hibát dob — egyszerűen nem történik semmi).
  -- Egy sima ADMIN döntése tehát nyom nélkül elveszett: az ügynökség
  -- jóváhagyottá vált, a hozzá tartozó fiók viszont 'pending' maradt, és a
  -- kolléga hiába próbált belépni.
  --
  -- A trigger a JWT NÉLKÜLI hívót (migráció, SQL Editor, service_role)
  -- megbízhatónak tekinti. Ez a függvény SECURITY DEFINER, a jogosultságot
  -- pedig már fent ellenőriztük, tehát erre az EGY utasításra jogosan
  -- lépünk be ezen az ajtón: a claimeket tranzakció-lokálisan kiütjük,
  -- majd visszaállítjuk. A 11-es migrációhoz nem nyúlunk.
  -- ÜRES SZTRING NEM JÓ IDE, és ezt is méréssel tanultuk meg: az auth.uid()
  -- a claimeket JSON-ként olvassa, az '' pedig érvénytelen JSON — az egész
  -- hívás elszállt volna. Az ÜRES JSON OBJEKTUM viszont mindkét oldalon
  -- (helyi replika és Supabase) szabályosan NULL azonosítót ad.
  jwt_saved := coalesce(current_setting('request.jwt.claims', true), '{}');
  perform set_config('request.jwt.claims', '{}', true);

  update public.profiles
     set approval_status = case when p_decision = 'approved' then 'approved' else 'rejected' end,
         rejected_reason = case when p_decision = 'rejected' then trim(p_reason) else null end
   where "agencyId" = p_agency
     and role = 'AGENT'
     and approval_status = 'pending';

  -- A trigger a státuszváltáskor 'sql-editor'-t ír az approved_by-ba (mert
  -- épp nincs JWT). Egy külön, státuszt NEM mozgató utasítással írjuk vissza
  -- a valódi döntéshozót — ezt a trigger már békén hagyja.
  update public.profiles
     set approved_by = who
   where "agencyId" = p_agency
     and role = 'AGENT'
     and approved_by = 'sql-editor';

  perform set_config('request.jwt.claims', coalesce(nullif(jwt_saved, ''), '{}'), true);

  perform public.log_status_event(
    'agency.' || p_decision,
    'agencies/' || ag.id,
    ag.name || ' -> ' || p_decision || coalesce(' (' || nullif(trim(p_reason), '') || ')', '')
  );
  return ag;
end
$$;


-- ---------------------------------------------------------------------------
-- agency_period_set_state  ->  agent_portal : EDIT
-- Jutalék-periódus zárása és nyitása
-- A törzs forrása: 67_agency_guard_fix.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.agency_period_set_state(
  p_period text,
  p_state  text
) returns public.agency_commission_period
language plpgsql security definer set search_path = public as $$
declare pr public.agency_commission_period;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('agent_portal', 'EDIT');
  end if;
  if not (public.is_admin() or public.is_trusted_caller()) then
    raise exception 'A beiratkozási időszakot csak ADMIN zárhatja vagy nyithatja.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_state not in ('open', 'closed') then
    raise exception 'Ismeretlen állapot: %', p_state using errcode = 'check_violation';
  end if;
  update public.agency_commission_period
     set state     = p_state,
         closed_at = case when p_state = 'closed' then now() else null end,
         closed_by = case when p_state = 'closed'
                          then coalesce(nullif(public.my_email(), ''), 'system (SQL)') else null end
   where id = p_period
  returning * into pr;
  if pr.id is null then
    raise exception 'Nincs ilyen időszak: %', p_period using errcode = 'no_data_found';
  end if;
  perform public.log_status_event('agency.period.' || p_state, 'agency_commission_period/' || pr.id, pr.label);
  return pr;
end
$$;


-- ---------------------------------------------------------------------------
-- agency_commission_issue  ->  agent_portal : USE
-- Jutalék-számlaigénylés kiküldése
-- A törzs forrása: 67_agency_guard_fix.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.agency_commission_issue(
  p_period text,
  p_agency text,
  p_due_on date default null,
  p_note   text default null
) returns public.agency_invoice
language plpgsql security definer set search_path = public as $$
declare
  pr  public.agency_commission_period;
  ag  public."agencies";
  inv public.agency_invoice;
  n   integer := 0;
  tot numeric := 0;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('agent_portal', 'USE');
  end if;
  if not (public.is_admin() or public.is_trusted_caller()) then
    raise exception 'A jutalék-számlaigénylést csak ADMIN küldheti ki (az ügynökség nem igényli).'
      using errcode = 'insufficient_privilege';
  end if;

  select * into pr from public.agency_commission_period where id = p_period;
  if pr.id is null then
    raise exception 'Nincs ilyen beiratkozási időszak: %', p_period using errcode = 'no_data_found';
  end if;
  if pr.state <> 'closed' then
    raise exception
      'A jutalék csak a beiratkozás LEZÁRÁSA után igényelhető. A(z) "%" időszak még nyitva van.',
      pr.label using errcode = 'check_violation';
  end if;

  select * into ag from public."agencies" where id = p_agency;
  if ag.id is null then
    raise exception 'Nincs ilyen ügynökség: %', p_agency using errcode = 'no_data_found';
  end if;
  if ag."approval_status" <> 'approved' then
    raise exception 'A(z) "%" ügynökség még nincs jóváhagyva.', ag.name using errcode = 'check_violation';
  end if;

  insert into public.agency_invoice
    (id, agency_id, period_id, status, amount, currency, student_count,
     requested_at, requested_by, due_on, note)
  values
    ('AGI-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12),
     ag.id, pr.id, 'requested', 0, 'EUR', 0,
     now(), coalesce(nullif(public.my_email(), ''), 'system (SQL)'),
     coalesce(p_due_on, (current_date + 30)), p_note)
  returning * into inv;

  insert into public.agency_commission_item
    (id, invoice_id, student_id, student_name, program, tuition_fee, rate, amount, enrolled_on)
  select 'AGC-' || substr(md5(inv.id || v.student_id), 1, 14),
         inv.id, v.student_id, v.student_name, v.program,
         v.tuition_fee, v.rate, v.amount, v.enrolled_on
    from public.agency_commission_preview(p_period, p_agency) v
   where v.already_invoiced = false
  on conflict (invoice_id, student_id) do nothing;

  select count(*), coalesce(sum(amount), 0) into n, tot
    from public.agency_commission_item where invoice_id = inv.id;

  if n = 0 then
    delete from public.agency_invoice where id = inv.id;
    raise exception
      'A(z) "%" ügynökséghez nincs elszámolható beiratkozott hallgató a(z) "%" időszakban.',
      ag.name, pr.label using errcode = 'no_data_found';
  end if;

  update public.agency_invoice
     set student_count = n, amount = tot
   where id = inv.id
  returning * into inv;

  perform public.log_status_event('agency.commission.issued', 'agency_invoice/' || inv.id,
    ag.name || ' · ' || pr.label || ' · ' || n || ' hallgató · ' || tot || ' EUR');
  return inv;
end
$$;


-- ---------------------------------------------------------------------------
-- agency_invoice_decide  ->  finance : USE
-- Partnerszámla elbírálása (jóváhagyás, kifizetés)
-- A törzs forrása: 67_agency_guard_fix.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.agency_invoice_decide(
  p_invoice  text,
  p_decision text,
  p_reason   text default null
) returns public.agency_invoice
language plpgsql security definer set search_path = public as $$
declare inv public.agency_invoice;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('finance', 'USE');
  end if;
  if not (public.is_admin() or public.is_finance() or public.is_trusted_caller()) then
    raise exception 'A számláról csak ADMIN vagy PÉNZÜGY dönthet.' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'rejected', 'paid') then
    raise exception 'Ismeretlen döntés: % (approved, rejected vagy paid).', p_decision
      using errcode = 'check_violation';
  end if;
  if p_decision = 'rejected' and coalesce(trim(p_reason), '') = '' then
    raise exception 'A visszaküldéshez indoklás kell.' using errcode = 'check_violation';
  end if;

  update public.agency_invoice
     set status        = p_decision,
         reject_reason = case when p_decision = 'rejected' then trim(p_reason) else null end,
         decided_at    = now(),
         decided_by    = coalesce(nullif(public.my_email(), ''), 'system (SQL)'),
         paid_at       = case when p_decision = 'paid' then now() else paid_at end
   where id = p_invoice
  returning * into inv;

  if inv.id is null then
    raise exception 'Nincs ilyen számla: %', p_invoice using errcode = 'no_data_found';
  end if;
  perform public.log_status_event('agency.invoice.' || p_decision, 'agency_invoice/' || inv.id,
    coalesce(inv.invoice_number, inv.id) || coalesce(' — ' || nullif(trim(p_reason), ''), ''));
  return inv;
end
$$;


-- ---------------------------------------------------------------------------
-- echo_course_save  ->  courses : EDIT
-- Kurzus felvitele és módosítása
-- A törzs forrása: 43_course_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_course_save(
  p_id                uuid    default null,
  p_code              text    default null,
  p_name_hu           text    default null,
  p_name_en           text    default null,
  p_term              text    default null,
  p_lang              text    default null,
  p_org_unit_id       uuid    default null,
  p_letszam           int     default null,
  p_van_orarendi_info boolean default null,
  p_vizsgakurzus      boolean default null,
  p_leiras            text    default null,
  p_leiras_en         text    default null,
  p_clear             text[]  default null
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  v_clear text[] := coalesce(p_clear, '{}'::text[]);
  v_id    uuid;
  v_code  text := nullif(btrim(coalesce(p_code, '')), '');
  v_nev   text := nullif(btrim(coalesce(p_name_hu, '')), '');
  v_term  text := nullif(btrim(coalesce(p_term, '')), '');
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('courses', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;

  if p_id is null then
    if v_code is null or v_nev is null or v_term is null then
      raise exception 'ECHO_BAD_INPUT: uj kurzushoz a kod, a magyar nev es a felev kotelezo.';
    end if;
    begin
      insert into echo.course (code, name_hu, name_en, term, lang, org_unit_id, letszam,
                               van_orarendi_info, vizsgakurzus, leiras, leiras_en, ext_source)
      values (v_code, v_nev, nullif(btrim(coalesce(p_name_en,'')),''), v_term,
              coalesce(nullif(btrim(coalesce(p_lang,'')),''), 'hu'),
              p_org_unit_id, p_letszam,
              coalesce(p_van_orarendi_info, true), coalesce(p_vizsgakurzus, false),
              nullif(btrim(coalesce(p_leiras,'')),''),
              nullif(btrim(coalesce(p_leiras_en,'')),''), 'manual')
      returning id into v_id;
    exception when unique_violation then
      raise exception 'ECHO_COURSE_DUPLICATE: a(z) "%" kod ebben a felevben (%) mar letezik. '
                      'A kurzuskod felevenkent egyedi.', v_code, v_term;
    end;
  else
    if not exists (select 1 from echo.course where id = p_id) then
      raise exception 'ECHO_COURSE_NOT_FOUND';
    end if;
    v_id := p_id;
    begin
      update echo.course set
        code              = coalesce(v_code, code),
        name_hu           = coalesce(v_nev, name_hu),
        name_en           = case when 'name_en' = any(v_clear) then null
                                 else coalesce(nullif(btrim(coalesce(p_name_en,'')),''), name_en) end,
        term              = coalesce(v_term, term),
        lang              = coalesce(nullif(btrim(coalesce(p_lang,'')),''), lang),
        org_unit_id       = case when 'org_unit' = any(v_clear) then null
                                 else coalesce(p_org_unit_id, org_unit_id) end,
        letszam           = case when 'letszam' = any(v_clear) then null
                                 else coalesce(p_letszam, letszam) end,
        van_orarendi_info = coalesce(p_van_orarendi_info, van_orarendi_info),
        vizsgakurzus      = coalesce(p_vizsgakurzus, vizsgakurzus),
        leiras            = case when 'leiras' = any(v_clear) then null
                                 else coalesce(nullif(btrim(coalesce(p_leiras,'')),''), leiras) end,
        leiras_en         = case when 'leiras_en' = any(v_clear) then null
                                 else coalesce(nullif(btrim(coalesce(p_leiras_en,'')),''), leiras_en) end
      where id = v_id;
    exception when unique_violation then
      raise exception 'ECHO_COURSE_DUPLICATE: ez a kod ebben a felevben mar letezik.';
    end;
  end if;

  perform echo.log_access('echo_course_save', null, v_id, null, 'course');
  return public.echo_course_get(v_id);
end $$;


-- ---------------------------------------------------------------------------
-- echo_course_delete  ->  courses : DELETE
-- Kurzus törlése
-- A törzs forrása: 43_course_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_course_delete(p_course uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare k echo.course%rowtype; v_k int; v_v int; v_h int;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('courses', 'DELETE');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;
  select * into k from echo.course where id = p_course;
  if not found then raise exception 'ECHO_COURSE_NOT_FOUND'; end if;

  select count(distinct campaign_id) into v_k from echo.eligibility where course_id = p_course;
  select count(*) into v_v from echo.response  where course_id = p_course;
  select count(*) into v_h from echo.enrollment where course_id = p_course;

  if v_k > 0 or v_v > 0 then
    raise exception 'ECHO_COURSE_IN_USE: a kurzus % kampanyban szerepel es % valasz tartozik '
                    'hozza. A torles kaszkadolna az alkalmassagi es reszveteli sorokra, '
                    'vagyis kampanytortenetet semmisitene meg. Ha a kurzus mar nem aktualis, '
                    'vedd ki a kesobbi kampanyok celkozonsegebol.', v_k, v_v;
  end if;

  delete from echo.course where id = p_course;
  perform echo.log_access('echo_course_delete', null, p_course, null, 'course');
  return jsonb_build_object('ok', true, 'code', k.code, 'torolt_beiratkozas', v_h);
end $$;


-- ---------------------------------------------------------------------------
-- echo_course_enroll  ->  courses : USE
-- Kurzusfelvétel rögzítése
-- A törzs forrása: 43_course_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_course_enroll(
  p_course   uuid,
  p_profiles uuid[] default null,
  p_group    text   default null,
  p_action   text   default 'add'
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare v_ids uuid[]; v_n int := 0; v_act text := coalesce(p_action, 'add');
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('courses', 'USE');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;
  if not exists (select 1 from echo.course where id = p_course) then raise exception 'ECHO_COURSE_NOT_FOUND'; end if;
  if v_act not in ('add','remove','drop') then
    raise exception 'ECHO_BAD_INPUT: ismeretlen muvelet: "%". Ervenyes: add, remove, drop.', v_act;
  end if;

  -- A csoportot ITT oldjuk fel, a mentés pillanatában: egy szabály alapú
  -- csoport tagsága később változhat, a beiratkozás viszont tény, nem szabály.
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids
    from (
      select unnest(coalesce(p_profiles, '{}'::uuid[])) as x
      union
      select m.profile_id from public.user_group_member m
       where p_group is not null and m.group_id = p_group
      union
      select p.id from public.profiles p
       join public.user_group g on g.id = p_group and g.tipus = 'szabaly'
       where p_group is not null and public.group_rule_matches(g.szabaly, p.id)
    ) s
   where x is not null;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'ECHO_BAD_INPUT: nincs egyetlen kijelolt hallgato sem.';
  end if;

  if v_act = 'add' then
    insert into echo.enrollment (course_id, student_key, status, ext_source)
    select p_course, u, 'active', 'manual' from unnest(v_ids) u
      where exists (select 1 from public.profiles pr where pr.id = u)
    on conflict (course_id, student_key) do update set status = 'active';
    get diagnostics v_n = row_count;
  elsif v_act = 'drop' then
    update echo.enrollment set status = 'dropped'
     where course_id = p_course and student_key = any(v_ids);
    get diagnostics v_n = row_count;
  else
    delete from echo.enrollment
     where course_id = p_course and student_key = any(v_ids);
    get diagnostics v_n = row_count;
  end if;

  perform echo.log_access('echo_course_enroll', null, p_course, null, v_act);
  return jsonb_build_object('ok', true, 'muvelet', v_act, 'erintett', v_n,
                            'hallgato_szam', (select count(*) from echo.enrollment
                                               where course_id = p_course and status='active'));
end $$;


-- ---------------------------------------------------------------------------
-- echo_course_teacher_set  ->  courses : EDIT
-- Kurzus oktatójának beállítása
-- A törzs forrása: 43_course_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_course_teacher_set(
  p_course uuid, p_teacher uuid,
  p_share numeric default null, p_role text default null, p_remove boolean default false
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('courses', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;
  if not exists (select 1 from echo.course  where id = p_course)  then raise exception 'ECHO_COURSE_NOT_FOUND'; end if;
  if not exists (select 1 from echo.teacher where id = p_teacher) then raise exception 'ECHO_TEACHER_NOT_FOUND'; end if;

  if coalesce(p_remove, false) then
    delete from echo.course_teacher where course_id = p_course and teacher_id = p_teacher;
  else
    insert into echo.course_teacher (course_id, teacher_id, share_pct, role, ext_source)
    values (p_course, p_teacher, coalesce(p_share, 100), coalesce(nullif(p_role,''), 'oktato'), 'manual')
    on conflict (course_id, teacher_id) do update
      set share_pct = coalesce(p_share, echo.course_teacher.share_pct),
          role      = coalesce(nullif(p_role,''), echo.course_teacher.role);
  end if;
  perform echo.log_access('echo_course_teacher_set', null, p_course, null, 'course');
  return public.echo_course_get(p_course);
end $$;


-- ---------------------------------------------------------------------------
-- echo_teacher_save  ->  teachers : EDIT
-- Oktató felvitele és módosítása
-- A törzs forrása: 54_teacher_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_teacher_save(
  p_id          uuid   default null,
  p_code        text   default null,
  p_name        text   default null,
  p_title       text   default null,
  p_email       text   default null,
  p_org_unit_id uuid   default null,
  p_clear       text[] default null
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  v_clear text[] := coalesce(p_clear, '{}'::text[]);
  v_id    uuid;
  v_code  text := nullif(btrim(coalesce(p_code, '')), '');
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('teachers', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'ECHO_BAD_INPUT: a megadott e-mail cím nem érvényes: "%".', v_email;
  end if;

  if p_id is null then
    if v_code is null or v_name is null then
      raise exception 'ECHO_BAD_INPUT: új oktatóhoz a kód és a név kötelező.';
    end if;
    begin
      insert into echo.teacher (code, name, title, email, org_unit_id, active, ext_source)
      values (v_code, v_name,
              nullif(btrim(coalesce(p_title,'')),''),
              v_email, p_org_unit_id, true, 'manual')
      returning id into v_id;
    exception when unique_violation then
      raise exception 'ECHO_TEACHER_DUPLICATE: a(z) "%" kód már foglalt. '
                      'Az oktatói kód egyedi.', v_code;
    end;
  else
    if not exists (select 1 from echo.teacher where id = p_id) then
      raise exception 'ECHO_TEACHER_NOT_FOUND';
    end if;
    v_id := p_id;
    begin
      update echo.teacher set
        code        = coalesce(v_code, code),
        name        = coalesce(v_name, name),
        title       = case when 'title' = any(v_clear) then null
                           else coalesce(nullif(btrim(coalesce(p_title,'')),''), title) end,
        email       = case when 'email' = any(v_clear) then null
                           else coalesce(v_email, email) end,
        org_unit_id = case when 'org_unit' = any(v_clear) then null
                           else coalesce(p_org_unit_id, org_unit_id) end
      where id = v_id;
    exception when unique_violation then
      raise exception 'ECHO_TEACHER_DUPLICATE: ez a kód már egy másik oktatóé.';
    end;
  end if;

  perform echo.log_access('echo_teacher_save', null, null, v_id, 'teacher');
  return public.echo_teacher_get(v_id);
end $$;


-- ---------------------------------------------------------------------------
-- echo_teacher_delete  ->  teachers : DELETE
-- Oktató törlése
-- A törzs forrása: 54_teacher_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_teacher_delete(p_teacher uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  t      echo.teacher%rowtype;
  v_jog  int; v_val int; v_kiz int; v_jkv int; v_esz int; v_krz int;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('teachers', 'DELETE');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then
    raise exception 'ECHO_FORBIDDEN: oktatót csak rendszergazda törölhet.';
  end if;

  select * into t from echo.teacher where id = p_teacher;
  if t.id is null then raise exception 'ECHO_TEACHER_NOT_FOUND'; end if;

  select count(*) into v_krz from echo.course_teacher    where teacher_id = p_teacher;
  select count(*) into v_jog from echo.eligibility       where teacher_id = p_teacher;
  select count(*) into v_val from echo.response          where teacher_id = p_teacher;
  select count(*) into v_kiz from echo.exclusion_log     where teacher_id = p_teacher;
  select count(*) into v_jkv from echo.protocol_handover where teacher_id = p_teacher;
  select count(*) into v_esz from echo.teacher_comment   where teacher_id = p_teacher;

  if v_jog > 0 or v_val > 0 or v_kiz > 0 or v_jkv > 0 or v_esz > 0 then
    raise exception 'ECHO_TEACHER_IN_USE: az oktató kampányban szerepel — % jogosultsági sor, '
                    '% válasz, % kizárási bejegyzés, % jegyzőkönyv-átadás, % észrevétel tartozik '
                    'hozzá. A törlés ezeket is elvinné, ezért nem engedjük. Használd az '
                    'inaktiválást: az oktató kikerül a választókból, a története megmarad.',
                    v_jog, v_val, v_kiz, v_jkv, v_esz;
  end if;

  if v_krz > 0 then
    raise exception 'ECHO_TEACHER_HAS_COURSES: az oktatóhoz még % kurzus van rendelve. '
                    'Előbb vedd le róluk, utána törölhető.', v_krz;
  end if;

  delete from echo.teacher where id = p_teacher;
  perform echo.log_access('echo_teacher_delete', null, null, p_teacher, 'teacher');
  return jsonb_build_object('torolve', true, 'name', t.name, 'code', t.code);
end $$;


-- ---------------------------------------------------------------------------
-- echo_teacher_set_active  ->  teachers : EDIT
-- Oktató aktiválása és inaktiválása
-- A törzs forrása: 54_teacher_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_teacher_set_active(
  p_teacher uuid,
  p_active  boolean,
  p_indok   text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  t       echo.teacher%rowtype;
  v_kurz  int;
  v_uzen  text := null;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('teachers', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;
  if p_active is null then
    raise exception 'ECHO_BAD_INPUT: meg kell adni, aktív legyen-e az oktató.';
  end if;

  select * into t from echo.teacher where id = p_teacher;
  if t.id is null then raise exception 'ECHO_TEACHER_NOT_FOUND'; end if;

  if t.active = p_active then
    raise exception 'ECHO_TEACHER_STATE: az oktató már % állapotban van.',
                    case when p_active then 'aktív' else 'inaktív' end;
  end if;

  update echo.teacher set active = p_active where id = p_teacher;

  select count(*) into v_kurz from echo.course_teacher where teacher_id = p_teacher;
  if not p_active and v_kurz > 0 then
    v_uzen := format('Az oktatónak még %s kurzus-hozzárendelése van. Amíg ezek megmaradnak, '
                     'egy új kampány jogosultság-építése továbbra is behúzza — az inaktív '
                     'jelző a nyilvántartásban és a választókban érvényesül. Ha tényleg nem '
                     'tanít többet, vedd le a kurzusairól is.', v_kurz);
  end if;

  perform echo.log_access('echo_teacher_set_active', null, null, p_teacher, 'teacher');

  return jsonb_build_object(
    'oktato',          public.echo_teacher_get(p_teacher),
    'figyelmeztetes',  v_uzen,
    'kurzus',          v_kurz);
end $$;


-- ---------------------------------------------------------------------------
-- echo_teacher_course_set  ->  teachers : EDIT
-- Oktató kurzus-hozzárendelése
-- A törzs forrása: 54_teacher_registry.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_teacher_course_set(
  p_teacher uuid,
  p_course  uuid,
  p_share   numeric default null,
  p_role    text    default null,
  p_remove  boolean default false
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare v_role text := lower(nullif(btrim(coalesce(p_role,'')),''));
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('teachers', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;

  if not exists (select 1 from echo.teacher where id = p_teacher) then
    raise exception 'ECHO_TEACHER_NOT_FOUND';
  end if;
  if not exists (select 1 from echo.course where id = p_course) then
    raise exception 'ECHO_COURSE_NOT_FOUND';
  end if;

  if coalesce(p_remove, false) then
    -- A már beérkezett válasz a kötéshez tartozik: ha levennénk az oktatót a
    -- kurzusról, a válasz oktató nélkül maradna. A response FK RESTRICT-je
    -- ezt a törlést nem fogja meg (az a teacher sorra vonatkozik), ezért itt
    -- kell kimondani.
    if exists (select 1 from echo.response r
                where r.teacher_id = p_teacher and r.course_id = p_course) then
      raise exception 'ECHO_TEACHER_HAS_RESPONSE: erre a kurzusra már érkezett '
                      'értékelés erről az oktatóról, ezért a hozzárendelés nem vehető le. '
                      'Ha nem tanítja tovább, a következő félév kurzusához ne rendeld hozzá.';
    end if;
    delete from echo.course_teacher where teacher_id = p_teacher and course_id = p_course;
  else
    if p_share is not null and (p_share < 0 or p_share > 100) then
      raise exception 'ECHO_BAD_INPUT: a részarány 0 és 100 közötti szám lehet.';
    end if;
    if v_role is not null and v_role not in ('oktato', 'kurzusfelelos', 'gyakvezeto') then
      raise exception 'ECHO_BAD_INPUT: ismeretlen szerep: "%". Érvényes: oktato, '
                      'kurzusfelelos, gyakvezeto.', v_role;
    end if;
    insert into echo.course_teacher (course_id, teacher_id, share_pct, role, ext_source)
    values (p_course, p_teacher, coalesce(p_share, 100), coalesce(v_role, 'oktato'), 'manual')
    on conflict (course_id, teacher_id) do update
      set share_pct = coalesce(excluded.share_pct, echo.course_teacher.share_pct),
          role      = coalesce(excluded.role,      echo.course_teacher.role);
  end if;

  perform echo.log_access('echo_teacher_course_set', null, p_course, p_teacher, 'teacher');
  return public.echo_teacher_get(p_teacher);
end $$;


-- ---------------------------------------------------------------------------
-- echo_campaign_create  ->  echo_admin : CREATE
-- ECHO kampány létrehozása
-- A törzs forrása: 42_campaign_editor.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_campaign_create(
  p_nev              text,
  p_term             text,
  p_template_version uuid        default null,
  p_opens_at         timestamptz default null,
  p_closes_at        timestamptz default null
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  v_nev    text := nullif(btrim(coalesce(p_nev, '')), '');
  v_term   text := nullif(btrim(coalesce(p_term, '')), '');
  v_tvst   text;
  v_tpl    text;
  v_code   text;
  v_base   text;
  v_n      int := 1;
  v_id     uuid;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('echo_admin', 'CREATE');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;

  if v_nev is null then
    raise exception 'ECHO_NAME_EMPTY: a kampany neve nem lehet ures.';
  end if;
  if length(v_nev) > 160 then
    raise exception 'ECHO_NAME_TOO_LONG: a kampany neve legfeljebb 160 karakter.';
  end if;
  if v_term is null then
    raise exception 'ECHO_TERM_EMPTY: a felev jelolese nem lehet ures (pl. 2025/26/2).';
  end if;
  -- Az ablak mar nem kotelezo (vazkampany), de ha van, ervenyesnek kell lennie.
  if p_opens_at is not null and p_closes_at <= p_opens_at then
    raise exception 'ECHO_WINDOW_INVALID: a zaras (%) nem lehet a nyitas (%) elott vagy azzal egyido.',
      p_closes_at, p_opens_at;
  end if;

  -- A sablonverzió: 'live' vagy 'approved'.
  -- MIÉRT ENGEDJÜK AZ 'approved'-ot IS: a kampány létrehozása előkészítő
  -- művelet, a jóváhagyott verzió élesítése önálló, naplózott lépés
  -- (echo_template_transition). A MEGNYITÁS viszont már 'live'-ot követel —
  -- lásd echo.campaign_precheck(): ECHO_TEMPLATE_NOT_LIVE.
  -- A kerdoiv OPCIONALIS: vazkampany is letrehozhato, es a sablonverzio
  -- utolag is megadhato (echo_campaign_update). Amit nem engedunk, az a
  -- rossz sablon: ha kaptunk egyet, annak most is ervenyesnek kell lennie.
  -- Elinditani ugyis csak kerdoivvel lehet — azt a campaign_precheck orzi.
  if p_template_version is not null then
    select tv.state, t.name_hu into v_tvst, v_tpl
      from echo.template_version tv
      join echo.template t on t.id = tv.template_id
     where tv.id = p_template_version;
    if v_tvst is null then raise exception 'ECHO_VERSION_NOT_FOUND'; end if;
    if v_tvst not in ('live','approved') then
      raise exception 'ECHO_TEMPLATE_NOT_READY: a valasztott sablonverzio allapota "%", '
                      'kampanyhoz csak "approved" vagy "live" verzio hasznalhato.', v_tvst;
    end if;
  end if;

  -- Fel ablak nincs: vagy mindketto, vagy egyik sem.
  if (p_opens_at is null) <> (p_closes_at is null) then
    raise exception 'ECHO_HALF_WINDOW: a nyitasi es a zarasi idopontot egyutt kell megadni, '
                    'vagy egyiket sem. Ablak nelkul a kampany vazkent jon letre.';
  end if;


  -- Kód: emberi olvasásra, egyedi. Az echo.slug() a magyar ékezeteket is kezeli.
  -- A kereses+beszuras nem atomi: ket egyidejű letrehozas ugyanazt a kodot
  -- talalhatna szabadnak, es a masodik az echo_campaign_code_uidx-en hasalna
  -- el. Eddig ezt a felev-index takarta el (a masodik kampany ugyis elbukott);
  -- most, hogy egy felevre tobb kampany lehet, ez a verseny valodiva valt.
  -- Tranzakcio vegeig tarto tanacsado zar: a kampanyletrehozas ritka, a
  -- sorositas ara elhanyagolhato.
  perform pg_advisory_xact_lock(hashtextextended('echo_campaign_create', 0));
  v_base := 'OMHV-' || echo.slug(v_term);
  v_code := v_base;
  while exists (select 1 from echo.campaign where code = v_code) loop
    v_n := v_n + 1;
    v_code := v_base || '-' || v_n::text;
  end loop;

  insert into echo.campaign (code, name_hu, term, template_version_id, opens_at, closes_at, state)
  values (v_code, v_nev, v_term, p_template_version, p_opens_at, p_closes_at, 'draft')
  returning id into v_id;

  insert into echo.campaign_log (campaign_id, from_state, to_state, irany, actor_key, actor_email, detail)
  values (v_id, null, 'draft', 'letrehozas', auth.uid(),
          (select email from public.profiles where id = auth.uid()),
          jsonb_build_object('code', v_code, 'term', v_term,
                             'template_version_id', p_template_version,
                             'template', v_tpl, 'template_state', v_tvst));

  perform echo.log_access('echo_campaign_create', v_id, null, null, 'campaign');

  return jsonb_build_object(
    'id', v_id, 'code', v_code, 'name', v_nev, 'term', v_term, 'state', 'draft',
    'opens_at', p_opens_at, 'closes_at', p_closes_at,
    'template_version_id', p_template_version, 'template_state', v_tvst,
    'kovetkezo_lepes', 'echo_rebuild_eligibility() a jogosultsagi listahoz, majd megnyitas.');
end $$;


-- ---------------------------------------------------------------------------
-- echo_campaign_update  ->  echo_admin : EDIT
-- ECHO kampány módosítása
-- A törzs forrása: 42_campaign_editor.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_campaign_update(
  p_campaign         uuid,
  p_nev              text        default null,
  p_name_en          text        default null,
  p_term             text        default null,
  p_template_version uuid        default null,
  p_opens_at         timestamptz default null,
  p_closes_at        timestamptz default null,
  p_goals_open_at    timestamptz default null,
  p_goals_close_at   timestamptz default null,
  p_clear            text[]      default null
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c        echo.campaign%rowtype;
  v_clear  text[] := coalesce(p_clear, '{}'::text[]);
  v_tvst   text;
  v_teljes boolean;
  v_op     timestamptz;
  v_cl     timestamptz;
  v_go     timestamptz;
  v_gc     timestamptz;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('echo_admin', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;

  select * into c from echo.campaign where id = p_campaign for update;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;

  if c.state in ('sealed','published') then
    raise exception 'ECHO_SEAL_IRREVERSIBLE: lepecsetelt kampany adatai nem modosithatok.';
  end if;
  v_teljes := (c.state = 'draft');

  if not v_teljes and (p_term is not null or p_template_version is not null
                       or p_opens_at is not null or p_closes_at is not null
                       or p_goals_open_at is not null or p_goals_close_at is not null
                       or v_clear && array['template','window','goals']) then
    raise exception 'ECHO_CAMPAIGN_RUNNING: a kampany allapota "%", ilyenkor csak a NEVE '
                    'modosithato. A kerdoiv, a felev vagy az ablak menet kozbeni atirasa a '
                    'mar beerkezett valaszokat ertelmezhetetlenne tenne.', c.state;
  end if;

  -- --- az új értékek kiszámítása (null = marad, p_clear = ürül) ---
  v_op := case when 'window' = any(v_clear) then null else coalesce(p_opens_at,  c.opens_at)  end;
  v_cl := case when 'window' = any(v_clear) then null else coalesce(p_closes_at, c.closes_at) end;
  v_go := case when 'goals'  = any(v_clear) then null else coalesce(p_goals_open_at,  c.goals_open_at)  end;
  v_gc := case when 'goals'  = any(v_clear) then null else coalesce(p_goals_close_at, c.goals_close_at) end;

  if (v_op is null) <> (v_cl is null) then
    raise exception 'ECHO_HALF_WINDOW: a nyitasi es a zarasi idopontot egyutt kell megadni, '
                    'vagy egyiket sem.';
  end if;
  if v_op is not null and v_cl <= v_op then
    raise exception 'ECHO_WINDOW_INVALID: a zaras (%) nem lehet a nyitas (%) elott vagy azzal egyido.',
                    v_cl, v_op;
  end if;
  if (v_go is null) <> (v_gc is null) then
    raise exception 'ECHO_HALF_WINDOW: a celmeghatarozasi ablak ket vegpontja is kell, vagy egyik sem.';
  end if;
  if v_go is not null and v_gc <= v_go then
    raise exception 'ECHO_WINDOW_INVALID: a celmeghatarozasi ablak zarasa nem lehet a nyitas elott.';
  end if;

  -- A kérdőív: ha kapunk verziót, annak most is érvényesnek kell lennie.
  -- Élesítettséget NEM követelünk — azt az indításnál kéri a precheck, hogy
  -- a szerkesztő ne akadjon el egy még jóváhagyás alatt lévő verzión.
  if p_template_version is not null then
    select tv.state into v_tvst from echo.template_version tv where tv.id = p_template_version;
    if v_tvst is null then raise exception 'ECHO_VERSION_NOT_FOUND'; end if;
    if v_tvst not in ('live','approved') then
      raise exception 'ECHO_TEMPLATE_NOT_READY: a valasztott sablonverzio allapota "%", '
                      'kampanyhoz csak "approved" vagy "live" verzio hasznalhato.', v_tvst;
    end if;
  end if;

  update echo.campaign
     set name_hu             = coalesce(nullif(btrim(coalesce(p_nev,'')),''), name_hu),
         name_en             = case when 'name_en' = any(v_clear) then null
                                    else coalesce(nullif(btrim(coalesce(p_name_en,'')),''), name_en) end,
         term                = coalesce(nullif(btrim(coalesce(p_term,'')),''), term),
         template_version_id = case when 'template' = any(v_clear) then null
                                    else coalesce(p_template_version, template_version_id) end,
         opens_at            = v_op,
         closes_at           = v_cl,
         goals_open_at       = v_go,
         goals_close_at      = v_gc
   where id = p_campaign;

  insert into echo.campaign_log (campaign_id, from_state, to_state, irany, actor_key, actor_email, detail)
  values (p_campaign, c.state, c.state, 'szerkesztes', auth.uid(),
          (select email from public.profiles where id = auth.uid()),
          jsonb_build_object('clear', to_jsonb(v_clear),
                             'nev', p_nev, 'term', p_term,
                             'template_version_id', p_template_version,
                             'opens_at', p_opens_at, 'closes_at', p_closes_at));

  perform echo.log_access('echo_campaign_update', p_campaign, null, null, 'campaign');

  select * into c from echo.campaign where id = p_campaign;
  return jsonb_build_object(
    'id', c.id, 'code', c.code, 'name', c.name_hu, 'name_en', c.name_en,
    'term', c.term, 'state', c.state,
    'template_version_id', c.template_version_id,
    'opens_at', c.opens_at, 'closes_at', c.closes_at,
    'goals_open_at', c.goals_open_at, 'goals_close_at', c.goals_close_at,
    'indithato', (echo.campaign_precheck(p_campaign, 'open')->>'ok')::boolean,
    'indulas_akadalya', echo.campaign_precheck(p_campaign, 'open')->>'uzenet',
    'ok', true);
end $$;


-- ---------------------------------------------------------------------------
-- echo_campaign_transition  ->  echo_admin : USE
-- ECHO kampány állapotváltása
-- A törzs forrása: 18a_echo_campaign.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_campaign_transition(
  p_campaign uuid,
  p_to       text,
  p_force    boolean default false
) returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c          echo.campaign%rowtype;
  v_pre      jsonb;
  v_forced   boolean := false;
  v_irany    text;
  v_detail   jsonb := '{}'::jsonb;
  v_marked   int;
  v_courses  int;
  v_fill     int;
  v_mix      int;
  v_shuf     int;
  v_nonpend  int;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('echo_admin', 'USE');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;

  -- Sorzár: két párhuzamos admin ne vihesse ugyanazt a kampányt kétfelé.
  select * into c from echo.campaign where id = p_campaign for update;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;

  v_pre := echo.campaign_precheck(p_campaign, p_to);
  if not (v_pre->>'ok')::boolean then
    if coalesce(p_force, false) and (v_pre->>'forcolhato')::boolean then
      v_forced := true;   -- a felteteltol eltekintunk, de NAPLOZZUK
    else
      raise exception '%: %', v_pre->>'kod', v_pre->>'uzenet';
    end if;
  end if;

  v_irany := case when echo.campaign_state_rank(p_to) < echo.campaign_state_rank(c.state)
                  then 'vissza' else 'elore' end;

  -- --- mellékhatások ---
  if p_to = 'processing' then
    -- 1) A részvételi napló lezárása: mely kurzusokon költötték el az összes
    --    kiadott jegyet. (Az echo.mark_submitted() kurzusonként egy sort ad.)
    select coalesce(sum(m.marked), 0), count(*) into v_marked, v_courses
      from echo.mark_submitted(p_campaign) m;

    -- 2) A moderálási sor feltöltése. Ugyanezt teszi az echo_moderation_queue()
    --    is minden hívásnál (on conflict do nothing), tehát ez idempotens —
    --    itt csak azért fut, hogy a moderátor NE üres sorral találkozzon.
    v_fill := echo.moderation_fill(p_campaign);

    -- 3) Keverés — CSAK akkor, ha még EGYETLEN döntés sem született.
    --    MIÉRT A FELTÉTEL: az echo.shuffle_moderation() DELETE + INSERT-tel
    --    dolgozik, és az echo.moderation_audit() trigger a nem-'pending'
    --    sorok ÚJRABESZÚRÁSÁT valódi döntésnek látná — hamis előzménysorokat
    --    írna az echo.moderation_history-ba. Friss feltöltésnél ez nem áll fenn.
    select count(*) into v_nonpend
      from echo.moderation m join echo.response r on r.id = m.response_id
     where r.campaign_id = p_campaign and m.allapot <> 'pending';
    if v_nonpend = 0 then
      v_mix := echo.shuffle_moderation(p_campaign);
    else
      v_mix := null;
    end if;

    v_detail := jsonb_build_object(
      'bekuldottnek_jelolt', v_marked, 'erintett_kurzus', v_courses,
      'moderalasi_sor_uj', v_fill, 'moderalasi_sor_kevert', v_mix,
      'mar_moderalt', v_nonpend);
  end if;

  if p_to = 'sealed' then
    -- A PECSÉT. A fizikai sorrend (ctid) mint rejtett csatorna itt bomlik el.
    v_shuf := echo.shuffle_responses(p_campaign);
    v_detail := jsonb_build_object('megkevert_valasz', v_shuf);
  end if;

  -- --- maga a váltás ---
  update echo.campaign
     set state        = p_to,
         sealed_at    = case when p_to = 'sealed'    then coalesce(sealed_at, now())    else sealed_at end,
         published_at = case when p_to = 'published' then coalesce(published_at, now()) else published_at end
   where id = p_campaign;

  insert into echo.campaign_log (campaign_id, from_state, to_state, irany, forced,
                                 actor_key, actor_email, detail)
  values (p_campaign, c.state, p_to, v_irany, v_forced, auth.uid(),
          (select email from public.profiles where id = auth.uid()),
          v_detail || jsonb_build_object('elofeltetel', v_pre));

  perform echo.log_access('echo_campaign_transition', p_campaign, null, null, p_to);

  return jsonb_build_object(
    'id', p_campaign, 'code', c.code, 'from', c.state, 'to', p_to,
    'irany', v_irany, 'forced', v_forced,
    'visszafordithatatlan', (p_to = 'sealed'),
    'detail', v_detail,
    'kovetkezo', echo.campaign_next(p_campaign),
    'ok', true);
end $$;


-- ---------------------------------------------------------------------------
-- echo_campaign_audience_set  ->  echo_admin : EDIT
-- ECHO kampány célközönségének beállítása
-- A törzs forrása: 45_audience_preview.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_campaign_audience_set(p_campaign uuid, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  c      echo.campaign%rowtype;
  v_it   jsonb;
  v_kind text;
  v_id   text;
  v_n    int := 0;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('echo_admin', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;

  select * into c from echo.campaign where id = p_campaign for update;
  if not found then raise exception 'ECHO_CAMPAIGN_NOT_FOUND'; end if;
  if c.state <> 'draft' then
    raise exception 'ECHO_CAMPAIGN_RUNNING: a celkozonseg csak "draft" allapotban '
                    'modosithato (a kampany most "%"). Futo kampanyon a mar kiadott '
                    'jegyek valnanak ervenytelenne.', c.state;
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'ECHO_BAD_INPUT: a p_items tomb kell legyen.';
  end if;

  delete from echo.campaign_audience where campaign_id = p_campaign;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_kind := v_it->>'kind';
    v_id   := v_it->>'id';
    if coalesce(v_id, '') = '' then
      raise exception 'ECHO_BAD_INPUT: hianyzo azonosito a "%s" tetelnel.', v_kind;
    end if;

    if v_kind = 'course' then
      if not exists (select 1 from echo.course where id = v_id::uuid) then
        raise exception 'ECHO_COURSE_NOT_FOUND: %', v_id;
      end if;
      insert into echo.campaign_audience (campaign_id, kind, course_id, added_by)
      values (p_campaign, 'course', v_id::uuid, auth.uid())
      on conflict do nothing;

    elsif v_kind = 'group' then
      if not exists (select 1 from public.user_group where id = v_id) then
        raise exception 'ECHO_GROUP_NOT_FOUND: %', v_id;
      end if;
      insert into echo.campaign_audience (campaign_id, kind, group_id, added_by)
      values (p_campaign, 'group', v_id, auth.uid())
      on conflict do nothing;

    elsif v_kind = 'user' then
      if not exists (select 1 from public.profiles where id = v_id::uuid) then
        raise exception 'ECHO_PROFILE_NOT_FOUND: %', v_id;
      end if;
      insert into echo.campaign_audience (campaign_id, kind, profile_id, added_by)
      values (p_campaign, 'user', v_id::uuid, auth.uid())
      on conflict do nothing;

    else
      raise exception 'ECHO_BAD_INPUT: ismeretlen celkozonseg-tipus: "%". '
                      'Ervenyes: course, group, user.', coalesce(v_kind, '(null)');
    end if;
    v_n := v_n + 1;
  end loop;

  insert into echo.campaign_log (campaign_id, from_state, to_state, irany, actor_key, actor_email, detail)
  values (p_campaign, c.state, c.state, 'celkozonseg', auth.uid(),
          (select email from public.profiles where id = auth.uid()),
          jsonb_build_object('tetel', v_n, 'items', coalesce(p_items, '[]'::jsonb)));

  perform echo.log_access('echo_campaign_audience_set', p_campaign, null, null, 'campaign');

  -- AZONNAL ujraepitjuk az alkalmassagot. Enelkul a kampany "Jogosult par" es
  -- "Jogosult hallgato" szamai a MENTES UTAN IS a regi celkozonseget mutatjak,
  -- mert azok az echo.eligibility / echo.participation tablakbol jonnek, azokat
  -- pedig kizarolag az eligibility_rebuild() irja. A felhasznalo joggal hiszi,
  -- hogy nem tortent semmi.
  -- Biztonsagos: ez a fuggveny csak 'draft' allapotban fut le (lasd fent),
  -- tehat nincs meg kiadott jegy, amit ervenytelenithetne.
  perform echo.eligibility_rebuild(p_campaign);

  return public.echo_campaign_audience(p_campaign);
end $$;


-- ---------------------------------------------------------------------------
-- echo_question_bank_save  ->  echo_admin : EDIT
-- ECHO kérdésbank mentése
-- A törzs forrása: 36_echo_question_bank.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_question_bank_save(
  p_id       uuid    default null,
  p_code     text    default null,
  p_type     text    default null,
  p_hu       text    default null,
  p_en       text    default null,
  p_options  jsonb   default null,
  p_min      integer default null,
  p_max      integer default null,
  p_required boolean default false,
  p_tags     text[]  default '{}',
  p_notes    text    default null)
returns echo.question_bank
language plpgsql security definer set search_path = public, echo
as $$
declare v_row echo.question_bank;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('echo_admin', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then
    raise exception 'ECHO_FORBIDDEN: a kerdesbankot csak admin szerkesztheti.';
  end if;

  if p_id is null then
    insert into echo.question_bank(
      code, type, hu, en, options, min_value, max_value, required, tags, notes, created_by)
    values (p_code, p_type, p_hu, p_en, p_options, p_min, p_max,
            coalesce(p_required,false), coalesce(p_tags,'{}'), p_notes, auth.uid())
    returning * into v_row;
  else
    -- A KIADOTT (active) tétel kódját nem engedjük átírni: arra már
    -- hivatkozhatnak sablonok, és a hivatkozás a kód mentén él.
    if exists (select 1 from echo.question_bank
                where id = p_id and state = 'active'
                  and p_code is not null and p_code <> code) then
      raise exception
        'ECHO_CODE_LOCKED: aktiv kerdes kodja nem irhato at, mert sablonok '
        'hivatkozhatnak ra. Vondd vissza (retired), es hozz letre ujat.';
    end if;

    update echo.question_bank
       set code      = coalesce(p_code, code),
           type      = coalesce(p_type, type),
           hu        = coalesce(p_hu, hu),
           en        = coalesce(p_en, en),
           options   = coalesce(p_options, options),
           min_value = coalesce(p_min, min_value),
           max_value = coalesce(p_max, max_value),
           required  = coalesce(p_required, required),
           tags      = coalesce(p_tags, tags),
           notes     = coalesce(p_notes, notes)
     where id = p_id
    returning * into v_row;

    if v_row.id is null then raise exception 'ECHO_NOT_FOUND'; end if;
  end if;

  return v_row;
end $$;


-- ---------------------------------------------------------------------------
-- echo_template_save  ->  echo_admin : EDIT
-- ECHO kérdőív-sablon mentése
-- A törzs forrása: 16_echo_reports.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_template_save(p_version uuid, p_compiled jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare v_state text;
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('echo_admin', 'EDIT');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then raise exception 'ECHO_FORBIDDEN'; end if;

  select state into v_state from echo.template_version where id = p_version;
  if v_state is null then raise exception 'ECHO_VERSION_NOT_FOUND'; end if;
  if v_state <> 'draft' then
    raise exception 'ECHO_NOT_DRAFT: a verzio allapota "%", menteni csak draft allapotban lehet. '
                    'Keszits uj verziot (echo_template_create).', v_state;
  end if;
  if p_compiled is null or jsonb_typeof(p_compiled) <> 'object' then
    raise exception 'ECHO_BAD_COMPILED: a compiled JSON objektum kell legyen.';
  end if;

  update echo.template_version set compiled = p_compiled where id = p_version;

  return jsonb_build_object('id', p_version, 'state', 'draft',
                            'ellenorzes', echo.template_validate(p_compiled));
end $$;


-- ---------------------------------------------------------------------------
-- echo_export_log  ->  reports : USE
-- Eredmény-export naplózása (adat visz ki)
-- A törzs forrása: 34_echo_export.sql (betűre onnan, a 9 soros kapun kívül).
-- ---------------------------------------------------------------------------
create or replace function public.echo_export_log(p_campaign uuid default null)
returns setof echo.export_log
language plpgsql
security definer
set search_path = public, echo
as $$
begin

  -- [rbacx] modul-akció kapu (72_rbac_actions.sql). A törzs többi
  -- sora BETŰRE az eredeti migrációból való — lásd a fájl fejlécét.
  -- Az is_trusted_caller() ág azért kell, hogy a JWT nélküli
  -- szerveroldali hívó (make-superadmin.sh, reset-data.sql, migráció)
  -- ne akadjon el rajta.
  if not public.is_trusted_caller() then
    perform public.rbac_require('reports', 'USE');
  end if;
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_admin() then
    raise exception 'ECHO_FORBIDDEN: az export-naplot csak admin olvashatja.';
  end if;
  return query
    select * from echo.export_log
     where p_campaign is null or campaign_id = p_campaign
     order by at desc
     limit 500;
end $$;


-- ============================================================================
-- 3. SZAKASZ — ELLENŐRZÉS
-- ============================================================================
-- Ugyanaz a linter, ami a deploy/migrate/verify.sql-be is bekerül: ott van-e a
-- kapu a törzsben, minden nyilvántartott RPC-n. Ez az, ami egy jövőbeli
-- `create or replace`-t is elkap — az ellenőrzőösszeg nem, mert a 74-es
-- fájlja változatlan marad.
select g.proc_name || ' -> ' || g.module_kod || ':' || g.action as "mit ellenőrzünk",
       case
         when p.oid is null then '!! NINCS ILYEN FÜGGVÉNY'
         when position('rbac_require(''' || g.module_kod || ''', ''' || g.action || '''' in p.prosrc) > 0
           then 'OK'
         else '!! A KAPU HIÁNYZIK a törzsből'
       end                                                       as "állapot"
  from public.rbac_rpc_guard g
  left join pg_proc p on p.proname = g.proc_name
                     and p.pronamespace = 'public'::regnamespace
 where g.aktiv
 order by 2 desc, 1;

do $rpc_kesz$
declare n int; ossz int;
begin
  select count(*) into ossz from public.rbac_rpc_guard where aktiv;
  select count(*) into n
    from public.rbac_rpc_guard g
    left join pg_proc p on p.proname = g.proc_name
                       and p.pronamespace = 'public'::regnamespace
   where g.aktiv
     and (p.oid is null
          or position('rbac_require(''' || g.module_kod || ''', ''' || g.action || '''' in p.prosrc) = 0);
  if n > 0 then
    raise exception 'MEGTAGADVA: % nyilvantartott RPC-n nincs ott a modul-akcio kapu.', n;
  end if;
  raise notice 'Rendben: mind a % RPC-n ott van a modul-akcio kapu.', ossz;
end $rpc_kesz$;
