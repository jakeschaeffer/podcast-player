import PlayerKit
import PodcastAPI
import SwiftUI

/// The full player: title, scrubber, skip 15/30, speed, Snip, and below them the transcript following along, the
/// chapter list, or Up next. The stack button beside the title lists the episode's snips. The artwork sits small beside
/// the title so the transcript has room. After a snip tap a slim bar at the bottom follows it (SnipPill); it never
/// blocks listening, and a tap on it pushes the snip's page (swipe from the left edge to come back).
///
/// Turned sideways, a video fills the screen with the same controls laid over it (VideoSideways). An audio episode
/// does what the setting says (SidewaysPlayer): read along in the karaoke view (EpisodeKaraoke), or keep the player in
/// two columns like the web app's wide layout: the controls on the left with the artwork as large as the spare height
/// allows, the transcript, chapters or Up next filling the right, and the snip bar docked at the foot of that reading
/// column so the controls never move.
struct PlayerView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @AppStorage("player.panel") private var panel = Panel.transcript
  @AppStorage(SidewaysPlayer.key) private var sidewaysMode = SidewaysPlayer.karaoke
  @State private var showingSnips = false
  @State private var openSnip: SnipRoute?
  /// The show whose name was tapped: its page is pushed over the player, which keeps playing.
  @State private var openShow: Feed?

  enum Panel: String { case transcript, chapters, upNext }

  /// The app icon's dark, for marks on the accent colour.
  private static let ink = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)

  private var sideways: Bool { verticalSizeClass == .compact }
  /// A video playing through its picture fills the screen sideways, whatever the setting says.
  private var watchingSideways: Bool { sideways && engine.video }
  /// Reading along needs words: an audio episode without a transcript keeps the two-column player sideways.
  private var readingAlong: Bool { sideways && !engine.video && sidewaysMode == .karaoke && engine.episode?.transcriptId != nil }
  private var fullScreenSideways: Bool { readingAlong || watchingSideways }

  var body: some View {
    NavigationStack {
      content
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(item: $openSnip) { route in
          SnipPage(snipID: route.id, api: model.api, renaming: route.renaming, onDelete: { Task { await engine.refreshEpisode() } })
        }
        .navigationDestination(item: $openShow) { feed in
          // An episode picked there opens in this player, so "show the player" means come back to it.
          FeedEpisodesView(feed: feed, showPlayer: Binding(get: { true }, set: { if $0 { openShow = nil } }))
        }
    }
    .task(id: model.renameRequest) { openRename() }
    .presentationDragIndicator(fullScreenSideways && engine.status == .ready ? .hidden : .visible)
  }

  @ViewBuilder private var content: some View {
    Group {
      if engine.status == .ready, let ep = engine.episode {
        if watchingSideways {
          VideoSideways { pill }
        } else if readingAlong {
          EpisodeKaraoke(episode: ep) { pill }
        } else if sideways {
          wide(ep)
        } else {
          upright(ep)
        }
      } else if engine.status == .details, let ep = engine.episode {
        VideoDetailsView(episode: ep)
      } else {
        VStack {
          switch engine.status {
          case .loading: ProgressView()
          case .preparing:
            ProgressView(engine.episode?.mediaKind == "video" ? "Fetching the video…" : "Fetching the recording…")
            if let ep = engine.episode {
              Text(ep.title).font(.headline).multilineTextAlignment(.center).padding(.top, 12)
              Text(ep.showTitle ?? "").font(.subheadline).foregroundStyle(.secondary)
              if ep.mediaKind == "video" {
                Text("The home fetcher brings it; a long video takes a few minutes.")
                  .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.top, 4)
              }
            }
          case .error(let message):
            ContentUnavailableView("Can't play this episode", systemImage: "exclamationmark.triangle", description: Text(message))
          default: ContentUnavailableView("Nothing playing", systemImage: "headphones")
          }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .animation(.snappy, value: model.snipCard == nil)
    .task(id: engine.episode?.video.status == "requested" ? engine.episode?.id : nil) {
      guard engine.episode?.video.status == "requested" else { return }
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        guard !Task.isCancelled else { return }
        let before = engine.episode?.asset?.id
        await engine.refreshEpisode()
        guard let ep = engine.episode else { return }
        if ep.video.isReady, ep.asset?.id != before {
          await engine.reload()
          return
        }
        if ep.video.status != "requested" { return }
      }
    }
    .sheet(isPresented: $showingSnips, onDismiss: { Task { await engine.refreshEpisode() } }) {
      if let ep = engine.episode { EpisodeSnipsView(episode: ep) }
    }
    // A snip the server finished counts towards the episode's total; re-read it so the badge keeps up.
    .onChange(of: model.snipCard?.snip?.revision?.status == .ready) { _, ready in
      if ready { Task { await engine.refreshEpisode() } }
    }
  }

  /// The Live Activity asked to rename a snip (AppModel.open): the snip bar renames it when it is showing that snip,
  /// as it does on a tap on its title; otherwise the snip's page opens with its title being edited.
  private func openRename() {
    guard let id = model.renameRequest else { return }
    model.renameRequest = nil
    if let card = model.snipCard, card.snip?.id == id {
      openSnip = nil
      card.renameRequested = true
    } else {
      openSnip = SnipRoute(id: id, renaming: true)
    }
  }

  // MARK: Layouts

  private func upright(_ ep: EpisodeDetail) -> some View {
    VStack(spacing: 20) {
      if engine.video {
        VideoSurface().frame(maxWidth: .infinity).padding(.top, 8)
      }
      titles(ep, artSize: 72, font: .headline, lines: 3, hideArt: engine.video)
        .padding(.top, engine.video ? 0 : 16)
      Scrubber()
      TransportRow()
      loadError
      panelPicker(ep)
      panelContent(ep)
    }
    .padding()
    // Every row is held to the sheet's width, so a long title wraps instead of widening the player.
    .frame(maxWidth: .infinity)
    .overlay(alignment: .bottom) { pill.padding(.horizontal, 16).padding(.bottom, 8) }
  }

  /// Sideways, after the web app's wide layout: two equal columns, controls and reading.
  private func wide(_ ep: EpisodeDetail) -> some View {
    HStack(alignment: .top, spacing: 28) {
      VStack(spacing: 10) {
        // The title block takes whatever height the controls leave, and the artwork grows to fill it.
        GeometryReader { geo in
          titles(ep, artSize: max(48, min(geo.size.height - 8, geo.size.width * 0.32, 200)), font: .title3.weight(.semibold), lines: 4, snipsBelow: true)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minHeight: 56)
        Scrubber()
        TransportRow()
        loadError
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      VStack(spacing: 8) {
        panelPicker(ep)
        panelContent(ep)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .overlay(alignment: .bottom) { pill.padding(.bottom, 8) }
    }
    .padding(.horizontal, 18)
    .padding(.top, 14)
  }

  // MARK: Pieces

  /// The artwork, the episode and show titles, and the snips button: beside the titles upright, under them sideways,
  /// where the column is narrow and the title needs the width.
  private func titles(_ ep: EpisodeDetail, artSize: CGFloat, font: Font, lines: Int, snipsBelow: Bool = false, hideArt: Bool = false) -> some View {
    HStack(spacing: 14) {
      if hideArt {
        EmptyView()
      } else if engine.video {
        VideoSurface().frame(height: artSize)
      } else {
        Artwork(url: model.artwork(episodeImage: ep.imageUrl, feedID: ep.feedId), size: artSize)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(ep.title).font(font).lineLimit(lines).fixedSize(horizontal: false, vertical: true)
        showLink(ep)
        if ep.video.canRequest || ep.asset?.videoUrl != nil { videoActions(ep).padding(.top, 4) }
        if snipsBelow { HStack(spacing: 4) { snipsButton(ep); DownloadButton(episode: ep) }.padding(.leading, -10) }
      }
      Spacer(minLength: 0)
      if !snipsBelow {
        VStack(spacing: 2) {
          snipsButton(ep)
          DownloadButton(episode: ep)
        }
      }
    }
  }

  /// The show's name: a tap opens the show's page, to look through its other episodes while this one plays.
  private func showLink(_ ep: EpisodeDetail) -> some View {
    Button {
      Task { if let feed = try? await model.api.feed(ep.feedId) { openShow = feed } }
    } label: {
      HStack(spacing: 2) {
        Text(ep.showTitle ?? "").lineLimit(1)
        Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
      }
      .font(.subheadline).foregroundStyle(.secondary)
    }
    .buttonStyle(.plain)
    .disabled(ep.showTitle == nil)
    .accessibilityHint("Opens the show")
  }

  private func snipsButton(_ ep: EpisodeDetail) -> some View {
    Button { showingSnips = true } label: {
      Image(systemName: "rectangle.stack")
        .font(.title3)
        .frame(width: 44, height: 44)
        .overlay(alignment: .topTrailing) {
          if ep.snipCount > 0 {
            Text(ep.snipCount > 99 ? "99+" : "\(ep.snipCount)")
              .font(.caption2.weight(.bold).monospacedDigit())
              .foregroundStyle(Self.ink)
              .padding(.horizontal, 5)
              .frame(minWidth: 18, minHeight: 18)
              .background(Color.accentColor, in: .capsule)
          }
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Snips from this episode, \(ep.snipCount)")
  }

  @ViewBuilder private var loadError: some View {
    if let problem = engine.loadError {
      Text(problem).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
    }
    if let video = engine.episode?.video, video.status == "requested" {
      Text("The video is on its way…").font(.footnote).foregroundStyle(.secondary)
    } else if let video = engine.episode?.video, video.status == "failed" {
      Text("The video could not be fetched: \(video.error ?? "unknown error")").font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
    }
  }

  /// Watch video (asks for a video the episode can have), and Video / Sound only for a recording that has one.
  private func videoActions(_ ep: EpisodeDetail) -> some View {
    HStack(spacing: 8) {
      if ep.video.canRequest {
        Button(ep.video.status == "failed" ? "Try the video again" : "Watch video", systemImage: "play.rectangle") {
          Task {
            _ = try? await model.api.requestVideo(ep.id)
            await engine.refreshEpisode()
          }
        }
      }
      if ep.asset?.videoUrl != nil {
        Button(engine.video ? "Sound only" : "Video", systemImage: engine.video ? "speaker.wave.2" : "play.rectangle") {
          engine.setWantsVideo(!engine.video)
        }
      }
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.capsule)
    .controlSize(.small)
  }

  private func panelPicker(_ ep: EpisodeDetail) -> some View {
    HStack(spacing: 8) {
      Picker("Panel", selection: $panel) {
        Text("Transcript").tag(Panel.transcript)
        if (ep.chapters?.items.count ?? 0) > 1 { Text("Chapters").tag(Panel.chapters) }
        Text("Up Next").tag(Panel.upNext)
      }
      .pickerStyle(.segmented)
      // Here rather than over the words, which scroll under anything laid on them; on every panel so the tabs keep still.
      if ep.transcriptId != nil { TranscriptSettingsButton() }
    }
  }

  @ViewBuilder private func panelContent(_ ep: EpisodeDetail) -> some View {
    let chapters = ep.chapters?.items ?? []
    if panel == .upNext {
      UpNextList { episode, playing in engine.open(episode.id, autoplay: playing) }
    } else if panel == .chapters && chapters.count > 1 {
      let current = chapters.last { $0.startMs <= engine.positionMs }?.startMs
      List(chapters, id: \.startMs) { chapter in
        Button {
          engine.seek(to: chapter.startMs)
        } label: {
          HStack {
            Text(chapter.title).lineLimit(2)
            Spacer()
            Text(Format.clock(chapter.startMs)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          }
          // In the row's margin, so the current chapter's title stays in line with the others.
          .overlay(alignment: .leading) {
            if chapter.startMs == current {
              Capsule().fill(Color.accentColor).frame(width: 3, height: 28).offset(x: -10).accessibilityLabel("Now playing")
            }
          }
        }
      }
      .listStyle(.plain)
    } else {
      TranscriptView(episode: ep, covered: model.snipCard != nil)
    }
  }

  /// The snip bar, while a snip tap is being followed.
  @ViewBuilder private var pill: some View {
    if let card = model.snipCard {
      SnipPill(card: card, onOpen: { openSnip = SnipRoute(id: $0) }, onCancel: { model.cancelSnip(card) }) {
        model.closeSnip(card)
      }
      .transition(.move(edge: .bottom).combined(with: .opacity))
    }
  }

}

/// The bar above the tab bar while something is loaded. Tap opens the full player.
struct MiniPlayer: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @Binding var showPlayer: Bool

  var body: some View {
    HStack(spacing: 12) {
      if let ep = engine.episode {
        Artwork(url: model.artwork(episodeImage: ep.imageUrl, feedID: ep.feedId), size: 32)
        Text(ep.title).font(.subheadline).lineLimit(1)
        Spacer()
        if AdOffer.of(engine) != nil { SkipAdButton(compact: true) }
        if engine.status != .details {
          Button { engine.toggle() } label: { Image(systemName: engine.playing ? "pause.fill" : "play.fill") }
            .buttonStyle(.plain)
        }
      } else {
        Text(engine.status == .loading ? "Loading…" : "Nothing playing").font(.subheadline).foregroundStyle(.secondary)
        Spacer()
      }
    }
    .padding(.horizontal)
    .contentShape(.rect)
    .onTapGesture { showPlayer = true }
    // The mini player is always there while signed in, so it puts the cover on the lock screen.
    .task(id: engine.episode.map { model.artwork(episodeImage: $0.imageUrl, feedID: $0.feedId) ?? "" }) {
      guard let ep = engine.episode, let url = ArtworkCache.secure(model.artwork(episodeImage: ep.imageUrl, feedID: ep.feedId)),
        let image = await ArtworkCache.shared.image(url, pixels: 1024), engine.episode?.id == ep.id
      else { return }
      engine.nowPlayingArtwork = ArtworkCache.lockScreenArtwork(image)
    }
  }
}

/// What the player offers about ads right now: Skip ad while a suspected break plays, and Undo skip for a few
/// seconds after one was skipped on its own (the account menu's "Auto-skip ads").
enum AdOffer: Equatable {
  case skip, undo

  static func of(_ engine: PlayerEngine) -> AdOffer? {
    if engine.currentAdBreak != nil { return .skip }
    return engine.skippedAd != nil ? .undo : nil
  }

  var title: String { self == .skip ? "Skip ad" : "Undo skip" }

  func act(on engine: PlayerEngine) {
    switch self {
    case .skip: engine.skipAd()
    case .undo: engine.undoAdSkip()
    }
  }
}

/// "Skip ad", shown only while a suspected ad break plays, like a streaming app's "Skip intro"; pressing it seeks past
/// the break. With ads skipped automatically it says "Undo skip" for a few seconds after each skip instead, which goes
/// back to the break's start. It fades in and out and takes its space even while hidden, so place it where hiding it
/// moves nothing (an overlay), or show it conditionally.
struct SkipAdButton: View {
  @Environment(PlayerEngine.self) private var engine
  var compact = false
  /// The last thing offered, so the button keeps its words while it fades out.
  @State private var last = AdOffer.skip

  var body: some View {
    let offer = AdOffer.of(engine)
    let shown = offer != nil
    let showing = offer ?? last
    Button { offer?.act(on: engine) } label: {
      HStack(spacing: 2) {
        if showing == .undo { Image(systemName: "arrow.uturn.backward").imageScale(.small) }
        Text(showing.title)
        if showing == .skip { Image(systemName: "chevron.forward").imageScale(.small) }
      }
      .font((compact ? Font.footnote : .callout).weight(.bold))
      .foregroundStyle(Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255))  // the icon's dark
      // The side with the small arrow gets less room, so the words look centred.
      .padding(.leading, showing == .skip ? (compact ? 10 : 14) : (compact ? 8 : 10))
      .padding(.trailing, showing == .skip ? (compact ? 8 : 10) : (compact ? 10 : 14))
      .frame(height: compact ? 30 : 38)
      .background(Color(red: 0xF3 / 255, green: 0xF1 / 255, blue: 0xEC / 255), in: .capsule)
      .shadow(color: .black.opacity(compact ? 0 : 0.35), radius: 10, y: 6)
    }
    .buttonStyle(.plain)
    .opacity(shown ? 1 : 0)
    .offset(y: shown || compact ? 0 : 6)
    .allowsHitTesting(shown)
    .accessibilityHidden(!shown)
    .animation(.easeInOut(duration: 0.25), value: offer)
    .onChange(of: offer) { _, now in if let now { last = now } }
    // Laid over a video or beside the mini player's title: it keeps a button's size at every text size.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }
}

/// A channel's video that has not been fetched: what is known about it, at once, and Fetch, the one thing here that
/// starts the download. PlayerView's poll moves on to the player when the video arrives.
struct VideoDetailsView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  let episode: EpisodeDetail
  @State private var problem: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Artwork(url: model.artwork(episodeImage: episode.imageUrl, feedID: episode.feedId), size: 96)
        Text(episode.title).font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
        Text(meta).font(.subheadline).foregroundStyle(.secondary)
        fetch
        if let notes = Self.plainText(episode.descriptionHtml), !notes.isEmpty {
          Text(notes).font(.body).textSelection(.enabled)
        } else {
          Text("No description yet.").foregroundStyle(.secondary)
        }
        if let chapters = episode.chapters?.items, !chapters.isEmpty {
          Text("Chapters").font(.headline).padding(.top, 4)
          ForEach(chapters, id: \.startMs) { chapter in
            Text(chapter.title).font(.subheadline)
          }
        }
      }
      .padding()
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder private var fetch: some View {
    if episode.video.status == "requested" {
      HStack(spacing: 10) {
        ProgressView()
        Text("Fetching the video… The home fetcher brings it; a long one takes a few minutes.")
          .font(.footnote).foregroundStyle(.secondary)
      }
    } else {
      if episode.video.status == "failed" {
        Text("The video could not be fetched: \(episode.video.error ?? "unknown error")").font(.footnote).foregroundStyle(.red)
      }
      if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
      Button(episode.video.status == "failed" ? "Try again" : "Fetch", systemImage: "arrow.down.circle") {
        Task {
          do {
            problem = nil
            try await engine.fetchVideo()
          } catch {
            problem = error.localizedDescription
          }
        }
      }
      .buttonStyle(.borderedProminent)
    }
  }

  private var meta: String {
    var parts: [String] = []
    if let show = episode.showTitle { parts.append(show) }
    if let at = episode.publishedAt { parts.append(Date(timeIntervalSince1970: Double(at) / 1000).formatted(date: .abbreviated, time: .omitted)) }
    if let ms = episode.durationMs, ms > 0 {
      let minutes = (ms + 30_000) / 60_000
      parts.append(minutes < 60 ? "\(max(1, minutes)) min" : "\(minutes / 60) h \(minutes % 60) min")
    }
    return parts.joined(separator: " · ")
  }

  /// The server's sanitized show notes as plain text: line breaks kept, tags gone, the usual entities decoded.
  static func plainText(_ html: String?) -> String? {
    guard var text = html else { return nil }
    for tag in ["<br>", "<br/>", "<br />", "</p>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>"] {
      text = text.replacingOccurrences(of: tag, with: tag.hasPrefix("<br") ? "\n" : "\n\n")
    }
    text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    for (entity, character) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&#x27;", "'"), ("&nbsp;", " "), ("&amp;", "&")] {
      text = text.replacingOccurrences(of: entity, with: character)
    }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
