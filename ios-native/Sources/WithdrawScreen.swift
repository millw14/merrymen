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
    @State private var confirming = false
    @State private var reviewed: J?
    @State private var records: [J] = []
    @State private var acknowledged = false
    @State private var unresolved = false
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else {
                Card {
                    Text("Withdraw to your wallet").font(.largeTitle.bold())
                    Text("The owner wallet signs this transfer. Withdrawal gas is paid in ETH by the smart account, even when trading gas is sponsored.")
                    Text("Stand down the agent first if you want it to stop trading while you withdraw.").font(.caption).foregroundStyle(.secondary)
                    NavigationLink("Wallet & permissions", value: Route.permissions)
                }
                if input != nil {
                    Button("Read balances and recovery plan") { Task { await readPlan() } }.disabled(wallet.busy || store.privy == nil)
                    if store.privy == nil { Text("This build needs its Privy iOS Client ID to open the owning wallet.").foregroundStyle(.orange) }
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
                            Button("Review withdrawal") { prepare() }.buttonStyle(.borderedProminent).disabled(wallet.busy || !acknowledged || plan["needsGas"].bool == true || !plan["unreadable"].array.isEmpty)
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
        .sheet(isPresented: $confirming) {
            NavigationStack { Page {
                Text("Confirm withdrawal").font(.title.bold())
                if let reviewed {
                    Metric(label: "From", value: reviewed["smartAccount"].text)
                    Metric(label: "Recipient", value: reviewed["to"].text)
                    Text("Robinhood Chain · 4663").font(.headline)
                    Text("This transfers recoverable tokens and ETH above the gas reserve. Amounts and gas are read again immediately before signing. Assets that cannot transfer are reported individually.")
                    if reviewed["approvedClass"] != .null { Text("Includes the reviewed class vault: \(reviewed["approvedClass"]["vault"].text)") }
                    Button("Sign withdrawal", role: .destructive) { Task { await withdraw(reviewed) } }.buttonStyle(.borderedProminent).disabled(wallet.busy)
                    if wallet.busy { ProgressView("Waiting for the wallet and receipt…") }
                }
                Button("Cancel", role: .cancel) { confirming = false }.disabled(wallet.busy)
            } }.interactiveDismissDisabled(wallet.busy)
        }
    }
    private func load() async {
        do {
            guard let owner = store.owner else { return }; try await store.verifyOwner(owner)
            let status = try await store.api.request("/api/grants")
            let local = try WalletHost.savedGrant(owner: owner)
            let grant = status["grant"] != .null ? status["grant"] : local ?? .null
            guard grant["owner"].text.lowercased() == owner.lowercased(), grant["chainId"].number == 4663, grant["binding"]["version"].text == "privy-did-owner-v1" else { throw APIError(status: 0, message: "No recoverable embedded-wallet grant was found. Legacy wallets need their original owner recovery flow.") }
            input = .object(["smartAccount": grant["smartAccount"], "grantTokens": .array(grant["grantTokens"].array)])
            try readRecords(owner)
        } catch { self.error = error.localizedDescription }
    }
    private func readRecords(_ owner: String) throws { records = try WalletHost.withdrawals(owner: owner); unresolved = records.contains { $0["settled"].bool != true } }
    private func readPlan() async {
        guard let input else { return }; error = nil
        do {
            plan = try await wallet.call("plan", input: input, store: store)
            selectedVault = plan?["classVaults"].array.first(where: { !$0["holdings"].array.isEmpty })?["vault"].text ?? ""
        } catch { self.error = error.localizedDescription }
    }
    private func prepare() {
        let to = recipient.trimmingCharacters(in: .whitespacesAndNewlines)
        guard to.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil, !to.lowercased().hasSuffix(String(repeating: "0", count: 40)), to.lowercased() != input?["smartAccount"].text.lowercased(), let input, let plan else { error = "Enter a valid recipient other than this smart account."; return }
        var fields = input.object; fields["to"] = .string(to)
        if let vault = plan["classVaults"].array.first(where: { $0["vault"].text == selectedVault }), !vault["holdings"].array.isEmpty {
            fields["approvedClass"] = .object(["vault": vault["vault"], "tokens": .array(vault["holdings"].array.map { $0["token"] })])
        }
        reviewed = .object(fields); confirming = true; error = nil
    }
    private func withdraw(_ input: J) async {
        guard !wallet.busy else { return }
        do { result = try await wallet.call("withdraw", input: input, store: store); plan = nil }
        catch { self.error = "Withdrawal was not confirmed: \(error.localizedDescription) Check the recorded receipt before retrying." }
        if let owner = store.owner { do { try readRecords(owner) } catch { self.error = error.localizedDescription; unresolved = true } }
        confirming = false
    }
    private func reconcile() async {
        guard let input else { return }; error = nil
        do { _ = try await wallet.call("reconcile", input: input, store: store); if let owner = store.owner { try readRecords(owner) } }
        catch { self.error = error.localizedDescription }
    }
}
