import SwiftUI

struct TokenActivity: View {
    let coin: J
    let evidence: J
    let token: String
    let showTrades: Bool
    var body: some View { Card {
        Text("Market activity").font(.title2.bold())
        Text("\(coin["venue"].text) · indexed pool data").font(.caption).foregroundStyle(.secondary)
        Text(coin["onCurve"].bool == true ? "Curve reserves include virtual liquidity and are not an available exit quote." : "Indexed liquidity is not a guaranteed execution price.").font(.caption).foregroundStyle(.secondary)
        ForEach([("m5", "5m"), ("h1", "1h"), ("h6", "6h"), ("h24", "24h")], id: \.0) { key, title in
            DisclosureGroup(title + " reported window") {
                Metric(label: "Volume", value: usd(coin["buckets"][key]["volumeUsd"].number))
                Metric(label: "Buys", value: coin["buckets"][key]["buys"].number.map { $0.formatted() } ?? "—")
                Metric(label: "Sells", value: coin["buckets"][key]["sells"].number.map { $0.formatted() } ?? "—")
            }
        }
        if showTrades { trades }
    } }
    @ViewBuilder private var trades: some View {
        Text("Recent pool buys & sells").font(.headline)
        Text("Public market trades, not your agent's fills. This indexed sample may omit trades.").font(.caption).foregroundStyle(.secondary)
        let tape = evidence["trades"]
        if evidence["token"].text.lowercased() != token.lowercased() || tape == .null || tape["failed"].bool == true {
            Text("Recent pool trades are unavailable.").foregroundStyle(.orange)
        } else {
            if let observed = tape["observedAt"].number { HStack { Text(Date().timeIntervalSince1970 * 1000 - observed > 120_000 ? "Older snapshot" : "Snapshot"); Text(Date(timeIntervalSince1970: observed / 1000), style: .relative) }.font(.caption).foregroundStyle(.secondary) }
            if tape["data"].array.isEmpty { Text("No matching trades were returned in this sample.").font(.caption) }
            Rows(values: Array(tape["data"].array.prefix(12))) { trade in
                VStack(alignment: .leading, spacing: 6) {
                    Metric(label: trade["side"].text.capitalized, value: usd(trade["usd"].number))
                    Metric(label: "Token price", value: tokenPrice(trade["priceUsd"].number))
                    if let at = trade["time"].number { Text(Date(timeIntervalSince1970: at), style: .time).font(.caption) }
                    if let tx = trade["tx"].string, tx.range(of: "^0x[0-9a-fA-F]{64}$", options: .regularExpression) != nil,
                       let url = URL(string: "https://robinhoodchain.blockscout.com/tx/\(tx)") { Link("View market transaction", destination: url).font(.caption) }
                }.padding(.vertical, 5)
            }
        }
    }
}
