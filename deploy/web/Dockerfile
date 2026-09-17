# syntax=docker/dockerfile:1
# ============================================================================
# UniPortal web
#   1. fázis: a felület csomagolása (esbuild) — ugyanaz, mint a `npm run build`
#   2. fázis: jogosultság nélküli nginx a statikus fájlokkal és az API-továbbítással
# ============================================================================
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY build.mjs app.jsx app.html ./
COPY features ./features
# Létrehozza az app.bundle.js-t, és az app.html-be beírja a bundle verziójelét.
RUN node build.mjs

FROM nginxinc/nginx-unprivileged:1.27-alpine
USER root
RUN rm -rf /usr/share/nginx/html/*
COPY index.html reset-password.html privacy.html terms.html config.js favicon.svg nje-logo.svg /usr/share/nginx/html/
# Országzászlók az országválasztóhoz (features/countries.jsx).
COPY assets/ /usr/share/nginx/html/assets/
COPY --from=build /src/app.html /src/app.bundle.js /usr/share/nginx/html/
# Az auth szolgáltatás innen tölti le a jelszó-visszaállító levél sablonját.
COPY deploy/web/email/ /usr/share/nginx/html/email/
COPY deploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/web/headers.conf deploy/web/proxy.conf /etc/nginx/uniportal/
COPY --chmod=755 deploy/web/10-uniportal-defaults.envsh /docker-entrypoint.d/10-uniportal-defaults.envsh
COPY --chmod=755 deploy/web/40-uniportal-config.sh   /docker-entrypoint.d/40-uniportal-config.sh
# A config.js-t és a realip.conf-ot induláskor a nem-root nginx felhasználó írja.
RUN chown -R 101:0 /usr/share/nginx/html /etc/nginx/uniportal \
 && chmod -R g+w /usr/share/nginx/html /etc/nginx/uniportal
USER 101
ENV API_GW_UPSTREAM=api-gw:8000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
