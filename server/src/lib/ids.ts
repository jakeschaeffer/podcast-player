import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

/** Sortable, URL-safe 26-character ids for every row. */
export function newId(): string {
  return ulid();
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 100 random bits as 20 lowercase base32 characters: unguessable, readable, safe in a URL. */
export function newShareToken(): string {
  const bytes = randomBytes(13);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) >>> 0;
    bits += 8;
    while (bits >= 5 && out.length < 20) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export const SHARE_TOKEN_RE = /^[a-z2-7]{20}$/;
