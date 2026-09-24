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
        let signedIn = ProcessInfo.processInfo.arguments.contains("-order-timeout")
        var status = 200
        switch path {
        case "/api/auth/session": body = signedIn ? #"{"hosted":true,"address":"0x1111111111111111111111111111111111111111"}"# : #"{"hosted":true,"address":null}"#
        case "/api/likes": body = #"{"read":true,"liked":[]}"#
        case "/api/follow": body = #"{"read":true,"wired":[]}"#
        case "/api/orders/ceiling": body = #"{"ceilingUsdg":50}"#
        case "/api/orders":
            if request.httpMethod == "POST" {
                UserDefaults.standard.set(true, forKey: "uiTest.orderPlaced")
                client?.urlProtocol(self, didFailWithError: URLError(.timedOut)); return
            }
            body = UserDefaults.standard.bool(forKey: "uiTest.orderPlaced") ? #"{"state":"queued","id":"test-order-1"}"# : #"{"state":"none"}"#
        case "/api/tour": body = #"{"done":false,"signedIn":false}"#
        case "/api/theses": body = #"{"source":"db","theses":[{"slug":"test-agent","name":"Test agent","head":"A measured decision","reason":"A test thesis with a clear investment rationale.","paper":true,"outcomeText":"Paper fill","symbol":"NVDA"}]}"#
        case "/api/market": body = #"{"tokens":[{"symbol":"NVDA","name":"Nvidia","address":"0x1111111111111111111111111111111111111111","priceUsd":null,"paused":false}]}"#
        case "/api/leaderboard": body = #"{"source":"db","agents":[]}"#
        default: body = #"{"error":"No UI-test fixture for this request"}"#; status = 404
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif
