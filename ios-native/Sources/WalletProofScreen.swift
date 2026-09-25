import SwiftUI
import MerrymenPolicy
import PrivySDK

/// Mirrors the web's copy-message/paste-signature flow. No external wallet
/// private key is imported. The backend recovers and verifies the signer.
struct WalletProofScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) var dismiss
    let linking: Bool
    @ObservedObject private var connection = ExternalWalletConnection.shared
    @State private var address = ""
    @State private var signature = ""
    @State private var challenge: J?
    @State private var challengeOwner: String?
    @State private var challengeAddress = ""
    @State private var linked: String?
    @State private var busy = false
    @State private var error: String?
    @State private var note: String?
    @State private var unlink = false
    var body: some View {
        Page {
            if linking && store.owner == nil { SignInCard() } else {
                Card {
                    Text(linking ? "Count tokens held in another wallet" : "Sign in with your wallet").font(.title.bold())
                    Text(linking ? "Prove ownership with a message signature. This wallet is read only; it does not become your agent's spending key." : "Use the wallet that already owns your Merrymen account. This message signs you in without moving funds.")
                    if let linked { Text("Linked: \(linked)").font(.caption.monospaced()); Button("Unlink holder wallet", role: .destructive) { unlink = true }.disabled(busy) }
                    if challenge == nil {
                        if connection.configured {
                            Button(connection.address == nil ? "Connect wallet app" : "Change wallet app") { connection.present() }.disabled(busy)
                            if let connected = connection.address {
                                Button("Use connected wallet") { address = connected }.disabled(busy)
                                Button("Disconnect wallet") { Task { await connection.disconnect() } }.disabled(busy)
                            }
                        }
                        TextField("Wallet address (0x…)", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button(linking ? "Prepare linking message" : "Prepare sign-in message") { Task { await start() } }.disabled(busy)
                    }
                }
                if let challenge {
                    Card {
                        Text("Sign this exact message in the wallet below, then paste its signature.")
                        Text(challengeAddress).font(.caption.monospaced()).textSelection(.enabled)
                        Text(challenge["message"].text).font(.caption.monospaced()).textSelection(.enabled)
                        Button("Copy message") { UIPasteboard.general.string = challenge["message"].text }
                        if connection.configured {
                            Button("Sign in wallet app") { Task { await signExternal() } }.disabled(busy || connection.address?.lowercased() != challengeAddress.lowercased())
                        }
                        if linking, challengeAddress.lowercased() == store.owner?.lowercased(), store.privy != nil {
                            Button("Sign with my embedded wallet") { Task { await signEmbedded() } }.disabled(busy)
                        }
                        TextField("Paste signature (0x…)", text: $signature, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                        Button(linking ? "Verify and link wallet" : "Verify and sign in") { Task { await submit() } }.buttonStyle(PrimaryButtonStyle()).disabled(busy || signature.isEmpty)
                        Button("Start again") { self.challenge = nil; signature = "" }.disabled(busy)
                    }
                }
                if busy { ProgressView("Checking ownership…") }
                if let error { Text(error).foregroundStyle(.orange) }
                if let note { Text(note) }
            }
        }.navigationTitle(linking ? "Holder wallet" : "Wallet sign-in")
        .task(id: store.generation) { challenge = nil; signature = ""; if linking { await readLinked() } }
        .onChange(of: connection.address) { _, value in if !busy { challenge = nil; signature = ""; if let value { address = value } } }
        .confirmationDialog("Stop using this wallet for your Circle tier?", isPresented: $unlink, titleVisibility: .visible) {
            Button("Unlink wallet", role: .destructive) { Task { await remove() } }
        }
    }
    private func start() async {
        guard !busy else { return }; busy = true; defer { busy = false }; error = nil; note = nil
        do {
            let value = address.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil else { throw APIError(status: 0, message: "Enter a full wallet address.") }
            let owner = store.owner
            if linking { try await store.verifyOwner(owner) }
            let response = try await store.api.request(linking ? "/api/holder?holder=\(escaped(value))" : "/api/auth/challenge")
            let expected = linking ? IdentityChallenge.holder(address: value, owner: owner ?? "", nonce: response["nonce"].text) : IdentityChallenge.signIn(nonce: response["nonce"].text)
            guard owner == store.owner, IdentityChallenge.valid(response, message: expected) else { throw APIError(status: 0, message: "The ownership challenge could not be verified. Start again.") }
            challengeOwner = owner; challengeAddress = value; challenge = response; signature = ""
        } catch { self.error = error.localizedDescription }
    }
    private func signEmbedded() async {
        guard !busy, linking, let challenge else { return }; busy = true; defer { busy = false }
        do {
            try await store.verifyOwner(challengeOwner)
            guard let user = await store.privy?.getUser(), let wallet = user.embeddedEthereumWallets.first(where: { $0.address.lowercased() == challengeAddress.lowercased() }) else { throw APIError(status: 0, message: "This is not the embedded wallet currently signed in.") }
            signature = try await wallet.provider.request(.personalSign(message: challenge["message"].text, address: wallet.address))
        } catch { self.error = error.localizedDescription }
    }
    private func signExternal() async {
        guard !busy, let challenge else { return }; busy = true; defer { busy = false }
        do {
            let generation = store.generation
            if linking { try await store.verifyOwner(challengeOwner) }
            let result = try await connection.sign(message: challenge["message"].text, address: challengeAddress)
            guard generation == store.generation, store.owner == challengeOwner else { throw APIError(status: 409, message: "Your account changed. Prepare a fresh message.") }
            signature = result
        } catch { self.challenge = nil; signature = ""; self.error = error.localizedDescription }
    }
    private func submit() async {
        guard !busy, let challenge else { return }; busy = true; defer { busy = false }; error = nil
        do {
            let signed = signature.trimmingCharacters(in: .whitespacesAndNewlines)
            guard signed.range(of: "^0x[0-9a-fA-F]{130}$", options: .regularExpression) != nil else { throw APIError(status: 0, message: "Paste the complete message signature from your wallet.") }
            guard let bootstrap = Bundle.main.url(forResource: "WalletRuntime", withExtension: "js"), let engine = Bundle.main.url(forResource: "WalletEngine", withExtension: "js") else { throw APIError(status: 0, message: "The signature verifier is missing from this build.") }
            let verifier = try WalletRuntime(bootstrap: String(contentsOf: bootstrap, encoding: .utf8), library: String(contentsOf: engine, encoding: .utf8))
            let proof = try await verifier.call("recoverIdentity", input: .object(["message": challenge["message"], "signature": .string(signed)]))
            guard proof["address"].text.lowercased() == challengeAddress.lowercased() else { throw APIError(status: 0, message: "That signature is from a different wallet.") }
            let body: J = .object(["holder": .string(challengeAddress), "nonce": challenge["nonce"], "signature": .string(signed)])
            if linking {
                _ = try await store.perform("/api/holder", body: body, expectedOwner: challengeOwner)
                self.challenge = nil; signature = ""; note = "Holder wallet linked. Your tier will use its verified balance."; await readLinked()
            } else {
                guard store.owner == challengeOwner else { throw APIError(status: 409, message: "Your account changed. Start again.") }
                let response = try await store.api.request("/api/auth/verify", method: "POST", body: body)
                await store.refreshSession()
                guard response["address"].text.lowercased() == challengeAddress.lowercased(), store.owner?.lowercased() == challengeAddress.lowercased() else {
                    try store.api.forget(); await store.refreshSession()
                    throw APIError(status: 401, message: "The signature did not match the wallet you selected.")
                }
                dismiss()
            }
        } catch { self.challenge = nil; signature = ""; self.error = error.localizedDescription + " Prepare a fresh message before trying again." }
    }
    private func readLinked() async {
        do { linked = try await store.perform("/api/holder", method: "PATCH", body: .object([:]), expectedOwner: store.owner)["linked"]["address"].string }
        catch { self.error = error.localizedDescription }
    }
    private func remove() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { _ = try await store.perform("/api/holder", method: "DELETE", body: .object([:]), expectedOwner: store.owner); linked = nil; challenge = nil; note = "Holder wallet unlinked. Your sign-in wallet is used for your tier." }
        catch { self.error = error.localizedDescription }
    }
}
