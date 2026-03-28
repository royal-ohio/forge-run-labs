FROM node:20-alpine AS deps

RUN npm install -g pnpm@latest

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/forgerun-labs/package.json ./artifacts/forgerun-labs/
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/
COPY lib/ ./lib/
COPY scripts/package.json ./scripts/

RUN pnpm install --frozen-lockfile


FROM deps AS frontend

COPY artifacts/forgerun-labs/ ./artifacts/forgerun-labs/

ENV NODE_ENV=production
ENV BASE_PATH=/
ENV PORT=8080

RUN pnpm --filter @workspace/api-spec run codegen
RUN pnpm --filter @workspace/forgerun-labs run build


FROM deps AS api

COPY artifacts/api-server/ ./artifacts/api-server/

RUN pnpm --filter @workspace/api-server run build


FROM node:20-alpine AS production

WORKDIR /app

COPY --from=api /app/artifacts/api-server/dist/ ./dist/
COPY --from=frontend /app/artifacts/forgerun-labs/dist/public/ ./dist/public/

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.mjs"]
