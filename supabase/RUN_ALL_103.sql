-- ============================================================================
-- RUN_ALL_103.sql — a lejárt határidő ne „ma jár le"-ként jelenjen meg
-- ============================================================================
-- MI TÖRTÉNT: egy 24-ei határidejű felhívásnál a rendszer 27-én is azt írta ki,
-- hogy „ma jár le".
--
-- AZ OK: a felhívás-lista a hátralévő napokat nullára vágva adta vissza
-- (greatest(0, …)). Egy három napja lejárt határidő így nem −3, hanem 0 lett,
-- a felület pedig a 0-t jelenti „ma jár le"-ként. A vágás azt akarta
-- elkerülni, hogy negatív szám kerüljön a képernyőre — de ezzel a lejárt és a
-- ma lejáró határidőt megkülönböztethetetlenné tette, ami rosszabb.
--
-- Ez nem szépséghiba: a „ma jár le" cselekvést jelent. Ha egy lejárt kiírás is
-- ezt mutatja, vagy fölöslegesen kapkodnak, vagy megtanulják, hogy a jelzés
-- nem megbízható.
--
-- A JAVÍTÁS: a szerver a valódi különbséget adja (negatívat is), a felület
-- pedig „3 napja lejárt" / „tegnap járt le" formában, áthúzott dátummal írja
-- ki. A naptár és a sürgősség-besorolás már eddig is így számolt — most
-- egyformán működik a kettő.
--
-- A szkript a MEGLÉVŐ függvényt írja át egyetlen kifejezésben (a definíciót
-- olvassa ki és cseréli), hogy a lista minden más mezője pontosan ugyanaz
-- maradjon — és ellenőrzi, hogy a vágás tényleg eltűnt.
--
-- MIT VÁRJ A FUTÁS VÉGÉN:
--   NOTICE: 103 — a grants_calls a valodi nap-kulonbseget adja vissza.
--   NOTICE: Rendben: 103 — a lejart hatarido nem „ma"-kent jelenik meg.
--   NOTICE: Rendben: az ECHO bekuldes tovabbra is zart.
-- ============================================================================



-- ####################################################################
-- ### 103_grants_lejart_hatarido.sql
-- ####################################################################

-- ============================================================
-- 103_grants_lejart_hatarido.sql — a lejárt határidő ne „ma"-ként jelenjen meg
-- ============================================================
-- MI TÖRTÉNT: egy 24-ei határidejű felhívásnál a rendszer 27-én is azt írta,
-- hogy „ma jár le".
--
-- AZ OK: a felhívás-lista a hátralévő napokat NULLÁRA VÁGVA adta vissza:
--     greatest(0, kovetkezo_hatarido::date - current_date)
-- Egy három napja lejárt határidő így nem −3, hanem 0 lett, a felület pedig a
-- 0-t jelenti „ma jár le"-ként. A vágás eredetileg azt akarta elkerülni, hogy
-- negatív szám kerüljön a képernyőre — de ezzel a lejárt és a ma lejáró
-- határidőt MEGKÜLÖNBÖZTETHETETLENNÉ tette, ami rosszabb.
--
-- Ez nem szépséghiba: a pályázati irodának a „ma jár le" cselekvést jelent. Ha
-- egy lejárt kiírás is ezt mutatja, vagy fölöslegesen kapkodnak, vagy — ami
-- rosszabb — megtanulják, hogy a jelzés nem megbízható.
--
-- A JAVÍTÁS: a szerver a VALÓDI különbséget adja vissza (negatívat is), és a
-- felület ebből írja ki, hogy „x napja lejárt". A naptár és a
-- sürgősség-besorolás már eddig is így számolt (78_grants_calendar.sql), csak
-- a lista tért el tőle — most egyformán működik mind a kettő.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

do $$
declare v_src text;
begin
  -- A függvény többi része változatlan: célzottan a vágást cseréljük, hogy a
  -- lista minden más mezője pontosan ugyanaz maradjon.
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'grants_calls'
   order by p.pronargs desc limit 1;
  if v_src is null then
    raise exception 'HIBA: nem talalom a public.grants_calls fuggvenyt.';
  end if;
  if position('greatest(0, c.kovetkezo_hatarido::date - current_date)' in v_src) = 0 then
    raise notice '103 — a vagas mar nincs a fuggvenyben, nincs teendo.';
    return;
  end if;
  v_src := replace(v_src,
    'greatest(0, c.kovetkezo_hatarido::date - current_date)',
    '(c.kovetkezo_hatarido::date - current_date)');
  execute v_src;
  raise notice '103 — a grants_calls a valodi nap-kulonbseget adja vissza.';
end $$;

do $chk$
declare v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'grants_calls'
   order by p.pronargs desc limit 1;
  if position('greatest(0, c.kovetkezo_hatarido::date' in v_src) > 0 then
    raise exception 'HIBA: a vagas bent maradt a grants_calls fuggvenyben.';
  end if;
  raise notice 'Rendben: 103 — a lejart hatarido nem „ma"-kent jelenik meg.';
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
