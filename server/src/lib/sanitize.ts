import sanitizeHtml from "sanitize-html";

/** Show notes are rendered to the owner only, but still get a strict allowlist. */
export function sanitizeShowNotes(html: string | null): string | null {
  if (!html) return null;
  const out = sanitizeHtml(html, {
    allowedTags: ["p", "br", "b", "strong", "i", "em", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "blockquote", "code", "pre"],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }) },
  }).trim();
  return out.length > 0 ? out : null;
}

export function htmlToText(html: string | null): string {
  if (!html) return "";
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
}
