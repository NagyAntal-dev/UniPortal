# syntax=docker/dockerfile:1
# A Keycloak-beállító (provision.sh) futtatókörnyezete: curl + jq.
# A szkriptet és a sablonokat a deploy/compose.keycloak.yml csak olvasásra
# csatolja — nincs másolat, ami elavulhatna (mint a migrate-nél).
FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl jq
USER 65534:65534
ENTRYPOINT ["/bin/sh", "/uniportal/bin/provision.sh"]
