import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../lib/config.js";
import { CodexCliTextModel, strictSchema } from "./codex-cli.js";

describe("strictSchema", () => {
  it("forbids additional properties and requires every property at every level", () => {
    const schema = Type.Object({
      preview: Type.String(),
      takeaways: Type.Array(Type.Object({ text: Type.String(), sentence_id: Type.Integer() })),
      nested: Type.Object({ kind: Type.Union([Type.Literal("a"), Type.Literal("b")]), inner: Type.Object({ n: Type.Number() }) }),
    });
    const strict = strictSchema(JSON.parse(JSON.stringify(schema))) as Record<string, unknown>;
    expect(strict["additionalProperties"]).toBe(false);
    expect(strict["required"]).toEqual(["preview", "takeaways", "nested"]);
    const items = ((strict["properties"] as Record<string, unknown>)["takeaways"] as Record<string, unknown>)["items"] as Record<string, unknown>;
    expect(items["additionalProperties"]).toBe(false);
    expect(items["required"]).toEqual(["text", "sentence_id"]);
    const nested = (strict["properties"] as Record<string, unknown>)["nested"] as Record<string, unknown>;
    const inner = (nested["properties"] as Record<string, unknown>)["inner"] as Record<string, unknown>;
    expect(inner["additionalProperties"]).toBe(false);
    expect(inner["required"]).toEqual(["n"]);
  });

  it("leaves non-object schemas alone", () => {
    expect(strictSchema({ type: "string", maxLength: 5 })).toEqual({ type: "string", maxLength: 5 });
  });
});

describe("CodexCliTextModel", () => {
  /** A stand-in `codex` that records its arguments and answers through `-o`, so no real call is made. */
  async function fakeCodex(): Promise<{ bin: string; args: () => Promise<string[]>; done: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    const bin = join(dir, "codex");
    const log = join(dir, "args.json");
    await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
require("fs").writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ ok: true }));
`);
    await chmod(bin, 0o755);
    return { bin, args: async () => JSON.parse(await readFile(log, "utf8")) as string[], done: () => rm(dir, { recursive: true, force: true }) };
  }
  const req = { system: "s", user: "u", schema: Type.Object({ ok: Type.Boolean() }) };

  it("passes the effort and the service tier, and names both in the model label", async () => {
    const fake = await fakeCodex();
    try {
      const res = await new CodexCliTextModel({ bin: fake.bin, reasoningEffort: "medium", serviceTier: "priority" }).generate(req);
      const args = await fake.args();
      expect(args).toContain('model_reasoning_effort="medium"');
      expect(args).toContain('service_tier="priority"');
      expect(args).toContain("--ignore-user-config");
      expect(res).toMatchObject({ data: { ok: true }, model: "codex-default/medium/priority" });
    } finally {
      await fake.done();
    }
  });

  it("leaves the tier alone when none is set", async () => {
    const fake = await fakeCodex();
    try {
      await new CodexCliTextModel({ bin: fake.bin, reasoningEffort: "low" }).generate(req);
      expect((await fake.args()).some((a) => a.startsWith("service_tier"))).toBe(false);
    } finally {
      await fake.done();
    }
  });
});

describe("snip Codex settings", () => {
  const base = { APP_SECRET: "x", OWNER_PASSWORD: "y", CODEX_REASONING_EFFORT: "low" };
  it("fall back to the general effort and the standard tier", () => {
    expect(loadConfig(base)).toMatchObject({ codexReasoningEffort: "low", snipCodexReasoningEffort: "low", snipCodexServiceTier: "" });
  });
  it("leave background work on the standard tier unless CODEX_BACKGROUND_SERVICE_TIER says otherwise", () => {
    expect(loadConfig({ ...base, CODEX_SERVICE_TIER: "priority" })).toMatchObject({ codexServiceTier: "priority", codexBackgroundServiceTier: "" });
    expect(loadConfig({ ...base, CODEX_BACKGROUND_SERVICE_TIER: "priority" })).toMatchObject({ codexBackgroundServiceTier: "priority" });
  });
  it("take the general service tier unless their own is set", () => {
    expect(loadConfig({ ...base, CODEX_SERVICE_TIER: "priority" })).toMatchObject({ codexServiceTier: "priority", snipCodexServiceTier: "priority" });
    expect(loadConfig({ ...base, CODEX_SERVICE_TIER: "priority", CODEX_SNIP_SERVICE_TIER: "flex" })).toMatchObject({ codexServiceTier: "priority", snipCodexServiceTier: "flex" });
  });
  it("can be set apart from the rest", () => {
    expect(loadConfig({ ...base, CODEX_SNIP_REASONING_EFFORT: "medium", CODEX_SNIP_SERVICE_TIER: "priority" })).toMatchObject({ codexReasoningEffort: "low", snipCodexReasoningEffort: "medium", snipCodexServiceTier: "priority" });
  });
});
