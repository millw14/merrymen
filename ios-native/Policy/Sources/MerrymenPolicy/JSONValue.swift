import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue { object[key] ?? .null }
    public var object: [String: JSONValue] { if case .object(let v) = self { return v }; return [:] }
    public var array: [JSONValue] { if case .array(let v) = self { return v }; return [] }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var number: Double? { if case .number(let v) = self, v.isFinite { return v }; return nil }
    public var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var text: String {
        switch self {
        case .string(let v): return v
        case .number(let v): return v.isFinite && abs(v) < 9_007_199_254_740_992 && v.rounded() == v ? String(Int64(v)) : String(v)
        case .bool(let v): return String(v)
        default: return ""
        }
    }
    public func setting(_ key: String) -> JSONValue { self["values"][key] == .null ? self["defaults"][key] : self["values"][key] }
}

public enum TradeInput {
    public static func amount(_ text: String) -> Double? {
        // One decimal separator, no grouping: 10,50 and 10.50 agree. Three
        // fractional digits are refused rather than guessed as grouped thousands.
        guard text.range(of: "^[0-9]+(?:[.,][0-9]{1,2})?$", options: .regularExpression) != nil,
              let value = Double(text.replacingOccurrences(of: ",", with: ".")), value.isFinite, value > 0 else { return nil }
        return value
    }
    public static func body(side: String, symbol: String, amount: String, owner: String) -> JSONValue? {
        let ticker = symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard ["buy", "sell"].contains(side), let value = self.amount(amount), value >= 0.01,
              value <= 1_000_000_000,
              ticker.range(of: "^[A-Z0-9]{1,12}$", options: .regularExpression) != nil,
              owner.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil else { return nil }
        return .object(["side": .string(side), "symbol": .string(ticker), "usdgAmount": .number(value), "owner": .string(owner)])
    }
}
