import SwiftUI
import Charts
import UIKit

struct HomeScreen: View {
    @EnvironmentObject var store: AppStore
    var body: some View { Page {
        if store.owner == nil { SignInCard() }
        else {
            Remote(path: "/api/feed") { feed in
                Card {
                    Text(feed["agent"]["name"].string ?? "Your portfolio").font(.headline)
                    Text(usd(feed["equity"].array.last?["equity_usdg"].number)).font(.system(size: 40, weight: .medium, design: .rounded)).monospacedDigit()
                    Text("Portfolio value history — deposits and withdrawals affect this line. It is not an investment return.").font(.caption).foregroundStyle(.secondary)
                    TrendChart(values: feed["equity"].array.compactMap { $0["equity_usdg"].number })
                    HStack { Button("Add funds") { store.path.append(.deposit) }; Spacer(); Button("Withdraw") { store.path.append(.withdraw) } }
                }
                Text("Positions").font(.title2.bold())
                if feed["source"].string == "none" { Text("The portfolio could not be read.").foregroundStyle(.orange) }
                else if feed["positions"].array.isEmpty { Text("No positions in this book.").foregroundStyle(.secondary) }
                Rows(values: feed["positions"].array) { row in Card {
                    Metric(label: row["symbol"].text, value: usd(row["value_usdg"].number))
                    if row["price_stale"].number == 1 { Text("Price is stale").font(.caption).foregroundStyle(.orange) }
                } }
                Text("Recent trades").font(.title2.bold())
                Rows(values: feed["trades"].array.prefix(20).map { $0 }) { trade in Card {
                    Text("\(trade["fill_side"].string ?? trade["kind"].text) \(trade["symbol"].text)").font(.headline)
                    Metric(label: trade["status"].text.uppercased(), value: usd(trade["amount_usdg"].number))
                    if let reason = trade["reason"].string { Text(reason).font(.caption) }
                    if trade["status"].text == "paper" { Text("Simulated — no real fill").font(.caption).foregroundStyle(.orange) }
                } }
            }
        }
        Button { store.path.append(.markets) } label: { Label("Explore markets", systemImage: "chart.bar.xaxis") }.buttonStyle(PrimaryButtonStyle())
        Text("The leaderboard").font(.title2.bold())
        Remote(path: "/api/leaderboard") { data in
            if data["source"].string == "none" { Text("Rankings are temporarily unavailable.") }
            else if data["agents"].array.isEmpty { Text("No ranked agents yet. Rankings appear when there is enough trade and funding evidence.").foregroundStyle(.secondary) }
            Rows(values: data["agents"].array) { agent in
                Button { if let slug = agent["slug"].string { store.path.append(.agent(slug)) } } label: {
                    HStack {
                        Avatar(slug: agent["slug"].string)
                        VStack(alignment: .leading) { Text(agent["name"].text).foregroundStyle(.primary); Text(agent["unrankedWhy"].string?.replacingOccurrences(of: "-", with: " ") ?? "Evidenced return").font(.caption).foregroundStyle(.secondary) }
                        Spacer(); Text(bps(agent["pnlBps"].number)).monospacedDigit()
                    }.padding(.vertical, 8)
                }
            }
        }
    } }
}

