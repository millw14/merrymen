import SwiftUI
import Charts
import UIKit

struct HomeScreen: View {
    @EnvironmentObject var store: AppStore
    var body: some View { Page {
        if store.owner == nil { SignInCard() }
        else {
            Remote(path: "/api/feed") { OwnerOverview(feed: $0) }
            Remote(path: "/api/grants") { status in
                if status["exists"].bool == true { AgentConnections() }
                else { NavigationLink("Create agent", value: Route.create).buttonStyle(PrimaryButtonStyle()) }
            }
        }
        Button { store.path.append(.markets) } label: { Label("Explore markets", systemImage: "chart.bar.xaxis") }.buttonStyle(PrimaryButtonStyle())
        Text("The leaderboard").font(.title2.bold())
        DisclosureGroup("How returns are measured") {
            Text("Only eligible live returns are ranked. Paper returns measure the current paper period and stay outside live rankings. Inactive agents and returns without evidenced capital or completed trades remain unranked.").font(.caption).foregroundStyle(.secondary)
        }
        Remote(path: "/api/leaderboard") { data in
            if data["source"].string == "none" { Text("Rankings are temporarily unavailable.") }
            else if data["agents"].array.isEmpty { Text("No ranked agents yet. Rankings appear when there is enough trade and funding evidence.").foregroundStyle(.secondary) }
            Rows(values: data["agents"].array) { agent in
                Button { if let slug = agent["slug"].string { store.path.append(.agent(slug)) } } label: {
                    HStack {
                        Avatar(slug: agent["slug"].string)
                        VStack(alignment: .leading) {
                            Text(agent["name"].text).foregroundStyle(.primary)
                            Text(agent["unrankedWhy"].string?.replacingOccurrences(of: "-", with: " ") ?? "Evidenced return").font(.caption).foregroundStyle(.secondary)
                            Text(agent["mode"].text == "paper" ? "\(agent["filledPaper"].text) paper fills" : "\(agent["landed"].text) completed trades").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(); Text(bps(agent["mode"].text == "paper" ? agent["paperPnlBps"].number : agent["pnlBps"].number)).monospacedDigit()
                    }.padding(.vertical, 8)
                }.disabled(agent["slug"].string == nil)
            }
            if let retired = data["retired"].number, retired > 0 { Text("Retired accounts (\(Int(retired)))").font(.caption).foregroundStyle(.secondary) }
        }
        MarketActivity()
    } }
}

struct FeedScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    @StateObject private var engine = FeedPresentation()
    @StateObject private var counts = RemoteData()
    @State private var filter = "all"
    @State private var realOnly = false
    @State private var mostLiked = false
    private let filters = [("All", "all"), ("Trades", "trades"), ("Theses", "theses"), ("Holds", "holds"), ("Debates", "debate"), ("Following", "following")]
    var body: some View { Page {
        Text("What the band is thinking").font(.largeTitle.bold())
        ScrollView(.horizontal, showsIndicators: false) { HStack {
            ForEach(filters, id: \.1) { label, id in
                Button(label) { filter = id }.padding(.horizontal, 14).padding(.vertical, 10)
                    .background(filter == id ? Brand.accent : Brand.card, in: Capsule()).foregroundStyle(filter == id ? Color.black : Color.primary)
                    .accessibilityAddTraits(filter == id ? .isSelected : [])
            }
        } }
        Toggle("Real money", isOn: $realOnly)
        Picker("Sort posts", selection: $mostLiked) { Text("Latest").tag(false); Text("Most liked").tag(true) }.pickerStyle(.segmented)
        if mostLiked && (counts.error != nil || counts.value?["read"].bool != true) { Text("Likes unavailable. Showing the latest posts; unread counts are not zero.").font(.caption).foregroundStyle(.orange) }
        Remote(path: "/api/theses", interval: 10) { data in
            let rendered = presentation(data)
            if data["source"].string == "none" { Text("The feed could not be read.").foregroundStyle(.orange) }
            else if let rows = rendered {
                if rows.isEmpty {
                    ContentUnavailableView(data["theses"].array.isEmpty ? "No theses yet" : "No posts match these filters", systemImage: "text.bubble")
                    if !data["theses"].array.isEmpty { Button("Show everything") { filter = "all"; realOnly = false; mostLiked = false } }
                }
                Rows(values: rows) { FeedBeatCard(beat: $0) }
            } else { Text("Feed presentation could not be loaded. Try reopening this screen.").foregroundStyle(.orange) }
        }
    }.task(id: phase == .active) {
        guard phase == .active else { return }
        repeat { await counts.load(store.api, "/api/like-counts"); do { try await Task.sleep(for: .seconds(20)) } catch { return } } while !Task.isCancelled
    }.onChange(of: store.likes) { _, _ in Task { await counts.load(store.api, "/api/like-counts") } } }
    private func presentation(_ data: J) -> [J]? {
        let read = counts.error == nil && counts.value?["read"].bool == true
        let knownCounts = read ? counts.value?["counts"] ?? .object([:]) : .object([:])
        let fields: [String: J] = ["rows": data["theses"], "pill": .string(filter), "realOnly": .bool(realOnly), "following": .array(store.following.sorted().map(J.string)), "mostLiked": .bool(mostLiked && read), "counts": knownCounts]
        return engine.rows(.object(fields))
    }
}

