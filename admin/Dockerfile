# syntax=docker/dockerfile:1
# Near Service — admin panel (Next.js, output: "standalone").
#
# BUILD CONTEXT IS admin/:
#   docker build -t near-service-admin ./admin
#   docker compose up --build          (compose sets this context)
#
# The admin listens on ONE port everywhere: 3001 (package.json
# "start": "next start -p 3001", compose host+container 3001:3001,
# K8s containerPort/Service 3001, Ingress service port 3001).
# The standalone server reads PORT at runtime; the image defaults it
# to 3001 below. NEXT_PUBLIC_API_URL is baked in at BUILD time (it is
# inlined into the client bundle), so pass it as a build arg:
#   docker build --build-arg NEXT_PUBLIC_API_URL=https://api.nearservice.pk/api/v1 ./admin
#
# No secrets are baked in: NEXT_PUBLIC_API_URL is a public API base URL,
# not a secret. There are no admin secrets in this image.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:20-alpine AS runner
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S nextjs && adduser -S nextjs -G nextjs
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
# NOTE: admin/ has no public/ directory, so there is no static asset
# copy here. If a public/ directory is added later, also copy it:
#   COPY --from=builder --chown=nextjs:nextjs /app/public ./public
USER nextjs
EXPOSE 3001
# Next.js has no dedicated health endpoint; / returns 200 when up.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://localhost:3001/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
