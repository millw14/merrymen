import SwiftUI

struct ProfileActivity: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    let slug: String
    let agent: J
    @State private var own: J?
    @State private var session: API.SessionBinding?
    @State private var ownGeneration: Int?
    private var privateBook: J? {
        guard let session, store.api.matches(session), ownGeneration == store.generation, store.owner != nil else { return nil }
        return own
    }
    var body: some View {
        let book = privateBook ?? agent
        let showMoney = privateBook != nil || agent["publicBook"].bool == true
        VStack(alignment: .leading, spacing: 16) {
            if privateBook != nil && agent["publicBook"].bool != true { Text("Your private view. These trade sizes and dollars remain hidden from other viewers.").font(.caption).foregroundStyle(.secondary) }
            Text("Top trades").font(.title2.bold())
            if book["topTradesRead"].bool != true { Text("Top trades could not be read.").foregroundStyle(.orange) }
            else if book["topTrades"].array.isEmpty { Text("No closed trades yet.").foregroundStyle(.secondary) }
            else { Rows(values: book["topTrades"].array) { ProfileTradeCard(trade: $0, showMoney: showMoney) } }
            Text("Recent fills").font(.title2.bold())
            if book["activityRead"].bool != true { Text("Recent fills could not be read.").foregroundStyle(.orange) }
            else if book["recentTrades"].array.isEmpty { Text("No fills in this period.").foregroundStyle(.secondary) }
            else { Rows(values: book["recentTrades"].array) { ProfileTradeCard(trade: $0, showMoney: showMoney) } }
        }.privacySensitive(privateBook != nil)
        .task(id: "\(slug)|\(store.generation)|\(phase == .active)") {
            own = nil; session = nil
            guard store.owner != nil, phase == .active else { return }
            let generation = store.generation; let binding = store.api.binding()
            repeat {
                do {
                    let value = try await store.api.request("/api/agents/\(escaped(slug))/own", expectedSession: binding)
                    guard !Task.isCancelled, store.generation == generation, store.api.matches(binding) else { return }
                    own = value; session = binding; ownGeneration = generation
                } catch { own = nil; session = nil; return }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            } while !Task.isCancelled
        }
    }
}
