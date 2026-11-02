import Foundation

/// The server's signed media URLs (`/m/...?e=<unix seconds>&d=<device>&s=<signature>`).
public enum SignedURL {
  /// Renew when this close to expiry, like the web engine.
  public static let renewMargin: TimeInterval = 10 * 60

  public static func expiry(from url: URL) -> Date? {
    guard
      let e = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "e" })?.value,
      let seconds = TimeInterval(e)
    else { return nil }
    return Date(timeIntervalSince1970: seconds)
  }

  /// Signed media URLs come back absolute, built from the server's PUBLIC_BASE_URL. Like the web app's
  /// `mediaPath`, play `/m/...` by path on the server the app talks to, so the dev server, the tailnet and an SSH
  /// tunnel work too. The signature covers id, expiry and device, not the host, so this changes nothing about
  /// authorization. Anything outside `/m/` is left alone.
  public static func onServer(_ string: String, base: URL) -> URL? {
    guard let url = URL(string: string, relativeTo: base)?.absoluteURL else { return nil }
    guard url.path().hasPrefix("/m/"), var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
    else { return url }
    let parsed = URLComponents(url: url, resolvingAgainstBaseURL: false)
    components.percentEncodedPath = parsed?.percentEncodedPath ?? url.path()
    components.percentEncodedQuery = parsed?.percentEncodedQuery
    return components.url
  }

  /// True when the URL has expired or will within `renewMargin`. A URL with no expiry is treated as fresh.
  public static func needsRenewal(_ url: URL, now: Date = .now) -> Bool {
    guard let expiry = expiry(from: url) else { return false }
    return expiry.timeIntervalSince(now) < renewMargin
  }
}
