# syntax=docker/dockerfile:1
# ============================================================================
# UniPortal SAML SP — az NJE IdP-vel beszélő bejelentkezési szolgáltatás.
# Kifelé nem nyit portot: a web (nginx) továbbítja rá a /saml/ útvonalat.
# ============================================================================
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/saml/healthz >/dev/null || exit 1
CMD ["node", "src/index.js"]
