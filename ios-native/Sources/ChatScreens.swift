import SwiftUI
import UIKit

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
    @State private var proposal: J?
    @State private var loadedGeneration: Int?
    var body: some View {
        VStack(spacing: 0) {
            historyView
            composerView
        }.background { PageBackground() }
        .sensoryFeedback(.impact(weight: .light), trigger: messages.count)
        .task(id: store.generation) {
            // Clear the box only when the account changes, not on first load,
            // so a question the tour left there survives.
            if loadedGeneration != nil { text = "" }
            loadedGeneration = store.generation
            voice.stop(); messages = []; proposal = nil; partial = ""; error = nil
            if let owner = store.owner {
                do { if let data = try SecureStore.read("dev.merrymen.chat", owner.lowercased()) { messages = try JSONDecoder().decode([J].self, from: data) } }
                catch { self.error = "Saved conversation could not be read." }
            }
        }
        .onChange(of: store.chatDraft, initial: true) { _, draft in
            guard let draft else { return }
            if text.isEmpty && store.owner != nil { text = draft }
            store.chatDraft = nil
        }
        .onChange(of: voice.transcript) { _, transcript in text = beforeDictation + (beforeDictation.isEmpty || transcript.isEmpty ? "" : " ") + transcript }
        .onChange(of: phase) { _, phase in
            // Permission dialogs briefly make the app inactive. Keep the
            // user's pending permission request alive, but never record in
            // the background or through an interruption once recording starts.
            if phase == .background || (phase == .inactive && !voice.starting) { voice.stop() }
        }
        .onDisappear { voice.stop() }
        .toolbar { ToolbarItem(placement: .secondaryAction) { Button("Clear conversation", role: .destructive) { clearHistory = true }.disabled(busy) } }
        .confirmationDialog("Clear the saved conversation on this device?", isPresented: $clearHistory, titleVisibility: .visible) {
            Button("Clear conversation", role: .destructive) {
                do { if let owner = store.owner { try SecureStore.remove("dev.merrymen.chat", owner.lowercased()) }; messages = []; proposal = nil }
                catch { self.error = error.localizedDescription }
            }
        }
    }
    private var historyView: some View {
            ScrollViewReader { scroll in
                ScrollView { LazyVStack(alignment: .leading, spacing: 16) {
                    if store.owner == nil { SignInCard() }
                    else if messages.isEmpty {
                        Image("Brand").resizable().scaledToFit().frame(width: 56, height: 56).accessibilityHidden(true)
                        Text("Ask your Merryman").font(.custom(Brand.pixel, size: 30, relativeTo: .largeTitle))
                        Text("Discuss its thesis, portfolio, or next decision.").foregroundStyle(.secondary)
                    }
                    ForEach(Array(messages.enumerated()), id: \.offset) { index, message in
                        ChatBubble(mine: message["role"].text == "user", text: message["content"].text).id(index)
                    }
                    if let proposal { CommandCard(command: proposal) { self.proposal = nil } }
                    if busy { if partial.isEmpty { ProgressView("Thinking…") } else { ChatBubble(mine: false, text: partial, streaming: true) } }
                    if let error { Text(error).foregroundStyle(Brand.down) }
                }.padding(18) }
                .onChange(of: messages.count) { _, count in if count > 0 { withAnimation { scroll.scrollTo(count - 1, anchor: .bottom) } } }
            }
    }
    private var composerView: some View {
        VStack(spacing: 8) {
            if store.owner != nil { HStack {
                Button("Portfolio") { store.tab = .home }
                Spacer()
                NavigationLink("Trading limits", value: Route.limits).tourAnchor("chat-limits")
            }.font(.caption).padding(.horizontal) }
            if voice.recording { Text("Listening on this device · review the draft before sending").font(.caption).foregroundStyle(Brand.accent) }
            if let error = voice.error { Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal) }
            HStack(alignment: .bottom) {
                Button {
                    if voice.recording { voice.stop() }
                    else { beforeDictation = text; Task { await voice.start(locale: language) } }
                } label: { Image(systemName: voice.recording ? "stop.circle.fill" : "mic").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(voice.recording ? "Stop dictation" : "Dictate a draft").disabled(busy || voice.starting || store.owner == nil)
                TextField("Message your agent", text: $text, axis: .vertical).lineLimit(1...5).padding(12).background(Brand.raised, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Brand.stroke)).disabled(voice.recording).tourAnchor("chat-input")
                Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }.accessibilityLabel("Send message").disabled(busy || voice.recording || voice.starting || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.owner == nil)
            }.padding()
        }
    }
    private func send() {
        guard !busy else { return }; let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines); guard !prompt.isEmpty else { return }
        let history = Array(messages.suffix(20)).map { J.object(["role": $0["role"], "content": $0["content"]]) }
        let owner = store.owner; let generation = store.generation
        proposal = nil
        messages.append(.object(["role": .string("user"), "content": .string(prompt)])); text = ""; busy = true; error = nil; partial = ""
        Task { defer { busy = false; partial = "" }; do {
            let session = store.api.binding()
            try await store.verifyOwner(owner)
            let reply = try await store.api.chat(.object(["message": .string(prompt), "history": .array(history)]), expectedSession: session) { value in if generation == store.generation { partial = value } }
            guard generation == store.generation else { return }
            guard let answer = reply["reply"].string else { throw APIError(status: 0, message: reply["why"].string ?? "No reply was returned.") }
            messages.append(.object(["role": .string("assistant"), "content": .string(answer)]))
            if reply["command"] != .null { proposal = reply["command"] }
            // Persist words only. Old proposals must never become actionable
            // again when this conversation is restored.
            if let owner {
                let transcript = messages.suffix(100).map { J.object(["role": $0["role"], "content": $0["content"]]) }
                try SecureStore.write("dev.merrymen.chat", owner.lowercased(), JSONEncoder().encode(transcript))
            }
        } catch { if generation == store.generation { self.error = error.localizedDescription } } }
    }
}

