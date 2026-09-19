FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_CORVIS_API_BASE=""
ARG NEXT_PUBLIC_CORVIS_DEMO_MODE="false"
ENV NEXT_PUBLIC_CORVIS_API_BASE=$NEXT_PUBLIC_CORVIS_API_BASE
ENV NEXT_PUBLIC_CORVIS_DEMO_MODE=$NEXT_PUBLIC_CORVIS_DEMO_MODE
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup -S corvis && adduser -S corvis -G corvis
COPY --from=build --chown=corvis:corvis /app/.next/standalone ./
COPY --from=build --chown=corvis:corvis /app/.next/static ./.next/static
USER corvis
EXPOSE 3000
CMD ["node", "server.js"]
