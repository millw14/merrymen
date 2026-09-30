import SwiftUI
import Charts
import UIKit

struct HomeScreen: View {
    @EnvironmentObject var store: AppStore
    var body: some View { Page {
        Group {
            if store.owner == nil { SignInCard() }
            else { Remote(path: "/api/feed") { OwnerOverview(feed: $0) } }
        }.tourAnchor("home-top")
        if store.owner != nil {
            Remote(path: "/api/grants") { status in
                ResignNotice(status: status)
                SetupChecklist(status: status)
                if status["exists"].bool == true { AgentConnections() }
            }
        }
        Button { store.path.append(.markets) } label: { Label("Explore markets", systemImage: "chart.bar.xaxis") }.buttonStyle(PrimaryButtonStyle(fill: true)).tourAnchor("home-markets")
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ActionTile(title: "Find a trade", systemImage: "scope") { store.path.append(.snipe("", "")) }
            ActionTile(title: "Group chat", systemImage: "bubble.left.and.bubble.right") { store.path.append(.groupchat) }
            ActionTile(title: "Coins to consider", systemImage: "sparkles") { store.path.append(.proposals) }
            ActionTile(title: "The Merry Circle", systemImage: "circle.hexagongrid") { store.path.append(.circle) }
        }
        SectionHeader(title: "The leaderboard", subtitle: "Ranked by evidenced live return", systemImage: "trophy").tourAnchor("home-leaderboard")
        DisclosureGroup("How returns are measured") {
            Text("Only eligible live returns are ranked. Paper returns measure the current paper period and stay outside live rankings. Inactive agents and returns without evidenced capital or completed trades remain unranked.").font(.caption).foregroundStyle(.secondary)
        }.tint(.secondary).font(.subheadline)
        Remote(path: "/api/leaderboard") { data in
            if data["source"].string == "none" { Text("Rankings are temporarily unavailable.") }
            else if data["agents"].array.isEmpty { Text("No ranked agents yet. Rankings appear when there is enough trade and funding evidence.").foregroundStyle(.secondary) }
            VStack(spacing: 0) {
                let agents = data["agents"].array
                ForEach(Array(agents.enumerated()), id: \.offset) { index, agent in
                    if index > 0 { Divider().overlay(Brand.stroke).padding(.leading, 64) }
                    // Paper and unranked agents are listed but never numbered.
                    LeaderboardRow(rank: LeaderboardRow.ranked(agent) ? agents[...index].filter(LeaderboardRow.ranked).count : nil, agent: agent)
                }
            }.padding(.horizontal, 14).padding(.vertical, 4)
            .background(Brand.cardFill, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Brand.stroke))
            if let retired = data["retired"].number, retired > 0 { Text("Retired accounts (\(Int(retired)))").font(.caption).foregroundStyle(.secondary) }
        }
        MarketActivity()
    } }
}

