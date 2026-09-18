# syntax=docker/dockerfile:1
# ============================================================================
# UniPortal Keycloak — SAML-közvetítő (broker) az NJE IdP és a Supabase Auth
# között. Részletek: docs/keycloak-saml.md
#
# A Keycloak ajánlott éles módja: a build-idejű beállítások (adatbázis-típus,
# health, relatív útvonal) a képbe fordítva, indításkor `start --optimized`.
# A futásidejű beállítások (hostname, adatbázis címe és jelszava, admin) a
# deploy/compose.keycloak.yml-ből, a .env alapján jönnek — a képben NINCS titok.
# ============================================================================
ARG KEYCLOAK_VERSION=26.7.4

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=false \
    KC_HTTP_RELATIVE_PATH=/keycloak
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
