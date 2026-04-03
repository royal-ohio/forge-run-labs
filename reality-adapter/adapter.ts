import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import {
  verifyCommandSignature,
  checkReplayProtection,
  generateAttestation,
  type CommandEnvelope,
  type NonceEntry,
} from "./verify";

const ADAPTER_VERSION = "1.0.0";
const CAPABILITIES = ["status", "restart", "deploy", "patch", "audit"];
const IDENTITY_FILE = path.join(__dirname, ".reality-identity.json");

interface AdapterIdentity {
  adapterId: string;
  publicKeyHex: string;
  privateKeyPem: string;
}

let identity: AdapterIdentity | null = null;
let authorityPublicKey: string | null = null;
const nonceWindow: NonceEntry[] = [];

function log(level: string, message: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: "reality-adapter",
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function loadOrCreateIdentity(): AdapterIdentity {
  const envId = process.env.ADAPTER_ID;
  const envKey = process.env.ADAPTER_PRIVATE_KEY;

  if (envId && envKey) {
    try {
      const privateKey = crypto.createPrivateKey({ key: envKey, format: "pem" });
      const publicKey = crypto.createPublicKey(privateKey);
      const pubDer = publicKey.export({ type: "spki", format: "der" });
      const id: AdapterIdentity = {
        adapterId: envId,
        publicKeyHex: pubDer.toString("hex"),
        privateKeyPem: envKey,
      };
      log("info", "Loaded identity from environment variables", { adapterId: envId });
      return id;
    } catch (err) {
      log("warn", "Failed to load identity from env vars, falling back to file", {
        error: String(err),
      });
    }
  }

  try {
    if (fs.existsSync(IDENTITY_FILE)) {
      const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8"));
      if (data.adapterId && data.publicKeyHex && data.privateKeyPem) {
        crypto.createPrivateKey({ key: data.privateKeyPem, format: "pem" });
        log("info", "Loaded existing identity from file", { adapterId: data.adapterId });
        return data as AdapterIdentity;
      }
    }
  } catch (err) {
    log("warn", "Failed to load identity file, generating new identity", {
      error: String(err),
    });
  }

  const kp = crypto.generateKeyPairSync("ed25519");
  const pubDer = kp.publicKey.export({ type: "spki", format: "der" });
  const privPem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const newIdentity: AdapterIdentity = {
    adapterId: crypto.randomUUID(),
    publicKeyHex: pubDer.toString("hex"),
    privateKeyPem: privPem,
  };

  try {
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(newIdentity, null, 2), { mode: 0o600 });
    log("info", "Generated and saved new identity", { adapterId: newIdentity.adapterId });
  } catch (err) {
    log("warn", "Could not persist identity file (will regenerate on restart)", {
      error: String(err),
    });
  }

  return newIdentity;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
): Promise<Response | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) return res;

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      log("warn", `HTTP ${res.status} (attempt ${attempt}/${retries})`, {
        url,
        status: res.status,
        retryInMs: attempt < retries ? delay : 0,
      });
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delay));
      } else {
        return res;
      }
    } catch (err) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      log("warn", `Request failed (attempt ${attempt}/${retries})`, {
        url,
        error: String(err),
        retryInMs: attempt < retries ? delay : 0,
      });
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return null;
}

async function fetchAuthorityKey(brainHubUrl: string): Promise<string | null> {
  const pinnedKey = process.env.BRAIN_AUTHORITY_PUBLIC_KEY;
  if (pinnedKey && /^[0-9a-fA-F]{20,}$/.test(pinnedKey)) {
    log("info", "Using pinned authority public key from BRAIN_AUTHORITY_PUBLIC_KEY env var", {
      keyLength: pinnedKey.length,
      keyPrefix: pinnedKey.substring(0, 16) + "...",
    });
    return pinnedKey;
  }

  if (!requireHttps(brainHubUrl, "fetchAuthorityKey")) {
    return null;
  }

  const url = `${brainHubUrl}/api/adapters/authority-key`;
  log("info", "Fetching authority public key from Brain Hub", { url });

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res || !res.ok) {
    log("warn", "Failed to fetch authority key — signed command verification disabled", {
      status: res?.status,
    });
    return null;
  }

  const body = (await res.json()) as { publicKey?: string };
  if (!body.publicKey) {
    log("warn", "Authority key response missing publicKey field");
    return null;
  }

  log("info", "Authority public key cached", {
    keyLength: body.publicKey.length,
    keyPrefix: body.publicKey.substring(0, 16) + "...",
  });
  return body.publicKey;
}

