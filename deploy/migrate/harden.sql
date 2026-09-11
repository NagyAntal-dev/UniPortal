-- ============================================================================
-- UniPortal — éles védelem, a migrációk UTÁN minden induláskor lefut.
--
-- A 02_auth_profiles.sql öt DEMÓ fiókot hoz létre NYILVÁNOSAN ismert jelszóval
-- (Demo1234! — a nyilvános git-tárolóban bárki elolvashatja):
--   admin@uni.hu (ADMIN), admissions@uni.hu, finance@uni.hu,
--   agent@globalstudy.com, ammar@test.com
-- Éles szerveren ezekkel bárki belépne. Ez a lépés azokat zárja le, amelyeknél
-- MÉG a demó jelszó érvényes: a jelszót véletlenre cseréli, és a fiókot tiltja.
--
-- Idempotens. Ha egy demó fiók később saját jelszót kap (és feloldják), nem
-- nyúl hozzá. Kikapcsolás CSAK bemutató szerveren: UNIPORTAL_DEMO_ACCOUNTS=keep
-- A felhős Supabase-projekten is lefuttatható (SQL Editor).
-- ============================================================================
set search_path = public, extensions;

do $$
declare
  n int;
begin
  update auth.users
     set encrypted_password = crypt(encode(gen_random_bytes(32), 'hex'), gen_salt('bf')),
         banned_until       = '2999-12-31 00:00:00+00',
         updated_at         = now()
   where lower(email) in ('admin@uni.hu', 'admissions@uni.hu', 'finance@uni.hu',
                          'agent@globalstudy.com', 'ammar@test.com')
     and case when encrypted_password like '$2%'
              then encrypted_password = crypt('Demo1234!', encrypted_password)
              else false end;
  get diagnostics n = row_count;
  if n > 0 then
    raise notice 'Lezárva: % demó fiók (a nyilvános Demo1234! jelszóval).', n;
  end if;
end $$;
