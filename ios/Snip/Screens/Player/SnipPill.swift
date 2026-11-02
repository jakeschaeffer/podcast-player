import Observation
import PlayerKit
import PodcastAPI
import SwiftUI
import SyncKit

/// The result of one snip tap, followed until the server is done with it, like web/src/snips/useSnip.ts:
/// `GET /v1/snips/{id}` with `If-None-Match` every 2 s while the revision is being prepared, then stop.
@MainActor @Observable
final class SnipCardModel {
  enum Phase: Equatable {
    /// Saved on the phone, not yet accepted by the server (offline, or the server is restarting).
    case waiting(SnipOutbox.Pending)
    case snip(Snip)
  }

  private(set) var phase: Phase
  private(set) var error: String?
  /// Why the last rename didn't save; the pill keeps the text box open with what was typed.
  private(set) var renameError: String?
  private var etag: String?
  private var polling: Task<Void, Never>?

  init(pending: SnipOutbox.Pending, snip: Snip?) {
    phase = snip.map(Phase.snip) ?? .waiting(pending)
  }

  /// An existing snip, opened from the episode's list.
  init(snip: Snip) {
    phase = .snip(snip)
  }

  var snip: Snip? { if case .snip(let s) = phase { s } else { nil } }

  /// Until the server has chosen the moment (offline, waiting for the transcript, or selecting), the card's X cancels
  /// the snip; after that it only closes the card.
  var cancellable: Bool {
    switch phase {
    case .waiting: true
    case .snip(let snip): snip.revision.map { $0.status == .waiting || $0.status == .selecting } ?? true
    }
  }

  /// The outbox delivered the tap later; start following the snip it became.
  func delivered(_ snip: Snip, api: APIClient) {
    phase = .snip(snip)
    follow(api: api)
  }

  func follow(api: APIClient) {
    polling?.cancel()
    guard let id = snip?.id else { return }
    polling = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, self.snip?.isPending ?? false else { return }
        try? await Task.sleep(for: .seconds(2))
        do {
          if let fresh = try await api.snip(id, ifNoneMatch: self.etag) {
            self.phase = .snip(fresh.value)
            self.etag = fresh.etag
          }
          self.error = nil
        } catch {
          self.error = error.localizedDescription
        }
      }
    }
  }

  func stop() { polling?.cancel() }

  /// A new title for the snip, typed in the pill. A title-only PATCH: the server edits the revision in place (no new
  /// clip) and keeps it as the owner's title, even over a summary still being written. Returns false when it failed.
  func rename(_ title: String, api: APIClient) async -> Bool {
    guard let snip, let rev = snip.revision else { return false }
    do {
      phase = .snip(try await api.editSnip(snip.id, EditSnip(title: title, ifRevision: rev.id)))
      renameError = nil
      return true
    } catch let e as APIError where e.status == 409 {
      renameError = "This snip changed elsewhere. Open it to rename it."
    } catch {
      renameError = error.localizedDescription
    }
    return false
  }
}

/// What the player shows after a snip tap: one slim bar above the controls, never a card over the transcript.
/// While the moment is being chosen it says so and offers Cancel; once the snip exists it shows its title, a tap on
/// the title renames it in place (as on the snip's page), and the round arrow opens the snip's page. A finished
/// snip's bar goes away by itself after a while, but not while it is being renamed; the snip stays in the lists.
struct SnipPill: View {
  @Environment(AppModel.self) private var model
  let card: SnipCardModel
  let onOpen: (ULID) -> Void
  let onCancel: () -> Void
  let onClose: () -> Void

  /// How long a finished snip's bar stays.
  static let readyFor = Duration.seconds(15)

  /// The title being typed; nil when not renaming.
  @State private var draft: String?
  @State private var saving = false
  @FocusState private var titleFocused: Bool

