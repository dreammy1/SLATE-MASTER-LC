import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getCandidateKeys(): Buffer[] {
  const keys: Buffer[] = [];
  const raw = process.env.ENCRYPTION_SECRET;
  if (raw && typeof raw === "string" && raw.trim().length > 0) {
    const trimmed = raw.trim();
    // 1. If 64-character hex string (exactly 32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      keys.push(Buffer.from(trimmed, "hex"));
    }
    // 2. If exactly 32-byte utf-8 string
    if (Buffer.byteLength(trimmed, "utf8") === 32) {
      keys.push(Buffer.from(trimmed, "utf8"));
    }
    // 3. SHA-256 digest of the secret (always exactly 32 bytes)
    keys.push(crypto.createHash("sha256").update(trimmed, "utf8").digest());
  }
  // 4. Default scrypt fallback key (always exactly 32 bytes)
  keys.push(crypto.scryptSync("slate-devops-fallback-key-2026", "salt", 32));
  return keys;
}

function getPrimaryKey(): Buffer {
  return getCandidateKeys()[0];
}

export function encryptSecret(plainText: string): string {
  if (plainText === "" || plainText === undefined || plainText === null) return "";
  const key = getPrimaryKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(String(plainText), "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptSecret(encryptedPayload: string): string {
  if (!encryptedPayload || typeof encryptedPayload !== "string") return "";
  const parts = encryptedPayload.split(":");
  if (parts.length !== 3) {
    // Plain text or unencrypted fallback
    return encryptedPayload;
  }
  const [ivHex, authTagHex, encryptedData] = parts;
  if (!ivHex || !authTagHex || !encryptedData) {
    return encryptedPayload;
  }

  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const candidateKeys = getCandidateKeys();

    for (const key of candidateKeys) {
      try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedData, "hex", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
      } catch {
        // Try next candidate key
      }
    }
  } catch {
    // Return original payload safely
  }

  return encryptedPayload;
}
