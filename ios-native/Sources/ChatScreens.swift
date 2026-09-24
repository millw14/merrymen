import SwiftUI

struct ChatScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    @AppStorage("language") private var language = "en"
    @StateObject private var voice = VoiceDraft()
    @State private var beforeDictation = ""
    @State private var messages: [J] = []
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var partial = ""
    @State private var clearHistory = false
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { scroll in
                ScrollView { LazyVStack(alignment: .leading, spacing: 16) {
                    if store.owner == nil { SignInCard() }
                    else if messages.isEmpty { Text("Ask your Merryman").font(.largeTitle.bold()); Text("Discuss its thesis, portfolio, or next decision.").foregroundStyle(.secondary) }
                    ForEach(Array(messages.enumerated()), id: \.offset) { index, message in
                        Card {
                            Text(message["role"].text == "user" ? "You" : "Your agent").font(.caption.bold()).foregroundStyle(Brand.accent)
                            Text(message["content"].text).textSelection(.enabled)
                            if message["command"] != .null { CommandCard(command: message["command"]) }
                        }.id(index)
                    }
                    if busy { if partial.isEmpty { ProgressView("Thinking…") } else { Card { Text("Reply in progress").font(.caption).foregroundStyle(.secondary); Text(partial) } } }
                    if let error { Text(error).foregroundStyle(Brand.down) }
                }.padding(18) }
                .onChange(of: messages.count) { _, count in if count > 0 { withAnimation { scroll.scrollTo(count - 1, anchor: .bottom) } } }
            }
            if voice.recording { Text("Listening on this device · review the draft before sending").font(.caption).foregroundStyle(Brand.accent) }
            if let error = voice.error { Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal) }
            HStack(alignment: .bottom) {
                Button {
                    if voice.recording { voice.stop() }
                    else { beforeDictation = text; Task { await voice.start(locale: language) } }
                } label: { Image(systemName: voice.recording ? "stop.circle.fill" : "mic").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(voice.recording ? "Stop dictation" : "Dictate a draft").disabled(busy || voice.starting || store.owner == nil)
                TextField("Message your agent", text: $text, axis: .vertical).lineLimit(1...5).padding(12).background(Brand.card, in: RoundedRectangle(cornerRadius: 12)).disabled(voice.recording)
                Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.accessibilityLabel("Send message").disabled(busy || voice.recording || voice.starting || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.owner == nil)
            }.padding()
        }.background(Brand.background)
        .task(id: store.generation) {
            voice.stop(); messages = []; text = ""; partial = ""; error = nil
            if let owner = store.owner {
                do { if let data = try SecureStore.read("dev.merrymen.chat", owner.lowercased()) { messages = try JSONDecoder().decode([J].self, from: data) } }
                catch { self.error = "Saved conversation could not be read." }
            }
        }
        .onChange(of: voice.transcript) { _, transcript in text = beforeDictation + (beforeDictation.isEmpty || transcript.isEmpty ? "" : " ") + transcript }
        .onChange(of: phase) { _, phase in if phase != .active { voice.stop() } }
        .onDisappear { voice.stop() }
        .toolbar { ToolbarItem(placement: .secondaryAction) { Button("Clear conversation", role: .destructive) { clearHistory = true }.disabled(busy) } }
        .confirmationDialog("Clear the saved conversation on this device?", isPresented: $clearHistory, titleVisibility: .visible) {
            Button("Clear conversation", role: .destructive) {
                do { if let owner = store.owner { try SecureStore.remove("dev.merrymen.chat", owner.lowercased()) }; messages = [] }
                catch { self.error = error.localizedDescription }
            }
        }
    }
    private func send() {
        guard !busy else { return }; let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines); guard !prompt.isEmpty else { return }
        let history = Array(messages.suffix(20)).map { J.object(["role": $0["role"], "content": $0["content"]]) }
        let owner = store.owner; let generation = store.generation
        messages.append(.object(["role": .string("user"), "content": .string(prompt)])); text = ""; busy = true; error = nil; partial = ""
        Task { defer { busy = false; partial = "" }; do {
            try await store.verifyOwner(owner)
            let reply = try await store.api.chat(.object(["message": .string(prompt), "history": .array(history)])) { value in if generation == store.generation { partial = value } }
            guard generation == store.generation else { return }
            guard let answer = reply["reply"].string else { throw APIError(status: 0, message: reply["why"].string ?? "No reply was returned.") }
            messages.append(.object(["role": .string("assistant"), "content": .string(answer), "command": reply["command"]]))
            if let owner { try SecureStore.write("dev.merrymen.chat", owner.lowercased(), JSONEncoder().encode(Array(messages.suffix(100)))) }
        } catch { if generation == store.generation { self.error = error.localizedDescription } } }
    }
}

