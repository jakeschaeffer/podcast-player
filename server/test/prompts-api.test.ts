import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import type { AppContext } from "../src/app/context.js";
import { sentencize } from "../src/core/snip/sentencize.js";
import { summarizeSnip } from "../src/core/summary/snip.js";
import { buildApp } from "../src/http/app.js";
import { drain } from "../src/jobs/worker.js";
import { testContext } from "./helpers/context.js";
import { buildTranscript } from "./helpers/transcript.js";

/** Answers every call with a valid reply, a judge's 4 for titles, and remembers the instructions it was sent. */
class ScriptedModel implements TextModel {
  readonly name = "scripted";
  readonly systems: string[] = [];
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    this.systems.push(req.system);
    const props = (req.schema as { properties?: Record<string, unknown> }).properties ?? {};
    const data = "score" in props
      ? { score: 4, missing: "nothing" }
      : { title: "A flat fee nobody upgraded from", bullets: [{ text: "Almost nobody upgrades.", sentence_ids: [0] }], quote: "" };
    return { data: parseAgainstSchema(req.schema, data), model: "scripted", elapsed_ms: 0 };
  }
}

const titleCase = (id: string) => ({
  id, source: "readwise", show: "Pricing Talk", episode: "Flat fees", excerpt: [{ speaker: "guest", text: "We tried a flat monthly fee for everyone. Almost nobody upgraded." }],
  excerpt_words: 11, reference_title: "Flat fee, nobody upgraded", origin: "manual", origin_confidence: "high", origin_reasons: [], meta: {}, tags: [],
});

