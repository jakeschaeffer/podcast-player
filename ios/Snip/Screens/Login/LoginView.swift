import PodcastAPI
import SwiftUI

/// The first screen. A build that names no server (the App Store's) offers one button, Start, which keeps everything
/// on the phone (`AppModel.usePhone`); "My server" under it opens the fields below. A build that names a server
/// (the owner's) opens on those fields: the server's address and the owner password, whose token goes to the Keychain.
struct LoginView: View {
  @Environment(AppModel.self) private var model
  /// The server fields are showing, rather than the one Start button.
  @State private var withServer = false
  @State private var server = ""
  @State private var password = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      if withServer { serverForm } else { start }
    }
    .onAppear {
      if server.isEmpty, let suggested = model.suggestedServer {
        server = suggested
        withServer = true
      }
      #if DEBUG
        // `-firstScreen start|server`: either face of this screen, whatever the build names (design checks).
        if let face = UserDefaults.standard.string(forKey: "firstScreen") { withServer = face == "server" }
      #endif
    }
  }

  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var size = CGSize.zero
  /// The iPhone Duo open and held wide: the name on the left page and the buttons on the right, so that neither runs
  /// across the fold.
  private var spread: Bool { UnfoldedDisplay.isSpread(horizontal: horizontalSizeClass, vertical: verticalSizeClass, size: size) }

  /// One button, as large as the screen allows: nothing here needs reading.
  private var start: some View {
    HingeSplit(split: spread, gapFill: Color(.systemBackground), line: false) {
      VStack(spacing: 28) {
        Spacer()
        Image(systemName: "scissors").font(.system(size: 72, weight: .semibold)).foregroundStyle(.tint).accessibilityHidden(true)
        Text("Snip").font(.system(size: 56, weight: .bold))
        Spacer()
        if !spread { startButtons }
      }
      .padding(24)
    } trailing: {
      VStack(spacing: 28) { startButtons }.padding(24)
    }
    .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
  }

  @ViewBuilder private var startButtons: some View {
    Button {
      model.usePhone()
    } label: {
      Text("Start").font(.largeTitle.weight(.bold)).frame(maxWidth: .infinity, minHeight: 72)
    }
    .buttonStyle(.borderedProminent)
    .buttonBorderShape(.capsule)
    Button("My server") { withServer = true }
      .font(.title3.weight(.semibold))
      .frame(minHeight: 44)
  }

  private var serverForm: some View {
      Form {
        Section {
          TextField("Server address", text: $server)
            .textContentType(.URL)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          SecureField("Password", text: $password)
            .textContentType(.password)
            .onSubmit(signIn)
            .accessibilityHint("The owner password from the server's environment")
        }
        if let error {
          Section { Text(error).foregroundStyle(.red) }
        }
        Section {
          // A real button, not a row that reads like another field.
          Button(action: signIn) {
            Group {
              if busy { ProgressView() } else { Text("Sign in").font(.title3.weight(.bold)) }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.capsule)
          .disabled(busy || password.isEmpty || URL(string: server)?.host() == nil)
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
        }
      }
      .unfoldedReadableWidth()
      .navigationTitle("Snip")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("This phone") { model.usePhone() }.font(.body.weight(.semibold))
        }
      }
  }

  private func signIn() {
    guard let url = URL(string: server.trimmingCharacters(in: .whitespaces)) else { return }
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do {
        try await model.signIn(server: url, password: password)
      } catch let e as APIError where e.status == 401 {
        error = "Wrong password."
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}
