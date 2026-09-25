import Foundation
import Combine
import PrivySDK
import MerrymenPolicy

/// A native, explicitly invoked host for the shipped permission library. No
/// remote script evaluation, external credential forwarding or raw-tx signing.
@MainActor
final class WalletHost: NSObject, ObservableObject, URLSessionTaskDelegate {
    @Published var busy = false
    @Published var status = ""
    private var runtime: WalletRuntime?
    private weak var store: AppStore?
    private var identity = ""
    private var signingOwner = ""
    private var legacyKey: String?
    private var did = ""
    private var generation = 0
    private var operation = ""
    private var account = ""
    private var recipient = ""
    private var challengeNonce: String?
    private var runID: UUID?
    private var sessionBinding: API.SessionBinding?
    private lazy var rpc: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 45
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private var service: String { "dev.merrymen.wallet.\(identity.lowercased())" }

    func call(_ name: String, input: J, store: AppStore, legacyKey: String? = nil) async throws -> J {
        guard !busy else { throw fail("A wallet operation is already running.") }
        let callID = UUID(); runID = callID
        busy = true; defer { busy = false; operation = ""; runtime = nil; runID = nil; self.legacyKey = nil }
        guard store.owner != nil || legacyKey != nil else { throw fail("Sign in before opening your wallet.") }
        let owner = store.owner ?? ""
        self.store = store; identity = owner; generation = store.generation
        sessionBinding = store.api.binding()
        if !owner.isEmpty { try await store.verifyOwner(owner) }
        signingOwner = owner
        if let legacyKey {
            guard ["preview", "plan", "withdraw", "reconcile", "restore"].contains(name) else { throw fail("An imported key is only available for recovery.") }
            if name == "restore", owner.isEmpty { throw fail("Sign in before restoring trading permissions.") }
            signingOwner = try WalletCryptography.call("address", .object(["key": .string(legacyKey)]))
            guard input["recoveryOwner"].string?.lowercased() == signingOwner.lowercased() else { throw fail("The recovery key does not match the selected owner.") }
            self.legacyKey = legacyKey; did = ""
        } else {
            guard let user = await store.privy?.getUser(), user.embeddedEthereumWallets.contains(where: { $0.address.lowercased() == owner.lowercased() }) else {
                throw fail("Sign in to the embedded wallet that owns this account.")
            }
            did = user.id
        }
        operation = name; challengeNonce = nil
        var fields = input.object
        fields["owner"] = .string(signingOwner); fields["tenant"] = .string(owner); fields["did"] = .string(did)
        account = fields["smartAccount"]?.text ?? fields["expectAccount"]?.text ?? ""
        recipient = fields["to"]?.text ?? ""
        if name == "withdraw", try journal().contains(where: { $0["settled"].bool != true }) { throw fail("A previous withdrawal is unresolved. Check its receipt before signing another.") }
        if name == "reconcile" { fields["hashes"] = .array(try journal().filter { $0["settled"].bool != true }.map { $0["hash"] }) }
        guard let bootstrapURL = Bundle.main.url(forResource: "WalletRuntime", withExtension: "js"),
              let engineURL = Bundle.main.url(forResource: "WalletEngine", withExtension: "js") else { throw fail("The wallet library is missing from this build.") }
        let runtime = try WalletRuntime(bootstrap: String(contentsOf: bootstrapURL, encoding: .utf8), library: String(contentsOf: engineURL, encoding: .utf8))
        self.runtime = runtime
        runtime.storage = { [weak self] op, args in guard let self, self.runID == callID else { throw WalletRuntimeError("Wallet operation closed.") }; return try self.storage(op, args) }
        runtime.handle = { [weak self] op, args in
            guard let self, self.runID == callID else { throw WalletRuntimeError("Wallet operation closed.") }
            let result = try await self.handle(op, args)
            guard self.runID == callID else { throw WalletRuntimeError("Wallet operation closed.") }; return result
        }
        let result = try await runtime.call(name, input: .object(fields))
        if name == "reconcile" {
            for row in result["receipts"].array where row["receipt"] != .null { try recordReceipt(hash: row["hash"].text, receipt: row["receipt"]) }
        }
        return result
    }