describe("prompts and evals API", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let token: string;
  let promptsDir: string;
  const model = new ScriptedModel();
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    // Work on copies: the API writes prompt files and the registry, and runs write result files.
    promptsDir = mkdtempSync(join(tmpdir(), "pp-prompts-"));
    cpSync(join(dirname(fileURLToPath(import.meta.url)), "../prompts"), promptsDir, { recursive: true });
    // Production adds and activates versions through this same API (and commits them), so pin the copy to each
    // prompt's v1 and the test doesn't depend on what the owner has activated since.
    const registryFile = join(promptsDir, "registry.json");
    const registry = JSON.parse(readFileSync(registryFile, "utf8")) as Record<string, { active: string; versions: Record<string, unknown> }>;
    for (const [name, entry] of Object.entries(registry)) {
      for (const version of Object.keys(entry.versions)) if (version !== "v1") rmSync(join(promptsDir, name, `${version}.md`));
      registry[name] = { active: "v1", versions: { v1: entry.versions.v1 } };
    }
    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
    const evalsDir = mkdtempSync(join(tmpdir(), "pp-evals-"));
    mkdirSync(join(evalsDir, "snip-titles/cases"), { recursive: true });
    writeFileSync(join(evalsDir, "snip-titles/cases/readwise.jsonl"), [titleCase("rw-1"), titleCase("rw-2")].map((c) => JSON.stringify(c)).join("\n") + "\n");
    process.env.PROMPTS_DIR = promptsDir;
    process.env.EVALS_DIR = evalsDir;
    ctx = testContext({ textModel: model });
    app = await buildApp(ctx);
    token = (await app.inject({ method: "POST", url: "/v1/devices", payload: { name: "test", platform: "cli", password: "hunter2" } })).json().token;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.PROMPTS_DIR;
    delete process.env.EVALS_DIR;
  });

  it("needs the owner", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/prompts" })).statusCode).toBe(401);
  });

  it("lists every prompt with its versions and the active one", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/prompts", headers: auth() });
    expect(res.statusCode).toBe(200);
    const prompts = res.json() as { name: string; active: string; in_use: boolean; eval: { id: string } | null; versions: { version: string; active: boolean }[] }[];
    expect(prompts.map((p) => p.name)).toEqual(["snip-summary", "episode-summary", "span-picker", "speakers", "title-judge"]);
    const snip = prompts[0]!;
    expect(snip).toMatchObject({ active: "v1", in_use: true, eval: { id: "titles" } });
    expect(snip.versions[0]).toMatchObject({ version: "v1", active: true });
    expect(prompts[2]!.in_use).toBe(false); // the start picker also needs SELECTION_MODEL=on
  });

  it("saves new text as the next version, without activating it, and refuses a duplicate", async () => {
    const v1 = (await app.inject({ method: "GET", url: "/v1/prompts/snip-summary/versions/v1", headers: auth() })).json() as { text: string; previous: unknown };
    expect(v1.previous).toBeNull();
    const text = `${v1.text}\n- Keep the concrete answer, number, or analogy in the title.`;
    const res = await app.inject({ method: "POST", url: "/v1/prompts/snip-summary/versions", headers: auth(), payload: { text } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ version: "v2", active: false, text: text.trim(), previous: { version: "v1", text: v1.text } });
    const file = join(promptsDir, "snip-summary/v2.md");
    const registry = JSON.parse(readFileSync(join(promptsDir, "registry.json"), "utf8"));
    expect(registry["snip-summary"].active).toBe("v1");
    expect(registry["snip-summary"].versions.v2.sha256).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));

    const again = await app.inject({ method: "POST", url: "/v1/prompts/snip-summary/versions", headers: auth(), payload: { text } });
    expect(again.statusCode).toBe(409);
  });

  it("activates a version for the next model call", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/prompts/snip-summary/active", headers: auth(), payload: { version: "v2" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: "v2" });
    const excerpt = sentencize(buildTranscript([{ speaker: "guest", text: "We tried a flat monthly fee for everyone. Almost nobody upgraded." }]));
    const out = await summarizeSnip({ excerpt, context: { show_title: "Pricing Talk", episode_title: "Flat fees" } }, model);
    expect(out.prompt_version).toBe("v2");
    expect(model.systems.at(-1)).toMatch(/Keep the concrete answer/);
  });

  it("runs an eval on a version in the background and scores it", async () => {
    const started = await app.inject({ method: "POST", url: "/v1/evals/titles/runs", headers: auth(), payload: { version: "v2" } });
    expect(started.statusCode).toBe(202);
    const run = started.json() as { id: string; status: string; version: string };
    expect(run).toMatchObject({ status: "queued", version: "v2" });
    // Asking again while it waits returns the same run.
    expect((await app.inject({ method: "POST", url: "/v1/evals/titles/runs", headers: auth(), payload: { version: "v2" } })).json().id).toBe(run.id);

    await drain(ctx, { kinds: ["eval_run"] });
    const detail = (await app.inject({ method: "GET", url: `/v1/evals/titles/runs/${run.id}`, headers: auth() })).json() as { run: { status: string; score: { passed: number; n: number } }; cases: { pass: boolean; expected: string; actual: string }[] };
    expect(detail.run).toMatchObject({ status: "done", score: { passed: 2, n: 2 } });
    expect(detail.cases[0]).toMatchObject({ pass: true, expected: "Flat fee, nobody upgraded", actual: "A flat fee nobody upgraded from" });
    expect(existsSync(join(process.env.EVALS_DIR!, `snip-titles/results/${run.id}-titles.md`))).toBe(true);

    const prompts = (await app.inject({ method: "GET", url: "/v1/prompts", headers: auth() })).json() as { versions: { version: string; score: { rate: number } | null }[] }[];
    expect(prompts[0]!.versions.find((v) => v.version === "v2")!.score).toMatchObject({ rate: 1 });
    const version = (await app.inject({ method: "GET", url: "/v1/prompts/snip-summary/versions/v2", headers: auth() })).json() as { runs: { id: string }[] };
    expect(version.runs.map((r) => r.id)).toEqual([run.id]);
  });

  it("rejects unknown prompts, versions, and evals", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/prompts/nope/versions/v1", headers: auth() })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/prompts/snip-summary/versions/..%2Fregistry", headers: auth() })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/v1/prompts/snip-summary/active", headers: auth(), payload: { version: "v9" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/evals/nope/runs", headers: auth(), payload: { version: "v1" } })).statusCode).toBe(404);
  });
});
