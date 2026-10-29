FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV MEDIASOUP_WORKER_BIN=/bin/true

RUN corepack enable

WORKDIR /app

# Copy root workspace configs and lockfile
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/theme.css packages/ui/theme.ts ./packages/ui/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @yumi/shared... --filter @yumi/server...

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY apps/server ./apps/server

WORKDIR /app/apps/server

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["pnpm", "start"]