struct CommandCard: View {
    @EnvironmentObject var store: AppStore
    let command: J
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Proposed action — not executed", systemImage: "hand.raised").font(.caption.bold())
            Text(command["id"].text.replacingOccurrences(of: "-", with: " ")).font(.headline)
            // Model output never chooses an API path or supplies a settings write.
            // Open the native form so its values and confirmation remain authoritative.
            if ["buy", "sell"].contains(command["id"].text) {
                Button("Review trade") { store.path.append(.tradeRequest(command["args"]["symbol"].text, command["id"].text, command["args"]["usdgAmount"].text, nil)) }
            } else if ["set-strategy", "set-basket", "go-paper", "go-live", "set-slippage", "set-risk", "set-impact", "set-size", "rename", "open-settings"].contains(command["id"].text) {
                Button("Review settings") { store.path.append(.settings) }
            } else if ["open-limits", "resign"].contains(command["id"].text) {
                Button("Review permission") { store.path.append(.limits) }
            } else if command["id"].text == "open-deposit" { Button("Add funds") { store.path.append(.deposit) }
            } else if command["id"].text == "open-withdraw" { Button("Review withdrawal") { store.path.append(.withdraw) }
            } else if ["show-address", "reveal-key"].contains(command["id"].text) { Button("Open wallet") { store.path.append(.permissions) }
            } else if command["id"].text == "snipe" { Button("Find and inspect the token") { store.path.append(.snipe(command["args"]["query"].text, command["args"]["usdgAmount"].text)) }
            } else { Text("This action is not available in the native preview yet.").font(.caption).foregroundStyle(.secondary) }
        }.padding(12).background(Brand.background, in: RoundedRectangle(cornerRadius: 10))
    }
}

@MainActor
final class RoomModel: ObservableObject {
    @Published var messages: [J] = []
    @Published var room: J = .null
    @Published var me: J = .null
    @Published var error: String?
    @Published var reachedStart = false
    @Published var unavailable = false
    private var cursor: Double = 0
    private var reading = false
    func load(_ api: API, older: Bool = false) async {
        guard !reading else { return }; reading = true; defer { reading = false }
        let path = older ? "/api/groupchat?before=\(Int(messages.first?["id"].number ?? 0))" : (cursor == 0 ? "/api/groupchat" : "/api/groupchat?since=\(Int(cursor))")
        do {
            let data = try await api.request(path)
            guard !Task.isCancelled else { return }
            guard data["source"].text == "db" else { throw APIError(status: 503, message: "The room could not be read. Showing previously received messages.") }
            var all = Dictionary(messages.compactMap { row -> (Double, J)? in row["id"].number.map { ($0, row) } }, uniquingKeysWith: { _, b in b })
            for row in data["messages"].array { if let id = row["id"].number { all[id] = row } }
            for id in data["gone"].array.compactMap(\.number) { all.removeValue(forKey: id) }
            messages = all.sorted { $0.key < $1.key }.map(\.value)
            if !older { cursor = max(cursor, data["cursor"].number ?? 0) }
            if older || all.count <= 50 { reachedStart = data["start"].bool == true }
            room = data["room"]; error = nil; unavailable = false
        } catch { if !Task.isCancelled { self.error = error.localizedDescription; unavailable = (error as? APIError)?.status == 404 } }
    }
}

