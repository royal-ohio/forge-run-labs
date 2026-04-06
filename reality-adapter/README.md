# Reality Adapter — Drop-in Execution Node

A self-contained adapter that connects any repository to the RealityOS mesh.

Supports **Phase 85** (shared secret fallback) and **Phase 86** (Ed25519 signed commands + identity + attestation).

```
┌──────────────────────────────────────────────────────┐
│  Brain Hub (Command Center)                          │
│                                                      │
│  ┌──────────────┐  ┌───────────────┐                │
│  │  Command      │  │  Health       │                │
│  │  Authority    │──│  Monitor      │                │
│  │  (Ed25519)    │  │  (polling)    │                │
│  └──────┬───────┘  └───────┬───────┘                │
│         │                  │                         │
└─────────┼──────────────────┼─────────────────────────┘
          │ Signed Command   │ GET /api/reality/status
          │ Envelope         │
          ▼                  ▼
┌──────────────────────────────────────────────────────┐
│  Your Repository (this adapter)                      │
│                                                      │
│  POST /api/reality/execute                           │
│    → Verify signature (Ed25519)                      │
│    → Check replay protection (nonce + timestamp)     │
│    → Execute action                                  │
│                                                      │
│  GET /api/reality/status                             │
│    → Return attestation (version, checksum, caps)    │
│    → Identity + public key                           │
│                                                      │
│  GET /healthz                                        │
│  GET /.well-known/system.identity                    │
└──────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js 18+
- TypeScript (for compilation)

## Installation

### 1. Copy the adapter directory into your repo

```bash
cp -r reality-adapter-template/ /path/to/your-repo/reality-adapter/
```

### 2. Set environment variables

```bash
# Required — shared secret for fallback auth
export REALITY_SECRET="your-shared-secret"

# Required for signed command mode
export BRAIN_HUB_URL="https://realityos-node-a.fly.dev"
export ACCESS_TOKEN="your-access-token"

# Auto-detected from directory name if not set
export REPO_NAME="your-repo-name"

# Optional — override generated identity
# export ADAPTER_ID="custom-uuid"
# export ADAPTER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

### 3a. Run standalone

```bash
cd reality-adapter
npx tsx adapter.ts
```

The adapter starts an HTTP server on port 8080 (override with `PORT` env var).

### 3b. Mount into existing Express app

```typescript
import { createServer } from "http";
import { createAdapter } from "./reality-adapter/adapter";

const adapter = createAdapter();

// Initialize identity and Brain Hub registration
await adapter.init();

// Mount into your existing server
const existingHandler = yourApp; // your Express app or http handler
const server = createServer(async (req, res) => {
  const url = req.url || "";
  if (
    url === "/api/reality/execute" ||
    url === "/api/reality/status" ||
    url === "/healthz" ||
    url === "/.well-known/system.identity"
  ) {
    return adapter.handler(req, res);
  }
  // Fall through to your existing handler
  existingHandler(req, res);
});
```

### 3c. Mount into existing Express app (as middleware)

```typescript
import express from "express";
import { createAdapter } from "./reality-adapter/adapter";

const app = express();
const adapter = createAdapter();

await adapter.init();

// Mount adapter routes
app.all("/api/reality/*", (req, res) => adapter.handler(req, res));
app.get("/healthz", (req, res) => adapter.handler(req, res));
app.get("/.well-known/system.identity", (req, res) => adapter.handler(req, res));

// Your existing routes below...
app.get("/", (req, res) => res.send("Hello"));
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REALITY_SECRET` | For fallback auth | — | Shared secret for `x-reality-key` header authentication |
| `BRAIN_HUB_URL` | No | `https://realityos-node-a.fly.dev` | Brain Hub base URL (must be HTTPS) |
| `ACCESS_TOKEN` | For registration | — | Token for authenticating with Brain Hub API |
| `BRAIN_AUTHORITY_PUBLIC_KEY` | No | Fetched from Brain Hub | Pinned authority public key (hex). If set, skips fetching from Brain Hub — use for high-security or air-gapped deployments |
| `ALLOW_INSECURE_BRAIN_HUB` | No | `false` | Set to `true` to allow HTTP (non-HTTPS) `BRAIN_HUB_URL` — **dev/testing only**, never use in production |
| `REQUIRE_SIGNED_COMMANDS` | No | `false` | Set to `true` to reject all shared-secret requests and only accept signed command envelopes — enable when ready for full enforcement |
| `REPO_NAME` | No | Directory name | Repository name for Brain Hub registration |
| `PORT` | No | `8080` | HTTP server port (standalone mode) |
| `ADAPTER_ID` | No | Auto-generated | Override the auto-generated adapter UUID |
| `ADAPTER_PRIVATE_KEY` | No | Auto-generated | Override the auto-generated Ed25519 private key (PEM) |

