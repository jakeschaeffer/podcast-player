/**
 * Guess whether a Snipd snip title was written by Snipd's model or by the owner.
 *
 * Snipd's titles are short Title Case headlines ("Pump Rules", "Ethereum vs. Celestia: A Comparison of Key
 * Differences"). The owner's read like notes: sentence case, full stops, several sentences, shorthand and units
 * ("Use cluster sets (5-20secs b/w reps)."), often appended after Snipd's headline. Heuristic, so every case keeps
 * its reasons and a confidence; the owner's edits in this app are the exact labels going forward.
 */
export type TitleOrigin = "generated" | "manual" | "appended" | "placeholder";
export type OriginGuess = { origin: TitleOrigin; confidence: "high" | "medium"; reasons: string[]; generated_part?: string; owner_part?: string };

const SMALL = new Set("a an and as at but by for from in into is it its of on or over the to vs via with without about after before between than that this your you their our his her are be not".split(" "));
const SHORTHAND = /->|\/=|=>|\d+\s?%|\b\d+(\.\d+)?\s?(secs?|mins?|hrs?|mg|mcg|g|kg|x|rm|1rm)\b|\bb\/w\b|\bw\/o?\b|\be\.g\.|\bi\.e\.|\(\d|\d\)|⅔/i;

function words(s: string): string[] {
  return s.match(/[A-Za-z][A-Za-z'’\-]*/g) ?? [];
}
/** Share of non-small words that start with a capital. */
export function titleCaseRatio(s: string): number {
  const big = words(s).filter((w) => !SMALL.has(w.toLowerCase()));
  if (big.length === 0) return 1;
  return big.filter((w) => /^[A-Z]/.test(w)).length / big.length;
}
/** Sentences, not splitting on "vs." or "e.g.". */
export function sentences(s: string): string[] {
  const protectedText = s.replace(/\b(vs|e\.g|i\.e|etc|Dr|Mr|Ms|St)\./gi, (m) => m.replace(".", "\u0000"));
  return protectedText.split(/(?<=[.?!])\s+(?=\S)/).map((x) => x.replace(/\u0000/g, ".").trim()).filter(Boolean);
}
function looksGenerated(s: string): boolean {
  const ws = words(s);
  return ws.length >= 2 && ws.length <= 14 && titleCaseRatio(s) >= 0.75 && !/\.$/.test(s.trim()) && !SHORTHAND.test(s);
}

export function guessTitleOrigin(title: string): OriginGuess {
  const t = title.trim().replace(/\s+/g, " ");
  if (/^(\d+\s*min\s+)?snip$/i.test(t) || t === "") return { origin: "placeholder", confidence: "high", reasons: ["placeholder"] };
  const ss = sentences(t);
  const reasons: string[] = [];
  if (ss.length >= 2) reasons.push("several sentences");
  if (/[^.]\.$/.test(t)) reasons.push("ends with a full stop");
  if (words(t).length > 14) reasons.push("long");
  if (titleCaseRatio(t) < 0.6 && words(t).filter((w) => !SMALL.has(w.toLowerCase())).length >= 3) reasons.push("sentence case");
  if (SHORTHAND.test(t)) reasons.push("shorthand or units");
  if (/\([a-z][^)]*\)/.test(t)) reasons.push("lowercase aside");
  if (reasons.length === 0) return { origin: "generated", confidence: looksGenerated(t) ? "high" : "medium", reasons: ["headline style"] };

  // Snipd's headline with the owner's note after it.
  if (ss.length >= 2 && looksGenerated(ss[0]!.replace(/[.?!:]$/, ""))) {
    const rest = ss.slice(1).join(" ");
    if (!looksGenerated(rest) || SHORTHAND.test(rest) || /\.$/.test(rest) || /\([a-z]/.test(rest)) {
      return { origin: "appended", confidence: "medium", reasons, generated_part: ss[0]!, owner_part: rest };
    }
  }
  if (reasons.length === 1 && reasons[0] === "lowercase aside") {
    const head = t.replace(/\s*\([a-z][^)]*\)\s*/g, " ").trim();
    if (looksGenerated(head)) return { origin: "appended", confidence: "medium", reasons, generated_part: head, owner_part: (t.match(/\([a-z][^)]*\)/g) ?? []).join(" ") };
  }
  const strong = reasons.filter((r) => r !== "long").length >= 2 || reasons.includes("sentence case");
  return { origin: "manual", confidence: strong ? "high" : "medium", reasons };
}
