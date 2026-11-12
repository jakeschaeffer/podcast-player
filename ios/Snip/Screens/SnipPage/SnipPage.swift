import PlayerKit
import PodcastAPI
import SwiftUI

/// Where a snip's page is pushed from: a snip bar or a row in a list.
struct SnipRoute: Hashable, Identifiable {
  let id: ULID
  /// Open with the title being edited, as the Live Activity's title asks.
  var renaming = false
}

/// One snip's own page, pushed from the player's snip bar and from the snip lists; swipe from the left edge to go
/// back. It is laid out for reading at arm's length: the title large, the summary, then the clip's own words, and one
/// row of actions at the bottom (Adjust, Play, Share). Tap the title to rename the snip where it stands. Adjust edits
/// the clip on its words: the words around it dim, a tap moves the nearer end, and press and hold chooses which. Turned sideways, the page becomes
/// the clip's words alone, as large as they fit, lighting up as it plays (SnipSideways).
struct SnipPage: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerEngine.self) private var engine
  @Environment(\.dismiss) private var dismiss
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var model: SnipPageModel
  @State private var mode = Mode.reading
  @State private var confirmingDelete = false
  /// Save was pressed on new In/Out points that change the length by more than 10 s: ask about the summary.
  @State private var askingToRewrite = false
  @FocusState private var titleFocused: Bool
  @ScaledMetric(relativeTo: .title) private var wordSize: CGFloat = 26
  /// The list that opened the page hears about each change to the snip, and about its deletion.
  let onChange: (Snip) -> Void
  let onDelete: () -> Void
  /// Start with the title being edited.
  let renaming: Bool

  enum Mode { case reading, title, adjusting }

  private static let titleFont = Font.system(.largeTitle, design: .rounded, weight: .bold)
  /// The app icon's dark, for marks on the accent colour.
  private static let ink = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)

  init(
    snipID: ULID, api: APIClient, renaming: Bool = false, onChange: @escaping (Snip) -> Void = { _ in },
    onDelete: @escaping () -> Void = {}
  ) {
    _model = State(initialValue: SnipPageModel(snipID: snipID, api: api))
    self.renaming = renaming
    self.onChange = onChange
    self.onDelete = onDelete
  }

  private var sideways: Bool { verticalSizeClass == .compact && mode == .reading && !model.spanWords.isEmpty }

  var body: some View {
    Group {
      if let error = model.loadError, model.snip == nil {
        ContentUnavailableView("Can't open this snip", systemImage: "exclamationmark.triangle", description: Text(error))
      } else if model.snip == nil {
        ProgressView()
      } else if sideways {
        SnipSideways(words: model.spanWords, positionMs: model.previewMs, progress: progress) {
          model.togglePreview(pausing: engine)
        }
      } else if mode == .adjusting {
        adjusting
      } else {
        reading
      }
    }
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(mode != .reading)
    .toolbar(sideways ? .hidden : .visible, for: .navigationBar, .tabBar)
    .persistentSystemOverlays(sideways ? .hidden : .automatic)
    .toolbar { toolbar }
    .task {
      await model.load()
      model.follow()
      if renaming { beginTitle() }
      #if DEBUG
        // `-snipMode title|adjust|play` opens the page in that state, for scripted simulator checks.
        switch UserDefaults.standard.string(forKey: "snipMode") {
        case "title": beginTitle()
        case "adjust": beginAdjusting()
        case "play": model.togglePreview(pausing: engine)
        default: break
        }
      #endif
    }
    .onChange(of: sideways, initial: true) { _, sideways in app.readingSideways = sideways }
    .onDisappear {
      model.stopPreview()
      model.stopFollowing()
      app.readingSideways = false
    }
    .onChange(of: model.snip) { _, snip in if let snip { onChange(snip) } }
    .confirmationDialog("Rewrite the summary?", isPresented: $askingToRewrite, titleVisibility: .visible) {
      Button("Rewrite summary") { Task { await commit(regenerate: true) } }
      Button("Keep current summary") { Task { await commit(regenerate: false) } }
      Button("Cancel", role: .cancel) {}
    } message: {
      let change = model.lengthChangeMs
      Text(
        "The clip is now \(Format.duration(abs(change))) \(change > 0 ? "longer" : "shorter"). "
          + (model.revision?.titleSource == "owner" ? "Your title stays either way." : "Rewriting also writes a new title."))
    }
    .confirmationDialog("Delete this snip?", isPresented: $confirmingDelete, titleVisibility: .visible) {
      Button("Delete snip", role: .destructive) {
        Task {
          if await model.delete() {
            onDelete()
            dismiss()
          }
        }
      }
    } message: {
      Text("Its shared link stops working.")
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    if mode == .reading {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          if let url = shareURL {
            Button("Copy link", systemImage: "link") { UIPasteboard.general.url = url }
          }
          Button("Delete snip", systemImage: "trash", role: .destructive) { confirmingDelete = true }
        } label: {
          Image(systemName: "ellipsis")
        }
        .accessibilityLabel("More")
      }
    } else {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { cancelEditing() }
      }
      ToolbarItem(placement: .confirmationAction) {
        Button(mode == .title ? "Done" : "Save") { Task { await commit() } }
          .tint(.accentColor)
          .disabled(model.saving)
      }
    }
  }

  // MARK: Reading

  private var reading: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 2) {
          if let show = model.snip?.showTitle { Text(show).lineLimit(2) }
          Text(at).monospacedDigit()
        }
        .font(.body.weight(.medium))
        .foregroundStyle(.secondary)
        titleView
        if model.previewing, model.previewHasVideo, let player = model.preview {
          PlayerLayerView(player: player)
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .transition(.opacity)
        }
        if let status {
          Label(status.text, systemImage: status.icon).font(.title3).foregroundStyle(status.failed ? .red : .secondary)
        }
        if model.revision?.status == .ready {
          if let quote = model.revision?.quote {
            Text("“\(quote)”").font(.system(.title2, design: .serif, weight: .semibold)).padding(.vertical, 4)
          }
          if let summary = model.revision?.summary { SummaryText(summary: summary) }
        }
        if model.revision?.status != .selecting {
          if let turns = model.turns {
            TurnsText(turns: turns)
          } else if let excerpt = model.revision?.excerpt {
            Text("“\(excerpt)”").font(.title2).foregroundStyle(.secondary)
          }
        }
        if let episode = model.snip?.episodeTitle {
          Text("From “\(episode)”").font(.body).foregroundStyle(.secondary)
        }
        if let error = model.saveError { Text(error).font(.body).foregroundStyle(.red) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 24)
      .padding(.top, 8)
      .padding(.bottom, 32)
    }
    .scrollDismissesKeyboard(.never)
    .safeAreaInset(edge: .bottom) {
      if mode == .reading { actions }
    }
  }

  @ViewBuilder private var titleView: some View {
    if mode == .title {
      TextField("Title", text: $model.title, axis: .vertical)
        .font(Self.titleFont)
        .focused($titleFocused)
        .submitLabel(.done)
        .onAppear { titleFocused = true }
        // The whole title starts selected, as in the snip bar: typing replaces it, a tap places the cursor.
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { note in
          guard let view = note.object as? UITextView else { return }
          Task { view.selectAll(nil) }
        }
        .onChange(of: model.title) { _, title in
          // Return ends the edit: a title is one line of thought, and a vertical field would take the newline.
          guard title.contains("\n") else { return }
          model.title = title.replacingOccurrences(of: "\n", with: "")
          Task { await commit() }
        }
    } else {
      Text(model.revision?.title ?? (model.snip?.isPending ?? false ? "Choosing the moment…" : "Snip"))
        .font(Self.titleFont)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .onTapGesture { beginTitle() }
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Renames the snip")
    }
  }

  /// Adjust, Play and Share, with Play in the middle of the screen whatever the others' widths.
  private var actions: some View {
    HStack(spacing: 0) {
      Button { beginAdjusting() } label: {
        Image(systemName: "slider.horizontal.3")
          .font(.title3.weight(.semibold))
          .frame(width: 56, height: 56)
          .background(Color(.systemGray5), in: .circle)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Adjust the clip")
      .disabled(!model.boundariesEditable)
      .opacity(model.boundariesEditable ? 1 : 0.4)
      .frame(maxWidth: .infinity, alignment: .leading)
      playButton
      Group {
        if let url = shareURL {
          ShareLink(item: url) {
            Image(systemName: "square.and.arrow.up")
              .font(.title3.weight(.semibold))
              .frame(width: 56, height: 56)
              .background(Color(.systemGray5), in: .circle)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Share")
        }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(.horizontal, 24)
    .padding(.top, 14)
    .padding(.bottom, 6)
    // Solid behind the buttons, with a short fade above them so the words scroll away underneath.
    .background {
      VStack(spacing: 0) {
        LinearGradient(colors: [Color(.systemBackground).opacity(0), Color(.systemBackground)], startPoint: .top, endPoint: .bottom)
          .frame(height: 36)
        Color(.systemBackground)
      }
      .padding(.top, -36)
      .ignoresSafeArea()
    }
  }

  private var playButton: some View {
    Button { model.togglePreview(pausing: engine) } label: {
      Image(systemName: model.previewing ? "pause.fill" : model.previewHasVideo ? "play.rectangle.fill" : "play.fill")
        .font(.system(size: 32, weight: .bold))
        .offset(x: model.previewing ? 0 : 2)
        .foregroundStyle(Self.ink)
        .frame(width: 80, height: 80)
        .background(Color.accentColor, in: .circle)
        .overlay {
          if model.previewing {
            Circle()
              .trim(from: 0, to: progress)
              .stroke(Color.primary, style: StrokeStyle(lineWidth: 4, lineCap: .round))
              .rotationEffect(.degrees(-90))
              .padding(-7)
          }
        }
    }
    .buttonStyle(.plain)
    .disabled(model.episode?.asset == nil)
    .accessibilityLabel(model.previewing ? "Pause" : "Play the snip")
  }

  // MARK: Adjusting

  private var adjusting: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 4) {
        Text("\(Format.clock(model.span.startMs)) – \(Format.clock(model.span.endMs))")
          .font(.system(.title, design: .rounded, weight: .bold))
          .monospacedDigit()
        Text(lengthLine).font(.body).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 12)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 22) {
            if model.moreEarlier {
              Button("Show earlier") { model.showEarlier() }.font(.body.weight(.semibold)).frame(maxWidth: .infinity)
            }
            let ends = spanEnds
            ForEach(model.segmentsInWindow, id: \.w0) { segment in
              FlowLayout(spacing: 7, lineSpacing: 4) {
                ForEach(Array(segment.words.enumerated()), id: \.offset) { i, word in
                  if segment.w0 + i == ends?.first { SpanHandle(atTop: true) }
                  Text(word.text)
                    .font(.system(size: wordSize, weight: .semibold, design: .rounded))
                    .foregroundStyle(model.inSpan(word) ? Color.primary : Color(.tertiaryLabel))
                    // The tint overlaps across the gap each side, so the clip's words read as one band; opaque, so
                    // the overlaps don't show.
                    .background {
                      if model.inSpan(word) {
                        Color(.systemBackground).overlay(Color.accentColor.opacity(0.28)).padding(.horizontal, -4).padding(.vertical, -2.5)
                      }
                    }
                    .contentShape(.rect)
                    .onTapGesture { model.tap(word) }
                    // Press and hold to say which end, when the nearer one isn't it.
                    .contextMenu {
                      Button("Start here", systemImage: "arrow.right.to.line") { model.set(.in, at: word) }
                      Button("End here", systemImage: "arrow.left.to.line") { model.set(.out, at: word) }
                    }
                  if segment.w0 + i == ends?.last { SpanHandle(atTop: false) }
                }
              }
              .id(segment.w0)
            }
            if model.moreLater {
              Button("Show later") { model.showLater() }.font(.body.weight(.semibold)).frame(maxWidth: .infinity)
            }
          }
          .padding(.horizontal, 24)
          .padding(.vertical, 16)
        }
        .onAppear {
          // Open with the clip's first paragraph just below the top, so its start shows with a little context above.
          let segments = model.segmentsInWindow
          if let first = segments.firstIndex(where: { $0.e >= model.span.startMs }) {
            proxy.scrollTo(segments[first].w0, anchor: UnitPoint(x: 0, y: 0.12))
          }
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 14) {
        if let error = model.saveError { Text(error).font(.body).foregroundStyle(.red) }
        Button { model.togglePreview(pausing: engine) } label: {
          Label(model.previewing ? "Stop" : "Play this clip", systemImage: model.previewing ? "stop.fill" : "play.fill")
            .font(.title3.weight(.semibold))
            .padding(.horizontal, 24)
            .frame(minHeight: 52)
            .background(Color.accentColor.opacity(0.28), in: .capsule)
        }
        .buttonStyle(.plain)
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 24)
      .padding(.top, 14)
      .padding(.bottom, 6)
      .background(Color(.systemBackground).ignoresSafeArea())
    }
  }

  /// The global indices of the first and last words in the span, where its handles go.
  private var spanEnds: (first: Int, last: Int)? {
    var first: Int?
    var last: Int?
    for segment in model.segmentsInWindow where segment.e >= model.span.startMs && segment.s <= model.span.endMs {
      for (i, word) in segment.words.enumerated() where model.inSpan(word) {
        if first == nil { first = segment.w0 + i }
        last = segment.w0 + i
      }
    }
    guard let first, let last else { return nil }
    return (first, last)
  }

  private var lengthLine: String {
    let now = Format.duration(model.span.endMs - model.span.startMs)
    guard model.boundariesChanged, let rev = model.revision else { return now }
    return "\(now) · was \(Format.duration(rev.endMs - rev.startMs))"
  }

  // MARK: Editing

  private func beginTitle() {
    guard model.revision != nil, mode == .reading else { return }
    model.editing = true
    mode = .title
  }

  private func beginAdjusting() {
    model.stopPreview()
    model.editing = true
    mode = .adjusting
  }

  private func cancelEditing() {
    model.stopPreview()
    model.revert()
    titleFocused = false
    mode = .reading
  }

  private func commit(regenerate: Bool? = nil) async {
    if mode == .adjusting, regenerate == nil, model.savingAsks {
      askingToRewrite = true
      return
    }
    if await model.save(regenerate: regenerate ?? false) {
      titleFocused = false
      mode = .reading
    }
  }

  // MARK: Labels

  private var progress: Double {
    guard let ms = model.previewMs else { return 0 }
    let length = Double(max(model.span.endMs - model.span.startMs, 1))
    return min(max(Double(ms - model.span.startMs) / length, 0), 1)
  }

  private var shareURL: URL? { model.snip.flatMap { URL(string: $0.shareUrl) } }

  /// Where the clip sits in the episode and how long it is (or where the tap was, until the moment is chosen).
  private var at: String {
    guard let snip = model.snip else { return "" }
    guard let rev = snip.revision, rev.status != .waiting, rev.status != .selecting else {
      return "Snipped at \(Format.clock(snip.anchorMs))"
    }
    return "\(Format.clock(rev.startMs)) – \(Format.clock(rev.endMs)) · \(Format.duration(rev.endMs - rev.startMs))"
  }

  private var status: (text: String, icon: String, failed: Bool)? {
    switch model.revision?.status {
    case .ready: nil
    case .failed: ("Snip failed", "exclamationmark.triangle", true)
    case .waiting: ("Waiting for the transcript", "clock", false)
    case .selecting, nil: ("Choosing the moment…", "clock", false)
    default: ("Preparing the clip…", "clock", false)
    }
  }
}

