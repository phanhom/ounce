import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const KEY_DIR = path.join(os.homedir(), ".paperclip");
const PRIVATE_KEY_FILE = path.join(KEY_DIR, "worker-key");
const PUBLIC_KEY_FILE = path.join(KEY_DIR, "worker-key.pub");

export interface WorkerKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  fingerprint: string;
}

/**
 * Ensure an Ed25519 key pair exists at ~/.paperclip/worker-key{,.pub}.
 * If missing or corrupted, generate a fresh pair.
 */
export function ensureKeyPair(): WorkerKeyPair {
  if (fs.existsSync(PRIVATE_KEY_FILE) && fs.existsSync(PUBLIC_KEY_FILE)) {
    try {
      const privateKeyPem = fs.readFileSync(PRIVATE_KEY_FILE, "utf-8").trim();
      const publicKeyPem = fs.readFileSync(PUBLIC_KEY_FILE, "utf-8").trim();
      const keyObj = crypto.createPrivateKey(privateKeyPem);
      if (keyObj.asymmetricKeyType === "ed25519") {
        return { privateKeyPem, publicKeyPem, fingerprint: computeFingerprint(publicKeyPem) };
      }
    } catch {
      // corrupted — regenerate below
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY_FILE, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_FILE, publicKey, { mode: 0o644 });

  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    fingerprint: computeFingerprint(publicKey),
  };
}

/**
 * SHA256 fingerprint of the public key, displayed as `SHA256:<base64>`.
 * Similar to `ssh-keygen -lf key.pub`.
 */
export function computeFingerprint(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const hash = crypto.createHash("sha256").update(der).digest("base64");
  return `SHA256:${hash}`;
}

/**
 * Sign a challenge nonce with the worker's private key.
 */
export function signChallenge(privateKeyPem: string, challenge: string): string {
  return crypto.sign(null, Buffer.from(challenge), privateKeyPem).toString("base64");
}

/**
 * Verify a signature against a public key and challenge.
 * Usable on both worker and server side.
 */
export function verifySignature(publicKeyPem: string, challenge: string, signatureBase64: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(challenge), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export function getKeyDir(): string {
  return KEY_DIR;
}

export function getPrivateKeyPath(): string {
  return PRIVATE_KEY_FILE;
}

export function getPublicKeyPath(): string {
  return PUBLIC_KEY_FILE;
}
