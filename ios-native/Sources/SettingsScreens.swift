import SwiftUI

struct SettingsScreen: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var data = RemoteData()
    @State private var draft: [String: J] = [:]
    @State private var busy = false
    @State private var confirm = false
    @State private var loadedOwner: String?
    private let flags: [(String, String)] = [
        ("liveTradingEnabled", "Trade with real funds"), ("publicBook", "Publish holdings"),
        ("discoveryEnabled", "Market discovery"), ("officialCoinsEnabled", "Include official coins"),
        ("telegramEnabled", "Telegram"), ("telegramControlEnabled", "Telegram controls"),
        ("telegramNotifyEnabled", "Telegram notifications")
    ]
    private let numbers: [(String, String)] = [
        ("tickSeconds", "Decision interval (seconds)"), ("slippageBps", "Slippage (basis points)"),
        ("telegramMaxActionUsdg", "Order ceiling (USDG)")
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
                    ForEach(numbers, id: \.0) { key, label in
                        VStack(alignment: .leading) { Text(label).font(.caption).foregroundStyle(.secondary); TextField(label, text: text(key, settings)).keyboardType(.decimalPad) }
                    }
                }
                Card {
                    Text("Basket").font(.headline)
                    ForEach(settings["knownSymbols"].array.compactMap(\.string), id: \.self) { symbol in
                        Toggle(symbol, isOn: Binding(get: { basket(settings).contains(symbol) }, set: { on in
                            var values = basket(settings); if on { values.insert(symbol) } else { values.remove(symbol) }
                            draft["basketSymbols"] = .array(values.sorted().map(J.string))
                        }))
                    }
                    Text("Adding assets may require a new signed permission before the agent can trade them.").font(.caption).foregroundStyle(.secondary)
                }
                Button("Review changes") { confirm = true }.buttonStyle(.borderedProminent).disabled(draft.isEmpty || busy)
                NavigationLink("Telegram connection", value: Route.telegram)
                NavigationLink("Wallet & signed limits", value: Route.permissions)
            } else if data.refreshing { ProgressView() }
            if let error = data.error { Text(error).foregroundStyle(Brand.down); Button("Retry") { Task { await load() } } }
        }.navigationTitle("Settings").task(id: store.generation) { if store.owner != nil { await load() } }
        .sheet(isPresented: $confirm) {
            NavigationStack { Page {
                Text("Review settings").font(.title2.bold())
                ForEach(draft.keys.sorted(), id: \.self) { key in Metric(label: key, value: draft[key]?.array.isEmpty == false ? draft[key]!.array.map(\.text).joined(separator: ", ") : draft[key]?.text ?? "") }
                Button("Save changes") { Task { await save() } }.buttonStyle(.borderedProminent).disabled(busy)
                Button("Cancel") { confirm = false }.disabled(busy)
            }.navigationTitle("Confirm") }
        }
    }
    private func text(_ key: String, _ settings: J) -> Binding<String> {
        Binding(get: { (draft[key] ?? settings.setting(key)).text }, set: { draft[key] = .string($0) })
    }
    private func basket(_ settings: J) -> Set<String> { Set((draft["basketSymbols"] ?? settings.setting("basketSymbols")).array.compactMap(\.string)) }
    private func load() async { await data.load(store.api, "/api/settings"); loadedOwner = data.value?["owner"].string }
    private func save() async {
        guard !busy, !draft.isEmpty else { return }; busy = true
        defer { busy = false }
        do {
            var body = draft
            for (key, _) in numbers where body[key] != nil {
                guard let value = Double(body[key]!.text), value.isFinite, value >= 0 else { throw APIError(status: 0, message: "Enter a valid number for \(key).") }
                body[key] = .number(value)
            }
            body["owner"] = loadedOwner.map(J.string) ?? .null
            _ = try await store.perform("/api/settings", method: "PUT", body: .object(body), expectedOwner: loadedOwner)
            draft = [:]; confirm = false; await load(); store.notice = "Settings saved."
        } catch { store.notice = error.localizedDescription }
    }
}

struct TelegramScreen: View {
    @EnvironmentObject var store: AppStore
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
                    if let code = status["linkCode"].string { Text("Send this linking code to your bot:"); Text(code).font(.title3.monospaced()).textSelection(.enabled) }
                    if status["ownerId"].number != nil { Text("Your Telegram owner is linked.") }
                    if status["hasToken"].bool != true { Text("Configure your Telegram bot token in account settings before linking.") }
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
                NavigationLink("Review permission", value: Route.limits)
            } }
        } }.navigationTitle("Coins to consider")
    }
}
