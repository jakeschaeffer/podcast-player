/** Run every claimable job to completion, then exit. Useful from cron or for a one-off catch-up without the worker. */
import { createContext } from "../app/context.js";
import { drain } from "../jobs/worker.js";
import { loadConfig } from "../lib/config.js";

const ctx = createContext(loadConfig());
const result = await drain(ctx);
console.log(JSON.stringify({ ...result, remaining: ctx.queue.counts() }));
ctx.db.close();
