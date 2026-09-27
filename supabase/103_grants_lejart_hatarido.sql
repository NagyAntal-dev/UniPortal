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
