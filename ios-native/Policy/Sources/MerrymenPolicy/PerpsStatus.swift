import Foundation

/// THE AGENT'S PERPETUALS, AS THE PHONE MAY SPEAK OF THEM (docs/perps.md,
/// Surfaces → Mobile; the product review's mobile-no-positions-while-leveraged).
///
/// The worker writes `agents.perps` (core `PerpsReport`) and GET /api/grants
/// carries it as `perps`. The phone only ever READS it, and the whole point of
/// reading it is one sentence the app must never say wrongly: that nothing is
/// held. A phone owner with open 10x positions used to see "No positions in
/// this book." — the feed's positions are the spot book, and perps never enter
/// it (rule 11) — and a stand-down notice that the assets "remain in the smart
/// account" while margin sat on Lighter.
///
/// So this file decides three things, with no SwiftUI in it so a macOS test
/// runs every one: the state (none, unread, or known), the banner that cannot
/// be dismissed while the state is not none, and the custody words a kill may
/// use. Where it and core disagree, core is right (perps.ts parsePerpsReport,
/// custodySentence); the custody reading follows the web's own port of the
/// same report (web/src/lib/perps-view.ts perpExposureOfReport, killWarning).
public struct PerpsStatus: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// Nothing is, or can be, on Lighter: no banner, and the old copy stands.
        case none
        /// The report could not be read. NEVER NONE: an unread venue may hold
        /// positions, and "unread ≠ zero" is the rule the banner exists for.
        /// `recorded` is how many positions the agent's own ledger lists (the
        /// worker reports those with every venue figure null); `paper` labels
        /// a practice book as practice.
        case unread(paper: Bool, recorded: Int, incident: Bool)
        /// A report with its venue figures present.
        case known(PerpsKnown)
    }

    /// What the screens show.
    public let state: State
    /// What a kill may say about the REAL money at Lighter — not the same
    /// question: a practice book says nothing about a real venue account, and
    /// a read too old to describe now describes nothing.
    public let custody: PerpsCustody
    /// Does the server this app talks to stand perpetuals down on a kill?
    /// GET /api/grants `perpsStanddownOnKill`. False unless this server
    /// advertises its shutdown executor. A supported request can still leave
    /// residual custody; the confirmation never promises a completed close.
    public let standsDownOnKill: Bool

    public init(state: State, custody: PerpsCustody, standsDownOnKill: Bool = false) {
        self.state = state
        self.custody = custody
        self.standsDownOnKill = standsDownOnKill
    }

    public static let none = PerpsStatus(state: .none, custody: .none)

    /// The web's PERPS_REPORT_STALE_MS: three times the ~5.5 minutes a hosted
    /// report may take to travel the ledger mirror. Older is no longer "now".
    public static let staleAfterMs: Double = 15 * 60_000

    /// The one reader, from a GET /api/grants answer.
    ///
    /// - no agent (`exists` not true) → none: the server says nothing about perps.
    /// - `perps` ABSENT → none: a server from before the report existed, which
    ///   could never have opened a perp.
    /// - `perps: null` → the worker has not said yet (web agent-perps.ts sends
    ///   null for "not said" and "unreadable" alike). Unread when the grant
    ///   mentions perps; none when it does not — without the permission the
    ///   session key can neither post margin nor register a Lighter key (the
    ///   wall, rule 3), so there is no real leverage to warn about, and a
    ///   "could not be read" banner on every owner who never turned perps on
    ///   would teach them to ignore the one that matters.
    /// - anything the strict parser refuses → unread.
    public init(status: JSONValue, nowMs: Double = Date().timeIntervalSince1970 * 1000) {
        guard status["exists"].bool == true else {
            // Deleting the grant does not establish that venue custody is empty.
            if status["perpsShutdown"] != .null {
                self.init(state: .unread(paper: false, recorded: 0, incident: false), custody: .unread)
            } else { self = .none }
            return
        }
        let grantPerps = Self.grantMentionsPerps(status["grant"])
        let accountPaper = status["mode"].string == "paper"
        let standsDown = status["perpsStanddownOnKill"].bool == true
        guard let raw = status.object["perps"] else {
            self.init(state: .none, custody: grantPerps ? .unread : .none, standsDownOnKill: standsDown)
            return
        }
        if raw == .null {
            self.init(state: grantPerps ? .unread(paper: accountPaper, recorded: 0, incident: false) : .none,
                      custody: grantPerps ? .unread : .none, standsDownOnKill: standsDown)
            return
        }
        guard let report = PerpsReport.parse(raw) else {
            // Something was said and cannot be read: unread on screen AND in the
            // kill's words, whatever the grant says, so the two never disagree.
            self.init(state: .unread(paper: accountPaper, recorded: 0, incident: false), custody: .unread, standsDownOnKill: standsDown)
            return
        }
        let read = PerpsStatus(report: report, accountMode: status["mode"].string, grantPerps: grantPerps, nowMs: nowMs)
        self.init(state: read.state, custody: read.custody, standsDownOnKill: standsDown)
    }

    /// The report's own `mode` is the perps RAIL; `off` and `refuse` still
    /// carry whatever the book holds (exits-only), and which book that is
    /// honors a real venue account index before the heartbeat's `mode`. Only a practice
    /// book is ever called paper: anything this cannot place is treated as
    /// real, because calling real leverage practice is the worse mistake.
    public init(report: PerpsReport, accountMode: String?, grantPerps: Bool, nowMs: Double) {
        let paper = report.mode == "paper" || (report.mode != "live" && report.accountIndex == nil && accountMode == "paper")
        // THE VENUE FIGURES ARE WHAT SAY "READ". The worker's report for a
        // venue it could not read lists the ledger's positions with every
        // figure null (worker perps/view.ts buildPerpsReport), and a reader
        // keys "Lighter could not be read" on exactly that.
        guard let notional = report.openNotionalMicro.flatMap(Self.micro),
              let collateral = report.collateralMicro.flatMap(Self.micro),
              let transit = report.inTransitMicro.flatMap(Self.micro) else {
            // For an unread venue the worker counts every ledger position in
            // `stopsMissing` but lists only those it can render.
            self.init(state: .unread(paper: paper, recorded: max(report.positions.count, report.stopsMissing), incident: report.incident),
                      custody: paper && !grantPerps ? .none : .unread)
            return
        }
        let stale = report.venueReadAt.map { nowMs - $0 > Self.staleAfterMs } ?? false
        let known = PerpsKnown(paper: paper, positions: report.positions, openNotionalMicro: notional,
                               collateralMicro: collateral, inTransitMicro: transit,
                               minLiqDistanceBps: report.minLiqDistanceBps, stopsMissing: report.stopsMissing,
                               incident: report.incident, venueReadAtMs: report.venueReadAt, stale: stale)
        let shown = known.held || known.funded || known.incident
        // perpExposureOfReport: a practice book → unread for a perps grant (it
        // says nothing about the real venue account), none otherwise; a stale
        // read → unread; nothing held and no venue account → none; else what
        // the report says — known and EMPTY still names the venue account.
        let custody: PerpsCustody
        if paper { custody = grantPerps ? .unread : .none }
        else if stale { custody = .unread }
        else if !shown && report.accountIndex == nil { custody = .none }
        else { custody = .known(positions: known.count, collateralMicro: collateral + transit) }
        self.init(state: shown ? .known(known) : .none, custody: custody)
    }

    /// DOES THIS GRANT HAVE ANYTHING TO DO WITH PERPS? The web's
    /// grantMentionsPerps, inclusive on purpose: the marker among
    /// `grantFeatures`, or any `perp` block at all. The answer only ever
    /// makes the phone MORE careful.
    public static func grantMentionsPerps(_ grant: JSONValue) -> Bool {
        if case .object = grant["perp"] { return true }
        return grant["grantFeatures"].array.contains { $0.string == PerpsReport.grantMarker }
    }

    static func micro(_ s: String) -> Decimal? { Decimal(string: s, locale: Locale(identifier: "en_US_POSIX")) }
}

