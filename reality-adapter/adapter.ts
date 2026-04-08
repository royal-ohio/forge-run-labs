import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { execFileSync } from "child_process";
import {
  verifyCommandSignature,
  checkReplayProtection,
  generateAttestation,
  type CommandEnvelope,
  type NonceEntry,
} from "./verify";

const ADAPTER_VERSION = "2.0.0";
const ADAPTER_CAPABILITY_LEVEL = 2;
const DEFAULT_CAPABILITIES = ["status", "restart", "deploy", "patch", "audit", "EXEC_SCRIPT", "WRITE_FILE", "RESTART_SERVICE", "RUN_MIGRATION"];

export interface AdapterIdentity {
  adapterId: string;
  publicKeyHex: string;
  privateKeyPem: string;
}

export interface AdapterConfig {
  brainHubUrl: string;
  repoName: string;
  accessToken?: string;
  port?: number;
  adapterId?: string;
  adapterPrivateKey?: string;
  identityDir?: string;
  allowInsecureBrainHub?: boolean;
  requireSignedCommands?: boolean;
  realitySecret?: string;
  capabilities?: string[];
  ecologicalTier?: string;
  providedServices?: string[];
  consumedServices?: string[];
  eventTypesEmitted?: string[];
  eventTypesConsumed?: string[];
  apiContracts?: Record<string, unknown>;
  onCommand?: (action: string, payload: Record<string, unknown>) => { success: boolean; result: Record<string, unknown> };
}

interface MigrationState {
  migrationId: string;
  targetUrl: string;
  oldUrl: string;
  deadline: string;
  status: "pending" | "verifying" | "migrated" | "rolled_back" | "failed";
  verifiedAt: string | null;
  migratedAt: string | null;
}

interface AdapterState {
  identity: AdapterIdentity | null;
  authorityPublicKey: string | null;
  nonceWindow: NonceEntry[];
  processedCommandIds: Set<string>;
  config: Required<Pick<AdapterConfig, "brainHubUrl" | "repoName" | "port" | "allowInsecureBrainHub" | "requireSignedCommands">> & AdapterConfig;
  capabilities: string[];
  migration: MigrationState | null;
}

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

function resolveIdentityFile(identityDir?: string): string {
  const dir = identityDir || process.cwd();
  return path.join(dir, ".reality-identity.json");
}

