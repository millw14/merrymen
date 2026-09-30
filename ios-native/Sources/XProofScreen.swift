import SwiftUI
import UIKit

struct XProofScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var handle = ""
    @State private var tweet = ""
    @State private var challenge: J?
    @State private var owner: String?
    @State private var busy = false
    @State private var message: String?
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else {
                Card {
                    Text("Verify your X profile").font(.largeTitle.bold())
                    Text("Publish a short verification post from your public X account, then paste its link here. Protected posts cannot be checked.")
                    TextField("X handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(challenge != nil || busy)
                    if challenge == nil { Button("Get verification message") { Task { await begin() } }.disabled(busy) }
                    if let challenge {
                        Text(challenge["message"].text).textSelection(.enabled)
                        Button("Copy verification message") { UIPasteboard.general.string = challenge["message"].text }
                        if let url = URL(string: "https://x.com/intent/post?text=\(escaped(challenge["message"].text))") { Link("Open X to write your post", destination: url) }
                        TextField("Link to your published post", text: $tweet).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        Button("Verify published post") { Task { await verify(challenge) } }.buttonStyle(PrimaryButtonStyle()).disabled(busy || tweet.isEmpty)
                        Button("Start again") { self.challenge = nil; tweet = "" }.disabled(busy)
                    }
                    if busy { ProgressView("Checking…") }
                    if let message { Text(message).foregroundStyle(.secondary) }
                }
            }
        }.navigationTitle("X verification")
    }
    private func begin() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        let normalized = handle.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "")
        guard normalized.range(of: "^[A-Za-z0-9_]{1,15}$", options: .regularExpression) != nil else { message = "Use an X handle with letters, numbers or underscores, up to 15 characters."; return }
        do {
            owner = store.owner; try await store.verifyOwner(owner)
            challenge = try await store.api.request("/api/x-proof?handle=\(escaped(normalized))"); message = nil
        } catch { message = error.localizedDescription }
    }
    private func verify(_ challenge: J) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            _ = try await store.perform("/api/x-proof", body: .object(["handle": challenge["handle"], "nonce": challenge["nonce"], "tweet": .string(tweet)]), expectedOwner: owner)
            message = "Your X profile is verified."; self.challenge = nil; tweet = ""
        } catch { message = error.localizedDescription + " Start again to get a fresh verification code."; self.challenge = nil }
    }
}
