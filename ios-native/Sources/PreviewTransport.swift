#if DEBUG
import Foundation

/// Deterministic UI-test data. Never compiled into a release build, never used
/// without the explicit test launch argument, and never forwards to production.
final class PreviewTransport: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        let body: String
        let signedIn = ProcessInfo.processInfo.arguments.contains("-order-timeout") || ProcessInfo.processInfo.arguments.contains("-signed-in")
        var status = 200
        switch path {
        case "/api/auth/session": body = signedIn ? #"{"hosted":true,"address":"0x1111111111111111111111111111111111111111"}"# : #"{"hosted":true,"address":null}"#
        case "/api/likes": body = #"{"read":true,"liked":[]}"#
        case "/api/like-counts": body = #"{"read":true,"counts":{"test-post":2}}"#
        case "/api/follow": body = #"{"read":true,"wired":[]}"#
        case "/api/orders/ceiling": body = #"{"ceilingUsdg":50}"#
        case "/api/snipe":
            let input = readBody()
            if input["query"] as? String == "0x2222222222222222222222222222222222222222" {
                body = #"{"outcome":"resolved","target":{"symbol":"NEON","address":"0x2222222222222222222222222222222222222222"},"usdgAmount":5,"matchedOn":"address"}"#
            } else {
                body = #"{"outcome":"ambiguous","total":2,"candidates":[{"symbol":"NEON","address":"0x2222222222222222222222222222222222222222","covered":true},{"symbol":"NEON","address":"0x3333333333333333333333333333333333333333","covered":false}]}"#
            }
        case "/api/orders":
            if request.httpMethod == "POST" {
                UserDefaults.standard.set(true, forKey: "uiTest.orderPlaced")
                client?.urlProtocol(self, didFailWithError: URLError(.timedOut)); return
            }
            body = UserDefaults.standard.bool(forKey: "uiTest.orderPlaced") ? #"{"state":"queued","id":"test-order-1"}"# : #"{"state":"none"}"#
        case "/api/tour": body = #"{"done":false,"signedIn":false}"#
        case "/api/theses": body = #"{"source":"db","theses":[{"slug":"test-agent","name":"Test agent","postId":"test-post","at":1790287200,"action":null,"head":"A measured decision","reason":"A test thesis with a clear investment rationale.","paper":true,"outcome":"view","outcomeText":"Paper view","symbol":"NVDA"}]}"#
        case "/api/market": body = #"{"tokens":[{"symbol":"NVDA","name":"Nvidia","address":"0x1111111111111111111111111111111111111111","priceUsd":null,"paused":false}]}"#
        case "/api/leaderboard": body = #"{"source":"db","agents":[]}"#
        case "/api/agents/test-agent":
            body = #"{"slug":"test-agent","name":"Test agent","mode":"live","publicBook":false,"holdingsRead":true,"holdings":[],"activityRead":true,"topTradesRead":true,"topTrades":[{"id":"sell","action":"sell","symbol":"NVDA","at":1790287200,"paper":false,"sizeUsdg":987654,"realizedPnlBps":100,"realizedPnlUsdg":1234}],"recentTrades":[],"thesesRead":true,"theses":[],"growth":[],"how":{"kind":"strategy","name":"steady-basket"}}"#
        case "/api/agents/test-agent/own":
            if signedIn { body = #"{"activityRead":true,"topTradesRead":true,"topTrades":[{"id":"sell","action":"sell","symbol":"NVDA","at":1790287200,"paper":false,"sizeUsdg":5,"realizedPnlBps":100,"realizedPnlUsdg":0.05}],"recentTrades":[]}"# }
            else { body = #"{"error":"Agent not found"}"#; status = 404 }
        default: body = #"{"error":"No UI-test fixture for this request"}"#; status = 404
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    private func readBody() -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream, data.isEmpty {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while data.count < 8192 { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count)) }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    override func stopLoading() {}
}
#endif
