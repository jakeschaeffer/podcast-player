import PodcastAPI
import SwiftUI

struct ReadwiseRoute: Hashable {}

/// Snips the server could not get into Readwise, and a way to send them again. Opened from the account menu, which
/// offers it only when a send has failed; otherwise the menu's one line ("48 of 48 snips sent") says it all.
struct ReadwiseView: View {
  @Environment(AppModel.self) private var model
  @State var summary: ReadwiseSummary?
  @State private var error: String?
  /// How many failures were just sent again, while the server works through them.
  @State private var resending: Int?

  var body: some View {
    List {
      if let error {
        Text(error).foregroundStyle(.secondary)
      }
      if let summary {
        Section {
          LabeledContent("Sent", value: "\(summary.sent) of \(summary.snips)")
          if summary.waiting > 0 { LabeledContent("Waiting to send", value: "\(summary.waiting)") }
          if summary.deletedInReadwise > 0 { LabeledContent("Deleted in Readwise", value: "\(summary.deletedInReadwise)") }
        } header: {
          Text("Past month")
        } footer: {
          Text("Every snip goes to Readwise once its title and summary are in, and again after an edit.")
        }
        if let resending {
          Section {
            HStack(spacing: 12) {
              ProgressView()
              Text("Sending \(resending) again…").foregroundStyle(.secondary)
            }
          }
        } else if !summary.failed.isEmpty {
          // When every failure has the same cause (a refused token, usually), it is said once, under the list.
          let reasons = Set(summary.failed.map { FailureRow.reason($0.error) })
          let shared = summary.failed.count > 1 && reasons.count == 1 ? reasons.first : nil
          Section {
            ForEach(summary.failed) { FailureRow(failure: $0, showsReason: shared == nil) }
            Button("Try Again", systemImage: "arrow.clockwise") { Task { await retry() } }
          } header: {
            Text("Failed sends")
          } footer: {
            Text([shared, "The server also tries these again on its own every six hours."].compactMap { $0 }.joined(separator: " "))
          }
        } else {
          Section {
            Label("Nothing failed", systemImage: "checkmark.circle").foregroundStyle(.secondary)
          }
        }
      }
    }
    .overlay { if summary == nil && error == nil { ProgressView() } }
    .navigationTitle("Readwise")
    .task { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    do {
      summary = try await model.api.readwise()
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// The server queues the failures at once and answers before they run, so the list is read again a moment later
  /// to show any that failed a second time.
  private func retry() async {
    let count = summary?.failed.count ?? 0
    resending = count
    do {
      summary = try await model.api.retryReadwise()
      try? await Task.sleep(for: .seconds(max(3, count)))
      await load()
    } catch {
      self.error = error.localizedDescription
    }
    resending = nil
  }
}

private struct FailureRow: View {
  let failure: ReadwiseSummary.Failure
  var showsReason = true

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(failure.title).font(.headline).lineLimit(2)
      Text(failure.snipDeleted ? "\(failure.episodeTitle) · deleted here" : failure.episodeTitle)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      if showsReason {
        Text(Self.reason(failure.error))
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(3)
      }
    }
    .padding(.vertical, 2)
  }

  /// The server's error says which request Readwise answered and how; the usual answers in words, the rest as is.
  static func reason(_ error: String) -> String {
    let status = error.firstMatch(of: /answered (\d{3})/).flatMap { Int($0.1) }
    switch status {
    case 401, 403: return "Readwise refused the server's token. Check READWISE_TOKEN on the server."
    case 429: return "Readwise asked the server to slow down."
    case .some(500...599): return "Readwise was not answering."
    default: return error
    }
  }
}

extension ReadwiseSummary {
  /// "46 of 48 snips sent", for the account menu, under its "Readwise · past month" header.
  var sentLine: String {
    snips == 0 ? "No snips" : "\(sent) of \(snips) snip\(snips == 1 ? "" : "s") sent"
  }
}
