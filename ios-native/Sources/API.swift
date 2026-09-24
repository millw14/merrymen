import Foundation
import Combine
import Security
import MerrymenPolicy

typealias J = JSONValue

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

final class API: NSObject, URLSessionTaskDelegate {
    static let origin = URL(string: "https://app.merrymen.dev")!
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.timeoutIntervalForRequest = 45
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-testing") || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { c.protocolClasses = [PreviewTransport.self] }
        #endif
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()
    private let lock = NSLock()
    private var cookieHeader = ""
    private var epoch = 0
    private var recoveryCookie: HTTPCookie?

    override init() {
        super.init()
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.merrymen.session", kSecAttrAccount as String: "cookie",
            kSecReturnData as String: true]
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data {
            cookieHeader = String(data: data, encoding: .utf8) ?? ""
        }
    }

    private func snapshot() -> (header: String, epoch: Int) { lock.lock(); defer { lock.unlock() }; return (cookieHeader, epoch) }
    func forget() throws { lock.lock(); defer { lock.unlock() }; epoch += 1; cookieHeader = ""; recoveryCookie = nil; try persistCookies("") }
    private func mergeCookies(_ fresh: [HTTPCookie], expectedEpoch: Int) throws {
        lock.lock(); defer { lock.unlock() }
        guard epoch == expectedEpoch else { return }
        var parts = Dictionary(cookieHeader.split(separator: ";").compactMap { part -> (String, String)? in
            let p = part.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1).map(String.init)
            return p.count == 2 ? (p[0], p[1]) : nil
        }, uniquingKeysWith: { _, b in b })
        for c in fresh where ["mm_session", "mm_gate"].contains(c.name) && c.domain == Self.origin.host! {
            if c.value.isEmpty || (c.expiresDate.map { $0 < Date() } ?? false) { parts.removeValue(forKey: c.name) }
            else { parts[c.name] = c.value }
        }
        for c in fresh where c.name == "merrymen_recovery" && c.domain == Self.origin.host! && c.path == "/api/bundler" { recoveryCookie = c }
        let next = parts.map { "\($0.key)=\($0.value)" }.joined(separator: "; ")
        try persistCookies(next)
        cookieHeader = next
    }
    private func persistCookies(_ value: String) throws {
        if value.isEmpty { try SecureStore.remove("dev.merrymen.session", "cookie") }
        else { try SecureStore.write("dev.merrymen.session", "cookie", Data(value.utf8)) }
    }

    func request(_ path: String, method: String = "GET", body: J? = nil, token: String? = nil) async throws -> J {
        let data = try body.map { try JSONEncoder().encode($0) }
        return try await bytes(path, method: method, data: data, contentType: "application/json", token: token)
    }

    func bytes(_ path: String, method: String, data: Data?, contentType: String, token: String? = nil) async throws -> J {
        let (responseData, http) = try await raw(path, method: method, data: data, contentType: contentType, token: token)
        return try decode(responseData, http: http, path: path)
    }
    func raw(_ path: String, method: String, data: Data?, contentType: String = "application/json", token: String? = nil) async throws -> (Data, HTTPURLResponse) {
        guard path.hasPrefix("/api/"), !path.hasPrefix("//"),
              let url = URL(string: path, relativeTo: Self.origin)?.absoluteURL,
              NavigationPolicy().isApp(url) else { throw APIError(status: 0, message: "Invalid API destination.") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.httpBody = data
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let sent = snapshot()
        req.setValue(sent.header, forHTTPHeaderField: "Cookie")
        if path.hasPrefix("/api/bundler/") {
            let ticket = recoveryHeader()
            if !ticket.isEmpty { req.setValue([sent.header, ticket].filter { !$0.isEmpty }.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        }
        if let data { req.setValue(String(data.count), forHTTPHeaderField: "Content-Length") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (responseData, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "No server response.") }
        if let headers = http.allHeaderFields as? [String: String] {
            let fresh = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
            if !fresh.isEmpty { try mergeCookies(fresh, expectedEpoch: sent.epoch) }
        }
        return (responseData, http)
    }
    private func recoveryHeader() -> String {
        lock.lock(); defer { lock.unlock() }
        guard let c = recoveryCookie, let expiry = c.expiresDate, expiry > Date() else { return "" }
        return "\(c.name)=\(c.value)"
    }
    private func decode(_ responseData: Data, http: HTTPURLResponse, path: String) throws -> J {
        if path == "/api/gate", http.statusCode == 303 {
            guard http.value(forHTTPHeaderField: "Location") == "/" else { throw APIError(status: 401, message: "That site password was not accepted.") }
            return .object(["ok": .bool(true)])
        }
        let value = try? JSONDecoder().decode(J.self, from: responseData)
        guard (200..<300).contains(http.statusCode) else {
            let words = value?["errors"].array.compactMap(\.string).joined(separator: "\n") ?? ""
            let message = words.isEmpty ? (value?["error"].string ?? value?["detail"].string ?? value?["why"].string ?? "Server returned \(http.statusCode).") : words
            throw APIError(status: http.statusCode, message: message == "gated" ? "This beta needs a site password. Open Profile → Site access." : message)
        }
        guard let value else { throw APIError(status: http.statusCode, message: "The server response could not be read.") }
        return value
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward the session or bearer token to a redirected host.
        completionHandler(nil)
    }
}

@MainActor
final class RemoteData: ObservableObject {
    @Published var value: J?
    @Published var error: String?
    @Published var refreshing = false
    func load(_ api: API, _ path: String) async {
        refreshing = true
        defer { refreshing = false }
        do { let next = try await api.request(path); guard !Task.isCancelled else { return }; value = next; error = nil }
        catch is CancellationError { }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
