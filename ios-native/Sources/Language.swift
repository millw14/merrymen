import SwiftUI

enum Language {
    static let options = [("en", "English"), ("es", "Español"), ("pt-BR", "Português"), ("id", "Bahasa Indonesia"), ("vi", "Tiếng Việt"), ("tr", "Türkçe"), ("ru", "Русский"), ("th", "ไทย"), ("zh-CN", "简体中文"), ("ja", "日本語"), ("ko", "한국어")]
    static let catalogues: [String: [String: String]] = {
        guard let url = Bundle.main.url(forResource: "Messages", withExtension: "json"), let data = try? Data(contentsOf: url), let values = try? JSONDecoder().decode([String: [String: String]].self, from: data) else { return [:] }
        return values
    }()
    static func text(_ key: String, locale: String, vars: [String: String] = [:]) -> String {
        let english = catalogues["en"] ?? [:]
        let ns = String(key.split(separator: ".").first ?? "")
        let required = [ns] + (["tour", "create", "settings", "strip"].contains(ns) ? ["mode"] : [])
        let table = catalogues[locale] ?? [:]
        let complete = required.allSatisfy { scope in english.keys.filter { $0.hasPrefix(scope + ".") }.allSatisfy { !(table[$0] ?? "").isEmpty } }
        var value = (complete ? table[key] : nil) ?? english[key] ?? key
        for (name, replacement) in vars { value = value.replacingOccurrences(of: "{\(name)}", with: replacement) }
        return value
    }
    static func ui(_ value: String, locale: String) -> String {
        guard let path = Bundle.main.path(forResource: locale, ofType: "lproj"), let bundle = Bundle(path: path) else { return value }
        return bundle.localizedString(forKey: value, value: value, table: "Localizable")
    }
}

struct LanguagePicker: View {
    @AppStorage("language") private var language = "en"
    var body: some View {
        Card {
            Picker("Language", selection: $language) { ForEach(Language.options, id: \.0) { code, name in Text(name).tag(code) } }
            Text("Some text is available in English.").font(.caption).foregroundStyle(.secondary)
        }
    }
}
