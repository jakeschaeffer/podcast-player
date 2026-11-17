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
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
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

  @ViewBuilder private var titleSection: some View {
    Section {
      box("Title", text: $title, oneLine: true)
        .accessibilityHint("Left empty, the title is written when the snip is sent")
    }
  }

  @ViewBuilder private var lengthSection: some View {
    Section {
      Stepper(value: Binding(get: { lengthMs }, set: { lengthMs = $0; lengthSet = true }), in: min(Self.stepMs, mostMs)...mostMs, step: Self.stepMs) {
        VStack(alignment: .leading, spacing: 2) {
          Text(Format.duration(lengthMs)).font(.body.weight(.medium)).monospacedDigit()
          Text("\(Format.clock(pending.body.anchorMs - lengthMs)) to \(Format.clock(pending.body.anchorMs))")
            .font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
        }
      }
      .accessibilityHint(lengthSet ? "Kept; the ends are fitted to whole words when the snip is sent" : "The start is chosen from the transcript when the snip is sent")
    } header: {
      Text("Length")
    }
  }

  @ViewBuilder private var noteSection: some View {
    Section("Note") {
      box("Why you kept it", text: $note)
    }
  }

  @ViewBuilder private var summarySection: some View {
    Section {
      box("One point a line", text: $summary)
        .accessibilityHint("Left empty, the summary is written when the snip is sent")
    } header: {
      Text("Summary")
    }
  }

  @ViewBuilder private var deleteSection: some View {
    Section {
      Button("Delete snip", role: .destructive) {
        Task {
          await model.deleteWaiting(pending.id)
          dismiss()
        }
      }
    }
  }

  var body: some View {
    NavigationStack {
      GeometryReader { geo in
        // Open and held wide: the snip's two halves on the two pages, the fold between them, on one full screen.
        HingeSplit(split: UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: geo.size),
                   gapFill: Color(.systemGroupedBackground)) {
          Form {
            titleSection
            lengthSection
            if !UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: geo.size) {
              noteSection
              summarySection
            }
            deleteSection
          }
        } trailing: {
          Form {
            noteSection
            summarySection
          }
        }
      }
      .background(Color(.systemGroupedBackground))
      // The episode's name is too long for the bar; the state is what matters here.
      .navigationTitle("Not sent")
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
