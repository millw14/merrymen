import SwiftUI
import Charts
import MerrymenPolicy

enum Brand {
    static let background = Color(red: 7/255, green: 8/255, blue: 6/255)
    static let card = Color(red: 18/255, green: 19/255, blue: 15/255)
    static let raised = Color(red: 26/255, green: 28/255, blue: 21/255)
    static let stroke = Color.white.opacity(0.07)
    static let accent = Color(red: 165/255, green: 206/255, blue: 31/255)
    static let up = Color(red: 61/255, green: 214/255, blue: 140/255)
    static let down = Color(red: 1, green: 92/255, blue: 113/255)
    static let pixel = "GeistPixel-Regular"
    static let cardFill = LinearGradient(colors: [raised, card], startPoint: .topLeading, endPoint: .bottomTrailing)
    static let heroFill = LinearGradient(colors: [accent.opacity(0.22), raised, card], startPoint: .topLeading, endPoint: .bottomTrailing)
    static func signed(_ value: Double?) -> Color { guard let value, value != 0 else { return .primary }; return value < 0 ? down : up }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    var fill = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .body).weight(.semibold))
            .foregroundStyle(Color.black).padding(.horizontal, 18).padding(.vertical, 12)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: 48)
            .background(configuration.role == .destructive ? Brand.down : Brand.accent, in: RoundedRectangle(cornerRadius: 14))
            .shadow(color: (configuration.role == .destructive ? Brand.down : Brand.accent).opacity(enabled ? 0.28 : 0), radius: 14, y: 4)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

/// Quiet companion to the primary button: raised surface with a hairline.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    var fill = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .body).weight(.medium))
            .foregroundStyle(configuration.role == .destructive ? AnyShapeStyle(Brand.down) : AnyShapeStyle(.primary)).padding(.horizontal, 18).padding(.vertical, 12)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: 48)
            .background(Brand.raised, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Brand.stroke))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(enabled ? 1 : 0.45)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

/// X's own sign-in treatment: white button, black mark.
struct XButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 10) {
            Text("𝕏").font(.system(size: 20, weight: .bold)).accessibilityHidden(true)
            configuration.label
        }
        .font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .body).weight(.semibold))
        .foregroundStyle(Color.black).padding(.horizontal, 18).padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 14))
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
        .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

struct SectionHeader: View {
    let title: String
    var subtitle: String? = nil
    var systemImage: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let systemImage { Image(systemName: systemImage).foregroundStyle(Brand.accent).font(.headline).accessibilityHidden(true) }
                Text(LocalizedStringKey(title)).font(.title2.bold())
            }
            if let subtitle { Text(LocalizedStringKey(subtitle)).font(.subheadline).foregroundStyle(.secondary) }
        }.padding(.top, 8).accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
    }
}

/// A short uppercase status tag (LIVE, PAPER, …).
struct Pill: View {
    let text: String
    var tint: Color = Brand.accent
    var body: some View {
        Text(LocalizedStringKey(text)).font(.caption2.weight(.bold)).tracking(0.6).textCase(.uppercase)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .foregroundStyle(tint).background(tint.opacity(0.14), in: Capsule())
    }
}

/// Percentage from basis points, green above zero and red below.
struct ReturnText: View {
    let bps: Double?
    var font: Font = .body.weight(.semibold)
    var body: some View {
        HStack(spacing: 3) {
            if let bps, bps != 0 { Image(systemName: bps < 0 ? "arrow.down.right" : "arrow.up.right").font(.caption.weight(.bold)).accessibilityHidden(true) }
            Text(Merrymen.bps(bps)).monospacedDigit()
        }.font(font).foregroundStyle(Brand.signed(bps))
    }
}

struct StatTile: View {
    let label: String
    let value: String
    var tint: Color = .primary
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(LocalizedStringKey(label)).font(.caption).foregroundStyle(.secondary).lineLimit(2).minimumScaleFactor(0.8)
            Text(value).font(.custom(Brand.pixel, size: 24, relativeTo: .title2)).foregroundStyle(tint).monospacedDigit().lineLimit(1).minimumScaleFactor(0.5)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .background(Brand.cardFill, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Brand.stroke))
        .accessibilityElement(children: .combine)
    }
}

