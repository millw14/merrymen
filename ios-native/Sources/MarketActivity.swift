import SwiftUI

struct MarketActivity: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    @StateObject private var market = RemoteData()
    @StateObject private var discoveries = RemoteData()
    @StateObject private var theses = RemoteData()
    @StateObject private var presentation = FeedPresentation()
    @State private var sort = "buys"
    @State private var showAll = false
    var query = ""
    var saved = false
    private var rendered: J? { presentation.markets(.object([
        "market": market.value ?? .null, "discoveries": discoveries.value ?? .null,
        "theses": theses.value ?? .null, "sort": .string(sort)
    ])) }
    private func matches(_ row: J, address: String) -> Bool {
        (!saved || store.watchlist.contains(where: { $0.lowercased() == address.lowercased() })) &&
        (query.isEmpty || (row["name"].text + " " + row["symbol"].text + " " + address).localizedCaseInsensitiveContains(query))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Market activity").font(.title2.bold())
            Picker("Market activity", selection: $sort) {
                Text("Buying").tag("buys"); Text("Held").tag("held"); Text("All tokens").tag("all")
            }.pickerStyle(.segmented).onChange(of: sort) { _, _ in showAll = false }
            if let rendered {
                let rows = rendered["rows"].array.filter { matches($0, address: $0["id"].text) }
                if market.value == nil && discoveries.value == nil {
                    if market.refreshing || discoveries.refreshing { ProgressView("Loading markets") }
                    else { Text("Market data could not be read.").foregroundStyle(.orange) }
                } else {
                    if rendered["fallback"].bool == true { Text("No buying or holding activity was found. Showing tokens to explore.").font(.caption).foregroundStyle(.secondary) }
                    if rows.isEmpty { Text("No tokens match these filters.").foregroundStyle(.secondary) }
                    Rows(values: showAll ? rows : Array(rows.prefix(8))) { row in
                        NavigationLink(value: Route.token(row["id"].text)) { Card {
                            Metric(label: row["symbol"].text, value: tokenPrice(row["priceUsd"].number))
                            Text(row["name"].text).font(.caption).foregroundStyle(.secondary)
                            HStack {
                                if sort == "buys" { Text("Buying activity: \(row["buys"].number.map { String(Int($0)) } ?? "—")") }
                                if sort == "held" { Text("Agents: \(row["agents"].number.map { String(Int($0)) } ?? "—")") }
                                Spacer()
                                if let change = row["change24hPct"].number { Text(bps(change * 100)).foregroundStyle(change < 0 ? Brand.down : Brand.accent) }
                            }.font(.caption)
                            if row["halted"].bool == true { Text("Trading paused").foregroundStyle(.orange).font(.caption) }
                            if !row["cast"].array.isEmpty { Text("Agents: " + row["cast"].array.map { $0["name"].text }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary) }
                        } }.buttonStyle(.plain)
                    }
                    if rows.count > 8 { Button(showAll ? "Show fewer" : "Show all \(rows.count)") { showAll.toggle() } }
                }
            } else { Text("Market presentation is unavailable.").foregroundStyle(.orange) }
            if market.error != nil || discoveries.error != nil || theses.error != nil { Text("Some market or agent activity could not be refreshed. Previously loaded values may be out of date.").font(.caption).foregroundStyle(.orange) }
            if let data = discoveries.value {
                MarketCaveats(data: data)
                let research = data["rows"].array.filter { matches($0, address: $0["token"].text) }
                if !research.isEmpty { DisclosureGroup("Discovery research") { Rows(values: research) { DiscoveryCard(row: $0) } } }
                let fresh = data["fresh"].array.filter { matches($0, address: $0["token"].text) }
                if !fresh.isEmpty { DisclosureGroup("New launches with activity") { Rows(values: fresh) { row in Card {
                    NavigationLink(row["name"].string ?? row["symbol"].text, value: Route.token(row["token"].text)).font(.headline)
                    Text(row["description"].text)
                    Metric(label: "Trades / traders", value: "\(row["trades"].text) / \(row["traders"].text)")
                    Metric(label: "Graduation progress", value: bps(row["progressBps"].number))
                    Text("Launcher description; not independently verified.").font(.caption).foregroundStyle(.secondary)
                } } } }
            }
        }
        .task(id: phase) { await refresh(market, "/api/market", seconds: 60) }
        .task(id: phase) { await refresh(discoveries, "/api/discoveries", seconds: 120) }
        .task(id: phase) { await refresh(theses, "/api/theses", seconds: 10) }
    }
    private func refresh(_ data: RemoteData, _ path: String, seconds: Double) async {
        guard phase == .active else { return }
        while !Task.isCancelled {
            await data.load(store.api, path)
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
        }
    }
}
