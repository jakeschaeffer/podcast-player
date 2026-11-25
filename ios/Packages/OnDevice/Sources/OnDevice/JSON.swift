import Foundation

/// A JSON value as the phone writes it. Responses are built by hand in the server's field names (snake_case, every
/// key present, `null` where the server sends null), because the app's models decode the server's exact shapes.
enum JSON: Sendable, Equatable {
  case null
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([JSON])
  case object([String: JSON])

  init(_ value: String?) { self = value.map(JSON.string) ?? .null }
  init(_ value: Int?) { self = value.map(JSON.int) ?? .null }
  init(_ value: Double?) { self = value.map(JSON.double) ?? .null }
  init(_ value: Bool) { self = .bool(value) }

  /// Keys sorted, so the same answer is the same bytes (`APIClient` keeps answers to compare and show again).
  func data() -> Data {
    var out = ""
    write(to: &out)
    return Data(out.utf8)
  }

  private func write(to out: inout String) {
    switch self {
    case .null: out += "null"
    case .bool(let v): out += v ? "true" : "false"
    case .int(let v): out += String(v)
    case .double(let v):
      // JSON has no NaN or infinity; a whole number is written without a fraction, as JavaScript writes it.
      if !v.isFinite { out += "null" } else if v == v.rounded() && abs(v) < 1e15 { out += String(Int(v)) } else { out += String(v) }
    case .string(let v): Self.write(v, to: &out)
    case .array(let items):
      out += "["
      for (i, item) in items.enumerated() {
        if i > 0 { out += "," }
        item.write(to: &out)
      }
      out += "]"
    case .object(let members):
      out += "{"
      for (i, key) in members.keys.sorted().enumerated() {
        if i > 0 { out += "," }
        Self.write(key, to: &out)
        out += ":"
        members[key]!.write(to: &out)
      }
      out += "}"
    }
  }

  private static func write(_ string: String, to out: inout String) {
    out += "\""
    for scalar in string.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += "\\u" + String(repeating: "0", count: 4 - String(scalar.value, radix: 16).count) + String(scalar.value, radix: 16)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    out += "\""
  }
}

extension JSON: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByStringLiteral,
  ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
  init(nilLiteral: ()) { self = .null }
  init(booleanLiteral value: Bool) { self = .bool(value) }
  init(integerLiteral value: Int) { self = .int(value) }
  init(stringLiteral value: String) { self = .string(value) }
  init(arrayLiteral elements: JSON...) { self = .array(elements) }
  init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
}

/// The server's domain errors (`server/src/app/errors.ts`): a status, and the body
/// `{ "error": { "code", "message", …extra } }` that `APIClient` turns into an `APIError`.
struct HTTPError: Error, Sendable, Equatable {
  let status: Int
  let code: String
  let message: String
  var extra: [String: String] = [:]

  static func notFound(_ what: String) -> HTTPError { HTTPError(status: 404, code: "not_found", message: "\(what) not found") }
  static func conflict(_ message: String, extra: [String: String] = [:]) -> HTTPError {
    HTTPError(status: 409, code: "conflict", message: message, extra: extra)
  }
  static func badRequest(_ message: String) -> HTTPError { HTTPError(status: 400, code: "bad_request", message: message) }
  /// What the server's schema validation answers (Fastify's `validation` code) for a malformed query or body.
  static func validation(_ message: String) -> HTTPError { HTTPError(status: 400, code: "validation", message: message) }
  /// A route the phone does not have: the screens that need it are hidden in this mode (docs/store-app-plan.md).
  static let notOnThisPhone = HTTPError(status: 404, code: "not_found", message: "Not available on this phone")

  var body: JSON {
    var error: [String: JSON] = ["code": .string(code), "message": .string(message)]
    for (key, value) in extra { error[key] = .string(value) }
    return ["error": .object(error)]
  }
}
