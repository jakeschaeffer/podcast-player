import Foundation

// A port of server/src/core/feed/parse.ts, tested on the cases of parse.test.ts. The server reads the XML with
// fast-xml-parser into nested objects keyed by tag name as written (`itunes:author`); this reads it with
// Foundation's XMLParser into the same kind of tree, with namespace processing off so the names match, and the
// rules over the tree are the server's line for line. Change the TypeScript first.

struct FeedMeta: Equatable, Sendable {
  var title: String?
  var author: String?
  var imageUrl: String?
  var siteUrl: String?
  var language: String?
}

struct FeedItem: Equatable, Sendable {
  /// Stable identity: the GUID, else the enclosure URL without a query string, else the link.
  var identity: String
  var identitySource: String
  var title: String
  /// As the publisher wrote it; sanitized when stored (`ShowNotes.sanitize`).
  var descriptionHtml: String?
  var publishedAt: Int?
  var enclosureUrl: String
  var enclosureType: String?
  var enclosureBytes: Int?
  /// What the enclosure is: "video" when the only enclosure is a video.
  var mediaKind: String
  /// A video enclosure beside the audio one (`<enclosure type="video/…">` or `<podcast:alternateEnclosure>`).
  var videoUrl: String?
  var durationHintMs: Int?
  var imageUrl: String?
  var link: String?
  /// A Podcasting 2.0 JSON chapters file (`<podcast:chapters url=… type="application/json+chapters">`), fetched later.
  var chaptersUrl: String?
  /// Podlove Simple Chapters inline in the item.
  var chapters: [ChapterPoint]?
}

struct SkippedItem: Equatable, Sendable {
  var title: String?
  var reason: String
}

struct ParsedFeed: Equatable, Sendable {
  var feed: FeedMeta
  var items: [FeedItem]
  /// Items skipped because they had no enclosure or no usable identity.
  var skipped: [SkippedItem]
}

struct FeedParseError: Error, LocalizedError, Equatable {
  let message: String
  var errorDescription: String? { message }
}

enum FeedParser {
  /// Parse an RSS 2.0 podcast feed with the iTunes and podcast namespaces. Tolerant of missing fields. Pure: no
  /// network, no clock. Throws only when the document is not a feed at all.
  static func parse(_ xml: String) throws -> ParsedFeed { try parse(Data(xml.utf8)) }

