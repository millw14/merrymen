import SwiftUI
import MerrymenPolicy

struct SettingsScreen: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var data = RemoteData()
    @State private var draft: [String: J] = [:]
    @State private var busy = false
    @State private var confirm: ReviewValue?
    @State private var loadedOwner: String?
    @State private var models: [String] = []
    @State private var modelStatus: String?
    @State private var tokenSymbol = ""
    @State private var tokenAddress = ""
    @State private var tokenDecimals = "18"
    @State private var tradeNewToken = true
    private let flags: [(String, String)] = [
        ("liveTradingEnabled", "Trade with real funds"), ("paperTradingEnabled", "Allow paper practice when live trading is unavailable"),
        ("publicBook", "Publish holdings, trade sizes and dollar P&L"),
        ("discoveryEnabled", "Market discovery"), ("officialCoinsEnabled", "Include official coins"),
        ("virtualsEnabled", "Publish landed trades and activity to Virtuals"),
        ("telegramEnabled", "Telegram"), ("telegramControlEnabled", "Telegram controls"),
        ("telegramTransferEnabled", "Allow Telegram transfers within the daily budget"),
        ("telegramNotifyEnabled", "Telegram notifications"), ("trencherLiveEnabled", "Live Trencher"),
        ("trencherFastEnabled", "Fast Trencher review"), ("deskEnabled", "Trading desk"),
        ("scoutEnabled", "Scout"), ("classSnipeEnabled", "Class sniping")
    ]
    private let numbers: [(String, String)] = [
        ("tickSeconds", "Decision interval (seconds)"), ("slippageBps", "Slippage (basis points)"),
        ("maxImpactBps", "Maximum price impact (basis points; 0 disables)"), ("paperStartUsdg", "Paper starting balance (USDG)"),
        ("telegramMaxActionUsdg", "Order ceiling (USDG)"), ("buyPerTickUsdg", "Buy per tick (USDG)"),
        ("idleFloorUsdg", "Cash floor (USDG)"), ("gapEnterBudgetUsdg", "Gap entry budget (USDG)"),
        ("takeProfitBps", "Take profit (basis points)"), ("maxPriceDivergenceBps", "Maximum price divergence (basis points)"),
        ("strategistStopLossBps", "Strategist stop loss (basis points; 0 disables)"), ("memecoinMinFdvUsd", "Minimum memecoin fully diluted value (USD)"),
        ("deskMaxSteps", "Maximum research steps per decision"),
        ("minPoolLiquidityUsdg", "Minimum pool liquidity (USDG)"), ("llmIntervalMin", "Strategist interval (minutes)"),
        ("llmMaxActionUsdg", "Strategist action cap (USDG)"), ("discoveryIntervalMin", "Discovery interval (minutes)"),
        ("scoutBudgetUsdg", "Scout budget (USDG)"), ("scoutPerTokenUsdg", "Scout per token (USDG)"),
        ("classMaxHoldSec", "Class maximum hold (seconds)"), ("classMaxPositions", "Class maximum positions"),
        ("classMinDepthUsdg", "Class minimum depth (USDG)"), ("classPerEntryUsdg", "Class entry (USDG)"),
        ("telegramNotifyEveryMin", "Telegram notification interval (minutes)"), ("telegramDigestHour", "Telegram digest hour (local)"),
        ("telegramTransferDailyUsdg", "Telegram transfer budget per day (USDG)")
    ]
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() }
            else if let settings = data.value {
                Card {
                    Text("Your agent").font(.title2.bold())
                    TextField("Agent name", text: text("agentName", settings)).textInputAutocapitalization(.words)
                    Picker("Strategy", selection: text("strategy", settings)) {
                        ForEach(Array(Set((settings["strategies"]["builtin"].array + settings["strategies"]["custom"].array).compactMap(\.string))).sorted(), id: \.self) { name in Text(name).tag(name) }
                    }
                    Text("Some strategies require a Merry Circle tier. Changing strategy does not change signed trading caps.").font(.caption).foregroundStyle(.secondary)
                    Picker("Markets", selection: text("assetMode", settings)) { Text("All").tag("all"); Text("Stocks").tag("stocks"); Text("Crypto").tag("crypto") }
                }
                Card {
                    Text("Controls").font(.headline)
                    ForEach(flags, id: \.0) { key, label in
                        Toggle(label, isOn: Binding(get: { (draft[key] ?? settings.setting(key)).bool ?? false }, set: { draft[key] = .bool($0) }))
                    }
                    if draft["liveTradingEnabled"] != nil {
                        Text("Live mode permits real orders within the existing grant. Switching it off also stops management of existing real positions; it does not sell them.").foregroundStyle(.orange).font(.caption)
                    }
                    if (draft["scoutEnabled"] ?? settings.setting("scoutEnabled")).bool == true || (draft["classSnipeEnabled"] ?? settings.setting("classSnipeEnabled")).bool == true {
                        Text("Scout and class positions can remain valued at purchase cost after losing value. The drawdown breaker cannot protect that money; the scout budget limits the amount at risk.").foregroundStyle(.orange).font(.caption)
                    }
                    if (draft["telegramTransferEnabled"] ?? settings.setting("telegramTransferEnabled")).bool == true {
                        Text("Telegram transfers can move real funds. Keep the transfer budget within the amount you authorize your linked chat to spend.").foregroundStyle(.orange).font(.caption)
                    }
                    if (draft["virtualsEnabled"] ?? settings.setting("virtualsEnabled")).bool == true {
                        Text("This publishes real activity to the public Virtuals agent page using the server's configured connection.").foregroundStyle(.orange).font(.caption)
                    }
                    DisclosureGroup("Advanced trading settings") { ForEach(numbers, id: \.0) { key, label in
                        VStack(alignment: .leading) { Text(label).font(.caption).foregroundStyle(.secondary); TextField(label, text: text(key, settings)).keyboardType(.decimalPad) }
                    } }
                }
                aiSettings(settings)
                Card {
                    Text("Basket").font(.headline)
                    ForEach(Array(Set(settings["knownSymbols"].array.compactMap(\.string) + tokens(settings).compactMap { $0["symbol"].string })).sorted(), id: \.self) { symbol in
                        Toggle(symbol, isOn: Binding(get: { basket(settings).contains(symbol) }, set: { on in
                            var values = basket(settings); if on { values.insert(symbol) } else { values.remove(symbol) }
                            draft["basketSymbols"] = .array(values.sorted().map(J.string))
                        }))
                    }
                    Text("Adding assets may require a new signed permission before the agent can trade them.").font(.caption).foregroundStyle(.secondary)
                }
                customTokens(settings)
                Card {
                    DisclosureGroup("Swap connections") {
                        Picker("Swap venue", selection: text("swapVenue", settings)) { Text("Uniswap").tag("uniswap"); Text("Rialto").tag("rialto") }
                        ForEach([("v4AdapterAddress", "V4 adapter"), ("ponsAdapterAddress", "Pons adapter"), ("ponsClassVaultFactory", "Class vault factory")], id: \.0) { key, label in
                            TextField(label, text: text(key, settings)).textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                        Text("Adapter and vault addresses are verified when you sign. Saving a connection does not add it to your current permission.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Card {
                    Text("Telegram connection").font(.headline)
                    SecureField(settings["telegramBotToken"]["set"].bool == true ? "Bot token saved — type to replace" : "Bot token", text: secret("telegramBotToken"))
                    if settings["telegramBotToken"]["set"].bool == true { Button("Clear saved bot token", role: .destructive) { draft["telegramBotToken"] = .string("") } }
                    Text("The linking code and connection status are available in Telegram connection below.").font(.caption)
                }
                Button("Review changes") { prepareReview() }.buttonStyle(PrimaryButtonStyle()).disabled(draft.isEmpty || busy)
                NavigationLink("Telegram connection", value: Route.telegram)
                NavigationLink("Wallet & signed limits", value: Route.permissions)
            } else if data.refreshing { ProgressView() }
            if let error = data.error { Text(error).foregroundStyle(Brand.down); Button("Retry") { Task { await load() } } }
        }.navigationTitle("Settings").task(id: store.generation) { if store.owner != nil { await load() } }
        .sheet(item: $confirm) { selection in
            NavigationStack { Page {
                Text("Review settings").font(.title2.bold())
                ForEach(selection.value.object.keys.filter { $0 != "owner" }.sorted(), id: \.self) { key in Metric(label: label(key), value: reviewValue(key, selection.value[key])) }
                Button("Save changes") { Task { await save(selection.value) } }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                Button("Cancel") { confirm = nil }.disabled(busy)
            }.navigationTitle("Confirm") }.interactiveDismissDisabled(busy)
        }
    }
    private func text(_ key: String, _ settings: J) -> Binding<String> {
        Binding(get: { (draft[key] ?? settings.setting(key)).text }, set: { draft[key] = .string($0) })
    }
    private func basket(_ settings: J) -> Set<String> { Set((draft["basketSymbols"] ?? settings.setting("basketSymbols")).array.compactMap(\.string)) }
    private func tokens(_ settings: J) -> [J] { (draft["customTokens"] ?? settings.setting("customTokens")).array }
    private func secret(_ key: String) -> Binding<String> { Binding(get: { draft[key]?.string ?? "" }, set: { draft[key] = .string($0) }) }
    private func label(_ key: String) -> String { (flags + numbers).first { $0.0 == key }?.1 ?? ["agentName": "Agent name", "strategy": "Strategy", "customTokens": "Custom tokens", "basketSymbols": "Basket", "llmProvider": "AI provider", "llmProviderModel": "Model" ][key] ?? key }
    private func reviewValue(_ key: String, _ value: J) -> String {
        if ["groqApiKey", "anthropicApiKey", "llmApiKey", "telegramBotToken"].contains(key) { return value.text.isEmpty ? "Clear saved override" : "Replace saved credential" }
        if key == "customTokens" { return value.array.map { $0["symbol"].text + " · " + $0["address"].text }.joined(separator: "\n") }
        if key == "basketSymbols" { return value.array.map(\.text).joined(separator: ", ") }
        return value.text
    }
    @ViewBuilder private func aiSettings(_ settings: J) -> some View {
        let provider = (draft["llmProvider"] ?? settings.setting("llmProvider")).string ?? "groq"
        let keyField = provider == "groq" ? "groqApiKey" : provider == "anthropic" ? "anthropicApiKey" : "llmApiKey"
        let modelField = provider == "groq" ? "groqModel" : provider == "anthropic" ? "llmModel" : "llmProviderModel"
        Card {
            Text("AI provider").font(.headline)
            Picker("Provider", selection: Binding(get: { provider }, set: { draft["llmProvider"] = .string($0); models = []; modelStatus = nil })) {
                ForEach(Array(settings["llmProviders"].array.filter { !["custom", "ollama"].contains($0["id"].text) }.enumerated()), id: \.offset) { _, row in Text(row["label"].text).tag(row["id"].text) }
            }
            SecureField(settings[keyField]["set"].bool == true ? "API key saved — type to replace" : "Optional API key", text: secret(keyField))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Use shared key") { draft[keyField] = .string(""); models = [] }
            TextField("Model ID (blank uses provider default)", text: text(modelField, settings)).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Load available models") {
                guard !busy else { return }; busy = true
                var body: [String: J] = ["provider": .string(provider)]
                if let key = draft[keyField]?.string { body["apiKey"] = .string(key); body["useSavedKey"] = .bool(false) }
                Task { defer { busy = false }; do {
                    let result = try await store.perform("/api/models", body: .object(body), expectedOwner: loadedOwner)
                    models = result["models"].array.compactMap(\.string)
                    modelStatus = result["code"].string == "missing_key" ? "Enter an API key to list models, or type a model ID." : result["error"].string
                } catch { modelStatus = "The model list could not be loaded. You can still type a model ID." } }
            }.disabled(busy)
            if !models.isEmpty { Picker("Available models", selection: text(modelField, settings)) { Text("Provider default").tag(""); ForEach(models, id: \.self) { Text($0).tag($0) } } }
            if let modelStatus { Text(modelStatus).font(.caption).foregroundStyle(.secondary) }
        }
    }
    @ViewBuilder private func customTokens(_ settings: J) -> some View {
        Card {
            DisclosureGroup("Custom tokens") {
                Rows(values: tokens(settings)) { token in
                    HStack { Text(token["symbol"].text); Spacer(); Button("Remove", role: .destructive) { draft["customTokens"] = .array(tokens(settings).filter { $0["address"].text.lowercased() != token["address"].text.lowercased() }) } }
                    Text(token["address"].text).font(.caption.monospaced()).textSelection(.enabled)
                }
                TextField("Symbol", text: $tokenSymbol).textInputAutocapitalization(.characters).autocorrectionDisabled()
                TextField("Contract address (0x…)", text: $tokenAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Token decimals", text: $tokenDecimals).keyboardType(.numberPad)
                Toggle("Include in trading basket", isOn: $tradeNewToken)
                Button("Add to draft") { addToken(settings) }
                Text("New tokens need a new signed permission before they can trade. Removing a token here does not revoke its on-chain permission.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func addToken(_ settings: J) {
        let symbol = tokenSymbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let address = tokenAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard symbol.range(of: "^[A-Z0-9._-]{1,16}$", options: .regularExpression) != nil,
              address.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil,
              let decimals = Int(tokenDecimals), (0...36).contains(decimals),
              !tokens(settings).contains(where: { $0["address"].text.lowercased() == address.lowercased() })
        else { store.notice = "Enter a valid ticker, contract address and whole-number decimals. The address must not already be listed."; return }
        draft["customTokens"] = .array(tokens(settings) + [.object(["symbol": .string(symbol), "address": .string(address), "decimals": .number(Double(decimals))])])
        if tradeNewToken { draft["basketSymbols"] = .array(basket(settings).union([symbol]).sorted().map(J.string)) }
        tokenSymbol = ""; tokenAddress = ""; tokenDecimals = "18"
    }
    private func load() async { draft = [:]; confirm = nil; await data.load(store.api, "/api/settings"); loadedOwner = data.value?["owner"].string }
    private func prepareReview() {
        do {
            var body = draft
            for (key, _) in numbers where body[key] != nil {
                let raw = body[key]!.text
                let pattern = key.hasSuffix("Usdg") ? "^[0-9]+(?:[.,][0-9]{1,2})?$" : "^[0-9]+$"
                guard raw.range(of: pattern, options: .regularExpression) != nil, let value = Double(raw.replacingOccurrences(of: ",", with: ".")), value.isFinite, value >= 0 else { throw APIError(status: 0, message: "Enter a valid number without thousands separators for \(label(key)).") }
                body[key] = .number(value)
            }
            body["owner"] = loadedOwner.map(J.string) ?? .null
            confirm = ReviewValue(value: .object(body))
        } catch { store.notice = error.localizedDescription }
    }
    private func save(_ body: J) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            _ = try await store.perform("/api/settings", method: "PUT", body: body, expectedOwner: body["owner"].string)
            await load(); store.notice = "Settings saved."
        } catch { store.notice = error.localizedDescription }
    }
}

struct TelegramScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var busy = false
    @State private var result: String?
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else { Remote(path: "/api/telegram") { status in
                Card {
                    Text("Telegram").font(.title.bold())
                    Metric(label: "Bot", value: status["connected"].bool == true ? "Connected" : "Not connected")
                    Metric(label: "Controls", value: status["control"].bool == true ? "Enabled" : "Read only")
                    if let name = status["botUsername"].string, name.range(of: "^[A-Za-z0-9_]+$", options: .regularExpression) != nil {
                        Link("Open @\(name)", destination: URL(string: "https://t.me/\(name)")!)
                    }
                    if let code = status["linkCode"].string {
                        Text("Send this command to your bot:"); Text("/link " + code).font(.title3.monospaced()).textSelection(.enabled).privacySensitive()
                        Text("Anyone with this code can control your agent. Keep it private.").font(.caption).foregroundStyle(.orange)
                    }
                    if status["ownerId"].number != nil { Text("Your Telegram owner is linked.") }
                    if status["hasToken"].bool != true { Text("Configure your Telegram bot token in account settings before linking.") }
                    Button("Test saved bot connection") {
                        guard !busy else { return }; busy = true; let owner = store.owner
                        Task { defer { busy = false }; do {
                            let value = try await store.perform("/api/telegram", body: .object(["action": .string("test")]), expectedOwner: owner)
                            result = value["ok"].bool == true ? "Connected to @\(value["username"].text)." : value["reason"].string ?? "Connection could not be verified."
                        } catch { result = error.localizedDescription } }
                    }.disabled(busy)
                    if let result { Text(result).font(.caption) }
                    NavigationLink("Edit Telegram settings", value: Route.settings)
                }
            } }
        }.navigationTitle("Telegram")
    }
}

