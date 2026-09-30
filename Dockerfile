# Base images are pinned by digest; Dependabot (docker ecosystem) proposes updates.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts stay off, as in CI deploy jobs: no dependency needs one to
# build, and it keeps third-party code from running at image build time (#236).
RUN npm ci --ignore-scripts

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_CORVIS_API_BASE=""
ARG NEXT_PUBLIC_CORVIS_DEMO_MODE="false"
ENV NEXT_PUBLIC_CORVIS_API_BASE=$NEXT_PUBLIC_CORVIS_API_BASE
ENV NEXT_PUBLIC_CORVIS_DEMO_MODE=$NEXT_PUBLIC_CORVIS_DEMO_MODE
RUN npm run build

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runtime
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
