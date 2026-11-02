import Foundation
import Security

/// The device token, kept in the Keychain (never UserDefaults). One item per server, so switching between the
/// dev server and production keeps both logins.
public struct TokenStore: Sendable {
  public let service: String
  public let account: String

  /// Keyed by the app's bundle id, so two apps built from this code on one phone keep separate tokens.
  public static let defaultService = "\(Bundle.main.bundleIdentifier ?? "Snip").device-token"

  public init(service: String = TokenStore.defaultService, server: URL) {
    self.service = service
    self.account = server.absoluteString
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  public func load() -> String? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func save(_ token: String) {
    clear()
    var q = query
    q[kSecValueData as String] = Data(token.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(q as CFDictionary, nil)
  }

  public func clear() {
    SecItemDelete(query as CFDictionary)
  }
}