struct CircleEntry: View {
    @EnvironmentObject var store: AppStore
    var body: some View { Button("The Merry Circle") { store.path.append(.circle) } }
}
struct CircleScreen: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        Page { Remote(path: "/api/circle") { circle in
            Card {
                Text("The Merry Circle").font(.largeTitle.bold())
                Text(circle["tier"]["name"].string ?? "Membership").font(.title2)
                if circle["why"].string == "unreadable" { Text("Your balance could not be read. Your tier is unknown.").foregroundStyle(.orange) }
                else if circle["why"].string == "sign-in" { SignInCard() }
                Metric(label: "$MERRYMEN held", value: circle["balance"].number.map { $0.formatted() } ?? "—")
                Metric(label: "Performance fee", value: bps(circle["effectiveFeeBps"].number))
                if let holder = circle["holderAddress"].string { Text(holder).font(.caption.monospaced()).textSelection(.enabled) }
                if store.owner != nil { NavigationLink("Manage holder wallet", value: Route.holderWallet) }
            }
            Rows(values: circle["tiers"].array) { tier in Card {
                Text("\(tier["emoji"].text) \(tier["name"].text)").font(.title2.bold())
                Metric(label: "Tokens required", value: tier["minTokens"].number.map { $0.formatted() } ?? "—")
                Rows(values: tier["perks"].array) { Text($0.text) }
            } }
        } }.navigationTitle("Merry Circle")
    }
}

