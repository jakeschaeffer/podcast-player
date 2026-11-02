/** Copy text; on http LAN origins the async clipboard is unavailable, so fall back to the share sheet or a selectable prompt. */
export async function copyText(text: string): Promise<"copied" | "shared" | "shown"> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    // fall through
  }
  if (navigator.share) {
    try {
      await navigator.share({ url: text });
      return "shared";
    } catch {
      // cancelled or unsupported
    }
  }
  window.prompt("Copy this link", text);
  return "shown";
}

/**
 * Share a link the way the phone does best: the system share sheet where there is one (iOS, over HTTPS), else copy.
 * Call it straight from the tap: Safari only allows sharing and copying during the user's gesture.
 */
export async function shareLink(url: string, title: string): Promise<"shared" | "copied" | "shown" | "cancelled"> {
  if (navigator.share && window.isSecureContext) {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  return copyText(url);
}

/**
 * Copy a link that is still being created. Safari allows a clipboard write only during the tap, so the write is
 * started at once with a promise of the text (ClipboardItem); without the async clipboard (plain-HTTP origins) the
 * link is shown once it exists.
 */
export async function copyPending(text: Promise<string>): Promise<"copied" | "shown"> {
  if (navigator.clipboard && window.isSecureContext && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return "copied";
    } catch {
      // fall through: show it
    }
  }
  const t = await text;
  const how = await copyText(t);
  return how === "copied" ? "copied" : "shown";
}
