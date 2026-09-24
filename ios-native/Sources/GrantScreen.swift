import SwiftUI
import MerrymenPolicy
import PrivySDK

struct GrantScreen: View {
    @EnvironmentObject var store: AppStore
    let creating: Bool
    @StateObject private var wallet = WalletHost()
    @State private var settings: J?
    @State private var grant: J?
    @State private var owner: String?
    @State private var name = ""
    @State private var strategy = "steady-basket"
    @State private var mode = "all"
    @State private var basket = Set<String>()
    @State private var paper = true
    @State private var trencher = false
    @State private var caps = ["perTradeUsdg": "10", "dailyUsdg": "50", "expiryDays": "7", "maxDrawdownPct": "5", "maxOpsPerDay": "24"]
    @State private var error: String?
    @State private var result: J?
    @State private var review: J?
    @State private var changes: J?
    @State private var confirming = false
    @State private var loading = true
    @State private var submitting = false
    private let fields = [("perTradeUsdg", "USDG per trade"), ("dailyUsdg", "USDG per day"), ("expiryDays", "Permission lifetime in days"), ("maxDrawdownPct", "Maximum drawdown %"), ("maxOpsPerDay", "Operations per day")]
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() }
            else if loading { ProgressView("Reading your account…") }
            else if let settings {
                if result == nil {
                    if creating {
                        Card {
                            Text("Meet your next agent.").font(.largeTitle.bold())
                            TextField("Agent name", text: $name)
                            Picker("Strategy", selection: $strategy) {
                                Text("Steady basket").tag("steady-basket"); Text("Even keel · holders").tag("even-keel")
                                Text("Dip hunter · holders").tag("dip-hunter"); Text("AI strategist").tag("llm-strategist")
                            }
                            if ["even-keel", "dip-hunter"].contains(strategy) {
                                Remote(path: "/api/tier") { tier in
                                    Text(tier["bonusStrategies"].bool == true ? "Your current tier includes this strategy." : "This strategy stays idle until your wallet meets its Merry Circle tier. Choose Steady basket or AI strategist to start without it.").foregroundStyle(.orange)
                                }
                            }
                            Toggle("Practice with paper trades", isOn: $paper)
                            Text(paper ? "Fills are simulated. You can enable live trading later." : "Live trading uses real funds within the permission you sign.").font(.caption)
                        }
                        Card {
                            Text("What should it trade?").font(.headline)
                            Picker("Markets", selection: $mode) { Text("All").tag("all"); Text("Stocks").tag("stocks"); Text("Crypto").tag("crypto") }
                            ForEach(Array(Set(settings["knownSymbols"].array.compactMap(\.string))).sorted(), id: \.self) { symbol in
                                Toggle(symbol, isOn: Binding(get: { basket.contains(symbol) }, set: { if $0 { basket.insert(symbol) } else { basket.remove(symbol) } }))
                            }
                            NavigationLink("Add custom coins in settings", value: Route.settings)
                            Text("Save custom coins in Settings, then return here and reload before reviewing the permission.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Card {
                        Text("Bound the permission").font(.title2.bold())
                        ForEach(fields, id: \.0) { key, title in
                            VStack(alignment: .leading) { Text(title).font(.caption); TextField(title, text: Binding(get: { caps[key] ?? "" }, set: { caps[key] = $0 })).keyboardType(.decimalPad) }
                        }
                        Toggle("Autonomous Trencher vault", isOn: $trencher).disabled(grant?["trencherVaultAddress"].string != nil)
                        Text("This separate permission allows the agent to trade pool tokens in its verified Trencher vault. Daily spending remains capped by the vault on-chain.").font(.caption).foregroundStyle(.secondary)
                        if grant?["trencherVaultAddress"].string != nil { Text("This renewal retains your existing Trencher custody permission.").font(.caption) }
                        Text("Network: Robinhood Chain (4663)").font(.caption)
                        if let address = grant?["smartAccount"].string { Text(address).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                    Button("Review permission") { Task { await prepareReview() } }.buttonStyle(.borderedProminent).disabled(wallet.busy)
                    Button("Reload account and saved settings") { Task { await load() } }.disabled(wallet.busy)
                }
                if wallet.busy { ProgressView(wallet.status.isEmpty ? "Preparing permission…" : wallet.status) }
                if let result {
                    Card {
                        Text(result["handoff"]["ok"].bool == true ? "Permission accepted" : "Permission saved on this device").font(.title2.bold())
                        Text(result["smartAccount"].text).font(.caption.monospaced()).textSelection(.enabled)
                        Text("Your owner key stays in your embedded wallet. The trading permission is stored in this device's Keychain.")
                        if result["handoff"]["ok"].bool != true {
                            Text(result["handoff"]["error"].string ?? "The service did not confirm activation.").foregroundStyle(.orange)
                            Button("Check activation / retry saved grant") { Task { await retrySaved() } }.disabled(wallet.busy)
                        } else { NavigationLink("Open wallet", value: Route.permissions); NavigationLink("Add funds", value: Route.deposit) }
                    }
                }
            }
            if let error { Text(error).foregroundStyle(.orange); if settings == nil { Button("Retry") { Task { await load() } } } }
        }.navigationTitle(creating ? "Create agent" : "Trading limits")
        .navigationBarBackButtonHidden(wallet.busy)
        .task { await load() }
        .sheet(isPresented: $confirming) {
            NavigationStack { Page {
                Text("Sign this permission?").font(.title.bold())
                if let review {
                    ForEach(fields, id: \.0) { key, label in Metric(label: label, value: review["caps"][key].text) }
                    Metric(label: "Account", value: review["expectAccount"].string ?? "Derived from your embedded wallet")
                    Metric(label: "Custom tokens covered", value: String(review["extraTokens"].array.count))
                    Metric(label: "Trencher vault", value: review["autonomousTrencher"].bool == true ? "Enabled" : "Disabled")
                    Text("You authorize automated trading within these limits. Signing does not deposit or withdraw funds. Your trading mode remains \(creating ? (paper ? "paper" : "live") : "as currently configured").")
                    if store.privy == nil { Text("This build needs the public Privy iOS Client ID before it can sign.").foregroundStyle(.orange) }
                    Button("Sign and activate") { Task { await activate(review) } }.buttonStyle(.borderedProminent).disabled(submitting || wallet.busy || store.privy == nil)
                    if wallet.busy { ProgressView(wallet.status) }
                }
                Button("Cancel", role: .cancel) { confirming = false }.disabled(submitting || wallet.busy)
            } }.interactiveDismissDisabled(submitting || wallet.busy)
        }
    }
    private func load() async {
        loading = true; defer { loading = false }; error = nil
        do {
            owner = store.owner; try await store.verifyOwner(owner)
            let status = try await store.api.request("/api/grants")
            let saved = try await store.api.request("/api/settings")
            guard saved["owner"].text.lowercased() == owner?.lowercased() else { throw APIError(status: 0, message: "The settings belong to another session.") }
            if creating && status["exists"].bool == true { throw APIError(status: 0, message: "Your agent already exists. Open Wallet & permissions to manage it.") }
            if !creating && status["grant"] == .null { throw APIError(status: 0, message: "No active grant was found. Open Create agent to restore management.") }
            grant = status["grant"] == .null ? nil : status["grant"]
            if let grant {
                guard grant["owner"].text.lowercased() == owner?.lowercased(), grant["chainId"].number == 4663, grant["binding"]["version"].text == "privy-did-owner-v1" else { throw APIError(status: 0, message: "This account uses a legacy owner or another network. It cannot be replaced by your embedded wallet.") }
                for field in fields { caps[field.0] = grant["caps"][field.0].text }
                trencher = grant["trencherVaultAddress"].string != nil
            }
            settings = saved; name = saved.setting("agentName").text; strategy = saved.setting("strategy").text.isEmpty ? "steady-basket" : saved.setting("strategy").text
            mode = saved.setting("assetMode").text.isEmpty ? "all" : saved.setting("assetMode").text
            basket = Set(saved.setting("basketSymbols").array.compactMap(\.string))
            paper = saved.setting("liveTradingEnabled").bool != true
        } catch { self.error = error.localizedDescription; settings = nil }
    }
    private func prepareReview() async {
        do {
            try await store.verifyOwner(owner)
            let fresh = try await store.api.request("/api/settings")
            guard fresh["owner"].text.lowercased() == owner?.lowercased() else { throw APIError(status: 0, message: "Your account changed.") }
            var parsed: [String: J] = [:]
            for field in fields {
                guard let value = TradeInput.amount(caps[field.0] ?? ""), value >= 1, value <= 1_000_000 else { throw APIError(status: 0, message: "Every limit must be a positive number of at least 1, without thousands separators.") }
                if !field.0.hasSuffix("Usdg"), value.rounded() != value { throw APIError(status: 0, message: "Days, drawdown percentage and operations must be whole numbers.") }
                parsed[field.0] = .number(value)
            }
            guard parsed["perTradeUsdg"]!.number! <= parsed["dailyUsdg"]!.number!, parsed["expiryDays"]!.number! <= 90, parsed["maxDrawdownPct"]!.number! <= 50, parsed["maxOpsPerDay"]!.number! <= 10_000 else { throw APIError(status: 0, message: "Per-trade spending cannot exceed the daily limit. Maximums: 90 days, 50% drawdown, 10,000 operations per day.") }
            var input: [String: J] = ["caps": .object(parsed), "extraTokens": .array(fresh.setting("customTokens").array), "autonomousTrencher": .bool(trencher)]
            for key in ["v4AdapterAddress", "ponsAdapterAddress", "ponsClassVaultFactory"] { if let value = fresh.setting(key).string, !value.isEmpty { input[key] = .string(value) } }
            if let grant { input["expectAccount"] = grant["smartAccount"]; if let factory = grant["trencherFactoryAddress"].string { input["priorTrencherFactory"] = .string(factory) } }
            if creating {
                guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 24, !basket.isEmpty else { throw APIError(status: 0, message: "Choose an agent name up to 24 characters and at least one asset.") }
                changes = .object(["owner": .string(owner ?? ""), "agentName": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "strategy": .string(strategy), "assetMode": .string(mode), "basketSymbols": .array(basket.sorted().map(J.string)), "paperTradingEnabled": .bool(true), "liveTradingEnabled": .bool(!paper)])
            }
            review = .object(input); confirming = true; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func activate(_ review: J) async {
        guard !submitting else { return }; submitting = true; defer { submitting = false }
        do {
            try await store.verifyOwner(owner)
            let latest = try await store.api.request("/api/grants")
            guard creating ? latest["exists"].bool == false : latest["grant"]["sessionKeyAddress"] == grant?["sessionKeyAddress"] else { throw APIError(status: 409, message: "Your grant changed on another device. Reload and review it again.") }
            if let changes { _ = try await store.perform("/api/settings", method: "PUT", body: changes, expectedOwner: owner) }
            result = try await wallet.call("create", input: review, store: store)
        } catch { self.error = "Permission was not confirmed: \(error.localizedDescription) Any settings already saved remain in effect." }
        confirming = false
    }
    private func retrySaved() async {
        do {
            guard let owner, let saved = try WalletHost.savedGrant(owner: owner) else { throw APIError(status: 0, message: "No saved grant was found.") }
            try await store.verifyOwner(owner)
            let latest = try await store.api.request("/api/grants")
            if latest["grant"]["sessionKeyAddress"] != saved["sessionKeyAddress"] {
                guard let user = await store.privy?.getUser() else { throw APIError(status: 401, message: "Sign in to your embedded wallet again.") }
                let token = try await user.getAccessToken()
                _ = try await store.api.request("/api/grants", method: "POST", body: saved, token: token)
            }
            result = .object(["smartAccount": saved["smartAccount"], "handoff": .object(["ok": .bool(true)])])
        } catch { self.error = error.localizedDescription }
    }
}
