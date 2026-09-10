-- ============================================================================
-- 55_attendance_band_fix.sql — a hiányzó óralátogatási sávkódok pótlása
--
-- A TÜNET
--   A „Teszt kérdőív"-vel futó kampányoknál az eredmény akkor sem jelent meg,
--   amikor MINDEN jogosult hallgató kitöltötte. Adminként is üres maradt, és a
--   felület „kevés válasz"-t írt ki — miközben 5 válasz megvolt 5 jogosultból.
--
-- A MÉRT OK
--   Az echo.results_build() a kurzusszintű válaszokból kiszűri azokat, ahol
--   echo.attendance_low(r.attendance_band) igaz. Ez a függvény FAIL-CLOSED:
--       - a sáv üres/NULL            -> false (a fő halmazba megy)
--       - a sáv a katalógusban van   -> a katalógus 'low' jelzője dönt
--       - EGYÉBKÉNT                  -> true  (ismeretlen címke = alacsony)
--   A „Teszt kérdőív" viszont ezeket az értékeket kínálja fel:
--       '0-33', '34-66', '67-100'          -- SZÁZALÉKJEL NÉLKÜL
--   az echo.attendance_band katalógusban pedig ezek állnak:
--       '0-33%', '26-50%', '51-75%', '76-100%', '0–32%', '33–59%', …
--   Egyik sem egyezik, tehát MINDEN válasz ismeretlen címkét kapott, és a
--   fail-closed ág mindet alacsony óralátogatásúnak minősítette. A fő halmaz
--   így nulla elemű lett, és a k_numeric=5 küszöb — teljesen helyesen — rejtett.
--
--   A fail-closed viselkedés HELYES, és nem nyúlunk hozzá: egy ismeretlen sávot
--   biztonságosabb alacsonynak venni, mint beengedni a fő halmazba. A hiba az,
--   hogy a katalógus nem ismeri a kérdőív értékeit.
--
-- AMIT EZ A MIGRÁCIÓ TESZ
--   Felveszi a három hiányzó kódot a katalógusba, a meglévők szemantikájával:
--       '0-33'    low = true   (a 3. § (9) szerint 33% alatt tájékoztató jellegű)
--       '34-66'   low = false
--       '67-100'  low = false
--   Meglévő sort NEM ír át, és a küszöböket NEM módosítja.
--
-- AMIT NEM OLD MEG — ŐSZINTÉN
--   A „Teszt kérdőív" egyetlen kérdése sem oktatói hatókörű (nincs benne
--   repeat:'teacher' kérdés), ezért az OKTATÓI bontás ezzel a kérdőívvel
--   ezután is üres marad: nincs mit oktatónként bontani. Ez nem hiba és nem is
--   javítható adatoldalról — a kérdőív nem kérdez semmit oktatónként. Az éles
--   „OMHV alapkérdőív" tartalmaz ilyen kérdéseket.
--
-- IDEMPOTENS: on conflict do nothing.
-- ============================================================================

insert into echo.attendance_band (code, name_hu, name_en, low, sort_order, active)
values
  ('0-33',    '0–33%',   '0–33%',   true,  7,  true),
  ('34-66',   '34–66%',  '34–66%',  false, 20, true),
  ('67-100',  '67–100%', '67–100%', false, 21, true)
on conflict (code) do nothing;

-- Ellenőrzés: a „Teszt kérdőív" MINDEN felkínált óralátogatási értéke
-- szerepel-e a katalógusban. Ha nem, kimondjuk, melyik hiányzik — némán
-- nem megyünk tovább, mert pont ez a némaság okozta az eredeti hibát.
do $$
declare
  v_hianyzo text;
  v_n       integer := 0;
begin
  for v_hianyzo in
    select distinct o->>'value'
      from echo.template_version v,
           jsonb_array_elements(v.compiled->'sections') s,
           jsonb_array_elements(s->'questions') q,
           jsonb_array_elements(q->'options') o
     where v.state = 'live'
       and q->>'id' = 'attendance'
       and not exists (select 1 from echo.attendance_band b
                        where b.code = o->>'value' and b.active)
  loop
    raise warning 'HIANYZO ORALATOGATASI SAV: "%" — egy elo kerdoiv felkinalja, '
                  'de a katalogus nem ismeri, ezert MINDEN ilyen valasz alacsony '
                  'oralatogatasunak minosul es kiesik az eredmenybol.', v_hianyzo;
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then
    raise notice 'Rendben: minden elo kerdoiv oralatogatasi erteke szerepel a katalogusban.';
  else
    raise notice '% hianyzo sav maradt — a fenti figyelmeztetesek mondjak meg, melyek.', v_n;
  end if;
end $$;
