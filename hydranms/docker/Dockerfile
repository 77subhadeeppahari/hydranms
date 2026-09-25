FROM node:22-bookworm-slim AS workspace-build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run typecheck:libs
RUN pnpm --filter @workspace/api-server run build
RUN PORT=8081 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/hydranms run build

FROM node:22-bookworm-slim AS api

ENV NODE_ENV=production
WORKDIR /workspace

COPY --from=workspace-build /workspace/node_modules ./node_modules
COPY --from=workspace-build /workspace/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=workspace-build /workspace/artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY --from=workspace-build /workspace/artifacts/api-server/dist ./artifacts/api-server/dist

USER node

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]

FROM nginxinc/nginx-unprivileged:stable-alpine AS web

COPY --from=workspace-build /workspace/artifacts/hydranms/dist/public /usr/share/nginx/html
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf