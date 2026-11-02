import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import * as S from "../schemas.js";

const Id = Type.Object({ id: Type.String() });
import { notFound } from "../../app/errors.js";
import type { JobKind, JobStatus } from "../../jobs/queue.js";

export function registerJobsRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.get("/v1/jobs", { schema: { tags: ["jobs"], summary: "Background jobs, newest first; filter by subject id, status, or kind", querystring: Type.Object({ subject: Type.Optional(Type.String()), status: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }), response: { 200: Type.Array(S.JobSchema) } } }, async (request) => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (request.query.subject) { where.push("key LIKE ?"); args.push(`%${request.query.subject}%`); }
    if (request.query.status) { where.push("status = ?"); args.push(request.query.status as JobStatus); }
    if (request.query.kind) { where.push("kind = ?"); args.push(request.query.kind as JobKind); }
    const rows = ctx.db.prepare(`SELECT id FROM job ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`).pluck().all(...args, request.query.limit ?? 100) as string[];
    return rows.map((id) => jobView(ctx, id));
  });
  app.post("/v1/jobs/:id/retry", { schema: { tags: ["jobs"], summary: "Re-queue a failed or deferred job now", params: Id, response: { 200: S.JobSchema } } }, async (request) => {
    const job = ctx.queue.get(request.params.id);
    if (!job) throw notFound("job");
    ctx.db.prepare("UPDATE job SET status = 'queued', run_after = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'deferred')").run(ctx.now(), ctx.now(), job.id);
    return jobView(ctx, job.id);
  });
}

export function jobView(ctx: AppContext, id: string) {
  const j = ctx.queue.get(id);
  if (!j) throw notFound("job");
  return { id: j.id, kind: j.kind, key: j.key, priority: j.priority, status: j.status, attempts: j.attempts, run_after: j.run_after, last_error: j.last_error, created_at: j.created_at, updated_at: j.updated_at };
}
