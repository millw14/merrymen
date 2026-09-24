import SwiftUI
import Charts

enum Brand {
    static let background = Color(red: 7/255, green: 8/255, blue: 6/255)
    static let card = Color(red: 18/255, green: 19/255, blue: 15/255)
    static let accent = Color(red: 165/255, green: 206/255, blue: 31/255)
    static let up = Color(red: 61/255, green: 214/255, blue: 140/255)
    static let down = Color(red: 1, green: 92/255, blue: 113/255)
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .body).weight(.semibold))
            .foregroundStyle(Color.black).padding(.horizontal, 16).padding(.vertical, 12)
            .frame(minHeight: 44)
            .background(configuration.role == .destructive ? Brand.down : Brand.accent, in: RoundedRectangle(cornerRadius: 12))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
    }
}

struct ReviewValue: Identifiable { let id = UUID(); let value: J }

func usd(_ value: Double?) -> String { value.map { $0.formatted(.currency(code: "USD")) } ?? "—" }
func bps(_ value: Double?) -> String { value.map { ($0 / 100).formatted(.number.precision(.fractionLength(2))) + "%" } ?? "—" }
func escaped(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }

struct NativeShell: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var tourProgress = TourProgress()
    @State private var tour = false
    @State private var replaying = false
    var body: some View {
        NavigationStack(path: $store.path) {
            TabView(selection: $store.tab) {
                HomeScreen().tag(Tab.home).tabItem { Label("Home", systemImage: Tab.home.icon) }
                ChatScreen().tag(Tab.chat).tabItem { Label("Chat", systemImage: Tab.chat.icon) }
                FeedScreen().tag(Tab.feed).tabItem { Label("Feed", systemImage: Tab.feed.icon) }
                AlphaScreen().tag(Tab.alpha).tabItem { Label("Alpha", systemImage: Tab.alpha.icon) }
                AccountScreen().tag(Tab.profile).tabItem { Label("Profile", systemImage: Tab.profile.icon) }
            }
            .id(store.generation)
            .toolbarBackground(Brand.background, for: .tabBar, .navigationBar)
            .toolbarBackground(.visible, for: .tabBar, .navigationBar)
            .navigationTitle(store.tab.rawValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Image("Brand").resizable().scaledToFit().frame(width: 28, height: 28).accessibilityLabel("Merrymen") }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { store.path.append(.search) } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search")
                    Menu {
                        Button("Group chat") { store.path.append(.groupchat) }
                        Button("Coins to consider") { store.path.append(.proposals) }
                        Button("The Merry Circle") { store.path.append(.circle) }
                        Button("Replay tour") { replaying = true; tour = true }
                        Button("Settings") { store.path.append(.settings) }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("More")
                }
            }
            .navigationDestination(for: Route.self) { route in
                Group {
                switch route {
                case .markets: MarketsScreen()
                case .search: SearchScreen()
                case .agent(let slug): AgentScreen(slug: slug)
                case .token(let address): TokenScreen(address: address)
                case .settings: SettingsScreen()
                case .telegram: TelegramScreen()
                case .circle: CircleScreen()
                case .groupchat: GroupChatScreen()
                case .proposals: ProposalsScreen()
                case .xProof: XProofScreen()
                case .trade(let symbol): TradeScreen(symbol: symbol)
                case .deposit: DepositScreen()
                case .permissions: PermissionsScreen()
                case .create: GrantScreen(creating: true)
                case .limits: GrantScreen(creating: false)
                case .withdraw: WithdrawScreen()
                case .signIn: SignInScreen()
                case .siteAccess: SiteAccessScreen()
                case .tour: TourScreen()
                }
                }.id(store.generation)
            }
        }.background(Brand.background)
        .task { await store.refreshSession() }
        .task(id: store.generation) {
            await tourProgress.activate(store)
            if !replaying { tour = !tourProgress.done }
        }
        .environmentObject(tourProgress)
        .sheet(isPresented: $tour, onDismiss: { replaying = false }) { TourScreen().environmentObject(tourProgress) }
        .alert("Merrymen", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
            Button("OK", role: .cancel) { store.notice = nil }
        } message: { Text(store.notice ?? "") }
    }
}

