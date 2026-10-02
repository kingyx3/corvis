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
# In-app help and support links (docs/SUPPORT.md); empty uses the documented defaults.
ARG NEXT_PUBLIC_CORVIS_SUPPORT_EMAIL=""
ARG NEXT_PUBLIC_CORVIS_SUPPORT_URL=""
ARG NEXT_PUBLIC_CORVIS_DOCS_URL=""
ARG NEXT_PUBLIC_CORVIS_STATUS_URL=""
ARG NEXT_PUBLIC_CORVIS_RELEASE_NOTES_URL=""
ENV NEXT_PUBLIC_CORVIS_API_BASE=$NEXT_PUBLIC_CORVIS_API_BASE
ENV NEXT_PUBLIC_CORVIS_DEMO_MODE=$NEXT_PUBLIC_CORVIS_DEMO_MODE
ENV NEXT_PUBLIC_CORVIS_SUPPORT_EMAIL=$NEXT_PUBLIC_CORVIS_SUPPORT_EMAIL
ENV NEXT_PUBLIC_CORVIS_SUPPORT_URL=$NEXT_PUBLIC_CORVIS_SUPPORT_URL
ENV NEXT_PUBLIC_CORVIS_DOCS_URL=$NEXT_PUBLIC_CORVIS_DOCS_URL
ENV NEXT_PUBLIC_CORVIS_STATUS_URL=$NEXT_PUBLIC_CORVIS_STATUS_URL
ENV NEXT_PUBLIC_CORVIS_RELEASE_NOTES_URL=$NEXT_PUBLIC_CORVIS_RELEASE_NOTES_URL
RUN npm run build

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# The runtime only runs `node server.js`. The npm/npx/corepack CLIs bundled in the
# base image are unused and carry their own dependency CVEs (#236), so remove them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && addgroup -S corvis && adduser -S corvis -G corvis
COPY --from=build --chown=corvis:corvis /app/.next/standalone ./
COPY --from=build --chown=corvis:corvis /app/.next/static ./.next/static
USER corvis
EXPOSE 3000
CMD ["node", "server.js"]
