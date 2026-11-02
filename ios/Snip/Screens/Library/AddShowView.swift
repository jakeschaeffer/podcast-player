import PlayerKit
import PodcastAPI
import SwiftUI

/// Find a show and open it. Typing searches the public directory (Apple Podcasts, or Podcast Index when the server has
/// its keys); pasting a feed address opens that address directly, which is how private feeds are added. A YouTube
/// channel link (or a bare @handle) opens the channel as a show; a YouTube video link makes the video an episode and
/// opens it in the player; a link to a video or audio file (`MediaLink`) becomes a one-off episode of the Pasted links
/// show, which the server downloads and transcribes, and opens in the player too. Opening a show the server doesn't
/// have creates it unfollowed: its episodes play (and can be transcribed and snipped), but it stays out of Library and
/// Today until followed from its page. An unfollowed show is always manual, so browsing never bills; a one-off bills
/// its transcription when added.
struct AddShowView: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  @Binding var showPlayer: Bool
  @State private var query: String
  @State private var results: ShowSearch?
  @State private var searching = false
  @State private var error: String?
  /// The feed URL being opened, while its feed is created or fetched.
  @State private var opening: String?
  /// The show to push.
  @State private var opened: Feed?
  @FocusState private var focused: Bool

  init(showPlayer: Binding<Bool>, query: String = "") {
    _showPlayer = showPlayer
    _query = State(initialValue: query)
  }

  private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var youtube: YouTubeLink? { YouTubeLink.parse(query) }
  private var mediaURL: String? { youtube == nil ? MediaLink.parse(query) : nil }
  private var feedURL: String? { youtube == nil && mediaURL == nil ? FeedAddress.parse(query) : nil }
  private var searchable: Bool { youtube == nil && mediaURL == nil && feedURL == nil && trimmed.count >= 2 }

  var body: some View {
    List {
      if let error {
        Text(error).foregroundStyle(.secondary)
      }
      if case .video(_, let url) = youtube {
        Section("YouTube video") {
          Text(url).font(.callout)
          Text("The video becomes an episode of its channel's show and is fetched at home; it opens in the player while that happens. The channel is not followed unless you follow it.")
            .font(.caption).foregroundStyle(.secondary)
          Button {
            openVideo(url)
          } label: {
            HStack {
              Text("Open this video")
              if opening == url { Spacer(); ProgressView() }
            }
          }
          .disabled(opening != nil)
        }
      } else if case .channel(let url) = youtube {
        Section("YouTube channel") {
          Text(url).font(.callout)
          Text("The channel's latest videos become episodes. Follow it from its page to keep up with new ones.")
            .font(.caption).foregroundStyle(.secondary)
          Button {
            open(feedURL: url, feedID: nil)
          } label: {
            HStack {
              Text("Open this channel")
              if opening == url { Spacer(); ProgressView() }
            }
          }
          .disabled(opening != nil)
        }
      } else if let mediaURL {
        Section("Video link") {
          Text(mediaURL).font(.callout)
          Text("The file becomes a one-off episode of Pasted links: the server downloads it and transcribes it, and it opens in the player meanwhile. A link to a web page (an X post, say) won't do; paste the video file's own address.")
            .font(.caption).foregroundStyle(.secondary)
          Button {
            addLink(mediaURL)
          } label: {
            HStack {
              Text("Add this video")
              if opening == mediaURL { Spacer(); ProgressView() }
            }
          }
          .disabled(opening != nil)
        }
      } else if let feedURL {
        Section("Feed address") {
          Text(feedURL).font(.callout)
          Text("Private feeds carry their access key in the address. It is stored encrypted and never shown again.")
            .font(.caption).foregroundStyle(.secondary)
          Button {
            open(feedURL: feedURL, feedID: nil)
          } label: {
            HStack {
              Text("Open this feed")
              if opening == feedURL { Spacer(); ProgressView() }
            }
          }
          .disabled(opening != nil)
          // A media link without a file extension looks like a feed address; this is its way in.
          Button {
            addLink(feedURL)
          } label: {
            HStack {
              Text("Not a feed? Add it as a one-off video").foregroundStyle(Color.secondary)
              if opening == "link:\(feedURL)" { Spacer(); ProgressView() }
            }
          }
          .disabled(opening != nil)
        }
      } else if !searchable {
        Text("Find a show by name, or paste the address of its RSS feed, a YouTube channel or video, or a video file.").foregroundStyle(.secondary)
      } else if let results {
        if results.results.isEmpty {
          Text("No shows match “\(trimmed)”.").foregroundStyle(.secondary)
        }
        Section {
          ForEach(results.results) { result in
            Button {
              open(feedURL: result.feedUrl, feedID: result.feedId)
            } label: {
              ShowResultRow(result: result, opening: opening == result.feedUrl)
            }
            .buttonStyle(.plain)
            .disabled(opening != nil)
          }
        } footer: {
          if !results.results.isEmpty {
            Text("Results from \(results.source == "podcastindex" ? "Podcast Index" : "Apple Podcasts")")
          }
        }
      } else if searching {
        Text("Searching…").foregroundStyle(.secondary)
      }
    }
    .searchable(
      text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search shows, or paste a feed, YouTube or video link"
    )
    .searchFocused($focused)
    .textInputAutocapitalization(.never)
    .autocorrectionDisabled()
    .navigationTitle("Find a show")
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(item: $opened) { feed in
      FeedEpisodesView(feed: feed, showPlayer: $showPlayer)
    }
    .onAppear { if query.isEmpty { focused = true } }
    // Debounced: each keystroke cancels the previous wait.
    .task(id: query) {
      try? await Task.sleep(for: .milliseconds(400))
      guard !Task.isCancelled else { return }
      await search()
    }
    // Back from a show: its Follow state may have changed.
    .onChange(of: opened) { _, now in if now == nil { Task { await search() } } }
  }

  private func search() async {
    guard searchable else {
      results = nil
      error = nil
      return
    }
    let q = trimmed
    searching = true
    defer { searching = false }
    do {
      let page = try await model.api.searchShows(q, limit: 20)
      guard q == trimmed else { return }  // the text changed while this was in flight
      results = page
      error = nil
    } catch {
      guard !Task.isCancelled, q == trimmed else { return }
      results = nil
      self.error = error.localizedDescription
    }
  }

  /// A pasted video becomes an episode on the server, which asks for its video; the player opens on it meanwhile.
  private func openVideo(_ url: String) {
    opening = url
    Task {
      defer { opening = nil }
      do {
        let episode = try await model.api.addYouTubeVideo(url)
        error = nil
        engine.open(episode.id)
        showPlayer = true
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  /// A pasted file link becomes a one-off episode on the server, which downloads and transcribes it; the player opens
  /// on it meanwhile. The server says why when the link is a page rather than a file.
  private func addLink(_ url: String) {
    opening = url == feedURL ? "link:\(url)" : url
    Task {
      defer { opening = nil }
      do {
        let episode = try await model.api.addPastedLink(url)
        error = nil
        engine.open(episode.id)
        showPlayer = true
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  /// A show the server has opens as it is; any other is created unfollowed (manual, no backfill) and opened. A 409
  /// means it was added since the search ran, and names the feed.
  private func open(feedURL: String, feedID: ULID?) {
    opening = feedURL
    Task {
      defer { opening = nil }
      do {
        if let feedID {
          opened = try await model.api.feed(feedID)
        } else {
          opened = try await model.api.createFeed(CreateFeed(url: feedURL, followed: false))
        }
        error = nil
      } catch let e as APIError where e.status == 409 {
        if let id = e.feedId, let feed = try? await model.api.feed(id) {
          opened = feed
        } else {
          error = "The server already has this show, but didn’t say which it is."  // a server from before feed_id
        }
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}

private struct ShowResultRow: View {
  let result: ShowSearch.Result
  let opening: Bool

  var body: some View {
    HStack(spacing: 12) {
      Artwork(url: result.artworkUrl, size: 52)
      VStack(alignment: .leading, spacing: 3) {
        Text(result.title).font(.body.weight(.medium)).lineLimit(2)
        Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 8)
      if opening {
        ProgressView()
      } else if result.followed == true {
        Text("Following").font(.caption.weight(.medium)).foregroundStyle(.secondary)
      }
    }
    .contentShape(.rect)
  }

  private var detail: String {
    [
      result.author,
      result.episodeCount.map { $0 == 1 ? "1 episode" : "\($0) episodes" },
      result.genres.first,
    ].compactMap { $0 }.joined(separator: " · ")
  }
}
