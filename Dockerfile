# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CORVIS_ENV=production CORVIS_DEMO_MODE=false
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs corvis
COPY --from=builder --chown=corvis:nodejs /app/.next ./.next
COPY --from=builder --chown=corvis:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=corvis:nodejs /app/package.json ./package.json
USER corvis
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["npm", "start"]