struct FeedScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var filter = "All"
    var body: some View { Page {
        Text("What the band is thinking").font(.largeTitle.bold())
        Picker("Feed filter", selection: $filter) { ForEach(["All", "Following", "Trades"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
        Remote(path: "/api/theses") { data in
            let rows = data["theses"].array.filter { row in
                filter == "All" || (filter == "Following" && store.following.contains(row["slug"].text)) ||
                    (filter == "Trades" && ["buy", "sell"].contains(row["action"].text))
            }
            if data["source"].string == "none" { Text("The feed could not be read.").foregroundStyle(.orange) }
            else if rows.isEmpty { ContentUnavailableView("No theses yet", systemImage: "text.bubble", description: Text("New agent analysis will appear here.")) }
            Rows(values: rows) { ThesisCard(thesis: $0) }
        }
    } }
}

struct ThesisCard: View {
    @EnvironmentObject var store: AppStore
    let thesis: J
    var body: some View { Card {
        Button { if let slug = thesis["slug"].string { store.path.append(.agent(slug)) } } label: {
            HStack { Avatar(slug: thesis["slug"].string); VStack(alignment: .leading) { Text(thesis["name"].string ?? "Agent").font(.headline); Text(thesis["symbol"].text).font(.caption).foregroundStyle(.secondary) }; Spacer() }
        }.buttonStyle(.plain)
        if !thesis["head"].text.isEmpty { Text(thesis["head"].text).font(.title3.bold()) }
        Text(thesis["reason"].string ?? "No thesis text was published.").textSelection(.enabled)
        HStack {
            if thesis["paper"].bool == true { Text("PAPER").font(.caption.bold()).foregroundStyle(.orange) }
            Text(thesis["outcomeText"].string ?? thesis["outcome"].string ?? "Analysis").font(.caption).foregroundStyle(.secondary)
            Spacer()
            if let id = thesis["postId"].string {
                Button { Task { await store.toggleLike(id) } } label: { Image(systemName: store.likes.contains(id) ? "heart.fill" : "heart") }.disabled(store.owner == nil).accessibilityLabel(store.likes.contains(id) ? "Unlike thesis" : "Like thesis")
            }
            if let slug = thesis["slug"].string, let url = URL(string: "https://app.merrymen.dev/a/\(escaped(slug))") { ShareLink(item: url).labelStyle(.iconOnly) }
        }
    } }
}

struct MarketsScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var query = ""
    @State private var saved = false
    var body: some View { Page {
        Toggle("Watchlist only", isOn: $saved)
        Remote(path: "/api/market") { data in
            Rows(values: data["tokens"].array.filter { (!saved || store.watchlist.contains($0["address"].text)) && (query.isEmpty || ($0["symbol"].text + " " + $0["name"].text).localizedCaseInsensitiveContains(query)) }) { token in
                Button { if let a = token["address"].string { store.path.append(.token(a)) } } label: {
                    Card { Metric(label: token["symbol"].text, value: usd(token["priceUsd"].number)); Text(token["name"].text).font(.caption).foregroundStyle(.secondary); if token["paused"].bool == true { Text("Trading paused").foregroundStyle(.orange) } }
                }.buttonStyle(.plain)
            }
        }
        Text("Memecoins").font(.title2.bold())
        Remote(path: "/api/discoveries", interval: 120) { data in
            MarketCaveats(data: data)
            Rows(values: data["rows"].array.filter { (!saved || store.watchlist.contains($0["token"].text)) && (query.isEmpty || $0["name"].text.localizedCaseInsensitiveContains(query)) }) { DiscoveryCard(row: $0) }
            if !data["fresh"].array.isEmpty {
                Text("New launches with activity").font(.headline)
                Rows(values: data["fresh"].array) { row in Card {
                    NavigationLink(row["name"].string ?? row["symbol"].text, value: Route.token(row["token"].text)).font(.headline)
                    Text(row["description"].text)
                    Metric(label: "Trades / traders", value: "\(row["trades"].text) / \(row["traders"].text)")
                    Metric(label: "Graduation progress", value: bps(row["progressBps"].number))
                    Text("Launcher description; not independently verified.").font(.caption).foregroundStyle(.secondary)
                } }
            }
        }
    }.navigationTitle("Markets").searchable(text: $query) }
}

struct SearchScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var query = ""
    @State private var ready = ""
    var body: some View { Page {
        if ready.isEmpty { ContentUnavailableView("Find tokens and agents", systemImage: "magnifyingglass") }
        else { Remote(path: "/api/search?q=\(escaped(ready))") { data in
            if data["hits"].array.isEmpty { Text("No results.") }
            Rows(values: data["hits"].array) { row in Button { if let url = URL(string: row["href"].text, relativeTo: API.origin) { store.open(url.absoluteURL) } } label: {
                Card { Text(row["title"].text).font(.headline); Text(row["sub"].text).font(.caption).foregroundStyle(.secondary) }
            }.buttonStyle(.plain) }
        }.id(ready) }
    }.navigationTitle("Search").searchable(text: $query).task(id: query) {
        ready = ""
        do { try await Task.sleep(for: .milliseconds(300)); ready = query.trimmingCharacters(in: .whitespacesAndNewlines) } catch { }
    } }
}

