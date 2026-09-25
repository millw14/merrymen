import SwiftUI
import MerrymenPolicy
import PrivySDK

struct GrantScreen: View {
    @EnvironmentObject var store: AppStore
    @AppStorage("language") private var language = "en"
    let creating: Bool
    var recovery: J? = nil
    var recoveryKey: String? = nil
    @StateObject private var wallet = WalletHost()
    @StateObject private var presentation = FeedPresentation()
    @State private var settings: J?
    @State private var grant: J?
    @State private var owner: String?
    @State private var name = ""
    @State private var strategy = "steady-basket"
    @State private var mode = "all"
    @State private var basket = Set<String>()
    @State private var paper = true
    @State private var liveAcknowledged = false
    @State private var trencher = false
    @State private var caps = ["perTradeUsdg": "10", "dailyUsdg": "50", "expiryDays": "7", "maxDrawdownPct": "5", "maxOpsPerDay": "24"]
    @State private var error: String?
    @State private var result: J?
    @State private var review: ReviewValue?
    @State private var loading = true
    @State private var submitting = false
    private let fields = [("perTradeUsdg", "USDG per trade"), ("dailyUsdg", "USDG per day"), ("expiryDays", "Permission lifetime in days"), ("maxDrawdownPct", "Maximum drawdown %"), ("maxOpsPerDay", "Operations per day")]
    private func words(_ key: String) -> String { Language.text(key, locale: language) }
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
                            Picker(words("mode.legend"), selection: $paper) { Text(words("mode.paperOption")).tag(true); Text(words("mode.liveOption")).tag(false) }
                            Text(words(paper ? "mode.paperNote" : "mode.liveNote")).font(.caption)
                            if !paper { Toggle(words("mode.ack"), isOn: $liveAcknowledged) }
                        }
                        Card {
                            Text("What should it trade?").font(.headline)
                            Picker("Markets", selection: $mode) { Text("All").tag("all"); Text("Stocks").tag("stocks"); Text("Crypto").tag("crypto") }
                            ForEach(presentation.assets(settings, mode: mode), id: \.self) { symbol in
                                Toggle(symbol, isOn: Binding(get: { basket.contains(symbol) }, set: { if $0 { basket.insert(symbol) } else { basket.remove(symbol) } }))
                            }
                            NavigationLink("Add custom coins in settings", value: Route.settings)
                            if mode == "crypto" && presentation.assets(settings, mode: mode).isEmpty { Text("Add at least one coin to give this agent something to trade.").foregroundStyle(.orange) }
                            Text("Save custom coins in Settings, then return here and reload before reviewing the permission.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Card {
                        Text("Bound the permission").font(.title2.bold())
                        DisclosureGroup("Choose a cap preset") {
                            Button("Cautious · the scout") { applyPreset(["10", "50", "7", "5", "24"]) }
                            Button("Balanced · the outlaw") { applyPreset(["50", "500", "14", "10", "48"]) }
                            Button("Bold · the warlord") { applyPreset(["200", "2000", "30", "15", "96"]) }
                            Text("A preset fills the limits below. Nothing changes until you review and sign.").font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(fields, id: \.0) { key, title in
                            VStack(alignment: .leading) { Text(title).font(.caption); TextField(title, text: Binding(get: { caps[key] ?? "" }, set: { caps[key] = $0 })).keyboardType(.decimalPad) }
                        }
                        Toggle("Autonomous Trencher vault", isOn: $trencher).disabled(grant?["trencherVaultAddress"].string != nil)
                        Text("This separate permission allows the agent to trade pool tokens in its verified Trencher vault. Daily spending remains capped by the vault on-chain.").font(.caption).foregroundStyle(.secondary)
                        if grant?["trencherVaultAddress"].string != nil { Text("This renewal retains your existing Trencher custody permission.").font(.caption) }
                        Text("Network: Robinhood Chain (4663)").font(.caption)
                        if let address = grant?["smartAccount"].string { Text(address).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                    Button("Review permission") { Task { await prepareReview() } }.buttonStyle(PrimaryButtonStyle()).disabled(wallet.busy)
                    Button("Reload account and saved settings") { Task { await load() } }.disabled(wallet.busy)
                }
                if wallet.busy { ProgressView(wallet.status.isEmpty ? "Preparing permission…" : wallet.status) }
                if let result {
                    Card {
                        Text(result["handoff"]["ok"].bool == true ? "Permission accepted" : "Permission saved on this device").font(.title2.bold())
                        Text(result["smartAccount"].text).font(.caption.monospaced()).textSelection(.enabled)
                        Text(recoveryKey == nil ? "Your owner key stays in your embedded wallet. The trading permission is stored in this device's Keychain." : "Your original recovery key remains in this recovery session. Keep your original backup. The new trading permission is stored in this device's Keychain.")
                        if result["handoff"]["ok"].bool != true {
                            Text(result["handoff"]["error"].string ?? "The service did not confirm activation.").foregroundStyle(.orange)
                            Button("Check activation / retry saved grant") { Task { await retrySaved() } }.disabled(wallet.busy || submitting)
                        } else { NavigationLink("Open wallet", value: Route.permissions); NavigationLink("Add funds", value: Route.deposit) }
                    }
                }
            }
            if let error { Text(error).foregroundStyle(.orange); if settings == nil { Button("Retry") { Task { await load() } } } }
        }.navigationTitle(creating ? "Create agent" : "Trading limits")
        .navigationBarBackButtonHidden(wallet.busy)
        .task { await load() }
        .onChange(of: mode) { _, _ in if let settings { basket.formIntersection(presentation.assets(settings, mode: mode)) } }
        .sheet(item: $review) { selected in
            NavigationStack { Page {
                Text("Sign this permission?").font(.title.bold())
                let review = selected.value
                    ForEach(fields, id: \.0) { key, label in Metric(label: label, value: review["caps"][key].text) }
                    Metric(label: "Account", value: review["expectAccount"].string ?? "Derived from your embedded wallet")
                    Metric(label: "Custom tokens covered", value: String(review["extraTokens"].array.count))
                    Metric(label: "Trencher vault", value: review["autonomousTrencher"].bool == true ? "Enabled" : "Disabled")
                    if review["settingsToSave"] != .null {
                        Metric(label: "Agent", value: review["settingsToSave"]["agentName"].text)
                        Metric(label: "Basket", value: review["settingsToSave"]["basketSymbols"].array.map(\.text).joined(separator: ", "))
                        Metric(label: "Mode", value: review["settingsToSave"]["liveTradingEnabled"].bool == true ? "Live" : "Paper")
                    }
                    Text("You authorize automated trading within these limits. Signing does not deposit or withdraw funds.")
                    if recoveryKey != nil {
                        Text("This restores the reviewed account using its original owner key. Your signed-in wallet must also authorize linking it to this login.")
                        if ExternalWalletConnection.shared.configured { Button("Connect login wallet") { ExternalWalletConnection.shared.present() } }
                    } else if store.privy == nil { Text("This build needs the public Privy iOS Client ID before it can sign.").foregroundStyle(.orange) }
                    Button("Sign and activate") { Task { await activate(review) } }.buttonStyle(PrimaryButtonStyle()).disabled(submitting || wallet.busy || (recoveryKey == nil && store.privy == nil))
                    if wallet.busy { ProgressView(wallet.status) }
                Button("Cancel", role: .cancel) { self.review = nil }.disabled(submitting || wallet.busy)
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
            if !creating && status["grant"] == .null && recovery == nil { throw APIError(status: 0, message: "No active grant was found. Open Create agent to restore management.") }
            grant = status["grant"] == .null ? nil : status["grant"]
            if recovery?["trencher"]["funded"].bool == true { trencher = true }
            if let grant {
                if let recovery {
                    guard grant["smartAccount"].text.lowercased() == recovery["smartAccount"].text.lowercased(), grant["owner"].text.lowercased() == recovery["recoveryOwner"].text.lowercased(), grant["chainId"].number == 4663 else { throw APIError(status: 0, message: "Another account is active. Stand it down before restoring this older account; its funds remain in the original wallet.") }
                } else {
                    guard grant["owner"].text.lowercased() == owner?.lowercased(), grant["chainId"].number == 4663, grant["binding"]["version"].text == "privy-did-owner-v1" else { throw APIError(status: 0, message: "This account needs its original owner key. Open Withdraw, recover that account, then choose Restore trading permissions.") }
                }
                for field in fields { caps[field.0] = grant["caps"][field.0].text }
                trencher = grant["trencherVaultAddress"].string != nil || recovery?["trencher"]["funded"].bool == true
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
            if let recovery {
                input["expectAccount"] = recovery["smartAccount"]; input["recoveryOwner"] = recovery["recoveryOwner"]
                if recovery["trencher"]["funded"].bool == true { input["priorTrencherFactory"] = recovery["trencher"]["factory"] }
            }
            if creating {
                basket.formIntersection(presentation.assets(fresh, mode: mode))
                guard paper || liveAcknowledged else { throw APIError(status: 0, message: words("create.errAck")) }
                guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 24, !basket.isEmpty else { throw APIError(status: 0, message: "Choose an agent name up to 24 characters and at least one asset.") }
                input["settingsToSave"] = .object(["owner": .string(owner ?? ""), "agentName": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "strategy": .string(strategy), "assetMode": .string(mode), "basketSymbols": .array(basket.sorted().map(J.string)), "paperTradingEnabled": .bool(true), "liveTradingEnabled": .bool(!paper)])
            }
            input["reviewOwner"] = owner.map(J.string) ?? .null
            input["reviewSessionKey"] = grant?["sessionKeyAddress"] ?? .null
            review = ReviewValue(value: .object(input)); error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func applyPreset(_ values: [String]) { for (field, value) in zip(fields, values) { caps[field.0] = value } }
    private func activate(_ review: J) async {
        guard !submitting else { return }; submitting = true; defer { submitting = false }
        do {
            let owner = review["reviewOwner"].string
            try await store.verifyOwner(owner)
            let latest = try await store.api.request("/api/grants")
            guard creating ? latest["exists"].bool == false : latest["grant"]["sessionKeyAddress"] == review["reviewSessionKey"] && (latest["exists"].bool == false || latest["grant"]["smartAccount"] == review["expectAccount"]) else { throw APIError(status: 409, message: "Your grant changed on another device. Reload and review it again.") }
            if review["settingsToSave"] != .null { _ = try await store.perform("/api/settings", method: "PUT", body: review["settingsToSave"], expectedOwner: owner) }
            try await store.verifyOwner(owner)
            var input = review.object
            for key in ["settingsToSave", "reviewOwner", "reviewSessionKey"] { input.removeValue(forKey: key) }
            result = try await wallet.call(recoveryKey == nil ? "create" : "restore", input: .object(input), store: store, legacyKey: recoveryKey)
        } catch { self.error = "Permission was not confirmed: \(error.localizedDescription) Any settings already saved remain in effect." }
        self.review = nil
    }
    private func retrySaved() async {
        guard !submitting else { return }; submitting = true; defer { submitting = false }
        do {
            guard let owner, let saved = try WalletHost.savedGrant(owner: owner) else { throw APIError(status: 0, message: "No saved grant was found.") }
            let session = store.api.binding()
            try await store.verifyOwner(owner)
            let latest = try await store.api.request("/api/grants")
            if latest["grant"]["sessionKeyAddress"] != saved["sessionKeyAddress"] {
                let token: String?
                if saved["binding"]["version"].text == "privy-did-owner-v1" {
                    guard let user = await store.privy?.getUser() else { throw APIError(status: 401, message: "Sign in to your embedded wallet again.") }
                    token = try await user.getAccessToken()
                } else { token = nil }
                _ = try await store.api.request("/api/grants", method: "POST", body: saved, token: token, expectedSession: session)
            }
            result = .object(["smartAccount": saved["smartAccount"], "handoff": .object(["ok": .bool(true)])])
        } catch { self.error = error.localizedDescription }
    }
}
