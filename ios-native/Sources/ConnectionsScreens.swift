import SwiftUI
import UIKit
import MerrymenPolicy

/// Connected AI apps: every assistant connection and access token that can
/// reach this owner's Merrymen, what each may do and did recently, and a
/// Disconnect that ends its access on its next request (web /connect/apps).
struct ConnectionsScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var revision = 0
    @State private var confirming: J?
    @State private var busy = false
    @State private var link = ""
    var body: some View {
        Page {
            SectionHeader(title: "Connected AI apps", subtitle: "Let Claude, ChatGPT or another assistant read your agent and prepare actions you approve here.", systemImage: "sparkles.rectangle.stack")
            if store.owner == nil { SignInCard() } else {
                Remote(path: "/api/mcp/connections") { data in
                    if let endpoint = data["endpoint"].string { connectCard(endpoint) }
                    approvalLinkCard
                    let connections = data["connections"].array
                    SectionHeader(title: "Connections", subtitle: connections.isEmpty ? "Nothing is connected." : "\(connections.count) connected")
                    Rows(values: connections) { connectionCard($0) }
                }.id(revision)
            }
        }
        .navigationTitle("AI apps")
        .confirmationDialog("Disconnect \(confirming?["clientName"].string ?? "this app")?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible, presenting: confirming) { connection in
            Button("Disconnect", role: .destructive) { revoke(connection) }
        } message: { _ in Text("Its access ends on its next request, and anything it left waiting for your approval is cancelled. Orders you already approved stay yours.") }
    }

    private func connectCard(_ endpoint: String) -> some View {
        Card {
            Text("Connect an assistant").font(.headline)
            Text("Add Merrymen as a connector in your assistant, then sign in here when it asks. You choose what it may do.").font(.subheadline).foregroundStyle(.secondary)
            if let claude = URL(string: "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Merrymen&connectorUrl=\(escaped(endpoint))") {
                Link(destination: claude) { Label("Add to Claude", systemImage: "arrow.up.right.square") }.buttonStyle(.plain).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.accent)
            }
            if let chatgpt = URL(string: "https://chatgpt.com/plugins") {
                Link(destination: chatgpt) { Label("Open ChatGPT connectors", systemImage: "arrow.up.right.square") }.buttonStyle(.plain).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.accent)
            }
            HStack {
                Text(endpoint).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Spacer()
                Button { UIPasteboard.general.string = endpoint } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy server URL")
            }.padding(10).background(Brand.raised, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    /// An assistant sends its approval requests as links; this opens one pasted from its chat.
    private var approvalLinkCard: some View {
        Card {
            Text("Review a request").font(.headline)
            Text("When an assistant prepares a trade or a change, it gives you a link. Open it here to approve or decline.").font(.caption).foregroundStyle(.secondary)
            TextField("Paste the approval link", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled().font(.callout)
                .padding(12).background(Brand.raised, in: RoundedRectangle(cornerRadius: 12))
            Button("Open request") {
                guard let id = ApprovalScreen.proposalID(in: link) else { store.notice = "That is not a Merrymen approval link."; return }
                link = ""; store.path.append(.approval(id))
            }.buttonStyle(SecondaryButtonStyle(fill: true)).disabled(link.isEmpty)
        }
    }

    private func connectionCard(_ c: J) -> some View {
        Card {
            HStack {
                Image(systemName: c["kind"].text == "personal" ? "key.horizontal" : "sparkles").foregroundStyle(Brand.accent).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(c["clientName"].string ?? (c["kind"].text == "personal" ? "Personal access token" : "AI assistant")).font(.headline)
                    if let host = c["clientHost"].string { Text(host).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if c["profile"].string == "directory" { Pill(text: "Limited", tint: .secondary) }
            }
            // What it may do. Anything past reading is called out.
            FlowTags(tags: c["scopes"].array.map { ($0["title"].text, $0["level"].text != "read") })
            if !c["agentSlugs"].array.isEmpty { Text("Agents: " + c["agentSlugs"].array.map(\.text).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary) }
            HStack(spacing: 4) {
                Text("Connected"); Text(Date(timeIntervalSince1970: c["createdAt"].number ?? 0), style: .date)
                Text("· last used")
                if let used = c["lastUsedAt"].number { Text(Date(timeIntervalSince1970: used), style: .relative) } else { Text("never") }
            }.font(.caption).foregroundStyle(.secondary)
            let recent = c["recent"].array
            if !recent.isEmpty {
                DisclosureGroup("Recent activity · \(recent.count)") {
                    Rows(values: recent) { r in
                        HStack { Text(r["action"].text).font(.caption.monospaced()); Spacer(); Text(r["outcome"].text).font(.caption).foregroundStyle(r["outcome"].text == "ok" ? Color.secondary : Color.orange) }
                    }
                }.font(.caption).tint(.secondary)
            }
            Button("Disconnect", role: .destructive) { confirming = c }.buttonStyle(SecondaryButtonStyle(fill: true)).disabled(busy)
        }
    }

    private func revoke(_ c: J) {
        guard !busy else { return }; busy = true; let owner = store.owner
        Task { defer { busy = false }; do {
            let r = try await store.perform("/api/mcp/connections", body: .object(["action": .string("revoke"), "id": c["id"]]), expectedOwner: owner)
            let cancelled = Int(r["proposals_cancelled"].number ?? 0)
            store.notice = "\(c["clientName"].string ?? "The app") is disconnected." + (cancelled > 0 ? " \(cancelled) waiting request\(cancelled == 1 ? " was" : "s were") cancelled." : "")
            revision += 1
        } catch { store.notice = error.localizedDescription } }
    }
}

/// Scope titles as small tags; ones beyond reading are highlighted.
struct FlowTags: View {
    let tags: [(String, Bool)]
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { content }
            VStack(alignment: .leading, spacing: 6) { content }
        }
    }
    @ViewBuilder private var content: some View {
        ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
            Text(tag.0).font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 4)
                .foregroundStyle(tag.1 ? Color.orange : Color.secondary)
                .background((tag.1 ? Color.orange : Color.secondary).opacity(0.12), in: Capsule())
        }
    }
}

