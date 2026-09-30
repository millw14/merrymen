import SwiftUI
import SafariServices
import MerrymenPolicy

/// THE BANNER THAT CANNOT BE DISMISSED (docs/perps.md, Surfaces → Mobile).
///
/// Drawn whenever the agent's perps report is not none — leveraged positions,
/// USDG left on Lighter, an incident, or a venue nobody could read — and there
/// is deliberately no dismiss control on it: the condition it names is a standing one,
/// and a banner an owner can swipe away is how "No positions" comes back while
/// 10x is open. Every word comes from PerpsStatus (MerrymenPolicy), where a
/// macOS test holds it.
///
/// Close-all hands off to the authenticated web review. The link itself never submits an order.
struct PerpsNotice: View {
    let perps: PerpsStatus
    @State private var webReview: PerpsWebReview?
    var body: some View {
        if let copy = perps.banner {
            // Red for what may be unknown or not ours; the warning tone for
            // leverage that is read and accounted for.
            let tint: Color = copy.alarm ? Brand.down : .orange
            Card {
                HStack(alignment: .top, spacing: 8) {
                    Label(copy.headline, systemImage: copy.alarm ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                        .font(.headline).foregroundStyle(tint)
                    Spacer(minLength: 4)
                    if copy.paper { Pill(text: "Paper", tint: .orange) }
                }
                ForEach(Array(perps.positionRows.enumerated()), id: \.offset) { _, row in Text(row).font(.callout).monospacedDigit() }
                ForEach(Array(copy.lines.enumerated()), id: \.offset) { _, line in Text(line).font(.caption).foregroundStyle(.secondary) }
                if let row = perps.atLighter { Metric(label: row.label, value: row.value) }
                if let url = URL(string: PerpsBannerCopy.closeAllPath, relativeTo: API.origin)?.absoluteURL {
                    Button(PerpsBannerCopy.closeAll) { webReview = PerpsWebReview(url: url) }.font(.subheadline.weight(.semibold))
                }
                if let url = URL(string: PerpsBannerCopy.dashboardPath, relativeTo: API.origin)?.absoluteURL {
                    Button(PerpsBannerCopy.manage) { webReview = PerpsWebReview(url: url) }.font(.subheadline.weight(.semibold))
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(tint.opacity(0.5)))
            .sheet(item: $webReview) { PerpsWebSheet(url: $0.url) }
        }
    }
}

/// THE OWNER'S BOOK, WITH THE AGENT'S STATUS READ BESIDE IT RATHER THAN AROUND IT.
///
/// The perps report rides GET /api/grants, the portfolio rides /api/feed, and
/// neither may hide the other: nested inside the feed's read, a feed that
/// failed would take the leverage banner with it; wrapped around it, a status
/// that failed would take the balance. So the status is polled here on the
/// feed's own clock, the banner stands above the book, and the book is told
/// the perps state — nil while the status has not been read, which the book
/// must not take for "none". A refresh that fails keeps the last good read
/// (RemoteData only replaces its value on success).
struct OwnerHome: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.scenePhase) var phase
    @StateObject private var status = RemoteData()
    var body: some View {
        let perps = status.value.map { PerpsStatus(status: $0) }
        VStack(alignment: .leading, spacing: 20) {
            if let perps { PerpsNotice(perps: perps) }
            Remote(path: "/api/feed") { OwnerOverview(feed: $0, perps: perps) }
        }
        .task(id: "\(store.generation)|\(phase == .active)") {
            guard phase == .active else { return }
            repeat {
                await status.load(store.api, "/api/grants")
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            } while !Task.isCancelled
        }
    }
}

/// Use an in-app Safari page so the app's /agent universal link cannot swallow
/// the review query and navigate back to native chat. The website authenticates
/// its owner and requires a separate book-specific confirmation.
struct PerpsWebReview: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}
struct PerpsWebSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