/// core `PerpExposure`, as far as a report can say it (web perpExposureOfReport).
public enum PerpsCustody: Equatable, Sendable {
    case none
    case unread
    /// Every position the report counts, and the USDG it puts at or in transit
    /// to/from Lighter — both sit in Lighter's settlement contract, so both are
    /// "still on Lighter".
    case known(positions: Int, collateralMicro: Decimal)
}

public struct PerpsKnown: Equatable, Sendable {
    public let paper: Bool
    public let positions: [PerpsPosition]
    public let openNotionalMicro: Decimal
    public let collateralMicro: Decimal
    public let inTransitMicro: Decimal
    public let minLiqDistanceBps: Double?
    public let stopsMissing: Int
    public let incident: Bool
    public let venueReadAtMs: Double?
    /// The venue read is older than PerpsStatus.staleAfterMs: shown, dated,
    /// and no longer called current.
    public let stale: Bool

    /// Something is open. `stopsMissing` counts positions the report could not
    /// render (a foreign position on a market this build has no decimals for)
    /// as well as unprotected ones, so a positive count with an empty list is
    /// still a position; so is notional with no position yet (an open in flight).
    public var held: Bool { !positions.isEmpty || stopsMissing > 0 || openNotionalMicro != 0 }
    /// Positions the report counts but could not list: `stopsMissing` counts
    /// every position without a stop SEEN resting, listed or not, and a listed
    /// one shows its stop only when it was seen (worker view.ts) — so what
    /// the count exceeds the listed stop-less ones by was never listed.
    public var unlisted: Int { max(0, stopsMissing - positions.filter { $0.stopTrigger == nil }.count) }
    /// Every position, listed or not.
    public var count: Int { positions.count + unlisted }
    /// Money is at the venue, or on its way in or out of it.
    public var funded: Bool { collateralMicro != 0 || inTransitMicro != 0 }

