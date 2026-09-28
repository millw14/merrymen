import Foundation

/// Deep links select product screens and never carry an executable action.
public struct NavigationPolicy {
    public let origin = URL(string: "https://app.merrymen.dev")!

    public init() {}

    public func isApp(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == origin.host &&
            (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }

    public func isHTTPS(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host != nil &&
            url.user == nil && url.password == nil
    }

    // Only public/product routes can be deep-linked. Never route a custom URL
    // into /api, OAuth callbacks, sign-out, javascript:, file: or an arbitrary host.
    public static let routes: Set<String> = [
        "/", "/home", "/feed", "/chat", "/agent", "/alpha", "/profile", "/you",
        "/search", "/create", "/settings", "/grant", "/limits", "/deposit", "/withdraw",
        "/groupchat", "/leaderboard", "/tokens", "/connect/apps"
    ]

    public func isProductPath(_ path: String) -> Bool {
        if Self.routes.contains(path) { return true }
        // An assistant's approval link opens its review screen; approving is
        // still a separate tap there. Only the exact proposal-id shape passes.
        if path.wholeMatch(of: #/\/connect\/approve\/prp_[0-9a-f]{32}/#) != nil { return true }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return parts.count == 3 && parts[0].isEmpty && ["a", "t"].contains(String(parts[1])) &&
            !parts[2].isEmpty && ![".", ".."].contains(String(parts[2])) &&
            !path.contains("\\") && !path.contains("%")
    }

    public func deepLink(_ url: URL) -> URL? {
        guard url.user == nil, url.password == nil else { return nil }
        let path: String
        if url.scheme?.lowercased() == "merrymen" {
            guard url.host == "app", url.port == nil else { return nil }
            path = url.path.isEmpty ? "/" : url.path
        } else if isApp(url) {
            path = url.path.isEmpty ? "/" : url.path
        } else { return nil }
        guard isProductPath(path), var result = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        result.path = path
        // Deep links select a screen; they never inject an authorization query.
        return result.url
    }

    /// Share screen identity, never OAuth codes, invitation secrets or fragments.
    public func shareURL(_ url: URL?) -> URL? {
        guard let url, isApp(url), isProductPath(url.path) else { return nil }
        return deepLink(url)
    }

    // MARK: Posting on X — the connect sheet and the links it leaves behind
    //
    // CONNECTING AN X ACCOUNT IS THE ONLY OAUTH THIS APP RUNS ITSELF, AND ITS
    // CALLBACK IS NEVER A DEEP LINK. The server (POST /api/x/connect start)
    // answers with X's authorize URL; the app opens it in an ephemeral web
    // authentication sheet whose callback scheme is `merrymen`. X sends the
    // owner to the web page /connect/x, which hands the code on to
    // `merrymen://x-connect?code&state`, and that URL is read ONLY as the
    // completion of the sheet this app opened — through xConnectAnswer, bound
    // to the state of that very authorize URL. `deepLink` does not route it
    // (its host is not `app`, and /connect/x is not a product route), so an
    // x-connect link opened any other way — from Safari, a message, another
    // app — does nothing at all.

    /// X's own authorize page and nothing else: https, the host exactly
    /// `x.com` or `twitter.com` (not a subdomain, not a lookalike such as
    /// `x.com.evil.test`, not `x.com.`), the default port, no userinfo, no
    /// fragment, and the path exactly `/i/oauth2/authorize`. A server answer
    /// that is anything else opens nothing.
    public func isXAuthorize(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme?.lowercased() == "https",
              let host = c.percentEncodedHost?.lowercased(), ["x.com", "twitter.com"].contains(host),
              c.port == nil || c.port == 443, c.user == nil, c.password == nil, c.fragment == nil else { return false }
        return c.percentEncodedPath == "/i/oauth2/authorize"
    }

    /// The state an iOS connect's authorize URL carries — `i.` and URL-safe
    /// characters, exactly once — or nil. The `i.` prefix is what makes the
    /// /connect/x page hand the code to this app; a web (`w.`) state would
    /// finish inside the sheet, where the owner's session is not, so the app
    /// refuses to open one rather than start a connect that cannot finish.
    public func xConnectState(_ authorize: URL) -> String? {
        guard isXAuthorize(authorize),
              let states = URLComponents(url: authorize, resolvingAgainstBaseURL: false)?.queryItems?.filter({ $0.name == "state" }),
              states.count == 1, let state = states[0].value,
              state.wholeMatch(of: #/i\.[A-Za-z0-9_-]{16,128}/#) != nil else { return nil }
        return state
    }

    public enum XConnectAnswer: Equatable, Sendable {
        /// The owner approved on X: finish the connect with this code.
        case approved(code: String)
        /// The owner said no on X (or X did not finish). A choice, not a failure; nothing is sent.
        case declined
    }

    /// The sheet's callback, read only as the answer to the connect whose
    /// authorize URL carried `state`: `merrymen://x-connect?code=…&state=…`,
    /// or `?error=…&state=…`. Every other shape — another host or path, a
    /// state that is not this connect's, a parameter given twice, userinfo, a
    /// fragment, a code with characters no OAuth code has — is nil, and the
    /// app sends nothing.
    public func xConnectAnswer(_ callback: URL, state: String) -> XConnectAnswer? {
        guard let c = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              c.scheme?.lowercased() == "merrymen", c.percentEncodedHost?.lowercased() == "x-connect",
              c.port == nil, c.user == nil, c.password == nil, c.fragment == nil,
              c.percentEncodedPath.isEmpty || c.percentEncodedPath == "/" else { return nil }
        let items = c.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count, !state.isEmpty,
              items.first(where: { $0.name == "state" })?.value == state else { return nil }
        if items.contains(where: { $0.name == "error" }) { return .declined }
        guard let code = items.first(where: { $0.name == "code" })?.value,
              code.wholeMatch(of: #/[A-Za-z0-9._~+\/=:-]{1,2048}/#) != nil else { return nil }
        return .approved(code: code)
    }

    /// A link to one post on X, to open in the browser: exactly
    /// `https://x.com/<handle>/status/<id>`. Anything else is not shown as a
    /// link, whatever the server sent.
    public func isXPostLink(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme?.lowercased() == "https", c.percentEncodedHost?.lowercased() == "x.com",
              c.port == nil, c.user == nil, c.password == nil, c.fragment == nil,
              c.percentEncodedQuery?.isEmpty ?? true else { return false }
        return c.percentEncodedPath.wholeMatch(of: #/\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,25}/#) != nil
    }

    public func downloadName(_ suggested: String) -> String {
        let leaf = suggested.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? "download"
        let clean = leaf.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let result = String(String.UnicodeScalarView(clean)).prefix(150)
        return result.isEmpty || result == "." || result == ".." ? "download" : String(result)
    }
}
