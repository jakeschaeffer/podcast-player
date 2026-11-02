import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "@sinclair/typebox";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "./textModel.js";

export type CodexCliOptions = {
  /** Binary name or path. */
  bin?: string;
  /** Model override; empty uses the CLI default. */
  model?: string;
  /** `low`, `medium`, or `high`; empty uses the CLI default. Boundary picking needs little reasoning. */
  reasoningEffort?: string;
  defaultTimeoutMs?: number;
};

/**
 * TextModel over `codex exec`, which uses the owner's ChatGPT subscription (docs/codex-routines.md).
 * Each call runs in a fresh empty directory with a read-only sandbox, no session persistence, and a
 * JSON schema for the final message, and without the owner's personal config (no MCP servers, no tools).
 * The model never sees the repository or the database.
 */
export class CodexCliTextModel implements TextModel {
  readonly name = "codex-cli";
  private readonly bin: string;
  private readonly model: string;
  private readonly reasoningEffort: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: CodexCliOptions = {}) {
    this.bin = options.bin ?? "codex";
    this.model = options.model ?? "";
    this.reasoningEffort = options.reasoningEffort ?? "";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 180_000;
  }

  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "codex-job-"));
    try {
      const schemaPath = join(dir, "schema.json");
      const outPath = join(dir, "last.json");
      await writeFile(schemaPath, JSON.stringify(strictSchema(req.schema)));
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ephemeral",
        "--sandbox", "read-only",
        "--color", "never",
        "--json",
        "-C", dir,
        "--output-schema", schemaPath,
        "-o", outPath,
      ];
      if (this.model) args.push("-m", this.model);
      if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      args.push("-");
      const prompt = `${req.system.trim()}\n\n${req.user.trim()}\n`;
      const { stdout, stderr, code } = await run(this.bin, args, prompt, req.timeout_ms ?? this.defaultTimeoutMs);
      if (code !== 0) {
        const reported = errorFromEvents(stdout);
        throw new Error(`codex exec exited ${code}: ${reported ?? stderr.split("\n").filter((l) => !/rmcp::transport/.test(l)).join("\n").trim().slice(-1000)}`);
      }
      const raw = await readFile(outPath, "utf8").catch(() => "");
      if (!raw.trim()) throw new Error(`codex exec produced no final message: ${stderr.trim().slice(-500)}`);
      const data = parseAgainstSchema(req.schema, raw);
      const usage = usageFromEvents(stdout);
      return { data, model: usage.model ?? (this.model || `codex-default${this.reasoningEffort ? `/${this.reasoningEffort}` : ""}`), ...usage.tokens, elapsed_ms: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function run(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex exec timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.stdin.end(stdin);
  });
}

/**
 * The strict structured-output mode behind `--output-schema` requires every object to forbid additional
 * properties and to list every property as required. Apply that to any schema recursively.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "properties" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strictSchema(pv)]));
    } else if (k === "items" || k === "anyOf" || k === "oneOf" || k === "allOf" || k === "not") {
      out[k] = strictSchema(v);
    } else {
      out[k] = v;
    }
  }
  if (out["type"] === "object" || out["properties"]) {
    out["additionalProperties"] = false;
    if (out["properties"] && typeof out["properties"] === "object") out["required"] = Object.keys(out["properties"] as Record<string, unknown>);
  }
  return out;
}

/** The first `error` event's message from the JSONL stream, if any. */
function errorFromEvents(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; message?: string; error?: { message?: string } };
      if (ev.type === "error" || ev.type === "turn.failed") {
        const raw = ev.message ?? ev.error?.message ?? "";
        try {
          const inner = JSON.parse(raw) as { error?: { message?: string } };
          return inner.error?.message ?? raw;
        } catch {
          return raw;
        }
      }
    } catch {
      // not an event line
    }
  }
  return null;
}

/** Best-effort token usage from the JSONL event stream; absent fields are simply omitted. */
function usageFromEvents(jsonl: string): { model?: string; tokens: { input_tokens?: number; output_tokens?: number } } {
  const out: { model?: string; tokens: { input_tokens?: number; output_tokens?: number } } = { tokens: {} };
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const usage = (ev["usage"] ?? (ev["payload"] as Record<string, unknown> | undefined)?.["usage"]) as Record<string, number> | undefined;
      if (usage) {
        if (typeof usage["input_tokens"] === "number") out.tokens.input_tokens = usage["input_tokens"];
        if (typeof usage["output_tokens"] === "number") out.tokens.output_tokens = usage["output_tokens"];
      }
      const model = ev["model"] ?? (ev["payload"] as Record<string, unknown> | undefined)?.["model"];
      if (typeof model === "string") out.model = model;
    } catch {
      // not an event line
    }
  }
  return out;
}
