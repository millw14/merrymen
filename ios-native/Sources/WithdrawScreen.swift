import SwiftUI

struct WithdrawScreen: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var wallet = WalletHost()
    @State private var input: J?
    @State private var plan: J?
    @State private var result: J?
    @State private var error: String?
    @State private var recipient = ""
    @State private var selectedVault = ""
    @State private var reviewed: ReviewValue?
    @State private var records: [J] = []
    @State private var acknowledged = false
    @State private var unresolved = false
    @State private var trencherVault: String?
    @State private var legacyKey: String?
    @State private var importing = false
    @State private var restoring = false
    var body: some View {
        Page {
            Group {
                Card {
                    Text("Withdraw to your wallet").font(.largeTitle.bold())
                    Text("The owner wallet signs this transfer. Withdrawal gas is paid in ETH by the smart account, even when trading gas is sponsored.")
                    Text("Stand down the agent first if you want it to stop trading while you withdraw.").font(.caption).foregroundStyle(.secondary)
                    NavigationLink("Wallet & permissions", value: Route.permissions)
                    Button("Recover an older owner-key account") { importing = true }.disabled(wallet.busy || reviewed != nil)
                    if legacyKey != nil { Text("Using an imported owner key for this recovery session.").font(.caption) }
                    if legacyKey != nil, store.owner != nil { Button("Restore trading permissions") { restoring = true }.disabled(wallet.busy || unresolved) }
                    if let trencherVault {
                        Text("This account also has a Trencher vault. Its balances and positions are not included in this recovery plan. Withdrawing the smart account does not empty that vault.").foregroundStyle(.orange)
                        Text(trencherVault).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
                if input != nil {
                    Button("Read balances and recovery plan") { Task { await readPlan() } }.disabled(wallet.busy || (legacyKey == nil && store.privy == nil))
                    if legacyKey == nil && store.privy == nil { Text("This build needs its Privy iOS Client ID to open the owning wallet.").foregroundStyle(.orange) }
                }
                if let plan {
                    Card {
                        Text("Account balances").font(.title2.bold())
                        Text(plan["smartAccount"].text).font(.caption.monospaced()).textSelection(.enabled)
                        Rows(values: plan["balances"].array) { balance in Metric(label: balance["symbol"].text, value: balance["amount"].text) }
                        Metric(label: "ETH for gas", value: rawUnits(plan["gasWei"].string, decimals: 18))
                        Metric(label: "ETH reserved for gas", value: rawUnits(plan["nativeReserveWei"].string, decimals: 18))
                        if plan["needsGas"].bool == true { Text("Add ETH on Robinhood Chain before withdrawing.").foregroundStyle(.orange) }
                        if !plan["unreadable"].array.isEmpty { Text("Some balances could not be read: " + plan["unreadable"].array.map(\.text).joined(separator: ", ")).foregroundStyle(.orange) }
                        if plan["trencher"]["state"].text == "unread" { Text("The Trencher vault could not be read. Its balance is unknown and is not included in this withdrawal.").foregroundStyle(.orange) }
                        if plan["trencher"]["funded"].bool == true {
                            Divider(); Text("Separate Trencher vault").font(.headline)
                            Text(plan["trencher"]["vault"].text).font(.caption.monospaced()).textSelection(.enabled)
                            Rows(values: plan["trencher"]["balances"].array) { row in Metric(label: row["symbol"].text, value: row["amount"].text) }
                            Text("These assets remain in the Trencher vault. The current recovery service handles the account and Class vaults; it does not relay Trencher recovery.").foregroundStyle(.orange)
                        }
                        ForEach(Array(plan["classVaults"].array.enumerated()), id: \.offset) { _, vault in
                            Divider()
                            Text("Class vault \(vault["version"].text)").font(.headline)
                            Text(vault["vault"].text).font(.caption.monospaced())
                            Rows(values: vault["holdings"].array) { holding in Metric(label: holding["symbol"].text, value: holding["amount"].text) }
                            if let note = vault["note"].string { Text(note).font(.caption).foregroundStyle(.orange) }
                        }
                        if plan["classVaults"].array.filter({ !$0["holdings"].array.isEmpty }).count > 1 {
                            Picker("Class vault to recover with this withdrawal", selection: $selectedVault) {
                                ForEach(Array(plan["classVaults"].array.enumerated()), id: \.offset) { _, vault in
                                    if !vault["holdings"].array.isEmpty { Text("\(vault["version"].text) · \(vault["vault"].text.prefix(10))…").tag(vault["vault"].text) }
                                }
                            }
                            Text("Only the selected class vault is included. Other vaults require a separate recovery and enough ETH for its gas.").foregroundStyle(.orange)
                        }
                    }
                    if !unresolved {
                        Card {
                            TextField("Recipient address (0x…)", text: $recipient).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Toggle("I checked the recipient and Robinhood network", isOn: $acknowledged)
                            Button("Review withdrawal") { prepare() }.buttonStyle(PrimaryButtonStyle()).disabled(wallet.busy || !acknowledged || plan["needsGas"].bool == true || !plan["unreadable"].array.isEmpty)
                        }
                    }
                }
                if !records.isEmpty {
                    Card {
                        Text("Withdrawal records").font(.headline)
                        ForEach(Array(records.enumerated()), id: \.offset) { _, record in
                            Text(record["settled"].bool == true ? (record["receipt"]["success"].bool == true ? "Receipt confirmed" : "Transaction failed on-chain") : "Awaiting a confirmed receipt").font(.headline)
                            Text(record["hash"].text).font(.caption.monospaced()).textSelection(.enabled)
                            Text("To: \(record["to"].text)").font(.caption.monospaced())
                            if let hash = record["receipt"]["receipt"]["transactionHash"].string, let url = URL(string: "https://robinhoodchain.blockscout.com/tx/\(hash)") { Link("View transaction", destination: url) }
                        }
                        if unresolved { Text("Another withdrawal is blocked until this receipt is confirmed. Checking status never resubmits it.").foregroundStyle(.orange) }
                        Button("Check withdrawal receipts") { Task { await reconcile() } }.disabled(wallet.busy)
                    }
                }
                if let result {
                    Card {
                        Text(result["txHash"].string == nil ? "No account transfer was submitted" : "Withdrawal receipt received").font(.headline)
                        if let hash = result["txHash"].string { Text(hash).font(.caption.monospaced()).textSelection(.enabled) }
                        Rows(values: result["skipped"].array) { row in Text("\(row["symbol"].text): \(row["reason"].text)").foregroundStyle(.orange) }
                        Text("Refresh balances to see what remains. A skipped asset has not been withdrawn.").font(.caption)
                    }
                }
                if wallet.busy { ProgressView(wallet.status.isEmpty ? "Working with your wallet…" : wallet.status) }
                if let error { Text(error).foregroundStyle(.orange) }
            }
        }.navigationTitle("Withdraw").navigationBarBackButtonHidden(wallet.busy)
        .task { await load() }
        .onDisappear {
            if !wallet.busy, !importing, !restoring, reviewed == nil, legacyKey != nil {
                legacyKey = nil; input = nil; plan = nil; result = nil; records = []; acknowledged = false
            }
        }
        .sheet(isPresented: $importing) {
            NavigationStack { RecoveryImportScreen { recovered, key in
                legacyKey = key
                input = .object(["smartAccount": recovered["smartAccount"], "grantTokens": recovered["grantTokens"], "recoveryOwner": recovered["recoveryOwner"], "trencher": recovered["trencher"]])
                plan = recovered; result = nil; acknowledged = false; recipient = ""; trencherVault = nil
                selectedVault = recovered["classVaults"].array.first(where: { !$0["holdings"].array.isEmpty })?["vault"].text ?? ""
                do { try readRecords(recovered["recoveryOwner"].text); error = nil } catch { self.error = error.localizedDescription; unresolved = true }
            } }
        }
        .sheet(isPresented: $restoring) {
            if let input, let legacyKey { NavigationStack { GrantScreen(creating: false, recovery: input, recoveryKey: legacyKey) } }
        }
        .sheet(item: $reviewed) { selected in
            NavigationStack { Page {
                Text("Confirm withdrawal").font(.title.bold())
                let reviewed = selected.value
                    Metric(label: "From", value: reviewed["smartAccount"].text)
                    Metric(label: "Recipient", value: reviewed["to"].text)
                    Text("Robinhood Chain · 4663").font(.headline)
                    Text("This transfers recoverable tokens and ETH above the gas reserve. Amounts and gas are read again immediately before signing. Assets that cannot transfer are reported individually.")
                    if reviewed["approvedClass"] != .null { Text("Includes the reviewed class vault: \(reviewed["approvedClass"]["vault"].text)") }
                    Button("Sign withdrawal", role: .destructive) { Task { await withdraw(reviewed) } }.buttonStyle(PrimaryButtonStyle()).disabled(wallet.busy)
                    if wallet.busy { ProgressView("Waiting for the wallet and receipt…") }
                Button("Cancel", role: .cancel) { self.reviewed = nil }.disabled(wallet.busy)
            } }.interactiveDismissDisabled(wallet.busy)
        }
    }
    private func load() async {
        do {
            guard let owner = store.owner else { return }; try await store.verifyOwner(owner)
            let status = try await store.api.request("/api/grants")
            let local = try WalletHost.savedGrant(owner: owner)
            let grant = status["grant"] != .null ? status["grant"] : local ?? .null
            guard grant["owner"].text.lowercased() == owner.lowercased(), grant["chainId"].number == 4663, grant["binding"]["version"].text == "privy-did-owner-v1" else { return }
            input = .object(["smartAccount": grant["smartAccount"], "grantTokens": .array(grant["grantTokens"].array)])
            trencherVault = grant["trencherVaultAddress"].string
            try readRecords(owner)
        } catch { self.error = error.localizedDescription }
    }
    private func readRecords(_ owner: String) throws { records = try WalletHost.withdrawals(owner: owner); unresolved = records.contains { $0["settled"].bool != true } }
    private func readPlan() async {
        guard let input else { return }; error = nil
        do {
            plan = try await wallet.call("plan", input: input, store: store, legacyKey: legacyKey)
            selectedVault = plan?["classVaults"].array.first(where: { !$0["holdings"].array.isEmpty })?["vault"].text ?? ""
        } catch { self.error = error.localizedDescription }
    }
    private func prepare() {
        let to = recipient.trimmingCharacters(in: .whitespacesAndNewlines)
        guard to.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil, !to.lowercased().hasSuffix(String(repeating: "0", count: 40)), to.lowercased() != input?["smartAccount"].text.lowercased(), let input, let plan else { error = "Enter a valid recipient other than this smart account."; return }
        var fields = input.object; fields["to"] = .string(to)
        fields["reviewTenant"] = store.owner.map(J.string) ?? .null; fields["reviewGeneration"] = .number(Double(store.generation))
        if let vault = plan["classVaults"].array.first(where: { $0["vault"].text == selectedVault }), !vault["holdings"].array.isEmpty {
            fields["approvedClass"] = .object(["vault": vault["vault"], "tokens": .array(vault["holdings"].array.map { $0["token"] })])
        }
        reviewed = ReviewValue(value: .object(fields)); error = nil
    }
    private func withdraw(_ input: J) async {
        guard !wallet.busy else { return }
        do {
            guard input["reviewTenant"].string == store.owner, input["reviewGeneration"].number == Double(store.generation) else { throw APIError(status: 409, message: "Your account changed. Review the withdrawal again.") }
            result = try await wallet.call("withdraw", input: input, store: store, legacyKey: legacyKey); plan = nil
        }
        catch { self.error = "Withdrawal was not confirmed: \(error.localizedDescription) Check the recorded receipt before retrying." }
        if let owner = input["recoveryOwner"].string ?? store.owner { do { try readRecords(owner) } catch { self.error = error.localizedDescription; unresolved = true } }
        reviewed = nil
    }
    private func reconcile() async {
        guard let input else { return }; error = nil
        do { _ = try await wallet.call("reconcile", input: input, store: store, legacyKey: legacyKey); if let owner = input["recoveryOwner"].string ?? store.owner { try readRecords(owner) } }
        catch { self.error = error.localizedDescription }
    }
}