struct ActionTile: View {
    let title: String
    let systemImage: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: systemImage).font(.title3.weight(.semibold)).foregroundStyle(Brand.accent)
                    .frame(width: 38, height: 38).background(Brand.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                Text(LocalizedStringKey(title)).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).multilineTextAlignment(.leading).lineLimit(2)
            }
            .frame(maxWidth: .infinity, minHeight: 76, alignment: .topLeading).padding(14)
            .background(Brand.cardFill, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Brand.stroke))
        }.buttonStyle(.plain)
    }
}

/// A grouped navigation row with an icon, used for account and settings lists.
struct MenuRow: View {
    let title: String
    let systemImage: String
    var route: Route? = nil
    var tint: Color = Brand.accent
    var action: (() -> Void)? = nil
    var body: some View {
        let label = HStack(spacing: 14) {
            Image(systemName: systemImage).font(.body.weight(.semibold)).foregroundStyle(tint).frame(width: 32, height: 32).background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 9)).accessibilityHidden(true)
            Text(LocalizedStringKey(title)).foregroundStyle(.primary)
            Spacer()
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
        }.padding(.vertical, 10).contentShape(Rectangle())
        if let route { NavigationLink(value: route) { label }.buttonStyle(.plain) }
        else { Button { action?() } label: { label }.buttonStyle(.plain) }
    }
}

struct ReviewValue: Identifiable { let id = UUID(); let value: J }

func usd(_ value: Double?) -> String { value.map { $0.formatted(.currency(code: "USD")) } ?? "—" }
func tokenPrice(_ value: Double?) -> String { FinancialDisplay.tokenPrice(value) }
func bps(_ value: Double?) -> String { value.map { ($0 / 100).formatted(.number.precision(.fractionLength(2))) + "%" } ?? "—" }
func escaped(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }

struct NativeShell: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    @StateObject private var tourProgress = TourProgress()
    var body: some View {
        NavigationStack(path: $store.path) {
            TabView(selection: $store.tab) {
                HomeScreen().tag(Tab.home).tabItem { Label("Home", systemImage: Tab.home.icon) }
                ChatScreen().tag(Tab.chat).tabItem { Label("Chat", systemImage: Tab.chat.icon) }
                FeedScreen().tag(Tab.feed).tabItem { Label("Feed", image: "TabMark") }
                AlphaScreen().tag(Tab.alpha).tabItem { Label("Alpha", systemImage: Tab.alpha.icon) }
                AccountScreen().tag(Tab.profile).tabItem { Label("Profile", systemImage: Tab.profile.icon) }
            }
            .id(store.generation)
            .toolbarBackground(Brand.background, for: .tabBar, .navigationBar)
            .toolbarBackground(.visible, for: .tabBar, .navigationBar)
            .navigationTitle(LocalizedStringKey(store.tab.rawValue))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // iOS 26 wraps toolbar items in a glass bubble sized for an
                // icon, which clipped the wordmark down to the logo alone.
                if #available(iOS 26.0, *) { ToolbarItem(placement: .topBarLeading) { Wordmark() }.sharedBackgroundVisibility(.hidden) }
                else { ToolbarItem(placement: .topBarLeading) { Wordmark() } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { store.path.append(.search) } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search")
                    Menu {
                        Button("Group chat") { store.path.append(.groupchat) }
                        Button("Find a trade") { store.path.append(.snipe("", "")) }
                        Button("Coins to consider") { store.path.append(.proposals) }
                        Button("The Merry Circle") { store.path.append(.circle) }
                        Button("Replay tour") { tourProgress.begin(store, replay: true) }
                        Button("Settings") { store.path.append(.settings) }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("More")
                }
            }
            .navigationDestination(for: Route.self) { route in
                Group {
                switch route {
                case .markets: MarketsScreen()
                case .search: SearchScreen()
                case .searchFor(let query): SearchScreen(initial: query)
                case .approval(let id): ApprovalScreen(id: id)
                case .connectedApps: ConnectionsScreen()
                case .agent(let slug): AgentScreen(slug: slug)
                case .token(let address): TokenScreen(address: address)
                case .settings: SettingsScreen()
                case .settingsProposal(let command): SettingsScreen(proposedCommand: command)
                case .telegram: TelegramScreen()
                case .circle: CircleScreen()
                case .groupchat: GroupChatScreen()
                case .proposals: ProposalsScreen()
                case .xProof: XProofScreen()
                case .holderWallet: WalletProofScreen(linking: true)
                case .walletSignIn: WalletProofScreen(linking: false)
                case .trade(let symbol): TradeScreen(symbol: symbol)
                case .tradeRequest(let symbol, let side, let amount, let address): TradeScreen(symbol: symbol, side: side, amount: amount, address: address)
                case .snipe(let query, let amount): SnipeScreen(query: query, amount: amount)
                case .deposit: DepositScreen()
                case .permissions: PermissionsScreen()
                case .create: GrantScreen(creating: true)
                case .limits: GrantScreen(creating: false)
                case .withdraw: WithdrawScreen()
                case .signIn: SignInScreen()
                }
                }.id(store.generation)
            }
        }.background(Brand.background)
        .task { await store.refreshSession() }
        .task(id: store.generation) {
            await tourProgress.activate(store)
            tourProgress.settle(store)
        }
        .onChange(of: phase) { _, phase in if phase == .active { Task { await tourProgress.sync(store) } } }
        .environmentObject(tourProgress)
        .sensoryFeedback(.selection, trigger: store.likes)
        .sensoryFeedback(.selection, trigger: store.following)
        .environment(\.tourFocus, tourProgress.active ? TourStop.all[tourProgress.step].anchor : nil)
        // Removed at once when it ends, so the next tap reaches the app.
        .overlay { if tourProgress.active { TourOverlay().environmentObject(tourProgress) } }
        .alert("Merrymen", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
            Button("OK", role: .cancel) { store.notice = nil }
        } message: { Text(store.notice ?? "") }
    }
}

