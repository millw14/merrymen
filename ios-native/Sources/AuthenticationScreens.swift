import SwiftUI
import PrivySDK

struct SignInCard: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        Card {
            Text("Your agent. Your rules.").font(.title2.bold())
            Text("Sign in to manage your agent, follow its decisions, and take part in the band.").foregroundStyle(.secondary)
            Button("Sign in") { store.path.append(.signIn) }.buttonStyle(.borderedProminent)
        }
    }
}

struct SignInScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) var dismiss
    @State private var email = ""
    @State private var code = ""
    @State private var sentTo: String?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Page {
            Text("Welcome to the band.").font(.largeTitle.bold())
            Text("Use the same sign-in method as your Merrymen account.").foregroundStyle(.secondary)
            if store.privy == nil {
                Label("Native sign-in is awaiting its Privy iOS client registration. You can still browse the public app.", systemImage: "info.circle")
            } else {
                Card {
                    TextField("Email", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(sentTo != nil)
                    if let sentTo {
                        Text("Enter the code sent to \(sentTo)").font(.caption)
                        TextField("Verification code", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad)
                        Button("Verify and sign in") { run {
                            guard let privy = store.privy else { return }
                            let user = try await privy.email.loginWithCode(code, sentTo: sentTo)
                            try await store.establishSession(user, provider: "email"); dismiss()
                        } }.disabled(code.isEmpty)
                        Button("Use a different email") { self.sentTo = nil; code = "" }
                    } else {
                        Button("Send sign-in code") { run {
                            let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
                            try await store.privy?.email.sendCode(to: address); sentTo = address
                        } }.disabled(!email.contains("@"))
                    }
                }
                Button("Continue with X") { run {
                    guard let privy = store.privy else { return }
                    let user = try await privy.oAuth.login(with: .twitter, appUrlScheme: "merrymen")
                    try await store.establishSession(user, provider: "twitter"); dismiss()
                } }.buttonStyle(.bordered)
            }
            if busy { ProgressView("Signing in…") }
            if let error { Text(error).foregroundStyle(Brand.down) }
            Text("Signing in proves ownership. It does not authorize a trade or a new trading permission.").font(.caption).foregroundStyle(.secondary)
        }.disabled(busy).navigationTitle("Sign in")
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
}

struct SiteAccessScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var password = ""
    @State private var busy = false
    var body: some View {
        Page { Card {
            Text("Site access").font(.title2.bold())
            Text("Only needed when the deployment asks for a beta password.")
            SecureField("Site password", text: $password)
            Button("Unlock") {
                guard !busy else { return }; busy = true
                Task { defer { busy = false }; do {
                    _ = try await store.api.bytes("/api/gate", method: "POST", data: Data("password=\(escaped(password))".utf8), contentType: "application/x-www-form-urlencoded")
                    password = ""; store.generation += 1; await store.refreshSession(); store.notice = "Site access unlocked."
                } catch { store.notice = error.localizedDescription } }
            }.disabled(busy || password.isEmpty)
        } }.navigationTitle("Site access")
    }
}
