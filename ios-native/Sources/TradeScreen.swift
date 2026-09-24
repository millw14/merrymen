import SwiftUI
import MerrymenPolicy

struct TradeScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    let symbol: String
    @State private var side = "buy"
    @State private var amount = ""
    @State private var confirm = false
    @State private var confirmationBody: J?
    @State private var confirmationOwner: String?
    @State private var busy = false
    @State private var attempted = false
    @State private var orderId: String?
    @State private var result: J?
    @State private var error: String?
    private var key: String { "pendingOrder.\(store.owner?.lowercased() ?? "none")" }
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else {
                Card {
                    Text(symbol).font(.largeTitle.bold())
                    Picker("Side", selection: $side) { Text("Buy").tag("buy"); Text("Sell").tag("sell") }.pickerStyle(.segmented)
                    TextField("Amount in USDG, e.g. 5.00", text: $amount).keyboardType(.decimalPad)
                    Text("Use a dot and at most two decimal places. This asks the agent to trade; it still checks the signed caps, available assets, and risk limits.").font(.caption).foregroundStyle(.secondary)
                    Button("Review order") {
                        guard let owner = store.owner, let body = TradeInput.body(side: side, symbol: symbol, amount: amount, owner: owner) else { error = "Enter a valid ticker and positive amount in USDG, with at most two decimal places."; return }
                        confirmationOwner = owner; confirmationBody = body; confirm = true
                    }.buttonStyle(.borderedProminent).disabled(busy || attempted)
                }
                if busy { ProgressView("Submitting once…") }
                if let error { Text(error).foregroundStyle(Brand.down) }
                if let result { OrderResult(result: result) }
                if attempted {
                    Text("This request will never be resubmitted automatically. Status checks only read the ledger.").font(.caption).foregroundStyle(.secondary)
                    Button("Refresh order status") { Task { await readStatus() } }.disabled(busy)
                    if let result, ["done", "expired"].contains(result["state"].text), orderId != nil {
                        Button("Start another order") { clear() }
                    } else if orderId == nil {
                        Text("The submission outcome is uncertain. Check your agent's activity before considering another order.").foregroundStyle(.orange)
                    }
                }
            }
        }.navigationTitle("Trade")
        .task(id: "\(store.generation)|\(phase == .active)") {
            guard store.owner != nil, phase == .active else { return }
            if let saved = UserDefaults.standard.string(forKey: key) { attempted = true; orderId = saved == "unknown" ? nil : saved }
            // Detect an order placed on another device before enabling another request.
            await readStatus()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                if attempted && !busy { await readStatus() }
            }
        }
        .sheet(isPresented: $confirm) {
            NavigationStack { Page {
                Text("Confirm order").font(.title.bold())
                if let body = confirmationBody {
                    Metric(label: "Action", value: body["side"].text.capitalized)
                    Metric(label: "Asset", value: body["symbol"].text)
                    Metric(label: "USDG amount", value: usd(body["usdgAmount"].number))
                    Text(confirmationOwner ?? "").font(.caption.monospaced())
                    Text("This may move real funds when your agent is live. A queued order is not a completed trade.")
                    Button("Submit order") { submit(body) }.buttonStyle(.borderedProminent).disabled(busy)
                }
                Button("Cancel", role: .cancel) { confirm = false }.disabled(busy)
            } }.interactiveDismissDisabled(busy)
        }
    }
    private func submit(_ body: J) {
        guard !busy, !attempted else { return }; busy = true; error = nil
        let owner = confirmationOwner; let pendingKey = key
        Task { defer { busy = false; confirm = false }; do {
            try await store.verifyOwner(owner)
            // Durable before sending: a timeout or process kill must not silently enable retry.
            attempted = true; UserDefaults.standard.set("unknown", forKey: pendingKey)
            let placed = try await store.api.request("/api/orders", method: "POST", body: body)
            guard let id = placed["id"].string, placed["queued"].bool == true else { throw APIError(status: 0, message: "The server did not confirm an order identifier.") }
            orderId = id; UserDefaults.standard.set(id, forKey: pendingKey)
            result = .object(["state": .string("queued")]); await readStatus()
        } catch {
            self.error = error.localizedDescription
            // Validation/auth rejections are definitive; timeouts and server failures aren't.
            if let api = error as? APIError, [400, 401, 403].contains(api.status) { attempted = false; UserDefaults.standard.removeObject(forKey: pendingKey) }
        } }
    }
    private func readStatus() async {
        guard let owner = store.owner else { return }; let generation = store.generation
        do {
            var path = "/api/orders?owner=\(escaped(owner))"
            if let orderId { path += "&id=\(escaped(orderId))" }
            let status = try await store.api.request(path)
            guard generation == store.generation else { return }
            if ["queued", "running"].contains(status["state"].text), let id = status["id"].string {
                attempted = true; orderId = id; UserDefaults.standard.set(id, forKey: key)
            }
            result = status; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func clear() { UserDefaults.standard.removeObject(forKey: key); attempted = false; orderId = nil; result = nil; error = nil; amount = "" }
}

struct OrderResult: View {
    let result: J
    var body: some View {
        Card {
            Text("Order status").font(.headline)
            let state = result["state"].text
            Text(state == "none" ? "No order found" : state.capitalized)
            if let line = result["result"].string { Text(line) }
            if result["receipt"] != .null {
                Text(result["receipt"]["status"].text.capitalized).font(.headline)
                if result["receipt"]["paper"].bool == true { Text("Paper trade — simulated").foregroundStyle(.orange) }
                if let reason = result["receipt"]["reason"].string { Text(reason) }
            } else if state == "done" { Text("The worker completed the request. No structured fill receipt was returned.").font(.caption).foregroundStyle(.secondary) }
        }
    }
}
