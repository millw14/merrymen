import XCTest
@testable import MerrymenPolicy

/// The phone's honesty minimum for perpetuals (docs/perps.md, Surfaces →
/// Mobile), rule by rule: never "No positions" over leverage or an unread
/// venue, a banner in every state but none, and kill copy that never says the
/// funds stay home while anything may be on Lighter.
final class PerpsStatusTests: XCTestCase {
    /// Five minutes after the fixtures' venue read.
    private let now: Double = 1_790_290_000_000 + 5 * 60_000

    private func read(_ status: JSONValue) -> PerpsStatus { PerpsStatus(status: status, nowMs: now) }

    private func json(_ text: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }

    /// A GET /api/grants answer for a live account carrying the perps permission.
    private func status(perps: String?, mode: String = "live", perpsGrant: Bool = true) -> JSONValue {
        let grant = perpsGrant
            ? #"{"smartAccount":"0x1111111111111111111111111111111111111111","grantFeatures":["perp-lighter-v1"],"perp":{"route":"perp-lighter-v1","apiKeyIndex":16,"apiPublicKey":"0x01"}}"#
            : #"{"smartAccount":"0x1111111111111111111111111111111111111111","grantFeatures":[]}"#
        let field = perps.map { #","perps":\#($0)"# } ?? ""
        return json(#"{"exists":true,"mode":"\#(mode)","grant":\#(grant)\#(field)}"#)
    }

    private let btc = #"{"market":"BTC-PERP","side":"long","baseAmount":"0.00020","entryPrice":"65000.0","markPrice":"66000.0","leverage":3,"marginMicro":"4333333","liqPrice":"44000.0","unrealizedMicro":"200000","stopTrigger":"61750.0","fundingMicro":"-1200"}"#

    private func report(mode: String = "live", positions: [String] = [], notional: String? = "0", collateral: String? = "0", transit: String? = "0", minLiq: String = "null", stopsMissing: Int = 0, incident: Bool = false, blocker: String = "null") -> String {
        func q(_ s: String?) -> String { s.map { "\"\($0)\"" } ?? "null" }
        return #"{"v":1,"mode":"\#(mode)","blocker":\#(blocker),"venueReadAt":1790290000000,"protectAt":null,"accountIndex":22149,"positions":[\#(positions.joined(separator: ","))],"openNotionalMicro":\#(q(notional)),"collateralMicro":\#(q(collateral)),"inTransitMicro":\#(q(transit)),"minLiqDistanceBps":\#(minLiq),"stopsMissing":\#(stopsMissing),"incident":\#(incident)}"#
    }

    // MARK: - the state

    func testExitReviewPathsAreExplicitAndCannotBecomeOrdersOrExternalURLs() {
        XCTAssertEqual(PerpsBannerCopy.reviewPath(purpose: "close-perp", symbol: "BTC-PERP", book: "live"), "/agent?perps=close&market=BTC-PERP&book=live")
        XCTAssertEqual(PerpsBannerCopy.reviewPath(purpose: "flatten-perps", symbol: "ALL-PERPS", book: nil), "/agent?perps=flatten")
        XCTAssertNil(PerpsBannerCopy.reviewPath(purpose: "close-perp", symbol: "BTC-PERP&book=live", book: "paper"))
        XCTAssertNil(PerpsBannerCopy.reviewPath(purpose: "close-perp", symbol: "BTC-PERP", book: "unknown"))
    }

    func testOffRealVenueBookDoesNotBecomePaperWithTheAccountMode() {
        for mode in ["off", "refuse"] {
            let s = read(status(perps: report(mode: mode, positions: [btc], notional: "13000000"), mode: "paper"))
            XCTAssertEqual(s.banner?.paper, false)
            XCTAssertNotNil(s.atLighter)
            XCTAssertFalse(s.banner?.headline.contains("Paper") ?? true)
        }
    }

    func testRemovedGrantDoesNotEraseShutdownCustody() {
        let s = read(json(#"{"exists":false,"perpsShutdown":{"state":"expired","result":{"outcome":"unreachable"}}}"#))
        XCTAssertEqual(s.custody, .unread)
        XCTAssertNotNil(s.banner)
        XCTAssertNotEqual(s.emptyPositions, "No positions in this book.")
    }

    func testAbsentReportIsNoneAndNullIsUnreadOnlyWhereThePermissionAllowsLeverage() {
        XCTAssertEqual(read(status(perps: nil)).state, .none, "a server from before the report: nothing it could have opened")
        XCTAssertEqual(read(status(perps: "null")), PerpsStatus(state: .unread(paper: false, recorded: 0, incident: false), custody: .unread))
        XCTAssertEqual(read(status(perps: "null", perpsGrant: false)), .none, "no permission: the wall never let it post margin")
        XCTAssertEqual(read(json(#"{"exists":false}"#)), .none)
    }

    func testAnythingTheStrictParserRefusesIsUnreadNeverNone() {
        for bad in [#""yes""#, "[]", #"{"v":2}"#, report(mode: "maybe"), report(blocker: #""new-blocker""#),
                    report(positions: [btc.replacingOccurrences(of: #""long""#, with: #""sell""#)], notional: "1"),
                    report(positions: [btc.replacingOccurrences(of: #""4333333""#, with: "4333333")], notional: "1"),
                    report(notional: "1.5")] {
            XCTAssertEqual(read(status(perps: bad)), PerpsStatus(state: .unread(paper: false, recorded: 0, incident: false), custody: .unread), bad)
            // Said and unreadable is unread even where the grant has no perps.
            XCTAssertEqual(read(status(perps: bad, perpsGrant: false)).custody, .unread, bad)
        }
    }

    func testAFlatReportIsNoneAndSaysNoPositions() {
        let s = read(status(perps: report()))
        XCTAssertEqual(s.state, .none)
        // Known and empty still names a venue account: a kill says the other
        // accounts under it were not read, never that the funds are all home.
        XCTAssertEqual(s.custody, .known(positions: 0, collateralMicro: 0))
        XCTAssertEqual(read(status(perps: report().replacingOccurrences(of: #""accountIndex":22149"#, with: #""accountIndex":null"#))), .none)
        XCTAssertNil(s.banner)
        XCTAssertNil(s.atLighter)
        XCTAssertEqual(s.emptyPositions, "No positions in this book.")
    }

    func testMissingVenueFiguresAreUnreadWithTheLedgersOwnCount() {
        // The worker's report for a venue it could not read (view.ts): the
        // ledger's positions, every venue figure null.
        let s = read(status(perps: report(positions: [btc], notional: nil, collateral: nil, transit: nil, stopsMissing: 1)))
        XCTAssertEqual(s, PerpsStatus(state: .unread(paper: false, recorded: 1, incident: false), custody: .unread))
        let b = s.banner!
        XCTAssertEqual(b.headline, "Lighter could not be read — you may have open leveraged positions")
        XCTAssertTrue(b.alarm)
        XCTAssertTrue(b.lines.contains("The agent's own records list 1 position."))
        XCTAssertEqual(s.atLighter?.value, "couldn't read")
        XCTAssertFalse(s.emptyPositions.hasPrefix("No positions"))
    }

    // MARK: - the banner

    func testHeldPositionsNameCountNotionalAndLiquidationRoundedTowardIt() {
        let s = read(status(perps: report(positions: [btc, btc.replacingOccurrences(of: "BTC", with: "ETH")], notional: "25000001", collateral: "8666666", minLiq: "1239.9")))
        let b = s.banner!
        XCTAssertEqual(b.headline, "Leveraged positions on Lighter: 2, $25.01 notional, nearest liquidation 12.3% away")
        XCTAssertFalse(b.alarm)
        XCTAssertFalse(b.paper)
        XCTAssertEqual(s.positionRows.first, "BTC-PERP · Long · 3x · liquidation 44000.0")
        XCTAssertEqual(s.emptyPositions, "No spot positions in this book. Its leveraged positions are shown above.")
        XCTAssertEqual(s.positionsLabel, "Spot positions")
        // C + T + ΣU: 8.666666 + 0 + 0.2 + 0.2, up to the cent.
        XCTAssertEqual(s.atLighter?.label, "At Lighter")
        XCTAssertEqual(s.atLighter?.value, "$9.07")
    }

    func testAnUnreadLiquidationOrPnLIsSaidNotGuessed() {
        // Its stop was not seen resting, so the report leaves the trigger out
        // and counts it in stopsMissing (worker view.ts).
        let noPnl = btc.replacingOccurrences(of: #""unrealizedMicro":"200000""#, with: #""unrealizedMicro":null"#)
            .replacingOccurrences(of: #""stopTrigger":"61750.0""#, with: #""stopTrigger":null"#)
        let s = read(status(perps: report(positions: [noPnl], notional: "13000000", collateral: "4333333", stopsMissing: 1)))
        XCTAssertEqual(s.banner?.headline, "Leveraged positions on Lighter: 1, $13.00 notional, nearest liquidation not read")
        XCTAssertEqual(s.banner?.lines, ["1 position has no stop seen resting at Lighter.", PerpsBannerCopy.noCloseLine])
        XCTAssertEqual(s.atLighter?.value, "$4.34 posted, P&L not read")
    }

    func testAPositionTheReportCouldNotListStillRaisesTheBanner() {
        let s = read(status(perps: report(notional: "0", collateral: "0", stopsMissing: 1, incident: true)))
        let b = s.banner!
        XCTAssertEqual(b.headline, "Leveraged positions on Lighter: 1, $0.00 notional, nearest liquidation not read")
        XCTAssertTrue(b.alarm)
        XCTAssertTrue(b.lines.contains("1 position could not be listed here and is not in that notional."))
        XCTAssertTrue(b.lines.contains { $0.hasPrefix("Lighter shows activity") })
        // A listed position with its stop seen resting and one foreign one the
        // report could not render: two, not one.
        let mixed = read(status(perps: report(positions: [btc], notional: "13000000", collateral: "1", stopsMissing: 1, incident: true)))
        XCTAssertTrue(mixed.banner!.headline.hasPrefix("Leveraged positions on Lighter: 2, $13.00 notional"))
    }

    func testMoneyLeftOnLighterWithNothingOpenIsStillABanner() {
        let s = read(status(perps: report(collateral: "5000000", transit: "1000000")))
        XCTAssertEqual(s.banner?.headline, "USDG on Lighter: $6.00, no leveraged position open")
        XCTAssertEqual(s.emptyPositions, "No positions in this book.")
        XCTAssertEqual(s.atLighter?.value, "$6.00")
    }

    func testPaperIsAlwaysLabelledPaper() {
        let paper = read(status(perps: report(mode: "paper", positions: [btc], notional: "13000000", collateral: "4333333", minLiq: "3000"), mode: "paper"))
        XCTAssertEqual(paper.banner?.headline, "Paper leveraged positions: 1, $13.00 notional, nearest liquidation 30.0% away")
        XCTAssertTrue(paper.banner!.lines.contains("Practice book: no real money is traded in it."))
        XCTAssertEqual(paper.atLighter?.label, "Paper perps")
        // With no real venue index, the off rail can retain a practice book.
        let offOnPaper = read(status(perps: report(mode: "off", positions: [btc], notional: "1").replacingOccurrences(of: #""accountIndex":22149"#, with: #""accountIndex":null"#), mode: "paper"))
        XCTAssertEqual(offOnPaper.banner?.paper, true)
        // An off rail on a live account is real money until something says otherwise.
        let offOnLive = read(status(perps: report(mode: "off", positions: [btc], notional: "1"), mode: "live"))
        XCTAssertEqual(offOnLive.banner?.paper, false)
    }

    // MARK: - the kill

    func testKillCopyNeverSaysTheFundsStayHomeWhileAnythingMayBeOnLighter() {
        let accepted = "Stand-down request accepted."
        let stayed = "Existing assets remain in the smart account."
        XCTAssertEqual(PerpsStatus.none.standDownNotice(accepted: accepted, stayed: stayed), "\(accepted) \(stayed)")
        XCTAssertNil(PerpsStatus.none.killWarning)

        // THE HOSTED SERVICE THIS APP TALKS TO CLOSES NOTHING ON A KILL YET
        // (no perpsStanddownOnKill): the copy says so, never "closed at market".
        let unread = read(status(perps: "null"))
        XCTAssertFalse(unread.standsDownOnKill)
        XCTAssertEqual(unread.standDownNotice(accepted: accepted, stayed: stayed), "\(accepted) Nothing at Lighter was closed. \(PerpsStatus.unreadCustody)")
        XCTAssertTrue(unread.killWarning!.contains("Lighter could not be read, so any perpetual positions there stay open"))
        XCTAssertFalse(unread.killWarning!.contains("closed at market"))

        let held = read(status(perps: report(positions: [btc], notional: "13000000", collateral: "4333333", transit: "1000000")))
        XCTAssertEqual(held.custody, .known(positions: 1, collateralMicro: 5_333_333))
        XCTAssertEqual(held.standDownNotice(accepted: accepted, stayed: stayed),
                       "\(accepted) Nothing at Lighter was closed. As last read before stopping the agent: Still on Lighter: 1 open position, 5.34 USDG of collateral. Other Lighter accounts under your smart account could not be read, so whether they hold anything is unknown. Any stops resting at Lighter stay in place until those positions close. To unwind it yourself with your owner key, open Withdraw on the web dashboard, which shows what is at Lighter, then run merrymen recover.")
        XCTAssertEqual(held.standDownPrompt(base: "Base."),
                       "Base. Stopping the agent here does NOT close its perpetuals: this server cannot stand them down yet. Its open perpetual position on Lighter stays open, protected only by the stops resting at Lighter — they expire after at most 28 days and nothing re-places them once the agent is stopped — and collateral stays at Lighter. Before stopping, use Close or Close all on the desk to review an exit request; a close is only complete when the worker reports the remaining book.")
        // A server that DOES stand perps down says so, and only then is a close promised.
        let standing = PerpsStatus(status: json(#"{"exists":true,"mode":"live","perpsStanddownOnKill":true,"grant":{"grantFeatures":["perp-lighter-v1"]},"perps":\#(report(positions: [btc], notional: "13000000", collateral: "4333333", transit: "1000000"))}"#), nowMs: 1_790_290_000_000)
        XCTAssertTrue(standing.standsDownOnKill)
        XCTAssertEqual(standing.standDownPrompt(base: "Base."),
                       "Base. Stopping the agent requests a stand-down: the worker attempts to close its open perpetual position on Lighter at market with reduce-only orders, which can realize a loss, and requests withdrawal of free collateral to your smart account after Lighter's delay. A request can fail or leave a partial fill; check the shutdown result for what remains.")
        XCTAssertTrue(standing.standDownNotice(accepted: accepted, stayed: stayed).contains("As last read before the stand-down: "))
        // The DELETE answer's own sentence, built from the stand-down's result, wins.
        XCTAssertEqual(held.standDownNotice(accepted: accepted, stayed: stayed, server: "Lighter reads empty."), "\(accepted) Lighter reads empty.")

        // A read too old to describe now is not repeated as fact.
        let old = PerpsStatus(status: status(perps: report(positions: [btc], notional: "1", collateral: "1")), nowMs: 1_790_290_000_000 + 16 * 60_000)
        XCTAssertEqual(old.custody, .unread)
        XCTAssertTrue(old.banner!.alarm)
        XCTAssertTrue(old.banner!.lines.contains("Last read over 15 minutes ago, so this may not be current."))

        // A practice book says nothing about a real venue account: unread for
        // a perps grant, the plain words for one without.
        let paperReport = report(mode: "paper", positions: [btc], notional: "1")
        XCTAssertEqual(read(status(perps: paperReport, mode: "paper")).custody, .unread)
        let paperOnly = read(status(perps: paperReport, mode: "paper", perpsGrant: false))
        XCTAssertEqual(paperOnly.standDownNotice(accepted: accepted, stayed: stayed), "\(accepted) \(stayed)")
        XCTAssertEqual(paperOnly.standDownPrompt(base: "Base."), "Base.")
    }

    // MARK: - drift against core

    /// The words this file copies from core, held against core. A checkout
    /// without the monorepo (the package built alone) skips.
    func testCopiedWordsAndBlockersMatchCore() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        guard let core = try? String(contentsOf: root.appendingPathComponent("packages/core/src/perps.ts"), encoding: .utf8) else {
            throw XCTSkip("packages/core is not beside this package")
        }
        let flat = core.replacingOccurrences(of: #"\"\s*\+\s*`"#, with: "", options: .regularExpression)
        XCTAssertTrue(flat.contains(String(PerpsStatus.unreadCustody.dropLast(PerpsStatus.recover.count + 1))))
        XCTAssertTrue(core.contains(PerpsStatus.incidentLine))
        XCTAssertTrue(core.contains("Any stops resting at Lighter stay in place until those positions close."))
        XCTAssertTrue(core.contains("Other Lighter accounts under your smart account could not be read, so whether they hold anything is unknown."))
        XCTAssertTrue(flat.contains("To unwind it yourself with your owner key, ${recover}."))
        // The web's port of the same report, where it is present: the kill
        // warning is said the same way on every surface.
        if let web = try? String(contentsOf: root.appendingPathComponent("web/src/lib/perps-view.ts"), encoding: .utf8) {
            XCTAssertTrue(web.contains("at market with reduce-only orders, which can realize a loss, "))
            XCTAssertTrue(web.contains("and requests withdrawal of free collateral to your smart account after Lighter's delay. A request can fail or leave a partial fill; check the shutdown result for what remains."))
            XCTAssertTrue(web.contains("any perpetual positions there (Lighter could not be read)"))
            XCTAssertTrue(web.contains("Stopping the agent here does NOT close its perpetuals: this server cannot stand them down yet."))
            XCTAssertTrue(web.contains("Lighter could not be read, so any perpetual positions there stay open"))
            XCTAssertTrue(web.contains("re-places them once the agent is stopped — and collateral stays at Lighter. Before stopping, use Close or Close all on the desk "))
            XCTAssertTrue(web.contains("PERPS_REPORT_STALE_MS = 15 * 60_000"))
        }
        XCTAssertTrue(core.contains(#"GRANT_PERP_LIGHTER = "\#(PerpsReport.grantMarker)""#))
        let start = try XCTUnwrap(core.range(of: "PERP_BLOCKERS = Object.freeze(["))
        let end = try XCTUnwrap(core.range(of: "] as const", range: start.upperBound..<core.endIndex))
        let listed = core[start.upperBound..<end.lowerBound].split(separator: "\n")
            .compactMap { $0.split(separator: "\"").dropFirst().first.map(String.init) }
        XCTAssertEqual(listed, PerpsReport.blockers)
    }
}
