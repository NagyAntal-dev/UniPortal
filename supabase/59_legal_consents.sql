-- ============================================================================
-- 59_legal_consents.sql — jogi dokumentumok, elfogadások és hozzájárulások naplója
--
-- MIÉRT KELL
--   A GDPR 7. cikk (1) szerint a hozzájárulást az adatkezelőnek BIZONYÍTANIA
--   kell tudni; a Ptk. 6:78. § szerint az általános szerződési feltétel akkor
--   válik a szerződés részévé, ha a felhasználó megismerhette és elfogadta. Eddig
--   a regisztráción egyetlen szürke mondat állt („By signing up you accept the
--   privacy policy”), link, jelölőnégyzet és napló nélkül — ez egyik célra sem
--   elég.
--
-- AMIT EZ A MIGRÁCIÓ AD
--   public.legal_document  — a dokumentumok és hozzájárulások katalógusa, VERZIÓVAL.
--                            Új verzió = új dátum; a felület belépéskor újra
--                            elfogadtatja a kötelezőket.
--   public.consent_log     — CSAK HOZZÁFŰZHETŐ napló: ki, mikor, melyik dokumentum
--                            melyik verzióját fogadta el, illetve melyik
--                            hozzájárulást adta meg vagy vonta vissza, és hol
--                            (regisztráció / belépés / profil). Módosítani és
--                            törölni SENKI nem tud (trigger tiltja).
--   public.legal_status()  — a bejelentkezett felhasználó állapota dokumentumonként.
--   public.legal_record()  — elfogadás / hozzájárulás / visszavonás rögzítése.
--   trigger auth.users-en  — a regisztrációkor bejelölt elfogadásokat naplózza
--                            (a signUp metaadatából); SOSEM akasztja meg a
--                            regisztrációt — ha hibázik, a belépéskori kapu kéri
--                            be újra.
--
-- AMIT SZÁNDÉKOSAN NEM TÁROL
--   IP-címet nem (adattakarékosság, GDPR 5. cikk (1) c)): a bizonyítékot a
--   hitelesített felhasználói azonosító, az időbélyeg és a verzió adja. A böngésző
--   azonosítóját (user agent) legfeljebb 300 karakterben, a csatorna igazolására.
--
-- MEGŐRZÉS
--   A napló sorai a felhasználói fiók törlése után is megmaradnak (nincs idegen
--   kulcs az auth.users-re), mert a jogszerű adatkezelés igazolásához és
--   jogi igények előterjesztéséhez szükségesek — az általános elévülési időn
--   (Ptk. 6:22. §, 5 év) belül. A pontos időt az adatvédelmi tisztviselő hagyja jóvá.
--
-- FÜGGŐSÉG: 02_auth_profiles.sql (profiles.role), 11_rbac_additive.sql (is_admin)
-- IDEMPOTENS: if not exists / create or replace / on conflict.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Katalógus
-- ------------------------------------------------------------
create table if not exists public.legal_document (
  id          text primary key check (id ~ '^[a-z][a-z0-9_]{1,40}$'),
  kind        text not null check (kind in ('terms', 'notice', 'declaration', 'consent')),
  version     text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$'),
  required    boolean not null default false,   -- a platform használatának feltétele
  roles       text[]  not null default '{}',    -- üres = minden szerepkör
  title_hu    text not null,
  title_en    text not null,
  label_hu    text not null,                    -- a jelölőnégyzet szövege
  label_en    text not null,
  url         text,                             -- a teljes szöveg nyilvános oldala
  sort_order  int  not null default 100,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

comment on table public.legal_document is
  'Jogi dokumentumok és hozzájárulások katalógusa. Új verzió kiadása: a version mező emelése (dátum) — a felület belépéskor újra elfogadtatja a kötelezőket.';

insert into public.legal_document (id, kind, version, required, roles, title_hu, title_en, label_hu, label_en, url, sort_order) values
  ('terms', 'terms', '2026-09-11', true, '{}',
   'Felhasználási feltételek', 'Terms of Use',
   'Elolvastam és elfogadom a Felhasználási feltételeket.',
   'I have read and accept the Terms of Use.',
   'terms.html', 10),
  ('privacy', 'notice', '2026-09-11', true, '{}',
   'Adatkezelési tájékoztató', 'Privacy Notice',
   'Megismertem az Adatkezelési tájékoztatót.',
   'I have read the Privacy Notice.',
   'privacy.html', 20),
  ('age16', 'declaration', '2026-09-11', true, '{}',
   'Életkori nyilatkozat', 'Age declaration',
   'Kijelentem, hogy elmúltam 16 éves.',
   'I confirm that I am at least 16 years old.',
   'privacy.html#kiskoru', 30),
  ('agent_terms', 'terms', '2026-09-11', true, '{AGENT}',
   'Partnerügynökségi feltételek', 'Partner Agency Terms',
   'Elfogadom a Partnerügynökségi feltételeket, és kijelentem, hogy a jelentkezők adatait az ő tájékoztatásuk és felhatalmazásuk alapján adom meg.',
   'I accept the Partner Agency Terms and confirm that I submit applicants'' data only after informing them and with their authorisation.',
   'terms.html#partner', 40),
  ('marketing', 'consent', '2026-09-11', false, '{}',
   'Hírlevél és képzési ajánlatok', 'Newsletter and programme offers',
   'Hozzájárulok, hogy az egyetem képzési ajánlatairól és eseményeiről e-mailben tájékoztatást kapjak. Bármikor visszavonhatom.',
   'I agree to receive emails about the university''s programmes and events. I can withdraw this at any time.',
   'privacy.html#marketing', 50),
  ('whatsapp', 'consent', '2026-09-11', false, '{}',
   'Kapcsolattartás WhatsAppon', 'Contact via WhatsApp',
   'Hozzájárulok, hogy a Nemzetközi Iroda WhatsAppon is felvegye velem a kapcsolatot (a Meta Platforms szolgáltatásán keresztül). Bármikor visszavonhatom.',
   'I agree that the International Office may also contact me via WhatsApp (a Meta Platforms service). I can withdraw this at any time.',
   'privacy.html#whatsapp', 60)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2. A napló — csak hozzáfűzhető
-- ------------------------------------------------------------
create table if not exists public.consent_log (
  id               bigint generated always as identity primary key,
  user_id          uuid not null,          -- szándékosan NINCS idegen kulcs: a fiók törlése után is igazolni kell
  email            text,
  document_id      text not null references public.legal_document(id),
  document_version text not null,
  action           text not null check (action in ('accept', 'grant', 'withdraw')),
  context          text not null check (context in ('signup', 'login', 'profile')),
  user_agent       text check (user_agent is null or char_length(user_agent) <= 300),
  created_at       timestamptz not null default now()
);
create index if not exists consent_log_user_doc_idx on public.consent_log (user_id, document_id, created_at desc);
create index if not exists consent_log_email_idx    on public.consent_log (lower(email));

create or replace function public.consent_log_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $fn$
begin
  raise exception 'CONSENT_LOG_IMMUTABLE: a hozzájárulási napló nem módosítható és nem törölhető.';
end $fn$;
revoke all on function public.consent_log_immutable() from public;
revoke all on function public.consent_log_immutable() from anon;

drop trigger if exists consent_log_no_update on public.consent_log;
create trigger consent_log_no_update before update or delete on public.consent_log
  for each row execute function public.consent_log_immutable();

alter table public.legal_document enable row level security;
alter table public.consent_log    enable row level security;

drop policy if exists legal_document_read on public.legal_document;
create policy legal_document_read on public.legal_document for select to anon, authenticated using (true);

drop policy if exists consent_log_read on public.consent_log;
create policy consent_log_read on public.consent_log for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- Írási policy SZÁNDÉKOSAN nincs: beírni csak a lenti függvények tudnak.

-- A Supabase alapértelmezett jogai mindent megadnának — előbb mindent visszavonunk.
revoke all on public.legal_document from anon, authenticated, public;
revoke all on public.consent_log    from anon, authenticated, public;
grant select on public.legal_document to anon, authenticated;
grant select on public.consent_log    to authenticated;

-- ------------------------------------------------------------
-- 3. Állapot a bejelentkezett felhasználónak
-- ------------------------------------------------------------
create or replace function public.legal_status()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text;
begin
  if auth.uid() is null then raise exception 'LEGAL_NOT_AUTHENTICATED'; end if;
  select upper(coalesce(role, 'STUDENT')) into v_role from public.profiles where id = auth.uid();
  v_role := coalesce(v_role, 'STUDENT');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'kind', d.kind, 'version', d.version, 'required', d.required,
             'title_hu', d.title_hu, 'title_en', d.title_en, 'label_hu', d.label_hu, 'label_en', d.label_en,
             'url', d.url,
             'last_action',  l.action,
             'last_version', l.document_version,
             'last_at',      l.created_at,
             -- Érvényes-e most: a legutóbbi bejegyzés a JELENLEGI verzióra szól, és elfogadás/megadás.
             'current', coalesce(l.document_version = d.version and l.action in ('accept', 'grant'), false)
           ) order by d.sort_order)
      from public.legal_document d
      left join lateral (
        select c.action, c.document_version, c.created_at
          from public.consent_log c
         where c.user_id = auth.uid() and c.document_id = d.id
         order by c.created_at desc, c.id desc
         limit 1
      ) l on true
     where d.active and (cardinality(d.roles) = 0 or v_role = any(d.roles))
  ), '[]'::jsonb);
