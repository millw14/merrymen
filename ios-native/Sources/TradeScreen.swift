import SwiftUI
import MerrymenPolicy

struct TradeScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    let symbol: String
    let address: String?
    @State private var side = "buy"
    @State private var amount = ""
    @State private var review: ReviewValue?
    @State private var busy = false
    @State private var attempted = false
    @State private var orderId: String?
    @State private var result: J?
    @State private var error: String?
    @State private var statusReady = false
    @State private var ceiling: Double?
    private var key: String { "pendingOrder.\(store.owner?.lowercased() ?? "none")" }
    init(symbol: String, side: String = "buy", amount: String = "", address: String? = nil) {
        self.symbol = symbol; self.address = address
        _side = State(initialValue: ["buy", "sell"].contains(side) ? side : "buy")
        _amount = State(initialValue: amount)
    }
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else {
                Card {
                    Text(symbol).font(.largeTitle.bold())
                    if let address { Text(address).font(.caption.monospaced()).textSelection(.enabled) }
                    Picker("Side", selection: $side) { Text("Buy").tag("buy"); Text("Sell").tag("sell") }.pickerStyle(.segmented)
                    TextField("Amount in USDG, e.g. 5.00", text: $amount).keyboardType(.decimalPad)
                    Text("Use at most two decimal places and no thousands separators. This asks the agent to trade; it still checks the signed caps, available assets, and risk limits.").font(.caption).foregroundStyle(.secondary)
                    Button("Review order") {
                        guard let owner = store.owner, let body = TradeInput.body(side: side, symbol: symbol, amount: amount, owner: owner) else { error = "Enter a valid ticker and positive amount in USDG, with at most two decimal places."; return }
                        guard let ceiling, body["usdgAmount"].number! <= ceiling else { error = "That amount exceeds your current order ceiling."; return }
                        review = ReviewValue(value: body)
                    }.buttonStyle(PrimaryButtonStyle()).disabled(busy || attempted || !statusReady || ceiling == nil)
                    Metric(label: "Current order ceiling", value: ceiling.map { usd($0) + " USDG" } ?? "Unread")
                }
                if busy { ProgressView("Submitting once…") }
                if let error { Text(error).foregroundStyle(Brand.down); Button("Retry status read") { Task { await readStatus() } }.disabled(busy) }
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
            do {
                if let old = UserDefaults.standard.string(forKey: key) { try savePending(old, key: key); UserDefaults.standard.removeObject(forKey: key) }
                if let data = try SecureStore.read("dev.merrymen.orders", key), let saved = String(data: data, encoding: .utf8) { attempted = true; orderId = saved == "unknown" ? nil : saved }
            } catch { self.error = error.localizedDescription; attempted = true; return }
            // Detect an order placed on another device before enabling another request.
            await readStatus()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                if attempted && !busy { await readStatus() }
            }
        }
        .sheet(item: $review) { selected in
            NavigationStack { Page {
                Text("Confirm order").font(.title.bold())
                let body = selected.value
                    Metric(label: "Action", value: body["side"].text.capitalized)
                    Metric(label: "Asset", value: body["symbol"].text)
                    if let address { Text(address).font(.caption.monospaced()).textSelection(.enabled) }
                    Metric(label: "USDG amount", value: usd(body["usdgAmount"].number))
                    Text(body["owner"].text).font(.caption.monospaced())
                    Text("This may move real funds when your agent is live. A queued order is not a completed trade.")
                    Button("Submit order") { submit(body) }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                Button("Cancel", role: .cancel) { review = nil }.disabled(busy)
            } }.interactiveDismissDisabled(busy)
        }
    }
    private func submit(_ body: J) {
        guard !busy, !attempted else { return }; busy = true; error = nil
        let owner = body["owner"].string; let pendingKey = key
        Task { defer { busy = false; review = nil }; do {
            try await store.verifyOwner(owner)
            // Durable before sending: a timeout or process kill must not silently enable retry.
            attempted = true; try savePending("unknown", key: pendingKey)
            let placed = try await store.api.request("/api/orders", method: "POST", body: body)
            guard let id = placed["id"].string, placed["queued"].bool == true else { throw APIError(status: 0, message: "The server did not confirm an order identifier.") }
            try savePending(id, key: pendingKey)
            guard owner == store.owner else { return }
            orderId = id
            result = .object(["state": .string("queued")]); await readStatus()
        } catch {
            self.error = error.localizedDescription
            // Validation/auth rejections are definitive; timeouts and server failures aren't.
            if let api = error as? APIError, [400, 401, 403].contains(api.status) {
                do { try SecureStore.remove("dev.merrymen.orders", pendingKey); attempted = false }
                catch { self.error = error.localizedDescription }
            }
        } }
    }
    private func readStatus() async {
        guard let owner = store.owner else { return }; let generation = store.generation
        do {
            if ceiling == nil {
                let limit = try await store.api.request("/api/orders/ceiling")
                guard let value = limit["ceilingUsdg"].number, value > 0 else { throw APIError(status: 0, message: "The order ceiling could not be read.") }
                guard generation == store.generation else { return }; ceiling = value
            }
            var path = "/api/orders?owner=\(escaped(owner))"
            if let orderId { path += "&id=\(escaped(orderId))" }
            let status = try await store.api.request(path)
            guard generation == store.generation else { return }
            guard ["none", "queued", "running", "done", "expired"].contains(status["state"].text) else { throw APIError(status: 0, message: "Order status could not be read.") }
            if ["queued", "running"].contains(status["state"].text), let id = status["id"].string {
                try savePending(id, key: key); attempted = true; orderId = id
            }
            result = status; error = nil; statusReady = true
        } catch { self.error = error.localizedDescription }
    }
    private func savePending(_ value: String, key: String) throws { try SecureStore.write("dev.merrymen.orders", key, Data(value.utf8)) }
    private func clear() {
        do { try SecureStore.remove("dev.merrymen.orders", key); attempted = false; orderId = nil; result = nil; error = nil; amount = ""; statusReady = false; Task { await readStatus() } }
        catch { self.error = error.localizedDescription }
    }
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