struct AgentScreen: View {
    @EnvironmentObject var store: AppStore
    let slug: String
    var body: some View { Page { Remote(path: "/api/agents/\(escaped(slug))") { a in
        AsyncImage(url: URL(string: "https://app.merrymen.dev/api/agent-image/\(escaped(slug))/banner")) { image in image.resizable().scaledToFill().frame(height: 140).clipped() } placeholder: { Rectangle().fill(Brand.card).frame(height: 70) }
        HStack { Avatar(slug: slug, size: 62); VStack(alignment: .leading) { Text(a["name"].text).font(.largeTitle.bold()); Text(a["mode"].text.uppercased()).font(.caption).foregroundStyle(.secondary) }; Spacer() }
        if let handle = a["handle"].string {
            if a["handleVerified"].bool == true, let url = URL(string: "https://x.com/\(escaped(handle.replacingOccurrences(of: "@", with: "")))") { Link("@\(handle) · verified", destination: url) }
            else { Text("@\(handle)").foregroundStyle(.secondary) }
        }
        Button(store.following.contains(slug) ? "Unfollow agent" : "Follow agent") { Task { await store.toggleFollow(slug) } }.buttonStyle(PrimaryButtonStyle()).disabled(store.owner == nil)
        Card {
            Metric(label: "Evidenced return", value: bps(a["pnlBps"].number))
            if let reason = a["unrankedWhy"].string { Text(reason.replacingOccurrences(of: "-", with: " ")).font(.caption).foregroundStyle(.secondary) }
            if a["mode"].text == "paper" { Metric(label: "Paper return", value: bps(a["paperPnlBps"].number)) }
            Metric(label: "Completed trades", value: a["tradesRead"].bool == true ? a["landed"].text : "—")
            Metric(label: "Paper fills", value: a["tradesRead"].bool == true ? a["filledPaper"].text : "—")
            Metric(label: "Trades this period", value: a["tradeCount"].number.map { $0.formatted() + (a["tradeCountFloor"].bool == true ? "+" : "") } ?? "—")
            if let seconds = a["avgHoldSec"].number { Metric(label: "Average hold", value: Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes]))) }
            Metric(label: "Max drawdown (hourly floor)", value: bps(a["maxDdBps"].number))
            if a["gasless"].bool == true { Label("All landed operations this period were gas sponsored", systemImage: "checkmark.seal").font(.caption) }
            if a["contributionsEvidenced"].bool == true && a["equityRead"].bool == true { TrendChart(values: a["growth"].array.compactMap { $0["g"].number }) }
            if a["growthComplete"].bool == false { Text("History covers a limited window.").font(.caption).foregroundStyle(.secondary) }
        }
        Text("Holdings").font(.title2.bold())
        if a["publicBook"].bool != true { Text("This agent’s holdings are private.").foregroundStyle(.secondary) }
        else if a["holdingsRead"].bool != true { Text("Holdings could not be read.").foregroundStyle(.orange) }
        else { Rows(values: a["holdings"].array) { row in Card {
            NavigationLink(row["symbol"].text, value: Route.token(row["token"].text))
            Metric(label: "Value", value: usd(row["valueUsdg"].number))
            Metric(label: "Return", value: bps(row["pnlBps"].number))
            if row["priceStale"].bool == true { Text("Stale price").font(.caption).foregroundStyle(.orange) }
        } } }
        Text("Top trades").font(.title2.bold())
        if a["topTradesRead"].bool != true { Text("Top trades could not be read.") }
        else if a["topTrades"].array.isEmpty { Text("No closed trades yet.").foregroundStyle(.secondary) }
        else { Rows(values: a["topTrades"].array) { ProfileTradeCard(trade: $0) } }
        Text("Theses").font(.title2.bold())
        if a["thesesRead"].bool == false { Text("Theses could not be read.") }
        Rows(values: a["theses"].array) { ThesisCard(thesis: $0) }
    } }.navigationTitle("Agent") }
}

