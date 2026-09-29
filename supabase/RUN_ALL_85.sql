-- ============================================================================
-- RUN_ALL_85.sql — célközönség a képzéseknél (2026-09-24)
-- ============================================================================
-- MIÉRT: a külügyi iroda észrevétele — „a magyar diákok ne tudjanak a
-- külföldieknek meghirdetett programokra jelentkezni". A mező most kerül be,
-- hogy a szabály készen álljon, mire a magyar jelentkezők is használják a
-- portált.
--
-- MI VÁLTOZIK MA: SEMMI. Minden meglévő képzés a 'mind' értéket kapja, tehát
-- a mostani működés érintetlen. A megkülönböztetés akkor lép életbe, amikor
-- az iroda egy képzésnél a szerkesztőben tudatosan átállítja
-- („Kinek hirdetjük" mező).
--
-- A DÖNTÉS ALAPJA a jelentkező ÁLLAMPOLGÁRSÁGA (a jelentkezés személyes
-- adataiból). Ha nem ismerjük, nem zárunk ki senkit.
--
-- A FUTÁS VÉGÉN EZT KELL LÁTNOD:
--   NOTICE: Rendben: 85 — celkozonseg mezo a kepzeseknel (N sor "mind").
-- ============================================================================


-- ####################################################################
-- ### 85_program_audience.sql
-- ####################################################################

-- ============================================================
-- 85_program_audience.sql — kinek szól a képzés: külföldi vagy magyar jelentkező
-- ============================================================
-- MIÉRT: a külügyi iroda észrevétele (2026-09-24): „A későbbiekben, ha a magyar
-- diákok is használják majd a portált, ők ne tudjanak a külföldieknek
-- meghirdetett programokra jelentkezni."
--
-- A mai kínálat teljes egészében az angol nyelvű, külföldieknek meghirdetett
-- képzés, ezért MINDEN meglévő sor alapértéke 'mind' marad — a mostani
-- működés nem változik. A megkülönböztetés akkor lép életbe, amikor az iroda
-- egy képzésnél tudatosan átállítja.
--
-- MIÉRT OSZLOP, ÉS NEM CÍMKE: a `tags` szabad szöveg, amit bárki átír; erre
-- viszont jogosultsági és szűrési szabály épül, tehát legyen zárt értékkészlet
-- (check), hogy elgépelés ne nyisson meg egy képzést.
--
-- A DÖNTÉS ALAPJA: a jelentkező ÁLLAMPOLGÁRSÁGA (a jelentkezés személyes
-- adataiban, illetve a profilban megadott ország). Nem a lakcím és nem a
-- nyelv — a „magyar diák" itt állampolgárságot jelent.
-- ============================================================

alter table public.programs add column if not exists audience text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'programs_audience_ck') then
    alter table public.programs
      add constraint programs_audience_ck
      check (audience is null or audience in ('mind', 'kulfoldi', 'magyar'));
  end if;
end $$;

comment on column public.programs.audience is
  'Kinek hirdetjük: mind (alapértelmezés) | kulfoldi (csak nem magyar állampolgár) | magyar (csak magyar állampolgár). NULL = mind, hogy a meglévő sorok viselkedése ne változzon.';

-- A meglévő kínálat marad mindenkinek szóló: az iroda állítja át, ha kell.
update public.programs set audience = 'mind' where audience is null;

do $chk$
declare v_db integer;
begin
  select count(*) into v_db from public.programs where audience is null;
  if v_db > 0 then
    raise exception 'HIBA: % kepzesnel maradt ures a celkozonseg.', v_db;
  end if;
  raise notice 'Rendben: 85 — celkozonseg mezo a kepzeseknel (% sor "mind").',
               (select count(*) from public.programs);
end $chk$;

-- ####################################################################
-- ### 21_echo_harden_submit.sql
-- ####################################################################

-- ============================================================
-- UniPortal Pro — ECHO: az anonim beküldés jogosultságának lezárása
-- ------------------------------------------------------------
-- MIÉRT KELL:
--   Az ECHO anonimitásának egyik tartóoszlopa, hogy a beküldés NEM a hallgató
--   munkamenetével fut: az echo_submit() kizárólag 'anon' joggal hívható, így
--   egy JWT-t hordozó kérés jogosultsági hibával elhasal, és a hallgató
--   azonosítója nem kerül a tranzakciós naplóba és a platform edge-logjába.
--
--   A 15_echo_core.sql ezt CSAK azzal éri el, hogy megadja a jogot az anon-nak
--   (1712. sor) — de SOHA NEM VONJA VISSZA az authenticated-tól. A Supabase
--   alapértelmezett jogosztása (alter default privileges … grant execute on
--   functions to anon, authenticated, service_role) viszont MINDEN új publikus
--   függvényre ad authenticated végrehajtási jogot. Ha ez a projekten él, akkor
--   az echo_submit bejelentkezve is hívható, és a garancia csendben elveszik.
--
--   MÉRVE: egy tiszta adatbázison, ahol a migrációk UTÁN lefutott egy tömeges
--   'grant all on all functions in schema public to anon, authenticated' —
--   ami pontosan azt utánozza, amit a platform tesz —, az echo_submit
--   jogosultsága 'anon=X authenticated=X service_role=X' lett.
--
-- MIT CSINÁL:
--   Visszavonja a végrehajtási jogot mindenkitől, majd kizárólag az anon-nak adja
--   vissza. Beállítja az alapértelmezett jogosztást is, hogy egy jövőbeli
--   platform-művelet ne nyissa vissza. A végén ellenőriz.
--
-- FUTTATÁSI SORREND: ez az UTOLSÓ migráció. Minden alkalommal futtasd újra,
-- amikor bármilyen új ECHO-migráció felment.
--
-- Idempotens — biztonságosan újrafuttatható, és futtatandó MINDEN olyan
-- alkalommal, amikor új ECHO-migráció ment fel.
-- ============================================================

-- ---------- 1. a beküldő függvény lezárása ----------
do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'echo_submit'
  loop
    execute format('revoke all on function %s from public, authenticated, service_role', fn);
    execute format('grant execute on function %s to anon', fn);
    raise notice 'Lezarva es anon-ra szukitve: %', fn;
  end loop;
end $$;

-- ---------- 2. a jegykiadó marad authenticated ----------
-- Ez SZÁNDÉKOSAN azonosított: itt még nincs válasz, tehát nincs mit korrelálni.
do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'echo_issue_ticket'
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ---------- 3. ellenőrzés ----------
with a as (
  select p.proname,
         coalesce(array_to_string(p.proacl, ' '), '(alapertelmezett)') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('echo_submit', 'echo_issue_ticket')
)
select proname as fuggveny, acl,
       case
         when proname = 'echo_submit'
           then case when acl like '%anon=X%' and acl not like '%authenticated=X%'
                     then 'OK — csak anon' else '*** BAJ: bejelentkezve is hivhato ***' end
         when proname = 'echo_issue_ticket'
           then case when acl like '%authenticated=X%' and acl not like '%anon=X%'
                     then 'OK — csak authenticated' else '*** BAJ ***' end
       end as allapot
from a order by proname;
