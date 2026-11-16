import PlayerKit
import PodcastAPI
import SwiftUI
import SyncKit

/// A snip tap that is still on the phone (no connection when it was made): its title, its note, its summary's points
/// and how far back it reaches can be set now. They travel with the tap; the server still fits the ends to whole sentences when it gets
/// it, and keeps what was typed here over anything it would have written.
struct WaitingSnipSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let pending: SnipOutbox.Pending

  @State private var title = ""
  @State private var note = ""
  @State private var summary = ""
  @State private var lengthMs = 0
  /// The length was changed here or before: only then does the tap carry a span of the owner's.
  @State private var lengthSet = false

  static let stepMs = 15_000
  static let longestMs = 600_000

  /// As far back as the snip may reach: the start of the recording, or ten minutes.
  private var mostMs: Int { min(pending.body.anchorMs, Self.longestMs) }

  /// A text box that takes Return the same on the on-screen and a hardware keyboard: a new line in the note and the
  /// summary, done in the title (OwnerTextBox).
  private func box(_ prompt: String, text: Binding<String>, oneLine: Bool = false) -> some View {
    OwnerTextBox(
      text: text, selection: .constant(nil), face: .body, singleLine: oneLine, locked: false, takesFocus: false,
      accessibilityLabel: prompt
    )
    .overlay(alignment: .topLeading) {
      if text.wrappedValue.isEmpty {
        Text(prompt).foregroundStyle(.tertiary).allowsHitTesting(false).accessibilityHidden(true)
      }
    }
    .frame(minHeight: oneLine ? nil : 52, alignment: .topLeading)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          box("Title", text: $title, oneLine: true)
        } footer: {
          Text("Left empty, the title is written when the snip is sent.")
        }
        Section {
          Stepper(value: Binding(get: { lengthMs }, set: { lengthMs = $0; lengthSet = true }), in: min(Self.stepMs, mostMs)...mostMs, step: Self.stepMs) {
            VStack(alignment: .leading, spacing: 2) {
              Text(Format.duration(lengthMs)).font(.body.weight(.medium)).monospacedDigit()
              Text("\(Format.clock(pending.body.anchorMs - lengthMs)) to \(Format.clock(pending.body.anchorMs))")
                .font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
            }
          }
        } header: {
          Text("Length")
        } footer: {
          Text(lengthSet ? "Your length is kept. The ends are fitted to whole words when the snip is sent." : "Unchanged, the start is chosen from the transcript when the snip is sent.")
        }
        Section("Note") {
          box("Why you kept it", text: $note)
        }
        Section {
          box("One point a line", text: $summary)
        } header: {
          Text("Summary")
        } footer: {
          Text("Left empty, the summary is written when the snip is sent. Yours is kept instead of it.")
        }
        Section {
          Button("Delete snip", role: .destructive) {
            Task {
              await model.deleteWaiting(pending.id)
              dismiss()
            }
          }
        } footer: {
          Text("Kept on this phone since \(Date(timeIntervalSince1970: Double(pending.body.capturedAt) / 1000).formatted(date: .abbreviated, time: .shortened)). It is sent when the server can be reached.")
        }
      }
      .navigationTitle(pending.episodeTitle ?? "Snip")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task {
              await model.editWaiting(pending.id, owner: edit)
              dismiss()
            }
          }
        }
      }
      .onAppear {
        title = pending.body.owner?.title ?? ""
        note = pending.body.owner?.note ?? ""
        summary = pending.body.owner?.summary ?? ""
        lengthMs = pending.endMs - pending.startMs
        lengthSet = pending.body.owner?.startMs != nil
      }
    }
  }

  private var edit: CreateSnip.Owner {
    let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
    let summary = SnipPageModel.lines(summary)
    return CreateSnip.Owner(
      startMs: lengthSet ? pending.body.anchorMs - lengthMs : nil, endMs: lengthSet ? pending.body.anchorMs : nil,
      title: title.isEmpty ? nil : String(title.prefix(120)), note: note.isEmpty ? nil : note,
      summary: summary.isEmpty ? nil : String(summary.prefix(2000)))
  }
}

/// A waiting tap in the Snips list, laid out as a snip's row is.
struct WaitingSnipRow: View {
  let pending: SnipOutbox.Pending

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Artwork(url: pending.imageUrl, size: 44).padding(.top, 2)
      VStack(alignment: .leading, spacing: 3) {
        Text(pending.body.owner?.title ?? "Snipped at \(Format.clock(pending.body.anchorMs))").font(.body.weight(.medium)).lineLimit(2)
        if let episode = pending.episodeTitle {
          Text(episode).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        HStack(spacing: 0) {
          Text("\(Format.clock(pending.startMs)) · \(Format.duration(pending.endMs - pending.startMs)) · not sent yet").monospacedDigit().lineLimit(1)
          Spacer(minLength: 8)
          Text(Date(timeIntervalSince1970: Double(pending.body.capturedAt) / 1000), format: .relative(presentation: .named)).fixedSize()
        }
        .font(.caption).foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
  }
}