    /// Rule 12's venue term as far as this report can state it: what was
    /// posted, what is in transit, and every position's unrealized P&L — or
    /// nil when any position's P&L was not read, because a total missing a
    /// term is not the total.
    public var accountMicro: Decimal? {
        var sum = collateralMicro + inTransitMicro
        for p in positions {
            guard let u = p.unrealizedMicro.flatMap(PerpsStatus.micro) else { return nil }
            sum += u
        }
        return sum
    }
}

// MARK: - what the banner says

public struct PerpsBannerCopy: Equatable, Sendable {
    /// The one sentence. Never dismissible: the view that draws it has no close.
    public let headline: String
    public let lines: [String]
    /// Unread or an incident: drawn in the alarm tone. Held: the warning tone.
    public let alarm: Bool
    public let paper: Bool
    /// A link to SEE them, and named as that: the web desk's perps panel is
    /// read-only too — no single close and no Close-all exist anywhere yet
    /// (the owner-order route for them is not built), so "Manage" promised a
    /// control the owner would not find.
    public static let manage = "See them on the web dashboard"
    /// The owner's desk on the web app, where the perps panel is.
    public static let dashboardPath = "/agent"
    public static let closeAllPath = "/agent?perps=flatten"
    public static func reviewPath(purpose: String, symbol: String, book: String?) -> String? {
        guard book == nil || book == "paper" || book == "live" else { return nil }
        let suffix = book.map { "&book=\($0)" } ?? ""
        if purpose == "flatten-perps" { return closeAllPath + suffix }
        guard purpose == "close-perp", symbol.range(of: "^[A-Z0-9]{1,24}-PERP$", options: .regularExpression) != nil else { return nil }
        return "/agent?perps=close&market=\(symbol)" + suffix
    }
    public static let closeAll = "Close all perpetual positions…"
    /// Closing is reviewed on the owner-bound web desk; opening this link places nothing.
    public static let noCloseLine = "Close all opens a confirmation on the web dashboard. It requests reduce-only closes, which may realize a loss, and pauses new perpetual positions until you resume them there."
}

