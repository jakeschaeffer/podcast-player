/**
 * Newsletter emails as an optional source of publisher text, for shows without a text feed. Read-only on the
 * mailbox; turned on by setting EMAIL_SOURCE_QUERY.
 */
import type { AppContext } from "../app/context.js";
import type { EpisodeRow } from "../db/rows.js";
import { NonRetryable } from "../jobs/errors.js";
import type { Job } from "../jobs/queue.js";
import { extractArticleFromEmail, parseSubject } from "../lib/articleHtml.js";
import { credentialsFromEnv, GmailClient } from "../lib/gmail.js";
import { storeEpisodeText } from "./publisherText.js";
import { findEpisodeByTitle } from "./titleMatch.js";

export type SyncReport = {
  query: string;
  listed: number;
  already_stored: number;
  not_an_episode: number;
  no_html: number;
  unmatched: { subject: string }[];
  stored: { episode_id: string; title: string; kind: string; words: number; sections: number }[];
  align_enqueued: number;
};

/** Fetch newsletters, match them to episodes, store the article text, and queue alignment for episodes with audio. */
export async function syncPublisherEmails(ctx: AppContext, opts: { query?: string; max?: number; align?: boolean } = {}): Promise<SyncReport> {
  const creds = credentialsFromEnv();
  if (!creds) throw new NonRetryable("Gmail credentials missing (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)");
  const query = opts.query ?? ctx.config.emailSourceQuery;
  if (!query) throw new NonRetryable("email source disabled (EMAIL_SOURCE_QUERY is empty)");
  const client = new GmailClient(creds);
  const ids = await client.listMessages(query, opts.max ?? 50);
  const report: SyncReport = { query, listed: ids.length, already_stored: 0, not_an_episode: 0, no_html: 0, unmatched: [], stored: [], align_enqueued: 0 };
  const episodes = ctx.db.prepare("SELECT * FROM episode").all() as EpisodeRow[];
  const exists = ctx.db.prepare("SELECT 1 FROM episode_text WHERE source = 'email' AND source_ref = ?");
  for (const m of ids) {
    if (exists.get(m.id)) { report.already_stored++; continue; }
    const msg = await client.getMessage(m.id);
    const subject = parseSubject(msg.subject);
    if (subject.kind === "other") { report.not_an_episode++; continue; }
    if (!msg.html) { report.no_html++; continue; }
    const article = extractArticleFromEmail(msg.html, msg.subject);
    if (article.word_count < 50) { report.not_an_episode++; continue; }
    const wanted = subject.date ? Date.parse(`${subject.date}T12:00:00Z`) : msg.date;
    const ep = findEpisodeByTitle(episodes, article.title, (e) => e.published_at !== null && Math.abs(e.published_at - wanted) < 4 * 86_400_000);
    if (!ep) { report.unmatched.push({ subject: msg.subject }); continue; }
    const stored = storeEpisodeText(ctx, { episode: ep, source: "email", source_ref: m.id, article, received_at: msg.date, align: opts.align !== false });
    report.stored.push({ episode_id: ep.id, title: article.title, kind: article.kind, words: article.word_count, sections: article.sections.length });
    if (stored.align_enqueued) report.align_enqueued++;
  }
  ctx.log("publisher emails synced", { query, listed: ids.length, stored: report.stored.length, unmatched: report.unmatched.length, align_enqueued: report.align_enqueued });
  return report;
}

/** Job body for the scheduled sync. */
export async function syncEmailJob(ctx: AppContext, _job: Job<unknown>): Promise<void> {
  await syncPublisherEmails(ctx);
}
