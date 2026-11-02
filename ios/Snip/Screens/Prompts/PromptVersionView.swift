import PodcastAPI
import SwiftUI

/// One version: its text or its changes from the version before, Activate, Run, a new version from this text, and
/// its eval runs (reloaded every few seconds while one waits or runs).
struct PromptVersionView: View {
  @Environment(AppModel.self) private var model
  let name: String
  let version: String
  @State private var current: PromptVersion?
  @State private var error: String?
  @State private var actionError: String?
  @State private var showChanges = false
  @State private var busy = false
  @State private var confirmingActivate = false
  @State private var editing = false
  @State private var created: PromptVersion?

  private var pending: Bool { current?.runs.contains { $0.status.isPending } ?? false }

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.secondary) }
      if let v = current {
        Section {
          actions(v)
          if let actionError { Text(actionError).font(.caption).foregroundStyle(.red) }
          if v.previous != nil {
            Picker("Show", selection: $showChanges) {
              Text("Text").tag(false)
              Text("Changes").tag(true)
            }
            .pickerStyle(.segmented)
          }
        }
        Section {
          text(v)
            .font(.system(.footnote, design: .monospaced))
            .textSelection(.enabled)
        } header: {
          if showChanges, let previous = v.previous { Text("Changes from \(previous.version)") }
        }
        if v.eval != nil { runs(v) }
      }
    }
    .overlay { if current == nil && error == nil { ProgressView() } }
    .navigationTitle(version)
    .toolbar {
      if current?.active == true {
        ToolbarItem(placement: .primaryAction) { ActiveBadge() }
      }
    }
    .confirmationDialog("Activate \(version)?", isPresented: $confirmingActivate, titleVisibility: .visible) {
      Button("Activate") { Task { await act { _ = try await model.api.activatePrompt(name, version: version) } } }
    } message: {
      Text("Production uses it from the next model call.")
    }
    .sheet(isPresented: $editing) {
      PromptEditorView(name: name, from: version) { created = $0 }
    }
    .navigationDestination(item: $created) { v in PromptVersionView(name: name, version: v.version) }
    .task { await load() }
    .task(id: pending) {
      while pending && !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3))
        await load()
      }
    }
    .refreshable { await load() }
  }

  @ViewBuilder private func actions(_ v: PromptVersion) -> some View {
    HStack {
      if !v.active {
        Button("Activate") { confirmingActivate = true }
          .buttonStyle(.borderedProminent)
      }
      if let eval = v.eval {
        Button("Run", systemImage: "play.fill") {
          Task { await act { _ = try await model.api.startEvalRun(eval.id, version: version) } }
        }
        .buttonStyle(.bordered)
        .disabled(pending)
      }
      Button("Edit", systemImage: "square.and.pencil") { editing = true }
        .buttonStyle(.bordered)
      Spacer()
    }
    .disabled(busy)
  }

  private func text(_ v: PromptVersion) -> Text {
    guard showChanges, let previous = v.previous else { return Text(v.text) }
    var out = AttributedString()
    for part in WordDiff.diff(previous.text, v.text) {
      var piece = AttributedString(part.text)
      switch part.kind {
      case .same: break
      case .add:
        piece.backgroundColor = .green.opacity(0.25)
      case .del:
        piece.backgroundColor = .red.opacity(0.18)
        piece.strikethroughStyle = .single
        piece.foregroundColor = .secondary
      }
      out += piece
    }
    return Text(out)
  }

  private func runs(_ v: PromptVersion) -> some View {
    Section(v.eval?.label ?? "Runs") {
      if v.runs.isEmpty { Text("No runs yet").foregroundStyle(.secondary) }
      ForEach(v.runs) { run in
        NavigationLink(value: PromptRoute.run(eval: run.eval, run: run.id)) {
          HStack {
            VStack(alignment: .leading, spacing: 3) {
              Text(Format.moment(run.runAt))
              Text(run.statusLabel)
                .font(.caption)
                .foregroundStyle(run.status == .failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
            Spacer()
            ScoreText(score: run.score)
          }
        }
      }
    }
  }

  private func load() async {
    do {
      current = try await model.api.promptVersion(name, version)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Activate or Run, then reload so the badge and the runs show the result.
  private func act(_ action: () async throws -> Void) async {
    busy = true
    defer { busy = false }
    do {
      try await action()
      actionError = nil
    } catch {
      actionError = error.localizedDescription
    }
    await load()
  }
}

/// One eval run: its score and every case, failures first.
struct EvalRunView: View {
  @Environment(AppModel.self) private var model
  let eval: String
  let run: String
  @State private var detail: EvalRunDetail?
  @State private var error: String?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.secondary) }
      if let r = detail?.run {
        Section {
          HStack(alignment: .firstTextBaseline) {
            ScoreText(score: r.score).font(.title2)
            Spacer()
            Text(r.statusLabel).monospacedDigit().foregroundStyle(.secondary)
          }
          LabeledContent("Version", value: r.version ?? "–")
          LabeledContent("Run", value: Format.moment(r.runAt))
          if let message = r.error { Text(message).font(.caption).foregroundStyle(.red) }
        }
      }
      if let cases = detail?.cases, !cases.isEmpty {
        Section("Cases") {
          ForEach(cases) { c in
            HStack(alignment: .top, spacing: 10) {
              Image(systemName: c.pass ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(c.pass ? .green : .red)
                .accessibilityLabel(c.pass ? "Pass" : "Fail")
              VStack(alignment: .leading, spacing: 3) {
                Text(c.expected).font(.subheadline.weight(.medium))
                Text(c.actual).font(.subheadline)
                if let note = c.note { Text(note).font(.caption).foregroundStyle(.secondary) }
              }
              Spacer()
              if let score = c.score { Text("\(score)").monospacedDigit().foregroundStyle(.secondary) }
            }
          }
        }
      }
    }
    .overlay { if detail == nil && error == nil { ProgressView() } }
    .navigationTitle("Run")
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .task(id: detail?.run.status.isPending) {
      while detail?.run.status.isPending == true && !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3))
        await load()
      }
    }
    .refreshable { await load() }
  }

  private func load() async {
    do {
      detail = try await model.api.evalRun(eval, run)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}