struct ThesisCard: View {
    @EnvironmentObject var store: AppStore
    let thesis: J
    var body: some View { Card {
        Button { if let slug = thesis["slug"].string { store.path.append(.agent(slug)) } } label: {
            HStack { Avatar(slug: thesis["slug"].string); VStack(alignment: .leading) { Text(thesis["name"].string ?? "Agent").font(.headline); Text(thesis["symbol"].text).font(.caption).foregroundStyle(.secondary) }; Spacer() }
        }.buttonStyle(.plain)
        if !thesis["head"].text.isEmpty { Text(thesis["head"].text).font(.title3.bold()) }
        Text(thesis["post"].string ?? thesis["reason"].string ?? "No thesis text was published.").textSelection(.enabled)
        if thesis["post"].string != nil, let reason = thesis["reason"].string { DisclosureGroup("Why") { Text(reason) } }
        if let time = thesis["at"].number { Text(Date(timeIntervalSince1970: time), style: .relative).font(.caption).foregroundStyle(.secondary) }
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
    @State private var query = ""
    @State private var saved = false
    var body: some View { Page {
        Toggle("Watchlist only", isOn: $saved)
        MarketActivity(query: query, saved: saved)
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
        AsyncImage(url: URL(string: "https://app.merrymen.dev/api/agent-image/\(escaped(slug))/banner?v=\(store.imageRevision.uuidString)")) { image in image.resizable().scaledToFill().frame(height: 140).clipped() } placeholder: { Rectangle().fill(Brand.card).frame(height: 70) }
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
            if a["gasless"].bool == true && a["mode"].text != "paper" { Label("All landed operations this period were gas sponsored", systemImage: "checkmark.seal").font(.caption) }
            AgentDetails(agent: a)
        }
        Text("Holdings").font(.title2.bold())
        if a["publicBook"].bool != true { Text("This agent’s holdings are private.").foregroundStyle(.secondary) }
        else if a["holdingsRead"].bool != true { Text("Holdings could not be read.").foregroundStyle(.orange) }
        else { Rows(values: a["holdings"].array) { row in Card {
            if let token = row["token"].string { NavigationLink(row["symbol"].text, value: Route.token(token)) } else { Text(row["symbol"].text) }
            Metric(label: "Value", value: usd(row["valueUsdg"].number))
            Metric(label: "Return", value: bps(row["pnlBps"].number))
            Metric(label: "Share of book", value: bps(row["shareBps"].number))
            if let held = row["heldSince"].number { HStack { Text("Held since"); Text(Date(timeIntervalSince1970: held), style: .date) }.font(.caption) }
            if row["basisSource"].text == "quote" { Text("Entry cost is an estimate.").font(.caption).foregroundStyle(.orange) }
            if row["acting"].bool == true { Text("A corporate action is pending.").font(.caption).foregroundStyle(.orange) }
            if row["priceStale"].bool == true { Text("Stale price").font(.caption).foregroundStyle(.orange) }
        } } }
        ProfileActivity(slug: slug, agent: a)
        Text("Theses").font(.title2.bold())
        if a["thesesRead"].bool == false { Text("Theses could not be read.") }
        Rows(values: a["theses"].array) { ThesisCard(thesis: $0) }
    } }.navigationTitle("Agent") }
}

