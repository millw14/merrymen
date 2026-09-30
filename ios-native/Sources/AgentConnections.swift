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
        // The web's telegramRow (agent-status.ts) says these three too, and
        // AgentStrip.tsx draws them: each is a measurement, never "checking…".
        case "held": words("strip.tg.held")
        case "not-listening": words(notListeningKey)
        case "elsewhere": words("strip.tg.elsewhere")
        default: words("strip.checking")
        }
    }
    private var notListeningKey: String {
        switch states["telegram"]["why"].text {
        case "revoked": "strip.tg.revoked"
        case "conflict": "strip.tg.conflict"
        default: "strip.tg.notListening"
        }
    }
    /// Why, beside the state, as AgentStrip.tsx says it; nil when there is nothing to add.
    private var telegramWhy: String? {
        let tg = states["telegram"]
        switch tg["kind"].text {
        case "held": return words("strip.tg.heldWhy", vars: ["reason": tg["reason"].string ?? "restore error"])
        case "elsewhere": return words("strip.tg.elsewhereWhy")
        case "not-listening":
            switch tg["why"].text {
            case "revoked": return words("strip.tg.revokedWhy")
            case "conflict": return words("strip.tg.conflictWhy")
            default:
                guard let at = tg["lastOkAt"].number else { return words("strip.tg.notListeningNever") }
                return words("strip.tg.notListeningSince", vars: ["when": Date(timeIntervalSince1970: at).formatted(date: .abbreviated, time: .shortened)])
            }
        default: return nil
        }
    }
    /// The code to show, as AgentStrip.tsx shows it: an unlinked bot's, and an
    /// unlinked owner's while trading is held (the hold process links chats) or
    /// while nothing hears the bot (it works once the bot is heard again).
    private var showsCode: Bool {
        let tg = states["telegram"]
        switch tg["kind"].text {
        case "unlinked": return true
        case "held", "not-listening": return tg["linked"].bool == false && tg["linkCode"].string != nil
        default: return false
        }
    }
    private var trencherText: String {
        let keys = ["off": "off", "no-crypto": "noCrypto", "paper": "paper", "live": "live"]
        return keys[states["trencher"]["kind"].text].map { words("strip.trencher." + $0) } ?? words("strip.checking")
    }
    var body: some View { Card {
        HStack { Text("Telegram").font(.headline); Spacer(); NavigationLink(words("strip.tg.manage"), value: Route.telegram) }
        Text(telegramText).font(.caption)
        if let why = telegramWhy { Text(why).font(.caption).foregroundStyle(.secondary) }
        if showsCode {
            if let code = states["telegram"]["linkCode"].string {
                Text(words("strip.tg.sendThis")).font(.caption)
                Text("/link " + code).font(.callout.monospaced()).textSelection(.enabled).privacySensitive()
                Text(words("strip.tg.codeWarning")).font(.caption).foregroundStyle(.orange)
                if states["telegram"]["kind"].text == "not-listening" { Text(words("strip.tg.codeWhenBack")).font(.caption).foregroundStyle(.secondary) }
                if let bot = states["telegram"]["botUsername"].string, bot.range(of: "^[A-Za-z0-9_]+$", options: .regularExpression) != nil,
                   let url = URL(string: "https://t.me/\(bot)?start=\(escaped(code))") { Link(words("strip.tg.open"), destination: url) }
            } else {
                // No code yet: the next one is being minted, or a new bot has
                // not been picked up and the old bot's code would not link it.
                Text(words(states["telegram"]["linkPending"].bool == true ? "strip.tg.pickingUp" : "strip.tg.noCodeYet")).font(.caption).foregroundStyle(.secondary)
            }
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
