/**
 * Signed media URLs come back absolute, built from the server's PUBLIC_BASE_URL. The app is served from the
 * same host as the API (dev proxy or nginx), so playing them by path keeps the audio on the app's origin,
 * which is what makes the dev proxy and a phone on the LAN work. The signature covers id, expiry, and device,
 * not the host, so this changes nothing about authorization. Share links are never rewritten.
 */
export function mediaPath(url: string): string {
  try {
    const u = new URL(url, location.href);
    if (u.pathname.startsWith("/m/")) return u.pathname + u.search;
    return url;
  } catch {
    return url;
  }
}