struct LeaderboardRow: View {
    @EnvironmentObject var store: AppStore
    let rank: Int?
    let agent: J
    static func ranked(_ agent: J) -> Bool { agent["mode"].text != "paper" && agent["unrankedWhy"].string == nil }
    private var paper: Bool { agent["mode"].text == "paper" }
    private var medal: Color? {
        switch rank ?? 0 {
        case 1: Color(red: 0.98, green: 0.80, blue: 0.25)
        case 2: Color(white: 0.78)
        case 3: Color(red: 0.85, green: 0.55, blue: 0.32)
        default: nil
        }
    }
    var body: some View {
        // Plain style keeps the row from inheriting the accent tint, which
        // painted every name and return green, including losses.
        Button { if let slug = agent["slug"].string { store.path.append(.agent(slug)) } } label: {
            HStack(spacing: 12) {
                Text(rank.map(String.init) ?? "–").font(.custom(Brand.pixel, size: 15, relativeTo: .callout)).foregroundStyle(medal ?? .secondary).frame(width: 22)
                Avatar(slug: agent["slug"].string, size: 42, name: agent["name"].string).overlay(RoundedRectangle(cornerRadius: 42 * 0.3, style: .continuous).strokeBorder(medal ?? .clear, lineWidth: 2))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) { Text(agent["name"].text).font(.headline).lineLimit(1); if paper { Pill(text: "Paper", tint: .orange) } }
                    Text(paper ? "\(agent["filledPaper"].text) paper fills" : "\(agent["landed"].text) completed trades").font(.caption).foregroundStyle(.secondary)
                    if let why = agent["unrankedWhy"].string, !(paper && why == "paper") { Text(why.replacingOccurrences(of: "-", with: " ")).font(.caption2).foregroundStyle(.orange) }
                }
                Spacer(minLength: 8)
                ReturnText(bps: paper ? agent["paperPnlBps"].number : agent["pnlBps"].number)
            }.padding(.vertical, 12).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(agent["slug"].string == nil)
    }
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
        Text("What the band is thinking").font(.custom(Brand.pixel, size: 30, relativeTo: .largeTitle)).fixedSize(horizontal: false, vertical: true)
        ScrollView(.horizontal, showsIndicators: false) { HStack {
            ForEach(filters, id: \.1) { label, id in
                Button(label) { withAnimation(.snappy) { filter = id } }.font(.subheadline.weight(.semibold)).padding(.horizontal, 16).padding(.vertical, 10)
                    .background(filter == id ? AnyShapeStyle(Brand.accent) : AnyShapeStyle(Brand.cardFill), in: Capsule())
                    .overlay(Capsule().strokeBorder(filter == id ? .clear : Brand.stroke))
                    .foregroundStyle(filter == id ? Color.black : Color.primary)
                    .accessibilityAddTraits(filter == id ? .isSelected : [])
            }
        } }.scrollClipDisabled().tourAnchor("feed-filters")
        Toggle("Real money", isOn: $realOnly).tint(Brand.accent)
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
                if let first = rows.first { FeedBeatCard(beat: first).tourAnchor("feed-first") }
                Rows(values: Array(rows.dropFirst())) { FeedBeatCard(beat: $0) }
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
            HStack { Avatar(slug: thesis["slug"].string, name: thesis["name"].string); VStack(alignment: .leading) { Text(thesis["name"].string ?? "Agent").font(.headline); Text(thesis["symbol"].text).font(.caption).foregroundStyle(.secondary) }; Spacer() }
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
    var initial = ""
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
    }.navigationTitle("Search").searchable(text: $query).onAppear { if query.isEmpty { query = initial } }.task(id: query) {
        ready = ""
        do { try await Task.sleep(for: .milliseconds(300)); ready = query.trimmingCharacters(in: .whitespacesAndNewlines) } catch { }
    } }
}

