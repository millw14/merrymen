import SwiftUI
import UniformTypeIdentifiers

enum RecoveryBackup {
    static func read(_ data: Data) throws -> J {
        guard data.count <= 2_000_000 else { throw invalid() }
        let decoded = try JSONDecoder().decode(J.self, from: data)
        let grant = decoded["grant"] != .null ? decoded["grant"] : decoded
        guard address(grant["owner"].text), address(grant["smartAccount"].text), grant["chainId"].number == 4663 else { throw invalid() }
        let tokens = grant["grantTokens"].array
        guard tokens.count <= 1000, tokens.allSatisfy({ address($0.text) }) else { throw invalid() }
        // Only these known fields cross into the recovery form. No serialized
        // session, server URL, binding or executable content from the backup.
        return .object(["owner": grant["owner"], "smartAccount": grant["smartAccount"], "grantTokens": .array(tokens), "key": grant["demoOwnerPrivateKey"]])
    }
    static func address(_ text: String) -> Bool { text.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil && text.lowercased() != "0x" + String(repeating: "0", count: 40) }
    static func invalid() -> APIError { APIError(status: 0, message: "Choose a Merrymen grant backup for Robinhood Chain (4663) with a valid owner, account and token list.") }
}

struct RecoveryImportScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var wallet = WalletHost()
    @State private var key = ""
    @State private var extraTokens = ""
    @State private var backup: J?
    @State private var prepared: J?
    @State private var importFile = false
    @State private var error: String?
    let accept: (J, String) -> Void
    var body: some View {
        Page {
            Card {
                Text("Recover an older account").font(.title.bold())
                Text("Use the original owner recovery key or a saved Merrymen grant backup. This reads the account that key controls, including after an agent is stood down.")
                Text("The key stays on this device for this recovery session. It is never sent to Merrymen, copied to the clipboard or saved in chat.").font(.caption)
                SecureField("Owner recovery key (0x…)", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("recovery-key")
                Button("Import grant backup") { importFile = true }
                if let backup { Text("Backup account: \(backup["smartAccount"].text)").font(.caption.monospaced()).textSelection(.enabled) }
                TextField("Additional token addresses, separated by commas", text: $extraTokens, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("Include custom tokens from your old grant so recovery checks them too. Without a backup, only known standard tokens and the addresses entered here are checked.").font(.caption).foregroundStyle(.secondary)
                Button("Read recovery account") { Task { await inspect() } }.buttonStyle(PrimaryButtonStyle()).disabled(wallet.busy || key.isEmpty)
            }.disabled(wallet.busy)
            if let prepared {
                Card {
                    Text("Check this is your account").font(.headline)
                    Metric(label: "Owner", value: prepared["ownerAddress"].text)
                    Metric(label: "Account", value: prepared["smartAccount"].text)
                    Text("Robinhood Chain · 4663")
                    Rows(values: prepared["balances"].array) { row in Metric(label: row["symbol"].text, value: row["amount"].text) }
                    Text("Continue to choose the destination and review a separate withdrawal. Reading this account grants no trading permission.").font(.caption)
                    Button("Use this recovery account") { accept(prepared, key.trimmingCharacters(in: .whitespacesAndNewlines)); key = ""; dismiss() }.buttonStyle(PrimaryButtonStyle())
                }
            }
            if wallet.busy { ProgressView(wallet.status.isEmpty ? "Reading the chain…" : wallet.status) }
            if let error { Text(error).foregroundStyle(.orange) }
        }.navigationTitle("Recovery")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { key = ""; dismiss() }.disabled(wallet.busy) } }
        .interactiveDismissDisabled(wallet.busy)
        .onChange(of: key) { _, _ in prepared = nil }
        .onChange(of: extraTokens) { _, _ in prepared = nil }
        .onDisappear { key = ""; backup = nil }
        .fileImporter(isPresented: $importFile, allowedContentTypes: [.json], allowsMultipleSelection: false) { outcome in
            do {
                guard let url = try outcome.get().first else { return }
                let accessed = url.startAccessingSecurityScopedResource(); defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 2_000_000 else { throw RecoveryBackup.invalid() }
                let value = try RecoveryBackup.read(Data(contentsOf: url))
                backup = value; if let stored = value["key"].string { key = stored }
                prepared = nil; error = nil
            } catch { self.error = "The recovery backup could not be read. Check that it is a valid grant JSON file for Robinhood Chain." }
        }
    }
    private func inspect() async {
        error = nil; prepared = nil
        do {
            let secret = key.trimmingCharacters(in: .whitespacesAndNewlines)
            let owner = try WalletCryptography.call("address", .object(["key": .string(secret)]))
            if let backup, owner.lowercased() != backup["owner"].text.lowercased() { throw APIError(status: 0, message: "This key does not own the imported backup.") }
            let tokens = Set((backup?["grantTokens"].array.map(\.text) ?? []) + extraTokens.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init))
            guard tokens.count <= 1000, tokens.allSatisfy(RecoveryBackup.address) else { throw RecoveryBackup.invalid() }
            let input: J = .object(["recoveryOwner": .string(owner), "grantTokens": .array(tokens.sorted().map(J.string))])
            var plan = try await wallet.call("preview", input: input, store: store, legacyKey: secret).object
            if let backup, plan["smartAccount"]?.text.lowercased() != backup["smartAccount"].text.lowercased() { throw APIError(status: 0, message: "The key derives a different smart account. Recovery is blocked.") }
            plan["recoveryOwner"] = .string(owner); plan["grantTokens"] = input["grantTokens"]
            prepared = .object(plan)
        } catch { self.error = error.localizedDescription }
    }
}
