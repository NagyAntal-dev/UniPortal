-- ============================================================
-- UniPortal Pro — Tárolók: méret- és típuskorlát minden bucketen
--
-- MIÉRT:
--   A feltöltött fájl MIME-típusát eddig a KLIENS mondta meg
--   (`upload(..., { contentType: f.type })`), a tárolók pedig nem szűrtek:
--
--     avatars      publikus, NINCS méretkorlát, NINCS típusszűrő
--     dorm-photos  privát,   NINCS méretkorlát, NINCS típusszűrő
--     documents    privát,   20 MB,             NINCS típusszűrő
--
--   A Docker-telepítésben a /storage/v1/ ugyanarról a címről szolgál ki, mint
--   a felület (deploy/web/default.conf.template), tehát egy text/html típusú
--   feltöltés AZONOS ORIGINRŐL futó JavaScript. Az pedig kiolvassa a
--   localStorage-ból a Supabase-munkamenetet: aki megnyitja a linket, annak a
--   fiókja elveszett. Az X-Content-Type-Options: nosniff itt NEM véd, mert a
--   típus nem találgatott, hanem DEKLARÁLT.
--
--   Az avatars ráadásul publikus és `for select to public`, a fájlnév-
--   konvenció pedig `<auth.uid()>/…` — vagyis bejelentkezés nélkül
--   kilistázható róla minden felhasználó UUID-ja, ami az egész RLS-modell
--   kulcsa.
--
--   Ez a migráció a tároló OLDALÁN zárja le a kérdést, tehát akkor is véd, ha
--   a kliens megkerüli a felületet és közvetlenül a Storage API-t hívja.
--   A kliensoldali szűrés (app.jsx, features/messages.jsx) csak kényelem:
--   hogy a felhasználó azonnali, érthető hibaüzenetet kapjon.
--
-- MEGJEGYZÉS az avatars publikusságáról:
--   A bucket EGYELŐRE publikus marad, mert a felület minden avatárt
--   getPublicUrl()-lel jelenít meg. A privátra váltás + aláírt URL külön
--   feladat (minden avatár-megjelenítést érint), és a típus- meg méretkorlát
--   nélküle is megszünteti a tényleges kockázatot: képet nem lehet futtatni.
--   Az SVG SZÁNDÉKOSAN nincs az engedélyezett listán: a böngésző az SVG-t
--   dokumentumként értelmezi, és script futhat benne.
--
-- FUTTATÁS: a migrate szolgáltatás automatikusan (deploy/migrate/manifest.txt),
--   vagy: Supabase dashboard → SQL Editor → New query → beilleszt → Run
-- Idempotens — biztonságosan újrafuttatható.
-- ============================================================

-- ---------- 1. avatars: 2 MB, csak raszteres kép ----------
do $blk$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', true, 2097152,
          array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  on conflict (id) do update
     set file_size_limit   = excluded.file_size_limit,
         allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise warning 'Az avatars tarolo korlatai nem allithatok (%). Allitsd be kezzel: Storage -> avatars -> Settings.', sqlerrm;
end $blk$;

-- ---------- 2. dorm-photos: 5 MB, csak raszteres kép ----------
do $blk$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('dorm-photos', 'dorm-photos', false, 5242880,
          array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  on conflict (id) do update
     set public             = false,
         file_size_limit    = excluded.file_size_limit,
         allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise warning 'A dorm-photos tarolo korlatai nem allithatok (%).', sqlerrm;
end $blk$;

-- ---------- 3. documents: marad a 20 MB, de típusszűrővel ----------
-- Ide jelentkezői dokumentumok (útlevél, bizonyítvány) és a felvételi
-- beszélgetés csatolmányai kerülnek: PDF, kép, és a szokásos irodai formátumok.
do $blk$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('documents', 'documents', false, 20971520,
          array['application/pdf',
                'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/tiff',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'text/plain',
                -- Az ismeretlen típusú feltöltés ide esik: a böngésző LETÖLTI,
                -- sosem jeleníti meg, tehát scriptet nem futtathat. Így egy
                -- szokatlan, de jogos fájl sem akad el.
                'application/octet-stream'])
  on conflict (id) do update
     set public             = false,
         file_size_limit    = excluded.file_size_limit,
         allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise warning 'A documents tarolo korlatai nem allithatok (%).', sqlerrm;
end $blk$;

-- ---------- 4. ellenőrzés ----------
do $blk$
declare
  b record;
  hiany text := '';
begin
  for b in
    select id, public, file_size_limit, allowed_mime_types
      from storage.buckets
     where id in ('avatars', 'dorm-photos', 'documents', 'interview-recordings')
  loop
    if b.file_size_limit is null then
      hiany := hiany || b.id || ' (nincs meretkorlat) ';
    end if;
    if b.allowed_mime_types is null or array_length(b.allowed_mime_types, 1) is null then
      hiany := hiany || b.id || ' (nincs tipusszuro) ';
    end if;
    if b.allowed_mime_types is not null and 'image/svg+xml' = any (b.allowed_mime_types) then
      raise exception 'BIZTONSAGI HIBA: a(z) % tarolo engedi az SVG-t (scriptet futtathat).', b.id;
    end if;
  end loop;

  if hiany <> '' then
    raise warning 'FIGYELEM: korlat nelkuli tarolo(k): %', hiany;
  else
    raise notice 'Rendben: minden tarolonak van meret- es tipuskorlatja.';
  end if;
end $blk$;

select id, public, file_size_limit, allowed_mime_types
  from storage.buckets
 where id in ('avatars', 'dorm-photos', 'documents', 'interview-recordings')
 order by id;