## Test Commands

### Legacy mode (shared secret)

```bash
# Status check
curl http://localhost:8080/api/reality/status

# Execute command with shared secret
curl -X POST http://localhost:8080/api/reality/execute \
  -H "Content-Type: application/json" \
  -H "x-reality-key: your-shared-secret" \
  -d '{"action": "status", "payload": {}}'

# Health check
curl http://localhost:8080/healthz

# Identity endpoint
curl http://localhost:8080/.well-known/system.identity
```

### Signed command mode (Ed25519)

Brain Hub sends signed commands automatically once the adapter's identity is registered.
To verify the adapter accepts signed commands, use the dispatch endpoint on Brain Hub:

```bash
# From Brain Hub — dispatch a command to a registered adapter
curl -X POST https://your-brain-hub/api/adapters/your-repo-name/execute \
  -H "Content-Type: application/json" \
  -H "x-access-token: your-access-token" \
  -d '{"action": "status", "payload": {}}'
```

## Startup Sequence

1. **Identity**: Loads from env vars → file (`.reality-identity.json`) → generates new
2. **Authority Key**: Fetches Brain Hub's Ed25519 public key (if `BRAIN_HUB_URL` set)
3. **Registration**: Registers adapter identity with Brain Hub (if `ACCESS_TOKEN` set)
4. **Server**: Starts HTTP server and begins accepting commands

If Brain Hub is unreachable, the adapter falls back to shared secret mode (`x-reality-key`).

## Authentication Modes

| Mode | Priority | How it works |
|------|----------|-------------|
| **Ed25519 Signed** | Primary | Brain Hub signs command envelopes; adapter verifies signature + nonce + timestamp |
| **Shared Secret** | Fallback | `x-reality-key` header matches `REALITY_SECRET` env var |

The adapter automatically upgrades to signed mode once:
1. `BRAIN_HUB_URL` is set and reachable
2. The authority public key is fetched
3. The adapter's identity is registered

## Files

| File | Purpose |
|------|---------|
| `adapter.ts` | Main adapter server — routes, auth, action handling, identity management |
| `verify.ts` | Standalone verification library — Ed25519 signatures, replay protection, attestation |
| `.gitignore` | Excludes `.reality-identity.json` and build artifacts |
| `.reality-identity.json` | Auto-generated identity (gitignored, created on first run) |

## Troubleshooting

**"Authentication failed" on every request**
- Check `REALITY_SECRET` is set and matches the value used in the `x-reality-key` header
- For signed mode, ensure `BRAIN_HUB_URL` is set and Brain Hub is reachable

**"Authority public key not available"**
- Brain Hub was unreachable during startup
- Restart the adapter with `BRAIN_HUB_URL` pointing to a live Brain Hub instance

**"adapterId mismatch"**
- The command was signed for a different adapter
- Check the adapter's registration in Brain Hub matches its local identity

**Identity regenerates on every restart**
- Ensure the adapter has write permission to its directory for `.reality-identity.json`
- Or set `ADAPTER_ID` and `ADAPTER_PRIVATE_KEY` env vars for persistent identity

**Port conflict**
- Set `PORT` env var to an available port
- Default is 8080