/// A snip's summary at reading size: since snip-summary v3 its lines are bullets, each with its own dot and a hanging
/// indent; an older one-paragraph summary reads as a paragraph.
private struct SummaryText: View {
  let summary: String
  @ScaledMetric(relativeTo: .title2) private var dot: CGFloat = 7

  var body: some View {
    let lines = summary.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    if lines.count < 2 {
      Text(summary).font(.title2)
    } else {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Circle().fill(Color.accentColor).frame(width: dot, height: dot).alignmentGuide(.firstTextBaseline) { $0[.bottom] + dot * 0.5 }
            Text(line).font(.title2).frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .accessibilityElement(children: .combine)
    }
  }
}

/// The clip's words split by voice, when there is more than one: each turn under its speaker's name (or Host, Guest,
/// Speaker 2; none for an article's own prose), the names alternating colour so a change of voice reads at a glance.
private struct TurnsText: View {
  let turns: [SnipPageModel.Turn]

  var body: some View {
    let order = turns.map(\.name).reduce(into: [String?]()) { if !$0.contains($1) { $0.append($1) } }
    VStack(alignment: .leading, spacing: 16) {
      ForEach(turns) { turn in
        let n = order.firstIndex(of: turn.name) ?? 0
        VStack(alignment: .leading, spacing: 4) {
          if let name = turn.name {
            Text(name)
              .font(.subheadline.weight(.bold))
              .textCase(.uppercase)
              .foregroundStyle(n.isMultiple(of: 2) ? Color.secondary : Color.accentColor)
          }
          Text(turn.text).font(.title2).foregroundStyle(.secondary)
        }
      }
    }
  }
}