struct Page<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 20) { content }.padding(18).frame(maxWidth: 800) }.background(Brand.background) }
}
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { VStack(alignment: .leading, spacing: 12) { content }.frame(maxWidth: .infinity, alignment: .leading).padding(18).background(Brand.card, in: RoundedRectangle(cornerRadius: 16)) }
}

struct Remote<Content: View>: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    let path: String
    var interval: UInt64 = 30
    @ViewBuilder var content: (J) -> Content
    @StateObject private var data = RemoteData()
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let error = data.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout)
                if data.value != nil { Text("Showing the last response. It may be out of date.").font(.caption).foregroundStyle(.secondary) }
                Button("Retry") { Task { await data.load(store.api, path) } }.disabled(data.refreshing)
            }
            if let v = data.value { content(v) }
            else if data.error == nil { ProgressView("Loading…").frame(maxWidth: .infinity) }
        }
        .task(id: "\(path)|\(store.generation)|\(phase == .active)") {
            guard phase == .active else { return }
            repeat {
                await data.load(store.api, path)
                do { try await Task.sleep(for: .seconds(interval)) } catch { return }
            } while !Task.isCancelled
        }
        .refreshable { await data.load(store.api, path) }
    }
}

struct Rows<Content: View>: View {
    let values: [J]
    @ViewBuilder var content: (J) -> Content
    var body: some View { ForEach(Array(values.enumerated()), id: \.offset) { _, row in content(row) } }
}

struct Metric: View {
    let label: String
    let value: String
    var body: some View { HStack { Text(label).foregroundStyle(.secondary); Spacer(); Text(value).monospacedDigit() } }
}
struct TrendChart: View {
    let values: [Double]
    var body: some View {
        if values.count > 1 {
            Chart(Array(values.enumerated()), id: \.offset) { point in
                LineMark(x: .value("Time", point.offset), y: .value("Value", point.element)).foregroundStyle(Brand.accent)
            }.chartXAxis(.hidden).chartYAxis(.hidden).frame(height: 100).accessibilityLabel("Performance history")
        } else { Text("History is not available yet.").font(.caption).foregroundStyle(.secondary) }
    }
}
struct Avatar: View {
    let slug: String?
    var size: CGFloat = 40
    var body: some View {
        AsyncImage(url: slug.flatMap { URL(string: "https://app.merrymen.dev/api/agent-image/\(escaped($0))/avatar") }) { image in image.resizable().scaledToFill() } placeholder: { Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(Brand.accent) }
            .frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
    }
}

struct TourScreen: View {
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var progress: TourProgress
    @AppStorage("language") private var language = "en"
    @State private var step = 0
    private func words(_ key: String) -> String { Language.text(key, locale: language) }
    private func key(_ index: Int, _ part: String) -> String { "tour.stop\(String(format: "%02d", index + 1)).\(part)" }
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 24) {
            HStack {
                Image("Brand").resizable().scaledToFit().frame(width: 70, height: 70)
                Spacer()
                Picker("Language", selection: $language) { ForEach(Language.options, id: \.0) { code, name in Text(name).tag(code) } }
            }
            Picker(words("tour.topics"), selection: $step) { ForEach(0..<26, id: \.self) { index in Text(words(key(index, "title"))).tag(index) } }
            Text(words(key(step, "title"))).font(.largeTitle.bold())
            Text(words(key(step, "copy"))).font(.title3).foregroundStyle(.secondary)
            Text(Language.text("tour.stepOf", locale: language, vars: ["current": String(step + 1), "total": "26"])).font(.caption)
            HStack {
                if step > 0 { Button(words("tour.back")) { step -= 1 } }
                Spacer()
                Button(words(step == 25 ? "tour.finish" : "tour.next")) { if step < 25 { step += 1 } else { finish() } }.buttonStyle(PrimaryButtonStyle())
            }
            Button(words("tour.skip")) { finish() }.accessibilityIdentifier("Skip tour")
            if progress.syncFailed { Button(words("tour.retrySync")) { Task { await progress.sync(store) } } }
        }.padding(30) }.background(Brand.background)
        .onChange(of: step) { _, step in progress.move(step) }
    }
    private func finish() {
        progress.finish(store); dismiss()
    }
}
