import Foundation
import SQLite3

/// A value SQLite stores, as it goes into a statement and comes out of a row.
enum SQLValue: Sendable, Equatable {
  case null
  case integer(Int64)
  case real(Double)
  case text(String)
  case blob(Data)
}

/// What can be bound to a `?`. Optionals bind NULL, so a query's arguments read like the server's `.run(a, b, c)`.
protocol SQLBindable {
  var sqlValue: SQLValue { get }
}

extension SQLValue: SQLBindable { var sqlValue: SQLValue { self } }
extension Int: SQLBindable { var sqlValue: SQLValue { .integer(Int64(self)) } }
extension Int64: SQLBindable { var sqlValue: SQLValue { .integer(self) } }
extension Double: SQLBindable { var sqlValue: SQLValue { .real(self) } }
extension String: SQLBindable { var sqlValue: SQLValue { .text(self) } }
extension Data: SQLBindable { var sqlValue: SQLValue { .blob(self) } }
extension Bool: SQLBindable { var sqlValue: SQLValue { .integer(self ? 1 : 0) } }
extension Optional: SQLBindable where Wrapped: SQLBindable {
  var sqlValue: SQLValue { self?.sqlValue ?? .null }
}

struct SQLiteError: Error, CustomStringConvertible {
  let code: Int32
  let message: String
  var description: String { "SQLite \(code): \(message)" }
}

/// One result row, read by column name like the server's row objects.
struct Row {
  private let values: [String: SQLValue]

  init(_ values: [String: SQLValue]) { self.values = values }

  func value(_ name: String) -> SQLValue { values[name] ?? .null }

  func int(_ name: String) -> Int? {
    switch value(name) {
    case .integer(let v): Int(v)
    case .real(let v): Int(v)
    default: nil
    }
  }

  func double(_ name: String) -> Double? {
    switch value(name) {
    case .integer(let v): Double(v)
    case .real(let v): v
    default: nil
    }
  }

  func string(_ name: String) -> String? {
    switch value(name) {
    case .text(let v): v
    // The `_enc` columns hold a URL's bytes (Schema.swift says why they are not encrypted here).
    case .blob(let v): String(data: v, encoding: .utf8)
    default: nil
    }
  }

  func bool(_ name: String) -> Bool { int(name) == 1 }
}

/// A thin wrapper over the system's SQLite: prepared statements kept by their text, values bound by position,
/// rows read by name. Not thread-safe by itself; `Store` (an actor) owns the only one.
final class Connection {
  private var handle: OpaquePointer?
  private var statements: [String: OpaquePointer] = [:]
  private var depth = 0

  /// SQLite copies a bound string or blob before `sqlite3_bind_*` returns.
  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  init(path: String) throws {
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
    guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK else {
      let error = lastError()
      sqlite3_close_v2(handle)
      throw error
    }
  }

  deinit {
    for statement in statements.values { sqlite3_finalize(statement) }
    sqlite3_close_v2(handle)
  }

  private func lastError() -> SQLiteError {
    SQLiteError(code: sqlite3_errcode(handle), message: handle.map { String(cString: sqlite3_errmsg($0)) } ?? "not open")
  }

  /// Run statements that take no arguments and return nothing (schema, pragmas).
  func exec(_ sql: String) throws {
    guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { throw lastError() }
  }

  private func prepared(_ sql: String) throws -> OpaquePointer {
    if let statement = statements[sql] { return statement }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw lastError() }
    statements[sql] = statement
    return statement
  }

  private func bind(_ statement: OpaquePointer, _ args: [any SQLBindable]) throws {
    for (i, arg) in args.enumerated() {
      let index = Int32(i + 1)
      let code: Int32
      switch arg.sqlValue {
      case .null: code = sqlite3_bind_null(statement, index)
      case .integer(let v): code = sqlite3_bind_int64(statement, index, v)
      case .real(let v): code = sqlite3_bind_double(statement, index, v)
      case .text(let v): code = sqlite3_bind_text(statement, index, v, -1, Self.transient)
      case .blob(let v):
        code = v.withUnsafeBytes { bytes in
          // A zero-length blob has no base address; SQLite takes any non-null pointer with length 0.
          sqlite3_bind_blob(statement, index, bytes.baseAddress ?? UnsafeRawPointer(bitPattern: 1), Int32(v.count), Self.transient)
        }
      }
      guard code == SQLITE_OK else { throw lastError() }
    }
  }

  /// Run a write; returns how many rows it changed.
  @discardableResult
  func run(_ sql: String, _ args: [any SQLBindable] = []) throws -> Int {
    let statement = try prepared(sql)
    defer {
      sqlite3_reset(statement)
      sqlite3_clear_bindings(statement)
    }
    try bind(statement, args)
    var code = sqlite3_step(statement)
    while code == SQLITE_ROW { code = sqlite3_step(statement) }
    guard code == SQLITE_DONE else { throw lastError() }
    return Int(sqlite3_changes(handle))
  }

  func all(_ sql: String, _ args: [any SQLBindable] = []) throws -> [Row] {
    let statement = try prepared(sql)
    defer {
      sqlite3_reset(statement)
      sqlite3_clear_bindings(statement)
    }
    try bind(statement, args)
    var rows: [Row] = []
    let count = sqlite3_column_count(statement)
    while true {
      let code = sqlite3_step(statement)
      if code == SQLITE_DONE { break }
      guard code == SQLITE_ROW else { throw lastError() }
      var values: [String: SQLValue] = [:]
      for i in 0..<count {
        let name = String(cString: sqlite3_column_name(statement, i))
        switch sqlite3_column_type(statement, i) {
        case SQLITE_INTEGER: values[name] = .integer(sqlite3_column_int64(statement, i))
        case SQLITE_FLOAT: values[name] = .real(sqlite3_column_double(statement, i))
        case SQLITE_TEXT: values[name] = .text(String(cString: sqlite3_column_text(statement, i)))
        case SQLITE_BLOB:
          let length = Int(sqlite3_column_bytes(statement, i))
          values[name] = .blob(sqlite3_column_blob(statement, i).map { Data(bytes: $0, count: length) } ?? Data())
        default: values[name] = .null
        }
      }
      rows.append(Row(values))
    }
    return rows
  }

  func get(_ sql: String, _ args: [any SQLBindable] = []) throws -> Row? {
    try all(sql, args).first
  }

  /// All of `body` or none of it. A transaction inside another joins it, as the server's nested calls do.
  func transaction<T>(_ body: () throws -> T) throws -> T {
    if depth > 0 { return try body() }
    try exec("BEGIN IMMEDIATE")
    depth += 1
    defer { depth -= 1 }
    do {
      let result = try body()
      try exec("COMMIT")
      return result
    } catch {
      try? exec("ROLLBACK")
      throw error
    }
  }
}