function requireHttps(brainHubUrl: string, operation: string): boolean {
  if (brainHubUrl.startsWith("https://")) return true;
  if (process.env.ALLOW_INSECURE_BRAIN_HUB === "true") {
    log("warn", `${operation}: BRAIN_HUB_URL is not HTTPS — proceeding due to ALLOW_INSECURE_BRAIN_HUB=true (DEV ONLY)`, { url: brainHubUrl });
    return true;
  }
  log("error", `${operation}: BRAIN_HUB_URL must use HTTPS — operation blocked`, { url: brainHubUrl });
  return false;
}

async function registerWithBrainHub(
  brainHubUrl: string,
  repoName: string,
  id: AdapterIdentity,
  accessToken: string,
): Promise<void> {
  if (!requireHttps(brainHubUrl, "registerWithBrainHub")) {
    log("warn", "Identity registration skipped — HTTPS required. Set ALLOW_INSECURE_BRAIN_HUB=true for dev only.");
    return;
  }

  const url = `${brainHubUrl}/api/adapters/${encodeURIComponent(repoName)}/register-identity`;
  log("info", "Registering identity with Brain Hub", { url, adapterId: id.adapterId });

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-access-token": accessToken,
    },
    body: JSON.stringify({
      adapterId: id.adapterId,
      publicKey: id.publicKeyHex,
    }),
  });

  if (!res || !res.ok) {
    const detail = res ? await res.text().catch(() => "") : "no response";
    log("warn", "Identity registration failed — adapter will operate in fallback mode", {
      status: res?.status,
      detail,
    });
    return;
  }

  log("info", "Identity registered with Brain Hub", { adapterId: id.adapterId });
}

function trySharedSecretAuth(
  headers: Record<string, string | undefined>,
): { authenticated: boolean; mode: "shared_secret" | "none"; reason?: string } {
  const realityKey = headers["x-reality-key"];
  const secret = process.env.REALITY_SECRET;
  if (realityKey && secret && realityKey === secret) {
    return { authenticated: true, mode: "shared_secret" };
  }
  return { authenticated: false, mode: "none", reason: "Missing or invalid credentials" };
}

function authenticateRequest(
  headers: Record<string, string | undefined>,
  body: Record<string, unknown>,
): { authenticated: boolean; mode: "ed25519" | "shared_secret" | "none"; reason?: string } {
  const hasSignedFields = !!(
    body.signature &&
    body.commandId &&
    body.adapterId &&
    body.nonce &&
    body.timestamp
  );

  if (hasSignedFields && authorityPublicKey) {
    const envelope = body as unknown as CommandEnvelope;

    if (identity && envelope.adapterId !== identity.adapterId) {
      return {
        authenticated: false,
        mode: "ed25519",
        reason: `adapterId mismatch: expected ${identity.adapterId}, got ${envelope.adapterId}`,
      };
    }

    const sigResult = verifyCommandSignature(envelope, authorityPublicKey);
    if (!sigResult.valid) {
      return { authenticated: false, mode: "ed25519", reason: sigResult.reason };
    }

    const replayResult = checkReplayProtection(envelope.nonce, envelope.timestamp, nonceWindow);
    if (!replayResult.valid) {
      return { authenticated: false, mode: "ed25519", reason: replayResult.reason };
    }

    return { authenticated: true, mode: "ed25519" };
  }

  const requireSigned = process.env.REQUIRE_SIGNED_COMMANDS === "true";

  if (requireSigned) {
    if (!hasSignedFields) {
      return {
        authenticated: false,
        mode: "none",
        reason: "REQUIRE_SIGNED_COMMANDS is enabled — only signed command envelopes accepted",
      };
    }
    if (!authorityPublicKey) {
      return {
        authenticated: false,
        mode: "ed25519",
        reason: "REQUIRE_SIGNED_COMMANDS is enabled but authority key unavailable — cannot verify",
      };
    }
  }

  if (hasSignedFields && !authorityPublicKey) {
    log("warn", "Signed envelope received but authority key unavailable — falling back to shared secret");
  }

  const fallback = trySharedSecretAuth(headers);
  if (fallback.authenticated) {
    return fallback;
  }

  if (!process.env.REALITY_SECRET && !authorityPublicKey) {
    return {
      authenticated: false,
      mode: "none",
      reason: "No authentication configured (set REALITY_SECRET or register identity)",
    };
  }

  return {
    authenticated: false,
    mode: "none",
    reason: "Missing or invalid credentials",
  };
}

