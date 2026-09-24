import SwiftUI
import PrivySDK
import MerrymenPolicy

enum Tab: String, CaseIterable { case home = "Home", chat = "Chat", feed = "Feed", alpha = "Alpha", profile = "Profile"
    var icon: String { switch self { case .home: "chart.xyaxis.line"; case .chat: "bubble.left.and.bubble.right"; case .feed: "leaf.fill"; case .alpha: "sparkles"; case .profile: "person.crop.circle" } }
}
enum Route: Hashable {
    case holderWallet, walletSignIn
    case snipe(String, String), tradeRequest(String, String, String, String?)
    case markets, search, agent(String), token(String), settings, telegram, circle, groupchat, proposals, xProof
    case trade(String), deposit, permissions, create, limits, withdraw, signIn, siteAccess, tour
}

@MainActor
final class AppStore: ObservableObject {
    let api = API()
    @Published var tab: Tab = .feed
    @Published var path: [Route] = []
    @Published var owner: String?
    @Published var sessionError: String?
    @Published var generation = 0
    @Published var imageRevision = UUID()
    @Published var notice: String?
    @Published var watchlist: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "watchlist") ?? [])
    @Published var likes: Set<String> = []
    @Published var following: Set<String> = []
    private(set) var privy: (any Privy)?

    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"), ProcessInfo.processInfo.arguments.contains("-reset-tour") {
            for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("merrymen.native.tour.") { UserDefaults.standard.removeObject(forKey: key) }
            UserDefaults.standard.set("en", forKey: "language")
        }
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"), ProcessInfo.processInfo.arguments.contains("-order-timeout") {
            path = [.trade("NVDA")]
            if ProcessInfo.processInfo.arguments.contains("-reset-order") {
                UserDefaults.standard.removeObject(forKey: "uiTest.orderPlaced")
                try? SecureStore.remove("dev.merrymen.orders", "pendingOrder.0x1111111111111111111111111111111111111111")
            }
        }
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"), ProcessInfo.processInfo.arguments.contains("-snipe-test") {
            path = [.snipe("NEON", "5.00")]
            UserDefaults.standard.removeObject(forKey: "uiTest.orderPlaced")
            try? SecureStore.remove("dev.merrymen.orders", "pendingOrder.0x1111111111111111111111111111111111111111")
        }
        #endif
        let app = Bundle.main.object(forInfoDictionaryKey: "PrivyAppID") as? String ?? ""
        let client = Bundle.main.object(forInfoDictionaryKey: "PrivyClientID") as? String ?? ""
        if !app.isEmpty, !client.isEmpty, !app.contains("$("), !client.contains("$(") {
            privy = PrivySdk.initialize(config: PrivyConfig(appId: app, appClientId: client))
        }
    }

    func refreshSession() async {
        let initialGeneration = generation
        do {
            let v = try await api.request("/api/auth/session")
            guard initialGeneration == generation else { return }
            let next = v["address"].string
            if next != owner { owner = next; generation += 1; likes = []; following = [] }
            sessionError = nil
            if next != nil {
                let accountGeneration = generation
                if let l = try? await api.request("/api/likes"), l["read"].bool == true, accountGeneration == generation { likes = Set(l["liked"].array.compactMap(\.string)) }
                if let f = try? await api.request("/api/follow"), accountGeneration == generation { following = Set(f["wired"].array.compactMap(\.string)) }
            }
        } catch { sessionError = error.localizedDescription }
    }

    func establishSession(_ user: any PrivyUser, provider: String) async throws {
        let wallet: any EmbeddedEthereumWallet
        if let existing = user.embeddedEthereumWallets.first { wallet = existing }
        else { wallet = try await user.createEthereumWallet() }
        let challenge = try await api.request("/api/auth/privy")
        guard let message = challenge["message"].string, let nonce = challenge["nonce"].string,
              nonce.range(of: "^[A-Za-z0-9_.-]{1,512}$", options: .regularExpression) != nil,
              message == ["\(API.origin.absoluteString) wants you to sign in with your merrymen wallet.", "",
                          "This proves you control the owner key. It moves no funds and grants no permissions.", "",
                          "URI: \(API.origin.absoluteString)", "Nonce: \(nonce)"].joined(separator: "\n")
        else { throw APIError(status: 0, message: "The sign-in challenge is invalid.") }
        let signature = try await wallet.provider.request(.personalSign(message: message, address: wallet.address))
        let token = try await user.getAccessToken()
        _ = try await api.request("/api/auth/privy", method: "POST", body: .object([
            "nonce": .string(nonce), "signature": .string(signature), "address": .string(wallet.address), "provider": .string(provider)
        ]), token: token)
        await refreshSession()
        guard owner?.lowercased() == wallet.address.lowercased() else { throw APIError(status: 401, message: sessionError ?? "Sign-in did not establish the expected wallet session.") }
    }

    func signOut() async {
        do {
            _ = try await api.request("/api/auth/logout", method: "POST", body: .object([:]))
            if let user = await privy?.getUser() { await user.logout() }
            try api.forget(); owner = nil; path = []; tab = .feed; likes = []; following = []; generation += 1
        } catch { notice = "Sign-out could not be confirmed: \(error.localizedDescription)" }
    }

    func perform(_ path: String, method: String = "POST", body: J, expectedOwner: String?) async throws -> J {
        let expectedGeneration = generation
        let session = api.binding()
        try await verifyOwner(expectedOwner)
        let result = try await api.request(path, method: method, body: body, expectedSession: session)
        guard generation == expectedGeneration, owner == expectedOwner else { throw APIError(status: 409, message: "Your account changed while the request was in progress. Check the previous account before repeating that action.") }
        return result
    }

    func verifyOwner(_ expectedOwner: String?) async throws {
        guard let expectedOwner, expectedOwner == owner else { throw APIError(status: 401, message: "Sign in again before confirming this action.") }
        let expectedGeneration = generation; let binding = api.binding()
        let session = try await api.request("/api/auth/session")
        guard expectedGeneration == generation, owner == expectedOwner, api.matches(binding), session["address"].string?.lowercased() == expectedOwner.lowercased() else {
            await refreshSession()
            throw APIError(status: 409, message: "Your account changed. Review this action again.")
        }
    }

    func toggleWatch(_ address: String) {
        if watchlist.contains(address) { watchlist.remove(address) } else { watchlist.insert(address) }
        UserDefaults.standard.set(Array(watchlist), forKey: "watchlist")
    }

    func toggleLike(_ id: String) async {
        do {
            let r = try await perform("/api/likes", body: .object(["postId": .string(id), "on": .bool(!likes.contains(id))]), expectedOwner: owner)
            guard r["read"].bool == true else { throw APIError(status: 503, message: "Could not read your likes.") }
            likes = Set(r["liked"].array.compactMap(\.string))
        } catch { notice = error.localizedDescription }
    }

    func toggleFollow(_ slug: String) async {
        do {
            let r = try await perform("/api/follow", body: .object(["target": .string(slug), "on": .bool(!following.contains(slug))]), expectedOwner: owner)
            guard r["read"].bool != false else { throw APIError(status: 503, message: "Could not read your follows.") }
            following = Set(r["wired"].array.compactMap(\.string))
            if let refusal = r["refused"].string { notice = refusal == "self" ? "You cannot follow your own agent." : "Your follow list is full." }
        } catch { notice = error.localizedDescription }
    }

    func open(_ url: URL) {
        guard let u = NavigationPolicy().deepLink(url) else { return }
        switch u.path {
        case "/", "/feed": tab = .feed; path = []
        case "/home", "/leaderboard": tab = .home; path = []
        case "/chat", "/agent": tab = .chat; path = []
        case "/alpha": tab = .alpha; path = []
        case "/profile", "/you": tab = .profile; path = []
        case "/settings": path.append(.settings)
        case "/search": path.append(.search)
        case "/groupchat": path.append(.groupchat)
        case "/create": path.append(.create)
        case "/grant": path.append(.permissions)
        case "/limits": path.append(.limits)
        case "/deposit": path.append(.deposit)
        case "/withdraw": path.append(.withdraw)
        case "/tokens": path.append(.markets)
        default:
            if u.path.hasPrefix("/a/") { path.append(.agent(String(u.path.dropFirst(3)))) }
            if u.path.hasPrefix("/t/") { path.append(.token(String(u.path.dropFirst(3)))) }
        }
    }
}
