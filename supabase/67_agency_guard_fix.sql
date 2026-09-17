-- ============================================================
-- UniPortal Pro — Jogosultsági kapuk zárása: a "nincs JWT = megbízható"
-- feltevés megszüntetése (29-es migráció)
--
-- MIÉRT:
--   A 29-es migráció minden ügynökségi kapuja így épült fel:
--
--       if not public.is_admin() and auth.uid() is not null then
--         raise exception '…' using errcode = 'insufficient_privilege';
--       end if;
--
--   A szándék jó volt: a szerveroldali hívó (SQL-szerkesztő, migráció,
--   service_role kulcs) ne akadjon el a kapun, mert ott nincs végfelhasználói
--   JWT, tehát az auth.uid() NULL.
--
--   A baj: a PostgREST `anon` szerepköre is JWT nélküli végfelhasználó.
--   Egy hitelesítetlen kérésnek sincs `sub` claimje, tehát az auth.uid() ott
--   is NULL — és ezzel a kapu NEM ZÁR, hanem NYIT. A függvények
--   SECURITY DEFINER-ek, a tábla tulajdonosaként futnak, és megkerülik az
--   RLS-t (a public sémában nincs FORCE ROW LEVEL SECURITY), tehát a hívó
--   ügynökséget hagyhat jóvá és jutalékkulcsot állíthat, bárkit beiratkozottá
--   tehet, elszámolási időszakot nyithat-zárhat, jutalékszámlát állíthat ki és
--   hagyhat jóvá kifizetésre.
--
--   Ez csak akkor kihasználható, ha az `anon` szerepkörnek van EXECUTE joga
--   ezekre a függvényekre. A 29-es migráció — egyedüliként a későbbiek közül —
--   NEM tartalmaz egyetlen `revoke`-ot sem, a Supabase alapértelmezett
--   jogosultsága pedig minden új public függvényre megadja az EXECUTE-ot az
--   anonnak (mérve és leírva: 21_echo_harden_submit.sql, 12-20. sor).
--   A 99_harden_grants.sql ezt az oldalt zárja; ez a migráció magát a kaput
--   javítja, hogy a jogosultság-visszavonás egy esetleges visszaesése se
--   nyissa ki újra.
--
-- MIT CSINÁL:
--   1. Bevezeti a public.is_trusted_caller() függvényt: igaz, ha a hívás NEM
--      a REST API-n át jött (SQL-szerkesztő, migráció, psql), vagy ha
--      service_role kulccsal jött. A "nincs auth.uid()" többé nem jelent
--      bizalmat.
--   2. Újradefiniálja a 29-es migráció nyolc kapuját erre a függvényre.
--      A törzsek egyébként BETŰRE azonosak a 29-essel — csak a kapu sora
--      változott.
--   3. Ugyanezt a mintát viszi végig a 11/25/30-as migrációk integritás-
--      triggerein is. Ezek MA nem érhetők el anonként (a tábláik policy-i
--      `to authenticated` + is_approved()), tehát ez mélységi védelem.
--
--   AMIT SZÁNDÉKOSAN NEM BÁNTUNK: a profiles_protect_privileges triggert
--   (07_registration_approval.sql:125). Az agency_decide tranzakció-lokálisan
--   KIÜRÍTI a JWT-claimeket (29:607-608) — pontosan azért, hogy ezen a
--   triggeren át írhassa az ügynöki profilok jóváhagyási mezőit. Ha ott is
--   is_trusted_caller()-re cserélnénk, a REST-en át hívott agency_decide-nál a
--   request.method még be van állítva, tehát a hívó nem minősülne megbízhatónak,
--   és a trigger NÉMÁN visszaírná a jóváhagyást. Kockázat nincs: a profiles
--   UPDATE policy `to authenticated`, tehát az anon el sem jut a triggerig.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt),
--   vagy: Supabase dashboard → SQL Editor → New query → beilleszt → Run
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. a megbízható hívó fogalma ----------
-- SECURITY DEFINER-en belül a current_user MINDIG a tulajdonos (postgres),
-- a session_user pedig a PostgREST-nél mindig 'authenticator' — egyik sem
-- alkalmas a megkülönböztetésre. A PostgREST viszont minden kéréshez beállítja
-- a request.method GUC-ot és a request.jwt.claims-et, közvetlen adatbázis-
-- kapcsolatnál pedig egyik sincs. Erre építünk.
--
-- A '{}' claim NEM REST-kérés jele: az agency_decide maga állítja be
-- tranzakció-lokálisan (lásd ott), és a valódi REST-kérés claimjében mindig
-- van 'role'. Ezért a 'role' MEGLÉTÉT nézzük, nem a claim puszta létezését.
create or replace function public.is_trusted_caller()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $itc$
declare
  v_method text;
  v_claims text;
  v_role   text;
