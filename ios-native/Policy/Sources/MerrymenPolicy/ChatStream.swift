import Foundation

public struct ChatStream {
    private var event = "message"
    private var data: [String] = []
    private var raw = ""
    public private(set) var visible = ""
    public private(set) var finished: JSONValue?
    public init() {}
    public mutating func line(_ line: String) throws {
        guard finished == nil else { return }
        guard raw.utf8.count < 1_000_000, data.joined().utf8.count < 1_000_000 else { throw ChatStreamError.tooLong }
        if line.isEmpty {
            defer { event = "message"; data = [] }
            guard let payload = try? JSONDecoder().decode(JSONValue.self, from: Data(data.joined(separator: "\n").utf8)) else { return }
            if event == "text", let text = payload["t"].string { raw += text; visible = Self.safe(raw) }
            if event == "done" { finished = payload }
            if event == "error" { throw ChatStreamError.interrupted }
        } else if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        else if line.hasPrefix("data:") { let value = String(line.dropFirst(5)); data.append(value.hasPrefix(" ") ? String(value.dropFirst()) : value) }
    }
    public static func safe(_ input: String) -> String {
        var value = input.replacingOccurrences(of: "<\\|?think\\|?>[\\s\\S]*?</\\|?think\\|?>", with: "", options: [.regularExpression, .caseInsensitive])
        if let open = value.range(of: "<\\|?think\\|?>", options: [.regularExpression, .caseInsensitive]) { value = String(value[..<open.lowerBound]) }
        if let marker = value.range(of: "<<") { value = String(value[..<marker.lowerBound]) }
        if let start = value.lastIndex(of: "<"), !value[start...].contains(">") { value = String(value[..<start]) }
        return String(value.drop(while: { $0.isWhitespace }))
    }
}
public enum ChatStreamError: LocalizedError {
    case tooLong, interrupted
    public var errorDescription: String? { self == .tooLong ? "The reply exceeded its size limit." : "The reply was interrupted. Its partial text is not a completed answer." }
}
