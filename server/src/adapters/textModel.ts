import { type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type GenerateRequest<S extends TSchema> = {
  /** Instructions. Episode speech is never placed here. */
  system: string;
  /** Content, including transcript text, wrapped in delimiters by the caller. */
  user: string;
  schema: S;
  timeout_ms?: number;
};

export type GenerateResult<T> = {
  data: T;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  elapsed_ms: number;
};

/**
 * The only interface the rest of the system knows about language models: a prompt and a JSON schema in,
 * validated JSON out. Adapters must reject output that does not match the schema.
 */
export interface TextModel {
  readonly name: string;
  generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>>;
}

export class SchemaMismatchError extends Error {
  constructor(message: string, readonly raw: unknown) {
    super(message);
    this.name = "SchemaMismatchError";
  }
}

/** Parse and validate model output against the schema; adapters call this before returning. */
export function parseAgainstSchema<S extends TSchema>(schema: S, raw: unknown): Static<S> {
  if (raw === undefined || raw === null) throw new SchemaMismatchError("model returned no output", raw);
  let value = raw;
  if (typeof raw === "string") {
    const text = stripFences(raw);
    try {
      value = JSON.parse(text);
    } catch {
      throw new SchemaMismatchError("model output is not JSON", raw);
    }
  }
  const cleaned = Value.Clean(schema, Value.Default(schema, value));
  if (!Value.Check(schema, cleaned)) {
    const first = Value.Errors(schema, cleaned).First();
    throw new SchemaMismatchError(`model output does not match schema: ${first?.path ?? ""} ${first?.message ?? ""}`.trim(), raw);
  }
  return cleaned as Static<S>;
}

function stripFences(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1]! : s.trim();
}

/** Wrap untrusted content so the instructions can refer to it unambiguously. */
export function delimited(tag: string, content: string): string {
  const safe = content.replace(new RegExp(`</?${tag}>`, "gi"), "");
  return `<${tag}>\n${safe}\n</${tag}>`;
}
