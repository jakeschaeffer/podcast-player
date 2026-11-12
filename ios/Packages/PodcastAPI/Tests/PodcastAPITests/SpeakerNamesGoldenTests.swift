import Foundation
import Testing

@testable import PodcastAPI

/// Replays contracts/golden/speakers/speaker_names_v1.json (recorded by the server, whose speakerDisplayName and
/// clipTurns are the reference) against `Speaker.displayName` and `Speaker.clipTurns`.
struct SpeakerNamesGoldenTests {
  struct Golden: Decodable {
    let version: String
    let displayName: [DisplayCase]
    let clipTurns: [TurnsCase]
  }

  struct DisplayCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let label: String?
    let speakers: [Speaker]?
    let expect: String?
    var testDescription: String { name }
  }

  struct Run: Decodable, Sendable {
    let speaker: String?
    let text: String
  }

  struct TurnsCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let turns: [Run]
    let speakers: [Speaker]?
    let expect: [Speaker.Turn]?
    var testDescription: String { name }
  }

  static let golden: Golden = {
    let url = URL(filePath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()  // PodcastAPI
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()  // repo root
      .appending(path: "contracts/golden/speakers/speaker_names_v1.json")
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try! decoder.decode(Golden.self, from: Data(contentsOf: url))
  }()

  @Test func isTheVersionThisPortImplements() {
    #expect(Self.golden.version == "speaker_names_v1")
  }

  @Test(arguments: golden.displayName)
  func displayName(_ c: DisplayCase) {
    #expect(Speaker.displayName(c.label, in: c.speakers) == c.expect)
  }

  @Test(arguments: golden.clipTurns)
  func clipTurns(_ c: TurnsCase) {
    #expect(Speaker.clipTurns(c.turns.map { ($0.speaker, $0.text) }, in: c.speakers) == c.expect)
  }
}
