import PodcastAPI
import SwiftUI

// Prompts, their versions, and eval scores, like the web's Prompts screens (server/prompts/README.md). Reached from
// the account menu on Today. Saving or activating a version makes the server commit to git in its checkout, and
// production pushes that commit to GitHub.

/// Where the Prompts screens lead. The stack's root declares them (`promptDestinations()`), since SwiftUI only uses
/// the destination closest to the root.
enum PromptRoute: Hashable {
  case list
  case prompt(String)
  case version(name: String, version: String)
  case run(eval: String, run: String)
}

extension View {
  func promptDestinations() -> some View {
    navigationDestination(for: PromptRoute.self) { route in
      switch route {
      case .list: PromptsView()
      case .prompt(let name): PromptDetailView(name: name)
      case .version(let name, let version): PromptVersionView(name: name, version: version)
      case .run(let eval, let run): EvalRunView(eval: eval, run: run)
      }
    }
  }
}

/// Every prompt with its active version and, when it has an eval, that version's latest score.
struct PromptsView: View {
  @Environment(AppModel.self) private var model
  @State private var prompts: [Prompt] = []
  @State private var error: String?
  @State private var loaded = false

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.secondary) }
      ForEach(prompts) { prompt in
        NavigationLink(value: PromptRoute.prompt(prompt.name)) {
          HStack {
            VStack(alignment: .leading, spacing: 3) {
              Text(prompt.label).font(.body.weight(.medium))
              Text([prompt.active, prompt.inUse ? nil : "Off"].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
              // How it fared in use, beside how it scored: what the owner changed of what it wrote.
              if let edits = prompt.editsLine {
                Text(edits).font(.caption).monospacedDigit().foregroundStyle(.secondary)
              }
            }
            Spacer()
            if prompt.eval != nil { ScoreText(score: prompt.versions.first { $0.active }?.score) }
          }
        }
      }
    }
    .overlay { if !loaded && error == nil { ProgressView() } }
    .navigationTitle("Prompts")
    .task { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    do {
      prompts = try await model.api.prompts()
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }
}

/// One prompt's versions, newest first, with each one's latest score.
struct PromptDetailView: View {
  @Environment(AppModel.self) private var model
  let name: String
  @State private var prompt: Prompt?
  @State private var error: String?
  @State private var editing = false
  @State private var created: PromptVersion?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.secondary) }
      if let prompt {
        Section {
          ForEach(prompt.versions) { v in
            NavigationLink(value: PromptRoute.version(name: name, version: v.version)) {
              HStack {
                VStack(alignment: .leading, spacing: 3) {
                  Text(v.version).font(.body.weight(.medium))
                  HStack(spacing: 6) {
                    Text(Format.day(v.createdAt))
                    if v.active { ActiveBadge() }
                  }
                  .font(.caption).foregroundStyle(.secondary)
                  if let edits = prompt.editsText(v.edits) {
                    Text(edits).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                  }
                }
                Spacer()
                if prompt.eval != nil { ScoreText(score: v.score) }
              }
            }
          }
        } footer: {
          // The count that belongs to no version: the spans the fixed rules chose.
          if let rules = prompt.editsText(prompt.rulesEdits) {
            Text("\(prompt.inUse ? "Where the fixed rules chose the start instead:" : "The fixed rules choose where a snip starts while this prompt is off.") \(rules).")
          }
        }
      }
    }
    .overlay { if prompt == nil && error == nil { ProgressView() } }
    .navigationTitle(prompt?.label ?? "Prompt")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button("New version", systemImage: "square.and.pencil") { editing = true }
          .disabled(prompt == nil)
      }
    }
    .sheet(isPresented: $editing) {
      if let prompt {
        PromptEditorView(name: name, from: prompt.active) { created = $0 }
      }
    }
    .navigationDestination(item: $created) { v in PromptVersionView(name: name, version: v.version) }
    .task { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    do {
      prompt = try await model.api.prompts().first { $0.name == name }
      error = prompt == nil ? "No prompt named \(name)" : nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// A pass rate and its 95% margin, "62% ±12", or a dash before the first finished run.
struct ScoreText: View {
  let score: EvalScore?

  var body: some View {
    if let score {
      HStack(alignment: .firstTextBaseline, spacing: 2) {
        Text(Format.percent(score.rate)).font(.body.weight(.semibold))
        Text("±\(Int((score.margin * 100).rounded()))").font(.caption).foregroundStyle(.secondary)
      }
      .monospacedDigit()
    } else {
      Text("No run yet").font(.footnote).foregroundStyle(.secondary)
    }
  }
}

struct ActiveBadge: View {
  var body: some View {
    Text("Active")
      .font(.caption2.weight(.semibold))
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .foregroundStyle(.tint)
      .background(.tint.opacity(0.15), in: .capsule)
  }
}

extension Format {
  static func percent(_ rate: Double) -> String { "\(Int((rate * 100).rounded()))%" }

  /// "Yesterday", "3 days ago".
  static func day(_ ms: Int) -> String {
    Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.relative(presentation: .named))
  }

  /// "Oct 26, 2026 at 5:48 PM".
  static func moment(_ ms: Int) -> String {
    Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
  }
}

extension EvalRun {
  /// "37 of 60" when done, progress while running, else the state.
  var statusLabel: String {
    switch status {
    case .done: score.map { "\($0.passed) of \($0.n)" } ?? "Done"
    case .running: progress.flatMap { $0.total > 0 ? "\($0.done) of \($0.total)" : nil } ?? "Running"
    case .queued: "Queued"
    case .failed, .unknown: "Failed"
    }
  }
}
