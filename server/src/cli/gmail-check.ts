/**
 * Verify read access and look at what the publisher's emails contain.
 *
 *   pnpm gmail:check [--query "from:publisher.example newer_than:14d"] [--max 10] [--show 1]
 */
import { parseArgs } from "node:util";
import { credentialsFromEnv, GmailClient } from "../lib/gmail.js";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { query: { type: "string", default: "newer_than:14d" }, max: { type: "string", default: "10" }, show: { type: "string", default: "1" } } });
  const creds = credentialsFromEnv();
  if (!creds) {
    console.error("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN; run pnpm gmail:auth first.");
    return 2;
  }
  const client = new GmailClient(creds);
  const profile = await client.profile();
  console.log(`mailbox: ${profile.emailAddress}`);
  const ids = await client.listMessages(values.query!, Number(values.max));
  console.log(`query "${values.query}" matched ${ids.length} message(s)${ids.length >= Number(values.max) ? " (capped)" : ""}`);
  let shown = 0;
  for (const m of ids) {
    const msg = await client.getMessage(m.id);
    const words = msg.text.split(/\s+/).filter(Boolean).length;
    console.log(`- ${new Date(msg.date).toISOString().slice(0, 10)} | ${msg.subject} | from ${msg.from} | ${words} words of text${msg.html ? ", has html" : ""}`);
    if (shown < Number(values.show)) {
      shown++;
      // Previews drop URLs: publisher links can embed personal access tokens.
      console.log(`  text starts: ${msg.text.replace(/\(?\bhttps?:\/\/\S+\)?/g, "[link]").replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
