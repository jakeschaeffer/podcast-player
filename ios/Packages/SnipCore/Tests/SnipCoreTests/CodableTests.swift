import Foundation
import Testing

@testable import SnipCore

/// The types encode to what the server stores and serves, so the phone's backend can keep the same shapes.
struct CodableTests {
  static func json<T: Encodable>(_ value: T) -> String {
    String(decoding: Golden.bytes(value), as: UTF8.self)
  }

  /// contracts/api/transcripts.get.json is a recorded `GET /v1/transcripts/{id}`: reading its body and writing it
  /// back must lose nothing and add nothing.
  @Test func apiTranscriptRoundTripsTheRecordedResponse() throws {
    let file = Golden.repoRoot.appending(path: "contracts/api/transcripts.get.json")
    let recording = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    let body = try #require(recording["body"] as? NSDictionary)
    let api = try JSONDecoder().decode(ApiTranscript.self, from: JSONSerialization.data(withJSONObject: body))
    #expect(api.id != nil && api.assetId != nil)
    #expect(api.segments.reduce(0) { $0 + $1.words.count } == api.wordCount)
    let written = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(api)) as? NSDictionary)
    #expect(written == body)
  }

  @Test func apiShapeAndStoredShapeConvertBothWays() throws {
    let raw = RawTranscript(
      provider: "test", model: "golden", language: nil,
      words: [
        RawWord(text: "Hi", startMs: 0, endMs: 300, speaker: "a"), RawWord(text: "there.", startMs: 350, endMs: 650, speaker: "a"),
        RawWord(text: "Hello.", startMs: 700, endMs: 1_000, speaker: "b"),
      ],
      events: [RawEvent(label: "music", startMs: 0, endMs: 100)])
    let t = try normalize(raw)
    let api = toApiTranscript(t, id: "T1", assetId: "A1")
    #expect(Self.json(api) == #"{"asset_id":"A1","events":[[0,100,"music"]],"id":"T1","language":null,"segments":[{"e":650,"s":0,"spk":"S1","w0":0,"words":[[0,300,"Hi"],[350,650,"there."]]},{"e":1000,"s":700,"spk":"S2","w0":2,"words":[[700,1000,"Hello."]]}],"word_count":3}"#)
    #expect(Self.json(toApiTranscript(t)).contains("\"id\"") == false)
    expectSame(NormalizedTranscript(api: api, provider: "test", model: "golden"), t)
  }

  /// A segment row: the columns by name, `words` being the JSON its column holds, and no speaker written as null.
  @Test func segmentEncodesAsItsRow() throws {
    let segment = Segment(idx: 0, startMs: 10, endMs: 311, speaker: nil, firstWord: 0, text: "a b", words: [WordTuple(10, 300, "a"), WordTuple(300, 311, "b")])
    #expect(Self.json(segment) == #"{"end_ms":311,"first_word":0,"idx":0,"speaker":null,"start_ms":10,"text":"a b","words":[[10,300,"a"],[300,311,"b"]]}"#)
    #expect(Self.json(segment.words) == #"[[10,300,"a"],[300,311,"b"]]"#)
    let t = NormalizedTranscript(provider: "p", model: "m", language: nil, wordCount: 2, segments: [segment], events: [EventTuple(0, 5, "music")])
    #expect(Self.json(t).hasPrefix(#"{"events":[[0,5,"music"]],"language":null,"model":"m","provider":"p","segments":[{"#))
    expectSame(try JSONDecoder().decode(NormalizedTranscript.self, from: Golden.bytes(t)), t)
  }

  /// An ad break as `ad_detection.breaks` and an episode's `ad_breaks` hold it.
  @Test func adBreakEncodesAsStored() throws {
    let found = AdBreak(startMs: 5_000, endMs: 40_000, confidence: .medium, sources: [.adChapter], cue: nil)
    #expect(Self.json([found]) == #"[{"confidence":"medium","cue":null,"end_ms":40000,"sources":["ad_chapter"],"start_ms":5000}]"#)
    let heard = AdBreak(startMs: 0, endMs: 30_000, confidence: .high, sources: [.publisherGap, .sponsorPhrase, .adChapter], cue: "promo code")
    #expect(Self.json(heard) == #"{"confidence":"high","cue":"promo code","end_ms":30000,"sources":["publisher_gap","sponsor_phrase","ad_chapter"],"start_ms":0}"#)
    expectSame(try JSONDecoder().decode([AdBreak].self, from: Golden.bytes([found, heard])), [found, heard])
    // A summary chapter carries more than the detector reads; the rest is ignored.
    let chapter = try JSONDecoder().decode(AdChapter.self, from: Data(#"{"start_ms":1,"end_ms":2,"kind":"ad","title":"Sponsor"}"#.utf8))
    #expect(chapter == AdChapter(startMs: 1, endMs: 2, kind: "ad"))
  }

  @Test func sentenceAndTurnWriteNoSpeakerAsNull() {
    #expect(Self.json(Sentence(id: 0, speaker: nil, startWord: 0, endWord: 1, startMs: 0, endMs: 5, text: "Hi.", wordCount: 1)) == #"{"end_ms":5,"end_word":1,"id":0,"speaker":null,"start_ms":0,"start_word":0,"text":"Hi.","word_count":1}"#)
    #expect(Self.json(SpeakerTurn(speaker: nil, text: "Hi.")) == #"{"speaker":null,"text":"Hi."}"#)
    #expect(Self.json(Alignment(ops: [.match, .sub, .del, .ins], pairs: [AlignedPair(0, 0)], sub: 1, del: 1, ins: 1)) == #"{"del":1,"ins":1,"ops":["match","sub","del","ins"],"pairs":[[0,0]],"sub":1}"#)
  }

  @Test func rawTranscriptReadsWhatAnAdapterWrites() throws {
    let text = #"{"provider":"p","model":"m","language":null,"words":[{"text":"a","start_ms":10.4,"end_ms":310.6,"speaker":"speaker_0","confidence":0.5},{"text":"b","start_ms":400,"end_ms":700}],"events":[{"label":"music","start_ms":0,"end_ms":1800}],"duration_ms":61250,"provider_request_id":"req_1"}"#
    let raw = try JSONDecoder().decode(RawTranscript.self, from: Data(text.utf8))
    #expect(raw.words == [RawWord(text: "a", startMs: 10.4, endMs: 310.6, speaker: "speaker_0", confidence: 0.5), RawWord(text: "b", startMs: 400, endMs: 700)])
    #expect(raw.durationMs == 61_250 && raw.costCents == nil && raw.providerRequestId == "req_1" && raw.language == nil)
    expectSame(try JSONDecoder().decode(RawTranscript.self, from: Golden.bytes(raw)), raw)
    #expect(Self.json(RawWord(text: "b", startMs: 400, endMs: 700)) == #"{"end_ms":400,"start_ms":400,"text":"b"}"#.replacingOccurrences(of: #""end_ms":400"#, with: #""end_ms":700"#))
  }
}
