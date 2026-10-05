FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

WORKDIR /workspace
ENV NODE_ENV=production

# The control loop is a repository scanner, so its image intentionally contains
# the reviewed source/documentation snapshot. services/control-loop/Dockerfile.dockerignore
# excludes build products, credentials and local-only artifacts without weakening
# the much smaller API container context.
COPY --chown=node:node . .

# The job only runs `node services/control-loop/cli.ts`; drop the unused npm/npx/corepack
# CLIs bundled in the base image and their dependency CVEs (#236).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

USER node
ENTRYPOINT ["node", "services/control-loop/cli.ts"]
CMD ["--mode", "daily"]
