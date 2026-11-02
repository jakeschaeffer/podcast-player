/**
 * Fetch publisher emails, match them to episodes, store the article text, and queue alignment.
 *
 *   pnpm email:sync [--query "from:stratechery.com"] [--max 50] [--no-align]
 */
import { parseArgs } from "node:util";
import { createContext } from "../app/context.js";
import { loadConfig } from "../lib/config.js";
import { syncPublisherEmails } from "../services/emailSource.js";

const { values } = parseArgs({ options: { query: { type: "string" }, max: { type: "string", default: "50" }, "no-align": { type: "boolean", default: false } } });
const ctx = createContext(loadConfig());
const report = await syncPublisherEmails(ctx, { ...(values.query ? { query: values.query } : {}), max: Number(values.max), align: !values["no-align"] });
console.log(JSON.stringify({ ...report, stored: report.stored.length, stored_titles: report.stored.map((s) => `${s.kind}: ${s.title} (${s.words} words, ${s.sections} sections)`) }, null, 1));
ctx.db.close();
