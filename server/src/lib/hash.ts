import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** The SHA-256 of a file on disk, hex: the name a recording or clip is stored under (content-addressed). */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