/// The owner's decision on something an assistant prepared (web /connect/approve/[id]).
///
/// It shows the stored binding the server will check, and Approve/Decline post
/// that binding's hash back, so the server acts only on what this screen showed.
/// The status headline, the real-money box and whether approving is allowed
/// come from the web page's own rules (approve-view.ts via FeedEngine).
struct ApprovalScreen: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var presentation = FeedPresentation()
    let id: String
    @State private var view: J?
    @State private var error: String?
    @State private var busy = false
    @State private var confirm: String?

    static func proposalID(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let link = NavigationPolicy().deepLink(url) else {
            return trimmed.wholeMatch(of: #/prp_[0-9a-f]{32}/#) != nil ? trimmed : nil
        }
        let parts = link.path.split(separator: "/")
        return parts.count == 3 && parts[0] == "connect" && parts[1] == "approve" ? String(parts[2]) : nil
    }

    var body: some View {
        Page {
            if store.owner == nil { SignInCard() }
            else if let view { content(view) }
            else if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange); Button("Retry") { Task { await load() } } }
            else { ProgressView("Loading the request…").frame(maxWidth: .infinity) }
        }
        .navigationTitle("Review request")
        .task(id: store.generation) { await load() }
        .refreshable { await load() }
        .confirmationDialog(confirm == "approve" ? "Approve this request?" : "Decline this request?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible, presenting: confirm) { decision in
            Button(decision == "approve" ? "Yes, approve" : "Yes, decline", role: decision == "approve" ? nil : .destructive) { decide(decision) }
        } message: { decision in
            Text(decision == "approve" ? "Merrymen checks it again against your limits and current state before acting." : "Nothing will be sent.")
        }
    }

    @ViewBuilder private func content(_ v: J) -> some View {
        let rules = presentation.approval(v)
        let b = v["binding"], s = v["summary"]
        Card(hero: rules?["approvable"].bool == true) {
            Pill(text: kindLabel(v["kind"].text), tint: v["kind"].text == "trade" ? .orange : Brand.accent)
            Text(rules?["headline"].string ?? v["status"].text).font(.title3.bold())
            Text("Requested by \(v["requested_by"].string ?? "an AI assistant")").font(.subheadline).foregroundStyle(.secondary)
            if v["status"].text == "awaiting_approval", let expires = v["expires_at"].number {
                HStack(spacing: 4) { Text("Expires"); Text(Date(timeIntervalSince1970: expires), style: .relative) }.font(.caption).foregroundStyle(.secondary)
            }
        }
        if let box = rules?["box"], box != .null {
            Label(box["text"].text, systemImage: box["warn"].bool == true ? "exclamationmark.triangle.fill" : "checkmark.shield")
                .font(.subheadline).foregroundStyle(box["warn"].bool == true ? Color.orange : Color.secondary)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background((box["warn"].bool == true ? Color.orange : Brand.accent).opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        }
        switch v["kind"].text {
        case "trade":
            let limits = b["limits"]
            Card {
                Text(s["action"].text).font(.headline)
                Metric(label: "Token", value: "\(b["symbol"].text) · \(short(b["token"].text))")
                Metric(label: "Quoted: expect / at least", value: "\(s["expected_out"].text) / \(s["min_out"].text) \(b["side"].text == "buy" ? b["symbol"].text : "USDG")")
                Metric(label: "Slippage limit when proposed", value: bps(b["slippage_bps"].number))
                let q = v["fresh_quote"]
                if q != .null {
                    Metric(label: "Price right now", value: q["quoted"].bool == true ? "expect \(q["expected_out"]["human"].text) · impact \(q["price_impact_bps"].number.map { "\(Int($0)) bps" } ?? "unknown")" : "no quote (\(q["why_not"].text))")
                    if q["impact_verdict"]["ok"].bool == false { Text(q["impact_verdict"]["detail"].string ?? "Price impact is over your agent's cap.").font(.caption).foregroundStyle(.orange) }
                }
                Metric(label: "Per trade limit", value: usd(limits["per_trade_usdg"].number))
                Metric(label: "Per day limit", value: usd(limits["daily_usdg"].number))
                Text("Approving re-checks the price, your limits and your agent's mode, and refuses if they moved. Your agent then takes a fresh price when it executes, with its own slippage limit, so the fill can differ from these figures.").font(.caption).foregroundStyle(.secondary)
            }
        case "settings", "agent_draft":
            let check = v["settings_check"]
            if check != .null {
                if !check["changed_since"].array.isEmpty { Label("Your settings changed since this was proposed. Approving is refused; ask your assistant for a fresh proposal.", systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange) }
                if check["applies_to_running_agent"].bool == true { Label("This changes your running agent immediately, including its trading limits.", systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange) }
                Card {
                    Rows(values: check["rows"].array) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(row["label"].text): " + (row["current"] == row["proposed"] ? "\(row["current"].text) (no change)" : "\(row["current"].text) → \(row["proposed"].text)")).font(.subheadline.weight(.semibold))
                            Text((row["changed"].bool == true ? "It was \(row["when_proposed"].text) when this was proposed. " : "") + row["help"].text).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if !check["left_out"].array.isEmpty { Text("Left out: " + check["left_out"].array.map(\.text).joined(separator: ", ") + ". Safety floors are only changed in Settings.").font(.caption).foregroundStyle(.secondary) }
                }
            } else {
                Card {
                    Rows(values: s["diff"].array) { d in Text("\(d["label"].text): \(d["current"].text) → \(d["proposed"].text)").font(.subheadline) }
                    if v["kind"].text == "agent_draft" && v["status"].text == "awaiting_approval" { Text("Your current settings could not be read just now. If you already run an agent, approving applies these to it immediately.").font(.caption).foregroundStyle(.orange) }
                }
            }
        default:
            Card { Text("“\(b["text"].text)”").font(.body.italic()); Text("Posted to the group chat as your agent.").font(.caption).foregroundStyle(.secondary) }
        }
        if let note = v["result"]["note"].string ?? v["result"]["why"].string {
            Card { Text("Result").font(.headline); Text(note).font(.subheadline) }
        }
        if v["status"].text == "awaiting_approval" {
            HStack(spacing: 12) {
                Button("Decline") { confirm = "reject" }.buttonStyle(SecondaryButtonStyle(fill: true))
                Button("Approve") { confirm = "approve" }.buttonStyle(PrimaryButtonStyle(fill: true)).disabled(rules?["approvable"].bool != true)
            }.disabled(busy)
            if busy { ProgressView("Sending your decision…") }
        }
    }

    private func kindLabel(_ kind: String) -> String {
        switch kind { case "trade": "Trade"; case "settings": "Settings change"; case "agent_draft": "Agent setup"; default: "Group chat post" }
    }
    private func short(_ a: String) -> String { a.count > 12 ? "\(a.prefix(8))…\(a.suffix(6))" : a }

    private func load() async {
        guard store.owner != nil else { return }
        do { view = try await store.api.request("/api/mcp/approvals/\(escaped(id))"); error = nil }
        catch let failure as APIError where failure.status == 404 { error = "There is no such request for this account. Check you are signed in as the agent's owner." }
        catch { self.error = error.localizedDescription }
    }

    /// Posts the hash of the binding this screen displayed; the server refuses
    /// if it no longer matches, so a changed request can never be approved here.
    private func decide(_ decision: String) {
        guard !busy, let hash = view?["binding_hash"].string else { return }
        busy = true; let owner = store.owner
        Task { defer { busy = false }; do {
            view = try await store.perform("/api/mcp/approvals/\(escaped(id))", body: .object(["decision": .string(decision), "hash": .string(hash)]), expectedOwner: owner)
            // Follow a queued trade until its outcome is known.
            for _ in 0..<20 where presentation.approval(view ?? .null)?["finished"].bool != true {
                try await Task.sleep(for: .seconds(3)); view = try await store.api.request("/api/mcp/approvals/\(escaped(id))")
            }
        } catch { store.notice = error.localizedDescription; await load() } }
    }
}
