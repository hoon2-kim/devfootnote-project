FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.4.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/queue/package.json ./packages/queue/package.json
COPY packages/ai/package.json ./packages/ai/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @devfootnote/api... build
RUN pnpm --filter @devfootnote/api deploy --legacy --prod /runtime

# 명시적으로 실행하는 migration 전용 target. 서버 기동과 연결하지 않는다.
FROM build AS migration
USER node
CMD ["node", "packages/db/scripts/migrate.mjs"]

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8000
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]
