import PodcastAPI
import SwiftUI

/// Server address and owner password. The token the server returns goes to the Keychain.
struct LoginView: View {
  @Environment(AppModel.self) private var model
  @State private var server = ""
  @State private var password = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
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
        } footer: {
          Text("The owner password from the server's environment. This iPhone gets its own device token.")
        }
        if let error {
          Section { Text(error).foregroundStyle(.red) }
        }
        Section {
          Button(action: signIn) {
            if busy { ProgressView() } else { Text("Sign in") }
          }
          .disabled(busy || password.isEmpty || URL(string: server)?.host() == nil)
        }
      }
      .navigationTitle("Snip")
      .onAppear { if server.isEmpty, let suggested = model.suggestedServer { server = suggested } }
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
