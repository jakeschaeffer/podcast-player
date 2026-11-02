/**
 * One-time Gmail authorization for the email content source.
 *
 *   pnpm gmail:auth            prints the consent URL (needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.server.local)
 *   pnpm gmail:auth --redirect "<the http://127.0.0.1:8765/?code=... URL from the address bar>"
 *                              exchanges the code and writes GOOGLE_REFRESH_TOKEN into .env.server.local; prints nothing secret
 *
 * The consent page must be opened in a browser signed in to the mailbox. After "Allow", the browser lands on a
 * 127.0.0.1 page that cannot connect; copy that page's full URL and pass it back here within a few minutes.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { authorizationUrl, codeFromRedirect, exchangeCode, GmailClient } from "../lib/gmail.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENV_FILE = resolve(REPO, ".env.server.local");

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { redirect: { type: "string" } } });
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    console.error("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Desktop OAuth client) to .env.server.local first.");
    return 2;
  }
  if (!values.redirect) {
    console.log("Open this URL in a browser signed in to the mailbox, allow read-only access, then run again with --redirect \"<url of the page you land on>\":\n");
    console.log(authorizationUrl(client_id));
    return 0;
  }
  const code = codeFromRedirect(values.redirect);
  const { refresh_token } = await exchangeCode(client_id, client_secret, code);
  const current = await readFile(ENV_FILE, "utf8").catch(() => "");
  const lines = current.split("\n").filter((l) => !l.startsWith("GOOGLE_REFRESH_TOKEN="));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  lines.push(`GOOGLE_REFRESH_TOKEN=${refresh_token}`);
  await writeFile(ENV_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
  const client = new GmailClient({ client_id, client_secret, refresh_token });
  const profile = await client.profile();
  console.log(`Stored a refresh token in .env.server.local for ${profile.emailAddress} (${profile.messagesTotal} messages visible, read-only).`);
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
