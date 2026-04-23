FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/whatsapp-agent/package.json apps/whatsapp-agent/package.json
COPY apps/whatsapp-agent/tsconfig.json apps/whatsapp-agent/tsconfig.json
COPY apps/whatsapp-agent/tsconfig.build.json apps/whatsapp-agent/tsconfig.build.json

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.base.json
COPY apps/whatsapp-agent/src apps/whatsapp-agent/src

RUN pnpm --filter @dublin/whatsapp-agent build
RUN pnpm --filter @dublin/whatsapp-agent deploy --prod /prod/whatsapp-agent

FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libuuid1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /prod/whatsapp-agent ./

CMD ["node", "dist/bootstrap.js", "start"]
