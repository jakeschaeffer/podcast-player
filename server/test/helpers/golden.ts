import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** contracts/golden at the repository root: shared test cases the Swift ports must reproduce exactly. */
export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "golden");

/**
 * The committed golden file at `relPath`, after rewriting it from `actual` when UPDATE_GOLDEN=1. Tests compare the
 * two, so a behaviour change in the reference implementation fails until the file is deliberately re-recorded
 * (under a new version when the change is real; see contracts/golden/README.md). Same helper as web/test/golden.ts.
 */
export function golden<T>(relPath: string, actual: T): T {
  const path = join(GOLDEN_DIR, relPath);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${compactJson(actual)}\n`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Indented JSON, except that any object or array short enough to fit on one line is written on one line. */
export function compactJson(value: unknown, indent = ""): string {
  const flat = JSON.stringify(value);
  if (flat === undefined || flat.length + indent.length <= 120 || value === null || typeof value !== "object") return flat ?? "null";
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + compactJson(v, inner)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`).join(",\n")}\n${indent}}`;
}
