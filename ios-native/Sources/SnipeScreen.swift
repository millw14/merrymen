import SwiftUI
import MerrymenPolicy

/// Resolution is read-only. The existing TradeScreen owns the sole order POST,
/// durable submission record, confirmation and receipt reconciliation.
struct SnipeScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var query: String
    @State private var amount: String
    @State private var result: J?
    @State private var busy = false
    @State private var error: String?
    @State private var resolvedAmount = ""
    init(query: String = "", amount: String = "") {
        _query = State(initialValue: query); _amount = State(initialValue: amount)
    }
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else {
                Card {
                    Text("Find a coin to trade").font(.largeTitle.bold())
                    Text("Search by name, ticker or contract address. Finding a match does not place an order.")
                    TextField("Coin or contract address", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Amount in USDG", text: $amount).keyboardType(.decimalPad)
                    Button("Find matching coins") { resolve() }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                }
                if busy { ProgressView("Checking the registry and discoveries…") }
                if let result {
                    switch result["outcome"].text {
                    case "not-found": Text("No matching coin was found. Try its full contract address.")
                    case "ambiguous":
                        Text("Several coins match. Choose the contract you intended.").font(.headline)
                        Rows(values: result["candidates"].array) { row in Card {
                            Text(row["symbol"].text).font(.headline)
                            Text(row["address"].text).font(.caption.monospaced()).textSelection(.enabled)
                            Button("Check this contract") { query = row["address"].text; resolve() }.disabled(busy)
                            NavigationLink("Inspect token", value: Route.token(row["address"].text))
                        } }
                    case "needs-signature":
                        Card {
                            Text("This coin needs a signed permission").font(.headline)
                            Text(result["target"]["symbol"].text)
                            Text(result["target"]["address"].text).font(.caption.monospaced()).textSelection(.enabled)
                            Text("Add the verified token details in Settings and review a new permission. No order has been placed.")
                            NavigationLink("Inspect token", value: Route.token(result["target"]["address"].text))
                            NavigationLink("Open settings", value: Route.settings)
                        }
                    case "resolved":
                        Card {
                            Text("Match found — not submitted").font(.headline)
                            Text(result["target"]["symbol"].text)
                            Text(result["target"]["address"].text).font(.caption.monospaced()).textSelection(.enabled)
                            if result["matchedOn"].text == "name" { Text("Matched by name. Check the contract carefully.").foregroundStyle(.orange) }
                            NavigationLink("Review buy order", value: Route.tradeRequest(result["target"]["symbol"].text, "buy", resolvedAmount, result["target"]["address"].string))
                        }
                    default: Text("The token could not be resolved. No order was placed.")
                    }
                }
                if let error { Text(error).foregroundStyle(.orange) }
            }
        }.navigationTitle("Find a trade")
        .onChange(of: query) { _, _ in result = nil }
        .onChange(of: amount) { _, _ in result = nil }
    }
    private func resolve() {
        guard !busy else { return }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, query.count <= 64, let value = TradeInput.amount(amount), value <= 1_000_000_000 else { error = "Enter a coin and a positive USDG amount with at most two decimal places."; return }
        let owner = store.owner; let typedAmount = amount
        busy = true; error = nil; result = nil
        Task { defer { busy = false }; do {
            let response = try await store.perform("/api/snipe", body: .object(["query": .string(query), "usdgAmount": .number(value), "owner": owner.map(J.string) ?? .null]), expectedOwner: owner)
            guard self.query.trimmingCharacters(in: .whitespacesAndNewlines) == query, amount == typedAmount else { return }
            resolvedAmount = typedAmount; result = response
        } catch { error = error.localizedDescription } }
    }
}
