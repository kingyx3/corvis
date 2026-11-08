FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
RUN addgroup -S corvis && adduser -S corvis -G corvis
COPY --chown=corvis:corvis services/extractor/server.mjs /app/server.mjs
USER corvis
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
