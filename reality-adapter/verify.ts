import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const NONCE_WINDOW_SIZE = 1000;
const NONCE_EXPIRY_MS = 5 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 30_000;

export interface NonceEntry {
  nonce: string;
  timestamp: number;
}

export interface CommandEnvelope {
  commandId: string;
  adapterId: string;
  action: string;
  payload: Record<string, unknown>;
  nonce: string;
  timestamp: number;
  signature: string;
  authorityPublicKey?: string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

export interface AttestationReport {
  adapterId: string;
  version: string;
  capabilitiesHash: string;
  codeChecksum: string;
  publicKey: string;
  lastVerifiedAt: string;
}

function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  if (typeof obj === "object") {
    const sorted = Object.keys(obj as Record<string, unknown>).sort();
    const pairs = sorted.map(
      (k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k]),
    );
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(obj);
}

function canonicalizeEnvelope(envelope: Record<string, unknown>): string {
  const fields: Record<string, unknown> = {
    commandId: envelope.commandId ?? "",
    adapterId: envelope.adapterId ?? "",
    action: envelope.action ?? "",
    payload: envelope.payload ?? {},
    nonce: envelope.nonce ?? "",
    timestamp: envelope.timestamp ?? 0,
  };
  return stableStringify(fields);
}

export function verifyCommandSignature(
  envelope: CommandEnvelope,
  authorityPublicKeyHex: string,
): VerificationResult {
  try {
    if (!envelope.signature || !authorityPublicKeyHex) {
      return { valid: false, reason: "Missing signature or authority public key" };
    }

    const envelopeData: Record<string, unknown> = {
      commandId: envelope.commandId,
      adapterId: envelope.adapterId,
      action: envelope.action,
      payload: envelope.payload,
      nonce: envelope.nonce,
      timestamp: envelope.timestamp,
    };

    const canonical = canonicalizeEnvelope(envelopeData);
    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.from(authorityPublicKeyHex, "hex"),
      format: "der",
      type: "spki",
    });

    const valid = crypto.verify(
      null,
      Buffer.from(canonical, "utf-8"),
      pubKeyObj,
      Buffer.from(envelope.signature, "hex"),
    );

    return valid
      ? { valid: true }
      : { valid: false, reason: "Signature verification failed" };
  } catch (err) {
    return {
      valid: false,
      reason: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function checkReplayProtection(
  nonce: string,
  timestamp: number,
  nonceWindow: NonceEntry[],
): VerificationResult {
  const now = Date.now();

  if (now - timestamp > NONCE_EXPIRY_MS) {
    return { valid: false, reason: `Timestamp expired: ${now - timestamp}ms old (max ${NONCE_EXPIRY_MS}ms)` };
  }

  if (timestamp > now + FUTURE_TOLERANCE_MS) {
    return { valid: false, reason: "Timestamp is in the future" };
  }

  const seen = nonceWindow.find((entry) => entry.nonce === nonce);
  if (seen) {
    return { valid: false, reason: `Nonce already seen: ${nonce}` };
  }

  nonceWindow.push({ nonce, timestamp: now });

  while (nonceWindow.length > NONCE_WINDOW_SIZE) {
    nonceWindow.shift();
  }

  const cutoff = now - NONCE_EXPIRY_MS;
  while (nonceWindow.length > 0 && nonceWindow[0].timestamp < cutoff) {
    nonceWindow.shift();
  }

  return { valid: true };
}

export function generateAttestation(
  adapterId: string,
  version: string,
  capabilities: string[],
  entryFilePath: string,
  publicKeyHex: string,
): AttestationReport {
  const sortedCapabilities = [...capabilities].sort();
  const capabilitiesHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(sortedCapabilities))
    .digest("hex");

  let codeChecksum = "";
  try {
    const resolvedPath = path.resolve(entryFilePath);
    const fileContent = fs.readFileSync(resolvedPath, "utf-8");
    codeChecksum = crypto.createHash("sha256").update(fileContent).digest("hex");
  } catch {
    codeChecksum = "unavailable";
  }

  return {
    adapterId,
    version,
    capabilitiesHash,
    codeChecksum,
    publicKey: publicKeyHex,
    lastVerifiedAt: new Date().toISOString(),
  };
}
