import Foundation
import Testing

@testable import PlayerKit

/// Replays every case in contracts/golden/heard/heard_v1.json against the Swift port.
struct HeardTrackerGoldenTests {
  struct Golden: Decodable {
    let family: String
    let version: String
    let cases: [Case]
  }

  struct Case: Decodable, CustomTestStringConvertible, Sendable {
    let name: String
    let steps: [Step]
    var testDescription: String { name }
  }

  struct Step: Decodable, Sendable {
    let op: String
    var startMs: Int?
    var assumeHeardBeforeMs: Int?
    var posMs: Int?
    var playing: Bool?
    var speed: Double?
    var wallMs: Int?
    var fromMs: Int?
    var toMs: Int?
    var expectFrom: Int?
    var expectRanges: [[Int]]?

    enum CodingKeys: String, CodingKey {
      case op, startMs, assumeHeardBeforeMs, posMs, playing, speed, wallMs, fromMs, toMs, expect
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      op = try c.decode(String.self, forKey: .op)
      startMs = try c.decodeIfPresent(Int.self, forKey: .startMs)
      assumeHeardBeforeMs = try c.decodeIfPresent(Int.self, forKey: .assumeHeardBeforeMs)
      posMs = try c.decodeIfPresent(Int.self, forKey: .posMs)
      playing = try c.decodeIfPresent(Bool.self, forKey: .playing)
      speed = try c.decodeIfPresent(Double.self, forKey: .speed)
      wallMs = try c.decodeIfPresent(Int.self, forKey: .wallMs)
      fromMs = try c.decodeIfPresent(Int.self, forKey: .fromMs)
      toMs = try c.decodeIfPresent(Int.self, forKey: .toMs)
      if op == "heard_from" { expectFrom = try c.decode(Int.self, forKey: .expect) }
      if op == "ranges" { expectRanges = try c.decode([[Int]].self, forKey: .expect) }
    }
  }

  static let file = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()  // PlayerKit
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()  // repo root
    .appending(path: "contracts/golden/heard/heard_v1.json")

  static let golden: Golden = {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try! decoder.decode(Golden.self, from: Data(contentsOf: file))
  }()

  @Test func fileIsHeardV1() {
    #expect(Self.golden.version == "heard_v1")
    #expect(Self.golden.cases.count > 0)
  }

  @Test(arguments: golden.cases)
  func replays(_ c: Case) throws {
    var tracker = HeardTracker()
    for (i, step) in c.steps.enumerated() {
      switch step.op {
      case "reset":
        tracker.reset(startMs: try #require(step.startMs), assumeHeardBeforeMs: step.assumeHeardBeforeMs ?? 0)
      case "tick":
        tracker.tick(
          posMs: try #require(step.posMs), playing: try #require(step.playing), speed: try #require(step.speed),
          wallMs: try #require(step.wallMs))
      case "jump":
        tracker.jump(fromMs: try #require(step.fromMs), toMs: try #require(step.toMs))
      case "heard_from":
        #expect(tracker.heardFrom(try #require(step.posMs)) == step.expectFrom, "step \(i)")
      case "ranges":
        #expect(tracker.heardRanges(try #require(step.posMs)) == step.expectRanges, "step \(i)")
      default:
        Issue.record("unknown op \(step.op) at step \(i)")
      }
    }
  }
}

struct SignedURLTests {
  @Test func readsExpiryFromTheEParameter() throws {
    let url = try #require(URL(string: "http://pods.test/m/assets/X?e=1800003600&d=D&s=S"))
    #expect(SignedURL.expiry(from: url) == Date(timeIntervalSince1970: 1_800_003_600))
    #expect(SignedURL.needsRenewal(url, now: Date(timeIntervalSince1970: 1_800_003_600 - 11 * 60)) == false)
    #expect(SignedURL.needsRenewal(url, now: Date(timeIntervalSince1970: 1_800_003_600 - 9 * 60)) == true)
  }

  @Test func playsMediaOnTheAppsOwnServer() throws {
    let base = try #require(URL(string: "http://localhost:8081"))
    let signed = "https://snip.example.com/m/assets/X?e=1800003600&d=D&s=a%2Bb-c_"
    #expect(SignedURL.onServer(signed, base: base)?.absoluteString == "http://localhost:8081/m/assets/X?e=1800003600&d=D&s=a%2Bb-c_")
    // Share links and other hosts' files stay as they are.
    #expect(SignedURL.onServer("https://snip.example.com/s/abc", base: base)?.absoluteString == "https://snip.example.com/s/abc")
    #expect(SignedURL.onServer("/m/clips/Y?e=1", base: base)?.absoluteString == "http://localhost:8081/m/clips/Y?e=1")
  }
}
