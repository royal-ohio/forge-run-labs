FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ bash git

COPY package*.json ./
RUN npm ci --ignore-scripts || npm install --legacy-peer-deps

COPY . .

RUN npm run build || true

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

RUN apk add --no-cache bash

COPY --from=builder /app /app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

CMD ["node", "index.js"]
