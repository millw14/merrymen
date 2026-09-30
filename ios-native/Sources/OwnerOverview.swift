import SwiftUI

struct OwnerOverview: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var presentation = FeedPresentation()
    let feed: J
    var body: some View {
        if let view = presentation.overview(feed), view != .null {
            Card(hero: true) {
                Text(view["name"].text).font(.headline)
                Text("Portfolio balance").font(.caption).foregroundStyle(.secondary)
                Text(usd(view["equity"].number)).font(.custom("GeistPixel-Regular", size: 42, relativeTo: .largeTitle)).minimumScaleFactor(0.6).lineLimit(1)
                if let change = view["chg24"].number { Text("\(usd(change)) over 24 hours").foregroundStyle(change < 0 ? Brand.down : Brand.up) }
                TrendChart(values: view["history"].array.compactMap(\.number))
                Text("Recorded portfolio value includes deposits and withdrawals. Individual trades identify real and paper activity.").font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    Button("Add funds") { store.path.append(.deposit) }.buttonStyle(PrimaryButtonStyle(fill: true))
                    Button("Withdraw") { store.path.append(.withdraw) }.buttonStyle(SecondaryButtonStyle(fill: true))
                }
                if let notice = view["notice"]["message"].string { AgentNotice(message: notice) }
            }
            DisclosureGroup("Positions · \(view["positions"].array.count)") {
                if view["positions"].array.isEmpty { Text("No positions in this book.").foregroundStyle(.secondary) }
                Rows(values: view["positions"].array) { position in Card {
                    Metric(label: position["symbol"].text, value: position["detail"].text)
                    if let pct = position["pnl"].number { Metric(label: "Return on evidenced cost", value: bps(pct * 100)) }
                    NavigationLink("Review trade", value: Route.trade(position["symbol"].text))
                } }
            }
            DisclosureGroup("Recent trades · \(view["moves"].array.count)") {
                Rows(values: view["moves"].array) { move in Card {
                    Text("\(move["action"].string?.capitalized ?? "Activity") \(move["displayName"].string ?? move["symbol"].text)").font(.headline)
                    Metric(label: move["paper"].bool == true ? "PAPER" : move["outcome"].text.uppercased(), value: usd(move["sizeUsdg"].number))
                    if let at = move["at"].number { Text(Date(timeIntervalSince1970: at), style: .relative).font(.caption).foregroundStyle(.secondary) }
                    if let reason = move["reason"].string { Text(reason).font(.caption) }
                    if let outcome = move["outcomeText"].string { Text(outcome).font(.caption).foregroundStyle(.secondary) }
                    if move["action"].text == "sell", move["realizedVouched"].bool == true { Metric(label: "Realized P&L", value: usd(move["realizedPnlUsdg"].number)) }
                    if let hash = move["txHash"].string, hash.range(of: "^0x[0-9a-fA-F]{64}$", options: .regularExpression) != nil,
                       let url = URL(string: "https://robinhoodchain.blockscout.com/tx/\(hash)") { Link("View transaction", destination: url) }
                } }
            }
        } else { Text(feed["source"].text == "none" ? "The portfolio could not be read." : "No portfolio readings yet.").foregroundStyle(.secondary) }
    }
}