struct Wordmark: View {
    var body: some View {
        HStack(spacing: 7) { Image("Brand").resizable().scaledToFit().frame(width: 32, height: 22); Text("merrymen").font(.custom(Brand.pixel, size: 17, relativeTo: .headline)) }
            .fixedSize().accessibilityElement(children: .ignore).accessibilityLabel("Merrymen")
    }
}

struct Page<Content: View>: View {
    @Environment(\.tourFocus) private var tourFocus
    @ViewBuilder var content: Content
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView { VStack(alignment: .leading, spacing: 20) { content }.padding(18).frame(maxWidth: 800) }
                .scrollDismissesKeyboard(.interactively)
                .background { PageBackground() }
                // Bring whatever the tour is describing into view.
                .onChange(of: tourFocus) { _, focus in
                    guard let focus else { return }
                    Task { try? await Task.sleep(for: .milliseconds(250)); withAnimation(.spring(duration: 0.4)) { proxy.scrollTo("tour.\(focus)", anchor: .center) } }
                }
        }
    }
}
/// Near-black with a faint accent glow at the top, so screens are not a flat void.
struct PageBackground: View {
    var body: some View {
        ZStack(alignment: .top) {
            Brand.background
            RadialGradient(colors: [Brand.accent.opacity(0.13), .clear], center: .topLeading, startRadius: 10, endRadius: 420).frame(height: 520)
            RadialGradient(colors: [Brand.up.opacity(0.06), .clear], center: .topTrailing, startRadius: 10, endRadius: 360).frame(height: 440)
        }.ignoresSafeArea()
    }
}
struct Card<Content: View>: View {
    var hero = false
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(hero ? Brand.heroFill : Brand.cardFill, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(hero ? Brand.accent.opacity(0.28) : Brand.stroke))
    }
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
    var body: some View { ViewThatFits(in: .horizontal) {
        HStack { Text(LocalizedStringKey(label)).foregroundStyle(.secondary); Spacer(); Text(value).monospacedDigit() }
        VStack(alignment: .leading, spacing: 4) { Text(LocalizedStringKey(label)).foregroundStyle(.secondary); Text(value).monospacedDigit().textSelection(.enabled) }
    } }
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
/// An agent's face, drawn with the web terminal's recipe (web/src/lib/agent-avatar.ts):
/// a gradient seeded on the slug, the name's initials, and any uploaded image on top.
/// A rounded square, so it never reads as a coin logo (a circle) beside one.
struct Avatar: View {
    @EnvironmentObject var store: AppStore
    let slug: String?
    var size: CGFloat = 40
    var name: String? = nil
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        ZStack {
            AgentFace.gradient(AgentFace.seed(name: name ?? "", slug: slug))
            Text(AgentFace.initials(name ?? slug ?? "")).font(.system(size: size * 0.34, weight: .bold)).foregroundStyle(.white)
            AsyncImage(url: slug.flatMap { URL(string: "https://app.merrymen.dev/api/agent-image/\(escaped($0))/avatar?v=\(store.imageRevision.uuidString)") }) { image in image.resizable().scaledToFill() } placeholder: { Color.clear }
        }
        .frame(width: size, height: size).clipShape(shape).accessibilityHidden(true)
    }
}

