import Foundation
import Security

/// One generic-password item in the Keychain, keyed by service and account. No access group is named: an item lands
/// in the process's default group, which for the app and its extensions is the app's own group (both targets'
/// `keychain-access-groups` entitlement names `$(AppIdentifierPrefix)<app bundle id>`), so what the app saves its
/// extensions can read.
struct KeychainItem: Sendable {
  let service: String
  let account: String

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  func load() -> String? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func save(_ value: String) {
    clear()
    var q = query
    q[kSecValueData as String] = Data(value.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(q as CFDictionary, nil)
  }

  func clear() {
    SecItemDelete(query as CFDictionary)
  }
}

/// The device token, kept in the Keychain (never UserDefaults). One item per server, so switching between the
/// dev server and production keeps both logins.
public struct TokenStore: Sendable {
  public let service: String
  public let account: String
  private var item: KeychainItem { KeychainItem(service: service, account: account) }

  /// Keyed by the app's bundle id, so two apps built from this code on one phone keep separate tokens. In an app
  /// extension, use `service(forApp:)` with the app's bundle id (`SharedSession.appBundleID()`), not this.
  public static let defaultService = service(forApp: Bundle.main.bundleIdentifier ?? "Snip")

  /// The service under which the app with that bundle id keeps its tokens.
  public static func service(forApp bundleID: String) -> String { "\(bundleID).device-token" }

  public init(service: String = TokenStore.defaultService, server: URL) {
    self.service = service
    self.account = server.absoluteString
  }

  public func load() -> String? { item.load() }

  public func save(_ token: String) { item.save(token) }

  public func clear() { item.clear() }
}
