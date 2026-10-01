# The server runs from source via `tsx`. The image therefore carries the
# workspace's dev dependencies — a deliberate trade-off (deployment design §11):
# no build step, at the cost of image size. Postgres is a separate service.
FROM node:24-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so the (slow) install layer caches across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/test-support/package.json packages/test-support/package.json
RUN pnpm install --frozen-lockfile --filter @adt/server...

# Only what the server needs at runtime.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/test-support packages/test-support

EXPOSE 8080
CMD ["pnpm", "-C", "packages/server", "exec", "tsx", "src/index.ts"]