  static func parse(_ data: Data) throws -> ParsedFeed {
    let document = XMLTree.read(data)
    let rss = document.child("rss")
    guard let channel = rss?.child("channel") ?? document.child("channel") else {
      throw FeedParseError(message: "not an RSS feed: no <channel>")
    }

    let feed = FeedMeta(
      title: text(channel.child("title")),
      author: text(channel.child("itunes:author")) ?? text(channel.child("managingEditor")),
      imageUrl: imageUrl(channel),
      siteUrl: text(channel.child("link")),
      language: text(channel.child("language")))

    let dates = DateReader()
    var items: [FeedItem] = []
    var skipped: [SkippedItem] = []
    for item in channel.children("item") {
      let title = text(item.child("title")) ?? "(untitled)"
      let enclosures = item.children("enclosure")
      let isVideo = { (e: XMLTree.Node) in (e.attributes["type"] ?? "").hasPrefix("video/") }
      guard
        let enclosure = enclosures.first(where: { $0.attributes["url"] != nil && ($0.attributes["type"] ?? "").hasPrefix("audio/") })
          ?? enclosures.first(where: { $0.attributes["url"] != nil })
      else {
        skipped.append(SkippedItem(title: title, reason: "no enclosure"))
        continue
      }
      let enclosureUrl = (enclosure.attributes["url"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      var video: (url: String, type: String?)?
      if !isVideo(enclosure) {
        if let other = enclosures.first(where: { $0.attributes["url"] != nil && isVideo($0) }) {
          video = (other.attributes["url"]!, other.attributes["type"])
        } else {
          video = alternateVideo(item)
        }
      }
      let link = text(item.child("link"))
      let identity: String
      let identitySource: String
      if let guid = text(item.child("guid")) {
        identity = guid
        identitySource = "guid"
      } else if !enclosureUrl.isEmpty {
        identity = String(enclosureUrl.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        identitySource = "enclosure"
      } else if let link {
        identity = link
        identitySource = "link"
      } else {
        skipped.append(SkippedItem(title: title, reason: "no identity"))
        continue
      }
      let bytes = number(enclosure.attributes["length"])
      items.append(
        FeedItem(
          identity: identity,
          identitySource: identitySource,
          title: title,
          descriptionHtml: text(item.child("content:encoded")) ?? text(item.child("description")) ?? text(item.child("itunes:summary")),
          publishedAt: text(item.child("pubDate")).flatMap(dates.unixMs),
          enclosureUrl: enclosureUrl,
          enclosureType: enclosure.attributes["type"],
          enclosureBytes: bytes.flatMap { $0.isFinite && $0 > 0 ? Int($0) : nil },
          mediaKind: isVideo(enclosure) ? "video" : "audio",
          videoUrl: video?.url.trimmingCharacters(in: .whitespacesAndNewlines),
          durationHintMs: duration(text(item.child("itunes:duration"))),
          imageUrl: imageUrl(item),
          link: link,
          chaptersUrl: chaptersUrl(item),
          chapters: pscChapters(item)))
    }
    return ParsedFeed(feed: feed, items: items, skipped: skipped)
  }

  /// An element's own text, trimmed; a CDATA section wins over text beside it. Nil when there is none.
  ///
  /// Two places where this is deliberately not the server: fast-xml-parser turns text that looks like a number into
  /// one, so an episode titled "007" is "7" there and "007" here; and a tag written twice comes out there as a
  /// list, which its `text` reads as nothing, where this reads the first.
  private static func text(_ node: XMLTree.Node?) -> String? {
    guard let node else { return nil }
    let cdata = node.cdata.trimmingCharacters(in: .whitespacesAndNewlines)
    if !cdata.isEmpty { return cdata }
    let text = node.text.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  /// A Podcasting 2.0 `<podcast:alternateEnclosure type="video/…">` with a `<podcast:source uri=…>` inside, if any.
  private static func alternateVideo(_ item: XMLTree.Node) -> (url: String, type: String?)? {
    for alternate in item.children("podcast:alternateEnclosure") where (alternate.attributes["type"] ?? "").hasPrefix("video/") {
      if let uri = alternate.children("podcast:source").first?.attributes["uri"], isHttp(uri) {
        return (uri, alternate.attributes["type"])
      }
    }
    return nil
  }

  /// The item's JSON chapters URL; a tag of another type (a few feeds point at an HTML page) is ignored.
  private static func chaptersUrl(_ item: XMLTree.Node) -> String? {
    for tag in item.children("podcast:chapters") {
      let url = (tag.attributes["url"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let type = (tag.attributes["type"] ?? "").lowercased()
      if isHttp(url), type.isEmpty || type.contains("json") { return url }
    }
    return nil
  }

  /// Podlove Simple Chapters: `start` in normal play time, `title` required. Nil when fewer than two survive.
  private static func pscChapters(_ item: XMLTree.Node) -> [ChapterPoint]? {
    guard let container = item.child("psc:chapters") else { return nil }
    var points: [ChapterPoint] = []
    for chapter in container.children("psc:chapter") {
      guard let start = chapter.attributes["start"].flatMap(ChapterPoints.parseNpt), let title = chapter.attributes["title"], !title.isEmpty
      else { continue }
      points.append(ChapterPoint(startMs: start, title: title))
    }
    return ChapterPoints.orderedPoints(points)
  }

  private static func imageUrl(_ node: XMLTree.Node) -> String? {
    if let href = node.child("itunes:image")?.attributes["href"] { return href }
    return text(node.child("image")?.child("url"))
  }

  private static func isHttp(_ url: String) -> Bool {
    url.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil
  }

  /// JavaScript's `Number(string)` as far as feeds use it: surrounding space ignored, empty is 0, anything else
  /// that is not a number is nil (NaN there).
  private static func number(_ value: String?) -> Double? {
    guard let value else { return nil }
    let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? 0 : Double(t)
  }

  /// `HH:MM:SS`, `MM:SS`, or plain seconds, as iTunes allows.
  static func duration(_ value: String?) -> Int? {
    guard let value, !value.isEmpty else { return nil }
    var seconds = 0.0
    for part in value.split(separator: ":", omittingEmptySubsequences: false) {
      guard let n = number(String(part)), n.isFinite, n >= 0 else { return nil }
      seconds = seconds * 60 + n
    }
    return seconds > 0 ? Int((seconds * 1000).rounded()) : nil
  }
}

/// `pubDate` as feeds write it: RFC 822 with a numeric or named zone, with or without the weekday or the seconds,
/// or an ISO 8601 time. The server leaves this to JavaScript's `Date.parse`, which takes all of these.
struct DateReader {
  private let formatters: [DateFormatter]
  private let iso = ISO8601DateFormatter()
  private let isoFractional: ISO8601DateFormatter

  init() {
    formatters = ["d MMM yyyy HH:mm:ss Z", "d MMM yyyy HH:mm:ss zzz", "d MMM yyyy HH:mm Z", "d MMM yyyy HH:mm zzz"].map {
      let f = DateFormatter()
      f.locale = Locale(identifier: "en_US_POSIX")
      f.timeZone = TimeZone(identifier: "UTC")
      f.dateFormat = $0
      return f
    }
    isoFractional = ISO8601DateFormatter()
    isoFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  }

  func unixMs(_ value: String) -> Int? {
    var t = value.trimmingCharacters(in: .whitespacesAndNewlines)
    // The weekday says nothing the date does not, and feeds get it wrong; JavaScript ignores it too.
    if let comma = t.firstIndex(of: ","), t.distance(from: t.startIndex, to: comma) <= 9 {
      t = t[t.index(after: comma)...].trimmingCharacters(in: .whitespaces)
    }
    for formatter in formatters {
      if let date = formatter.date(from: t) { return Int((date.timeIntervalSince1970 * 1000).rounded()) }
    }
    if let date = iso.date(from: t) ?? isoFractional.date(from: t) { return Int((date.timeIntervalSince1970 * 1000).rounded()) }
    return nil
  }
}

/// An XML document as a tree of elements with their attributes and own text, names kept as written.
enum XMLTree {
  final class Node {
    let name: String
    let attributes: [String: String]
    var children: [Node] = []
    var text = ""
    var cdata = ""

    init(name: String, attributes: [String: String]) {
      self.name = name
      self.attributes = attributes
    }

    func child(_ name: String) -> Node? { children.first { $0.name == name } }
    func children(_ name: String) -> [Node] { children.filter { $0.name == name } }
  }

  /// The document under a nameless root. A document XMLParser gives up on partway (feeds in the wild have a bare
  /// `&` or an HTML entity such as `&nbsp;` outside CDATA, which strict XML forbids and fast-xml-parser lets by) is
  /// read again with those repaired; whatever was read before a remaining error is kept, as the server's lenient
  /// parser keeps it. A refresh only ever adds episodes, so a feed cut short loses nothing already stored.
  static func read(_ data: Data) -> Node {
    let first = Builder()
    if first.run(data) { return first.root }
    guard let source = String(data: data, encoding: .utf8) else { return first.root }
    let second = Builder()
    _ = second.run(Data(repairEntities(source).utf8))
    return second.root
  }

  private final class Builder: NSObject, XMLParserDelegate {
    let root = Node(name: "", attributes: [:])
    private var stack: [Node] = []

    func run(_ data: Data) -> Bool {
      let parser = XMLParser(data: data)
      parser.delegate = self
      parser.shouldProcessNamespaces = false
      // Never fetch anything a document names (a DTD, an external entity).
      parser.shouldResolveExternalEntities = false
      stack = [root]
      return parser.parse()
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
      let node = Node(name: elementName, attributes: attributeDict)
      stack.last?.children.append(node)
      stack.append(node)
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
      if stack.count > 1 { stack.removeLast() }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
      stack.last?.text += string
    }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
      stack.last?.cdata += String(decoding: CDATABlock, as: UTF8.self)
    }
  }

  private static let xmlEntities: Set<String> = ["amp", "lt", "gt", "quot", "apos"]

  /// Outside CDATA sections: an HTML entity becomes the character it names (as a numeric reference, which XML
  /// allows), and an `&` that begins no reference becomes `&amp;`.
  static func repairEntities(_ xml: String) -> String {
    var out = ""
    var rest = Substring(xml)
    while let open = rest.range(of: "<![CDATA[") {
      out += repairText(rest[..<open.lowerBound])
      guard let close = rest.range(of: "]]>", range: open.upperBound..<rest.endIndex) else {
        out += rest[open.lowerBound...]
        return out
      }
      out += rest[open.lowerBound..<close.upperBound]
      rest = rest[close.upperBound...]
    }
    return out + repairText(rest)
  }

  private static func repairText(_ text: Substring) -> String {
    guard text.contains("&") else { return String(text) }
    var out = ""
    var rest = text
    while let amp = rest.firstIndex(of: "&") {
      out += rest[..<amp]
      let after = rest[rest.index(after: amp)...]
      if let semi = after.prefix(34).firstIndex(of: ";") {
        let name = String(after[..<semi])
        if xmlEntities.contains(name) || name.range(of: #"^#([0-9]+|[xX][0-9a-fA-F]+)$"#, options: .regularExpression) != nil {
          out += "&\(name);"
          rest = after[after.index(after: semi)...]
          continue
        }
        if let character = HTML.namedEntities[name] {
          out += character.unicodeScalars.map { "&#\($0.value);" }.joined()
          rest = after[after.index(after: semi)...]
          continue
        }
      }
      out += "&amp;"
      rest = after
    }
    return out + rest
  }
}
