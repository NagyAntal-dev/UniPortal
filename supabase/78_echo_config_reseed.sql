-- ============================================================
-- UniPortal Pro — ECHO: az üzemi konfigurációs sorok pótlása
--
-- MIÉRT:
--   Ugyanaz a hiba, mint a 77-esnél, csak más táblán. Az ECHO működéséhez
--   kellő KONFIGURÁCIÓS sorokat (küszöbök, jegy-aláíró kulcs, óralátogatási
--   szótár) minden migráció EGYSZER, seed INSERT-tel veti el. Ha az
--   adatbázis nyilvántartás nélkül került a gépre, a migrációs futtató
--   "baseline" módba lép (deploy/migrate/run.sh), és ezeket a fájlokat
--   lefutottnak jelöli ANÉLKÜL, hogy lefuttatná — a táblák létrejöhettek
--   kézzel, a sorok viszont kimaradtak.
--
--   A TÜNET, ami elárulta: az echo.setting-ből hiányzott a 'min_share_pct'
--   és a 'min_headcount' (egy UPDATE rájuk "UPDATE 0"-t adott). Innen az
--   echo.eligibility_rebuild:
--       v_min_head  := (select value::integer from echo.setting where key='min_headcount');
--       v_min_share := (select value::numeric from echo.setting where key='min_share_pct');
--   mindkettő NULL lett, és minden rájuk épülő összehasonlítás NULL-t adott:
--       where headcount >= v_min_head and ...   -> egyetlen sor sem igaz
--       where ct.share_pct >= v_min_share       -> egyetlen sor sem igaz
--   Így az echo.eligibility ÜRESEN maradt, a kampány pedig
--   ECHO_NO_ELIGIBILITY hibával nem volt megnyitható. Csendes hiba: a
--   kizárási napló sem jelezte, mert a kizáró ágak (headcount < NULL,
--   share_pct < NULL) szintén NULL-ra futottak.
--
--   A NULL-küszöb tehát nem "mindent átenged", hanem MINDENT KIZÁR. A
--   fail-closed irány önmagában helyes; a hiányzó sor a hiba.
--
-- MIT CSINÁL:
--   1. echo.setting — mind a 15/16/22/35-ös migráció küszöbei, a meglévő
--      értékekhez NEM nyúlva (on conflict do nothing). Ha valaki
--      finomhangolta a küszöböt, az marad.
--   2. echo.app_secret — a jegy HMAC-kulcsa, ha hiányzik. Enélkül az
--      echo.ticket_key() NULL-t ad, és a jegykiadás hasal el.
--   3. echo.attendance_band — a 16-os nyolc és a 18b négy sávja. Az
--      echo.attendance_low() FAIL-CLOSED: ami nincs a szótárban, az
--      ALACSONY óralátogatásnak számít, és kiesik a jegyzőkönyvi
--      főstatisztikából. Üres szótár = minden válasz kiesik, csendben.
--      FIGYELEM: a 18b sávjai GONDOLATJELET (U+2013) használnak, nem ASCII
--      mínuszt. Betű szerint kell egyezniük a kérdőív opcióinak value
--      mezőjével, különben a szótár nem talál rájuk.
--   4. Önellenőrzés: kimondja, mi hiányzott, és hibát dob, ha az
--      eligibility két küszöbe a pótlás után sincs meg.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt).
-- Idempotens — biztonságosan újrafuttatható. Meglévő értéket nem ír felül.
-- ============================================================

-- A gen_random_bytes a pgcrypto-ból jön, az pedig a Supabase-en az
-- 'extensions' sémában él. A fájl felső szintjén (nem függvényen belül) a
-- session search_path dönt, ezért itt is kimondjuk — ugyanúgy, ahogy a
-- 15_echo_core.sql:202 teszi.
set search_path = echo, public, extensions, pg_temp;

