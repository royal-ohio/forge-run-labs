#!/bin/bash
# RealityOS Entrypoint — runs the adapter alongside the main app
# The adapter connects to Brain Hub for fleet coordination

set -e

export PORT=${PORT:-8080}
APP_PORT=${APP_PORT:-8081}

cleanup() {
  echo "[entrypoint] Shutting down..."
  kill $ADAPTER_PID 2>/dev/null || true
  kill $APP_PID 2>/dev/null || true
  wait
  exit 0
}
trap cleanup SIGTERM SIGINT

echo "[entrypoint] Starting Reality Adapter v2.0 on port $PORT..."
cd /app
BRAIN_HUB_URL=${BRAIN_HUB_URL:-https://realityos-node-a.fly.dev} \
npx tsx /app/reality-adapter/adapter.ts &
ADAPTER_PID=$!

sleep 2

if [ -f /app/dist/index.cjs ]; then
  echo "[entrypoint] Starting app on port $APP_PORT..."
  PORT=$APP_PORT node /app/dist/index.cjs &
  APP_PID=$!
elif [ -f /app/dist/index.mjs ]; then
  PORT=$APP_PORT node /app/dist/index.mjs &
  APP_PID=$!
elif [ -f /app/dist/index.js ]; then
  PORT=$APP_PORT node /app/dist/index.js &
  APP_PID=$!
elif [ -f /app/server.js ]; then
  PORT=$APP_PORT node /app/server.js &
  APP_PID=$!
elif [ -f /app/main.py ]; then
  PORT=$APP_PORT python /app/main.py &
  APP_PID=$!
elif [ -f /app/app.py ]; then
  PORT=$APP_PORT python /app/app.py &
  APP_PID=$!
elif [ -f /app/package.json ]; then
  PORT=$APP_PORT npm start &
  APP_PID=$!
else
  echo "[entrypoint] No app detected — running adapter only"
fi

wait $ADAPTER_PID
