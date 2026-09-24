import SwiftUI

struct HomeScreen: View {
    @EnvironmentObject var store: AppStore
    var body: some View { Page {
        if store.owner == nil { SignInCard() }
        else {
            Remote(path: "/api/feed") { feed in
                Card {
                    Text(feed["agent"]["name"].string ?? "Your portfolio").font(.headline)
                    Text(usd(feed["equity"].array.last?["equity_usdg"].number)).font(.system(size: 40, weight: .medium, design: .rounded)).monospacedDigit()
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
            }
        }
        Button { store.path.append(.markets) } label: { Label("Explore markets", systemImage: "chart.bar.xaxis") }.buttonStyle(.borderedProminent)
        Text("The leaderboard").font(.title2.bold())
        Remote(path: "/api/leaderboard") { data in
            if data["source"].string == "none" { Text("Rankings are temporarily unavailable.") }
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
        Button(store.following.contains(slug) ? "Unfollow agent" : "Follow agent") { Task { await store.toggleFollow(slug) } }.buttonStyle(.borderedProminent).disabled(store.owner == nil)
        Card {
            Metric(label: "Evidenced return", value: bps(a["pnlBps"].number))
            if let reason = a["unrankedWhy"].string { Text(reason.replacingOccurrences(of: "-", with: " ")).font(.caption).foregroundStyle(.secondary) }
            if a["mode"].text == "paper" { Metric(label: "Paper return", value: bps(a["paperPnlBps"].number)) }
            Metric(label: "Completed trades", value: a["tradesRead"].bool == true ? a["landed"].text : "—")
            Metric(label: "Paper fills", value: a["tradesRead"].bool == true ? a["filledPaper"].text : "—")
            if a["contributionsEvidenced"].bool == true && a["equityRead"].bool == true { TrendChart(values: a["growth"].array.compactMap { $0["g"].number }) }
        }
        Text("Holdings").font(.title2.bold())
        if a["publicBook"].bool != true { Text("This agent’s holdings are private.").foregroundStyle(.secondary) }
        else if a["holdingsRead"].bool != true { Text("Holdings could not be read.").foregroundStyle(.orange) }
        else { Rows(values: a["holdings"].array) { row in Metric(label: row["symbol"].text, value: usd(row["valueUsdg"].number)) } }
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
            let m = token["market"]
            Card {
                Text(m["symbol"].string ?? "Token").font(.largeTitle.bold())
                Text(usd(m["priceUsd"].number)).font(.largeTitle).monospacedDigit()
                Text(m["name"].text).foregroundStyle(.secondary)
                TrendChart(values: token["candles"].array.compactMap { $0["close"].number ?? $0["c"].number })
                Metric(label: "24h change", value: m["change24hPct"].number.map { "\($0)%" } ?? "—")
                Button("Trade") { store.path.append(.trade(m["symbol"].text)) }.buttonStyle(.borderedProminent).disabled(m["symbol"].text.isEmpty)
            }
            Text(address).font(.caption.monospaced()).textSelection(.enabled)
            Button("Copy address") { UIPasteboard.general.string = address }
            Text("Holders & activity").font(.title2.bold())
            Rows(values: token["ledger"]["holders"].array) { row in Metric(label: row["name"].string ?? row["slug"].text, value: usd(row["valueUsdg"].number)) }
            Rows(values: token["ledger"]["trades"].array) { row in Metric(label: row["side"].text + " " + row["name"].text, value: usd(row["usd"].number)) }
        }.id(span)
    }.navigationTitle("Token") }
}

struct AlphaScreen: View {
    var body: some View { Page { Text("Alpha").font(.largeTitle.bold()); Remote(path: "/api/alpha") { a in
        if a["locked"].bool != false {
            Card { Label("The Merry Circle", systemImage: "lock.fill").font(.headline); Text(a["why"].text == "unreachable" ? "Your eligibility could not be checked. Try again shortly." : "Sign in and meet the Circle holding requirement to read vetted opportunities."); NavigationLink("View membership", value: Route.circle) }
        } else if a["indexUnreachable"].bool == true { Text("The Alpha index could not be read.").foregroundStyle(.orange) }
        else { Rows(values: a["picks"].array) { row in Card { Text(row["symbol"].string ?? row["name"].text).font(.title2); Text(row["thesis"].string ?? row["reason"].text); if let address = row["address"].string { NavigationLink("View token", value: Route.token(address)) } } } }
    } } }
}