begin
  v_method := nullif(current_setting('request.method',     true), '');
  v_claims := nullif(current_setting('request.jwt.claims', true), '');

  begin
    v_role := case when v_claims is null then null else (v_claims::jsonb ->> 'role') end;
  exception when others then
    -- Értelmezhetetlen claim: NEM adunk bizalmat.
    return false;
  end;

  -- (a) service_role kulccsal érkezett REST-hívás: szerveroldali, megbízható.
  if v_role = 'service_role' then
    return true;
  end if;

  -- (b) Nem REST-hívás: nincs request.method ÉS nincs szerepkör a claimben.
  return v_method is null and v_role is null;
end
$itc$;

comment on function public.is_trusted_caller() is
  'Igaz, ha a hívás közvetlen adatbázis-kapcsolatból (SQL-szerkesztő, migráció, psql) vagy service_role kulccsal jött. NEM azonos azzal, hogy "nincs auth.uid()" — az anon szerepkörnek sincs.';

revoke all on function public.is_trusted_caller() from public, anon;
grant execute on function public.is_trusted_caller() to authenticated;

-- ---------- 2. a 29-es migráció nyolc kapuja ----------

-- ---- students_enrollment_guard ----
create or replace function public.students_enrollment_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and new."enrolled_at" is distinct from old."enrolled_at"
     and not public.is_staff()
     and not public.is_trusted_caller() then
    -- Nem hibát dobunk, hanem visszaírjuk: ugyanaz a minta, mint a
    -- 11-es migráció students_protect_identity triggerénél.
    new."enrolled_at" := old."enrolled_at";
    return new;
  end if;

  if new."enrolled_at" is not null and coalesce(new."status", '') <> 'Accepted' then
    raise exception
      'A beiratkozás csak "Accepted" (Felvéve) fő státusz mellett rögzíthető (a jelenlegi: "%").',
      coalesce(new."status", '(nincs)')
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- ---- agency_decide ----
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

-- ---- student_set_enrolled ----
create or replace function public.student_set_enrolled(
  p_student text,
  p_on      date default current_date
) returns public."students"
language plpgsql security definer set search_path = public as $$
declare st public."students";
begin
  if not (public.is_staff() or public.is_trusted_caller()) then
    raise exception 'A beiratkozást csak ügyintéző rögzítheti.' using errcode = 'insufficient_privilege';
  end if;
  update public."students" set "enrolled_at" = p_on where id = p_student returning * into st;
  if st.id is null then
    raise exception 'Nincs ilyen jelentkező: %', p_student using errcode = 'no_data_found';
  end if;
  perform public.log_status_event('student.enrolled', 'students/' || st.id,
    coalesce(st.name, st.id) || ' beiratkozott: ' || coalesce(p_on::text, '(törölve)'));
  return st;
end
$$;

-- ---- agency_period_set_state ----
create or replace function public.agency_period_set_state(
  p_period text,
  p_state  text
) returns public.agency_commission_period
language plpgsql security definer set search_path = public as $$
declare pr public.agency_commission_period;
begin
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

