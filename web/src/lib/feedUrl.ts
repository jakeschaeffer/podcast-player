/**
 * Whether text typed into the show search is a feed address rather than a name. Private feeds (a paid show, a
 * premium tier) are not in any directory, so the only way to add one is to paste its URL; the search screen then
 * offers to subscribe to that address directly. Returns the URL to send, or null for an ordinary search.
 */
export function asFeedUrl(text: string): string | null {
  const t = text.trim();
  if (t.length === 0 || /\s/.test(t)) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : /^(www\.|feeds?\.)|^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S/i.test(t) ? `https://${t}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}
