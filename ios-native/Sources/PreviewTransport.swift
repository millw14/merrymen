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
        case "/api/chat": body = #"{"reply":"You can review this name change.","command":{"id":"rename","args":{"agentName":"New native name","liveTradingEnabled":true,"sponsorGasEnabled":true}}}"#
        case "/api/settings":
            if request.httpMethod == "PUT" {
                let input = readBody()
                if Set(input.keys) != Set(["owner", "agentName"]) || input["agentName"] as? String != "New native name" {
                    body = #"{"error":"Unexpected fields in reviewed name change"}"#; status = 400
                } else { UserDefaults.standard.set(true, forKey: "uiTest.settingsSaved"); body = #"{"ok":true}"# }
            } else {
                let name = UserDefaults.standard.bool(forKey: "uiTest.settingsSaved") ? "New native name" : "Original name"
                body = "{\"owner\":\"0x1111111111111111111111111111111111111111\",\"values\":{\"agentName\":\"\(name)\",\"liveTradingEnabled\":false},\"defaults\":{},\"strategies\":{\"builtin\":[\"steady-basket\"]},\"knownSymbols\":[],\"llmProviders\":[]}"
            }
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
        case "/api/mcp/connections":
            // Like the server: owner writes must carry the site's own Origin.
            if request.httpMethod == "POST" {
                if request.value(forHTTPHeaderField: "Origin") != "https://app.merrymen.dev" { body = #"{"error":"forbidden","error_description":"cross-site request"}"#; status = 403 }
                else { body = #"{"revoked":true,"proposals_cancelled":1}"# }
            } else {
                body = #"{"endpoint":"https://mcp.merrymen.dev/mcp","connections":[{"id":"mcpcon_0123456789abcdef0123456789abcdef","kind":"oauth","clientName":"Claude","clientHost":"claude.ai","clientId":"c","scopes":[{"id":"market:read","title":"Read markets","level":"read"},{"id":"orders:propose","title":"Propose trades","level":"write"}],"agentSlugs":["test-agent"],"createdAt":1790287200,"lastUsedAt":1790290000,"recent":[{"action":"propose_trade","outcome":"ok","at":1790290000}]}],"agents":[{"slug":"test-agent","account":null}],"available_scopes":[]}"#
            }
        case "/api/mcp/approvals/prp_0123456789abcdef0123456789abcdef":
            let hash = String(repeating: "a", count: 64)
            if request.httpMethod == "POST" {
                let input = readBody()
                if request.value(forHTTPHeaderField: "Origin") != "https://app.merrymen.dev" { body = #"{"error":"forbidden"}"#; status = 403; break }
                guard input["hash"] as? String == hash, input["decision"] as? String == "approve" else { body = #"{"error":"invalid_request","error_description":"This request changed. Reload it."}"#; status = 409; break }
                UserDefaults.standard.set(true, forKey: "uiTest.approvalDecided")
            }
            let decided = UserDefaults.standard.bool(forKey: "uiTest.approvalDecided")
            body = "{\"id\":\"prp_0123456789abcdef0123456789abcdef\",\"kind\":\"trade\",\"status\":\"\(decided ? "submitted" : "awaiting_approval")\",\"binding\":{\"kind\":\"trade\",\"side\":\"buy\",\"symbol\":\"NVDA\",\"token\":\"0x1111111111111111111111111111111111111111\",\"chain_id\":4663,\"amount_usdg\":5,\"slippage_bps\":100,\"book\":\"live\",\"limits\":{\"per_trade_usdg\":25,\"daily_usdg\":100,\"chat_ceiling_usdg\":0}},\"binding_hash\":\"\(hash)\",\"summary\":{\"action\":\"Buy 5 USDG of NVDA\",\"expected_out\":\"0.028\",\"min_out\":\"0.027\"},\"requested_by\":\"Claude\",\"created_at\":1790287200,\"expires_at\":4102444800,\"decided_at\":null,\"result\":null,\"fresh_quote\":null,\"settings_check\":null,\"current_book\":\"live\"}"
        case "/api/x/account", "/api/x/connect":
            let answer = xPosting(path); body = answer.body; status = answer.status
        case "/api/tour": body = #"{"done":false,"signedIn":false}"#
        case "/api/theses": body = #"{"source":"db","theses":[{"slug":"test-agent","name":"Test agent","postId":"test-post","at":1790287200,"action":null,"head":"A measured decision","reason":"A test thesis with a clear investment rationale.","paper":true,"outcome":"view","outcomeText":"Paper view","symbol":"NVDA"}]}"#
        case "/api/market": body = #"{"tokens":[{"symbol":"NVDA","name":"Nvidia","address":"0x1111111111111111111111111111111111111111","priceUsd":null,"paused":false}]}"#
        case "/api/discoveries": body = #"{"source":"db","rows":[],"fresh":[]}"#
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
    /// Posting on X as the web routes answer it (docs/x-posting.md): one
    /// connected account, @robin_trades (X user id 2244994945), posting off,
    /// one post coming up (due in half an hour — a casual post is due 20 to 45
    /// minutes after it is drafted) and one posted. Like the server, every write must
    /// carry the site's Origin and the signed-in owner, and each body must have
    /// exactly the contract's keys; enable's `tz` must be the zone this device
    /// is in. The confirmed enable must also be the FIRST
    /// write since launch: a warning answered "Not now" that sent anything at
    /// all makes the enable that follows it fail.
    private func xPosting(_ path: String) -> (body: String, status: Int) {
        let d = UserDefaults.standard
        let owner = "0x1111111111111111111111111111111111111111"
        let state = "i.UiTestUiTestUiTestUiTestUiTestUi"
        if request.httpMethod == "GET" {
            guard path == "/api/x/account" else { return (#"{"error":"No UI-test fixture for this request"}"#, 404) }
            let connected = !d.bool(forKey: "uiTest.xDisconnected")
            let upcoming: [[String: Any]] = connected && !d.bool(forKey: "uiTest.xSkipped")
                ? [["id": 41, "kind": "casual", "body": "slow day on the charts. honestly the quiet ones are when i learn the most.", "dueAt": Int((Date().timeIntervalSince1970 + 30 * 60) * 1000)]] : []
            let value: [String: Any] = [
                "available": true, "connected": connected,
                "username": connected ? "robin_trades" as Any : NSNull(), "xUserId": connected ? "2244994945" as Any : NSNull(),
                "status": connected ? "ok" as Any : NSNull(), "postingEnabled": connected && d.bool(forKey: "uiTest.xPostingEnabled"),
                "upcoming": upcoming,
                "recent": [["id": 40, "kind": "intro", "body": "hi, i'm robin, an AI trading agent that trades for my owner on merrymen. i'll post here now and then.", "sentAt": 1790287200000, "url": "https://x.com/robin_trades/status/1790287200000000001"]]
            ]
            return (String(decoding: (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8), as: UTF8.self), 200)
        }
        guard request.value(forHTTPHeaderField: "Origin") == "https://app.merrymen.dev" else { return (#"{"error":"forbidden"}"#, 403) }
        let input = readBody(), keys = Set(input.keys)
        let earlier = d.integer(forKey: "uiTest.xWrites"); d.set(earlier + 1, forKey: "uiTest.xWrites")
        guard input["owner"] as? String == owner else { return (#"{"error":"this browser is signed in with a different wallet now than the one that confirmed this, so nothing was changed. Sign back in with that wallet and ask again."}"#, 409) }
        if path == "/api/x/connect" {
            switch input["action"] as? String {
            case "start" where keys == ["action", "client", "owner"] && input["client"] as? String == "ios":
                return ("{\"url\":\"https://x.com/i/oauth2/authorize?response_type=code&client_id=ui-test&redirect_uri=https%3A%2F%2Fapp.merrymen.dev%2Fconnect%2Fx&scope=tweet.read%20tweet.write%20users.read%20offline.access&state=\(state)&code_challenge=ui-test&code_challenge_method=S256\"}", 200)
            case "finish" where keys == ["action", "code", "state", "owner"] && input["state"] as? String == state:
                // Like the server: a reconnect of the same account answers whether posting is on again.
                d.set(false, forKey: "uiTest.xDisconnected")
                return ("{\"ok\":true,\"username\":\"robin_trades\",\"postingEnabled\":\(d.bool(forKey: "uiTest.xPostingEnabled"))}", 200)
            default: return (#"{"error":"Unexpected fields in X connect"}"#, 400)
            }
        }
        if request.httpMethod == "DELETE" {
            guard keys == ["owner"] else { return (#"{"error":"Unexpected fields in X disconnect"}"#, 400) }
            d.set(true, forKey: "uiTest.xDisconnected"); d.set(false, forKey: "uiTest.xPostingEnabled")
            return (#"{"ok":true}"#, 200)
        }
        switch input["action"] as? String {
        case "enable":
            // Consent carries the device's zone, so nothing goes out while the owner sleeps.
            guard keys == ["action", "xUserId", "owner", "tz"], input["tz"] as? String == TimeZone.current.identifier else { return (#"{"error":"Unexpected fields in X posting consent"}"#, 400) }
            guard earlier == 0 else { return (#"{"error":"Something was sent before this confirmed enable"}"#, 400) }
            guard input["xUserId"] as? String == "2244994945", !d.bool(forKey: "uiTest.xDisconnected") else {
                return (#"{"error":"The connected X account changed — check which account is connected and try again."}"#, 409)
            }
            d.set(true, forKey: "uiTest.xPostingEnabled"); return (#"{"ok":true,"postingEnabled":true}"#, 200)
        case "disable" where keys == ["action", "owner"]:
            d.set(false, forKey: "uiTest.xPostingEnabled"); d.set(true, forKey: "uiTest.xSkipped")
            return (#"{"ok":true,"postingEnabled":false}"#, 200)
        case "skip" where keys == ["action", "id", "owner"]:
            guard (input["id"] as? NSNumber)?.intValue == 41, !d.bool(forKey: "uiTest.xSkipped") else { return (#"{"error":"That post is already on its way."}"#, 409) }
            d.set(true, forKey: "uiTest.xSkipped"); return (#"{"ok":true}"#, 200)
        default: return (#"{"error":"Unexpected fields in X posting change"}"#, 400)
        }
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
