import PlayerKit
import PodcastAPI
import SwiftUI

/// The transcript follows playback word by word, like web/src/player/TranscriptView.tsx: the word being spoken is
/// highlighted and kept a third of the way down the view, scrolling a line at a time as speech moves on, and jumping
/// straight there after a seek. Scrolling away stops following until "Follow audio" is tapped. A tap on a paragraph
/// plays from its start.
struct TranscriptView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  let episode: EpisodeDetail
  /// A snip card covers the lower part of the view; the spoken line is then kept higher so it stays above it.
  var covered = false
  /// The episode's current transcript (the publisher's text once aligned, else ASR); nil until it is processed.
  private var transcriptID: ULID? { episode.transcriptId }

  /// Where the spoken line is kept: this far down the visible transcript (higher while a snip card covers it).
  private var anchor: CGFloat { covered ? 0.1 : 0.3 }
  @AppStorage(TranscriptTextSize.key) private var textSize = TranscriptTextSize.large
  /// A line's height at the chosen size; the view scrolls once the spoken word is this far from the anchor.
  private var lineHeight: CGFloat { textSize.scaledPoints * 1.3 }

  @State private var transcript: (id: ULID, transcript: Transcript)?
  @State private var failed = false
  /// Names for the speaker labels, when the server knows them; "Speaker 1" until then.
  @State private var speakers: (id: ULID, list: [Speaker]?)?
  @State private var following = true
  @State private var position = ScrollPosition(idType: Int.self)
  @State private var offsetY: CGFloat = 0
  @State private var viewportHeight: CGFloat = 0
  /// The spoken segment's frame in the scroll view's visible coordinates, and which segment it was measured for.
  @State private var spokenFrame: (index: Int, frame: CGRect)?

  var body: some View {
    Group {
      if transcriptID == nil {
        TranscribePrompt(episode: episode)
      } else if failed {
        ContentUnavailableView("The transcript could not be loaded", systemImage: "exclamationmark.triangle")
      } else if let transcript, transcript.id == transcriptID {
        reader(transcript.transcript.segments)
      } else {
        ProgressView("Loading transcript…").frame(maxHeight: .infinity)
      }
    }
    .task(id: transcriptID) { await load() }
  }

  private func reader(_ segments: [TranscriptSegment]) -> some View {
    let current = TranscriptPosition.segmentIndex(segments, at: engine.positionMs)
    let word = current.flatMap { TranscriptPosition.wordIndex(segments[$0], at: engine.positionMs) }
    return ScrollView {
      LazyVStack(alignment: .leading, spacing: 24) {
        ForEach(segments.indices, id: \.self) { i in
          SegmentRow(
            segment: segments[i],
            points: textSize.scaledPoints,
            speaker: segments[i].spk.flatMap { spk in
              spk != (i > 0 ? segments[i - 1].spk : nil) ? Speaker.displayName(spk, in: speakers?.id == transcriptID ? speakers?.list : nil) : nil
            },
            spokenWord: i == current ? (word ?? -1) : nil
          )
          .contentShape(.rect)
          .onTapGesture {
            engine.seek(to: segments[i].s)
            following = true
          }
          .onGeometryChange(for: CGRect?.self) { proxy in i == current ? proxy.frame(in: .scrollView) : nil } action: {
            if let frame = $0 { spokenFrame = (i, frame) }
          }
        }
      }
      .scrollTargetLayout()
      .padding(.vertical, 12)
    }
    .scrollPosition($position)
    .onScrollGeometryChange(for: CGRect.self) { $0.visibleRect } action: { _, rect in
      offsetY = rect.minY
      viewportHeight = rect.height
    }
    // Only the reader's own drag stops following; the scrolling below never does.
    .onScrollPhaseChange { _, phase in if phase == .interacting { following = false } }
    .onChange(of: word) { follow(segments, current: current, word: word, force: false) }
    .onChange(of: spokenFrame?.frame) { follow(segments, current: current, word: word, force: false) }
    .onChange(of: following) { follow(segments, current: current, word: word, force: true) }
    .onChange(of: covered) { follow(segments, current: current, word: word, force: true) }
    .onAppear { follow(segments, current: current, word: word, force: true) }
    .onChange(of: textSize) { follow(segments, current: current, word: word, force: true) }
    .overlay(alignment: .bottom) {
      if !following {
        Button {
          following = true
        } label: {
          Label("Follow audio", systemImage: "arrow.up").font(.callout.weight(.semibold))
        }
        .buttonStyle(.borderedProminent)
        .padding(.bottom, 12)
        .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.2), value: following)
  }

  /// Bring the spoken word's line to the anchor. Unforced, it moves only once the word is a line away from it, so the
  /// text steps up one line at a time. A segment that isn't laid out yet (after a seek) is jumped to first.
  private func follow(_ segments: [TranscriptSegment], current: Int?, word: Int?, force: Bool) {
    guard following, let current, viewportHeight > 0 else { return }
    guard let measured = spokenFrame, measured.index == current else {
      position.scrollTo(id: current, anchor: UnitPoint(x: 0, y: anchor))
      return
    }
    let segment = segments[current]
    let frame = measured.frame
    // How far down its paragraph the word sits, by characters: close enough to find its line.
    let before = segment.words.prefix(max(word ?? 0, 0)).reduce(0) { $0 + $1.text.count + 1 }
    let total = max(segment.words.reduce(0) { $0 + $1.text.count + 1 }, 1)
    let wordY = frame.minY + frame.height * CGFloat(before) / CGFloat(total)
    let off = wordY - viewportHeight * anchor
    guard force || abs(off) > lineHeight * 0.75 else { return }
    let far = abs(off) > viewportHeight * 2
    withAnimation(far ? nil : .easeInOut(duration: 0.3)) {
      position.scrollTo(y: max(0, offsetY + off))
    }
  }

  private func load() async {
    failed = false
    guard let id = transcriptID else { return }
    do {
      transcript = (id, try await TranscriptCache.load(id, api: model.api, offline: model.downloads))
    } catch is CancellationError {
    } catch {
      failed = true
    }
    if let list = try? await model.api.speakers(id) { speakers = (id, list) }
  }
}

/// The transcript's text size and what turning the phone does, beside the player's panel tabs.
struct TranscriptSettingsButton: View {
  @AppStorage(TranscriptTextSize.key) private var textSize = TranscriptTextSize.large
  @AppStorage(SidewaysPlayer.key) private var sideways = SidewaysPlayer.karaoke

  var body: some View {
    Menu {
      TranscriptTextSize.picker($textSize)
      SidewaysPlayer.picker($sideways)
    } label: {
      Image(systemName: "textformat.size")
        .font(.callout.weight(.semibold))
        .frame(width: 36, height: 36)
        .background(Color(.systemGray5), in: .circle)
    }
    .accessibilityLabel("Transcript settings")
    // A button beside the panel picker, which doesn't grow: the mark stays inside its circle at every text size.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }
}

/// No transcript yet: say where it stands, and offer to transcribe it. Transcription bills per audio hour, so the
/// button asks first and says roughly what it costs. While it runs, the episode is re-read until the transcript lands.
private struct TranscribePrompt: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  let episode: EpisodeDetail
  /// The server's default TRANSCRIPTION_CENTS_PER_HOUR (ElevenLabs' rate); only for the estimate shown before asking.
  static let centsPerHour = 22.0
  @State private var confirming = false
  @State private var error: String?

  private var state: JobState { episode.processing.transcript }
  private var working: Bool { state == .queued || state == .running || episode.processing.audio == .queued || episode.processing.audio == .running }

  var body: some View {
    VStack(spacing: 12) {
      if working {
        ProgressView()
        Text("Transcribing…").font(.headline)
        Text("The transcript appears here when it's ready, usually within a few minutes.")
          .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
      } else {
        Image(systemName: "text.quote").font(.largeTitle).foregroundStyle(.secondary)
        Text(state == .failed ? "Transcription failed" : state == .deferred ? "Transcription is waiting" : "No transcript yet")
          .font(.headline)
        Button(state == .failed ? "Try again" : "Transcribe this episode") { confirming = true }
          .buttonStyle(.borderedProminent)
        Text(estimate).font(.footnote).foregroundStyle(.secondary)
      }
      if let error { Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center) }
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .confirmationDialog("Transcribe this episode?", isPresented: $confirming, titleVisibility: .visible) {
      Button("Transcribe") { Task { await transcribe() } }
    } message: {
      Text(estimate)
    }
    // While it works, re-read the episode until the transcript is there (or the job stops).
    .task(id: working) {
      while working && !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        await engine.refreshEpisode()
      }
    }
  }

  private var estimate: String {
    guard let ms = episode.asset?.durationMs ?? episode.durationMs else { return "Billed per audio hour." }
    let cents = Double(ms) / 3_600_000 * Self.centsPerHour
    return "About \(Int(cents.rounded(.up)))¢ for \(Format.clock(ms)) of audio."
  }

  private func transcribe() async {
    do {
      _ = try await model.api.processEpisode(episode.id)
      error = nil
      await engine.refreshEpisode()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// One paragraph: its time, the speaker when it changes, and the text. The spoken paragraph is in full colour with
/// its current word marked; the rest are dimmed.
private struct SegmentRow: View, Equatable {
  let segment: TranscriptSegment
  let points: CGFloat
  let speaker: String?
  /// The word being spoken in this segment (-1 before its first word), or nil when another segment is playing.
  let spokenWord: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 8) {
        Text(Format.clock(segment.s)).monospacedDigit()
        if let speaker { Text(speaker).fontWeight(.semibold) }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      Text(text)
        .font(.system(size: points))
        .foregroundStyle(spokenWord == nil ? .secondary : .primary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var text: AttributedString {
    guard let spokenWord, spokenWord >= 0 else {
      return AttributedString(segment.words.map(\.text).joined(separator: " "))
    }
    var out = AttributedString()
    for (j, word) in segment.words.enumerated() {
      var piece = AttributedString(word.text)
      if j == spokenWord {
        piece.backgroundColor = .accentColor.opacity(0.4)
      }
      out += piece
      if j < segment.words.count - 1 { out += AttributedString(" ") }
    }
    return out
  }
}

/// How big the transcript's text is. Larger by default than body text, since it is read at arm's length while
/// listening; set from the transcript's Aa button or Today's account menu. Scales with the system text size.
enum TranscriptTextSize: Int, CaseIterable, Identifiable {
  case small, medium, large, larger, largest

  static let key = "transcript.textSize"
  var id: Int { rawValue }

  var points: CGFloat { [17, 20, 24, 28, 34][rawValue] }
  var scaledPoints: CGFloat { UIFontMetrics(forTextStyle: .body).scaledValue(for: points) }
  var name: String { ["Small", "Medium", "Large", "Larger", "Largest"][rawValue] }

  /// The size choices, for a menu.
  static func picker(_ selection: Binding<TranscriptTextSize>) -> some View {
    Picker("Transcript text", systemImage: "textformat.size", selection: selection) {
      ForEach(allCases) { Text($0.name).tag($0) }
    }
  }
}
