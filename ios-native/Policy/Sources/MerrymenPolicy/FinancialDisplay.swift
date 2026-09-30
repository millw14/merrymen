import Foundation

public enum FinancialDisplay {
    /// A small nonzero coin price must not look like a worthless asset.
    public static func tokenPrice(_ value: Double?, locale: Locale = .current) -> String {
        guard let value, value.isFinite, value >= 0 else { return "—" }
        if value == 0 || value >= 0.01 { return value.formatted(.currency(code: "USD").locale(locale)) }
        let format = NumberFormatter()
        format.locale = locale
        format.numberStyle = value < 0.00000001 ? .scientific : .decimal
        format.exponentSymbol = "e"
        format.usesGroupingSeparator = false
        format.usesSignificantDigits = true
        format.minimumSignificantDigits = 2
        format.maximumSignificantDigits = 6
        guard let text = format.string(from: NSNumber(value: value)) else { return "—" }
        return "$" + text
    }
}