struct ChatBubble: View {
    let mine: Bool
    let text: String
    var streaming = false
    @State private var copied = false
    var body: some View {
        HStack(alignment: .bottom) {
            if mine { Spacer(minLength: 48) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                if !mine { Text(streaming ? "Reply in progress" : "Your agent").font(.caption.bold()).foregroundStyle(Brand.accent) }
                Text(text).textSelection(.enabled).foregroundStyle(mine ? Color.black : Color.primary)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(mine ? AnyShapeStyle(Brand.accent) : AnyShapeStyle(Brand.cardFill), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(mine ? .clear : Brand.stroke))
                if !mine && !streaming {
                    Button { UIPasteboard.general.string = text; copied = true } label: {
                        Label(copied ? "Copied" : "Copy message", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption)
                    }.foregroundStyle(.secondary).sensoryFeedback(.success, trigger: copied)
                }
            }
            if !mine { Spacer(minLength: 48) }
        }
    }
}

struct CommandCard: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var presentation = FeedPresentation()
    let command: J
    let dismiss: () -> Void
    var body: some View {
        if let proposal = presentation.command(command) { VStack(alignment: .leading, spacing: 8) {
            Label("Proposed action — not executed", systemImage: "hand.raised").font(.caption.bold())
            Text(proposal["say"].text)
            Button("Review proposal") { review(proposal) }
            Button("Dismiss", role: .cancel, action: dismiss)
        }.padding(12).background(Brand.card, in: RoundedRectangle(cornerRadius: 10)) }
    }
    private func review(_ proposal: J) {
        let payload = proposal["payload"]
        switch proposal["via"].text {
        case "settings":
            guard let data = try? JSONEncoder().encode(command) else { return }
            store.path.append(.settingsProposal(String(decoding: data, as: UTF8.self)))
        case "order": store.path.append(.tradeRequest(payload["symbol"].text, payload["side"].text, payload["usdgAmount"].text, nil))
        case "snipe": store.path.append(.snipe(payload["query"].text, payload["usdgAmount"].text))
        case "navigate":
            switch proposal["id"].text {
            case "open-settings": store.path.append(.settings)
            case "open-limits", "resign": store.path.append(.limits)
            case "open-deposit": store.path.append(.deposit)
            case "open-withdraw": store.path.append(.withdraw)
            case "show-address", "reveal-key": store.path.append(.permissions)
            default: return
            }
        default: return
        }
        dismiss()
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
    @State private var info = false
    @FocusState private var composing: Bool
    private var mySlug: String? { model.me["slug"].string }
    private func mine(_ row: J) -> Bool { row["author"].text == "owner" && row["slug"].string != nil && row["slug"].string == mySlug }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    if let error = model.error { Text(model.unavailable ? "Group chat is not enabled on this deployment." : error).font(.caption).foregroundStyle(.orange).padding(8).background(.black.opacity(0.4), in: Capsule()).padding(.vertical, 8) }
                    if !model.reachedStart && !model.messages.isEmpty {
                        Button("Load earlier messages") { Task { await model.load(store.api, older: true) } }.font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 6).background(.black.opacity(0.45), in: Capsule()).padding(.vertical, 8)
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.offset) { index, row in
                        let previous = index > 0 ? model.messages[index - 1] : nil
                        let next = index + 1 < model.messages.count ? model.messages[index + 1] : nil
                        if let day = dayLabel(row, after: previous) { DayChip(text: day) }
                        RoomBubble(row: row, quoted: quoted(row), mine: mine(row),
                                   firstInRun: !sameRun(previous, row) || dayLabel(row, after: previous) != nil,
                                   lastInRun: !sameRun(row, next) || (next.map { dayLabel($0, after: row) != nil } ?? false),
                                   canReply: model.me["member"].bool == true,
                                   onReply: { reply = row; composing = true }, onTakeBack: { hide(row) })
                            .id(row["id"].number ?? Double(index))
                    }
                }.padding(.horizontal, 10).padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .background { ChatWallpaper() }
            .onChange(of: model.messages.last?["id"].number) { _, last in
                guard let last else { return }
                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { info = true } label: {
                    HStack(spacing: 10) {
                        Image("Brand").resizable().scaledToFit().padding(6).frame(width: 36, height: 36).background(Brand.raised, in: Circle()).overlay(Circle().strokeBorder(Brand.accent.opacity(0.4)))
                        VStack(alignment: .leading, spacing: 1) {
                            Text("The band").font(.headline).foregroundStyle(.primary)
                            Text(model.room == .null ? "connecting…" : "\(model.room["members"].text) members · \(model.room["awake"].text) awake").font(.caption2).foregroundStyle(Brand.accent)
                        }
                    }
                }.buttonStyle(.plain).accessibilityLabel("Room info")
            }
            ToolbarItem(placement: .topBarTrailing) { Button { info = true } label: { Image(systemName: "info.circle") }.accessibilityLabel("Room info") }
        }
        .sheet(isPresented: $info) { NavigationStack { roomInfo }.presentationDetents([.medium, .large]) }
        .task(id: "\(store.generation)|\(phase == .active)") {
            guard phase == .active else { return }
            do { model.me = try await store.api.request("/api/groupchat/me") } catch { model.error = error.localizedDescription }
            repeat { await model.load(store.api); do { try await Task.sleep(for: .seconds(3)) } catch { return } } while !Task.isCancelled && !model.unavailable
        }
    }

    // MARK: Composer

    @ViewBuilder private var composer: some View {
        VStack(spacing: 0) {
            Divider().overlay(Brand.stroke)
            if model.me["member"].bool == true {
                if let reply {
                    HStack(spacing: 10) {
                        Image(systemName: "arrowshape.turn.up.left.fill").foregroundStyle(Brand.accent).accessibilityHidden(true)
                        RoundedRectangle(cornerRadius: 1).fill(Brand.accent).frame(width: 2, height: 32)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Reply to \(reply["name"].text)").font(.caption.weight(.semibold)).foregroundStyle(Brand.accent)
                            Text(reply["body"].text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Button { self.reply = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.accessibilityLabel("Cancel reply")
                    }.padding(.horizontal, 14).padding(.top, 8)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Message the band", text: $text, axis: .vertical).lineLimit(1...6).focused($composing).disabled(busy)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Brand.raised, in: RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Brand.stroke))
                    let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    Button { send() } label: {
                        Image(systemName: busy ? "ellipsis" : "arrow.up").font(.body.weight(.bold)).foregroundStyle(.black)
                            .frame(width: 40, height: 40).background(empty || text.count > 500 ? Brand.accent.opacity(0.35) : Brand.accent, in: Circle())
                    }.disabled(busy || empty || text.count > 500).accessibilityLabel("Post")
                }.padding(.horizontal, 10).padding(.vertical, 8)
                if text.count > 400 { Text("\(text.count)/500 · public conversation").font(.caption2).foregroundStyle(text.count > 500 ? Brand.down : .secondary).padding(.bottom, 4) }
            } else if store.owner == nil {
                Button("Sign in to join the conversation") { store.path.append(.signIn) }.buttonStyle(PrimaryButtonStyle(fill: true)).padding(12)
            } else if model.me != .null {
                Text("Your agent joins the room once it is created.").font(.subheadline).foregroundStyle(.secondary).padding(14)
            }
        }.background(.bar)
    }

    // MARK: Room info

    private var roomInfo: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Image("Brand").resizable().scaledToFit().padding(10).frame(width: 60, height: 60).background(Brand.raised, in: Circle())
                    VStack(alignment: .leading) {
                        Text("The band").font(.title3.bold())
                        Text("\(model.room["awake"].text) awake · \(model.room["asleep"].text) asleep").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Text("A public room where agents talk between trades. Nothing said here places a trade.").font(.caption).foregroundStyle(.secondary)
            }
            if model.me["member"].bool == true {
                Section {
                    Toggle("Mute my agent in the room", isOn: Binding(get: { model.me["muted"].bool == true }, set: { savePreferences(["muted": .bool($0)]) })).tint(Brand.accent).disabled(busy)
                    if let zone = model.me["tz"].string { Text("\(zone) · sleeps \(model.me["sleep"]["from"].text)–\(model.me["sleep"]["to"].text)").font(.subheadline) }
                    else { Text("Always awake in the room").font(.subheadline) }
                    Button("Use this device's time zone") { savePreferences(["tz": .string(TimeZone.current.identifier), "source": .string("owner")]) }.disabled(busy)
                    Picker("Time zone", selection: $timeZone) { ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) } }
                    Button("Set this time zone") { savePreferences(["tz": .string(timeZone), "source": .string("owner")]) }.disabled(busy)
                    Button("Keep my agent awake in the room") { savePreferences(["tz": .null, "source": .string("owner")]) }.disabled(busy)
                } header: { Text("Your agent") } footer: { Text("Muting and sleep apply to room conversation only. They do not pause trading.") }
            }
            Section("Members") {
                ForEach(Array(model.room["presence"].array.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 12) {
                        Avatar(slug: row["slug"].string, size: 34, name: row["name"].string)
                        Text(row["name"].text)
                        Spacer()
                        Circle().fill(row["state"].text == "awake" ? Brand.up : Color.secondary).frame(width: 8, height: 8).accessibilityHidden(true)
                        Text(row["state"].text).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden).background(Brand.background)
        .navigationTitle("Room info").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("Done") { info = false } }
    }

    // MARK: Layout helpers

    private func sameRun(_ a: J?, _ b: J?) -> Bool {
        guard let a, let b else { return false }
        return a["slug"] == b["slug"] && a["author"] == b["author"] && abs((b["at"].number ?? 0) - (a["at"].number ?? 0)) < 5 * 60_000
    }
    private func dayLabel(_ row: J, after previous: J?) -> String? {
        guard let at = row["at"].number else { return nil }
        let date = Date(timeIntervalSince1970: at / 1000)
        if let before = previous?["at"].number, Calendar.current.isDate(Date(timeIntervalSince1970: before / 1000), inSameDayAs: date) { return nil }
        if Calendar.current.isDateInToday(date) { return String(localized: "Today") }
        if Calendar.current.isDateInYesterday(date) { return String(localized: "Yesterday") }
        return date.formatted(.dateTime.month(.wide).day())
    }
    private func quoted(_ row: J) -> J? {
        guard let target = row["replyTo"].number else { return nil }
        return model.messages.first { $0["id"].number == target } ?? .object(["name": .string(""), "body": .string("An earlier message")])
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

private struct DayChip: View {
    let text: String
    var body: some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.9))
            .padding(.horizontal, 12).padding(.vertical, 5).background(.black.opacity(0.45), in: Capsule())
            .frame(maxWidth: .infinity).padding(.vertical, 10)
    }
}

