#if canImport(JavaScriptCore)
import Foundation
import JavaScriptCore
import Security

public struct WalletRuntimeError: LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

/// Executes only shipped wallet computation. All privileged work is delegated
/// to the native host; incoming pages, messages and PR content never enter eval.
@MainActor
public final class WalletRuntime {
    private let context: JSContext
    private var next = 0
    private var completions: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var timers: [Int: Task<Void, Never>] = [:]
    private var failure: String?
    public var handle: ((String, JSONValue) async throws -> JSONValue)?
    public var storage: ((String, JSONValue) throws -> JSONValue)?

    public init(bootstrap: String, library: String) throws {
        guard let context = JSContext() else { throw WalletRuntimeError("Wallet runtime could not start.") }
        self.context = context
        context.exceptionHandler = { [weak self] _, value in self?.failure = value?.toString() ?? "Wallet runtime exception" }
        let asyncCall: @convention(block) (Int, String, String) -> Void = { [weak self] id, operation, json in
            guard let self else { return }
            Task { @MainActor in
                do {
                    guard let handle = self.handle else { throw WalletRuntimeError("Native wallet host is not connected.") }
                    let args = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
                    let result = try await handle(operation, args)
                    let encoded = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
                    self.context.objectForKeyedSubscript("__settle")?.call(withArguments: [id, true, encoded])
                } catch { self.context.objectForKeyedSubscript("__settle")?.call(withArguments: [id, false, error.localizedDescription]) }
            }
        }
        let syncCall: @convention(block) (String, String) -> String = { [weak self] operation, json in
            do {
                guard let self else { throw WalletRuntimeError("Wallet runtime closed.") }
                let args = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
                let result = try self.sync(operation, args)
                return String(decoding: try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": result])), as: UTF8.self)
            } catch {
                return String(decoding: (try? JSONEncoder().encode(JSONValue.object(["ok": .bool(false), "error": .string(error.localizedDescription)]))) ?? Data(), as: UTF8.self)
            }
        }
        let timer: @convention(block) (Int, Double) -> Void = { [weak self] id, milliseconds in
            guard let self else { return }
            self.timers[id] = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .milliseconds(min(300_000, max(0, milliseconds)))) } catch { return }
                self?.context.objectForKeyedSubscript("__fireTimer")?.call(withArguments: [id]); self?.timers.removeValue(forKey: id)
            }
        }
        let cancelTimer: @convention(block) (Int) -> Void = { [weak self] id in self?.timers.removeValue(forKey: id)?.cancel() }
        let result: @convention(block) (Int, Bool, String) -> Void = { [weak self] id, ok, text in
            guard let continuation = self?.completions.removeValue(forKey: id) else { return }
            if !ok { continuation.resume(throwing: WalletRuntimeError(text)); return }
            do { continuation.resume(returning: try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) }
            catch { continuation.resume(throwing: error) }
        }
        context.setObject(asyncCall, forKeyedSubscript: "__nativeAsync" as NSString)
        context.setObject(syncCall, forKeyedSubscript: "__nativeSync" as NSString)
        context.setObject(timer, forKeyedSubscript: "__nativeTimer" as NSString)
        context.setObject(cancelTimer, forKeyedSubscript: "__nativeCancelTimer" as NSString)
        context.setObject(result, forKeyedSubscript: "__nativeResult" as NSString)
        context.evaluateScript(bootstrap)
        if let failure { throw WalletRuntimeError(failure) }
        context.evaluateScript(library)
        if let failure { throw WalletRuntimeError(failure) }
    }

    public func call(_ operation: String, input: JSONValue) async throws -> JSONValue {
        guard completions.isEmpty else { throw WalletRuntimeError("A wallet operation is already in progress.") }
        next += 1; let id = next
        let json = String(decoding: try JSONEncoder().encode(input), as: UTF8.self)
        return try await withCheckedThrowingContinuation { continuation in
            completions[id] = continuation
            context.objectForKeyedSubscript("__runWallet")?.call(withArguments: [id, operation, json])
            if let failure, let pending = completions.removeValue(forKey: id) { pending.resume(throwing: WalletRuntimeError(failure)) }
        }
    }

    private func sync(_ op: String, _ args: JSONValue) throws -> JSONValue {
        func bytes() throws -> [UInt8] {
            guard args["bytes"].array.count <= 2_000_000 else { throw WalletRuntimeError("Data exceeds runtime limit.") }
            return try args["bytes"].array.map { n in
                guard let v = n.number, (0...255).contains(v), v.rounded() == v else { throw WalletRuntimeError("Invalid byte.") }
                return UInt8(v)
            }
        }
        switch op {
        case "random":
            guard let count = args["count"].number, (0...65536).contains(count) else { throw WalletRuntimeError("Invalid randomness size.") }
            var values = [UInt8](repeating: 0, count: Int(count))
            guard SecRandomCopyBytes(kSecRandomDefault, values.count, &values) == errSecSuccess else { throw WalletRuntimeError("Secure randomness unavailable.") }
            return .array(values.map { .number(Double($0)) })
        case "encodeUTF8": return .array(args["text"].text.utf8.map { .number(Double($0)) })
        case "decodeUTF8": return .string(String(decoding: try bytes(), as: UTF8.self))
        case "base64encode": return .string(Data(try bytes()).base64EncodedString())
        case "base64decode":
            guard let data = Data(base64Encoded: args["text"].text) else { throw WalletRuntimeError("Invalid base64.") }
            return .array(data.map { .number(Double($0)) })
        case "storageGet", "storageSet", "storageRemove", "storageKeys":
            guard let storage else { throw WalletRuntimeError("Secure storage is unavailable.") }
            return try storage(op, args)
        default: throw WalletRuntimeError("Unsupported native runtime operation.")
        }
    }
}
#endif