extension PerpsStatus {
    public var banner: PerpsBannerCopy? {
        switch state {
        case .none:
            return nil
        case let .unread(paper, recorded, incident):
            var lines: [String] = []
            if recorded > 0 { lines.append("The agent's own records list \(Self.count(recorded, "position", "positions")).") }
            if incident { lines.append(Self.incidentLine) }
            lines.append(paper ? Self.practiceLine : "Any stops resting at Lighter keep working whether or not it can be read.")
            lines.append(PerpsBannerCopy.noCloseLine)
            return PerpsBannerCopy(
                headline: paper
                    ? "Paper perpetuals could not be read — you may have open paper leveraged positions"
                    : "Lighter could not be read — you may have open leveraged positions",
                lines: lines, alarm: true, paper: paper)
        case let .known(k):
            var lines: [String] = []
            let headline: String
            if k.held {
                // docs: "Leveraged positions on Lighter: N, $X notional,
                // nearest liquidation Y% away". The count is left out only
                // when there is none to give (an open still in flight), never
                // printed as 0 beside notional that says otherwise.
                var parts: [String] = []
                if k.count > 0 { parts.append(String(k.count)) }
                parts.append("\(Self.dollars(k.openNotionalMicro)) notional")
                parts.append(Self.liquidationText(k.minLiqDistanceBps))
                headline = (k.paper ? "Paper leveraged positions: " : "Leveraged positions on Lighter: ") + parts.joined(separator: ", ")
                if k.unlisted > 0 {
                    lines.append("\(Self.count(k.unlisted, "position", "positions")) could not be listed here and \(k.unlisted == 1 ? "is" : "are") not in that notional.")
                }
                if k.stopsMissing > 0 {
                    lines.append("\(Self.count(k.stopsMissing, "position has", "positions have")) no stop seen resting\(k.paper ? "" : " at Lighter").")
                }
                if k.incident { lines.append(Self.incidentLine) }
                lines.append(PerpsBannerCopy.noCloseLine)
            } else if k.funded {
                headline = k.paper
                    ? "Paper perpetuals: \(Self.dollars(k.collateralMicro + k.inTransitMicro)) of practice margin, no position open"
                    : "USDG on Lighter: \(Self.dollars(k.collateralMicro + k.inTransitMicro)), no leveraged position open"
                if k.inTransitMicro != 0 { lines.append("\(Self.dollars(k.inTransitMicro)) of it is in transit between Lighter and your smart account.") }
                if k.incident { lines.append(Self.incidentLine) }
            } else {
                // Only the incident is left to say, and it is the headline.
                headline = Self.incidentLine
            }
            if k.stale { lines.append("Last read over 15 minutes ago, so this may not be current.") }
            if k.paper { lines.append(Self.practiceLine) }
            return PerpsBannerCopy(headline: headline, lines: lines, alarm: k.incident || k.stale, paper: k.paper)
        }
    }

    /// One row per position the report lists: "BTC-PERP · Long · 3x · liquidation 52,000".
    public var positionRows: [String] {
        guard case let .known(k) = state else { return [] }
        return k.positions.map { p in
            var parts = [p.market, p.side == "short" ? "Short" : "Long"]
            if let lev = p.leverage { parts.append(Self.leverageText(lev)) }
            parts.append(p.liqPrice.map { "liquidation \($0)" } ?? "liquidation not read")
            return parts.joined(separator: " · ")
        }
    }

    /// THE "AT LIGHTER" ROW, where the account's money is listed: nil when
    /// there is nothing to list (an agent without perps gets no $0.00 row).
    /// A practice book is labelled as one — its margin never left the paper
    /// ledger, so "at Lighter" would be a claim about real money.
    public var atLighter: (label: String, value: String)? {
        switch state {
        case .none: return nil
        case let .unread(paper, _, _): return (paper ? "Paper perps" : "At Lighter", "couldn't read")
        case let .known(k):
            let label = k.paper ? "Paper perps" : "At Lighter"
            if let total = k.accountMicro { return (label, Self.dollars(total)) }
            return (label, "\(Self.dollars(k.collateralMicro + k.inTransitMicro)) posted, P&L not read")
        }
    }

    /// What the spot positions list says when it is empty. Only `none` may say
    /// "No positions": in every other state the leverage is elsewhere, or unknown.
    public var emptyPositions: String {
        switch state {
        case .none: return "No positions in this book."
        case .unread: return "No spot positions in this book. Lighter could not be read, so leveraged positions are not ruled out."
        case let .known(k): return k.held ? "No spot positions in this book. Its leveraged positions are shown above." : "No positions in this book."
        }
    }

    /// The list's label when the empty-copy above can hold: none keeps "Positions".
    public var positionsLabel: String {
        switch state {
        case .none: return "Positions"
        case .unread: return "Spot positions"
        case let .known(k): return k.held ? "Spot positions" : "Positions"
        }
    }

    // MARK: - the kill

    /// Whether a kill has anything to say about Lighter at all.
    public var realMoney: Bool { custody != .none }