enum AgentFace {
    private static let publicSlug = try! Regex("^[0-9a-hjkmnp-tv-z]{16}$")
    /// The slug when it is a real public id (stable across renames), else the name.
    static func seed(name: String, slug: String?) -> String {
        if let slug, slug.wholeMatch(of: publicSlug) != nil { return slug }
        return name
    }
    /// Matches hueOf: JavaScript string char codes are UTF-16 units.
    /// A readable name colour for dark bubbles, from the same seed as the face.
    static func color(_ seed: String) -> Color { hsl(Double(hue(seed)), 0.7, 0.66) }
    static func hue(_ seed: String) -> Int { seed.utf16.reduce(0) { ($0 * 31 + Int($1)) % 360 } }
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        guard let first = words.first else { return "??" }
        if words.count == 1 { return String(first.prefix(2)).uppercased() }
        return (String(first.prefix(1)) + String(words[1].prefix(1))).uppercased()
    }
    static func gradient(_ seed: String) -> LinearGradient {
        let h = Double(hue(seed))
        return LinearGradient(colors: [hsl(h, 0.62, 0.62), hsl((h + 42).truncatingRemainder(dividingBy: 360), 0.58, 0.44)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    private static func hsl(_ h: Double, _ s: Double, _ l: Double) -> Color {
        let c = (1 - abs(2 * l - 1)) * s, x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1)), m = l - c / 2
        let (r, g, b): (Double, Double, Double) = switch h {
        case ..<60: (c, x, 0)
        case ..<120: (x, c, 0)
        case ..<180: (0, c, x)
        case ..<240: (0, x, c)
        case ..<300: (x, 0, c)
        default: (c, 0, x)
        }
        return Color(red: r + m, green: g + m, blue: b + m)
    }
}

/// A token's logo, falling back to the ticker. Takes the shared market rows'
/// `logo` as-is (an https mark, or a site-relative /api/coin-image path); a raw
/// launcher URI must go through `CoinLogo.proxied` first, as the web does,
/// because public IPFS gateways refuse phone user agents.
struct CoinLogo: View {
    let logo: String?
    let symbol: String
    var size: CGFloat = 36
    static func proxied(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        return "/api/coin-image?uri=\(escaped(raw))"
    }
    private var url: URL? {
        guard let logo, !logo.isEmpty else { return nil }
        if logo.hasPrefix("/") { return URL(string: logo, relativeTo: API.origin)?.absoluteURL }
        return logo.hasPrefix("https://") ? URL(string: logo) : nil
    }
    var body: some View {
        ZStack {
            Circle().fill(Brand.raised)
            Text(String(symbol.prefix(3)).uppercased()).font(.system(size: size * 0.28, weight: .bold)).foregroundStyle(.secondary).minimumScaleFactor(0.5)
            AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Color.clear }
        }
        .frame(width: size, height: size).clipShape(Circle()).overlay(Circle().strokeBorder(Brand.stroke)).accessibilityHidden(true)
    }
}

