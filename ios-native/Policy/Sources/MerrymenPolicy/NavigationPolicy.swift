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
        "/groupchat", "/leaderboard", "/tokens"
    ]

    public func isProductPath(_ path: String) -> Bool {
        if Self.routes.contains(path) { return true }
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

    public func downloadName(_ suggested: String) -> String {
        let leaf = suggested.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? "download"
        let clean = leaf.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let result = String(String.UnicodeScalarView(clean)).prefix(150)
        return result.isEmpty || result == "." || result == ".." ? "download" : String(result)
    }
}