-- ---------- 1. küszöbértékek ----------
insert into echo.setting (key, value, description) values
  ('min_headcount', '3',
   'A veleményezhetőség alsó létszámküszöbe. Ez alatt a kurzus kimarad, mert '
   'a valaszok tartalma onmagaban azonositana a kitoltot.'),
  ('min_share_pct', '25',
   'Az oktatoi oraarany alsó kuszobe szazalekban. Ez alatt az oktato–kurzus '
   'par kimarad, mert a hallgatonak nincs eleg tapasztalata rola.'),
  ('ticket_ttl_minutes', '90',
   'A kiadott jegy ervenyessegi ideje percben.'),
  ('max_tickets_per_course', '2',
   'Egy hallgato egy kurzuson legfeljebb ennyi jegyet kaphat.'),
  ('k_numeric', '5',
   'K-anonimitasi kuszob a szamszeru bontasra. Also korlat: 5.'),
  ('k_dist', '10',
   'Az eloszlas (cellankenti bontas) kuszobe. Also korlat: 10.'),
  ('k_text', '10',
   'A szabadszoveges valaszok kuszobe. Also korlat: 10.'),
  ('cond_context_keys', 'has_goals,attendance_band,lang',
   'A megjelenitesi felteteben (cond) hasznalhato KORNYEZETI kulcsok.'),
  ('draft_ttl_days', '14',
   'A kitoltesi piszkozat elettartama napokban, a legutobbi mentestol szamitva.'),
  ('comment_window_days', '7',
   'Az eszrevetelezesi ablak hossza napokban.'),
  ('comment_recipient_chain', 'TANSZEKVEZETO,DEKAN,MIR',
   'Az eszrevetel cimzetti lanca.')
on conflict (key) do nothing;

-- ---------- 2. a jegy aláíró kulcsa ----------
insert into echo.app_secret (key, secret)
select 'ticket_hmac', gen_random_bytes(32)
where not exists (select 1 from echo.app_secret where key = 'ticket_hmac');

-- ---------- 3. óralátogatási sávok ----------
insert into echo.attendance_band (code, name_hu, name_en, low, sort_order) values
  ('0-25%',    '0-25%',    '0-25%',    true,  10),
  ('26-50%',   '26-50%',   '26-50%',   false, 20),
  ('51-75%',   '51-75%',   '51-75%',   false, 30),
  ('76-100%',  '76-100%',  '76-100%',  false, 40),
  ('0-33%',    '0-33%',    '0-33%',    true,  11),
  ('<33%',     '33% alatt','below 33%',true,  12),
  ('33% alatt','33% alatt','below 33%',true,  13),
  ('nem jart', 'Nem jart orara','Did not attend', true, 14),
  ('0–32%',    '0–32%',    '0–32%',    true,  15),
  ('33–59%',   '33–59%',   '33–59%',   false, 25),
  ('60–84%',   '60–84%',   '60–84%',   false, 35),
  ('85–100%',  '85–100%',  '85–100%',  false, 45)
on conflict (code) do nothing;

-- ---------- 4. önellenőrzés ----------
do $blk$
declare
  v_head  text := (select value from echo.setting where key = 'min_headcount');
  v_share text := (select value from echo.setting where key = 'min_share_pct');
  v_key   boolean := exists (select 1 from echo.app_secret where key = 'ticket_hmac');
  v_band  integer := (select count(*)::integer from echo.attendance_band);
begin
  -- Ez a ketto nem lehet NULL: az eligibility_rebuild minden osszehasonlitasa
  -- rajuk epul, es NULL kuszobbel a jogosultsagi lista csendben ures marad.
  if v_head is null or v_share is null then
    raise exception 'ECHO: hianyzo kuszob a setting tablaban (min_headcount=%, min_share_pct=%).',
      coalesce(v_head, 'NINCS'), coalesce(v_share, 'NINCS');
  end if;
  if not v_key then
    raise exception 'ECHO: nincs jegy-alairo kulcs (app_secret.ticket_hmac).';
  end if;

  raise notice 'Rendben: min_headcount=%, min_share_pct=%, jegykulcs megvan, % oralatogatasi sav.',
    v_head, v_share, v_band;
end $blk$;
