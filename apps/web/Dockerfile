FROM node:22-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/theme.css packages/ui/theme.ts ./packages/ui/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile --filter @yumi/shared... --filter @yumi/web...

COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY apps/web ./apps/web

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

RUN pnpm --filter @yumi/web build

FROM nginx:alpine
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