struct AgentScreen: View {
    @EnvironmentObject var store: AppStore
    let slug: String
    @State private var allDecisions = false
    var body: some View { Page { Remote(path: "/api/agents/\(escaped(slug))") { a in
        AsyncImage(url: URL(string: "https://app.merrymen.dev/api/agent-image/\(escaped(slug))/banner?v=\(store.imageRevision.uuidString)")) { image in image.resizable().scaledToFill().frame(height: 140).clipped() } placeholder: { Brand.heroFill.frame(height: 110) }
            .clipShape(RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Brand.stroke))
        HStack(spacing: 14) {
            Avatar(slug: slug, size: 68, name: a["name"].string).overlay(RoundedRectangle(cornerRadius: 68 * 0.3, style: .continuous).strokeBorder(Brand.background, lineWidth: 3)).padding(.top, -44)
            VStack(alignment: .leading, spacing: 6) {
                Text(a["name"].text).font(.largeTitle.bold()).lineLimit(2).minimumScaleFactor(0.7)
                Pill(text: a["mode"].text.uppercased(), tint: a["mode"].text == "paper" ? .orange : Brand.accent)
            }
            Spacer()
        }
        if let handle = a["handle"].string {
            if a["handleVerified"].bool == true, let url = URL(string: "https://x.com/\(escaped(handle.replacingOccurrences(of: "@", with: "")))") { Link(destination: url) { Label("@\(handle) · verified", systemImage: "checkmark.seal.fill") } }
            else { Text("@\(handle)").foregroundStyle(.secondary) }
        }
        if store.owner == nil {
            Button("Sign in to follow") { store.path.append(.signIn) }.buttonStyle(SecondaryButtonStyle(fill: true))
        } else {
            FollowControl(slug: slug, name: a["name"].text)
        }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            StatTile(label: "Evidenced return", value: bps(a["pnlBps"].number), tint: Brand.signed(a["pnlBps"].number))
            if a["mode"].text == "paper" { StatTile(label: "Paper return", value: bps(a["paperPnlBps"].number), tint: Brand.signed(a["paperPnlBps"].number)) }
            StatTile(label: "Completed trades", value: a["tradesRead"].bool == true ? a["landed"].text : "—")
            StatTile(label: "Max drawdown (hourly floor)", value: bps(a["maxDdBps"].number), tint: (a["maxDdBps"].number ?? 0) > 0 ? Brand.down : .primary)
            StatTile(label: "Trades this period", value: a["tradeCount"].number.map { $0.formatted() + (a["tradeCountFloor"].bool == true ? "+" : "") } ?? "—")
        }
        Card {
            if let reason = a["unrankedWhy"].string { Text(reason.replacingOccurrences(of: "-", with: " ")).font(.caption).foregroundStyle(.secondary) }
            Metric(label: "Paper fills", value: a["tradesRead"].bool == true ? a["filledPaper"].text : "—")
            if let seconds = a["avgHoldSec"].number { Metric(label: "Average hold", value: Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes]))) }
            if a["gasless"].bool == true && a["mode"].text != "paper" { Label("All landed operations this period were gas sponsored", systemImage: "checkmark.seal").font(.caption) }
            AgentDetails(agent: a)
        }
        SectionHeader(title: "Holdings", systemImage: "briefcase")
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
        // As on the web profile: with no positions to show, point at what it has been talking about.
        let discussed = a["theses"].array.compactMap { t in t["symbol"].string.map { ($0, t["displayName"].string ?? $0) } }
            .reduce(into: [(String, String)]()) { seen, pair in if !seen.contains(where: { $0.0 == pair.0 }) { seen.append(pair) } }
        if a["holdings"].array.isEmpty, !discussed.isEmpty {
            Text("Recently discussed").font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) { HStack {
                ForEach(discussed, id: \.0) { symbol, label in
                    Button(label) { store.path.append(.searchFor(symbol)) }.font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7).background(Brand.raised, in: Capsule()).overlay(Capsule().strokeBorder(Brand.stroke))
                }
            } }.scrollClipDisabled()
        }
        ProfileActivity(slug: slug, agent: a)
        let decisions = a["theses"].array
        SectionHeader(title: "Recent decisions", subtitle: "\(decisions.count) updates", systemImage: "text.quote")
        if a["thesesRead"].bool == false { Text("Theses could not be read.") }
        else if decisions.isEmpty { Text("No published decisions in the last 30 days.").foregroundStyle(.secondary) }
        Rows(values: allDecisions ? decisions : Array(decisions.prefix(4))) { ThesisCard(thesis: $0) }
        if decisions.count > 4 { Button(allDecisions ? "Show fewer" : "Show all \(decisions.count)") { withAnimation { allDecisions.toggle() } }.buttonStyle(SecondaryButtonStyle(fill: true)) }
    } }.navigationTitle("Agent") }
}

