import PodcastAPI
import SwiftUI
import UniformTypeIdentifiers

/// What happens to a shared link: a YouTube channel is followed; anything else becomes an episode, with the default
/// processing (a YouTube video of its channel's show, fetched at home; a media file a one-off of Pasted links,
/// downloaded by the server; both transcribed). The server tells page links apart and says so.
struct ShareView: View {
  enum Phase: Equatable {
    case reading
    case sending(String)
    case done(title: String, detail: String)
    case failed(String)
  }

  let items: [NSExtensionItem]
  let finish: () -> Void
  @State private var phase: Phase = .reading

  init(items: [NSExtensionItem], finish: @escaping () -> Void) {
    self.items = items
    self.finish = finish
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 14) {
        switch phase {
        case .reading:
          Label("Reading the link…", systemImage: "link").foregroundStyle(.secondary)
        case .sending(let url):
          HStack(spacing: 12) {
            ProgressView()
            Text("Adding to Snip…").font(.headline)
          }
          Text(url).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
        case .done(let title, let detail):
          Label(title, systemImage: "checkmark.circle.fill").font(.headline).foregroundStyle(.primary)
          Text(detail).font(.footnote).foregroundStyle(.secondary)
        case .failed(let message):
          Label("Couldn’t add this", systemImage: "exclamationmark.triangle.fill").font(.headline)
          Text(message).font(.footnote).foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .padding(20)
      .navigationTitle("Snip")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(isWorking ? "Cancel" : "Done") { finish() }
        }
      }
      .task { await run() }
    }
  }

  private var isWorking: Bool {
    switch phase {
    case .reading, .sending: true
    case .done, .failed: false
    }
  }

  private func run() async {
    guard let url = await SharedLink.url(in: items) else {
      phase = .failed("Share a link: a YouTube video or channel, or a video file’s address.")
      return
    }
    guard let session = SharedSession.current() else {
      phase = .failed("Open Snip and sign in first; the share sheet uses the app’s login.")
      return
    }
    phase = .sending(url)
    let api = APIClient(baseURL: session.server, token: { session.token })
    do {
      if case .channel(let channelURL) = YouTubeLink.parse(url) {
        let feed = try await follow(channelURL, api: api)
        let name = feed.title ?? URL(string: channelURL)?.lastPathComponent ?? "the channel"
        phase = .done(title: "Following \(name)", detail: "Its latest videos become episodes, in your Library and Today.")
      } else {
        let episode = try await api.addPastedLink(url)
        let show = episode.showTitle ?? "Pasted links"
        let detail =
          episode.youtubeId != nil
          ? "Added to \(show). The video is fetched at home, then transcribed."
          : "Added to \(show). The server is downloading it and will transcribe it."
        phase = .done(title: episode.title, detail: detail)
      }
    } catch {
      phase = .failed(error.localizedDescription)
      return
    }
    // Long enough to read; the Done button closes it sooner.
    try? await Task.sleep(for: .seconds(2.5))
    if !Task.isCancelled { finish() }
  }

  /// Follow the channel: created followed and manual (its videos are fetched when asked for), or, when the library
  /// already has it, followed from now on.
  private func follow(_ channelURL: String, api: APIClient) async throws -> Feed {
    do {
      return try await api.createFeed(CreateFeed(url: channelURL, autoProcess: false, backfill: 0, followed: true))
    } catch let e as APIError where e.status == 409 {
      guard let id = e.feedId else { throw e }
      return try await api.updateFeed(id, UpdateFeed(followed: true))
    }
  }
}

/// The one link in what was shared: a URL item, else the first http(s) address in a text item.
enum SharedLink {
  static func url(in items: [NSExtensionItem]) async -> String? {
    for item in items {
      for provider in item.attachments ?? [] {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
          let text = await load(provider, UTType.url.identifier), let url = firstHTTPURL(in: text)
        {
          return url
        }
      }
      for provider in item.attachments ?? [] {
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
          let text = await load(provider, UTType.plainText.identifier), let url = firstHTTPURL(in: text)
        {
          return url
        }
      }
    }
    return nil
  }

  /// The item as text: a URL's address, a string as it is, or bytes decoded as UTF-8.
  private static func load(_ provider: NSItemProvider, _ type: String) async -> String? {
    await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: type) { @Sendable item, _ in
        let text: String? =
          (item as? URL)?.absoluteString
          ?? (item as? NSURL)?.absoluteString
          ?? (item as? String)
          ?? (item as? Data).flatMap { String(data: $0, encoding: .utf8) }
        continuation.resume(returning: text)
      }
    }
  }

  static func firstHTTPURL(in text: String) -> String? {
    guard let match = text.firstMatch(of: #/https?://[^\s<>"']+/#) else { return nil }
    return String(match.0).trimmingCharacters(in: CharacterSet(charactersIn: ".,;)"))
  }
}