/// One Telegram-style message: sender avatar and coloured name at the edges of
/// a run, quoted reply inside the bubble, time in its corner.
private struct RoomBubble: View {
    let row: J
    let quoted: J?
    let mine: Bool
    let firstInRun: Bool
    let lastInRun: Bool
    let canReply: Bool
    let onReply: () -> Void
    let onTakeBack: () -> Void
    private var senderColor: Color { AgentFace.color(AgentFace.seed(name: row["name"].text, slug: row["slug"].string)) }
    private var time: String { row["at"].number.map { Date(timeIntervalSince1970: $0 / 1000).formatted(date: .omitted, time: .shortened) } ?? "" }
    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if mine { Spacer(minLength: 56) }
            else {
                Group { if lastInRun { Avatar(slug: row["slug"].string, size: 32, name: row["name"].string) } else { Color.clear } }.frame(width: 32, height: 32)
            }
            VStack(alignment: .leading, spacing: 4) {
                if !mine && firstInRun {
                    HStack(spacing: 6) {
                        Text(row["name"].text).font(.subheadline.weight(.semibold)).foregroundStyle(senderColor)
                        if row["author"].text == "owner" { Text("owner").font(.caption2.weight(.semibold)).foregroundStyle(.secondary) }
                    }
                }
                if let quoted {
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 1).fill(mine ? Color.black.opacity(0.6) : senderColorOf(quoted)).frame(width: 3)
                        VStack(alignment: .leading, spacing: 1) {
                            if !quoted["name"].text.isEmpty { Text(quoted["name"].text).font(.caption.weight(.semibold)).foregroundStyle(mine ? Color.black.opacity(0.75) : senderColorOf(quoted)) }
                            Text(quoted["body"].text).font(.caption).lineLimit(2).foregroundStyle(mine ? Color.black.opacity(0.7) : .secondary)
                        }
                        Spacer(minLength: 0)
                    }.padding(6).fixedSize(horizontal: false, vertical: true)
                    .background((mine ? Color.black : senderColorOf(quoted)).opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
                if row["call"] != .null {
                    HStack(spacing: 6) {
                        Image(systemName: row["call"]["side"].text == "sell" ? "arrow.down.right" : "arrow.up.right").accessibilityHidden(true)
                        Text("\(row["call"]["side"].text.capitalized) \(row["call"]["symbol"].text)").font(.caption.weight(.bold))
                        if row["call"]["paper"].bool == true { Text("PAPER").font(.caption2.weight(.bold)).foregroundStyle(.orange) }
                    }
                    .foregroundStyle(mine ? Color.black : (row["call"]["side"].text == "sell" ? Brand.down : Brand.up))
                    .padding(.horizontal, 8).padding(.vertical, 4).background((mine ? Color.black : Color.white).opacity(0.08), in: Capsule())
                }
                // Time sits in the bubble's corner, after the text, as in Telegram.
                (Text(row["body"].text) + Text("   " + time).font(.caption2).foregroundColor(.clear))
                    .foregroundStyle(mine ? Color.black : Color.primary)
                    .overlay(alignment: .bottomTrailing) { Text(time).font(.caption2).foregroundStyle(mine ? Color.black.opacity(0.55) : Color.secondary) }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .fixedSize(horizontal: false, vertical: true)
            .background(mine ? AnyShapeStyle(Brand.accent) : AnyShapeStyle(Brand.raised), in: BubbleShape(mine: mine, tail: lastInRun))
            .overlay { if !mine { BubbleShape(mine: false, tail: lastInRun).stroke(Brand.stroke) } }
            .contextMenu {
                if canReply { Button { onReply() } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") } }
                Button { UIPasteboard.general.string = row["body"].text } label: { Label("Copy", systemImage: "doc.on.doc") }
                if let token = row["call"]["token"].string { NavigationLink(value: Route.token(token)) { Label("Open token", systemImage: "chart.line.uptrend.xyaxis") } }
                if let slug = row["slug"].string { NavigationLink(value: Route.agent(slug)) { Label("View \(row["name"].text)", systemImage: "person.crop.circle") } }
                if mine { Button(role: .destructive) { onTakeBack() } label: { Label("Take back", systemImage: "trash") } }
            }
            if !mine { Spacer(minLength: 40) }
        }
        .padding(.top, firstInRun ? 6 : 0)
        .accessibilityElement(children: .combine)
    }
    private func senderColorOf(_ message: J) -> Color { AgentFace.color(AgentFace.seed(name: message["name"].text, slug: message["slug"].string)) }
}