function handleAction(
  action: string,
  payload: Record<string, unknown>,
): { success: boolean; result: Record<string, unknown> } {
  const timestamp = new Date().toISOString();

  switch (action) {
    case "status":
      return {
        success: true,
        result: {
          action: "status",
          status: "operational",
          adapterId: identity?.adapterId,
          version: ADAPTER_VERSION,
          timestamp,
        },
      };

    case "restart":
      log("info", "Restart command received (log-only)", { payload });
      return {
        success: true,
        result: {
          action: "restart",
          message: "Restart acknowledged (log-only mode)",
          timestamp,
        },
      };

    case "deploy":
      log("info", "Deploy command received (log-only)", { payload });
      return {
        success: true,
        result: {
          action: "deploy",
          message: "Deploy acknowledged (log-only mode)",
          timestamp,
        },
      };

    case "patch":
      log("info", "Patch command received (log-only)", { payload });
      return {
        success: true,
        result: {
          action: "patch",
          message: "Patch acknowledged (log-only mode)",
          timestamp,
        },
      };

    case "audit":
      log("info", "Audit command received (log-only)", { payload });
      return {
        success: true,
        result: {
          action: "audit",
          message: "Audit acknowledged (log-only mode)",
          timestamp,
        },
      };

    default:
      return {
        success: false,
        result: {
          action,
          error: `Unknown action: ${action}`,
          supportedActions: CAPABILITIES,
          timestamp,
        },
      };
  }
}

const MAX_BODY_BYTES = 1024 * 256;

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function handleExecute(
  headers: Record<string, string | undefined>,
  body: Record<string, unknown>,
  res: http.ServerResponse,
): void {
  const auth = authenticateRequest(headers, body);

  if (!auth.authenticated) {
    log("warn", "Authentication failed on /execute", {
      mode: auth.mode,
      reason: auth.reason,
    });
    sendJson(res, 403, {
      error: "Authentication failed",
      mode: auth.mode,
      reason: auth.reason,
    });
    return;
  }

  const action = (body.action as string) || "";
  const payload = (body.payload as Record<string, unknown>) || {};

  const result = handleAction(action, payload);
  const signatureVerified = auth.mode === "ed25519";

  log("info", "Command executed", {
    action,
    signatureVerified,
    authMode: auth.mode,
    success: result.success,
    commandId: body.commandId as string | undefined,
  });

  sendJson(res, result.success ? 200 : 400, {
    action,
    success: result.success,
    executedAt: new Date().toISOString(),
    authMode: auth.mode,
    signatureVerified,
    commandId: (body.commandId as string) || undefined,
    ...result.result,
  });
}

function handleStatus(res: http.ServerResponse): void {
  const attestation = generateAttestation(
    identity?.adapterId ?? "uninitialized",
    ADAPTER_VERSION,
    CAPABILITIES,
    __filename,
    identity?.publicKeyHex ?? "",
  );

  sendJson(res, 200, {
    status: "ok",
    adapterId: attestation.adapterId,
    version: attestation.version,
    capabilities: CAPABILITIES,
    capabilitiesHash: attestation.capabilitiesHash,
    codeChecksum: attestation.codeChecksum,
    publicKey: attestation.publicKey,
    lastVerifiedAt: attestation.lastVerifiedAt,
    attestation,
    timestamp: Date.now(),
  });
}

