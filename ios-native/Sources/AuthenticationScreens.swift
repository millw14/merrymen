import SwiftUI
import PrivySDK
import AuthenticationServices

/// X is the primary way into Merrymen, matching the web sign-in order.
struct XSignInButton: View {
    @EnvironmentObject var store: AppStore
    var onSignedIn: () -> Void = {}
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { signIn() } label: {
                if busy { ProgressView().tint(.black) } else { Text("Continue with X") }
            }.buttonStyle(XButtonStyle()).disabled(busy || store.privy == nil)
            if store.privy == nil { Text("X sign-in turns on once this build has its Privy iOS client ID. You can still browse the public app.").font(.caption).foregroundStyle(.secondary) }
            if let error { Text(error).font(.caption).foregroundStyle(Brand.down) }
        }
    }
    private func signIn() {
        guard !busy, let privy = store.privy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                let user = try await privy.oAuth.login(with: .twitter, appUrlScheme: "merrymen")
                try await store.establishSession(user, provider: "twitter"); onSignedIn()
            } catch let failure as NSError where failure.domain == ASWebAuthenticationSessionError.errorDomain && failure.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                // Closing the X sheet is a choice, not a failure.
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct SignInCard: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        Card(hero: true) {
            Pill(text: "Merrymen")
            Text("Your agent. Your rules.").font(.custom(Brand.pixel, size: 30, relativeTo: .largeTitle)).fixedSize(horizontal: false, vertical: true)
            Text("Sign in to manage your agent, follow its decisions, and take part in the band.").foregroundStyle(.secondary)
            XSignInButton().padding(.top, 4)
            Button("Other ways to sign in") { store.path.append(.signIn) }.font(.subheadline).frame(maxWidth: .infinity)
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
    @State private var useEmail = false
    var body: some View {
        Page {
            VStack(alignment: .leading, spacing: 10) {
                Image("Brand").resizable().scaledToFit().frame(width: 64, height: 64).accessibilityHidden(true)
                Text("Welcome to the band.").font(.largeTitle.bold())
                Text("Use the same sign-in method as your Merrymen account.").foregroundStyle(.secondary)
            }.padding(.top, 12)
            XSignInButton { dismiss() }
            if store.privy != nil {
                DisclosureGroup("Use email instead", isExpanded: $useEmail) {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("Email", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(sentTo != nil)
                            .padding(14).background(Brand.raised, in: RoundedRectangle(cornerRadius: 12))
                        if let sentTo {
                            Text("Enter the code sent to \(sentTo)").font(.caption)
                            TextField("Verification code", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad)
                                .padding(14).background(Brand.raised, in: RoundedRectangle(cornerRadius: 12))
                            Button("Verify and sign in") { run {
                                guard let privy = store.privy else { return }
                                let user = try await privy.email.loginWithCode(code, sentTo: sentTo)
                                try await store.establishSession(user, provider: "email"); dismiss()
                            } }.buttonStyle(PrimaryButtonStyle(fill: true)).disabled(code.isEmpty)
                            Button("Use a different email") { self.sentTo = nil; code = "" }
                        } else {
                            Button("Send sign-in code") { run {
                                let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
                                try await store.privy?.email.sendCode(to: address); sentTo = address
                            } }.buttonStyle(SecondaryButtonStyle(fill: true)).disabled(!email.contains("@"))
                        }
                    }.padding(.top, 10)
                }.tint(.primary)
            }
            MenuRow(title: "Sign in with an existing external wallet", systemImage: "wallet.bifold", route: .walletSignIn)
            if busy { ProgressView("Signing in…") }
            if let error { Text(error).foregroundStyle(Brand.down) }
            Label("Signing in proves ownership. It does not authorize a trade or a new trading permission.", systemImage: "lock.shield").font(.caption).foregroundStyle(.secondary)
        }.disabled(busy).navigationTitle("Sign in")
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
}