struct DailyUsage: View {
    @StateObject private var presentation = FeedPresentation()
    let grant: J
    var body: some View {
        Remote(path: "/api/feed") { feed in
            if let view = presentation.overview(feed), view != .null, let spent = view["spent"].number {
                Card {
                    Metric(label: "Recorded trading today", value: usd(spent))
                    if let cap = grant["caps"]["dailyUsdg"].number, cap > 0 {
                        ProgressView(value: min(spent, cap), total: cap).accessibilityLabel("Recorded daily trading usage")
                        Text("Daily signed limit: \(usd(cap))").font(.caption)
                    }
                    Text("Completed buys and sells in today's loaded ledger. Pending and paper orders are excluded; the trading permission enforces its own limits.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// "Your trading permission is out of date" — the web's ResignPrompt strip.
///
/// A grant signed before the current wall release keeps the old wall; the agent
/// looks armed but may refuse trades. This only navigates: the one signing
/// control stays on the trading-limits screen, which shows the change first.
struct ResignNotice: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var presentation = FeedPresentation()
    let status: J
    /// Exactly the renew screen's own guard (GrantScreen), so this never sends
    /// someone to a re-sign this app cannot perform.
    private var canSign: Bool {
        let grant = status["grant"]
        return store.privy != nil && grant["owner"].text.lowercased() == store.owner?.lowercased()
            && grant["chainId"].number == 4663 && grant["binding"]["version"].text == "privy-did-owner-v1"
    }
    var body: some View {
        if presentation.resignApplies(exists: status["exists"].bool, grantedAt: status["grant"]["grantedAt"].number, canSign: canSign) {
            Card {
                Label("Trading permission is out of date", systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.orange)
                Text("Signed before the last update. Your agent may refuse trades it looks able to make.")
                Text("Re-signing is free, takes one signature and moves nothing on-chain. You will see what changes before you sign.").font(.caption).foregroundStyle(.secondary)
                Button("Re-sign — free, one signature") { store.path.append(.limits) }.buttonStyle(PrimaryButtonStyle(fill: true))
            }.overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.orange.opacity(0.5)))
        }
    }
}

/// "Finish setting up" — the web's SetupChecklist, from the same status read.
struct SetupChecklist: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var presentation = FeedPresentation()
    let status: J
    var body: some View {
        let paper = status["mode"].string == "paper"
        if let step = presentation.setupStep(status: status, paper: paper), step != "done" {
            let created = status["exists"].bool == true
            Card {
                HStack { Text("Finish setting up").font(.headline); Spacer(); Text("\(created ? 1 : 0) of \(paper ? 1 : 2)").font(.custom(Brand.pixel, size: 14, relativeTo: .caption)).foregroundStyle(.secondary) }
                row(done: created, title: "Create your agent", detail: "A strategy and signed trading limits.", action: created ? nil : ("Create agent", .create))
                if !paper {
                    row(done: false, title: "Add trading funds",
                        detail: step == "unread" ? "We couldn't read your balance just now, so we can't say whether this is done." : "Fund your agent when you're ready.",
                        action: step == "fund" ? ("Add funds", .deposit) : nil)
                }
            }
        }
    }
    private func row(done: Bool, title: String, detail: String, action: (String, Route)?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle").foregroundStyle(done ? Brand.accent : .secondary).font(.title3).accessibilityLabel(done ? "Done" : "Not done")
            VStack(alignment: .leading, spacing: 2) { Text(LocalizedStringKey(title)).font(.subheadline.weight(.semibold)); Text(LocalizedStringKey(detail)).font(.caption).foregroundStyle(.secondary) }
            Spacer()
            if let action { Button(LocalizedStringKey(action.0)) { store.path.append(action.1) }.font(.subheadline.weight(.semibold)) }
        }
    }
}

/// A note the agent's worker left for its owner (for example, holdings it
/// refuses to price). Summarised in one line, with the agent's words behind a tap.
struct AgentNotice: View {
    let message: String
    @State private var open = false
    private var summary: String {
        message.hasPrefix("won't put a price on") ? "Some holdings are left unpriced, so this balance excludes them." : message.prefix(1).uppercased() + message.dropFirst()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
                    Text(summary).font(.caption.weight(.semibold)).foregroundStyle(.primary).multilineTextAlignment(.leading).lineLimit(open ? nil : 2)
                    Spacer(minLength: 4)
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                }
            }.buttonStyle(.plain)
            if open {
                Text(message.prefix(1).uppercased() + message.dropFirst()).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .padding(12).background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.3)))
    }
}
