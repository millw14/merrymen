import SwiftUI
import Charts

struct AgentDetails: View {
    let agent: J
    @StateObject private var engine = FeedPresentation()
    @State private var picked: String?
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { time in
            let input: J = .object(["agent": agent, "picked": picked.map(J.string) ?? .null, "nowSec": .number(time.date.timeIntervalSince1970)])
            if let view = engine.profile(input) {
                if !view["approach"].text.isEmpty { Text(view["approach"].text).font(.callout).foregroundStyle(.secondary) }
                if let beat = agent["beatAt"].number {
                    HStack { Text("Last heartbeat"); Text(Date(timeIntervalSince1970: beat), style: .relative) }.font(.caption).foregroundStyle(.secondary)
                }
                if let joined = agent["joinedAt"].number {
                    Text("Joined \(Date(timeIntervalSince1970: joined).formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.secondary)
                }
                if agent["mode"].text != "paper", agent["contributionsEvidenced"].bool == true, agent["equityRead"].bool == true { chart(view) }
            } else { Text("Profile presentation is unavailable.").font(.caption).foregroundStyle(.orange) }
        }
    }
    @ViewBuilder private func chart(_ view: J) -> some View {
        HStack {
            ForEach(Array(view["windows"].array.enumerated()), id: \.offset) { _, window in
                Button(window["id"].text) { picked = window["id"].string }
                    .buttonStyle(.bordered).tint(view["active"].text == window["id"].text ? Brand.accent : .gray)
                    .disabled(window["available"].bool != true)
                    .accessibilityAddTraits(view["active"].text == window["id"].text ? .isSelected : [])
            }
        }
        if view["slice"]["state"].text == "ok" {
            Chart(Array(view["points"].array.enumerated()), id: \.offset) { _, point in
                if let at = point["at"].number, let growth = point["g"].number {
                    LineMark(x: .value("Time", Date(timeIntervalSince1970: at)), y: .value("Growth index", growth)).foregroundStyle(Brand.accent)
                }
            }.frame(height: 130).chartYScale(domain: .automatic(includesZero: false)).accessibilityLabel("Time-weighted return history")
            Text("Chart: time-weighted return over \(view["words"].text), adjusted for deposits and withdrawals. It is calculated differently from the net return above.").font(.caption).foregroundStyle(.secondary)
        } else {
            Text(view["slice"]["state"].text == "partial" ? "Only the most recent part of this trading period was read." : "Not enough readings for this chart period.").font(.caption).foregroundStyle(.secondary)
        }
    }
}
