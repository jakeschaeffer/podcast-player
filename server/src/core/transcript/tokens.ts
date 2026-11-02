/** Token normalization shared by alignment, comparison, and matching: lowercase, ASCII apostrophes, letters and digits only. */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, "")
    .replace(/^'+|'+$/g, "");
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map(normalizeToken).filter((t) => t.length > 0);
}