    /// WHAT A KILL DOES TO PERPS, said before the owner confirms it — the
    /// web's killWarning, word for word, for what THIS server's kill does
    /// (rule 13). Supported shutdown attempts reduce-only closes and a secure
    /// withdrawal; neither is guaranteed. An unsupported server leaves venue
    /// positions to their resting stops. Nil when there is nothing at Lighter.
    public var killWarning: String? {
        let positions: Int?
        switch custody {
        case .none: return nil
        case .unread: positions = nil
        case let .known(n, _): positions = n
        }
        if standsDownOnKill {
            let what: String
            if let n = positions, n > 0 {
                what = n == 1 ? "its open perpetual position on Lighter" : "its \(n) open perpetual positions on Lighter"
            } else if positions == nil {
                what = "any perpetual positions there (Lighter could not be read)"
            } else {
                what = "any perpetual positions on Lighter"
            }
            return "Stopping the agent requests a stand-down: the worker attempts to close \(what) at market with reduce-only orders, which can realize a loss, "
                + "and requests withdrawal of free collateral to your smart account after Lighter's delay. A request can fail or leave a partial fill; check the shutdown result for what remains."
        }
        let held: String
        if let n = positions, n > 0 {
            held = n == 1 ? "Its open perpetual position on Lighter stays open" : "Its \(n) open perpetual positions on Lighter stay open"
        } else if positions == nil {
            held = "Lighter could not be read, so any perpetual positions there stay open"
        } else {
            held = "Any perpetual positions on Lighter stay open"
        }
        return "Stopping the agent here does NOT close its perpetuals: this server cannot stand them down yet. \(held), "
            + "protected only by the stops resting at Lighter — they expire after at most 28 days and nothing re-places them once "
            + "the agent is stopped — and collateral stays at Lighter. Before stopping, use Close or Close all on the desk to review an exit request; "
            + "a close is only complete when the worker reports the remaining book."
    }

    /// The confirmation's message: the spot sentence, then the perps one.
    public func standDownPrompt(base: String) -> String {
        killWarning.map { "\(base) \($0)" } ?? base
    }

    /// WHERE THE MONEY IS, once the stand-down was accepted — core's
    /// custodySentence over the exposure above, the way the web builds its
    /// kill messages. "Your funds stay" is kept for `none`, the only state in
    /// which it is true. `server` is the DELETE answer's own `custody` when it
    /// sent one (self-hosted builds it from the stand-down's result, which
    /// this app cannot read once the grant is gone) and wins.
    public func standDownNotice(accepted: String, stayed: String, server: String? = nil) -> String {
        if let server, !server.isEmpty { return "\(accepted) \(server)" }
        guard let sentence = Self.custodySentence(custody) else { return "\(accepted) \(stayed)" }
        // Figures from before the stop are dated as such: with a stand-down
        // it has begun changing them by the time anyone reads this; without
        // one (hosted), nothing at Lighter was closed, and that is said first.
        let lead = standsDownOnKill ? "" : "Nothing at Lighter was closed. "
        if case .known = custody {
            return "\(accepted) \(lead)As last read before \(standsDownOnKill ? "the stand-down" : "stopping the agent"): \(sentence)"
        }
        return "\(accepted) \(lead)\(sentence)"
    }

    /// core custodySentence for the exposure a report can state (openOrders,
    /// pool shares, spot balances and pending withdrawals are not in it, and
    /// other accounts under the L1 address are NOT READ — so the sentence says
    /// that, and never that Lighter reads empty). Nil for none: the caller's
    /// own sentence about the smart account stands.
    static func custodySentence(_ c: PerpsCustody) -> String? {
        switch c {
        case .none:
            return nil
        case .unread:
            return unreadCustody
        case let .known(positions, collateral):
            var held: [String] = []
            if positions > 0 { held.append(count(positions, "open position", "open positions")) }
            if collateral != 0 { held.append("\(usdg(collateral)) of collateral") }
            var parts: [String] = []
            if !held.isEmpty { parts.append("Still on Lighter: \(held.joined(separator: ", ")).") }
            parts.append("Other Lighter accounts under your smart account could not be read, so whether they hold anything is unknown.")
            if positions > 0 { parts.append("Any stops resting at Lighter stay in place until those positions close.") }
            parts.append("To unwind it yourself with your owner key, \(recover).")
            return parts.joined(separator: " ")
        }
    }

    // MARK: - words and figures

