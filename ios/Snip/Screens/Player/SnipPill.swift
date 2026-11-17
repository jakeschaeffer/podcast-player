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

  private(set) var phase: Phase {
    didSet { if phase != oldValue { onChange?(self) } }
  }
  private(set) var error: String?
  /// The server couldn't be reached: the tap is kept on the phone and sent when it can be.
  private(set) var onPhone = false {
    didSet { if onPhone != oldValue { onChange?(self) } }
  }
  /// Told each time the phase changes, so the Live Activity follows the snip (AppModel).
  @ObservationIgnored var onChange: ((SnipCardModel) -> Void)?
  /// The Live Activity's title was tapped: the bar opens the title for renaming as soon as it shows.
  var renameRequested = false
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

  /// The first try to send the tap failed.
  func held() { onPhone = true }

  /// The owner gave the waiting tap a title, a note or another length.
  func edited(_ pending: SnipOutbox.Pending) {
    if case .waiting = phase { phase = .waiting(pending) }
  }

  /// The outbox delivered the tap; start following the snip it became.
  func delivered(_ snip: Snip, api: APIClient) {
    onPhone = false
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
  /// clip) and keeps it as the owner's title, even over a summary still being written. It names no revision, so a step
  /// the server took meanwhile can't refuse it. Returns false when it failed.
  func rename(_ title: String, api: APIClient) async -> Bool {
    guard let snip else { return false }
    do {
      phase = .snip(try await api.editSnip(snip.id, EditSnip(title: title)))
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
/// the title renames it in place (as on the snip's page). The round arrow opens the snip's page at every step the
/// server has the snip, choosing the moment included, so the owner can write a title, a summary or a note there before
/// the generated ones arrive. A finished
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
  /// A finger is on the bar: it doesn't close under it, and the wait starts again once the finger lifts.
  @State private var touched = false
  @FocusState private var titleFocused: Bool

  var body: some View {
    Group {
      if card.onPhone, case .waiting(let pending) = card.phase {
        // No connection: the snip is kept, with a length to start from, and can be named before it is sent.
        HStack(spacing: 14) {
          Image(systemName: "wifi.slash").font(.title3.weight(.semibold)).foregroundStyle(.secondary)
          Button { model.editingWaiting = pending } label: {
            lines(
              pending.body.owner?.title ?? "Snipped at \(Format.clock(pending.body.anchorMs))",
              "Not sent"
            ).contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityHint("Names the snip or changes its length")
          Button { model.editingWaiting = pending } label: {
            Image(systemName: "pencil")
              .font(.body.weight(.bold))
              .frame(width: 48, height: 48)
              .background(Color(.systemGray4), in: .circle)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Edit snip")
          Button(action: onClose) {
            Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 36, height: 44)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Close")
        }
      } else if card.cancellable {
        HStack(spacing: 14) {
          // The round arrow takes the spinner's room once there is a page to open; the line below still says it is
          // choosing the moment.
          if card.snip == nil { ProgressView().controlSize(.regular) }
          lines("Snipped at \(Format.clock(anchorMs))", "Choosing the moment…")
          Button("Cancel", action: onCancel)
            .font(.body.weight(.semibold))
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .accessibilityLabel("Cancel snip")
          if let snip = card.snip { openButton(snip) }
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
            openButton(snip)
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
    .simultaneousGesture(
      DragGesture(minimumDistance: 0).onChanged { _ in touched = true }.onEnded { _ in touched = false }
    )
    // A tap on the Live Activity's title (AppModel.open) renames, as a tap on the bar's title would.
    .task(id: card.renameRequested) {
      guard card.renameRequested, let snip = card.snip, snip.revision?.title != nil else { return }
      card.renameRequested = false
      begin(snip)
    }
    #if DEBUG
      // `-openSnipFromBarAfter <s>`: press the round arrow that many seconds after the server has the snip, whatever
      // step it is at, for scripted checks of writing on a snip still being made.
      .task(id: card.snip?.id) {
        let after = UserDefaults.standard.double(forKey: "openSnipFromBarAfter")
        guard after > 0, let id = card.snip?.id else { return }
        try? await Task.sleep(for: .seconds(after))
        if !Task.isCancelled { onOpen(id) }
      }
    #endif
    .task(id: closesAfterAWhile) {
      guard closesAfterAWhile else { return }
      try? await Task.sleep(for: Self.readyFor)
      if !Task.isCancelled { onClose() }
    }
  }

  /// The round arrow to the snip's page.
  private func openButton(_ snip: Snip) -> some View {
    Button { onOpen(snip.id) } label: {
      Image(systemName: "chevron.forward")
        .font(.body.weight(.bold))
        .frame(width: 48, height: 48)
        .background(Color(.systemGray4), in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open snip")
  }

  private var closesAfterAWhile: Bool { card.snip?.revision?.status == .ready && draft == nil && !touched }

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

  /// The title and the step it is at. Each wraps to a second line rather than cut off: on the iPhone Duo's reading
  /// page, a step larger, "Snipped at 31:48" no longer fit one line, and the time is the point of it.
  private func lines(_ title: String, _ subtitle: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.title3.weight(.semibold)).lineLimit(2)
      Text(subtitle).font(.callout).foregroundStyle(.secondary).lineLimit(2)
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
    return "Snip saved"
  }
}
