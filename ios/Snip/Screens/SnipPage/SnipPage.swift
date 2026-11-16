import PlayerKit
import PodcastAPI
import SwiftUI

/// Where a snip's page is pushed from: a snip bar or a row in a list.
struct SnipRoute: Hashable, Identifiable {
  let id: ULID
  /// Open with the title being edited, as the Live Activity's title asks.
  var renaming = false
  /// Open adjusting the clip's ends (Adjust pressed on the page beside the snips list).
  var adjusting = false
}

/// One snip's own page, pushed from the player's snip bar and from the snip lists; swipe from the left edge to go
/// back. It is laid out for reading at arm's length: the title large, the summary, the owner's note, then the clip's
/// own words, and one row of actions at the bottom (Adjust, Play, Share). The title, the summary's points and the note
/// are each the owner's to write: a tap opens one where it stands, Save (or Return, for the title) keeps it, Cancel
/// puts it back, and a tap on another saves it and opens that one. They can be written at any step, before the
/// generated title and summary arrive, and what was typed is kept over them. The page's state is the app's
/// (AppModel.snipPage), so turning, folding or opening the device, which can build the page again, keeps the field
/// open with its draft and the keyboard. Adjust edits the clip on its words: the words around it dim, a tap moves the nearer end, and press
/// and hold chooses which. Turned sideways, the page becomes the clip's words alone, as large as they fit, lighting up
/// as it plays (SnipSideways).
struct SnipPage: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerEngine.self) private var engine
  @Environment(\.dismiss) private var dismiss
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.besideList) private var besideList
  @Environment(\.openAcrossPages) private var openAcrossPages
  @State private var model: SnipPageModel
  @State private var confirmingDelete = false
  /// The system's vertical bar stands at the page's trailing edge (the iPhone Duo closed, or open held wide).
  @State private var verticalBar = false
  /// Save was pressed on new In/Out points that change the length by more than 10 s: ask about the summary.
  @State private var askingToRewrite = false
  @ScaledMetric(relativeTo: .title) private var wordSize: CGFloat = 26
  /// The list that opened the page hears about each change to the snip, and about its deletion.
  let onChange: (Snip) -> Void
  let onDelete: () -> Void
  /// Start with the title being edited, or the clip's ends.
  let renaming: Bool
  let startAdjusting: Bool

  enum Mode { case reading, adjusting }
  typealias Field = SnipPageModel.Field

  private static let titleFont = Font.system(.largeTitle, design: .rounded, weight: .bold)
  /// The title in the editor, where the words to tap need the room.
  private static let compactTitleFont = Font.system(.title, design: .rounded, weight: .bold)
  /// The margins either side of the words. The vertical bar's inset already holds the words a little off its
  /// buttons, and beside the list the split already keeps the page clear of the fold, so on those sides a narrow
  /// margin gives the words the width.
  private var leadingMargin: CGFloat { besideList ? 8 : 24 }
  private var trailingMargin: CGFloat { verticalBar ? 4 : 24 }

  /// The app icon's dark, for marks on the accent colour.
  private static let ink = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)

  /// `model` comes from AppModel.snipPage, which hands a page built again the state its last one left.
  init(
    model: SnipPageModel, renaming: Bool = false, adjusting: Bool = false,
    onChange: @escaping (Snip) -> Void = { _ in }, onDelete: @escaping () -> Void = {}
  ) {
    _model = State(initialValue: model)
    self.renaming = renaming
    self.startAdjusting = adjusting
    self.onChange = onChange
    self.onDelete = onDelete
  }

  private var sideways: Bool {
    verticalSizeClass == .compact && mode == .reading && model.editingField == nil && !model.spanWords.isEmpty
  }
  private var typing: Bool { model.editingField != nil }
  /// Reading, or adjusting the span: the model's, so it outlasts the page.
  private var mode: Mode { model.adjusting ? .adjusting : .reading }

  var body: some View {
    Group {
      if let error = model.loadError, model.snip == nil {
        cantOpen(error)
      } else if model.snip == nil {
        ProgressView()
      } else if sideways {
        SnipSideways(words: model.spanWords, positionMs: model.previewMs, progress: progress) {
          model.togglePreview(pausing: engine)
        }
      } else if !besideList, UnfoldedDisplay.isUnfolded(horizontal: horizontalSizeClass, vertical: verticalSizeClass) {
        // The iPhone Duo open: held wide, two pages split at the fold; turned tall, the one column.
        GeometryReader { geo in
          // Wide or tall by the whole screen, insets included: the keyboard's inset would otherwise make the tall
          // screen "wide" while typing, swap the layout and take the field (and the keyboard) away.
          let insets = geo.safeAreaInsets
          if geo.size.width + insets.leading + insets.trailing > geo.size.height + insets.top + insets.bottom {
            if mode == .adjusting { adjustingSpread } else { readingSpread }
          } else if mode == .adjusting {
            adjusting
          } else {
            reading
          }
        }
      } else if mode == .adjusting {
        adjusting
      } else {
        reading
      }
    }
    .navigationBarTitleDisplayMode(besideList ? .large : .inline)
    // Leaving mid-edit would lose what was typed or moved: Cancel or Save first.
    .navigationBarBackButtonHidden(mode != .reading || typing)
    // Nor by swiping the player's sheet down (the iPhone or the Duo closed), which would close the page with it.
    .interactiveDismissDisabled(mode != .reading || typing)
    .toolbar(sideways ? .hidden : .visible, for: .navigationBar, .tabBar)
    .persistentSystemOverlays(sideways ? .hidden : .automatic)
    .background(VerticalBar(present: $verticalBar))
    .toolbar { toolbar }
    .task {
      // A page built again on a model already in use (the device folded or opened) carries on as it was.
      let first = !model.started
      model.started = true
      await model.load()
      model.follow()
      guard first else { return }
      if renaming { begin(.title) } else if startAdjusting { beginAdjusting() }
      #if DEBUG
        await debugLaunch()
      #endif
    }
    // Turned, folded or opened, the page is laid out anew and the field open loses the keyboard: give it back. (The
    // keyboard put away by hand, with a hardware one or the system's key, leaves the field open with Save and Cancel.)
    // By the width across the insets, which the keyboard coming and going doesn't change: one put away by hand stays away.
    .onGeometryChange(for: CGFloat.self) { $0.size.width + $0.safeAreaInsets.leading + $0.safeAreaInsets.trailing } action: { _ in
      model.refocus()
    }
    // Sent to the background mid-edit, where the app can be ended: what was typed is saved.
    .onChange(of: scenePhase) { _, phase in
      if phase == .background, typing { Task { await model.saveField() } }
    }
    .onChange(of: sideways, initial: true) { _, sideways in app.readingSideways = sideways }
    .onAppear { model.pageAppeared() }
    .onDisappear {
      model.pageDisappeared()
      if !model.showing { app.readingSideways = false }
    }
    .onChange(of: model.snip) { _, snip in if let snip { onChange(snip) } }
    .confirmationDialog("Rewrite the summary?", isPresented: $askingToRewrite, titleVisibility: .visible) {
      Button("Rewrite summary") { Task { await commit(regenerate: true) } }
      Button("Keep current summary") { Task { await commit(regenerate: false) } }
      Button("Cancel", role: .cancel) {}
    } message: {
      let change = model.lengthChangeMs
      let own = model.revision?.titleSource == "owner" || model.ownSummary
      Text(
        "The clip is now \(Format.duration(abs(change))) \(change > 0 ? "longer" : "shorter"). "
          + (own ? "What you wrote stays either way." : "Rewriting also writes a new title."))
    }
    .confirmationDialog("Delete this snip?", isPresented: $confirmingDelete, titleVisibility: .visible) {
      Button("Delete snip", role: .destructive) {
        Task {
          if await model.delete() {
            onDelete()
            dismiss()
          }
        }
      }
    } message: {
      Text("Its shared link stops working.")
    }
  }

  /// The snip couldn't be read (no connection, most often): Try again, large, and a quiet retry every few seconds, so
  /// the page comes back by itself once the server answers.
  private func cantOpen(_ error: String) -> some View {
    ContentUnavailableView {
      Label("Can't open this snip", systemImage: "exclamationmark.triangle").font(.title.weight(.bold))
    } description: {
      Text(error).font(.title3)
    } actions: {
      Button { Task { await retryLoad() } } label: {
        Text("Try again").font(.title2.weight(.semibold)).padding(.horizontal, 28).frame(minHeight: 60)
      }
      .buttonStyle(.borderedProminent)
      .buttonBorderShape(.capsule)
      .foregroundStyle(Self.ink)
    }
    .task(id: error) {
      while !Task.isCancelled, model.snip == nil {
        try? await Task.sleep(for: .seconds(5))
        if !Task.isCancelled { await retryLoad() }
      }
    }
  }

  private func retryLoad() async {
    await model.load()
    if model.snip != nil { model.follow() }
  }

  /// While a field is open its own Save and Cancel sit beside it, so the bar holds nothing (on the iPhone Duo closed or
  /// held wide the bar is the column down the trailing edge, and the fields keep clear of it).
  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    if !typing {
      if mode == .reading {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            if let url = shareURL {
              Button("Copy link", systemImage: "link") { UIPasteboard.general.url = url }
            }
            Button("Delete snip", systemImage: "trash", role: .destructive) { confirmingDelete = true }
          } label: {
            Image(systemName: "ellipsis")
          }
          .accessibilityLabel("More")
        }
      } else {
        // In the trailing column where the Duo has one (closed, or held wide), not over the words to tap.
        VerticalPreferred {
          // Marks rather than words, which the column's round buttons cut off.
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", systemImage: "xmark") { cancelAdjusting() }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save", systemImage: "checkmark") { Task { await commit() } }
              .buttonStyle(.borderedProminent)
              .tint(.accentColor)
              .disabled(model.saving)
          }
        }
      }
    }
  }

  // MARK: Reading

  private var reading: some View {
    page {
      VStack(alignment: .leading, spacing: 18) {
        about
        // What the owner wrote above, the clip's own words below.
        Divider().padding(.vertical, 6)
        clipWords
        from
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.leading, leadingMargin)
      .padding(.trailing, trailingMargin)
      .padding(.top, 8)
      .padding(.bottom, 32)
    }
    .safeAreaInset(edge: .bottom) {
      if mode == .reading, !typing { actions }
    }
  }

  /// The iPhone Duo open and held wide: what the snip is (its title, summary and note, each editable, and where it is
  /// from) on the left page, with its actions at the foot, and the clip's own words on the right, so neither runs
  /// across the fold.
  private var readingSpread: some View {
    HingeSplit {
      page {
        VStack(alignment: .leading, spacing: 18) {
          about
          from
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 24)
        .padding(.top, 8)
        .padding(.bottom, 24)
      }
      .safeAreaInset(edge: .bottom) {
        if mode == .reading, !typing { actions.padding(.trailing, -24) }
      }
    } trailing: {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          clipWords
          if model.revision?.status == .selecting || model.revision?.status == .waiting {
            // The right page would otherwise stand empty until the moment is chosen.
            Text("The clip’s words show here once the moment is chosen.").font(.title3).foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, trailingMargin)
        .padding(.top, 8)
        .padding(.bottom, 32)
      }
    }
  }

  /// A scrolling page that brings a field opened for typing to its top, heading and buttons first, with the keyboard
  /// below it, so the keyboard never covers the field being typed in.
  private func page<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    let content = content()
    return ScrollViewReader { proxy in
      ScrollView { content }
        .scrollDismissesKeyboard(.never)
        // On a field opening, and on a page made with one open (Adjust's words stepping aside, the device folded or
        // opened).
        .task(id: model.editingField) {
          guard let field = model.editingField else { return }
          // Once the keyboard is up and the page has its new height.
          try? await Task.sleep(for: .milliseconds(450))
          withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(field, anchor: .top) }
        }
        // And whenever the keyboard comes up late (after the device was folded or opened), so it never covers the field.
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
          guard let field = model.editingField else { return }
          withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(field, anchor: .top) }
        }
    }
  }

  /// The show and where the clip sits, the title, the playing video, the status, the quote, the summary and the note.
  @ViewBuilder private var about: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let show = model.snip?.showTitle { Text(show).lineLimit(2) }
      Text(at).monospacedDigit()
    }
    .font(.body.weight(.medium))
    .foregroundStyle(.secondary)
    field(.title)
    if model.previewing, model.previewHasVideo, let player = model.preview {
      PlayerLayerView(player: player)
        .aspectRatio(16 / 9, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .transition(.opacity)
    }
    if let status {
      Label(status.text, systemImage: status.icon).font(.title3).foregroundStyle(status.failed ? .red : .secondary)
    }
    if model.revision?.status == .ready, let quote = model.revision?.quote {
      Text("“\(quote)”").font(.system(.title2, design: .serif, weight: .semibold)).padding(.vertical, 4)
    }
    field(.summary)
    field(.note)
  }

  /// The clip's words, by speaker, once the moment is chosen.
  @ViewBuilder private var clipWords: some View {
    if model.revision?.status != .selecting {
      if let turns = model.turns {
        TurnsText(turns: turns)
      } else if let excerpt = model.revision?.excerpt {
        Text("“\(excerpt)”").font(.title2).foregroundStyle(.secondary)
      }
    }
  }

  @ViewBuilder private var from: some View {
    if let episode = model.snip?.episodeTitle {
      Text("From “\(episode)”").font(.body).foregroundStyle(.secondary)
    }
    if let error = model.saveError { Text(error).font(.body).foregroundStyle(.red) }
  }

  // MARK: The owner's texts

  /// One of the owner's texts: shown, with a tap to open it, or open for typing. In the editor (`compact`) it is a size
  /// smaller, so the words to tap keep their room.
  /// `brief`: the summary as one row, its name and how many points (the one-column Adjust, where the words need the
  /// room); a tap opens all of it.
  @ViewBuilder private func field(_ field: Field, compact: Bool = false, brief: Bool = false) -> some View {
    Group {
      // Beside the snips list a field is written on the page pushed across both pages, which shares this model: only
      // that page draws the box, or the two would take the keyboard from each other without end.
      if model.editingField == field, !besideList {
        editor(field, compact: compact)
      } else {
        shown(field, compact: compact, brief: brief)
      }
    }
    .id(field)
  }

  @ViewBuilder private func shown(_ field: Field, compact: Bool, brief: Bool) -> some View {
    switch field {
    case .title:
      Button { begin(.title) } label: {
        Group {
          if let title = model.revision?.title {
            Text(title).foregroundStyle(.primary)
          } else {
            // Nothing yet: the step it is at, and a mark that it can be written now.
            Text("\(titlePlaceholder)  \(Text(Image(systemName: "pencil")).foregroundStyle(Color.accentColor))")
              .foregroundStyle(.secondary)
          }
        }
        .font(compact ? Self.compactTitleFont : Self.titleFont)
        .lineLimit(compact ? 3 : nil)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHint(model.revision?.title == nil ? "Writes your own title" : "Renames the snip")
    case .summary:
      if brief, let summary = model.revision?.summary {
        let points = SnipPageModel.lines(summary).split(separator: "\n").count
        Button { begin(.summary) } label: {
          heading("\(model.ownSummary ? "Your summary" : "Summary") · \(points) \(points == 1 ? "point" : "points")", editable: true)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the summary to edit")
      } else if let summary = model.revision?.summary {
        Button { begin(.summary) } label: {
          VStack(alignment: .leading, spacing: 8) {
            heading(model.ownSummary ? "Your summary" : "Summary", editable: true)
            SummaryText(summary: summary, compact: compact)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Edits the summary")
      } else if summaryWriting {
        Button { begin(.summary) } label: {
          VStack(alignment: .leading, spacing: 8) {
            heading("Summary", editable: true)
            Text("Writing the summary…").font(compact ? .title3 : .title2).foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Writes your own summary")
      } else {
        add("Add a summary") { begin(.summary) }
      }
    case .note:
      if let note = model.snip?.note {
        Button { begin(.note) } label: {
          VStack(alignment: .leading, spacing: 8) {
            heading("Your note", editable: true)
            Text(note).font(compact ? .title3 : .title2).lineLimit(compact ? 3 : nil).multilineTextAlignment(.leading)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Edits the note")
      } else {
        add("Add a note") { begin(.note) }
      }
    }
  }

  /// A field open for typing: what it is with Cancel and Save on one row above it (or under its name, when they don't
  /// fit beside it), then the box, then a line saying how it saves, or why it didn't.
  private func editor(_ field: Field, compact: Bool) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 12) {
          heading(label(field), editable: false)
          Spacer(minLength: 4)
          editButtons
        }
        VStack(alignment: .leading, spacing: 10) {
          heading(label(field), editable: false)
          editButtons
        }
      }
      // The whole title starts selected the first time, as in the snip bar: typing replaces it, and a tap after that
      // places the cursor. The summary and the note open with the cursor at the end, to add to them. Return saves
      // the title and starts a new line in the others, on the on-screen keyboard and a hardware one alike.
      OwnerTextBox(
        text: $model.draft, selection: $model.draftSelection, face: face(field, compact: compact), singleLine: field == .title,
        locked: model.saving, focusRequest: model.focusRequest, accessibilityLabel: label(field)
      ) {
        Task { await model.saveField() }
      }
      .overlay(alignment: .topLeading) {
        if model.draft.isEmpty {
          Text(prompt(field)).font(font(field, compact: compact)).foregroundStyle(.tertiary).allowsHitTesting(false)
            .accessibilityHidden(true)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 16, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2)
      }
      if let error = model.fieldError {
        Text(error).font(.body.weight(.medium)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
      } else if let hint = hint(field) {
        Text(hint).font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      if field == .summary, model.ownSummary {
        // Back to the generated bullets only where there are some, or some to come; else it just takes yours away.
        Button(model.generatedSummaryAvailable ? "Use the generated summary instead" : "Remove your summary") {
          Task { await model.saveField(restoringGenerated: true) }
        }
        .font(.body.weight(.semibold))
        .disabled(model.saving)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var editButtons: some View {
    HStack(spacing: 10) {
      Button("Cancel") { model.cancelEditing() }
        .buttonStyle(.bordered)
      Button { Task { await model.saveField() } } label: {
        if model.saving { ProgressView().tint(Self.ink) } else { Text("Save") }
      }
      .buttonStyle(.borderedProminent)
      .foregroundStyle(Self.ink)
    }
    .font(.title3.weight(.semibold))
    .buttonBorderShape(.capsule)
    .controlSize(.large)
    .disabled(model.saving)
    .fixedSize()
  }

  /// A field's name above it, with a pencil where a tap opens it.
  private func heading(_ text: String, editable: Bool) -> some View {
    HStack(spacing: 8) {
      Text(text)
      if editable { Image(systemName: "pencil").foregroundStyle(Color.accentColor).accessibilityHidden(true) }
    }
    .font(.headline.weight(.bold))
    .textCase(.uppercase)
    .foregroundStyle(.secondary)
  }

  /// "Add a note", "Add a summary": a field with nothing in it, as a plain accent button.
  private func add(_ text: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(text, systemImage: "plus.circle.fill")
        .font(.title3.weight(.semibold))
        .frame(minHeight: 44)
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color.accentColor)
  }

  private func label(_ field: Field) -> String {
    switch field {
    case .title: "Title"
    case .summary: "Summary"
    case .note: "Note"
    }
  }

  private func prompt(_ field: Field) -> String {
    switch field {
    case .title: "Your title"
    case .summary: "One point a line"
    case .note: "Why you kept it"
    }
  }

  private func face(_ field: Field, compact: Bool) -> OwnerTextBox.Face {
    switch field {
    case .title: compact ? .compactTitle : .title
    case .summary, .note: compact ? .compactText : .text
    }
  }

  private func font(_ field: Field, compact: Bool) -> Font {
    switch field {
    case .title: compact ? Self.compactTitleFont : Self.titleFont
    case .summary, .note: compact ? .title3 : .title2
    }
  }

  /// How the field saves, and that what is typed is kept when the generated one is still on its way.
  private func hint(_ field: Field) -> String? {
    switch field {
    case .title:
      if waitingForTranscript {
        "A title is written once the transcript is in. Yours is kept instead. Return saves."
      } else if model.revision?.title == nil || (model.titleIsStandIn && model.revision?.summaryStatus == "pending") {
        "A title is still being written. Yours is kept instead. Return saves."
      } else {
        "Return saves."
      }
    case .summary:
      summaryWriting
        ? "A summary is still being written. Yours is kept instead. One point a line."
        : "One point a line: Return starts the next."
    case .note:
      // Near the most the server keeps, say how much room is left.
      model.draft.count > SnipPageModel.noteLimit - 500
        ? "\(min(model.draft.count, SnipPageModel.noteLimit)) of \(SnipPageModel.noteLimit) characters." : nil
    }
  }

  /// Nothing is being written yet: the recording has no transcript, and the title and summary wait on it.
  private var waitingForTranscript: Bool { model.revision?.status == .waiting }

  /// The summary is still to come: its job hasn't run and the snip hasn't failed, nor is it waiting for a transcript.
  private var summaryWriting: Bool {
    model.revision?.summary == nil && (model.revision?.summaryStatus ?? "pending") == "pending" && model.revision?.status != .failed
      && !waitingForTranscript
  }

  private var titlePlaceholder: String {
    model.revision?.status == .failed || waitingForTranscript ? "Add a title" : "Writing the title…"
  }

  /// Adjust, Play and Share, with Play in the middle of the screen whatever the others' widths.
  private var actions: some View {
    HStack(spacing: 0) {
      Button { beginAdjusting() } label: {
        Image(systemName: "slider.horizontal.3")
          .font(.title3.weight(.semibold))
          .frame(width: 56, height: 56)
          .background(Color(.systemGray5), in: .circle)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Adjust the clip")
      .disabled(!model.boundariesEditable)
      .opacity(model.boundariesEditable ? 1 : 0.4)
      .frame(maxWidth: .infinity, alignment: .leading)
      playButton
      Group {
        if let url = shareURL {
          ShareLink(item: url) {
            Image(systemName: "square.and.arrow.up")
              .font(.title3.weight(.semibold))
              .frame(width: 56, height: 56)
              .background(Color(.systemGray5), in: .circle)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Share")
        }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(.leading, leadingMargin)
    .padding(.trailing, trailingMargin)
    .padding(.top, 14)
    .padding(.bottom, 6)
    // Solid behind the buttons with a clear edge above them: the words end there rather than fading half drawn.
    .background {
      Color(.systemBackground)
        .overlay(alignment: .top) { Divider() }
        .ignoresSafeArea()
    }
  }

  private var playButton: some View {
    Button { model.togglePreview(pausing: engine) } label: {
      Image(systemName: model.previewing ? "pause.fill" : model.previewHasVideo ? "play.rectangle.fill" : "play.fill")
        .font(.system(size: 32, weight: .bold))
        .offset(x: model.previewing ? 0 : 2)
        .foregroundStyle(Self.ink)
        .frame(width: 80, height: 80)
        .background(Color.accentColor, in: .circle)
        .overlay {
          if model.previewing {
            Circle()
              .trim(from: 0, to: progress)
              .stroke(Color.primary, style: StrokeStyle(lineWidth: 4, lineCap: .round))
              .rotationEffect(.degrees(-90))
              .padding(-7)
          }
        }
    }
    .buttonStyle(.plain)
    .disabled(model.episode?.asset == nil)
    .accessibilityLabel(model.previewing ? "Pause" : "Play the snip")
  }

  // MARK: Adjusting

  /// One column: the clip's times, its title and note, the words to tap, and Play at the foot. With a field open the
  /// words step aside, so the field and the keyboard have the screen.
  @ViewBuilder private var adjusting: some View {
    if typing {
      page {
        VStack(alignment: .leading, spacing: 16) {
          adjustRange
          field(.title, compact: true)
          field(.summary, compact: true)
          field(.note, compact: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 24)
        .padding(.trailing, trailingMargin)
        .padding(.top, 8)
        .padding(.bottom, 24)
      }
    } else {
      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 10) {
          adjustRange
          field(.title, compact: true)
          field(.summary, compact: true, brief: true)
          field(.note, compact: true)
        }
        // At their own height: the words below take what is left, rather than squeezing the title to a line.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 24)
        .padding(.trailing, trailingMargin)
        .padding(.bottom, 12)
        Divider().padding(.leading, 24).padding(.trailing, trailingMargin)
        adjustWords
      }
      .safeAreaInset(edge: .bottom) {
        adjustPlay
          .frame(maxWidth: .infinity)
          .padding(.horizontal, 24)
          .padding(.top, 14)
          .padding(.bottom, 6)
          .background(Color(.systemBackground).ignoresSafeArea())
      }
    }
  }

  /// The iPhone Duo open and held wide: the clip's times, its title and note (each editable), how to move its ends
  /// and Play on the left page, the words to tap on the right, so the words never run across the fold.
  private var adjustingSpread: some View {
    HingeSplit {
      page {
        VStack(alignment: .leading, spacing: 16) {
          adjustRange
          field(.title, compact: true)
          field(.summary, compact: true)
          field(.note, compact: true)
          if !typing {
            Text("Tap a word to move the nearer end. Press and hold a word to choose which end.")
              .font(.body)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 24)
        .padding(.top, 8)
        .padding(.bottom, 12)
      }
      .safeAreaInset(edge: .bottom) {
        if !typing {
          adjustPlay
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 24)
            .padding(.top, 12)
            .padding(.bottom, 12)
            .background(Color(.systemBackground).ignoresSafeArea())
        }
      }
    } trailing: {
      adjustWords.padding(.leading, -24)
    }
  }

  /// The clip's start and end, and its length (and what it was, once changed).
  private var adjustRange: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("\(Format.clock(model.span.startMs)) – \(Format.clock(model.span.endMs))")
        .font(.system(.title, design: .rounded, weight: .bold))
        .monospacedDigit()
      Text(lengthLine).font(.body).foregroundStyle(.secondary)
    }
  }

  /// The save error, if any, and Play this clip.
  private var adjustPlay: some View {
    VStack(spacing: 14) {
      if let error = model.saveError { Text(error).font(.body).foregroundStyle(.red) }
      Button { model.togglePreview(pausing: engine) } label: {
        Label(model.previewing ? "Stop" : "Play this clip", systemImage: model.previewing ? "stop.fill" : "play.fill")
          .font(.title3.weight(.semibold))
          .padding(.horizontal, 24)
          .frame(minHeight: 52)
          .background(Color.accentColor.opacity(0.28), in: .capsule)
      }
      .buttonStyle(.plain)
    }
  }

  /// The words around the clip, the clip's own tinted, for moving its ends.
  private var adjustWords: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 22) {
          if model.moreEarlier {
            Button("Show earlier") { model.showEarlier() }.font(.body.weight(.semibold)).frame(maxWidth: .infinity)
          }
          let ends = spanEnds
          ForEach(model.segmentsInWindow, id: \.w0) { segment in
            FlowLayout(spacing: 7, lineSpacing: 4) {
              ForEach(Array(segment.words.enumerated()), id: \.offset) { i, word in
                if segment.w0 + i == ends?.first { SpanHandle(atTop: true) }
                Text(word.text)
                  .font(.system(size: wordSize, weight: .semibold, design: .rounded))
                  .foregroundStyle(model.inSpan(word) ? Color.primary : Color(.tertiaryLabel))
                  // The tint overlaps across the gap each side, so the clip's words read as one band; opaque, so
                  // the overlaps don't show.
                  .background {
                    if model.inSpan(word) {
                      Color(.systemBackground).overlay(Color.accentColor.opacity(0.28)).padding(.horizontal, -4).padding(.vertical, -2.5)
                    }
                  }
                  .contentShape(.rect)
                  .onTapGesture { model.tap(word) }
                  // Press and hold to say which end, when the nearer one isn't it.
                  .contextMenu {
                    Button("Start here", systemImage: "arrow.right.to.line") { model.set(.in, at: word) }
                    Button("End here", systemImage: "arrow.left.to.line") { model.set(.out, at: word) }
                  }
                if segment.w0 + i == ends?.last { SpanHandle(atTop: false) }
              }
            }
            .id(segment.w0)
          }
          if model.moreLater {
            Button("Show later") { model.showLater() }.font(.body.weight(.semibold)).frame(maxWidth: .infinity)
          }
        }
        .padding(.leading, 24)
        .padding(.trailing, trailingMargin)
        .padding(.vertical, 16)
      }
      .onAppear {
        // Open with the clip's first paragraph just below the top, so its start shows with a little context above.
        let segments = model.segmentsInWindow
        if let first = segments.firstIndex(where: { $0.e >= model.span.startMs }) {
          proxy.scrollTo(segments[first].w0, anchor: UnitPoint(x: 0, y: 0.12))
        }
      }
    }
  }

  /// The global indices of the first and last words in the span, where its handles go.
  private var spanEnds: (first: Int, last: Int)? {
    var first: Int?
    var last: Int?
    for segment in model.segmentsInWindow where segment.e >= model.span.startMs && segment.s <= model.span.endMs {
      for (i, word) in segment.words.enumerated() where model.inSpan(word) {
        if first == nil { first = segment.w0 + i }
        last = segment.w0 + i
      }
    }
    guard let first, let last else { return nil }
    return (first, last)
  }

  private var lengthLine: String {
    let now = Format.duration(model.span.endMs - model.span.startMs)
    guard model.boundariesChanged, let rev = model.revision else { return now }
    return "\(now) · was \(Format.duration(rev.endMs - rev.startMs))"
  }

  // MARK: Editing

  /// Opens a field; one open already is saved first (SnipPageModel.beginEditing). Beside the snips list the page is
  /// narrow, so the field is then written across both pages instead: the page pushed there shares this model
  /// (AppModel.snipPage), so it opens with the field and its draft as they are.
  private func begin(_ field: Field) {
    guard model.snip != nil else { return }
    model.stopPreview()
    Task {
      await model.beginEditing(field)
      if besideList, model.editingField == field, let openAcrossPages { openAcrossPages(SnipRoute(id: model.snipID)) }
    }
  }

  private func beginAdjusting() {
    model.stopPreview()
    model.cancelEditing()
    model.adjusting = true
    if besideList, let openAcrossPages { openAcrossPages(SnipRoute(id: model.snipID)) }
  }

  private func cancelAdjusting() {
    model.stopPreview()
    model.revert()
  }

  private func commit(regenerate: Bool? = nil) async {
    if regenerate == nil, model.savingAsks {
      askingToRewrite = true
      return
    }
    // Saved, the model leaves adjusting, and the page reads again.
    _ = await model.save(regenerate: regenerate ?? false)
  }

  #if DEBUG
    /// Scripted simulator checks: `-snipMode adjust|play` opens the page in that state (`title` opens the title);
    /// `-editSnipField title|summary|note` opens that field for typing (several, comma-separated, one after another),
    /// `-typeText <text>` puts text in it as if typed (`\n` starts a new line; with several fields, one text each,
    /// separated by `|`), and `-saveFieldAfter <s>` presses its Save that many seconds later.
    private func debugLaunch() async {
      let defaults = UserDefaults.standard
      // With `-openSnip`, only that snip's page (beside the list, the newest's page can come first).
      if let only = defaults.string(forKey: "openSnip"), only != model.snipID { return }
      switch defaults.string(forKey: "snipMode") {
      case "title": begin(.title)
      case "adjust": beginAdjusting()
      case "play": model.togglePreview(pausing: engine)
      default: break
      }
      let fields = (defaults.string(forKey: "editSnipField") ?? "").split(separator: ",").compactMap { Field(rawValue: String($0)) }
      let texts = defaults.string(forKey: "typeText").map { $0.components(separatedBy: "|") } ?? []
      let saveAfter = defaults.double(forKey: "saveFieldAfter")
      for (i, field) in fields.enumerated() {
        model.stopPreview()
        await model.beginEditing(field)
        try? await Task.sleep(for: .milliseconds(700))
        if i < texts.count { model.draft = texts[i].replacingOccurrences(of: "\\n", with: "\n") }
        guard saveAfter > 0 else { break }
        try? await Task.sleep(for: .seconds(saveAfter))
        await model.saveField()
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
  #endif

  // MARK: Labels

  private var progress: Double {
    guard let ms = model.previewMs else { return 0 }
    let length = Double(max(model.span.endMs - model.span.startMs, 1))
    return min(max(Double(ms - model.span.startMs) / length, 0), 1)
  }

  private var shareURL: URL? { model.snip.flatMap { URL(string: $0.shareUrl) } }

  /// Where the clip sits in the episode and how long it is (or where the tap was, until the moment is chosen).
  private var at: String {
    guard let snip = model.snip else { return "" }
    guard let rev = snip.revision, rev.status != .waiting, rev.status != .selecting else {
      return "Snipped at \(Format.clock(snip.anchorMs))"
    }
    return "\(Format.clock(rev.startMs)) – \(Format.clock(rev.endMs)) · \(Format.duration(rev.endMs - rev.startMs))"
  }

  private var status: (text: String, icon: String, failed: Bool)? {
    switch model.revision?.status {
    case .ready: nil
    case .failed: ("Snip failed", "exclamationmark.triangle", true)
    case .waiting: ("Waiting for the transcript", "clock", false)
    case .selecting, nil: ("Choosing the moment…", "clock", false)
    default: ("Preparing the clip…", "clock", false)
    }
  }
}

/// Toolbar items that go in the system's vertical bar where there is one (the iPhone Duo closed, or open and held wide,
/// from iOS 27.1), instead of over the page.
private struct VerticalPreferred<Content: ToolbarContent>: ToolbarContent {
  @ToolbarContentBuilder let content: Content

  var body: some ToolbarContent {
    if #available(iOS 27.1, *) {
      content.axisBehavior(.verticalPreferred)
    } else {
      content
    }
  }
}

/// A snip's summary at reading size: since snip-summary v3 its lines are bullets, each with its own dot and a hanging
/// indent; an older one-paragraph summary reads as a paragraph. In the editor (`compact`) it is a size smaller and
/// shows its first points, two lines each, so the words to tap keep their room; a tap opens all of it.
private struct SummaryText: View {
  let summary: String
  var compact = false
  @ScaledMetric(relativeTo: .title2) private var dot: CGFloat = 7
  private static let compactPoints = 3

  var body: some View {
    let lines = summary.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let font: Font = compact ? .title3 : .title2
    if lines.count < 2 {
      Text(summary).font(font).lineLimit(compact ? 3 : nil)
    } else {
      let shown = compact ? Array(lines.prefix(Self.compactPoints)) : lines
      VStack(alignment: .leading, spacing: compact ? 8 : 12) {
        ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Circle().fill(Color.accentColor).frame(width: dot, height: dot).alignmentGuide(.firstTextBaseline) { $0[.bottom] + dot * 0.5 }
            Text(line).font(font).lineLimit(compact ? 2 : nil).frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        if lines.count > shown.count {
          Text("\(lines.count - shown.count) more").font(.body.weight(.semibold)).foregroundStyle(.secondary)
        }
      }
      .accessibilityElement(children: .combine)
    }
  }
}

/// The clip's words split by voice, when there is more than one: each turn under its speaker's name (or Host, Guest,
/// Speaker 2; none for an article's own prose), the names alternating colour so a change of voice reads at a glance.
private struct TurnsText: View {
  let turns: [SnipPageModel.Turn]

  var body: some View {
    let order = turns.map(\.name).reduce(into: [String?]()) { if !$0.contains($1) { $0.append($1) } }
    VStack(alignment: .leading, spacing: 16) {
      ForEach(turns) { turn in
        let n = order.firstIndex(of: turn.name) ?? 0
        VStack(alignment: .leading, spacing: 4) {
          if let name = turn.name {
            Text(name)
              .font(.subheadline.weight(.bold))
              .textCase(.uppercase)
              .foregroundStyle(n.isMultiple(of: 2) ? Color.secondary : Color.accentColor)
          }
          Text(turn.text).font(.title2).foregroundStyle(.secondary)
        }
      }
    }
  }
}

/// An end of the span among the words: an accent bar with a knob above (the start) or below (the end).
private struct SpanHandle: View {
  let atTop: Bool
  @ScaledMetric(relativeTo: .title) private var height: CGFloat = 32

  var body: some View {
    Capsule()
      .fill(Color.accentColor)
      .frame(width: 4, height: height)
      .overlay(alignment: atTop ? .top : .bottom) {
        Circle().fill(Color.accentColor).frame(width: 16, height: 16).offset(y: atTop ? -10 : 10)
      }
      .accessibilityHidden(true)
  }
}

/// The snip turned sideways: only the clip's words, as large as they fit (KaraokeHalves), lighting up as the clip
/// plays. A tap plays or pauses.
struct SnipSideways: View {
  let words: [Word]
  let positionMs: Int?
  let progress: Double
  let toggle: () -> Void

  var body: some View {
    KaraokeHalves(pieces: KaraokePieces.split(words), positionMs: positionMs)
      .padding(.horizontal, 24)
      .padding(.vertical, 12)
      .background(Color.black.ignoresSafeArea())
      .overlay(alignment: .bottomTrailing) {
        if positionMs == nil {
          Image(systemName: "play.fill")
            .font(.system(size: 26, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 64, height: 64)
            .background(.white.opacity(0.16), in: .circle)
            .padding(.trailing, 8)
            .padding(.bottom, 8)
        }
      }
      .overlay(alignment: .bottom) {
        if positionMs != nil { KaraokeProgress(progress: progress).padding(.horizontal, 24) }
      }
      .contentShape(.rect)
      .onTapGesture(perform: toggle)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(words.map(\.text).joined(separator: " "))
      .accessibilityAddTraits(.isButton)
      .accessibilityHint(positionMs == nil ? "Plays the snip" : "Pauses the snip")
  }
}

/// Lays children out left to right, wrapping to a new line when the row is full, like words in a paragraph.
struct FlowLayout: Layout {
  var spacing: CGFloat = 4
  var lineSpacing: CGFloat = 4

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
    let height = rows.last.map { $0.y + $0.height } ?? 0
    let width = rows.map(\.width).max() ?? 0
    return CGSize(width: proposal.width ?? width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for row in arrange(width: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for index in row.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
    }
  }

  private struct Row {
    var indices: [Int] = []
    var y: CGFloat = 0
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
    var rows: [Row] = [Row()]
    for (index, subview) in subviews.enumerated() {
      let size = subview.sizeThatFits(.unspecified)
      if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
        let last = rows[rows.count - 1]
        rows.append(Row(y: last.y + last.height + lineSpacing))
      }
      var row = rows[rows.count - 1]
      row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
      row.height = max(row.height, size.height)
      row.indices.append(index)
      rows[rows.count - 1] = row
    }
    return rows
  }
}
