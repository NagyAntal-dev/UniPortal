-- ============================================================
-- UniPortal Pro — A profiles tábla nem mindenki számára olvasható
--
-- MIÉRT:
--   A 07-es migráció SELECT-policy-je így szólt (07:173-175):
--
--       create policy "profiles_select" on public.profiles
--         for select to authenticated
--         using (id = auth.uid() or public.is_approved());
--
--   Vagyis MINDEN jóváhagyott fiók — köztük minden hallgató és ügynök —
--   lekérdezhette az ÖSSZES profilt: nevet, e-mail-címet, telefonszámot,
--   szerepkört, ügynökség-azonosítót, jóváhagyási állapotot. A felület ezt
--   sehol nem mutatja meg, a REST-végpont viszont igen:
--
--       GET /rest/v1/profiles?select=*
--
--   Egyetlen bejelentkezett hallgató egy kéréssel letölthette az egész
--   intézmény címlistáját.
--
--   A SZIVÁRGÁS MÁSIK ÚTJA — és ezt a policy szigorítása önmagában NEM
--   zárná be: a 38-as migráció `registration_directory` nézete (38:338)
--   `security_invoker` NÉLKÜL készült. Az ilyen nézet a TULAJDONOSA jogán
--   fut, tehát MEGKERÜLI a profiles RLS-ét — és `grant select ... to
--   authenticated` van rajta. Bármelyik bejelentkezett fiók lekérdezhette
--   rajta keresztül ugyanazt az adatot, ráadásul a neptun-kóddal és a
--   képzési adatokkal kiegészítve. A tároló többi nézete (09, 60, 66) helyesen
--   `security_invoker = on`-nal készült, a 60-as még ellenőrzi is (60:284) —
--   ez az egy maradt ki.
--
-- MIT CSINÁL:
--   1. A profiles SELECT-et a saját sorra + az ügyintézőkre szűkíti.
--   2. A registration_directory nézetet átállítja `security_invoker = on`-ra,
--      így az is a HÍVÓ jogán fut, és az 1. pont rá is érvényes.
--   3. A kollégiumi személy-összekötéshez ad egy szűk RPC-t. A párbeszéd
--      (features/dorm.jsx, DORM_AddResident) eddig közvetlenül a profiles-ból
--      olvasott, a KOLI_ADMIN/KOLI_SYSADMIN viszont NEM ügyintéző — nekik az
--      1. pont után nem maradna listájuk. Az RPC pontosan annyit ad vissza,
--      amennyi a párosításhoz kell (azonosító, név, e-mail, szerepkör).
--
-- AMI NEM VÁLTOZIK:
--   A nevek megjelenítése máshol: az üzenetek, a felvételi beszélgetés, az
--   interjúk és a kollégiumi listák mind SECURITY DEFINER RPC-ken át kapják a
--   neveket, azokra az RLS nem vonatkozik.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt),
--   vagy: Supabase dashboard → SQL Editor → New query → beilleszt → Run
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. a SELECT-policy szűkítése ----------
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_staff());

-- ---------- 2. a címtár a hívó RLS-jét használja ----------
-- A view korábban a tulajdonosa jogán futott, ezért megkerülte a fenti
-- profiles-policy-t. Az invoker mód ezt ugyanahhoz a láthatósághoz köti,
-- mint a közvetlen profiles-lekérdezést.
alter view public.registration_directory set (security_invoker = true);

-- ---------- 3. kollégiumi személy-összekötés: szűk fióklista ----------
-- A KOLI_ADMIN és a KOLI_SYSADMIN jogosult kollégistát felvenni, de nem
-- feltétlenül public.is_staff(). Nekik csak az összekötéshez szükséges,
-- jóváhagyott fiókok adatait adjuk ki, nem a teljes profiles sort.
create or replace function public.dorm_profile_candidates()
returns table (id uuid, email text, name text, role text, approval_status text)
language plpgsql
stable
security definer
set search_path = dorm, public, pg_temp
as $fn$
begin
  if not (dorm.can_grant() or dorm.has_any_role(array['KOLI_ADMIN'])) then
    raise exception 'DORM_FORBIDDEN: a portalfiokok listaja KOLI_ADMIN / KOLI_SYSADMIN / admin jogosultsagot igenyel.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select p.id, p.email, p.name, p.role, p.approval_status
      from public.profiles p
     where p.approval_status = 'approved'
     order by p.name nulls last, p.email
     limit 1000;
end;
$fn$;

revoke all on function public.dorm_profile_candidates() from public, anon;
grant execute on function public.dorm_profile_candidates() to authenticated;

-- ---------- 4. ellenőrzés ----------
do $chk$
begin
  if not coalesce((select (reloptions::text[] @> array['security_invoker=true'])
                     from pg_class
                    where oid = 'public.registration_directory'::regclass), false) then
    raise exception 'BIZTONSAGI HIBA: a registration_directory nem security_invoker nezet.';
  end if;
  if has_function_privilege('anon', 'public.dorm_profile_candidates()', 'execute') then
    raise exception 'BIZTONSAGI HIBA: az anon hivhatja a dorm_profile_candidates fuggvenyt.';
  end if;
  raise notice 'Rendben: profiles sajat sorra/ugyintezore szukitve, a kollégiumi fioklista dedikalt RPC-n erheto el.';
end
$chk$;
