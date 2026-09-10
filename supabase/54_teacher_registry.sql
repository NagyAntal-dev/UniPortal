-- ============================================================================
-- 54_teacher_registry.sql — Oktatói nyilvántartás
--
-- MIÉRT KELL
--   Az echo.teacher tábla és a hozzá tartozó echo.course_teacher kötés eddig
--   CSAK gépi úton (seed, külső import) töltődött. Nem volt RPC, amivel egy
--   ügyintéző új oktatót vehetne fel, javíthatná az adatait, vagy jelölhetné,
--   hogy valaki már nem tanít. A kurzusnyilvántartás (43) mintáját követjük.
--
-- A LEGFONTOSABB DÖNTÉS: INAKTIVÁLÁS, NEM TÖRLÉS
--   Az echo.teacher idegen kulcsai KASZKÁDOLNAK — MÉRVE:
--       echo.course_teacher.teacher_id     -> CASCADE
--       echo.eligibility.teacher_id        -> CASCADE
--       echo.exclusion_log.teacher_id      -> CASCADE
--       echo.protocol_handover.teacher_id  -> CASCADE
--       echo.teacher_comment.teacher_id    -> CASCADE
--       echo.response.teacher_id           -> RESTRICT
--   Vagyis egy törlés CSENDBEN megsemmisítené a kampánytörténetet: a
--   jogosultsági sorokat, a kizárási naplót (amire a 3. § szerint hivatkozni
--   kell tudni), a jegyzőkönyv-átadásokat és az oktatói észrevételeket. Csak a
--   válasz van védve, az viszont a legkésőbbi pillanatban szólna.
--   Ezért az echo_teacher_delete ELŐRE elutasít minden olyan törlést, ahol
--   bármelyik nyom létezik — a helyes lépés ilyenkor az inaktiválás.
--
-- AMIT AZ INAKTIVÁLÁS MA JELENT — ÉS AMIT NEM
--   Az echo.eligibility_rebuild() a course_teacher-ből dolgozik, és NEM nézi a
--   teacher.active jelzőt (MÉRVE: 15_echo_core.sql és 42_campaign_editor.sql
--   insert-je egyaránt csak a share_pct küszöböt szűri). Az inaktiválás tehát
--   NYILVÁNTARTÁSI állapot: kiveszi az oktatót a választókból és a listák
--   alapértelmezett szűréséből, de amíg kurzus-hozzárendelése van, egy új
--   kampány továbbra is behúzná. Ezt a felület KIMONDJA, és az RPC vissza is
--   adja a megmaradt hozzárendelések számát, hogy ne csendben történjen.
--
-- FÜGGŐSÉG: 15_echo_core.sql, 19_echo_roles.sql, 43_course_registry.sql
-- IDEMPOTENS: minden create or replace; a revoke/grant újrafuttatható.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Olvasó RPC-k
-- ------------------------------------------------------------

-- Oktatói lista. p_active: 'aktiv' (alapértelmezés) | 'inaktiv' | 'mind'.
create or replace function public.echo_teacher_list(
  p_q      text default null,
  p_active text default null,
  p_org    uuid default null,
  p_limit  int  default 200
) returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  v_q    text := nullif(btrim(coalesce(p_q, '')), '');
  v_akt  text := lower(coalesce(nullif(btrim(coalesce(p_active,'')),''), 'aktiv'));
  v_lim  int  := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_out  jsonb;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;
  if v_akt not in ('aktiv', 'inaktiv', 'mind') then
    raise exception 'ECHO_BAD_INPUT: az állapotszűrő csak "aktiv", "inaktiv" vagy "mind" lehet.';
  end if;

  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'id',        t.id,
             'code',      t.code,
             'name',      t.name,
             'title',     t.title,
             'email',     t.email,
             'active',    t.active,
             'org_unit',  o.name_hu,
             'org_kind',  o.kind,
             'kurzus',    (select count(*) from echo.course_teacher ct where ct.teacher_id = t.id),
             'kotott',    (t.profile_id is not null),
             'fiok',      p.email,
             'grantok',   (select count(*) from echo.role_grant g
                            where g.person = t.profile_id
                              and (g.expires_at is null or g.expires_at > now()))
           ) as x, t.name
      from echo.teacher t
      left join echo.org_unit o on o.id = t.org_unit_id
      left join public.profiles p on p.id = t.profile_id
     where (v_akt = 'mind' or (v_akt = 'aktiv' and t.active) or (v_akt = 'inaktiv' and not t.active))
       and (p_org is null or t.org_unit_id = p_org)
       and (v_q is null
            or t.name  ilike '%'||v_q||'%'
            or t.code  ilike '%'||v_q||'%'
            or coalesce(t.email,'') ilike '%'||v_q||'%')
     order by t.name
     limit v_lim
  ) s;

  return v_out;