    /// The web's HOSTED_RECOVER_PATH (the service this app talks to), without
    /// the backticks a phone would print literally: the web dashboard's
    /// Withdraw shows what is at Lighter, and the unwind is the CLI with the
    /// owner key (rule 13: "the recover path for the owner's platform").
    static let recover = "open Withdraw on the web dashboard, which shows what is at Lighter, then run merrymen recover"
    /// custodySentence's unread sentence, word for word.
    static let unreadCustody = "Lighter could not be read, so what is still there is unknown: positions, their resting stops and USDG may remain on Lighter. To see it and unwind it with your owner key, \(recover)."
    /// What a practice book is, said wherever one is shown.
    static let practiceLine = "Practice book: no real money is traded in it."
    /// perpsBlockerText("perps-unknown-activity").what, word for word.
    static let incidentLine = "Lighter shows activity on the agent's account that the agent did not do. New positions are stopped and open ones are being closed."

    static func count(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

    /// "1x", "2.5x" — the report's leverage, cut to hundredths and never
    /// rounded up into more than the venue holds.
    static func leverageText(_ v: Double) -> String {
        let text = String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), (v * 100).rounded(.down) / 100)
            .replacingOccurrences(of: "\\.?0+$", with: "", options: .regularExpression)
        return text + "x"
    }

    /// Liquidation distance to a tenth of a percent, rounded TOWARD the
    /// liquidation: showing a position further from it than it is would be
    /// the understatement this banner exists to prevent.
    static func liquidationText(_ bps: Double?) -> String {
        guard let bps, bps.isFinite else { return "nearest liquidation not read" }
        guard bps > 0 else { return "a position at or past its liquidation price" }
        let tenths = (bps / 10).rounded(.down)
        return "nearest liquidation " + String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), tenths / 10) + "% away"
    }

    /// micro-USDG as "$1,234.57", rounded UP to the cent in magnitude, like
    /// core's usdgText: exposure text may overstate by under a cent, never understate.
    static func dollars(_ micro: Decimal) -> String {
        let (negative, text) = centsText(micro)
        return (negative ? "-$" : "$") + text
    }

    /// The same figure in core's own unit: "1,234.57 USDG".
    static func usdg(_ micro: Decimal) -> String {
        let (negative, text) = centsText(micro)
        return (negative ? "-" : "") + text + " USDG"
    }

    private static func centsText(_ micro: Decimal) -> (Bool, String) {
        let negative = micro < 0
        var cents = (negative ? -micro : micro) / 10_000
        var up = Decimal()
        NSDecimalRound(&up, &cents, 0, .up)
        let format = NumberFormatter()
        format.locale = Locale(identifier: "en_US")
        format.numberStyle = .decimal
        format.usesGroupingSeparator = true
        format.minimumFractionDigits = 2
        format.maximumFractionDigits = 2
        return (negative && up != 0, format.string(from: NSDecimalNumber(decimal: up / 100)) ?? "—")
    }
}

// MARK: - the report, parsed the way core parses it

public struct PerpsPosition: Equatable, Sendable {
    public let market: String
    public let side: String
    public let baseAmount: String
    public let entryPrice: String
    public let markPrice: String?
    public let leverage: Double?
    public let marginMicro: String
    public let liqPrice: String?
    public let unrealizedMicro: String?
    public let stopTrigger: String?
    public let fundingMicro: String?
}

/// core `PerpsReport` (packages/core/src/perps.ts). Money is micro-USDG as a
/// decimal integer STRING — a float loses cents at scale — and every nullable
/// field means "not said", never zero.
public struct PerpsReport: Equatable, Sendable {
    public let mode: String
    public let blocker: String?
    public let venueReadAt: Double?
    public let protectAt: Double?
    public let accountIndex: Double?
    public let positions: [PerpsPosition]
    public let openNotionalMicro: String?
    public let collateralMicro: String?
    public let inTransitMicro: String?
    public let minLiqDistanceBps: Double?
    public let stopsMissing: Int
    public let incident: Bool

    /// core GRANT_PERP_LIGHTER.
    public static let grantMarker = "perp-lighter-v1"
    static let modes: Set<String> = ["off", "paper", "live", "refuse"]
    /// core PERP_BLOCKERS. A blocker this list lacks makes the whole report
    /// unread — the fail-closed side, and a Policy test holds it against core.
    public static let blockers: [String] = [
        "perps-off", "perps-live-off", "account-not-live", "perps-not-granted", "perps-cap-below-min",
        "perps-awaiting-deposit", "perps-key-pending", "perps-key-mismatch", "perps-venue-unreachable",
        "perps-no-collateral", "perps-grant-expiring", "perps-unknown-activity", "perps-entries-halted",
        "breaker-tripped",
    ]