  var body: some View {
    Group {
      if card.cancellable {
        HStack(spacing: 14) {
          ProgressView().controlSize(.regular)
          lines("Snipped at \(Format.clock(anchorMs))", "Choosing the moment…")
          Button("Cancel", action: onCancel)
            .font(.body.weight(.semibold))
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .accessibilityLabel("Cancel snip")
        }
      } else if card.snip?.revision?.status == .failed {
        HStack(spacing: 14) {
          Image(systemName: "exclamationmark.triangle.fill").font(.title3).foregroundStyle(.red)
          lines("Snip failed", card.snip?.revision?.error ?? "Snipped at \(Format.clock(anchorMs))")
          Button(action: onClose) {
            Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 44, height: 44)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Dismiss")
        }
      } else if let snip = card.snip {
        HStack(spacing: 14) {
          if snip.revision?.status == .ready, !saving {
            Image(systemName: "checkmark").font(.title3.weight(.bold)).foregroundStyle(Color.accentColor)
          } else {
            ProgressView().controlSize(.regular)
          }
          if draft != nil {
            titleField
            Button("Done") { Task { await commit() } }
              .font(.body.weight(.semibold))
              .buttonStyle(.borderedProminent)
              .buttonBorderShape(.capsule)
              .controlSize(.large)
              .disabled(saving)
          } else {
            Button { begin(snip) } label: {
              lines(snip.revision?.title ?? "Snip", subtitle(snip)).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(snip.revision?.title == nil)
            .accessibilityHint("Renames the snip")
            Button { onOpen(snip.id) } label: {
              Image(systemName: "chevron.forward")
                .font(.body.weight(.bold))
                .frame(width: 48, height: 48)
                .background(Color(.systemGray4), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open snip")
          }
        }
      }
    }
    .padding(.leading, 20)
    .padding(.trailing, 10)
    .padding(.vertical, 6)
    .frame(minHeight: 68)
    // A capsule at one line; a rounded box when the title being typed wraps.
    .background(Color(.systemGray5), in: .rect(cornerRadius: 34, style: .continuous))
    .task(id: closesAfterAWhile) {
      guard closesAfterAWhile else { return }
      try? await Task.sleep(for: Self.readyFor)
      if !Task.isCancelled { onClose() }
    }
  }

  private var closesAfterAWhile: Bool { card.snip?.revision?.status == .ready && draft == nil }

  /// The title as a text box, at the size it is shown. Return or Done saves, and so does tapping away.
  private var titleField: some View {
    VStack(alignment: .leading, spacing: 2) {
      TextField("Title", text: Binding(get: { draft ?? "" }, set: { draft = $0 }), axis: .vertical)
        .font(.title3.weight(.semibold))
        .lineLimit(1...3)
        .focused($titleFocused)
        .submitLabel(.done)
        .disabled(saving)
        .onAppear { titleFocused = true }
        // The whole title starts selected, so typing replaces it and a tap places the cursor instead. (A vertical
        // field is a UITextView; SwiftUI's selection binding is undone when it takes focus.)
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { note in
          guard let view = note.object as? UITextView else { return }
          Task { view.selectAll(nil) }
        }
        .onChange(of: draft) { _, title in
          // Return ends the edit: a vertical field would take the newline.
          guard let title, title.contains("\n") else { return }
          draft = title.replacingOccurrences(of: "\n", with: "")
          Task { await commit() }
        }
        .onChange(of: titleFocused) { _, focused in
          if !focused { Task { await commit() } }
        }
      Text(card.renameError ?? "Return to save")
        .font(.callout)
        .foregroundStyle(card.renameError == nil ? Color.secondary : Color.red)
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func begin(_ snip: Snip) {
    draft = snip.revision?.title ?? ""
  }

  /// Saves the typed title, or just closes the box when it is empty or unchanged. A failed save keeps it open.
  private func commit() async {
    guard let typed = draft, !saving else { return }
    let title = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title != card.snip?.revision?.title else {
      draft = nil
      return
    }
    saving = true
    defer { saving = false }
    if await card.rename(String(title.prefix(120)), api: model.api) { draft = nil }
  }

  private func lines(_ title: String, _ subtitle: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.title3.weight(.semibold)).lineLimit(1)
      Text(subtitle).font(.callout).foregroundStyle(.secondary).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var anchorMs: Int {
    switch card.phase {
    case .waiting(let pending): pending.body.anchorMs
    case .snip(let snip): snip.anchorMs
    }
  }

  private func subtitle(_ snip: Snip) -> String {
    guard let rev = snip.revision, rev.status == .ready else {
      // The clip is cut within seconds; the title takes the model a while longer.
      return snip.revision?.clipUrl == nil ? "Preparing the clip" : "Clip ready · naming it…"
    }
    return "Snip saved · \(Format.duration(rev.endMs - rev.startMs))"
  }
}
