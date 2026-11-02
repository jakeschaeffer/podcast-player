import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { evalDef, getRun, startRun } from "../../services/evalRuns.js";
import { activatePromptVersion, createPromptVersion, getPromptVersion, listPrompts, promptName } from "../../services/prompts.js";
import * as S from "../schemas.js";

const Name = Type.Object({ name: Type.String() });

export function registerPromptsRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.get("/v1/prompts", { schema: { tags: ["prompts"], summary: "Every prompt with its versions, the active one, and each version's latest eval score", response: { 200: Type.Array(S.PromptSchema) } } }, async () => listPrompts(ctx));
  app.get("/v1/prompts/:name/versions/:version", { schema: { tags: ["prompts"], summary: "One prompt version: its text, the version before it, and its eval runs", params: Type.Object({ name: Type.String(), version: Type.String() }), response: { 200: S.PromptVersionSchema } } }, async (request) =>
    getPromptVersion(ctx, promptName(request.params.name), request.params.version),
  );
  app.post("/v1/prompts/:name/versions", { schema: { tags: ["prompts"], summary: "Save text as the next version of a prompt; it is not active until activated", params: Name, body: Type.Object({ text: Type.String({ minLength: 1, maxLength: 20_000 }) }), response: { 201: S.PromptVersionSchema, 409: S.ErrorSchema } } }, async (request, reply) =>
    reply.code(201).send(await createPromptVersion(ctx, promptName(request.params.name), request.body.text)),
  );
  app.put("/v1/prompts/:name/active", { schema: { tags: ["prompts"], summary: "Make a version the one production uses, from the next model call on", params: Name, body: Type.Object({ version: Type.String() }), response: { 200: S.PromptSchema } } }, async (request) =>
    activatePromptVersion(ctx, promptName(request.params.name), request.body.version),
  );
  app.post("/v1/evals/:eval/runs", { schema: { tags: ["prompts"], summary: "Run an eval on one prompt version in the background; a run already waiting for that version is returned", params: Type.Object({ eval: Type.String() }), body: Type.Object({ version: Type.String() }), response: { 202: S.EvalRunSchema, 409: S.ErrorSchema } } }, async (request, reply) =>
    reply.code(202).send(startRun(ctx, evalDef(request.params.eval).id, request.body.version)),
  );
  app.get("/v1/evals/:eval/runs/:run", { schema: { tags: ["prompts"], summary: "One eval run with every case, failures first", params: Type.Object({ eval: Type.String(), run: Type.String() }), response: { 200: S.EvalRunDetailSchema } } }, async (request) =>
    getRun(ctx, evalDef(request.params.eval).id, request.params.run),
  );
}
