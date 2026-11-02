import PodcastAPI
import SwiftUI

/// A new version, starting from an existing version's text. Saving adds it as the next version, not yet active.
struct PromptEditorView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let name: String
  /// The version whose text the editor starts from.
  let from: String
  let onSaved: (PromptVersion) -> Void
  @State private var source: String?
  @State private var text = ""
  @State private var loadError: String?
  @State private var saveError: String?
  @State private var saving = false

  private var unchanged: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines) == source?.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("New version")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(saving ? "Saving…" : "Save") { Task { await save() } }
              .disabled(source == nil || unchanged || saving)
          }
        }
    }
    .interactiveDismissDisabled(source != nil && !unchanged)
    .task { await load() }
  }

  @ViewBuilder private var content: some View {
    if let loadError {
      ContentUnavailableView("Can't open \(from)", systemImage: "exclamationmark.triangle", description: Text(loadError))
    } else if source == nil {
      ProgressView()
    } else {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text("From \(from)")
          Spacer()
          if let saveError { Text(saveError).foregroundStyle(.red) }
        }
        .font(.caption).foregroundStyle(.secondary)
        .padding(.horizontal)
        TextEditor(text: $text)
          .font(.system(.footnote, design: .monospaced))
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .padding(.horizontal, 12)
      }
    }
  }

  private func load() async {
    guard source == nil else { return }
    do {
      let v = try await model.api.promptVersion(name, from)
      text = v.text
      source = v.text
    } catch {
      loadError = error.localizedDescription
    }
  }

  private func save() async {
    saving = true
    defer { saving = false }
    do {
      let created = try await model.api.createPromptVersion(name, text: text)
      dismiss()
      onSaved(created)
    } catch let error as APIError where error.status == 409 {
      // "same text as v1"
      saveError = error.message.replacingOccurrences(of: "same text as", with: "Same as")
    } catch {
      saveError = error.localizedDescription
    }
  }
}