-- ---- agency_commission_preview ----
create or replace function public.agency_commission_preview(
  p_period text,
  p_agency text default null
) returns table (
  agency_id    text,
  agency_name  text,
  student_id   text,
  student_name text,
  program      text,
  tuition_fee  numeric,
  rate         numeric,
  amount       numeric,
  enrolled_on  date,
  already_invoiced boolean
)
language sql stable security definer set search_path = public as $$
  select a.id,
         a.name,
         s.id,
         s.name,
         s.program,
         coalesce(s."tuitionFee", 0),
         coalesce(a."commissionRate", 0),
         round(coalesce(s."tuitionFee", 0) * coalesce(a."commissionRate", 0) / 100.0, 2),
         s."enrolled_at",
         exists (
           select 1
             from public.agency_commission_item ci
             join public.agency_invoice i on i.id = ci.invoice_id
            where ci.student_id = s.id
              and i.period_id = p_period
              and i.status <> 'rejected'
         )
    from public."students" s
    join public."agencies" a on a.id = s."agentId"
    join public.agency_commission_period pr on pr.id = p_period
   where s."enrolled_at" is not null
     and s."status" = 'Accepted'
     and a."approval_status" = 'approved'
     and (pr.opens_on  is null or s."enrolled_at" >= pr.opens_on)
     and (pr.closes_on is null or s."enrolled_at" <= pr.closes_on)
     and (p_agency is null or a.id = p_agency)
     and (
       -- A megbízható szerveroldali hívó (SQL-szerkesztő, migráció, service_role)
       -- ugyanúgy lát, mint a többi függvényben — enélkül az admin SQL-ből hívva
       -- üres listát kap, és az agency_commission_issue tévesen "nincs elszámolható hallgató"-t jelent.
       public.is_trusted_caller()
       or public.is_staff()
       or (public.is_agent() and a.id = public.my_agency())
     )
   order by a.name, s.name
$$;

-- ---- agency_commission_issue ----
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

-- ---- agency_invoice_attach ----
create or replace function public.agency_invoice_attach(
  p_invoice   text,
  p_number    text,
  p_issued_on date,
  p_path      text,
  p_title     text default null,
  p_file_name text default null,
  p_file_size bigint default null,
  p_note      text default null
) returns public.agency_invoice
language plpgsql security definer set search_path = public as $$
declare
  inv public.agency_invoice;
  doc public.agency_document;
begin
  select * into inv from public.agency_invoice where id = p_invoice;
  if inv.id is null then
    raise exception 'Nincs ilyen számlaigénylés: %', p_invoice using errcode = 'no_data_found';
  end if;
  if not public.is_trusted_caller()
     and not public.is_staff()
     and not (public.is_agent() and inv.agency_id = public.my_agency()) then
    raise exception 'Ehhez a számlaigényléshez nincs jogosultsága.' using errcode = 'insufficient_privilege';
  end if;
  if inv.status not in ('requested', 'rejected', 'submitted') then
    raise exception 'A(z) "%" állapotú számlához már nem csatolható új dokumentum.', inv.status
      using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_number), '') = '' then
    raise exception 'A számlaszám kötelező.' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_path), '') = '' then
    raise exception 'A számla fájlját fel kell tölteni.' using errcode = 'check_violation';
  end if;

  insert into public.agency_document
    (id, agency_id, kind, title, path, file_name, file_size, note, uploaded_by, uploaded_at)
  values
    ('AGD-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12),
     inv.agency_id, 'invoice',
     coalesce(nullif(trim(p_title), ''), 'Számla ' || trim(p_number)),
     trim(p_path), p_file_name, p_file_size, p_note, auth.uid(), now())
  on conflict (path) do update
     set title = excluded.title, file_name = excluded.file_name, file_size = excluded.file_size
  returning * into doc;

  update public.agency_invoice
     set status         = 'submitted',
         invoice_number = trim(p_number),
         issued_on      = p_issued_on,
         document_id    = doc.id,
         submitted_at   = now(),
         submitted_by   = coalesce(nullif(public.my_email(), ''), 'system (SQL)'),
         reject_reason  = null,
         note           = coalesce(p_note, note)
   where id = inv.id
  returning * into inv;

  perform public.log_status_event('agency.invoice.submitted', 'agency_invoice/' || inv.id,
    'Számlaszám: ' || trim(p_number));
  return inv;
