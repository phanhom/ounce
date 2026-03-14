import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const KEY_DIR = path.join(os.homedir(), ".paperclip");
const KEY_FILE = path.join(KEY_DIR, "worker-key");

export function ensureWorkerKey(): string {
  if (fs.existsSync(KEY_FILE)) {
    const existing = fs.readFileSync(KEY_FILE, "utf-8").trim();
    if (existing.length >= 32) return existing;
  }

  const key = "pclip_wk_" + crypto.randomBytes(48).toString("base64url");

  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });

  return key;
}

export function getKeyFilePath(): string {
  return KEY_FILE;
}
