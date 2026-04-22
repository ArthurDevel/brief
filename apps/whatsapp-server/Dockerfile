FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/whatsapp-server/package.json apps/whatsapp-server/package.json
COPY apps/whatsapp-server/tsconfig.json apps/whatsapp-server/tsconfig.json
COPY apps/whatsapp-server/tsconfig.build.json apps/whatsapp-server/tsconfig.build.json
COPY packages/whatsapp-core/package.json packages/whatsapp-core/package.json

RUN pnpm install --frozen-lockfile

COPY apps/whatsapp-server/src apps/whatsapp-server/src
COPY packages/whatsapp-core/src packages/whatsapp-core/src

RUN pnpm --filter @dublin/whatsapp-server build

FROM node:22-bookworm-slim AS runner

WORKDIR /app/apps/whatsapp-server

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/whatsapp-server/package.json /app/apps/whatsapp-server/package.json
COPY --from=builder /app/apps/whatsapp-server/node_modules /app/apps/whatsapp-server/node_modules
COPY --from=builder /app/apps/whatsapp-server/dist /app/apps/whatsapp-server/dist
COPY --from=builder /app/packages/whatsapp-core /app/packages/whatsapp-core

CMD ["node_modules/.bin/tsx", "dist/server.js"]