end
$$;

-- ---- agency_invoice_decide ----
create or replace function public.agency_invoice_decide(
  p_invoice  text,
  p_decision text,
  p_reason   text default null
) returns public.agency_invoice
language plpgsql security definer set search_path = public as $$
declare inv public.agency_invoice;
begin
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

-- ---------- 3. integritás-triggerek (mélységi védelem) ----------
-- Ezek MA nem érhetők el anonként: a tábláik policy-i `to authenticated`-ek és
-- is_approved()-ot kérnek, tehát az anon el sem jut a triggerig. A minta mégis
-- ugyanaz a hibás feltevés, és a 12-es migráció ezt a négy triggert HARD
-- ELŐFELTÉTELKÉNT kezeli az RLS-átkapcsoláshoz (12_rbac_flip.sql:42-43) —
-- ezért itt is lezárjuk, mielőtt egy jövőbeli anon-elérhető útvonal örökölné.

-- ---- students_protect_identity ----
create or replace function public.students_protect_identity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff() or public.is_trusted_caller() then
    return new;
  end if;
  -- a jelentkező az azonosságát és a pénzügyi paramétereit NEM írhatja
  new.id           := old.id;
  new.name         := old.name;
  new.email        := old.email;
  new."agentId"    := old."agentId";
  new."tuitionFee" := old."tuitionFee";
  new.evaluation   := old.evaluation;
  -- A felvételi DÖNTÉS és a fizetési link sem a jelentkezőé: a status mezőn
  -- keresztül a jelentkező felvetetné magát ('Accepted'), ami a
  -- sendConditionalAdmission (app.jsx:274) ügyintézői művelete.
  -- Mérve: e két sor nélkül a "update students set status='Accepted'" SIKERÜL.
  -- A FINANCE benne van az is_staff()-ban, tehát a fizetés jóváírásakor futó
  -- students.update({status:'Paid'}) (app.jsx:290) változatlanul működik.
  new.status        := old.status;
  new."paymentLink" := old."paymentLink";
  return new;
end
$$;

-- ---- interviewslots_force_owner ----
create or replace function public.interviewslots_force_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff() or public.is_trusted_caller() then
    return new;
  end if;
  new."studentId"   := public.my_student_id();
  new."studentName" := public.my_display_name();
  return new;
end
$$;

-- ---- payments_force_owner ----
create or replace function public.payments_force_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_finance() or public.is_trusted_caller() then
    return new;
  end if;
  new."studentName" := public.my_student_name();
  return new;
end
$$;

-- ---- auditlogs_force_actor ----
create or replace function public.auditlogs_force_actor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff() or public.is_trusted_caller() then
    return new;
  end if;
  new."user" := coalesce(public.my_email(), 'unknown');
  return new;
end
$$;

-- ---- students_protect_tracks ----
create or replace function public.students_protect_tracks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff() or public.is_trusted_caller() then
    return new;
  end if;
  new."status_legacy"  := old."status_legacy";
  new."visa_state"     := old."visa_state";
  new."deferral_state" := old."deferral_state";
  if not (coalesce(old."refund_state", '') = 'bank_details_needed'
          and coalesce(new."refund_state", '') = 'bank_details_provided') then
    new."refund_state" := old."refund_state";
  end if;
  return new;
end
$$;

-- ---- interviewslots_insert_owner ----
create or replace function public.interviewslots_insert_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public.is_staff() or public.is_trusted_caller() then
    return new;
  end if;

  if public.is_student() then
    new."studentId"   := public.my_student_id();
    new."studentName" := public.my_display_name();
    return new;
  end if;

  raise exception
    'Interjú-idősávot csak a Külügyi Iroda hozhat létre. A jelentkező a MÁR MEGHIRDETETT szabad sávok közül foglalhat.'
    using errcode = '42501',
          hint = 'Az idősávokat az Interjú Foglalás → Elérhetőség fülön lehet generálni.';