function loadOrCreateIdentity(state: AdapterState): AdapterIdentity {
  const envId = state.config.adapterId;
  const envKey = state.config.adapterPrivateKey;

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
      log("info", "Loaded identity from config/environment variables", { adapterId: envId });
      return id;
    } catch (err) {
      log("warn", "Failed to load identity from config, falling back to file", {
        error: String(err),
      });
    }
  }

  const identityFile = resolveIdentityFile(state.config.identityDir);

  try {
    if (fs.existsSync(identityFile)) {
      const data = JSON.parse(fs.readFileSync(identityFile, "utf-8"));
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
    fs.writeFileSync(identityFile, JSON.stringify(newIdentity, null, 2), { mode: 0o600 });
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

function brainHubHeaders(token?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", ...extra };
  if (token) {
    headers["x-access-token"] = token;
  }
  return headers;
}

function requireHttps(brainHubUrl: string, operation: string, allowInsecure: boolean): boolean {
  if (brainHubUrl.startsWith("https://")) return true;
  if (allowInsecure) {
    log("warn", `${operation}: BRAIN_HUB_URL is not HTTPS — proceeding due to allowInsecureBrainHub=true (DEV ONLY)`, { url: brainHubUrl });
    return true;
  }
  log("error", `${operation}: BRAIN_HUB_URL must use HTTPS — operation blocked`, { url: brainHubUrl });
  return false;
}

async function fetchAuthorityKey(state: AdapterState): Promise<string | null> {
  const pinnedKey = process.env.BRAIN_AUTHORITY_PUBLIC_KEY;
  if (pinnedKey && /^[0-9a-fA-F]{20,}$/.test(pinnedKey)) {
    log("info", "Using pinned authority public key from BRAIN_AUTHORITY_PUBLIC_KEY env var", {
      keyLength: pinnedKey.length,
      keyPrefix: pinnedKey.substring(0, 16) + "...",
    });
    return pinnedKey;
  }

  if (!requireHttps(state.config.brainHubUrl, "fetchAuthorityKey", state.config.allowInsecureBrainHub)) {
    return null;
  }

  const url = `${state.config.brainHubUrl}/api/adapters/authority-key`;
  log("info", "Fetching authority public key from Brain Hub", { url });

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: brainHubHeaders(state.config.accessToken),
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

async function registerWithBrainHub(state: AdapterState): Promise<void> {
  if (!requireHttps(state.config.brainHubUrl, "registerWithBrainHub", state.config.allowInsecureBrainHub)) {
    log("warn", "Identity registration skipped — HTTPS required. Set allowInsecureBrainHub=true for dev only.");
    return;
  }

  const id = state.identity!;
  const url = `${state.config.brainHubUrl}/api/adapters/${encodeURIComponent(state.config.repoName)}/register-identity`;
  log("info", "Registering identity with Brain Hub", { url, adapterId: id.adapterId });

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: brainHubHeaders(state.config.accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      adapterId: id.adapterId,
      publicKey: id.publicKeyHex,
      capabilityLevel: ADAPTER_CAPABILITY_LEVEL,
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

  await publishCapabilityManifest(state);
}

async function publishCapabilityManifest(state: AdapterState): Promise<void> {
  if (!requireHttps(state.config.brainHubUrl, "publishCapabilityManifest", state.config.allowInsecureBrainHub)) {
    return;
  }

  const url = `${state.config.brainHubUrl}/api/registry/capability`;
  const manifest = {
    repoName: state.config.repoName,
    ecologicalTier: state.config.ecologicalTier,
    providedServices: state.config.providedServices ?? state.capabilities,
    consumedServices: state.config.consumedServices ?? [],
    eventTypesEmitted: state.config.eventTypesEmitted ?? [],
    eventTypesConsumed: state.config.eventTypesConsumed ?? [],
    apiContracts: state.config.apiContracts ?? {},
    healthEndpoint: `/api/reality/healthz`,
    version: ADAPTER_VERSION,
  };

  log("info", "Publishing capability manifest to Brain Hub", { url, repoName: state.config.repoName });

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: brainHubHeaders(state.config.accessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify(manifest),
  });

  if (!res || !res.ok) {
    const detail = res ? await res.text().catch(() => "") : "no response";
    log("warn", "Capability manifest publish failed (non-fatal)", { status: res?.status, detail });
    return;
  }

  log("info", "Capability manifest published", { repoName: state.config.repoName });
}

function trySharedSecretAuth(
  headers: Record<string, string | undefined>,
  realitySecret?: string,
): { authenticated: boolean; mode: "shared_secret" | "none"; reason?: string } {
  const realityKey = headers["x-reality-key"];
  if (realityKey && realitySecret && realityKey === realitySecret) {
    return { authenticated: true, mode: "shared_secret" };
  }
  return { authenticated: false, mode: "none", reason: "Missing or invalid credentials" };
}

function authenticateRequest(
  state: AdapterState,
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

  if (hasSignedFields && state.authorityPublicKey) {
    const envelope = body as unknown as CommandEnvelope;

    if (state.identity && envelope.adapterId !== state.identity.adapterId) {
      return {
        authenticated: false,
        mode: "ed25519",
        reason: `adapterId mismatch: expected ${state.identity.adapterId}, got ${envelope.adapterId}`,
      };
    }

    const sigResult = verifyCommandSignature(envelope, state.authorityPublicKey);
    if (!sigResult.valid) {
      return { authenticated: false, mode: "ed25519", reason: sigResult.reason };
    }

    const replayResult = checkReplayProtection(envelope.nonce, envelope.timestamp, state.nonceWindow);
    if (!replayResult.valid) {
      return { authenticated: false, mode: "ed25519", reason: replayResult.reason };
    }

    return { authenticated: true, mode: "ed25519" };
  }

  if (state.config.requireSignedCommands) {
    if (!hasSignedFields) {
      return {
        authenticated: false,
        mode: "none",
        reason: "REQUIRE_SIGNED_COMMANDS is enabled — only signed command envelopes accepted",
      };
    }
    if (!state.authorityPublicKey) {
      return {
        authenticated: false,
        mode: "ed25519",
        reason: "REQUIRE_SIGNED_COMMANDS is enabled but authority key unavailable — cannot verify",
      };
    }
  }

  if (hasSignedFields && !state.authorityPublicKey) {
    log("warn", "Signed envelope received but authority key unavailable — falling back to shared secret");
  }

  const fallback = trySharedSecretAuth(headers, state.config.realitySecret);
  if (fallback.authenticated) {
    return fallback;
  }

  if (!state.config.realitySecret && !state.authorityPublicKey) {
    return {
      authenticated: false,
      mode: "none",
      reason: "No authentication configured (set realitySecret or register identity)",
    };
  }

  return {
    authenticated: false,
    mode: "none",
    reason: "Missing or invalid credentials",
  };
}

function defaultHandleAction(
  action: string,
  payload: Record<string, unknown>,
  state: AdapterState,
): { success: boolean; result: Record<string, unknown> } {
  const timestamp = new Date().toISOString();

  switch (action) {
    case "status":
      return {
        success: true,
        result: {
          action: "status",
          status: "operational",
          adapterId: state.identity?.adapterId,
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
          supportedActions: state.capabilities,
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

async function emitResultEvent(
  state: AdapterState,
  commandId: string,
  commandType: string,
  action: string,
  success: boolean,
  result: Record<string, unknown>,
): Promise<void> {
  if (!state.config.brainHubUrl) return;

  const event = {
    eventId: `cmd-result-${commandId}-${Date.now()}`,
    event_type: "adapter.command.result",
    payload: {
      commandId,
      repoName: state.config.repoName,
      adapterId: state.identity?.adapterId,
      commandType,
      action,
      stdout: result.stdout ?? null,
      exitCode: result.exitCode ?? (success ? 0 : 1),
      status: success ? "success" : "failed",
      completedAt: new Date().toISOString(),
      result,
    },
  };

  const url = `${state.config.brainHubUrl}/api/events/forward`;
  try {
    await fetchWithRetry(url, {
      method: "POST",
      headers: brainHubHeaders(state.config.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(event),
    }, 1);
  } catch (err) {
    log("warn", "Failed to emit command result event", { error: String(err) });
  }
}

async function emitSecurityViolation(
  state: AdapterState,
  commandId: string,
  reason: string,
): Promise<void> {
  if (!state.config.brainHubUrl) return;

  const event = {
    eventId: `sec-violation-${commandId}-${Date.now()}`,
    event_type: "adapter.security.violation",
    payload: {
      commandId,
      repoName: state.config.repoName,
      adapterId: state.identity?.adapterId,
      reason,
      rejectedAt: new Date().toISOString(),
    },
  };

  const url = `${state.config.brainHubUrl}/api/events/forward`;
  try {
    await fetchWithRetry(url, {
      method: "POST",
      headers: brainHubHeaders(state.config.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(event),
    }, 1);
  } catch (err) {
    log("warn", "Failed to emit security violation event", { error: String(err) });
  }
}

const ALLOWED_SCRIPT_COMMANDS = new Set([
  "ls", "cat", "echo", "pwd", "date", "whoami", "uname",
  "node", "npm", "npx", "tsx", "tsc", "pnpm",
  "git", "curl",
]);

function parseCommandArgs(input: string): { command: string; args: string[] } | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return null;
  const command = parts[0].split("/").pop() || "";
  if (!ALLOWED_SCRIPT_COMMANDS.has(command)) return null;
  return { command, args: parts.slice(1) };
}

const WRITE_FILE_ALLOWED_DIRS = ["reality-adapter/", "./reality-adapter/"];

function isWritePathAllowed(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  if (normalized.includes("..")) return false;
  return WRITE_FILE_ALLOWED_DIRS.some((dir) => normalized.startsWith(dir));
}

function execCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): { stdout: string; exitCode: number; error?: string } {
  try {
    const stdout = execFileSync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      cwd: process.cwd(),
      shell: false,
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      stdout: (execErr.stdout || "") + (execErr.stderr || ""),
      exitCode: execErr.status ?? 1,
      error: execErr.message || "Execution failed",
    };
  }
}

function handleExecuteCommand(
  commandType: string,
  payload: Record<string, unknown>,
  _state: AdapterState,
): { success: boolean; result: Record<string, unknown> } {
  const timestamp = new Date().toISOString();
  const timeoutMs = (payload.timeoutMs as number) ?? 60_000;

  switch (commandType) {
    case "EXEC_SCRIPT": {
      const script = (payload.script as string) || "";
      if (!script) {
        return {
          success: false,
          result: { commandType: "EXEC_SCRIPT", error: "Missing 'script' in payload", exitCode: 1, stdout: "", timestamp },
        };
      }

      const parsed = parseCommandArgs(script);
      if (!parsed) {
        log("warn", "EXEC_SCRIPT blocked by allowlist", { script: script.substring(0, 100) });
        return {
          success: false,
          result: {
            commandType: "EXEC_SCRIPT",
            error: `Script command not in allowlist. Allowed: ${[...ALLOWED_SCRIPT_COMMANDS].join(", ")}`,
            exitCode: 126,
            stdout: "",
            timestamp,
          },
        };
      }

      log("info", "EXEC_SCRIPT executing", { command: parsed.command, argsCount: parsed.args.length, timeoutMs });
      const result = execCommand(parsed.command, parsed.args, timeoutMs);
      return {
        success: result.exitCode === 0,
        result: { commandType: "EXEC_SCRIPT", ...result, timestamp },
      };
    }

    case "WRITE_FILE": {
      const filePath = (payload.path as string) || "";
      const content = (payload.content as string) || "";
      if (!filePath) {
        return {
          success: false,
          result: { commandType: "WRITE_FILE", error: "Missing 'path' in payload", exitCode: 1, stdout: "", timestamp },
        };
      }

      if (!isWritePathAllowed(filePath)) {
        log("warn", "WRITE_FILE blocked — path outside allowed directory", { path: filePath });
        return {
          success: false,
          result: {
            commandType: "WRITE_FILE",
            error: `Write path must be inside: ${WRITE_FILE_ALLOWED_DIRS.join(", ")}`,
            exitCode: 1,
            stdout: "",
            path: filePath,
            timestamp,
          },
        };
      }

      log("info", "WRITE_FILE executing", { path: filePath, contentLength: content.length });
      try {
        const resolvedPath = path.resolve(filePath);
        const dir = path.dirname(resolvedPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, content, "utf-8");
        return {
          success: true,
          result: {
            commandType: "WRITE_FILE",
            stdout: `Written ${content.length} bytes to ${filePath}`,
            exitCode: 0,
            path: filePath,
            bytesWritten: content.length,
            timestamp,
          },
        };
      } catch (err: unknown) {
        const fsErr = err as { message?: string };
        return {
          success: false,
          result: {
            commandType: "WRITE_FILE",
            error: fsErr.message || "File write failed",
            exitCode: 1,
            stdout: "",
            path: filePath,
            timestamp,
          },
        };
      }
    }

    case "RESTART_SERVICE": {
      const serviceName = (payload.service as string) || "self";
      log("info", "RESTART_SERVICE executing", { service: serviceName });

      if (serviceName === "self" || serviceName === "adapter") {
        setTimeout(() => {
          log("info", "Adapter self-restart triggered by RESTART_SERVICE command");
          process.exit(0);
        }, 1000);

        return {
          success: true,
          result: {
            commandType: "RESTART_SERVICE",
            stdout: `Service "${serviceName}" restart scheduled (exit in 1s)`,
            exitCode: 0,
            service: serviceName,
            timestamp,
          },
        };
      }

      return {
        success: false,
        result: {
          commandType: "RESTART_SERVICE",
          error: `Only "self" or "adapter" service restart is supported. Got: "${serviceName}"`,
          exitCode: 1,
          stdout: "",
          service: serviceName,
          timestamp,
        },
      };
    }

    case "RUN_MIGRATION": {
      const migrationCommand = (payload.command as string) || "";
      const migrationId = (payload.migrationId as string) || crypto.randomUUID();
      if (!migrationCommand) {
        return {
          success: false,
          result: { commandType: "RUN_MIGRATION", error: "Missing 'command' in payload", exitCode: 1, stdout: "", migrationId, timestamp },
        };
      }

      const parsed = parseCommandArgs(migrationCommand);
      if (!parsed) {
        log("warn", "RUN_MIGRATION blocked by allowlist", { command: migrationCommand.substring(0, 100) });
        return {
          success: false,
          result: {
            commandType: "RUN_MIGRATION",
            error: `Migration command not in allowlist. Allowed: ${[...ALLOWED_SCRIPT_COMMANDS].join(", ")}`,
            exitCode: 126,
            stdout: "",
            migrationId,
            timestamp,
          },
        };
      }

      log("info", "RUN_MIGRATION executing", { migrationId, command: parsed.command, argsCount: parsed.args.length });
      const result = execCommand(parsed.command, parsed.args, timeoutMs);
      return {
        success: result.exitCode === 0,
        result: { commandType: "RUN_MIGRATION", ...result, migrationId, timestamp },
      };
    }

    default:
      return {
        success: false,
        result: {
          commandType,
          error: `Unknown execute command type: ${commandType}`,
          supportedTypes: ["EXEC_SCRIPT", "WRITE_FILE", "RESTART_SERVICE", "RUN_MIGRATION"],
          exitCode: 1,
          stdout: "",
          timestamp,
        },
      };
  }
}

function handleExecute(
  state: AdapterState,
  headers: Record<string, string | undefined>,
  body: Record<string, unknown>,
  res: http.ServerResponse,
): void {
  const auth = authenticateRequest(state, headers, body);
  const commandId = (body.commandId as string) || "";

  if (!auth.authenticated) {
    log("warn", "Authentication failed on /execute", {
      mode: auth.mode,
      reason: auth.reason,
    });

    emitSecurityViolation(state, commandId, auth.reason || "Authentication failed");

    sendJson(res, 403, {
      error: "Authentication failed",
      mode: auth.mode,
      reason: auth.reason,
    });
    return;
  }

  const action = (body.action as string) || "";
  const payload = (body.payload as Record<string, unknown>) || {};

  const isExecuteCommand = action.startsWith("COMMAND_EXECUTE:");
  if (isExecuteCommand) {
    if (commandId && state.processedCommandIds.has(commandId)) {
      log("info", "Duplicate command delivery (idempotent skip)", { commandId, transport: "http" });
      sendJson(res, 200, {
        action,
        commandId,
        duplicate: true,
        message: "Command already processed (idempotent)",
      });
      return;
    }

    if (auth.mode !== "ed25519") {
      const reason = `COMMAND_EXECUTE requires Ed25519 signed delivery, got auth mode: ${auth.mode}`;
      log("warn", "Execute command rejected — Ed25519 required", {
        commandId,
        authMode: auth.mode,
      });
      emitSecurityViolation(state, commandId, reason);
      sendJson(res, 403, {
        error: reason,
        mode: auth.mode,
        commandId: commandId || undefined,
      });
      return;
    }

    if (commandId) trackProcessedCommand(state, commandId);

    const commandType = action.replace("COMMAND_EXECUTE:", "");
    const execResult = handleExecuteCommand(commandType, payload, state);

    log("info", "Execute command processed", {
      commandType,
      signatureVerified: true,
      authMode: auth.mode,
      success: execResult.success,
      commandId,
    });

    emitResultEvent(state, commandId, commandType, action, execResult.success, execResult.result);

    sendJson(res, execResult.success ? 200 : 400, {
      action,
      commandType,
      success: execResult.success,
      executedAt: new Date().toISOString(),
      authMode: auth.mode,
      signatureVerified: true,
      commandId: commandId || undefined,
      ...execResult.result,
    });
    return;
  }

  const handler = state.config.onCommand || ((a: string, p: Record<string, unknown>) => defaultHandleAction(a, p, state));
  const result = handler(action, payload);
  const signatureVerified = auth.mode === "ed25519";

  log("info", "Command executed", {
    action,
    signatureVerified,
    authMode: auth.mode,
    success: result.success,
    commandId: body.commandId as string | undefined,
  });

  emitResultEvent(state, commandId, "legacy", action, result.success, result.result);

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

function handleStatus(state: AdapterState, res: http.ServerResponse): void {
  const attestation = generateAttestation(
    state.identity?.adapterId ?? "uninitialized",
    ADAPTER_VERSION,
    state.capabilities,
    __filename,
    state.identity?.publicKeyHex ?? "",
  );

  sendJson(res, 200, {
    status: "ok",
    adapterId: attestation.adapterId,
    version: attestation.version,
    capabilities: state.capabilities,
    capabilitiesHash: attestation.capabilitiesHash,
    codeChecksum: attestation.codeChecksum,
    publicKey: attestation.publicKey,
    lastVerifiedAt: attestation.lastVerifiedAt,
    attestation,
    timestamp: Date.now(),
  });
}

function handleHealthz(state: AdapterState, res: http.ServerResponse): void {
  sendJson(res, 200, {
    status: "ok",
    service: "forge-run-labs",
    ok: true,
    adapterId: state.identity?.adapterId ?? null,
    identityLoaded: !!state.identity,
    authorityKeyLoaded: !!state.authorityPublicKey,
    requireSignedCommands: state.config.requireSignedCommands,
    version: ADAPTER_VERSION,
    brainHubUrl: state.config.brainHubUrl,
    migration: state.migration ? {
      migrationId: state.migration.migrationId,
      status: state.migration.status,
      targetUrl: state.migration.targetUrl,
      migratedAt: state.migration.migratedAt,
    } : null,
    timestamp: new Date().toISOString(),
  });
}

function handleWellKnownIdentity(state: AdapterState, res: http.ServerResponse): void {
  sendJson(res, 200, {
    system: "realityos-adapter",
    adapterId: state.identity?.adapterId,
    publicKey: state.identity?.publicKeyHex,
    version: ADAPTER_VERSION,
    capabilityLevel: ADAPTER_CAPABILITY_LEVEL,
    capabilities: state.capabilities,
  });
}

async function handleRequest(
  state: AdapterState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url || "";
  const method = req.method || "GET";

  if (method === "GET" && (url === "/healthz" || url === "/api/reality/healthz")) {
    return handleHealthz(state, res);
  }

  if (method === "GET" && url === "/.well-known/system.identity") {
    return handleWellKnownIdentity(state, res);
  }

  if (method === "GET" && url === "/api/reality/status") {
    return handleStatus(state, res);
  }

  if (method === "POST" && url === "/api/reality/execute") {
    try {
      const body = await parseBody(req);
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
      return handleExecute(state, headers, body, res);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid request body", detail: String(err) });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found", path: url });
}

const MAX_PROCESSED_COMMAND_IDS = 10_000;

function trackProcessedCommand(state: AdapterState, commandId: string): void {
  if (state.processedCommandIds.size >= MAX_PROCESSED_COMMAND_IDS) {
    const first = state.processedCommandIds.values().next().value;
    if (first) state.processedCommandIds.delete(first);
  }
  state.processedCommandIds.add(commandId);
}

const SSE_RECONNECT_DELAY_MS = 5_000;
const SSE_MAX_RECONNECT_DELAY_MS = 60_000;

function startSSECommandListener(state: AdapterState): void {
  if (!state.config.brainHubUrl || !state.config.accessToken) {
    log("info", "SSE command listener not started — no brainHubUrl or accessToken");
    return;
  }

  const eventBusUrl = process.env.EVENT_BUS_URL || state.config.brainHubUrl;
  const streamUrl = `${eventBusUrl}/api/events/stream`;

  let reconnectDelay = SSE_RECONNECT_DELAY_MS;

  function connect() {
    log("info", "Connecting to event bus SSE stream for command delivery", { url: streamUrl });

    const headers: Record<string, string> = {
      "x-access-token": state.config.accessToken || "",
      Accept: "text/event-stream",
    };

    fetch(streamUrl, {
      headers,
    }).then(async (response) => {
      if (!response.ok || !response.body) {
        log("warn", "SSE stream connection failed", { status: response.status });
        scheduleReconnect();
        return;
      }

      log("info", "SSE command stream connected", { url: streamUrl });
      reconnectDelay = SSE_RECONNECT_DELAY_MS;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let currentData = "";
          for (const line of lines) {
            if (line.startsWith("data:")) {
              currentData += line.slice(5).trim();
            } else if (line.trim() === "" && currentData) {
              processSSEEvent(state, currentData);
              currentData = "";
            }
          }
        }
      } catch (err) {
        log("warn", "SSE stream read error", { error: String(err) });
      }

      log("info", "SSE stream ended, reconnecting...");
      scheduleReconnect();
    }).catch((err) => {
      log("warn", "SSE stream connection error", { error: String(err) });
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    log("info", `SSE reconnecting in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, SSE_MAX_RECONNECT_DELAY_MS);
  }

  connect();
}

async function handleMigrationAnnounce(state: AdapterState, payload: Record<string, unknown>): Promise<void> {
  const migrationId = (payload.migrationId as string) || "";
  const targetUrl = (payload.targetUrl as string) || "";
  const oldUrl = (payload.oldUrl as string) || "";
  const deadline = (payload.deadline as string) || "";

  if (!targetUrl || !migrationId) {
    log("warn", "Migration announcement missing required fields", { migrationId, targetUrl });
    return;
  }

  log("info", "Received migration announcement", { migrationId, targetUrl, oldUrl, deadline });

  state.migration = {
    migrationId,
    targetUrl,
    oldUrl,
    deadline,
    status: "verifying",
    verifiedAt: null,
    migratedAt: null,
  };

  const verified = await verifyMigrationTarget(state, targetUrl);

  if (!verified) {
    state.migration.status = "failed";
    log("error", "Migration target verification failed — staying on current URL", { migrationId, targetUrl });
    await reportMigrationStatus(state, "failed", "Target verification failed — authority key mismatch or unreachable");
    return;
  }

  state.migration.status = "migrated";
  state.migration.verifiedAt = new Date().toISOString();
  state.migration.migratedAt = new Date().toISOString();

  const previousUrl = state.config.brainHubUrl;
  state.config.brainHubUrl = targetUrl;

  log("info", "Migration complete — switched to new Brain Hub URL", {
    migrationId,
    previousUrl,
    newUrl: targetUrl,
  });

  await registerWithBrainHub(state);

  await reportMigrationStatus(state, "migrated", null);
}

async function verifyMigrationTarget(state: AdapterState, targetUrl: string): Promise<boolean> {
  try {
    const url = `${targetUrl}/api/adapters/authority-key`;
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: brainHubHeaders(state.config.accessToken),
    }, 2);

    if (!res || !res.ok) {
      log("warn", "Migration target health check failed", { url, status: res?.status });
      return false;
    }

    const body = (await res.json()) as { publicKey?: string };
    if (!body.publicKey) {
      log("warn", "Migration target missing authority key");
      return false;
    }

    if (state.authorityPublicKey && body.publicKey !== state.authorityPublicKey) {
      log("error", "Migration target authority key mismatch — refusing migration", {
        expected: state.authorityPublicKey.substring(0, 16) + "...",
        got: body.publicKey.substring(0, 16) + "...",
      });
      return false;
    }

    log("info", "Migration target verified — authority key matches", {
      targetUrl,
      keyPrefix: body.publicKey.substring(0, 16) + "...",
    });
    return true;
  } catch (err) {
    log("error", "Migration target verification error", { error: String(err) });
    return false;
  }
}

async function handleMigrationRollback(state: AdapterState, payload: Record<string, unknown>): Promise<void> {
  const migrationId = (payload.migrationId as string) || "";
  const targetUrl = (payload.targetUrl as string) || "";
  const reason = (payload.reason as string) || "Unknown";

  if (!targetUrl) {
    log("warn", "Rollback announcement missing targetUrl");
    return;
  }

  if (state.migration && state.migration.migrationId !== migrationId) {
    log("warn", "Rollback migrationId mismatch — ignoring", {
      expected: state.migration.migrationId,
      received: migrationId,
    });
    return;
  }

  log("info", "Received migration rollback — verifying target", { migrationId, targetUrl, reason });

  const verified = await verifyMigrationTarget(state, targetUrl);
  if (!verified) {
    log("error", "Rollback target verification failed — refusing rollback", { migrationId, targetUrl });
    return;
  }

  if (state.migration) {
    state.migration.status = "rolled_back";
  }

  state.config.brainHubUrl = targetUrl;

  log("info", "Rolled back to previous Brain Hub URL", { targetUrl, migrationId, reason });

  await registerWithBrainHub(state);
  await reportMigrationStatus(state, "rolled_back", reason);
}

async function reportMigrationStatus(
  state: AdapterState,
  status: string,
  failureReason: string | null,
): Promise<void> {
  if (!state.config.brainHubUrl || !state.migration) return;

  const url = `${state.config.brainHubUrl}/api/adapters/migration/confirm`;
  const body = {
    migrationId: state.migration.migrationId,
    repoName: state.config.repoName,
    adapterId: state.identity?.adapterId,
    status,
    failureReason,
    timestamp: new Date().toISOString(),
  };

  try {
    await fetchWithRetry(url, {
      method: "POST",
      headers: brainHubHeaders(state.config.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }, 2);
    log("info", "Migration status reported to Brain Hub", { status });
  } catch (err) {
    log("warn", "Failed to report migration status", { error: String(err) });
  }
}

function processSSEEvent(state: AdapterState, dataStr: string): void {
  try {
    const event = JSON.parse(dataStr) as Record<string, unknown>;
    const eventType = (event.event_type as string) || "";

    if (eventType === "system.migration.announce") {
      const payload = (event.payload as Record<string, unknown>) || event;
      handleMigrationAnnounce(state, payload);
      return;
    }

    if (eventType === "system.migration.rollback") {
      const payload = (event.payload as Record<string, unknown>) || event;
      handleMigrationRollback(state, payload);
      return;
    }

    if (eventType !== "adapter.command.execute") return;

    const payload = (event.payload as Record<string, unknown>) || {};
    const targetAdapterId = payload.adapterId as string;
    const targetRepoName = payload.repoName as string;

    if (targetAdapterId && state.identity && targetAdapterId !== state.identity.adapterId) {
      return;
    }
    if (targetRepoName && targetRepoName !== state.config.repoName) {
      return;
    }

    const sseCommandId = (payload.commandId as string) || "";
    if (sseCommandId && state.processedCommandIds.has(sseCommandId)) {
      log("info", "Duplicate command delivery (idempotent skip)", { commandId: sseCommandId, transport: "sse" });
      return;
    }

    log("info", "Received COMMAND_EXECUTE via SSE", {
      commandId: sseCommandId,
      commandType: payload.commandType as string,
    });

    const envelope = payload.envelope as Record<string, unknown>;
    if (!envelope) {
      log("warn", "SSE command missing envelope — skipping");
      return;
    }

    const auth = authenticateRequest(
      state,
      {},
      envelope,
    );

    const commandId = (envelope.commandId as string) || "";

    if (!auth.authenticated) {
      log("warn", "SSE command authentication failed", {
        mode: auth.mode,
        reason: auth.reason,
        commandId,
      });
      emitSecurityViolation(state, commandId, auth.reason || "SSE command authentication failed");
      return;
    }

    if (auth.mode !== "ed25519") {
      const reason = `COMMAND_EXECUTE via SSE requires Ed25519, got: ${auth.mode}`;
      log("warn", reason, { commandId });
      emitSecurityViolation(state, commandId, reason);
      return;
    }

    const action = (envelope.action as string) || "";
    if (!action.startsWith("COMMAND_EXECUTE:")) {
      log("warn", "SSE command has non-execute action — skipping", { action });
      return;
    }

    if (sseCommandId) trackProcessedCommand(state, sseCommandId);

    const commandType = action.replace("COMMAND_EXECUTE:", "");
    const cmdPayload = (envelope.payload as Record<string, unknown>) || {};
    const execResult = handleExecuteCommand(commandType, cmdPayload, state);

    log("info", "SSE execute command processed", {
      commandType,
      success: execResult.success,
      commandId,
    });

    emitResultEvent(state, commandId, commandType, action, execResult.success, execResult.result);
  } catch (err) {
    log("warn", "Failed to process SSE event", { error: String(err) });
  }
}

export function createAdapter(config: AdapterConfig): {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  init: () => Promise<void>;
  getIdentity: () => AdapterIdentity | null;
  getState: () => { identityLoaded: boolean; authorityKeyLoaded: boolean };
} {
  const missing: string[] = [];
  if (!config.brainHubUrl) missing.push("brainHubUrl (env: BRAIN_HUB_URL)");
  if (!config.repoName) missing.push("repoName (env: REPO_NAME)");
  if (!config.accessToken) missing.push("accessToken (env: ACCESS_TOKEN or BRAIN_HUB_TOKEN)");
  if (missing.length > 0) {
    const msg = `Reality Adapter: missing required configuration: ${missing.join(", ")}`;
    log("error", msg);
    throw new Error(msg);
  }

  const state: AdapterState = {
    identity: null,
    authorityPublicKey: null,
    nonceWindow: [],
    processedCommandIds: new Set<string>(),
    config: {
      ...config,
      port: config.port ?? 9000,
      allowInsecureBrainHub: config.allowInsecureBrainHub ?? false,
      requireSignedCommands: config.requireSignedCommands ?? false,
    },
    capabilities: config.capabilities ?? DEFAULT_CAPABILITIES,
    migration: null,
  };

  return {
    handler: (req, res) => handleRequest(state, req, res),
    init: async () => {
      state.identity = loadOrCreateIdentity(state);

      if (state.config.brainHubUrl) {
        state.authorityPublicKey = await fetchAuthorityKey(state);
        await registerWithBrainHub(state);
        startSSECommandListener(state);
      } else {
        log("info", "brainHubUrl not set — running in standalone/fallback mode");
      }
    },
    getIdentity: () => state.identity,
    getState: () => ({
      identityLoaded: !!state.identity,
      authorityKeyLoaded: !!state.authorityPublicKey,
    }),
  };
}

export async function startAdapter(config: AdapterConfig): Promise<http.Server> {
  const port = config.port ?? 9000;
  const adapter = createAdapter(config);

  await adapter.init();

  const server = http.createServer(adapter.handler);
  const adapterState = adapter.getState();
  const requireSigned = config.requireSignedCommands ?? false;
  const authMode = requireSigned
    ? "STRICT (signed only)"
    : adapterState.authorityKeyLoaded
      ? "signed-ready"
      : "fallback";
  const brainHubStatus = adapterState.authorityKeyLoaded ? "connected" : "fallback";

  return new Promise<http.Server>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      log("info", "Reality Adapter started", {
        port,
        adapterId: adapter.getIdentity()?.adapterId,
        version: ADAPTER_VERSION,
        capabilities: config.capabilities ?? DEFAULT_CAPABILITIES,
        authMode,
        brainHub: brainHubStatus,
        requireSignedCommands: requireSigned,
        identityLoaded: adapterState.identityLoaded,
        authorityKeyLoaded: adapterState.authorityKeyLoaded,
      });

      console.log("");
      console.log("=== Reality Adapter Online ===");
      console.log(`  Adapter ID: ${adapter.getIdentity()?.adapterId}`);
      console.log(`  Version:    ${ADAPTER_VERSION}`);
      console.log(`  Port:       ${port}`);
      console.log(`  Auth Mode:  ${authMode}`);
      console.log(`  Brain Hub:  ${brainHubStatus}`);
      console.log(`  Enforce:    ${requireSigned ? "SIGNED ONLY" : "fallback allowed"}`);
      console.log(`  Cap Level:  ${ADAPTER_CAPABILITY_LEVEL}`);
      console.log(`  SSE Cmds:   ${adapterState.authorityKeyLoaded ? "listening" : "disabled"}`);
      console.log(`  Endpoints:`);
      console.log(`    GET  /api/reality/status`);
      console.log(`    POST /api/reality/execute`);
      console.log(`    GET  /api/reality/healthz`);
      console.log(`    GET  /healthz`);
      console.log(`    GET  /.well-known/system.identity`);
      console.log(`  Execute Commands:`);
      console.log(`    EXEC_SCRIPT | WRITE_FILE | RESTART_SERVICE | RUN_MIGRATION`);
      console.log("==============================");
      console.log("");

      resolve(server);
    });
  });
}

export { ADAPTER_VERSION, ADAPTER_CAPABILITY_LEVEL, DEFAULT_CAPABILITIES };

if (typeof require !== "undefined" && require.main === module) {
  const repoName = process.env.REPO_NAME;
  if (!repoName) {
    console.error("ERROR: REPO_NAME environment variable is required");
    process.exit(1);
  }

  const config: AdapterConfig = {
    brainHubUrl: process.env.BRAIN_HUB_URL || "https://migration-hub.replit.app",
    repoName,
    accessToken: process.env.ACCESS_TOKEN,
    port: parseInt(process.env.PORT || "9000", 10),
    adapterId: process.env.ADAPTER_ID,
    adapterPrivateKey: process.env.ADAPTER_PRIVATE_KEY,
    allowInsecureBrainHub: process.env.ALLOW_INSECURE_BRAIN_HUB === "true",
    requireSignedCommands: process.env.REQUIRE_SIGNED_COMMANDS === "true",
    realitySecret: process.env.REALITY_SECRET,
  };

  startAdapter(config).catch((err) => {
    console.error("Failed to start adapter:", err);
    process.exit(1);
  });
}
