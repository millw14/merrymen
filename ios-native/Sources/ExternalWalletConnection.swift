import Foundation
import Combine
import ReownAppKit
import WalletConnectNetworking
import WalletConnectSign
import WalletConnectSigner
import WalletConnectRelay

/// Only message ownership proofs are exposed to the product. This connection
/// cannot submit a transaction or become an agent's spending signer.
@MainActor
final class ExternalWalletConnection: ObservableObject {
    static let shared = ExternalWalletConnection()
    @Published private(set) var address: String?
    @Published private(set) var configured = false
    @Published private(set) var error: String?
    private var subscriptions = Set<AnyCancellable>()
    private var pending: (request: Request, address: String, hex: String, continuation: CheckedContinuation<String, Error>)?
    private var timeout: Task<Void, Never>?
    private init() {
        let project = Bundle.main.object(forInfoDictionaryKey: "WalletConnectProjectID") as? String ?? ""
        let group = Bundle.main.object(forInfoDictionaryKey: "WalletConnectKeychainGroup") as? String ?? ""
        guard project.range(of: "^[0-9a-fA-F]{32}$", options: .regularExpression) != nil, !group.isEmpty, !group.contains("$(") else { return }
        do {
            let metadata = AppMetadata(name: "merrymen", description: "Sign in to Merrymen and prove holder-wallet ownership.", url: API.origin.absoluteString, icons: [], redirect: try .init(native: "merrymen://walletconnect", universal: nil))
            Networking.configure(groupIdentifier: group, projectId: project, socketFactory: NativeRelaySocketFactory())
            let namespace = ProposalNamespace(chains: [Blockchain("eip155:1")!], methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"])
            AppKit.configure(projectId: project, metadata: metadata, crypto: NativeProofCrypto(), sessionParams: SessionParams(namespaces: ["eip155": namespace]), authRequestParams: nil, includeWebWallets: false, coinbaseEnabled: false) { _ in }
            AppKit.instance.disableAnalytics()
            configured = true
            AppKit.instance.sessionsPublisher.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.refresh() }.store(in: &subscriptions)
            AppKit.instance.sessionResponsePublisher.receive(on: DispatchQueue.main).sink { [weak self] response in
                guard let self, let pending = self.pending, response.id == pending.request.id, response.topic == pending.request.topic else { return }
                guard response.chainId == pending.request.chainId.absoluteString else { self.finish(.failure(self.failure("The wallet response used a different network."))); return }
                switch response.result {
                case .response(let value):
                    do {
                        let signature = try value.get(String.self)
                        let recovered = try WalletCryptography.call("recoverAddress", .object(["hex": .string(pending.hex), "signature": .string(signature)]))
                        guard recovered.lowercased() == pending.address.lowercased() else { throw self.failure("The signature came from another wallet. Reconnect and start again.") }
                        self.finish(.success(signature))
                    } catch { self.finish(.failure(error)) }
                case .error: self.finish(.failure(self.failure("The wallet did not approve the message.")))
                }
            }.store(in: &subscriptions)
            AppKit.instance.sessionEventPublisher.receive(on: DispatchQueue.main).sink { [weak self] event in
                guard let self else { return }; self.refresh()
                if event.sessionTopic == self.pending?.request.topic { self.finish(.failure(self.failure("The wallet changed. Prepare a fresh ownership message."))) }
            }.store(in: &subscriptions)
            AppKit.instance.sessionDeletePublisher.receive(on: DispatchQueue.main).sink { [weak self] event in
                guard let self else { return }; self.refresh()
                if event.0 == self.pending?.request.topic { self.finish(.failure(self.failure("The wallet disconnected."))) }
            }.store(in: &subscriptions)
            refresh()
        } catch { self.error = "Wallet-app connections could not be initialized." }
    }
    func present() { guard configured else { return }; error = nil; AppKit.present() }
    func handleURL(_ url: URL) -> Bool {
        guard configured, url.scheme == "merrymen", url.host == "walletconnect" else { return false }
        _ = AppKit.instance.handleDeeplink(url); return true
    }
    func disconnect() async {
        guard configured else { return }
        finish(.failure(failure("The wallet disconnected.")))
        do { for session in AppKit.instance.getSessions() { try await AppKit.instance.disconnect(topic: session.topic) }; refresh() }
        catch { self.error = "The wallet connection could not be removed. Try disconnecting again." }
    }
    func sign(message: String, address: String) async throws -> String {
        guard configured, pending == nil, message.utf8.count <= 8192,
              let session = AppKit.instance.getSessions().first(where: { $0.expiryDate > Date() && $0.namespaces["eip155"]?.methods.contains("personal_sign") == true && $0.namespaces["eip155"]?.accounts.contains(where: { $0.blockchain.absoluteString == "eip155:1" && $0.address.lowercased() == address.lowercased() }) == true }) else { throw failure("Connect the wallet that owns this address before signing.") }
        let hex = "0x" + message.utf8.map { String(format: "%02x", $0) }.joined()
        let request = try Request(topic: session.topic, method: "personal_sign", params: AnyCodable([hex, address]), chainId: Blockchain("eip155:1")!)
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                pending = (request, address, hex, continuation)
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(120)) } catch { return }
                    self?.finish(.failure(APIError(status: 0, message: "The wallet did not respond in time. Prepare a fresh message; no transaction was sent.")))
                }
                Task {
                    do { try await AppKit.instance.request(params: request); if self.pending?.request.id == request.id { AppKit.instance.launchCurrentWallet() } }
                    catch { if self.pending?.request.id == request.id { self.finish(.failure(self.failure("The message could not reach your wallet."))) } }
                }
            }
        } onCancel: { Task { @MainActor in if self.pending?.request.id == request.id { self.finish(.failure(CancellationError())) } } }
    }
    private func refresh() {
        address = AppKit.instance.getSessions().filter { $0.expiryDate > Date() }.flatMap { $0.namespaces["eip155"]?.accounts ?? [] }.first(where: { $0.blockchain.absoluteString == "eip155:1" })?.address
    }
    private func finish(_ result: Result<String, Error>) {
        guard let value = pending else { return }; pending = nil; timeout?.cancel(); timeout = nil
        value.continuation.resume(with: result)
    }
    private func failure(_ message: String) -> APIError { APIError(status: 0, message: message) }
}

