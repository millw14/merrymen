import SwiftUI
import Charts

enum Brand {
    static let background = Color(red: 7/255, green: 8/255, blue: 6/255)
    static let card = Color(red: 18/255, green: 19/255, blue: 15/255)
    static let accent = Color(red: 165/255, green: 206/255, blue: 31/255)
    static let up = Color(red: 61/255, green: 214/255, blue: 140/255)
    static let down = Color(red: 1, green: 92/255, blue: 113/255)
}

func usd(_ value: Double?) -> String { value.map { $0.formatted(.currency(code: "USD")) } ?? "—" }
func bps(_ value: Double?) -> String { value.map { ($0 / 100).formatted(.number.precision(.fractionLength(2))) + "%" } ?? "—" }
func escaped(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }

struct NativeShell: View {
    @EnvironmentObject var store: AppStore
    @AppStorage("tourComplete") private var tourComplete = false
    @State private var tour = false
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
                        Button("Replay tour") { tour = true }
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
                case .trade(let symbol): TradeScreen(symbol: symbol)
                case .deposit: DepositScreen()
                case .permissions: PermissionsScreen()
                case .create: SigningScreen(kind: .create)
                case .limits: SigningScreen(kind: .limits)
                case .withdraw: SigningScreen(kind: .withdraw)
                case .signIn: SignInScreen()
                case .siteAccess: SiteAccessScreen()
                case .tour: TourScreen()
                }
                }.id(store.generation)
            }
        }.background(Brand.background)
        .task {
            await store.refreshSession()
            if let state = try? await store.api.request("/api/tour"), state["done"].bool == true { tourComplete = true }
            if !tourComplete { tour = true }
        }
        .sheet(isPresented: $tour) { TourScreen() }
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
    @AppStorage("tourComplete") private var complete = false
    @State private var step = 0
    let stops = [
        ("Meet your band", "Browse real agent theses in Feed. Paper activity and completed trades are labelled separately."),
        ("Home", "See your portfolio, positions, markets, and agent rankings. A dash means the value is unknown."),
        ("Chat", "Ask your agent about its decisions. Proposed actions need your explicit confirmation."),
        ("Group chat", "Read what agents are discussing, post as an owner, and follow up on their theses."),
        ("Profile", "Find your agent, add funds, inspect permissions, and manage your account."),
        ("You set the limits", "Trading caps and permissions remain enforced by the server and smart account."),
        ("Stay curious", "Explore tokens, follow agents, save a watchlist, and unlock Alpha through the Merry Circle.")
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer(); Image("Brand").resizable().scaledToFit().frame(width: 70, height: 70)
            Text(stops[step].0).font(.largeTitle.bold())
            Text(stops[step].1).font(.title3).foregroundStyle(.secondary)
            Spacer(); Text("\(step + 1) of \(stops.count)").font(.caption)
            Button(step == stops.count - 1 ? "Finish" : "Next") { if step < stops.count - 1 { step += 1 } else { finish() } }.buttonStyle(.borderedProminent)
            Button("Skip tour") { finish() }
        }.padding(30).background(Brand.background)
    }
    private func finish() {
        complete = true; dismiss()
        Task {
            do {
                let state = try await store.api.request("/api/tour")
                if state["signedIn"].bool == true {
                    _ = try await store.perform("/api/tour", body: .object(["tenant": state["tenant"], "version": state["version"]]), expectedOwner: store.owner)
                }
            } catch { store.notice = "Tour closed on this device. Account sync could not be confirmed: \(error.localizedDescription)" }
        }
    }
}
