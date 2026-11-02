import type { AppContext } from "../../app/context.js";
import { listTitleEdits } from "../../services/titleEdits.js";
import { slug } from "../snip-selection/cases.js";
import type { TitleCase } from "./cases.js";

/** Title cases from the owner's edits in the app: exact ground truth, with the model title each edit replaced. */
export function appEditCases(ctx: AppContext): TitleCase[] {
  // Only the latest edit per revision is the owner's final word on that span.
  const latest = new Map<string, ReturnType<typeof listTitleEdits>[number]>();
  for (const e of listTitleEdits(ctx)) latest.set(e.revision_id, e);
  return [...latest.values()]
    .filter((e) => e.excerpt && e.excerpt.split(/\s+/).length >= 20)
    .map((e) => ({
      id: `app-${e.id}`,
      source: "app" as const,
      show: e.show_title,
      episode: e.episode_title,
      excerpt: [{ speaker: null, text: e.excerpt! }],
      excerpt_words: e.excerpt!.split(/\s+/).filter(Boolean).length,
      reference_title: e.new_title,
      origin: "app-edit" as const,
      origin_confidence: "exact" as const,
      origin_reasons: ["edited in the app"],
      other_model_title: e.generated_title,
      meta: { snip_id: e.snip_id, revision_id: e.revision_id, edited_at: e.created_at },
      tags: ["origin:app-edit", `show:${slug(e.show_title ?? "unknown")}`],
    }));
}
