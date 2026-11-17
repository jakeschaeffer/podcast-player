import PodcastAPI
import SwiftUI

/// The snip bar's states (SnipPill) drawn to fill a whole half of the screen: the iPhone Duo standing half open,
/// where the flat bottom half is all controls and, after a snip tap, all snip. One step at a time, in large type,
/// with full-width buttons: Cancel while the moment is being chosen, Open (the snip's page, where its title and the
/// rest can be changed) and Done, which brings the controls back. A finished snip's panel goes by itself after the
/// same while as the bar's.
struct SnipPanel: View {
  @Environment(AppModel.self) private var model
  let card: SnipCardModel
  let onOpen: (ULID) -> Void
  let onCancel: () -> Void
  let onClose: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Spacer(minLength: 0)
      HStack(alignment: .firstTextBaseline, spacing: 16) {
        mark.frame(width: 40)
        VStack(alignment: .leading, spacing: 8) {
          Text(title).font(.largeTitle.weight(.bold)).lineLimit(3).fixedSize(horizontal: false, vertical: true)
          Text(subtitle).font(.title3).foregroundStyle(.secondary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .accessibilityElement(children: .combine)
      Spacer(minLength: 0)
      HStack(spacing: 16) { buttons }
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(.systemGray6), in: .rect(cornerRadius: 32, style: .continuous))
    .task(id: closesAfterAWhile) {
      guard closesAfterAWhile else { return }
      try? await Task.sleep(for: SnipPill.readyFor)
      if !Task.isCancelled { onClose() }
    }
  }

  private var closesAfterAWhile: Bool { card.snip?.revision?.status == .ready }

  @ViewBuilder private var mark: some View {
    if card.onPhone, case .waiting = card.phase {
      Image(systemName: "wifi.slash").font(.title.weight(.semibold)).foregroundStyle(.secondary)
    } else if card.snip?.revision?.status == .failed {
      Image(systemName: "exclamationmark.triangle.fill").font(.title).foregroundStyle(.red)
    } else if card.snip?.revision?.status == .ready {
      Image(systemName: "checkmark").font(.title.weight(.bold)).foregroundStyle(Color.accentColor)
    } else {
      ProgressView().controlSize(.large)
    }
  }

  private var title: String {
    if card.onPhone, case .waiting(let pending) = card.phase {
      return pending.body.owner?.title ?? "Snipped at \(Format.clock(pending.body.anchorMs))"
    }
    if card.cancellable { return "Snipped at \(Format.clock(anchorMs))" }
    if card.snip?.revision?.status == .failed { return "Snip failed" }
    return card.snip?.revision?.title ?? "Snipped at \(Format.clock(anchorMs))"
  }

  private var subtitle: String {
    if card.onPhone, case .waiting(let pending) = card.phase {
      return "Not sent"
    }
    if card.cancellable { return "Choosing the moment…" }
    guard let snip = card.snip, let rev = snip.revision else { return "" }
    if rev.status == .failed { return rev.error ?? "Snipped at \(Format.clock(anchorMs))" }
    if rev.status != .ready { return rev.clipUrl == nil ? "Preparing the clip" : "Clip ready · naming it…" }
    return "Snip saved"
  }

  private var anchorMs: Int {
    switch card.phase {
    case .waiting(let pending): pending.body.anchorMs
    case .snip(let snip): snip.anchorMs
    }
  }

  @ViewBuilder private var buttons: some View {
    if card.onPhone, case .waiting(let pending) = card.phase {
      big("Edit", "pencil") { model.editingWaiting = pending }
      big("Done", nil, action: onClose)
    } else if card.cancellable {
      big("Cancel snip", "xmark", role: .destructive, action: onCancel)
      if let id = card.snip?.id { big("Open", "chevron.forward") { onOpen(id) } }
    } else if card.snip?.revision?.status == .failed {
      big("Done", nil, action: onClose)
    } else if let snip = card.snip {
      big("Open", "chevron.forward") { onOpen(snip.id) }
      big("Done", nil, action: onClose)
    }
  }

  private func big(_ label: String, _ symbol: String?, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
    Button(role: role, action: action) {
      Group {
        if let symbol { Label(label, systemImage: symbol) } else { Text(label) }
      }
      .font(.title3.weight(.semibold))
      .frame(maxWidth: .infinity, minHeight: 56)
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.capsule)
    .controlSize(.large)
  }
}