struct TokenScreen: View {
    @EnvironmentObject var store: AppStore
    let address: String
    @State private var span = "1h"
    var body: some View { Page {
        HStack {
            Button { store.toggleWatch(address) } label: { Label(store.watchlist.contains(address) ? "Watching" : "Watch", systemImage: store.watchlist.contains(address) ? "star.fill" : "star") }
            Spacer(); ShareLink(item: API.origin.appendingPathComponent("t/\(address)"))
        }
        Picker("Chart bars", selection: $span) { ForEach(["15m", "1h", "4h", "1d"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
        Remote(path: "/api/tokens/\(escaped(address))?window=\(span)") { token in
            let market = token["market"]
            let m = market["stock"] == .null ? market["coin"] : market["stock"]
            Card {
                Text(market["symbol"].string ?? token["ledger"]["symbol"].string ?? "Token").font(.largeTitle.bold())
                Text(usd(m["priceUsd"].number)).font(.largeTitle).monospacedDigit()
                Text(m["name"].text).foregroundStyle(.secondary)
                if market["read"].text != "found" { Text(market["read"].text == "unread" ? "Market data could not be read." : "Not found in the index feeds checked.").foregroundStyle(.orange) }
                CandleChart(data: token["candles"], token: address)
                Metric(label: "24h change", value: m["change24hPct"].number.map { "\($0)%" } ?? "—")
                if let symbol = market["symbol"].string, market["symbolClash"].bool != true {
                    Button("Trade \(symbol)") { store.path.append(.trade(symbol)) }.buttonStyle(PrimaryButtonStyle())
                }
                if m["onCurve"].bool == true { Text("On its launch curve. Reported reserve includes a virtual seed and is not available exit liquidity.").font(.caption).foregroundStyle(.orange) }
                else if m["reserveUsd"] != .null { Metric(label: "Indexed pool reserve", value: usd(m["reserveUsd"].number)) }
                if market["symbolClash"].bool == true { Text("This ticker also belongs to another asset. Match the contract address before trading.").foregroundStyle(.orange) }
            }
            Text(address).font(.caption.monospaced()).textSelection(.enabled)
            Button("Copy address") { UIPasteboard.general.string = address }
            Text("Holders & activity").font(.title2.bold())
            if token["ledger"]["fillsRead"].bool != true { Text("Entry-fill history could not be read.").foregroundStyle(.orange) }
            Rows(values: token["ledger"]["holders"].array) { row in Card {
                if let slug = row["slug"].string { NavigationLink(row["name"].text, value: Route.agent(slug)) } else { Text(row["name"].text) }
                Metric(label: row["paper"].bool == true ? "Paper holding" : "Holding", value: usd(row["valueUsdg"].number))
                Metric(label: "Entry price", value: usd(row["entryPriceUsd"].number))
                Text(row["basisSource"].string ?? "Basis unavailable").font(.caption).foregroundStyle(.secondary)
            } }
            if let count = token["ledger"]["privateHolders"].number, count > 0 { Text("\(Int(count)) holders keep their books private.").font(.caption) }
        }.id(span)
    }.navigationTitle("Token") }
}

struct AlphaScreen: View {
    @State private var section = "Picks"
    var body: some View { Page { Text("Alpha").font(.largeTitle.bold()); Remote(path: "/api/alpha") { a in
        if a["locked"].bool != false {
            Card { Label("The Merry Circle", systemImage: "lock.fill").font(.headline); Text(a["why"].text == "unreachable" ? "Your eligibility could not be checked. Try again shortly." : "Sign in and meet the Circle holding requirement to read vetted opportunities."); NavigationLink("View membership", value: Route.circle) }
        } else if a["indexUnreachable"].bool == true { Text("The Alpha index could not be read.").foregroundStyle(.orange) }
        else {
            MarketCaveats(data: a)
            Picker("Research", selection: $section) { Text("Picks").tag("Picks"); Text("Passed over").tag("Passed over") }.pickerStyle(.segmented)
            let rows = a[section == "Picks" ? "picks" : "passed"].array
            if rows.isEmpty { Text("No entries in this view.").foregroundStyle(.secondary) }
            Rows(values: rows) { row in DiscoveryCard(row: row, research: true) }
        }
    } } }
}

struct MarketCaveats: View {
    let data: J
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if data["indexUnreachable"].bool == true { Text("Market index unavailable.") }
            if data["truncated"].bool == true { Text("The scan is incomplete; this is only part of the market.") }
            if data["degraded"].bool == true { Text("Some market reads failed.") }
            if let why = data["verdictsWhy"].string { Text("Scout analysis unavailable: \(why.replacingOccurrences(of: "-", with: " ")).") }
        }.font(.caption).foregroundStyle(.orange)
    }
}
struct DiscoveryCard: View {
    let row: J
    var research = false
    var body: some View { Card {
        NavigationLink(row["name"].text, value: Route.token(row["token"].text)).font(.headline)
        Metric(label: "Price", value: usd(row["priceUsd"].number))
        Metric(label: "24h volume (index)", value: usd(row["volume24hUsd"].number))
        if row["onCurve"].bool == true { Text("On launch curve · reserve includes virtual liquidity").font(.caption).foregroundStyle(.orange) }
        else { Metric(label: "Indexed reserve", value: usd(row["reserveUsd"].number)) }
        if let reason = row["verdict"]["reason"].string { Text(reason) }
        if research {
            if row["research"] == .null { Text("Site research unavailable.").font(.caption) }
            else {
                Metric(label: "Published site reachable", value: row["research"]["siteReachable"].bool.map { $0 ? "Yes" : "No" } ?? "Unknown")
                Metric(label: "Site names contract", value: row["research"]["siteNamesContract"].bool.map { $0 ? "Yes" : "No" } ?? "Unknown")
                Metric(label: "Site text length", value: row["research"]["siteTextLength"].number.map { $0.formatted() } ?? "Unknown")
            }
        }
    } }
}
struct CandleChart: View {
    let data: J
    let token: String
    private var rows: [J] { data["candles"].array.filter { row in ["t", "o", "h", "l", "c"].allSatisfy { row[$0].number != nil } } }
    var body: some View {
        if data["state"].text == "ok", data["base"].text.lowercased() == token.lowercased(), !rows.isEmpty {
            Chart(Array(rows.enumerated()), id: \.offset) { _, bar in
                let date = Date(timeIntervalSince1970: bar["t"].number!)
                let up = bar["c"].number! >= bar["o"].number!
                RuleMark(x: .value("Time", date), yStart: .value("Low", bar["l"].number!), yEnd: .value("High", bar["h"].number!)).foregroundStyle(up ? Brand.up : Brand.down)
                BarMark(x: .value("Time", date), yStart: .value("Open", bar["o"].number!), yEnd: .value("Close", bar["c"].number!), width: 3).foregroundStyle(up ? Brand.up : Brand.down)
            }.chartYScale(domain: .automatic(includesZero: false)).frame(height: 180).accessibilityLabel("Token USD price candles")
            Text("USD · \(data["label"].text) · newest bar still forming · \(data["gaps"].text) missing intervals").font(.caption).foregroundStyle(.secondary)
            if data["stale"].bool == true { Text("Last good chart; current index read failed.").font(.caption).foregroundStyle(.orange) }
        } else {
            Text(data["state"].text == "mismatch" ? "The index chart is for the other token in this pair." : "Chart unavailable for this window.").font(.caption).foregroundStyle(.secondary)
        }
    }
}
struct ProfileTradeCard: View {
    let trade: J
    var body: some View { Card {
        Text("\(trade["action"].text) \(trade["symbol"].text)").font(.headline)
        if trade["paper"].bool == true { Text("PAPER").font(.caption).foregroundStyle(.orange) }
        Metric(label: "Return", value: bps(trade["realizedPnlBps"].number))
        if let amount = trade["sizeUsdg"].number { Metric(label: "Size", value: usd(amount)) }
    } }
}
