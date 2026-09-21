-- ============================================================
-- UniPortal Pro — ECHO: a kizárási szabálytár (echo.exclusion_rule) pótlása
--
-- MIÉRT:
--   Az echo.exclusion_log.rule_code idegen kulccsal hivatkozik az
--   echo.exclusion_rule(code) sorokra. A szabálysorokat EGYETLEN helyen
--   vetettük el: a 15_echo_core.sql fájlban, egyszeri INSERT-tel. Ha az
--   adatbázis a nyilvántartás (uniportal_meta.migrations) nélkül került a
--   gépre — visszaállított mentés, vagy a SQL Editorban kézzel futtatott
--   részletek —, akkor a migrációs futtató "baseline" módba lép, és a
--   15_echo_core.sql-t lefutottnak jelöli ANÉLKÜL, hogy lefuttatná
--   (deploy/migrate/run.sh). A táblák ilyenkor létrejöhettek kézzel, de a
--   szabálysorok kimaradtak. Ugyanez a helyzet, ha valaki a sorokat utóbb
--   kitörölte.
--
--   A tünet: kampány létrehozásakor / kérdőív hozzárendelésekor lefut az
--   echo.eligibility_rebuild (42_campaign_editor.sql), amely a kizárásokat
--   naplózni akarja, és elhasal:
--     insert or update on table "exclusion_log" violates foreign key
--     constraint "exclusion_log_rule_code_fkey"
--
-- MIT CSINÁL:
--   1. Létrehozza a szabálytáblát, ha hiányzik (a 15-össel azonos alakban).
--   2. Pótolja az öt szabálysort — a meglévő sorok szövegéhez NEM nyúl
--      (on conflict do nothing), mert a §-hivatkozás ADAT: ha valaki már
--      pontosította, nem írjuk vissza a becslésre.
--   3. Ellenőrzi, hogy az eligibility_rebuild által használt mind az öt kód
--      megvan-e, és hibát dob, ha nem.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt).
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. a szabálytábla (a 15_echo_core.sql-lel azonos) ----------
create table if not exists echo.exclusion_rule (
  code          text primary key,
  name_hu       text not null,
  name_en       text,
  -- BECSLÉS: a 28/2023. szenátusi határozat szövege nem áll rendelkezésre,
  -- a paragrafusszámok pontosítandók. ADAT, nem kód — egy UPDATE javítja.
  paragraph_ref text not null,
  description_hu text,
  scope         text not null default 'course' check (scope in ('course','pair'))
);

-- ---------- 2. a hiányzó szabálysorok pótlása ----------
insert into echo.exclusion_rule (code, name_hu, name_en, paragraph_ref, description_hu, scope) values
  ('LETSZAM_ALATT',
   'Létszám a küszöb alatt', 'Headcount below threshold',
   '28/2023. (PONTOSÍTANDÓ) §',                                   -- BECSLÉS
   'A kurzusra felvett hallgatók száma nem éri el a beállított küszöböt '
   '(echo.setting.min_headcount). Ilyen kis csoportban a válasz tartalma '
   'önmagában azonosítaná a kitöltőt, ezért a kurzus nem véleményezhető.',
   'course'),
  ('NINCS_ORARENDI_INFO',
   'Nincs órarendi információ', 'No timetable information',
   '28/2023. (PONTOSÍTANDÓ) §',                                   -- BECSLÉS
   'A kurzushoz nem tartozik órarendi információ (nincs kontaktóra), ezért '
   'nincs mit véleményezni.',
   'course'),
  ('VIZSGAKURZUS',
   'Vizsgakurzus', 'Exam-only course',
   '28/2023. (PONTOSÍTANDÓ) §',                                   -- BECSLÉS
   'A vizsgakurzuson nincs oktatási tevékenység, csak számonkérés.',
   'course'),
  ('OKTATOI_ARANY_ALATT',
   'Oktatói óraarány a küszöb alatt', 'Teacher share below threshold',
   '28/2023. (PONTOSÍTANDÓ) §',                                   -- BECSLÉS
   'Az oktató a kurzus óráinak kevesebb mint a beállított hányadát tartotta '
   '(echo.setting.min_share_pct), ezért a hallgatónak nincs elegendő '
   'tapasztalata a munkájáról.',
   'pair'),
  ('NINCS_OKTATO',
   'Nincs rögzített oktató', 'No teacher assigned',
   '28/2023. (PONTOSÍTANDÓ) §',                                   -- BECSLÉS
   'A kurzushoz egyetlen oktató sincs rögzítve, így oktatói értékelés nem '
   'képezhető.',
   'course')
on conflict (code) do nothing;

-- ---------- 3. önellenőrzés ----------
-- Ugyanaz az öt kód, amit az echo.eligibility_rebuild beír a naplóba. Ha
-- bármelyik hiányzik, a kampány alkalmassági építése idegenkulcs-hibával áll
-- meg — jobb itt, a migrációban elhasalni, mint a felhasználó képernyőjén.
do $blk$
declare
  v_kell   text[] := array['LETSZAM_ALATT','NINCS_ORARENDI_INFO','VIZSGAKURZUS',
                           'OKTATOI_ARANY_ALATT','NINCS_OKTATO'];
  v_hiany  text;
  v_potolt integer;
begin
  select string_agg(k, ', ' order by k) into v_hiany
    from unnest(v_kell) as k
   where not exists (select 1 from echo.exclusion_rule r where r.code = k);

  if v_hiany is not null then
    raise exception 'ECHO: hianyzo kizarasi szabalyok: %', v_hiany;
  end if;

  select count(*)::integer into v_potolt from echo.exclusion_rule;
  raise notice 'Rendben: a kizarasi szabalytar teljes (% sor).', v_potolt;
end $blk$;
