import Foundation

/// Just enough of server/openapi.json to find a response schema and strip a body down to what the schema
/// guarantees.
enum OpenAPI {
  nonisolated(unsafe) static let document: [String: Any] = {
    let url = DecodeFixturesTests.fixturesDir
      .deletingLastPathComponent().deletingLastPathComponent()  // repo root
      .appending(path: "server/openapi.json")
    return (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? [:]
  }()

  /// The schema for `status` of the route whose template matches `url` (`/v1/feeds/{id}` matches `/v1/feeds/01…`).
  static func responseSchema(method: String, url: String, status: String) throws -> [String: Any]? {
    let path = url.split(separator: "?", maxSplits: 1).first.map(String.init) ?? url
    let paths = document["paths"] as? [String: [String: Any]] ?? [:]
    let segments = path.split(separator: "/")
    let template = paths.keys.first { key in
      let parts = key.split(separator: "/")
      return parts.count == segments.count
        && zip(parts, segments).allSatisfy { $0.hasPrefix("{") || $0 == $1 }
    }
    guard let template, let operation = paths[template]?[method] as? [String: Any] else { return nil }
    let responses = operation["responses"] as? [String: Any]
    let response = responses?[status] as? [String: Any]
    let content = response?["content"] as? [String: Any]
    return (content?["application/json"] as? [String: Any])?["schema"] as? [String: Any]
  }

  /// `value` with every nullable field set to null and every optional property removed.
  static func minimize(_ value: Any, schema: [String: Any]) -> Any {
    if value is NSNull { return value }
    var schema = schema
    if let branches = schema["anyOf"] as? [[String: Any]] {
      if branches.contains(where: { $0["type"] as? String == "null" }) { return NSNull() }
      guard let match = branches.first(where: { matches(value, $0) }) else { return value }
      schema = match
    }
    if let object = value as? [String: Any], let properties = schema["properties"] as? [String: [String: Any]] {
      let required = Set(schema["required"] as? [String] ?? [])
      var out: [String: Any] = [:]
      for (key, v) in object where required.contains(key) {
        out[key] = properties[key].map { minimize(v, schema: $0) } ?? v
      }
      return out
    }
    if let array = value as? [Any], let items = schema["items"] as? [String: Any] {
      return array.map { minimize($0, schema: items) }
    }
    return value
  }

  private static func matches(_ value: Any, _ schema: [String: Any]) -> Bool {
    switch schema["type"] as? String {
    case "object": return value is [String: Any]
    case "array": return value is [Any]
    case "string": return value is String
    case "integer", "number": return value is NSNumber && !(value is Bool)
    case "boolean": return value is Bool
    default: return true
    }
  }
}
