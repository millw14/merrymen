import SwiftUI

struct AgentConnections: View {
    @EnvironmentObject var store: AppStore
    @AppStorage("language") private var language = "en"
    @StateObject private var telegram = RemoteData()
    @StateObject private var settings = RemoteData()
    @StateObject private var presentation = FeedPresentation()
    private var states: J { presentation.connections(telegram: telegram.value, settings: settings.value) ?? .null }
    private func words(_ key: String, vars: [String: String] = [:]) -> String { Language.text(key, locale: language, vars: vars) }
    private var telegramText: String {
        switch states["telegram"]["kind"].text {
        case "no-token": words("strip.tg.notSetUp")
        case "off": words("strip.tg.off")
        case "unverified": words("strip.tg.unverified")
        case "unlinked": words(states["telegram"]["linkCode"].string == nil ? "strip.tg.startingUp" : "strip.tg.ready")
        case "linked": states["telegram"]["botUsername"].string.map { words("strip.tg.connectedAs", vars: ["bot": $0]) } ?? words("strip.tg.connected")
        default: words("strip.checking")
        }
    }
    private var trencherText: String {
        let keys = ["off": "off", "no-crypto": "noCrypto", "paper": "paper", "live": "live"]
        return keys[states["trencher"]["kind"].text].map { words("strip.trencher." + $0) } ?? words("strip.checking")
    }
    var body: some View { Card {
        HStack { Text("Telegram").font(.headline); Spacer(); NavigationLink(words("strip.tg.manage"), value: Route.telegram) }
        Text(telegramText).font(.caption)
        if states["telegram"]["kind"].text == "unlinked" {
            if let code = states["telegram"]["linkCode"].string {
                Text(words("strip.tg.sendThis")).font(.caption)
                Text("/link " + code).font(.callout.monospaced()).textSelection(.enabled).privacySensitive()
                Text(words("strip.tg.codeWarning")).font(.caption).foregroundStyle(.orange)
                if let bot = states["telegram"]["botUsername"].string, bot.range(of: "^[A-Za-z0-9_]+$", options: .regularExpression) != nil,
                   let url = URL(string: "https://t.me/\(bot)?start=\(escaped(code))") { Link(words("strip.tg.open"), destination: url) }
            } else { Text(words("strip.tg.noCodeYet")).font(.caption).foregroundStyle(.secondary) }
        }
        Divider()
        HStack { Text("Trencher").font(.headline); Spacer(); NavigationLink(words("strip.trencher.settings"), value: Route.settings) }
        Text(trencherText).font(.caption)
        if telegram.error != nil || settings.error != nil { Text("Connection status could not be refreshed.").font(.caption).foregroundStyle(.orange) }
    }
    .task(id: store.generation) { await telegram.load(store.api, "/api/telegram") }
    .task(id: store.generation) { await settings.load(store.api, "/api/settings") }
    }
}