private struct NativeProofCrypto: CryptoProvider {
    func recoverPubKey(signature: EthereumSignature, message: Data) throws -> Data {
        try decode(WalletCryptography.call("recoverPublicKey", .object(["digest": .string(hex(message)), "r": .string(hex(Data(signature.r))), "s": .string(hex(Data(signature.s))), "v": .number(Double(signature.v))])))
    }
    func keccak256(_ data: Data) -> Data {
        // A hashing failure must not turn into a believable digest.
        guard let value = try? WalletCryptography.call("keccak", .object(["hex": .string(hex(data))])), let bytes = try? decode(value), bytes.count == 32 else { return Data() }
        return bytes
    }
    private func hex(_ data: Data) -> String { "0x" + data.map { String(format: "%02x", $0) }.joined() }
    private func decode(_ value: String) throws -> Data {
        guard value.hasPrefix("0x"), value.count.isMultiple(of: 2) else { throw APIError(status: 0, message: "Invalid wallet proof.") }
        let chars = Array(value.dropFirst(2)); var bytes = [UInt8]()
        for index in stride(from: 0, to: chars.count, by: 2) { guard let byte = UInt8(String(chars[index...index+1]), radix: 16) else { throw APIError(status: 0, message: "Invalid wallet proof.") }; bytes.append(byte) }
        return Data(bytes)
    }
}

private struct NativeRelaySocketFactory: WebSocketFactory {
    func create(with url: URL) -> WebSocketConnecting { NativeRelaySocket(url: url) }
}
private final class NativeRelaySocket: NSObject, WebSocketConnecting, URLSessionWebSocketDelegate {
    var request: URLRequest
    var onConnect: (() -> Void)?
    var onDisconnect: ((Error?) -> Void)?
    var onText: ((String) -> Void)?
    private let lock = NSRecursiveLock()
    private var connected = false
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    var isConnected: Bool { lock.lock(); defer { lock.unlock() }; return connected }
    init(url: URL) { request = URLRequest(url: url); super.init() }
    func connect() {
        lock.lock(); defer { lock.unlock() }
        guard task == nil else { return }
        let socket = session.webSocketTask(with: request); task = socket; socket.resume()
        receiveTask = Task { [weak self, weak socket] in
            guard let socket else { return }
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    if case .string(let text) = message { self?.received(text, from: socket) }
                }
            } catch { self?.closed(socket, error: error) }
        }
    }
    func disconnect() {
        lock.lock(); let socket = task; task = nil; connected = false; receiveTask?.cancel(); receiveTask = nil; lock.unlock()
        socket?.cancel(with: .normalClosure, reason: nil); if socket != nil { onDisconnect?(nil) }
    }
    func write(string: String, completion: (() -> Void)?) {
        lock.lock(); let socket = task; lock.unlock()
        guard let socket else { return }
        Task { [weak self] in do { try await socket.send(.string(string)); completion?() } catch { self?.closed(socket, error: error) } }
    }
    private func received(_ text: String, from socket: URLSessionWebSocketTask) {
        lock.lock(); let current = task === socket; lock.unlock(); if current { onText?(text) }
    }
    private func closed(_ socket: URLSessionWebSocketTask, error: Error?) {
        lock.lock(); guard task === socket else { lock.unlock(); return }; task = nil; connected = false; receiveTask?.cancel(); receiveTask = nil; lock.unlock()
        onDisconnect?(error)
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        lock.lock(); let current = task === webSocketTask; if current { connected = true }; lock.unlock(); if current { onConnect?() }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { closed(webSocketTask, error: nil) }
}
