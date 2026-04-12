FROM node:18-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ bash git curl

COPY package*.json ./
RUN rm -f package-lock.json && npm install --legacy-peer-deps --ignore-scripts

COPY . .

RUN npm run build || true

FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

RUN apk add --no-cache bash curl

COPY --from=builder /app /app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

CMD ["node", "index.js"]