/// An end of the span among the words: an accent bar with a knob above (the start) or below (the end).
private struct SpanHandle: View {
  let atTop: Bool
  @ScaledMetric(relativeTo: .title) private var height: CGFloat = 32

  var body: some View {
    Capsule()
      .fill(Color.accentColor)
      .frame(width: 4, height: height)
      .overlay(alignment: atTop ? .top : .bottom) {
        Circle().fill(Color.accentColor).frame(width: 16, height: 16).offset(y: atTop ? -10 : 10)
      }
      .accessibilityHidden(true)
  }
}

/// The snip turned sideways: only the clip's words, as large as they fit (KaraokeHalves), lighting up as the clip
/// plays. A tap plays or pauses.
struct SnipSideways: View {
  let words: [Word]
  let positionMs: Int?
  let progress: Double
  let toggle: () -> Void

  var body: some View {
    KaraokeHalves(pieces: KaraokePieces.split(words), positionMs: positionMs)
      .padding(.horizontal, 24)
      .padding(.vertical, 12)
      .background(Color.black.ignoresSafeArea())
      .overlay(alignment: .bottomTrailing) {
        if positionMs == nil {
          Image(systemName: "play.fill")
            .font(.system(size: 26, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 64, height: 64)
            .background(.white.opacity(0.16), in: .circle)
            .padding(.trailing, 8)
            .padding(.bottom, 8)
        }
      }
      .overlay(alignment: .bottom) {
        if positionMs != nil { KaraokeProgress(progress: progress).padding(.horizontal, 24) }
      }
      .contentShape(.rect)
      .onTapGesture(perform: toggle)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(words.map(\.text).joined(separator: " "))
      .accessibilityAddTraits(.isButton)
      .accessibilityHint(positionMs == nil ? "Plays the snip" : "Pauses the snip")
  }
}

/// Lays children out left to right, wrapping to a new line when the row is full, like words in a paragraph.
struct FlowLayout: Layout {
  var spacing: CGFloat = 4
  var lineSpacing: CGFloat = 4

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
    let height = rows.last.map { $0.y + $0.height } ?? 0
    let width = rows.map(\.width).max() ?? 0
    return CGSize(width: proposal.width ?? width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for row in arrange(width: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for index in row.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
    }
  }

  private struct Row {
    var indices: [Int] = []
    var y: CGFloat = 0
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
    var rows: [Row] = [Row()]
    for (index, subview) in subviews.enumerated() {
      let size = subview.sizeThatFits(.unspecified)
      if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
        let last = rows[rows.count - 1]
        rows.append(Row(y: last.y + last.height + lineSpacing))
      }
      var row = rows[rows.count - 1]
      row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
      row.height = max(row.height, size.height)
      row.indices.append(index)
      rows[rows.count - 1] = row
    }
    return rows
  }
}
