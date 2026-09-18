# Műveleti RBAC — helyi mérési jelentés

Dátum: 2026-09-18. Környezet: Node.js 22, PGlite a
`private-imports/validation` függőségeiből. Éles adatbázison nem futott mérés.

## Eredmény

| Ellenőrzés | Eredmény |
| --- | --- |
| 72: séma, seed, admin RPC-k, jóváhagyás, audit, menü és rollback | Sikeres |
| 72 újrafuttatása üresre állított ADMIN/feed sorral | Egyik elvett műveletet sem adja vissza |
| 73: 8 szerepkör × 22 tábla × 4 művelet × saját/idegen sor | 1408 eset, 0 eltérés az előtte/utána mátrixban |
| Képzési katalógus: 8 szerepkör × 3 írás | 24 eset, 0 eltérés |
| Restriktív policy-k | 49, 20 public táblán, csak authenticated; SELECT nincs |
| Eredeti 11-es permisszív policy-k a tesztsémában | Mind a 86 megmaradt |
| Egyenként elvett/visszaadott ADMIN művelet | Mind a 49 leképezésnél megtagadás, majd 1 érintett sor |
| `trainings` és `programs` szétválasztása | Képzési jog elvétele nem tiltja a rövid programokat |
| 73 újrafuttatása elvett joggal | A tiltás megmaradt |
| Vészkapcsoló és SUPERADMIN | A kapcsoló nyit/zár; a SUPERADMIN nincs kizárva |
| Önkiszolgáló permisszív szabály / hiányos backfill | A 73-as atomikusan megtagadja a telepítést |
| 75-ös rollback | Kétszer is lefut; az eredeti RLS-viselkedés visszaáll |
| 74/75: 26 RPC | Csak a beszúrt őrblokk változik; módosított őrnél teljes rollback; újratelepítés sikeres |
| Data-layer | 37 ellenőrzés: megtagadásból/hálózati hibából nem lesz helyi mentés |
| Jelentkezési munkafolyamat | Sikertelen mentés nem vált lépést és nem hívja a beadó RPC-t; siker és dobott RPC-hiba is ellenőrizve |
| Menü / PERM | 1872 menücella, 0 eltérés; PERM szerződés és hívóhelyek sikeresek |
| Frontend build | `npm run build` sikeres |

A szerepkörök: SUPERADMIN, ADMIN, ADMISSIONS, FINANCE, STUDENT, AGENT,
CUSTOM (saját szerepkör), valamint PENDING (jóváhagyás előtti STUDENT).
A nyers SQL próbák `SET LOCAL ROLE authenticated` alatt futnak, külön
tranzakciókban, mindig rollbackkel. Az `auth.uid()` tesztbeli implementációja
a tranzakcióhoz beállított profilazonosítót olvassa.

## A 73-as hatóköre

| Táblák | Új kapuk |
| --- | --- |
| users, agencies, campaigns, marketingCampaigns, scholarships, videoInterviewQuestions, integrations, webhooks, invoices, leads, feed_posts, programs, kb_documents | INSERT, UPDATE, DELETE |
| interviewSlots, students | INSERT, DELETE |
| payments | UPDATE, DELETE |
| process_messages, program_applications | DELETE |
| event_rsvps, ticket_claims | UPDATE |
| admission_processes, auditLogs | Nincs |

Az `admission_processes` DELETE szabálya tulajdonosi ágat is tartalmaz:
ezért a tábla teljesen kimarad. Az önkiszolgáló írások és az összes SELECT
változatlan. A `programs.level` bachelor/master/doctoral sorai `trainings`,
a többi `programs` jogot kérnek. Az UPDATE a régi és új sorra is ellenőriz.
A `FINANCE/feed:EDIT` backfill a már létező RSVP/jegy UPDATE jogot őrzi meg;
a hírfolyamposztok szerkesztését továbbra is az eredeti permisszív kapu korlátozza.

## Reprodukálás

```sh
node tools/perm_regresszio.mjs
node tools/menu_regresszio.mjs
node tools/data_layer_regresszio.mjs
node tools/program_save_regresszio.mjs
node supabase/diagnostics/73_pglite_ellenorzes.mjs
node supabase/diagnostics/74_pglite_ellenorzes.mjs
npm run build
```

A 73-as teszt importálja és lefuttatja a 72-es ellenőrzést is. A PGlite nincs
a frontend függőségei között; a teszt a gyökérből vagy a meglévő
`private-imports/validation/node_modules` alól keresi.

## A mérés korlátai és a következő ellenőrzés

Ez **policy-integrációs teszt**, nem teljes Supabase-replika. A 11-es tényleges
predikátumait és policy-it használja, de az üzleti táblák minimális tesztsorokkal
szerepelnek. Nem tölti be az összes üzleti triggert, idegen kulcsot, későbbi
ügynökségi izolációs szabályt vagy célközönség-szűrést. A 74-es teszt csonk
rowtype-okkal, `check_function_bodies=off` mellett ellenőrzi a telepítést és a
rollbacket; nem bizonyítja mind a 26 RPC üzleti végrehajtását.

A teljes sémájú helyi replika, a cél Supabase/PostgREST, a böngészős
szerepkörváltás és mátrixszerkesztés, valamint a `reset-data.sh` előnézet és
`make-superadmin.sh` integráció még nyitott a TODO-ban. Saját szerepkörnek
adott moduljog önmagában nem bővíti az eredeti szerepkör-alapú RLS/RPC kapukat.