end $$;


-- Egy oktató teljes lapja: adatok, kurzusai, fiókja, ECHO-jogosultságai és a
-- kampánybeli érintettsége. Az utóbbi kettő azért kell, mert az inaktiválás és
-- a törlés következményét EBBŐL lehet megítélni.
create or replace function public.echo_teacher_get(p_teacher uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare t echo.teacher%rowtype; v_out jsonb;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;

  select * into t from echo.teacher where id = p_teacher;
  if t.id is null then raise exception 'ECHO_TEACHER_NOT_FOUND'; end if;

  select jsonb_build_object(
    'id', t.id, 'code', t.code, 'name', t.name, 'title', t.title,
    'email', t.email, 'active', t.active,
    'org_unit_id', t.org_unit_id,
    'org_unit', (select o.name_hu from echo.org_unit o where o.id = t.org_unit_id),
    'ext_source', t.ext_source,
    'created_at', t.created_at,

    -- a kötött fiók
    'profile_id', t.profile_id,
    'fiok', (select jsonb_build_object('id', p.id, 'email', p.email, 'name', p.name, 'role', p.role)
               from public.profiles p where p.id = t.profile_id),

    -- ECHO-jogosultságok (élő és lejárt egyaránt, a lejárat dátumával)
    'grantok', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', g.id, 'role', g.role, 'expires_at', g.expires_at,
                          'aktiv', (g.expires_at is null or g.expires_at > now()),
                          'scope_org', (select o.name_hu from echo.org_unit o where o.id = g.scope_org),
                          'iktatoszam', g.iktatoszam) order by g.role), '[]'::jsonb)
                  from echo.role_grant g where g.person = t.profile_id),

    -- kurzusai, félév szerint csökkenő sorrendben
    'kurzusok', (select coalesce(jsonb_agg(jsonb_build_object(
                          'course_id', c.id, 'code', c.code, 'name', c.name_hu,
                          'term', c.term, 'lang', c.lang,
                          'share_pct', ct.share_pct, 'role', ct.role,
                          'letszam', c.letszam)
                        order by c.term desc, c.code), '[]'::jsonb)
                   from echo.course_teacher ct
                   join echo.course c on c.id = ct.course_id
                  where ct.teacher_id = t.id),

    -- kampánybeli érintettség: EZ dönti el, törölhető-e egyáltalán
    'nyomok', jsonb_build_object(
        'kurzus',      (select count(*) from echo.course_teacher    x where x.teacher_id = t.id),
        'jogosultsag', (select count(*) from echo.eligibility       x where x.teacher_id = t.id),
        'valasz',      (select count(*) from echo.response          x where x.teacher_id = t.id),
        'kizaras',     (select count(*) from echo.exclusion_log     x where x.teacher_id = t.id),
        'jegyzokonyv', (select count(*) from echo.protocol_handover x where x.teacher_id = t.id),
        'eszrevetel',  (select count(*) from echo.teacher_comment   x where x.teacher_id = t.id))
  ) into v_out;

  perform echo.log_access('echo_teacher_get', null, null, t.id, 'teacher');
  return v_out;
end $$;


-- Választólisták a felület pickereihez.
--   'org_unit' — szervezeti egységek
--   'profile'  — még EGYETLEN oktatóhoz sem kötött fiókok
--   'course'   — kurzusok, amiket az adott oktató MÉG NEM visz
create or replace function public.echo_teacher_options(
  p_kind text, p_teacher uuid default null, p_q text default null, p_limit int default 50
) returns jsonb
language plpgsql stable security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  v_q   text := nullif(btrim(coalesce(p_q, '')), '');
  v_lim int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_out jsonb;
