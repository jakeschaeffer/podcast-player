import Foundation

/// What the app's extensions (the share sheet) need to speak to the server as the app: which server the app is signed
/// in to, kept in the Keychain beside the token `TokenStore` keeps per server. An extension has none of the app's
/// UserDefaults, and the DEBUG dev-auth file does not apply there, so the Keychain is the one place both can read
/// (ios/README.md, "Share sheet"). The app writes the server on sign-in and at launch, and forgets it on sign-out.
public enum SharedSession {
  /// The app's bundle id from any of its processes: an extension's bundle id is the app's plus one suffix
  /// (`<app>.Share`, `<app>.LiveActivity`), and its bundle is an `.appex`.
  public static func appBundleID(of bundle: Bundle = .main) -> String {
    let id = bundle.bundleIdentifier ?? "Snip"
    if bundle.bundleURL.pathExtension == "appex", let dot = id.lastIndex(of: ".") { return String(id[..<dot]) }
    return id
  }

  private static func serverItem(_ appBundleID: String) -> KeychainItem { KeychainItem(service: "\(appBundleID).server", account: "current") }

  /// The server the app is signed in to now; the token for it is saved by `TokenStore` as before.
  public static func rememberServer(_ server: URL, appBundleID: String = appBundleID()) {
    serverItem(appBundleID).save(server.absoluteString)
  }

  public static func forgetServer(appBundleID: String = appBundleID()) {
    serverItem(appBundleID).clear()
  }

  /// The app's current server and its token, or nil when the app is signed out (or never wrote the server: a build
  /// from before the share sheet; opening the app once fixes that).
  public static func current(appBundleID: String = appBundleID()) -> (server: URL, token: String)? {
    guard let saved = serverItem(appBundleID).load(), let server = URL(string: saved),
      let token = TokenStore(service: TokenStore.service(forApp: appBundleID), server: server).load()
    else { return nil }
    return (server, token)
  }
}
