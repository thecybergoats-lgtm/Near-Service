# syntax=docker/dockerfile:1
# Near Service — backend API (NestJS).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (not backend/):
#   docker build -f backend/Dockerfile .
#   docker compose up --build          (compose sets this context)
#
# Reason: dist/scripts/migrate.js resolves the migrations as
# ../../../db relative to dist/ (backend/dist/scripts -> repo-root db/),
# so the image needs /app/db alongside /app/backend/dist. A backend/-only
# context cannot COPY ../db, so the root context is required.
#
# Layout inside the image:
#   /app/backend/dist   compiled NestJS (node backend/dist/main.js)
#   /app/backend/node_modules   production deps only (npm ci --omit=dev)
#   /app/db             migrations + seed (read by migrate.js)
#   /app/backend/uploads  runtime upload dir (empty in the image)
#
# No secrets are baked in: every secret comes from the environment at
# runtime (compose / K8s Secret / Secrets Manager). See README.md
# "Production environment variables".
FROM node:20-alpine AS builder
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY backend/package.json backend/package-lock.json ./backend/
WORKDIR /app/backend
RUN npm ci --omit=dev && npm cache clean --force
WORKDIR /app
COPY --from=builder /app/backend/dist ./backend/dist
COPY db ./db
RUN mkdir -p backend/uploads && chown -R app:app /app
USER app
EXPOSE 3000
# Node's fetch (no curl/wget in alpine) against the liveness endpoint.
# /ready is the stricter probe (Postgres + Redis); compose/K8s use /ready
# for readiness and /health for liveness — see docker-compose.yml.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/main.js"]
