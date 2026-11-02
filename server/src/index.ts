/**
 * Entry point. `--role api` serves HTTP, `--role worker` runs jobs, `--role all` (default) does both in one process.
 * Configuration comes from the environment; `pnpm dev` loads ../.env.local.
 */
import { parseArgs } from "node:util";
import { createContext } from "./app/context.js";
import { sqliteVersion } from "./db/index.js";
import { buildApp } from "./http/app.js";
import { startWorker } from "./jobs/worker.js";
import { loadConfig } from "./lib/config.js";

const { values } = parseArgs({ options: { role: { type: "string", default: "all" } } });
const role = values.role as "api" | "worker" | "all";
if (!["api", "worker", "all"].includes(role)) {
  console.error("usage: --role api|worker|all");
  process.exit(2);
}

const config = loadConfig();
const ctx = createContext(config);
ctx.log("starting", { role, data_dir: config.dataDir, sqlite: sqliteVersion(ctx.db), transcriber: ctx.transcriber?.name ?? null, text_model: ctx.textModel?.name ?? null, public_base_url: config.publicBaseUrl });

const stops: (() => Promise<void>)[] = [];
if (role === "api" || role === "all") {
  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });
  ctx.log("api listening", { host: config.host, port: config.port });
  stops.push(() => app.close());
}
if (role === "worker" || role === "all") {
  const worker = startWorker(ctx);
  stops.push(worker.stop);
}

const shutdown = async (signal: string) => {
  ctx.log("shutting down", { signal });
  await Promise.allSettled(stops.map((s) => s()));
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