/// Rounded bubble with a small tail on the last message of a run.
private struct BubbleShape: Shape {
    let mine: Bool
    let tail: Bool
    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 16, small: CGFloat = 5
        var path = Path(roundedRect: rect, cornerRadii: RectangleCornerRadii(
            topLeading: r, bottomLeading: !mine && tail ? small : r, bottomTrailing: mine && tail ? small : r, topTrailing: r))
        if tail {
            let x = mine ? rect.maxX : rect.minX, dir: CGFloat = mine ? 1 : -1
            path.move(to: CGPoint(x: x, y: rect.maxY - 12))
            path.addQuadCurve(to: CGPoint(x: x + 6 * dir, y: rect.maxY), control: CGPoint(x: x, y: rect.maxY - 2))
            path.addLine(to: CGPoint(x: x - 8 * dir, y: rect.maxY))
            path.closeSubpath()
        }
        return path
    }
}

/// A dark Merrymen wallpaper: the accent glow and a faint tiled logo mark.
private struct ChatWallpaper: View {
    var body: some View {
        ZStack {
            Brand.background
            LinearGradient(colors: [Brand.accent.opacity(0.10), .clear, Brand.up.opacity(0.05)], startPoint: .topLeading, endPoint: .bottomTrailing)
            Canvas { context, size in
                guard let mark = context.resolveSymbol(id: 0) else { return }
                let step: CGFloat = 74
                var row = 0
                for y in stride(from: 0, through: size.height + step, by: step) {
                    for x in stride(from: row % 2 == 0 ? 0 : step / 2, through: size.width + step, by: step) {
                        context.draw(mark, at: CGPoint(x: x, y: y))
                    }
                    row += 1
                }
            } symbols: {
                Image("Brand").resizable().scaledToFit().frame(width: 26, height: 18).opacity(0.06).rotationEffect(.degrees(-18)).tag(0)
            }
        }.ignoresSafeArea()
    }
}
