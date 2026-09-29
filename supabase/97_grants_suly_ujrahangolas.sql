-- ============================================================
-- 97_grants_suly_ujrahangolas.sql — a téma döntsön, a méltányosság csak
--                                    döntetlennél
-- ============================================================
-- MIÉRT: a hét pontszám-komponensből NÉGY semmit nem tud a felhívásról
-- (tekintély, kapacitás, nyitottság, bevonás). A régi súlyokkal ezek együtt 36
-- pontot vittek a 83-ból, és a kilengésük nagyobb volt, mint a tartalomé:
--
--   komponens   súly   tipikus kilengés   hatás az összpontszámra
--   tartalom     40    ±1 szórás = 12,5   6,0 pont
--   bevonás      15    8 → 100 = 92       16,6 pont      ← ez dönt!
--   tekintély    12    50 → 96 = 46       6,6 pont
--
-- Vagyis egy soha fel nem kért, közepesen illeszkedő kolléga megelőzte a
-- témában erőset, aki már két pályázatban benne volt. A terv ezzel szemben azt
-- mondja: a méltányosság a ZÖREJEN BELÜL dönt, nem a kompetencia helyett.
--
-- AZ ÚJ SÚLYOK ÉS AZ ARITMETIKA (összeg 93):
--   tartalom 50  → 1 szórásnyi témakülönbség 6,7 pont
--   bevonás   6  → a teljes kilengés        5,9 pont   ≈ 1 szórásnyi téma
--   tekintély 8, kapacitás 6, nyitottság 3, frissesség 12, súlypont 8
--
-- Így a bevonás pontosan annyit mozdít, amennyi egy szórásnyi témakülönbség:
-- két hasonlóan illeszkedő jelölt közül a kevesebbet szerepeltet hozza előre,
-- de a témában lényegesen jobbat NEM előzi meg.
--
-- A BEVONÁS EZZEL NEM GYENGÜL — csak a helyére kerül. A csapatépítő továbbra is
-- fenntart egy helyet az újonnan bevonható kollégának, és a döntetlen-sávon
-- belül a kevesebbet szerepelt nyer (90_grants_teams.sql). A méltányosság ott
-- szerkezeti szabály, itt pedig rangsor-finomhangolás.
--
-- MIND A HÉT ÉRTÉK A BEÁLLÍTÁSOKBAN MARAD: az iroda bármikor átállíthatja, ha
-- más egyensúlyt akar. Ez a migráció csak az alapértelmezést hangolja.
--
-- Futtatás után: 21_echo_harden_submit.sql újra (a szokásos sorrend).
-- ============================================================

-- Csak az alapértelmezésen változtatunk: ha az iroda már kézzel átállította,
-- azt tiszteletben tartjuk (a where feltétel a régi alapértéket nézi).
update grants.setting set value = '50', updated_at = now()
 where key = 'pont_suly_tartalom'   and value = '40';
update grants.setting set value = '6',  updated_at = now()
 where key = 'pont_suly_bevonas'    and value = '15';
update grants.setting set value = '6',  updated_at = now()
 where key = 'pont_suly_kapacitas'  and value = '8';
update grants.setting set value = '3',  updated_at = now()
 where key = 'pont_suly_nyitottsag' and value = '5';

update grants.setting
   set description = 'A tartalmi hasonlóság súlya. Ez a legnagyobb: a téma döntsön.'
 where key = 'pont_suly_tartalom';
update grants.setting
   set description = 'A bevonási méltányosság súlya. Szándékosan akkora, hogy a teljes kilengése ~1 szórásnyi témakülönbséggel érjen fel: döntetlennél dönt, a kompetencia helyett nem.'
 where key = 'pont_suly_bevonas';

do $chk$
declare v_tart numeric; v_bev numeric; v_ossz numeric;
begin
  v_tart := grants.szam_beall('pont_suly_tartalom', 50);
  v_bev  := grants.szam_beall('pont_suly_bevonas', 6);
  v_ossz := v_tart + grants.szam_beall('pont_suly_frissesseg', 12)
          + grants.szam_beall('pont_suly_sulypont', 8) + grants.szam_beall('pont_suly_tekintely', 8)
          + grants.szam_beall('pont_suly_kapacitas', 6) + grants.szam_beall('pont_suly_nyitottsag', 3)
          + v_bev;
  -- A mérce: egy szórásnyi témakülönbség (12,5 pont tartalom) legalább annyit
  -- mozdítson, mint a bevonás TELJES kilengése (92 pont). Ha ez nem áll, a
  -- méltányosság újra elnyomná a szakmai illeszkedést.
  if (12.5 * v_tart / v_ossz) < (92 * v_bev / v_ossz) * 0.9 then
    raise exception 'ARANY HIBA: a bevonas tobbet mozdit, mint egy szorasnyi temakulonbseg (tartalom=%, bevonas=%).', v_tart, v_bev;
  end if;
  raise notice 'Rendben: 97 — 1 szorasnyi temakulonbseg % pont, a bevonas teljes kilengese % pont.',
    round(12.5 * v_tart / v_ossz, 1), round(92 * v_bev / v_ossz, 1);
end $chk$;
