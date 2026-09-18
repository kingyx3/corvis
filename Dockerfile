FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts

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
RUN addgroup -S corvis && adduser -S corvis -G corvis
COPY --from=build --chown=corvis:corvis /app/package.json ./package.json
COPY --from=build --chown=corvis:corvis /app/node_modules ./node_modules
COPY --from=build --chown=corvis:corvis /app/.next ./.next
COPY --from=build --chown=corvis:corvis /app/next.config.ts ./next.config.ts
USER corvis
EXPOSE 3000
CMD ["npm", "start"]