    /// Strict whitelist parse, or nil (= unread) — parsePerpsReport rule for
    /// rule. A wrong type ANYWHERE refuses the whole report, one malformed
    /// position included: dropping just that position would draw a book with a
    /// leveraged position missing from it.
    public static func parse(_ raw: JSONValue) -> PerpsReport? {
        guard case let .object(o) = raw, o["v"] == .number(1),
              let mode = o["mode"]?.string, modes.contains(mode),
              case let .array(rawPositions)? = o["positions"],
              let stopsMissing = o["stopsMissing"].flatMap(safeInteger), stopsMissing >= 0,
              case let .bool(incident)? = o["incident"] else { return nil }
        guard let blocker = opt(o["blocker"], { $0.string.flatMap { blockers.contains($0) ? $0 : nil } }),
              let venueReadAt = opt(o["venueReadAt"], timestamp),
              let protectAt = opt(o["protectAt"], timestamp),
              let accountIndex = opt(o["accountIndex"], { safeInteger($0).flatMap { $0 > 0 ? $0 : nil } }),
              let openNotional = opt(o["openNotionalMicro"], intString),
              let collateral = opt(o["collateralMicro"], intString),
              let transit = opt(o["inTransitMicro"], intString),
              let minLiq = opt(o["minLiqDistanceBps"], { $0.number }) else { return nil }
        var positions: [PerpsPosition] = []
        for p in rawPositions {
            guard let parsed = position(p) else { return nil }
            positions.append(parsed)
        }
        return PerpsReport(mode: mode, blocker: blocker, venueReadAt: venueReadAt, protectAt: protectAt,
                           accountIndex: accountIndex, positions: positions, openNotionalMicro: openNotional,
                           collateralMicro: collateral, inTransitMicro: transit, minLiqDistanceBps: minLiq,
                           stopsMissing: Int(stopsMissing), incident: incident)
    }

    private static func position(_ raw: JSONValue) -> PerpsPosition? {
        guard case let .object(o) = raw,
              // Shape, not membership: a market this build does not list is
              // still exposure, and showing it beats hiding it behind "unread".
              let market = o["market"]?.string, matches(market, "^[A-Z0-9]{1,24}-PERP$"),
              let side = o["side"]?.string, side == "long" || side == "short",
              let base = o["baseAmount"].flatMap(positiveDecimal),
              let entry = o["entryPrice"].flatMap(positiveDecimal),
              let margin = o["marginMicro"].flatMap(intString),
              let mark = opt(o["markPrice"], positiveDecimal),
              let leverage = opt(o["leverage"], { $0.number.flatMap { $0 > 0 ? $0 : nil } }),
              let liq = opt(o["liqPrice"], positiveDecimal),
              let unrealized = opt(o["unrealizedMicro"], intString),
              let stop = opt(o["stopTrigger"], positiveDecimal),
              let funding = opt(o["fundingMicro"], intString) else { return nil }
        return PerpsPosition(market: market, side: side, baseAmount: base, entryPrice: entry, markPrice: mark,
                             leverage: leverage, marginMicro: margin, liqPrice: liq, unrealizedMicro: unrealized,
                             stopTrigger: stop, fundingMicro: funding)
    }

    /// A nullable field: absent or null is "not said" (`.some(nil)`); present
    /// and wrong refuses the report (`nil`).
    private static func opt<T>(_ v: JSONValue?, _ ok: (JSONValue) -> T?) -> T?? {
        guard let v, v != .null else { return .some(nil) }
        guard let value = ok(v) else { return nil }
        return .some(value)
    }

    private static func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }
    private static func intString(_ v: JSONValue) -> String? { v.string.flatMap { matches($0, "^-?[0-9]{1,40}$") ? $0 : nil } }
    private static func positiveDecimal(_ v: JSONValue) -> String? {
        v.string.flatMap { matches($0, "^[0-9]{1,30}(\\.[0-9]{1,30})?$") && matches($0, "[1-9]") ? $0 : nil }
    }
    private static func safeInteger(_ v: JSONValue) -> Double? {
        guard let n = v.number, n.rounded() == n, abs(n) <= 9_007_199_254_740_991 else { return nil }
        return n
    }
    private static func timestamp(_ v: JSONValue) -> Double? { safeInteger(v).flatMap { $0 >= 0 ? $0 : nil } }
}