begin
  if auth.uid() is null then raise exception 'ECHO_NOT_AUTHENTICATED'; end if;
  if not public.is_staff() then raise exception 'ECHO_FORBIDDEN'; end if;

  if p_kind = 'org_unit' then
    select coalesce(jsonb_agg(x order by x->>'cimke'), '[]'::jsonb) into v_out
    from (select jsonb_build_object('id', o.id, 'cimke', o.name_hu, 'reszlet', o.kind) as x
            from echo.org_unit o
           where v_q is null or o.name_hu ilike '%'||v_q||'%' or o.code ilike '%'||v_q||'%'
           order by o.name_hu limit v_lim) s;

  elsif p_kind = 'profile' then
    select coalesce(jsonb_agg(x order by x->>'cimke'), '[]'::jsonb) into v_out
    from (select jsonb_build_object('id', p.id, 'cimke', coalesce(p.name, p.email),
                                    'reszlet', p.email) as x
            from public.profiles p
           where not exists (select 1 from echo.teacher t
                              where t.profile_id = p.id
                                and (p_teacher is null or t.id <> p_teacher))
             and (v_q is null or coalesce(p.name,'') ilike '%'||v_q||'%'
                              or p.email ilike '%'||v_q||'%')
           order by coalesce(p.name, p.email) limit v_lim) s;

  elsif p_kind = 'course' then
    select coalesce(jsonb_agg(x order by x->>'cimke'), '[]'::jsonb) into v_out
    from (select jsonb_build_object('id', c.id, 'cimke', c.code||' · '||c.name_hu,
                                    'reszlet', c.term) as x
            from echo.course c
           where (p_teacher is null or not exists (
                    select 1 from echo.course_teacher ct
                     where ct.course_id = c.id and ct.teacher_id = p_teacher))
             and (v_q is null or c.code ilike '%'||v_q||'%' or c.name_hu ilike '%'||v_q||'%')
           order by c.term desc, c.code limit v_lim) s;

  else
    raise exception 'ECHO_BAD_INPUT: ismeretlen típus: "%". Érvényes: org_unit, profile, course.',
                    coalesce(p_kind, '(null)');
  end if;

  return v_out;
end $$;


-- ------------------------------------------------------------
-- 2. Író RPC-k
-- ------------------------------------------------------------

-- Oktató létrehozása és módosítása. p_id nélkül új jön létre.
-- A p_clear tömb a KIÜRÍTHETŐ mezőket nevezi meg: e nélkül a NULL argumentum
-- „ne változtass" jelentésű, tehát egy megadott értéket nem lehetne törölni.
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


-- Aktiválás / inaktiválás. NEM töröl semmit, és NEM bontja a kurzus-
-- hozzárendeléseket — a visszatérő 'figyelmeztetes' mező mondja meg, hány
-- hozzárendelés maradt, mert amíg van, egy új kampány behúzná az oktatót.
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


-- Kurzus hozzárendelése az OKTATÓ felől. A 43-as echo_course_teacher_set a
-- kurzus felől ugyanezt teszi; itt csak a paraméterek sorrendje fordul meg,
-- hogy a felület ne kényszerüljön kurzust választani ahhoz, hogy egy oktatót
-- kurzushoz kössön.
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


-- Oktató törlése. A FÉK: az echo.teacher idegen kulcsai kaszkádolnak (lásd a
-- fájl fejlécét), ezért egy törlés kampánytörténetet semmisítene meg. Előre
-- elutasítjuk, ha BÁRMILYEN nyom van — a helyes lépés ilyenkor az inaktiválás.
create or replace function public.echo_teacher_delete(p_teacher uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = echo, public, extensions, pg_temp
as $$
declare
  t      echo.teacher%rowtype;
  v_jog  int; v_val int; v_kiz int; v_jkv int; v_esz int; v_krz int;
begin
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


-- ------------------------------------------------------------
-- 3. Jogosultságok
-- ------------------------------------------------------------
-- FIGYELEM: a Supabase alapértelmezett jogosztása MINDEN új public függvényre
-- ad EXECUTE-ot az 'anon' szerepnek, és a "revoke ... from public" ezt NEM
-- veszi el — nevesítve kell visszavonni. (Ez a hiba egyszer már átcsúszott
-- négy RPC-n; azóta minden migráció végén itt a nevesített revoke.)
do $$
declare f text;
begin
  foreach f in array array[
    'public.echo_teacher_list(text,text,uuid,int)',
    'public.echo_teacher_get(uuid)',
    'public.echo_teacher_options(text,uuid,text,int)',
    'public.echo_teacher_save(uuid,text,text,text,text,uuid,text[])',
    'public.echo_teacher_set_active(uuid,boolean,text)',
    'public.echo_teacher_course_set(uuid,uuid,numeric,text,boolean)',
    'public.echo_teacher_delete(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Ellenőrzés: egyetlen új RPC sem maradhat az 'anon' kezében.
do $$
declare v_n int;
begin
  select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'echo_teacher%'
     and has_function_privilege('anon', p.oid, 'execute');
  if v_n > 0 then
    raise exception 'BIZTONSAGI HIBA: % oktatói RPC-t az anon is hívhat.', v_n;
  end if;
  raise notice 'Oktatói nyilvántartás: 7 RPC telepítve, anon-hozzáférés nélkül.';
end $$;
