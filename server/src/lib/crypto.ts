import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Application-layer encryption for feed and enclosure URLs, which carry private-feed credentials.
 * AES-256-GCM with a per-value nonce; the key is derived from APP_SECRET and lives outside the database.
 */
export class Secrets {
  private readonly key: Buffer;
  private readonly mac: Buffer;

  constructor(appSecret: string) {
    if (appSecret.length < 16) throw new Error("APP_SECRET must be at least 16 characters");
    this.key = createHash("sha256").update(`enc:${appSecret}`).digest();
    this.mac = createHash("sha256").update(`mac:${appSecret}`).digest();
  }

  encrypt(plain: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Buffer): string {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const body = blob.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  /** Deterministic keyed hash for uniqueness checks on encrypted values (feed URLs). */
  hash(value: string): string {
    return createHmac("sha256", this.mac).update(value).digest("hex");
  }

  /** HMAC used by signed media URLs. */
  sign(message: string): string {
    return createHmac("sha256", this.mac).update(message).digest("base64url");
  }

  verify(message: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(message));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

/** Device tokens are stored hashed; the plain token is shown once. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newDeviceToken(): string {
  return `pp_${randomBytes(24).toString("base64url")}`;
}