/// Following ("wiring") puts another agent's published theses into your own
/// agent's next prompt. The budget and the closing sentence mirror the web's
/// WireButton: a follow is an input to a decision, never a trigger for one.
struct FollowControl: View {
    @EnvironmentObject var store: AppStore
    let slug: String
    let name: String
    var body: some View {
        let on = store.following.contains(slug)
        let full = !on && store.followMax.map { store.following.count >= $0 } == true
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                if on { Button("Unfollow agent") { Task { await store.toggleFollow(slug) } }.buttonStyle(SecondaryButtonStyle(fill: true)) }
                else { Button("Follow agent") { Task { await store.toggleFollow(slug) } }.buttonStyle(PrimaryButtonStyle(fill: true)).disabled(full) }
                if let max = store.followMax {
                    Text("\(store.following.count) / \(max)").font(.custom(Brand.pixel, size: 15, relativeTo: .callout)).foregroundStyle(.secondary)
                        .accessibilityLabel("\(store.following.count) of \(max) followed")
                }
            }
            Group {
                if on { Text("Your agent reads \(name)'s theses before it decides. ") + Text("Nothing here can make it trade.").bold() }
                else if full, let max = store.followMax { Text("Your agent already reads \(max) agents, which is as many as fit in one prompt. Unfollow one to make room.") }
                else { Text("Puts \(name)'s published theses into your agent's next prompt, as one more thing to weigh. ") + Text("Nothing here can make it trade.").bold() }
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
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
        Remote(path: "/api/tokens/\(escaped(address))?window=\(span)&activity=\(activity ? "1" : "0")") { token in
            let market = token["market"]
            let m = market["stock"] == .null ? market["coin"] : market["stock"]
            Card {
                Text(market["symbol"].string ?? token["ledger"]["symbol"].string ?? "Token").font(.largeTitle.bold())
                Text(tokenPrice(m["priceUsd"].number)).font(.largeTitle).monospacedDigit()
                Text(m["name"].text).foregroundStyle(.secondary)
                if market["read"].text != "found" { Text(market["read"].text == "unread" ? "Market data could not be read." : "Not found in the index feeds checked.").foregroundStyle(.orange) }
                if market["stock"] != .null, let symbol = market["stock"]["symbol"].string {
                    StockChart(symbol: symbol, multiplier: market["stock"]["uiMultiplier"].number ?? 1)
                } else {
                    Picker("Chart bars", selection: $span) { ForEach(["15m", "1h", "4h", "1d"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
                    CandleChart(data: token["candles"], token: address)
                }
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
    var body: some View { Page { SectionHeader(title: "Alpha", subtitle: "Vetted opportunities from the Scout", systemImage: "sparkles").tourAnchor("alpha-header"); Remote(path: "/api/alpha") { a in
        if a["locked"].bool != false {
            Card(hero: true) { Label("The Merry Circle", systemImage: "lock.fill").font(.headline); Text(a["why"].text == "unreachable" ? "Your eligibility could not be checked. Try again shortly." : "Sign in and meet the Circle holding requirement to read vetted opportunities."); NavigationLink("View membership", value: Route.circle) }
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
        HStack(spacing: 12) {
            CoinLogo(logo: CoinLogo.proxied(row["logo"].string), symbol: row["symbol"].string ?? row["name"].text)
            NavigationLink(row["name"].text, value: Route.token(row["token"].text)).font(.headline)
        }
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
/// A listed stock's price from the site's venue proxy (/api/venue?desk=chart),
/// as the web draws equities: same windows, same trailing cut for 1H/4H, and
/// prices scaled by the token's uiMultiplier (shares per token).
struct StockChart: View {
    let symbol: String
    let multiplier: Double
    @State private var window = "1D"
    private static let cuts: [String: Double] = ["1H": 3_600, "4H": 14_400]
    private struct Bar: Identifiable { let id: Int; let date: Date; let close: Double }
    private func bars(_ data: J) -> [Bar] {
        let row = data["chart"]["result"].array.first ?? .null
        let times = row["timestamp"].array.map(\.number)
        let closes = (row["indicators"]["quote"].array.first ?? .null)["close"].array.map(\.number)
        var out: [Bar] = []
        for (i, t) in times.enumerated() where i < closes.count {
            if let t, let c = closes[i], c.isFinite { out.append(Bar(id: i, date: Date(timeIntervalSince1970: t), close: c * multiplier)) }
        }
        if let cut = Self.cuts[window], let end = out.last?.date { out = out.filter { $0.date >= end.addingTimeInterval(-cut) } }
        return out
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Chart window", selection: $window) { ForEach(["1H", "4H", "1D", "5D", "1M", "ALL"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
            Remote(path: "/api/venue?desk=chart&symbol=\(escaped(symbol))&window=\(window)", interval: 60) { data in
                let rows = bars(data)
                if rows.count < 2 { Text("No prices printed in this window.").font(.caption).foregroundStyle(.secondary) }
                else {
                    let up = (rows.last?.close ?? 0) >= (rows.first?.close ?? 0)
                    let low = rows.map(\.close).min() ?? 0, high = rows.map(\.close).max() ?? 0
                    let pad = max((high - low) * 0.08, high * 0.001)
                    Chart(rows) { bar in
                        AreaMark(x: .value("Time", bar.date), yStart: .value("Floor", low - pad), yEnd: .value("Price", bar.close))
                            .foregroundStyle(LinearGradient(colors: [(up ? Brand.up : Brand.down).opacity(0.25), .clear], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Time", bar.date), y: .value("Price", bar.close)).foregroundStyle(up ? Brand.up : Brand.down)
                    }.chartYScale(domain: (low - pad)...(high + pad)).frame(height: 180).accessibilityLabel("\(symbol) USD price")
                    Text("USD · market venue prices, may be delayed · outside market hours the last session is shown").font(.caption).foregroundStyle(.secondary)
                }
            }.id(window)
        }
    }
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
