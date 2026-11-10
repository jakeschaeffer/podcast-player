import CryptoKit
import Foundation

/// The server's last answers to a few list requests, one file each, so the app's first screens have something to
/// draw before the server is reached (and with no connection at all). The bytes are kept as they came, so they decode
/// exactly as a fresh answer does. One folder per server; signing out empties it.
public struct SavedResponses: Sendable {
  public let folder: URL

  public init(folder: URL) { self.folder = folder }

  static func key(_ path: String, _ query: [URLQueryItem]) -> String {
    let text = path + "?" + query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
    return SHA256.hash(data: Data(text.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
  }

  func read(_ key: String) -> Data? { try? Data(contentsOf: folder.appending(path: key + ".json")) }

  func write(_ data: Data, for key: String) {
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try? data.write(to: folder.appending(path: key + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  public func clear() { try? FileManager.default.removeItem(at: folder) }
}