end $fn$;

-- ------------------------------------------------------------
-- 4. Rögzítés (belépéskori kapu, profil)
--    p_items: [{ "id": "terms", "version": "2026-09-11", "action": "accept" }, …]
-- ------------------------------------------------------------
create or replace function public.legal_record(p_items jsonb, p_context text, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $fn$
declare
  v_item  jsonb;
  v_doc   public.legal_document%rowtype;
  v_email text;
  v_act   text;
  v_ver   text;
begin
  if auth.uid() is null then raise exception 'LEGAL_NOT_AUTHENTICATED'; end if;
  if p_context not in ('login', 'profile') then
    raise exception 'LEGAL_BAD_INPUT: a kontextus csak "login" vagy "profile" lehet.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'LEGAL_BAD_INPUT: legalább egy tételt meg kell adni.';
  end if;
  select email into v_email from auth.users where id = auth.uid();

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_doc from public.legal_document where id = v_item->>'id' and active;
    if not found then raise exception 'LEGAL_UNKNOWN_DOCUMENT: %', v_item->>'id'; end if;
    v_act := v_item->>'action';
    v_ver := v_item->>'version';
    -- Csak a JELENLEGI verziót lehet elfogadni: amit a felhasználó látott, az legyen naplózva.
    if v_ver is distinct from v_doc.version then
      raise exception 'LEGAL_STALE_VERSION: % (jelenlegi: %, kapott: %)', v_doc.id, v_doc.version, v_ver;
    end if;
    if v_doc.kind = 'consent' then
      if v_act not in ('grant', 'withdraw') then raise exception 'LEGAL_BAD_ACTION: hozzájárulásnál csak grant/withdraw.'; end if;
    else
      if v_act <> 'accept' then raise exception 'LEGAL_BAD_ACTION: % csak elfogadható (accept).', v_doc.id; end if;
    end if;
    insert into public.consent_log (user_id, email, document_id, document_version, action, context, user_agent)
    values (auth.uid(), v_email, v_doc.id, v_doc.version, v_act, p_context, left(p_user_agent, 300));
  end loop;

  return public.legal_status();
end $fn$;

-- ------------------------------------------------------------
-- 5. Regisztráció: a signUp metaadatában érkező elfogadások naplózása
--    raw_user_meta_data.consents = { "terms": "2026-09-11", "privacy": "2026-09-11",
--                                    "age16": "2026-09-11", "marketing": "2026-09-11", … }
--    Csak a jelenlegi verzióval egyező tétel kerül be. Hiba esetén a regisztráció
--    NEM akad meg: a belépéskori kapu úgyis bekéri a hiányzó elfogadást.
-- ------------------------------------------------------------
create or replace function public.legal_from_signup()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare
  v_c   jsonb := new.raw_user_meta_data->'consents';
  v_doc public.legal_document%rowtype;
begin
  if v_c is null or jsonb_typeof(v_c) <> 'object' then return new; end if;
  begin
    for v_doc in select * from public.legal_document where active loop
      if (v_c->>v_doc.id) = v_doc.version then
        insert into public.consent_log (user_id, email, document_id, document_version, action, context)
        values (new.id, new.email, v_doc.id, v_doc.version,
                case when v_doc.kind = 'consent' then 'grant' else 'accept' end, 'signup');
      end if;
    end loop;
  exception when others then
    raise warning 'legal_from_signup: a regisztrációs elfogadás naplózása nem sikerült (%). A belépéskori kapu bekéri.', sqlerrm;
  end;
  return new;
end $fn$;

drop trigger if exists on_auth_user_created_legal on auth.users;
create trigger on_auth_user_created_legal
  after insert on auth.users
  for each row execute function public.legal_from_signup();

-- ------------------------------------------------------------
-- 6. Jogok
-- ------------------------------------------------------------
revoke all on function public.legal_status()                  from public, anon;
revoke all on function public.legal_record(jsonb, text, text) from public, anon;
revoke all on function public.legal_from_signup()             from public, anon, authenticated;
grant execute on function public.legal_status()                  to authenticated;
grant execute on function public.legal_record(jsonb, text, text) to authenticated;

do $blk$
begin
  if has_table_privilege('anon', 'public.consent_log', 'select') then
    raise exception 'BIZTONSAGI HIBA: az anon olvashatja a hozzajarulasi naplot.';
  end if;
  if has_table_privilege('authenticated', 'public.consent_log', 'insert')
     or has_table_privilege('authenticated', 'public.consent_log', 'update')
     or has_table_privilege('authenticated', 'public.consent_log', 'delete')
     or has_table_privilege('authenticated', 'public.consent_log', 'truncate') then
    raise exception 'BIZTONSAGI HIBA: az authenticated kozvetlenul irhatja a hozzajarulasi naplot.';
  end if;
  if has_function_privilege('anon', 'public.legal_record(jsonb,text,text)', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a legal_record fuggvenyt.';
  end if;
  raise notice 'Rendben: a jogi katalogus es a hozzajarulasi naplo kesz.';
end $blk$;