    static func savedGrant(owner: String) throws -> J? {
        guard let data = try SecureStore.read("dev.merrymen.wallet.\(owner.lowercased())", "grants") else { return nil }
        let values = try JSONDecoder().decode([String: String].self, from: data)
        guard let text = values["merrymen.grant.v1"] else { return nil }
        let grant = try JSONDecoder().decode(J.self, from: Data(text.utf8))
        guard (grant["owner"].text.lowercased() == owner.lowercased() || grant["binding"]["version"].text == "legacy-wallet-owner-v1"), grant["demoOwnerPrivateKey"] == .null else { throw APIError(status: 0, message: "This saved grant belongs to a different owner.") }
        return grant
    }
    static func withdrawals(owner: String) throws -> [J] {
        guard let data = try SecureStore.read("dev.merrymen.wallet.\(owner.lowercased())", "withdrawals") else { return [] }
        return try JSONDecoder().decode([J].self, from: data)
    }
    private func journal() throws -> [J] { try Self.withdrawals(owner: signingOwner) }
    private func saveJournal(_ items: [J]) throws { try SecureStore.write("dev.merrymen.wallet.\(signingOwner.lowercased())", "withdrawals", JSONEncoder().encode(items)) }

    private func storage(_ op: String, _ args: J) throws -> J {
        guard store?.generation == generation, store?.owner == identity else { throw fail("Your account changed. Open your wallet again.") }
        var values: [String: String] = [:]
        if let data = try SecureStore.read(service, "grants") { values = try JSONDecoder().decode([String: String].self, from: data) }
        if op == "storageKeys" { return .array(values.keys.sorted().map(J.string)) }
        let key = args["key"].text
        guard key == "merrymen.grant.v1" || key.range(of: "^merrymen\\.grant\\.archive\\.0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil else { throw fail("Unsupported wallet storage key.") }
        switch op {
        case "storageGet": return values[key].map(J.string) ?? .null
        case "storageSet":
            guard let text = args["value"].string, text.utf8.count <= 2_000_000 else { throw fail("Invalid grant data.") }
            let grant = try JSONDecoder().decode(J.self, from: Data(text.utf8))
            let embedded = legacyKey == nil && grant["binding"]["version"].text == "privy-did-owner-v1" && grant["binding"]["did"].text == did
            let restored = legacyKey != nil && operation == "restore" && grant["binding"]["version"].text == "legacy-wallet-owner-v1" && grant["binding"]["walletSignature"].string != nil && grant["smartAccount"].text.lowercased() == account.lowercased()
            guard grant["owner"].text.lowercased() == signingOwner.lowercased(), grant["demoOwnerPrivateKey"] == .null, embedded || restored else { throw fail("Refusing to store a grant for a different wallet.") }
            if key == "merrymen.grant.v1", let old = values[key] {
                let previous = try JSONDecoder().decode(J.self, from: Data(old.utf8))
                // One atomic write preserves the preceding account even if the
                // shared library's best-effort archive could not run.
                values["merrymen.grant.archive.\(previous["smartAccount"].text.lowercased())"] = old
            }
            values[key] = text
        case "storageRemove": throw fail("Grant deletion is not part of this operation.")
        default: throw fail("Unknown secure storage operation.")
        }
        try SecureStore.write(service, "grants", JSONEncoder().encode(values)); return .null
    }

    private func currentUser() async throws -> any PrivyUser {
        let callID = runID; let expectedIdentity = identity; let expectedDID = did; let expectedGeneration = generation
        guard let store, store.owner == identity, store.generation == generation,
              let user = await store.privy?.getUser(), user.id == expectedDID,
              runID == callID, store.owner == expectedIdentity, store.generation == expectedGeneration else { throw fail("The wallet session changed. Review the action again.") }
        return user
    }
    private func handle(_ op: String, _ args: J) async throws -> J {
        let callID = runID
        guard let store, (store.owner ?? "") == identity, store.generation == generation else { throw fail("The wallet session changed. Review the action again.") }
        if legacyKey == nil { _ = try await currentUser() }
        guard callID != nil, callID == runID else { throw fail("Wallet operation closed.") }
        switch op {
        case "status": status = args["message"].text; return .null
        case "accessToken": return .string(try await currentUser().getAccessToken())
        case "signTenant":
            let message = args["message"].text
            let hex = "0x" + message.utf8.map { String(format: "%02x", $0) }.joined()
            guard operation == "restore", legacyKey != nil, !identity.isEmpty, args["address"].text.lowercased() == identity.lowercased(), hex.count > 66,
                  WalletSignaturePolicy.permitsPersonalSign(hex: hex, operation: "restore", owner: signingOwner, did: "", expectedAccount: account, nonce: challengeNonce) else { throw fail("The account-link request differs from your reviewed recovery.") }
            try await store.verifyOwner(identity)
            let signature: String
            if let user = await store.privy?.getUser(), let wallet = user.embeddedEthereumWallets.first(where: { $0.address.lowercased() == identity.lowercased() }) {
                signature = try await wallet.provider.request(.personalSign(message: message, address: wallet.address))
            } else { signature = try await ExternalWalletConnection.shared.sign(message: message, address: identity) }
            guard callID == runID, store.generation == generation, store.owner == identity,
                  try WalletCryptography.call("recoverAddress", .object(["hex": .string(hex), "signature": .string(signature)])).lowercased() == identity.lowercased() else { throw fail("The login wallet changed during authorization.") }
            return .string(signature)
        case "signMessage", "signTypedData":
            guard !["plan", "preview"].contains(operation), args["address"].text.lowercased() == signingOwner.lowercased() else { throw fail("This operation cannot request that signature.") }
            if !identity.isEmpty { try await store.verifyOwner(identity) }
            guard callID == runID else { throw fail("Wallet operation closed.") }
            if op == "signMessage" {
                let hex = args["hex"].text
                guard WalletSignaturePolicy.permitsPersonalSign(hex: hex, operation: operation, owner: signingOwner, did: did, expectedAccount: account, nonce: challengeNonce) else { throw fail("The wallet challenge does not match the action you reviewed.") }
            } else {
                guard operation != "reconcile" else { throw fail("Receipt checks cannot sign spending permissions.") }
                let chain = args["typedData"]["domain"]["chainId"]
                guard chain.number == 4663 || chain.string == "4663" else { throw fail("The signature names the wrong network.") }
            }
            if let legacyKey {
                var fields = args.object; fields["key"] = .string(legacyKey)
                return .string(try WalletCryptography.call(op, .object(fields)))
            }
            let user = try await currentUser()
            guard callID == runID, let wallet = user.embeddedEthereumWallets.first(where: { $0.address.lowercased() == signingOwner.lowercased() }) else { throw fail("The owning wallet is unavailable.") }
            let request = op == "signMessage" ? EthereumRpcRequest(method: "personal_sign", params: [args["hex"].text, wallet.address]) : EthereumRpcRequest(method: "eth_signTypedData_v4", params: [wallet.address, String(decoding: try JSONEncoder().encode(args["typedData"]), as: UTF8.self)])
            return .string(try await wallet.provider.request(request))
        case "fetch": return try await fetch(args)
        default: throw fail("Unsupported wallet capability.")
        }
    }

    private func fetch(_ args: J) async throws -> J {
        let callID = runID
        let body = args["body"].string.map { Data($0.utf8) }
        let requestJSON = body.flatMap { try? JSONDecoder().decode(J.self, from: $0) } ?? .null
        let method = args["method"].text.uppercased()
        guard let url = WalletNetworkPolicy.destination(args["url"].text, method: method, operation: operation, rpcMethod: requestJSON["method"].string),
              (body?.count ?? 0) <= 2_000_000, let store else { throw fail("The wallet requested an unsupported network destination or method.") }
        let rpcMethod = requestJSON["method"].text
        if rpcMethod == "eth_sendUserOperation" {
            if !identity.isEmpty { try await store.verifyOwner(identity) }
            guard callID != nil, callID == runID else { throw fail("Wallet operation closed before submission.") }
            let hash = args["metadata"]["hash"].text
            guard hash.range(of: "^0x[0-9a-fA-F]{64}$", options: .regularExpression) != nil,
                  args["metadata"]["sender"].text.lowercased() == account.lowercased() else { throw fail("Withdrawal identity does not match the reviewed account.") }
            var items = try journal()
            guard !items.contains(where: { $0["hash"].text == hash || $0["settled"].bool != true }) else { throw fail("This withdrawal was already submitted or is awaiting a receipt. It will not be sent again.") }
            items.append(.object(["hash": .string(hash), "account": .string(account), "to": .string(recipient), "submittedAt": .string(ISO8601DateFormatter().string(from: Date())), "settled": .bool(false)]))
            try saveJournal(items) // Must succeed before any submission leaves this device.
        }
        let data: Data; let response: HTTPURLResponse
        if url.host == API.origin.host {
            if url.path == "/api/grants", requestJSON["demoOwnerPrivateKey"] != .null { throw fail("Owner keys cannot be sent to the service.") }
            let token = url.path == "/api/grants" && legacyKey == nil ? try await currentUser().getAccessToken() : nil
            guard callID != nil, callID == runID else { throw fail("Wallet operation closed.") }
            if url.path == "/api/grants" { try await store.verifyOwner(identity) }
            guard callID == runID, let sessionBinding else { throw fail("Wallet operation closed.") }
            (data, response) = try await store.api.raw(url.path, method: method, data: body, token: token, expectedSession: sessionBinding)
        } else {
            var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let (bytes, http) = try await rpc.data(for: request)
            guard let http = http as? HTTPURLResponse else { throw fail("The chain did not respond.") }
            data = bytes; response = http
        }
        guard callID == runID else { throw fail("This wallet operation has ended. Check its receipt before retrying.") }
        guard data.count <= 8_000_000 else { throw fail("The wallet response exceeds its size limit.") }
        if method == "GET", ["/api/auth/challenge", "/api/recover/ticket"].contains(url.path), response.statusCode == 200 {
            let challenge = try JSONDecoder().decode(J.self, from: data)
            if url.path == "/api/auth/challenge", challenge["origin"].text != API.origin.absoluteString { throw fail("The grant challenge names another origin.") }
            challengeNonce = challenge["nonce"].string
        }
        if rpcMethod == "eth_getUserOperationReceipt", let response = try? JSONDecoder().decode(J.self, from: data), response["result"] != .null {
            try recordReceipt(hash: requestJSON["params"].array.first?.text ?? "", receipt: response["result"])
        }
        return .object(["status": .number(Double(response.statusCode)), "body": .string(String(decoding: data, as: UTF8.self)), "headers": .object(["content-type": .string(response.value(forHTTPHeaderField: "Content-Type") ?? "application/json")])])
    }
    private func recordReceipt(hash: String, receipt: J) throws {
        guard receipt["userOpHash"].text.lowercased() == hash.lowercased(),
              receipt["receipt"]["transactionHash"].string != nil, receipt["success"].bool != nil else { return }
        var items = try journal()
        for index in items.indices where items[index]["hash"].text == hash {
            var row = items[index].object; row["settled"] = .bool(true); row["receipt"] = receipt; items[index] = .object(row)
        }
        try saveJournal(items)
    }
    private func fail(_ message: String) -> APIError { APIError(status: 0, message: message) }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