struct TokenScreen: View {
    @EnvironmentObject var store: AppStore
    let address: String
    @State private var span = "1h"
    @State private var activity = false
    var body: some View { Page {
        HStack {
            Button { store.toggleWatch(address) } label: { Label(store.watchlist.contains(address) ? "Watching" : "Watch", systemImage: store.watchlist.contains(address) ? "star.fill" : "star") }
            Spacer(); ShareLink(item: API.origin.appendingPathComponent("t/\(address)"))
        }
        Picker("Chart bars", selection: $span) { ForEach(["15m", "1h", "4h", "1d"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
        Remote(path: "/api/tokens/\(escaped(address))?window=\(span)&activity=\(activity ? "1" : "0")") { token in
            let market = token["market"]
            let m = market["stock"] == .null ? market["coin"] : market["stock"]
            Card {
                Text(market["symbol"].string ?? token["ledger"]["symbol"].string ?? "Token").font(.largeTitle.bold())
                Text(tokenPrice(m["priceUsd"].number)).font(.largeTitle).monospacedDigit()
                Text(m["name"].text).foregroundStyle(.secondary)
                if market["read"].text != "found" { Text(market["read"].text == "unread" ? "Market data could not be read." : "Not found in the index feeds checked.").foregroundStyle(.orange) }
                CandleChart(data: token["candles"], token: address)
                Metric(label: "24h change", value: m["change24hPct"].number.map { "\($0)%" } ?? "—")
                if let symbol = market["symbol"].string, market["symbolClash"].bool != true {
                    Button("Trade \(symbol)") { store.path.append(.tradeRequest(symbol, "buy", "", address)) }.buttonStyle(PrimaryButtonStyle())
                }
                if m["onCurve"].bool == true { Text("On its launch curve. Reported reserve includes a virtual seed and is not available exit liquidity.").font(.caption).foregroundStyle(.orange) }
                else if m["reserveUsd"] != .null { Metric(label: "Indexed pool reserve", value: usd(m["reserveUsd"].number)) }
                if market["symbolClash"].bool == true { Text("This ticker also belongs to another asset. Match the contract address before trading.").foregroundStyle(.orange) }
            }
            Text(address).font(.caption.monospaced()).textSelection(.enabled)
            Button("Copy address") { UIPasteboard.general.string = address }
            if market["coin"] != .null {
                Toggle("Load recent pool trades", isOn: $activity)
                TokenActivity(coin: market["coin"], evidence: token["evidence"], token: address, showTrades: activity)
                Button("Find this coin for an order") { store.path.append(.snipe(address, "")) }.buttonStyle(PrimaryButtonStyle())
            }
            Text("Holders & activity").font(.title2.bold())
            if token["ledger"]["fillsRead"].bool != true { Text("Entry-fill history could not be read.").foregroundStyle(.orange) }
            Rows(values: token["ledger"]["holders"].array) { row in Card {
                if let slug = row["slug"].string { NavigationLink(row["name"].text, value: Route.agent(slug)) } else { Text(row["name"].text) }
                Metric(label: row["paper"].bool == true ? "Paper holding" : "Holding", value: usd(row["valueUsdg"].number))
                Metric(label: "Entry price", value: tokenPrice(row["entryPriceUsd"].number))
                Text(row["basisSource"].string ?? "Basis unavailable").font(.caption).foregroundStyle(.secondary)
            } }
            if let count = token["ledger"]["privateHolders"].number, count > 0 { Text("\(Int(count)) holders keep their books private.").font(.caption) }
        }.id("\(span)|\(activity)")
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
        Metric(label: "Price", value: tokenPrice(row["priceUsd"].number))
        Metric(label: "24h volume (index)", value: usd(row["volume24hUsd"].number))
        Metric(label: "24h buyers", value: row["buyers24h"].number.map { $0.formatted() } ?? "—")
        Metric(label: "Fully diluted value (index)", value: usd(row["fdvUsd"].number))
        if let days = row["ageDays"].number { Metric(label: "Age in days", value: days.formatted()) }
        if row["graduated"].bool == true { Text("Graduated to a pool").font(.caption) }
        if row["onCurve"].bool == true { Text("On launch curve · reserve includes virtual liquidity").font(.caption).foregroundStyle(.orange) }
        else { Metric(label: "Indexed reserve", value: usd(row["reserveUsd"].number)) }
        if let reason = row["verdict"]["reason"].string { Text(reason) }
        if let conviction = row["verdict"]["conviction"].number { Metric(label: "Scout conviction (1–5)", value: conviction.formatted()); Text("Advisory ranking, not a trade size or safety rating.").font(.caption).foregroundStyle(.secondary) }
        if research {
            if row["research"] == .null { Text("Site research unavailable.").font(.caption) }
            else {
                Metric(label: "Published site reachable", value: row["research"]["siteReachable"].bool.map { $0 ? "Yes" : "No" } ?? "Unknown")
                Metric(label: "Site names contract", value: row["research"]["siteNamesContract"].bool.map { $0 ? "Yes" : "No" } ?? "Unknown")
                Metric(label: "Site text length", value: row["research"]["siteTextLength"].number.map { $0.formatted() } ?? "Unknown")
                Metric(label: "Outbound domains", value: row["research"]["siteOutboundDomains"].number.map { $0.formatted() } ?? "Unknown")
                Metric(label: "Hype words", value: row["research"]["siteHypeWords"].number.map { $0.formatted() } ?? "Unknown")
                Metric(label: "No description or socials", value: row["research"]["publishedNothing"].bool.map { $0 ? "Yes" : "No" } ?? "Unknown")
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
    var showMoney = false
    var body: some View { Card {
        Text("\(trade["action"].text.capitalized) \(trade["displayName"].string ?? trade["symbol"].string ?? "token")").font(.headline)
        if let at = trade["at"].number { Text(Date(timeIntervalSince1970: at), style: .relative).font(.caption).foregroundStyle(.secondary) }
        if trade["paper"].bool == true { Text("PAPER").font(.caption).foregroundStyle(.orange) }
        if trade["action"].text == "sell" {
            Metric(label: "Return", value: bps(trade["realizedPnlBps"].number))
            if trade["realizedPnlBps"].number == nil { Text("A return is unavailable without an evidenced entry cost.").font(.caption).foregroundStyle(.secondary) }
        }
        if showMoney, let amount = trade["sizeUsdg"].number { Metric(label: "Size", value: usd(amount)) }
        if showMoney, let profit = trade["realizedPnlUsdg"].number { Metric(label: "Realized P&L", value: usd(profit)) }
    } }
}
