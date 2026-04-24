FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/whatsapp-agent/package.json apps/whatsapp-agent/package.json
COPY apps/whatsapp-agent/tsconfig.json apps/whatsapp-agent/tsconfig.json
COPY apps/whatsapp-agent/tsconfig.build.json apps/whatsapp-agent/tsconfig.build.json
COPY packages/whatsapp-core/package.json packages/whatsapp-core/package.json

RUN pnpm install --frozen-lockfile

COPY apps/whatsapp-agent/src apps/whatsapp-agent/src
COPY packages/whatsapp-core/src packages/whatsapp-core/src

RUN pnpm --filter @dublin/whatsapp-agent build

FROM node:22-bookworm-slim AS runner

WORKDIR /app/apps/whatsapp-agent

RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libuuid1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/whatsapp-agent/package.json /app/apps/whatsapp-agent/package.json
COPY --from=builder /app/apps/whatsapp-agent/node_modules /app/apps/whatsapp-agent/node_modules
COPY --from=builder /app/apps/whatsapp-agent/dist /app/apps/whatsapp-agent/dist
COPY --from=builder /app/packages/whatsapp-core /app/packages/whatsapp-core

CMD ["node_modules/.bin/tsx", "dist/bootstrap.js", "start"]
