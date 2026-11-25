import Foundation

/// Just enough HTML reading for show notes: the tags and text of a fragment in order, with no tree. The server
/// uses htmlparser2 for the same two jobs (sanitizing the notes, and finding the timestamps in them); the phone has
/// no HTML parser to call, so this is the small part of one those jobs need.
enum HTML {
  enum Token: Equatable {
    /// Text between tags, entities not yet decoded.
    case text(String)
    case open(name: String, attributes: [String: String], selfClosing: Bool)
    case close(name: String)
  }

  /// Elements whose content is not markup: everything up to their closing tag is one text token.
  private static let rawText: Set<String> = ["script", "style", "textarea", "title"]

  static func tokens(_ html: String) -> [Token] {
    let s = Array(html.unicodeScalars)
    var out: [Token] = []
    var text = String.UnicodeScalarView()
    var i = 0

    func flush() {
      if !text.isEmpty { out.append(.text(String(text))) }
      text = String.UnicodeScalarView()
    }
    func isLetter(_ c: Unicode.Scalar) -> Bool { (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") }
    func isSpace(_ c: Unicode.Scalar) -> Bool { c == " " || c == "\n" || c == "\t" || c == "\r" || c == "\u{0C}" }
    func find(_ needle: String, from start: Int) -> Int? {
      let n = Array(needle.unicodeScalars)
      guard s.count >= n.count else { return nil }
      var j = start
      while j <= s.count - n.count {
        if (0..<n.count).allSatisfy({ s[j + $0].properties.lowercaseMapping == String(n[$0]) }) { return j }
        j += 1
      }
      return nil
    }

    while i < s.count {
      guard s[i] == "<", i + 1 < s.count else {
        text.append(s[i])
        i += 1
        continue
      }
      let next = s[i + 1]
      if next == "!" || next == "?" {
        // A comment runs to `-->`; any other declaration to the next `>`.
        flush()
        if i + 3 < s.count, s[i + 2] == "-", s[i + 3] == "-" {
          i = find("-->", from: i + 4).map { $0 + 3 } ?? s.count
        } else {
          i = find(">", from: i + 2).map { $0 + 1 } ?? s.count
        }
      } else if next == "/", i + 2 < s.count, isLetter(s[i + 2]) {
        flush()
        var j = i + 2
        var name = ""
        while j < s.count, s[j] != ">", !isSpace(s[j]) {
          name.unicodeScalars.append(s[j])
          j += 1
        }
        out.append(.close(name: name.lowercased()))
        i = find(">", from: j).map { $0 + 1 } ?? s.count
      } else if isLetter(next) {
        flush()
        var j = i + 1
        var name = ""
        while j < s.count, s[j] != ">", s[j] != "/", !isSpace(s[j]) {
          name.unicodeScalars.append(s[j])
          j += 1
        }
        name = name.lowercased()
        var attributes: [String: String] = [:]
        var selfClosing = false
        while j < s.count, s[j] != ">" {
          if isSpace(s[j]) {
            j += 1
          } else if s[j] == "/" {
            selfClosing = j + 1 < s.count && s[j + 1] == ">"
            j += 1
          } else {
            var key = ""
            while j < s.count, s[j] != "=", s[j] != ">", s[j] != "/", !isSpace(s[j]) {
              key.unicodeScalars.append(s[j])
              j += 1
            }
            while j < s.count, isSpace(s[j]) { j += 1 }
            var value = ""
            if j < s.count, s[j] == "=" {
              j += 1
              while j < s.count, isSpace(s[j]) { j += 1 }
              if j < s.count, s[j] == "\"" || s[j] == "'" {
                let quote = s[j]
                j += 1
                while j < s.count, s[j] != quote {
                  value.unicodeScalars.append(s[j])
                  j += 1
                }
                j += 1
              } else {
                while j < s.count, s[j] != ">", !isSpace(s[j]) {
                  value.unicodeScalars.append(s[j])
                  j += 1
                }
              }
            }
            // The first of a repeated attribute wins, as in a browser.
            if !key.isEmpty, attributes[key.lowercased()] == nil { attributes[key.lowercased()] = decodeEntities(value) }
          }
        }
        i = min(j + 1, s.count)
        out.append(.open(name: name, attributes: attributes, selfClosing: selfClosing))
        if rawText.contains(name), !selfClosing {
          let end = find("</\(name)", from: i) ?? s.count
          if end > i { out.append(.text(String(String.UnicodeScalarView(s[i..<end])))) }
          i = end
        }
      } else {
        text.append(s[i])
        i += 1
      }
    }
    flush()
    return out
  }

  /// The entities show notes and feeds use by name. A name that is not here stays as written.
  static let namedEntities: [String: String] = [
    "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{A0}", "copy": "©", "reg": "®", "trade": "™",
    "mdash": "—", "ndash": "–", "hellip": "…", "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”", "sbquo": "‚",
    "bdquo": "„", "laquo": "«", "raquo": "»", "bull": "•", "middot": "·", "deg": "°", "euro": "€", "pound": "£",
    "cent": "¢", "yen": "¥", "sect": "§", "para": "¶", "times": "×", "divide": "÷", "plusmn": "±", "frac12": "½",
    "frac14": "¼", "frac34": "¾", "iexcl": "¡", "iquest": "¿", "ensp": "\u{2002}", "emsp": "\u{2003}",
    "thinsp": "\u{2009}", "zwnj": "\u{200C}", "zwj": "\u{200D}", "shy": "\u{AD}", "prime": "′", "Prime": "″",
    "larr": "←", "rarr": "→", "uarr": "↑", "darr": "↓", "hearts": "♥", "dagger": "†", "Dagger": "‡",
    "agrave": "à", "aacute": "á", "acirc": "â", "atilde": "ã", "auml": "ä", "aring": "å", "aelig": "æ", "ccedil": "ç",
    "egrave": "è", "eacute": "é", "ecirc": "ê", "euml": "ë", "igrave": "ì", "iacute": "í", "icirc": "î", "iuml": "ï",
    "ntilde": "ñ", "ograve": "ò", "oacute": "ó", "ocirc": "ô", "otilde": "õ", "ouml": "ö", "oslash": "ø",
    "ugrave": "ù", "uacute": "ú", "ucirc": "û", "uuml": "ü", "yacute": "ý", "yuml": "ÿ", "szlig": "ß",
    "Agrave": "À", "Aacute": "Á", "Acirc": "Â", "Atilde": "Ã", "Auml": "Ä", "Aring": "Å", "AElig": "Æ", "Ccedil": "Ç",
    "Egrave": "È", "Eacute": "É", "Ecirc": "Ê", "Euml": "Ë", "Iacute": "Í", "Ntilde": "Ñ", "Oacute": "Ó",
    "Ocirc": "Ô", "Ouml": "Ö", "Oslash": "Ø", "Uacute": "Ú", "Uuml": "Ü",
  ]

  /// `&amp;`, `&#8217;`, `&#x2019;` and the names above become the characters they stand for.
  static func decodeEntities(_ text: String) -> String {
    guard text.contains("&") else { return text }
    let s = Array(text.unicodeScalars)
    var out = String.UnicodeScalarView()
    var i = 0
    while i < s.count {
      guard s[i] == "&", let end = s[i...].prefix(34).firstIndex(of: ";"), end > i + 1 else {
        out.append(s[i])
        i += 1
        continue
      }
      let name = String(String.UnicodeScalarView(s[(i + 1)..<end]))
      var decoded: String?
      if name.hasPrefix("#x") || name.hasPrefix("#X") {
        decoded = UInt32(name.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map { String($0) }
      } else if name.hasPrefix("#") {
        decoded = UInt32(name.dropFirst(), radix: 10).flatMap(Unicode.Scalar.init).map { String($0) }
      } else {
        decoded = namedEntities[name]
      }
      if let decoded {
        out.append(contentsOf: decoded.unicodeScalars)
        i = end + 1
      } else {
        out.append(s[i])
        i += 1
      }
    }
    return String(out)
  }
}

/// A port of `sanitizeShowNotes` (server/src/lib/sanitize.ts), which hands the notes to the sanitize-html package
/// with a strict allowlist: a few formatting tags, links with an `href` of scheme http, https or mailto, and
/// nothing else. A tag that is not allowed is dropped and its text kept, except a script's or a style's, whose
/// content goes too. Show notes are stored already sanitized, as on the server, so every reader gets the safe form.
enum ShowNotes {
  private static let allowedTags: Set<String> = [
    "p", "br", "b", "strong", "i", "em", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "blockquote", "code", "pre",
  ]
  private static let allowedSchemes: Set<String> = ["http", "https", "mailto"]
  /// sanitize-html's `nonTextTags`: their text is not the document's.
  private static let nonTextTags: Set<String> = ["script", "style", "textarea", "option"]
  private static let voidTags: Set<String> = ["br"]

  static func sanitize(_ html: String?) -> String? {
    guard let html, !html.isEmpty else { return nil }
    var out = ""
    var open: [String] = []
    var skipping = 0

    func closeThrough(_ name: String) {
      guard let index = open.lastIndex(of: name) else { return }
      for tag in open[index...].reversed() { out += "</\(tag)>" }
      open.removeSubrange(index...)
    }

    for token in HTML.tokens(html) {
      switch token {
      case .text(let raw):
        if skipping == 0 { out += escape(HTML.decodeEntities(raw), quotes: false) }
      case .open(let name, let attributes, let selfClosing):
        if nonTextTags.contains(name) {
          if !selfClosing { skipping += 1 }
        } else if skipping == 0, allowedTags.contains(name) {
          // A paragraph or list item ends where the next begins, as an HTML parser reads it.
          if (name == "p" || name == "li"), open.last == name { closeThrough(name) }
          out += "<\(name)"
          // An empty `href` is dropped too, as sanitize-html drops an empty value of an attribute that needs one.
          if name == "a", let href = attributes["href"], !href.isEmpty, allowed(href: href) { out += " href=\"\(escape(href, quotes: true))\"" }
          if voidTags.contains(name) {
            out += " />"
          } else {
            out += ">"
            open.append(name)
          }
        }
      case .close(let name):
        if nonTextTags.contains(name) {
          skipping = max(0, skipping - 1)
        } else if skipping == 0, allowedTags.contains(name), !voidTags.contains(name) {
          closeThrough(name)
        }
      }
    }
    for tag in open.reversed() { out += "</\(tag)>" }
    let trimmed = out.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  /// A relative link has no scheme and is kept; one with a scheme must name an allowed one. Control characters and
  /// spaces are ignored first, since browsers ignore them too (`java\nscript:`).
  private static func allowed(href: String) -> Bool {
    let compact = String(String.UnicodeScalarView(href.unicodeScalars.filter { $0.value > 0x20 && $0.value != 0x7F }))
    guard let colon = compact.firstIndex(of: ":") else { return true }
    let scheme = compact[..<colon]
    guard let first = scheme.unicodeScalars.first, (first >= "a" && first <= "z") || (first >= "A" && first <= "Z"),
      scheme.unicodeScalars.allSatisfy({ ($0 >= "a" && $0 <= "z") || ($0 >= "A" && $0 <= "Z") || ($0 >= "0" && $0 <= "9") || $0 == "+" || $0 == "-" || $0 == "." })
    else { return true }  // the colon is in a path or query, not after a scheme
    return allowedSchemes.contains(scheme.lowercased())
  }

  private static func escape(_ text: String, quotes: Bool) -> String {
    var out = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
    if quotes { out = out.replacingOccurrences(of: "\"", with: "&quot;") }
    return out
  }
}