function handleHealthz(res: http.ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    adapterId: identity?.adapterId ?? null,
    identityLoaded: !!identity,
    authorityKeyLoaded: !!authorityPublicKey,
    requireSignedCommands: process.env.REQUIRE_SIGNED_COMMANDS === "true",
    version: ADAPTER_VERSION,
    timestamp: new Date().toISOString(),
  });
}

function handleWellKnownIdentity(res: http.ServerResponse): void {
  sendJson(res, 200, {
    system: "realityos-adapter",
    adapterId: identity?.adapterId,
    publicKey: identity?.publicKeyHex,
    version: ADAPTER_VERSION,
    capabilities: CAPABILITIES,
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url || "";
  const method = req.method || "GET";

  if (method === "GET" && (url === "/healthz" || url === "/api/reality/healthz")) {
    return handleHealthz(res);
  }

  if (method === "GET" && url === "/.well-known/system.identity") {
    return handleWellKnownIdentity(res);
  }

  if (method === "GET" && url === "/api/reality/status") {
    return handleStatus(res);
  }

  if (method === "POST" && url === "/api/reality/execute") {
    try {
      const body = await parseBody(req);
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
      return handleExecute(headers, body, res);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid request body", detail: String(err) });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found", path: url });
}

export function createAdapter(): {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  init: () => Promise<void>;
  getIdentity: () => AdapterIdentity | null;
} {
  return {
    handler: handleRequest,
    init: async () => {
      identity = loadOrCreateIdentity();
      const brainHubUrl = "BRAIN_HUB_URL" in process.env
        ? process.env.BRAIN_HUB_URL || ""
        : "https://migration-hub.replit.app";
      const repoName = process.env.REPO_NAME || path.basename(process.cwd());
      const accessToken = process.env.ACCESS_TOKEN || "";

      if (brainHubUrl) {
        authorityPublicKey = await fetchAuthorityKey(brainHubUrl);
        if (accessToken) {
          await registerWithBrainHub(brainHubUrl, repoName, identity, accessToken);
        } else {
          log("warn", "ACCESS_TOKEN not set — skipping identity registration with Brain Hub");
        }
      } else {
        log("info", "BRAIN_HUB_URL not set — running in standalone/fallback mode");
      }
    },
    getIdentity: () => identity,
  };
}

export { handleRequest, handleExecute, handleStatus };

if (require.main === module) {
  const PORT = parseInt(process.env.PORT || "8080", 10);
  const adapter = createAdapter();

  adapter.init().then(() => {
    const server = http.createServer(adapter.handler);
    const requireSigned = process.env.REQUIRE_SIGNED_COMMANDS === "true";
    const authMode = requireSigned
      ? "STRICT (signed only)"
      : authorityPublicKey
        ? "signed-ready"
        : "fallback";
    const brainHubStatus = authorityPublicKey ? "connected" : "fallback";

    server.listen(PORT, "0.0.0.0", () => {
      log("info", "Reality Adapter started", {
        port: PORT,
        adapterId: adapter.getIdentity()?.adapterId,
        version: ADAPTER_VERSION,
        capabilities: CAPABILITIES,
        authMode,
        brainHub: brainHubStatus,
        requireSignedCommands: requireSigned,
        identityLoaded: !!adapter.getIdentity(),
        authorityKeyLoaded: !!authorityPublicKey,
      });

      console.log("");
      console.log("=== Reality Adapter Online ===");
      console.log(`  Adapter ID: ${adapter.getIdentity()?.adapterId}`);
      console.log(`  Version:    ${ADAPTER_VERSION}`);
      console.log(`  Port:       ${PORT}`);
      console.log(`  Auth Mode:  ${authMode}`);
      console.log(`  Brain Hub:  ${brainHubStatus}`);
      console.log(`  Enforce:    ${requireSigned ? "SIGNED ONLY" : "fallback allowed"}`);
      console.log(`  Endpoints:`);
      console.log(`    GET  /api/reality/status`);
      console.log(`    POST /api/reality/execute`);
      console.log(`    GET  /api/reality/healthz`);
      console.log(`    GET  /healthz`);
      console.log(`    GET  /.well-known/system.identity`);
      console.log("==============================");
      console.log("");
    });
  });
}