end
$fn$;

-- ---------- 4. jogosultságok ----------
-- FONTOS: a `create or replace function` MEGTARTJA a meglévő ACL-t, tehát a
-- 29-es migráció után az anonnál maradt EXECUTE-ot itt külön kell elvenni.
-- A trigger-függvényeknek senkinek nem kell EXECUTE-jog: a triggert a motor
-- hívja, nem a kliens.
revoke all on function public.agency_decide(text, text, text, numeric)            from public, anon;
revoke all on function public.student_set_enrolled(text, date)                    from public, anon;
revoke all on function public.agency_period_set_state(text, text)                 from public, anon;
revoke all on function public.agency_commission_preview(text, text)               from public, anon;
revoke all on function public.agency_commission_issue(text, text, date, text)     from public, anon;
revoke all on function public.agency_invoice_attach(text, text, date, text, text, text, bigint, text) from public, anon;
revoke all on function public.agency_invoice_decide(text, text, text)             from public, anon;

revoke all on function public.students_enrollment_guard()      from public, anon, authenticated;
revoke all on function public.students_protect_identity()      from public, anon, authenticated;
revoke all on function public.students_protect_tracks()        from public, anon, authenticated;
revoke all on function public.interviewslots_force_owner()     from public, anon, authenticated;
revoke all on function public.interviewslots_insert_owner()    from public, anon, authenticated;
revoke all on function public.payments_force_owner()           from public, anon, authenticated;
revoke all on function public.auditlogs_force_actor()          from public, anon, authenticated;

grant execute on function public.agency_decide(text, text, text, numeric)         to authenticated;
grant execute on function public.student_set_enrolled(text, date)                 to authenticated;
grant execute on function public.agency_period_set_state(text, text)              to authenticated;
grant execute on function public.agency_commission_preview(text, text)            to authenticated;
grant execute on function public.agency_commission_issue(text, text, date, text)  to authenticated;
grant execute on function public.agency_invoice_attach(text, text, date, text, text, text, bigint, text) to authenticated;
grant execute on function public.agency_invoice_decide(text, text, text)          to authenticated;

-- ---------- 5. ellenőrzés ----------
do $blk$
declare
  fn text;
begin
  foreach fn in array array[
    'public.agency_decide(text,text,text,numeric)',
    'public.student_set_enrolled(text,date)',
    'public.agency_period_set_state(text,text)',
    'public.agency_commission_preview(text,text)',
    'public.agency_commission_issue(text,text,date,text)',
    'public.agency_invoice_attach(text,text,date,text,text,text,bigint,text)',
    'public.agency_invoice_decide(text,text,text)',
    'public.is_trusted_caller()'
  ]
  loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'BIZTONSAGI HIBA: az anon hivhatja a(z) % fuggvenyt.', fn;
    end if;
  end loop;

  -- A kapuk tenyleg atirodtak-e: a regi mintanak nyoma sem maradhat.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('agency_decide', 'student_set_enrolled', 'agency_period_set_state',
                        'agency_commission_preview', 'agency_commission_issue',
                        'agency_invoice_attach', 'agency_invoice_decide',
                        'students_enrollment_guard', 'students_protect_identity',
                        'students_protect_tracks', 'interviewslots_force_owner',
                        'interviewslots_insert_owner', 'payments_force_owner',
                        'auditlogs_force_actor')
      and (p.prosrc like '%or auth.uid() is null%' or p.prosrc like '%and auth.uid() is not null%')
  ) then
    raise exception 'BIZTONSAGI HIBA: maradt "auth.uid() is (not) null" alaku kapu a javitott fuggvenyekben.';
  end if;

  raise notice 'Rendben: a 29-es migracio nyolc kapuja es hat integritas-trigger zarva, az anon EXECUTE visszavonva.';
end $blk$;
