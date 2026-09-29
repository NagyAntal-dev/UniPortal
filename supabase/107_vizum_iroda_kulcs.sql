-- ============================================================
-- 107_vizum_iroda_kulcs.sql
-- A VÍZUM-NYILVÁNTARTÁS IRODAI BEJEGYZÉSÉNEK VÉDELME
-- ============================================================
-- MIÉRT: a felvett hallgatónak vízumot kell szereznie a beutazáshoz. A
-- felület két külön bejegyzést tart nyilván a jelentkezés data mezőjében:
--
--   data.visa        — a HALLGATÓ bejelentése („beadtam", „megkaptam")
--   data.visa_iroda  — az IRODA nyilvántartása (ő látta a vízumot)
--
-- A kettő nem ugyanaz: az egyik önbevallás, a másik igazolás. Ha a hallgató
-- felül tudná írni az irodai bejegyzést, az ügyintéző egy olyan „igazolást"
-- látna, amit nem ő adott — épp azt veszítenénk el, amiért a két mező külön
-- van. A 60-as migráció védelme (admission_processes_protect_office_keys)
-- pontosan ezt tudja: a felsorolt FELSŐ SZINTŰ kulcsokat a közvetlen
-- (PostgREST) írás nem módosíthatja, csak az iroda és a SECURITY DEFINER
-- RPC-k. Ez a szkript kiegészíti a kulcslistát.
--
-- A FELÜLET ENÉLKÜL IS MŰKÖDIK: ha ez a szkript nem fut le, a vízum-jelölés
-- ugyanúgy használható, csak a hallgatói oldalról elvileg felülírható.
--
-- MIT VÁRJ A FUTÁS VÉGÉN: egyetlen sor, három kulccsal:
--   {decision,interview,visa_iroda}
-- ============================================================

create or replace function public.admission_office_keys()
returns text[] language sql immutable as $fn$
  select array['decision', 'interview', 'visa_iroda']::text[]
$fn$;

revoke all on function public.admission_office_keys() from public, anon;
grant execute on function public.admission_office_keys() to authenticated;

comment on function public.admission_office_keys() is
  'A jelentkezés data mezőjének IRODAI kulcsai: ezeket a jelentkező közvetlen írása nem módosíthatja (60-as trigger). visa_iroda: a vízum irodai nyilvántartása (107).';

-- ---------------------------------------------------------------------------
-- Záró ellenőrzés
-- ---------------------------------------------------------------------------
do $$
declare
  v text[];
begin
  select public.admission_office_keys() into v;
  if not ('visa_iroda' = any(v)) then
    raise exception 'A visa_iroda kulcs nem került be a vedett listaba: %', v;
  end if;
  raise notice 'Rendben: 107 — vedett irodai kulcsok: %', v;
end $$;

select public.admission_office_keys() as vedett_irodai_kulcsok;