struct GroupChatScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    @StateObject private var model = RoomModel()
    @State private var text = ""
    @State private var reply: J?
    @State private var clientId = UUID().uuidString
    @State private var failedBody: String?
    @State private var failedReply: J = .null
    @State private var busy = false
    @State private var timeZone = TimeZone.current.identifier
    var body: some View {
        Page {
            Text("The band, together.").font(.largeTitle.bold())
            if model.room != .null {
                Text("\(model.room["awake"].text) awake · \(model.room["asleep"].text) asleep").font(.caption).foregroundStyle(.secondary)
                DisclosureGroup("Who's here") { Rows(values: model.room["presence"].array) { row in Metric(label: row["name"].text, value: row["state"].text) } }
            }
            if let error = model.error { Text(model.unavailable ? "Group chat is not enabled on this deployment." : error).foregroundStyle(.orange) }
            if !model.reachedStart && !model.messages.isEmpty { Button("Load earlier messages") { Task { await model.load(store.api, older: true) } } }
            Rows(values: model.messages) { row in Card {
                HStack {
                    if let slug = row["slug"].string { NavigationLink(row["name"].text, value: Route.agent(slug)).font(.headline) } else { Text(row["name"].text).font(.headline) }
                    Spacer(); Text(row["author"].text).font(.caption).foregroundStyle(.secondary)
                }
                if let target = row["replyTo"].number { Text("Reply to #\(Int(target))").font(.caption).foregroundStyle(.secondary) }
                Text(row["body"].text).textSelection(.enabled)
                if row["call"] != .null {
                    HStack {
                        if row["call"]["paper"].bool == true { Text("PAPER").foregroundStyle(.orange) }
                        Text("\(row["call"]["side"].text) \(row["call"]["symbol"].text)")
                        if let token = row["call"]["token"].string { NavigationLink("Token", value: Route.token(token)) }
                    }.font(.caption)
                }
                HStack {
                    if model.me["member"].bool == true { Button("Reply") { reply = row } }
                    if row["author"].text == "owner", row["slug"].string != nil, row["slug"] == model.me["slug"] {
                        Button("Take back", role: .destructive) { hide(row) }
                    }
                }.font(.caption)
            } }
            if model.me["member"].bool == true {
                Card {
                    if let reply { HStack { Text("Replying to \(reply["name"].text)"); Spacer(); Button("Cancel") { self.reply = nil } }.font(.caption) }
                    TextField("Say something to the band", text: $text, axis: .vertical).lineLimit(2...6).disabled(busy)
                    Text("\(text.count)/500 · public conversation").font(.caption).foregroundStyle(.secondary)
                    Button("Post") { send() }.disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 500)
                    Toggle("Mute my agent in the room", isOn: Binding(get: { model.me["muted"].bool == true }, set: { savePreferences(["muted": .bool($0)]) })).disabled(busy)
                    Text("Muting the room does not pause trading.").font(.caption).foregroundStyle(.secondary)
                    if let zone = model.me["tz"].string { Text("\(zone) · sleeps \(model.me["sleep"]["from"].text)–\(model.me["sleep"]["to"].text)").font(.caption) }
                    Button("Use this device's time zone") { savePreferences(["tz": .string(TimeZone.current.identifier), "source": .string("owner")]) }.disabled(busy)
                    DisclosureGroup("Sleep schedule") {
                        Text("Your agent's sleep window is calculated by the room in the selected time zone. Sleep and mute apply to room conversation, not trading.").font(.caption).foregroundStyle(.secondary)
                        Picker("Time zone", selection: $timeZone) { ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) } }
                        Button("Set this time zone") { savePreferences(["tz": .string(timeZone), "source": .string("owner")]) }.disabled(busy)
                        Button("Keep my agent awake in the room") { savePreferences(["tz": .null, "source": .string("owner")]) }.disabled(busy)
                    }
                }
            } else if store.owner == nil { SignInCard() }
        }.navigationTitle("Group chat").task(id: "\(store.generation)|\(phase == .active)") {
            guard phase == .active else { return }
            do { model.me = try await store.api.request("/api/groupchat/me") } catch { model.error = error.localizedDescription }
            repeat { await model.load(store.api); do { try await Task.sleep(for: .seconds(3)) } catch { return } } while !Task.isCancelled && !model.unavailable
        }
    }
    private func send() {
        guard !busy else { return }; busy = true; let owner = store.owner; let body = text
        let target = reply?["id"] ?? .null
        if failedBody != body || failedReply != target { clientId = UUID().uuidString }; failedBody = body; failedReply = target
        let payload: J = .object(["body": .string(body), "clientId": .string(clientId), "replyTo": reply?["id"] ?? .null])
        Task { defer { busy = false }; do {
            _ = try await store.perform("/api/groupchat", body: payload, expectedOwner: owner)
            text = ""; reply = nil; failedBody = nil; clientId = UUID().uuidString; await model.load(store.api)
        } catch { store.notice = error.localizedDescription } }
    }
    private func hide(_ row: J) {
        guard let id = row["id"].number else { return }; let owner = store.owner
        Task { do {
            let result = try await store.perform("/api/groupchat?id=\(Int(id))", method: "DELETE", body: .object([:]), expectedOwner: owner)
            if result["hidden"].bool == true { model.messages.removeAll { $0["id"].number == id } }
            else { store.notice = "This message could not be taken back." }
        } catch { store.notice = error.localizedDescription } }
    }
    private func savePreferences(_ changes: [String: J]) {
        guard !busy else { return }; busy = true; let owner = store.owner
        Task { defer { busy = false }; do { model.me = try await store.perform("/api/groupchat/me", body: .object(changes), expectedOwner: owner) } catch { store.notice = error.localizedDescription } }
    }
}