struct ProposalsScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var selected: ReviewValue?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Page { Remote(path: "/api/proposals") { data in
            Text("Coins to consider").font(.largeTitle.bold())
            Text("\(data["covered"].text) tokens covered by the current signed permission.").font(.caption)
            if data["why"].string != "ok" { Text(data["why"].text.replacingOccurrences(of: "-", with: " ")) }
            Rows(values: data["proposals"].array) { row in Card {
                NavigationLink(row["symbol"].text, value: Route.token(row["token"].text)).font(.headline)
                Text(row["reason"].text)
                Metric(label: "Price", value: usd(row["priceUsd"].number))
                if row["onCurve"].bool == true { Text("Still on its launch curve").foregroundStyle(.orange) }
                Text(row["watched"].bool == true ? "Already watched; permission still required." : "Adding this token needs settings and a new signed permission.").font(.caption)
                Button("Review adding this coin") { selected = ReviewValue(value: row) }.disabled(store.owner == nil)
            } }
        } }.navigationTitle("Coins to consider")
        .sheet(item: $selected) { selection in
            NavigationStack { Page {
                Text("Add coin to the basket?").font(.title.bold())
                let row = selection.value
                    Text(row["symbol"].text).font(.headline)
                    Text(row["token"].text).font(.caption.monospaced()).textSelection(.enabled)
                    Text("This saves the coin in your settings and basket. You will review a new signed permission next. Research is not a promise of return.")
                    Button("Save and review permission") { Task { await add(row) } }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                if let error { Text(error).foregroundStyle(.orange) }
                Button("Cancel") { selected = nil }.disabled(busy)
            } }.interactiveDismissDisabled(busy)
        }
    }
    private func add(_ row: J) async {
        guard !busy else { return }; busy = true; defer { busy = false }; error = nil
        do {
            let owner = store.owner; try await store.verifyOwner(owner)
            guard row["token"].text.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil,
                  row["symbol"].text.range(of: "^[A-Za-z0-9._-]{1,16}$", options: .regularExpression) != nil,
                  let decimals = row["decimals"].number, (0...36).contains(decimals), decimals.rounded() == decimals else { throw APIError(status: 0, message: "This proposal is missing valid token metadata.") }
            let settings = try await store.api.request("/api/settings")
            guard settings["owner"].string?.lowercased() == owner?.lowercased() else { throw APIError(status: 0, message: "Your account changed.") }
            var tokens = settings.setting("customTokens").array
            if !tokens.contains(where: { $0["address"].text.lowercased() == row["token"].text.lowercased() }) {
                tokens.append(.object(["symbol": row["symbol"], "address": row["token"], "decimals": row["decimals"]]))
            }
            let basket = Set(settings.setting("basketSymbols").array.compactMap(\.string)).union([row["symbol"].text])
            _ = try await store.perform("/api/settings", method: "PUT", body: .object(["owner": owner.map(J.string) ?? .null, "customTokens": .array(tokens), "basketSymbols": .array(basket.sorted().map(J.string))]), expectedOwner: owner)
            selected = nil; store.path.append(.limits)
        } catch { self.error = error.localizedDescription }
    }
}
