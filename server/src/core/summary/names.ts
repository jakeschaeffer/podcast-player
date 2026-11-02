/**
 * Cheap guard against the most embarrassing summary failure: a person's name that appears nowhere
 * in the source. Capitalized tokens that are not sentence-initial must appear in the allowed text, and so must a
 * sentence's first word when a verb of saying follows it ("Priya says"). Each generated text is read on its own, and
 * titles in Title Case are left out (see isTitleCase).
 */
const STOP = new Set(["i", "the", "a", "an", "and", "but", "or", "so", "if", "in", "on", "at", "to", "of", "for", "with", "by", "as", "it", "he", "she", "they", "we", "you", "his", "her", "their", "our", "this", "that", "these", "those", "there", "here", "when", "where", "why", "how", "what", "who", "which", "not", "no", "yes"]);

export function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
}

/** Verbs a summary attributes claims with; the capitalized word that opens a sentence before one is a name. */
const SAYS = new Set(["says", "said", "argues", "argued", "explains", "explained", "notes", "noted", "adds", "added", "thinks", "thought", "believes", "believed", "asks", "asked", "tells", "told", "recalls", "recalled", "jokes", "joked", "suggests", "suggested", "describes", "described", "calls", "called", "claims", "claimed", "insists", "insisted", "admits", "admitted", "agrees", "agreed", "warns", "warned", "predicts", "predicted", "likens", "likened", "wonders", "wondered", "urges", "urged", "cites", "cited", "credits", "credited", "imagines", "imagined", "recommends", "recommended", "mentions", "mentioned", "reveals", "revealed", "recounts", "recounted", "concedes", "conceded", "counters", "countered", "responds", "responded", "replies", "replied", "observes", "observed", "contends", "contended", "acknowledges", "acknowledged", "emphasizes", "emphasized", "stresses", "stressed", "laughs", "laughed"]);

/** Capitalized tokens that look like names: any not opening a sentence, and one opening a sentence before a verb of saying. */
export function candidateNames(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/\s+/).filter(Boolean);
  let sentenceStart = true;
  for (const [i, part] of parts.entries()) {
    const word = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (word.length > 0 && /^\p{Lu}\p{Ll}+/u.test(word) && !STOP.has(word.toLowerCase())) {
      const next = (parts[i + 1] ?? "").replace(/[^\p{L}'’]+$/u, "").toLowerCase();
      if (!sentenceStart || SAYS.has(next)) out.push(word);
    }
    // A sentence ends at . ! ? : or …, also inside closing quotes and brackets, straight or curly.
    sentenceStart = /[.!?:…]["'”’)\]]*$/.test(part);
  }
  return out;
}

/**
 * Whether a title is in Title Case ("Why Rollups Want Their Own Sequencers"): at least three longer words, three
 * quarters of them capitalized. Such a title capitalizes ordinary words, so its capitals say nothing about names.
 */
export function isTitleCase(title: string): boolean {
  const words = tokens(title).filter((w) => w.length > 3 && /^\p{L}/u.test(w) && !STOP.has(w.toLowerCase()));
  return words.length >= 3 && words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length >= 0.75;
}

/**
 * Names in the texts that do not occur (case-insensitively) in any of the allowed sources. Each text is read on its
 * own, so its first word starts a sentence: pass a title and its summary as two texts, not joined.
 */
export function unsupportedNames(texts: string | string[], allowedSources: string[]): string[] {
  const allowed = new Set(allowedSources.flatMap((s) => tokens(s).map((t) => t.toLowerCase().replace(/[’']s$/u, ""))));
  const bad = new Set<string>();
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    for (const name of candidateNames(text)) {
      const key = name.toLowerCase().replace(/[’']s$/u, "");
      if (!allowed.has(key)) bad.add(name);
    }
  }
  return [...bad];
}
