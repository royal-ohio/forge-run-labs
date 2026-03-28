# Deploying to Fly.io

This guide covers the one-time setup to get ForgeRun Labs running on Fly.io.
Development on Replit continues to work exactly as before.

## Prerequisites

Install the Fly.io CLI (`flyctl`):

```bash
# macOS
brew install flyctl

# Linux / WSL
curl -L https://fly.io/install.sh | sh
```

Then log in:

```bash
fly auth login
```

## One-time setup

### 1. Launch the app on Fly.io

Run this from the repo root. When prompted, **skip** generating a new
Dockerfile — one already exists.

```bash
fly launch --no-deploy
```

Update `fly.toml` with the app name and region that were assigned (or choose
your own). The defaults in `fly.toml` are reasonable starting points.

### 2. Set required secrets

The app needs these environment variables set as Fly.io secrets:

```bash
fly secrets set DATABASE_URL="postgres://user:password@host:5432/dbname"
fly secrets set ADMIN_TOKEN="your-secret-admin-token"
```

Add any other secrets your app requires in the same way.

### 3. Apply database migrations

Fly.io does **not** run migrations automatically on deploy. Before your first
deploy (and after any schema changes), connect to your production database
directly and push the schema:

```bash
DATABASE_URL="postgres://user:password@host:5432/dbname" \
  pnpm --filter @workspace/db run push
```

## Deploy

```bash
fly deploy
```

Fly.io will build the Docker image, push it, and start the new version. The
health check at `/api/healthz` must return `200 OK` before traffic is routed
to the new machine.

## Subsequent deploys

After the initial setup, deploying is just:

```bash
fly deploy
```

## Checking logs

```bash
fly logs
```

## Scaling

To run more than one machine or increase memory:

```bash
fly scale count 2
fly scale memory 512
```
