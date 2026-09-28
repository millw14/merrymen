import SwiftUI
import AuthenticationServices
import MerrymenPolicy

/// POSTING ON X — the owner's switch for letting their Merryman post from an X
/// account they connect (docs/x-posting.md; web Settings "Posting on X").
///
/// OPT-IN, AND BOUND TO THE ACCOUNT THE OWNER SAW. Connecting is not consent.
/// The switch never writes when it is flipped on: it opens a warning that
/// names the connected account (`@handle`, as the server read it from X), and
/// only that warning's own button sends `enable` — carrying the X user id the
/// warning named, so the server refuses (409) if a different account is
/// connected by then, and the device's time zone, so nothing goes out while
/// the owner is asleep. "Not now", or dismissing the warning, sends nothing.
/// Turning it off sends `disable` at once: that direction is always safe.
///
/// UNREAD IS NOT "NOT CONNECTED". The screen shows the connect button only
/// when the server said, in the expected shape, that nothing is connected. A
/// failed or malformed read shows the failure and a retry, never an offer to
/// connect, and no switch acts on a guess.
///
/// THE CONNECT SHEET IS EPHEMERAL, AND ITS CALLBACK IS READ ONLY HERE. X's
/// authorize page opens in a web authentication sheet that does not share
/// Safari's cookies, so the owner signs in to the X account they mean rather
/// than whichever one Safari happened to hold. The server's URL must be X's
/// own authorize page (NavigationPolicy.isXAuthorize) with an iOS state; the
/// sheet's `merrymen://x-connect` answer is accepted only with that same state
/// (xConnectAnswer). Closing the sheet or saying no on X (`access_denied`) is
/// a choice, not a failure, and closes quietly; any other error X answers
/// with is X failing, and the owner is told so. If the owner changed while X
/// was open, nothing is finished.
///
/// WHAT THIS SCREEN DOES NOT DO: it never posts, drafts or edits a post, and
/// it never shows a post it has not read from the server. Drafts are shown
/// exactly as they will go out, and Skip cancels one; a post the server has
/// already claimed for sending answers 409 and is not half-skipped.
struct XPostingScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.webAuthenticationSession) private var webAuthentication
    @Environment(\.scenePhase) private var phase
    @State private var account: XPostingAccount?
    @State private var readError: String?
    @State private var paper = false
    @State private var busy = false
    @State private var connecting = false
    @State private var skipping: Int?
    /// The account the open warning names; enabling sends exactly this id.
    @State private var consent: XPostingAccount.Identity?
    @State private var confirmDisconnect = false
    private let policy = NavigationPolicy()

    var body: some View {
        Page {
            if store.owner == nil { SignInCard() }
            else {
                if let readError {
                    Label(readError, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout)
                    if account != nil { Text("Showing the last response. It may be out of date.").font(.caption).foregroundStyle(.secondary) }
                    Button("Retry") { Task { await load() } }.disabled(busy)
                }
                if let account { content(account) }
                else if readError == nil { ProgressView("Loading…").frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Posting on X")
        .task(id: "\(store.generation)|\(phase == .active)") {
            guard phase == .active else { return }
            repeat {
                await load()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            } while !Task.isCancelled
        }
        .refreshable { await load() }
        .alert(Text(verbatim: "Post on X as @\(consent?.handle ?? "")?"), isPresented: Binding(get: { consent != nil }, set: { if !$0 { consent = nil } }), presenting: consent) { identity in
            Button { enable(identity) } label: { Text(verbatim: "Let it post as @\(identity.handle)") }
            Button("Not now", role: .cancel) {}
        } message: { identity in Text(verbatim: XPostingAccount.warning(identity.handle)) }
        .confirmationDialog(Text(verbatim: account?.identity.map { "Disconnect @\($0.handle)?" } ?? "Disconnect X?"), isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { write([:], method: "DELETE") }
        } message: { Text("Your Merryman stops posting and anything waiting to go out is cancelled.") }
    }

    @ViewBuilder private func content(_ account: XPostingAccount) -> some View {
        if !account.connected {
            Card(hero: true) {
                Text("Posting on X").font(.title2.bold())
                Text("Let your Merryman post on X in its own words — a hello when it starts, the odd casual thought, and now and then a coin it bought and why. No trade alerts, no error messages, no numbers.").foregroundStyle(.secondary)
                if account.available { connectButton("Connect X account") }
                else { Label("Posting on X isn't available right now.", systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(.secondary) }
            }
        } else {
            Card(hero: true) {
                Text("Posting on X").font(.title2.bold())
                if let identity = account.identity {
                    Text(verbatim: "Connected as @\(identity.handle)").font(.headline)
                } else {
                    Label("The connected X account could not be read. Pull to reload, or disconnect and connect again.", systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.orange)
                }
                if account.revoked {
                    Label("X stopped accepting this connection. Reconnect to keep posting.", systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange)
                    if account.available { connectButton("Reconnect X account") }
                }
                Toggle("Let my Merryman post on X", isOn: Binding(get: { account.postingEnabled }, set: { on in
                    guard !busy else { return }
                    // Never a write: turning it on only opens the warning.
                    if on { consent = account.identity } else { write(["action": .string("disable")]) }
                }))
                .disabled(busy || (!account.postingEnabled && (account.identity == nil || account.revoked)))
                if account.postingEnabled, let identity = account.identity {
                    Text(verbatim: "Posting from @\(identity.handle) — whichever X account is connected.").font(.caption).foregroundStyle(.orange)
                }
                if paper { Text("While your Merryman trades on paper, its buy posts say so.").font(.caption).foregroundStyle(.secondary) }
                Button("Disconnect", role: .destructive) { confirmDisconnect = true }.buttonStyle(SecondaryButtonStyle(fill: true)).disabled(busy)
            }
            SectionHeader(title: "Coming up")
            if account.upcoming.isEmpty { Text("Nothing waiting to go out.").font(.subheadline).foregroundStyle(.secondary) }
            ForEach(account.upcoming) { post in
                Card {
                    Text(verbatim: post.body).textSelection(.enabled)
                    HStack {
                        Text(verbatim: post.at > .now ? "Goes out \(post.at.formatted(.relative(presentation: .named)))" : "Going out soon").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        // Several drafts mean several Skips: VoiceOver hears which post each one skips.
                        Button { skip(post) } label: { if skipping == post.id { ProgressView() } else { Text("Skip") } }
                            .buttonStyle(SecondaryButtonStyle()).disabled(busy)
                            .accessibilityLabel("Skip post").accessibilityHint(Text(verbatim: post.body))
                    }
                }
            }
        }
        if !account.recent.isEmpty {
            SectionHeader(title: "Posted")
            ForEach(account.recent) { post in
                Card {
                    Text(verbatim: post.body).textSelection(.enabled)
                    HStack {
                        Text(verbatim: "Posted \(post.at.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if let link = post.link { Link(destination: link) { Label("View on X", systemImage: "arrow.up.right.square") }.font(.subheadline.weight(.semibold)).foregroundStyle(Brand.accent) }
                    }
                }
            }
        }
    }

    private func connectButton(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { connect() } label: { if connecting { ProgressView().tint(.black) } else { Text(title) } }
                .buttonStyle(XButtonStyle()).disabled(busy)
            Text("You'll approve it on X. Your Merryman will post from whichever X account you approve there, so check which account you're signed into on X first.").font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: reading

    private func load() async {
        guard let owner = store.owner else { account = nil; return }
        let generation = store.generation
        do {
            let value = try await store.api.request("/api/x/account")
            guard generation == store.generation, owner == store.owner, !Task.isCancelled else { return }
            guard let next = XPostingAccount(value, policy: policy) else { throw APIError(status: 0, message: "Your X connection could not be read.") }
            account = next; readError = nil
            // Best effort, only for the paper note: an unread mode shows no note.
            var grants: J?
            if next.connected { grants = try? await store.api.request("/api/grants") }
            guard generation == store.generation, owner == store.owner else { return }
            paper = grants?["exists"].bool == true && grants?["mode"].string == "paper"
        } catch is CancellationError {
        } catch let failure as APIError where failure.status == 404 {
            guard generation == store.generation else { return }
            readError = "Posting on X isn't available here."
        } catch {
            guard generation == store.generation, !Task.isCancelled else { return }
            readError = error.localizedDescription
        }
    }

    // MARK: writing — every body names the owner who acted; the server refuses another session

    /// CONSENT CARRIES THE DEVICE'S ZONE. The Merryman plans and sends nothing
    /// while the owner is asleep, but only if it knows where the owner is; the
    /// room's zone is often unknown (an iOS-only owner who never opened its
    /// picker, a fleet with the room off). So the zone this phone is in goes
    /// with the consent, as an IANA name, and the server keeps it as the
    /// fallback. It validates the name and treats a placeless one (UTC, GMT)
    /// as unknown, so this sends what the device says and decides nothing.
    private func enable(_ identity: XPostingAccount.Identity) {
        write(XPostingAccount.enableFields(identity, zone: .current))
    }

    private func skip(_ post: XPostingAccount.Post) {
        guard !busy else { return }
        skipping = post.id
        write(["action": .string("skip"), "id": .number(Double(post.id))])
    }

    /// One owner-bound write to /api/x/account, then a fresh read either way.
    /// A refusal (a changed account, a post already on its way) is shown in the
    /// server's own words.
    private func write(_ fields: [String: J], method: String = "POST") {
        guard !busy, let owner = store.owner else { skipping = nil; return }
        busy = true
        var body = fields
        body["owner"] = .string(owner)
        Task {
            defer { busy = false; skipping = nil }
            do { _ = try await store.perform("/api/x/account", method: method, body: .object(body), expectedOwner: owner) }
            catch { store.notice = error.localizedDescription }
            await load()
        }
    }

    // MARK: connecting

    private func connect() {
        guard !busy, let owner = store.owner else { return }
        busy = true; connecting = true
        let generation = store.generation
        Task {
            defer { busy = false; connecting = false }
            do {
                let started = try await store.perform("/api/x/connect", body: .object(["action": .string("start"), "client": .string("ios"), "owner": .string(owner)]), expectedOwner: owner)
                guard let raw = started["url"].string, let url = URL(string: raw), policy.isXAuthorize(url), let state = policy.xConnectState(url) else {
                    throw APIError(status: 0, message: "Merrymen sent an X sign-in link this app does not recognise, so nothing was opened.")
                }
                let callback: URL
                do { callback = try await authorize(url) }
                catch let failure as NSError where failure.domain == ASWebAuthenticationSessionError.errorDomain && failure.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                    return // Closing X's sheet is a choice, not a failure.
                }
                guard generation == store.generation, owner == store.owner else {
                    throw APIError(status: 409, message: "Your account changed while X was open, so nothing was connected. Connect again from this account.")
                }
                switch policy.xConnectAnswer(callback, state: state) {
                case .declined: return // Saying no on X is a choice too; nothing is sent.
                case .failed: // X's own error, not the owner's choice: say so rather than close in silence.
                    throw APIError(status: 0, message: "X couldn't finish connecting, so nothing was connected. Try again in a moment.")
                case .approved(let code):
                    let finished = try await store.perform("/api/x/connect", body: .object(["action": .string("finish"), "code": .string(code), "state": .string(state), "owner": .string(owner)]), expectedOwner: owner)
                    // A reconnect of the same account keeps the owner's earlier consent: say so, it posts again now.
                    if let notice = XPostingAccount.postingBackOn(finished) { store.notice = notice }
                case nil:
                    throw APIError(status: 0, message: "That answer from X wasn't for this connection, so nothing was connected. Try again.")
                }
            } catch { store.notice = error.localizedDescription }
            await load()
        }
    }

    /// X's page in a sheet that shares no cookies with Safari, ending at the
    /// app's own scheme. The sheet's answer is returned, never routed.
    private func authorize(_ url: URL) async throws -> URL {
        if #available(iOS 17.4, *) {
            return try await webAuthentication.authenticate(using: url, callback: .customScheme("merrymen"), preferredBrowserSession: .ephemeral, additionalHeaderFields: [:])
        }
        return try await webAuthentication.authenticate(using: url, callbackURLScheme: "merrymen", preferredBrowserSession: .ephemeral)
    }
}

/// GET /api/x/account, read strictly. Nil when the answer does not have the
/// contract's shape: the screen then says it could not read the connection
/// rather than guess "not connected".
struct XPostingAccount: Equatable {
    struct Identity: Equatable {
        let handle: String
        let xUserId: String
    }
    struct Post: Identifiable, Equatable {
        let id: Int
        let body: String
        let at: Date
        /// Only ever one post on x.com (NavigationPolicy.isXPostLink).
        let link: URL?
    }
    let available: Bool
    let connected: Bool
    /// Nil when connected but the handle or user id could not be read: then
    /// no warning can name the account, so posting cannot be turned on.
    let identity: Identity?
    let revoked: Bool
    let postingEnabled: Bool
    let upcoming: [Post]
    let recent: [Post]

    init?(_ v: J, policy: NavigationPolicy = NavigationPolicy()) {
        guard let available = v["available"].bool, let connected = v["connected"].bool else { return nil }
        let posting = v["postingEnabled"].bool
        guard posting != nil || !connected else { return nil }
        self.available = available
        self.connected = connected
        postingEnabled = connected && posting == true
        revoked = connected && v["status"].string == "revoked"
        if connected, let handle = v["username"].string, handle.wholeMatch(of: #/[A-Za-z0-9_]{1,15}/#) != nil,
           let id = v["xUserId"].string, id.wholeMatch(of: #/[0-9]{1,25}/#) != nil {
            identity = Identity(handle: handle, xUserId: id)
        } else { identity = nil }
        upcoming = connected ? v["upcoming"].array.compactMap { Self.post($0, time: "dueAt", link: nil) } : []
        recent = v["recent"].array.compactMap { row in Self.post(row, time: "sentAt", link: row["url"].string.flatMap(URL.init(string:)).flatMap { policy.isXPostLink($0) ? $0 : nil }) }
    }

    /// RECONNECTING CAN TURN POSTING BACK ON, AND THE OWNER IS TOLD. When X
    /// stops accepting a connection and the owner reconnects the SAME X
    /// account, the server keeps the consent they gave for it, so the
    /// Merryman posts again from the next pass — with no new warning. The
    /// finish answer says so (`postingEnabled`), and this is the sentence the
    /// owner sees then; nil when posting is off, or the answer does not say
    /// `true` in so many words. A handle that is not an X handle is not shown.
    static func postingBackOn(_ finished: J) -> String? {
        guard finished["postingEnabled"].bool == true else { return nil }
        let handle = finished["username"].string.flatMap { $0.wholeMatch(of: #/[A-Za-z0-9_]{1,15}/#) != nil ? "@\($0)" : nil }
        return "Posting is back on — your Merryman posts from \(handle ?? "the X account you just connected") again. You can see what's coming up, skip it, or turn posting off here."
    }

    /// The confirmed enable, owner aside (every write adds it): the X user id
    /// the warning named and the zone the device is in.
    static func enableFields(_ identity: Identity, zone: TimeZone) -> [String: J] {
        ["action": .string("enable"), "xUserId": .string(identity.xUserId), "tz": .string(zone.identifier)]
    }

    private static func post(_ row: J, time: String, link: URL?) -> Post? {
        guard let id = row["id"].number, id.rounded() == id, id > 0, id < 9_007_199_254_740_992,
              let body = row["body"].string, !body.isEmpty, let ms = row[time].number, ms > 0 else { return nil }
        return Post(id: Int(id), body: body, at: Date(timeIntervalSince1970: ms / 1000), link: link)
    }

    /// The warning the owner confirms, in the words the web uses. It names the
    /// account because that account is what the Merryman will post from.
    ///
    /// THE REVIEW WINDOW IT PROMISES IS THE PLANNER'S FLOOR. Every post is
    /// drafted at least ten minutes before it is due (worker/src/xpost/
    /// planner.ts), and this screen re-reads every minute while it is open —
    /// so "at least ten minutes" is a promise the code keeps, where "you'll see
    /// each one" was not: nothing tells the owner to look.
    static func warning(_ handle: String) -> String {
        [
            "Your Merryman will post from whichever X account is connected — right now that's @\(handle).",
            "It writes its own posts: a hello first, then the odd casual thought and now and then a coin it bought and why. It never posts trade alerts, error messages, prices or amounts.",
            "Posts go out on their own, a few a day at most. Each one waits under Coming up for at least ten minutes first, and you can skip it there. Turn this off or disconnect X at any time.",
            "X may label accounts that post automatically, and may ask an account to verify itself the first time it posts about crypto."
        ].joined(separator: "\n\n")
    }
}
