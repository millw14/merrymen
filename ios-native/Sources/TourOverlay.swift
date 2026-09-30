import SwiftUI

/// The tour walks the real app, like the web's FirstVisit: each stop opens the
/// screen it talks about, scrolls the element into view and spotlights it. It
/// only navigates; it never presses anything or changes a setting.
struct TourStop {
    enum Place { case tab(Tab), route(Route) }
    let place: Place?
    /// A `tourAnchor` id to spotlight, or nil to describe the whole screen.
    let anchor: String?
}

extension TourStop {
    /// Same order and screens as web/src/terminal/FirstVisit.tsx STOPS.
    static let all: [TourStop] = [
        .init(place: nil, anchor: nil),                                   // 1 welcome
        .init(place: .tab(.home), anchor: "home-markets"),                // 2 markets
        .init(place: .tab(.chat), anchor: "chat-limits"),                 // 3 boundaries
        .init(place: .tab(.chat), anchor: "chat-input"),                  // 4 ask it why
        .init(place: .tab(.profile), anchor: "profile-top"),              // 5 what you hold
        .init(place: nil, anchor: nil),                                   // 6 you stay in control
        .init(place: .tab(.feed), anchor: "feed-filters"),                // 7 the feed
        .init(place: .route(.search), anchor: nil),                       // 8 search
        .init(place: .route(.create), anchor: nil),                       // 9 build your agent
        .init(place: .route(.settings), anchor: nil),                     // 10 paper and live
        .init(place: .route(.limits), anchor: nil),                       // 11 spending limits
        .init(place: .route(.permissions), anchor: nil),                  // 12 wallet permissions
        .init(place: .route(.deposit), anchor: nil),                      // 13 add funds
        .init(place: .route(.withdraw), anchor: nil),                     // 14 withdraw
        .init(place: .tab(.home), anchor: "home-top"),                    // 15 portfolio
        .init(place: .tab(.home), anchor: "home-leaderboard"),            // 16 other agents
        .init(place: .tab(.home), anchor: "home-leaderboard"),            // 17 leaderboard
        .init(place: .tab(.home), anchor: "home-leaderboard"),            // 18 P&L
        .init(place: .tab(.home), anchor: "home-leaderboard"),            // 19 chart numbers
        .init(place: .tab(.feed), anchor: "feed-filters"),                // 20 buys, sells, decisions
        .init(place: .tab(.feed), anchor: "feed-first"),                  // 21 follow the reasoning
        .init(place: .tab(.feed), anchor: "feed-first"),                  // 22 wire in
        .init(place: .tab(.alpha), anchor: "alpha-header"),               // 23 alpha
        .init(place: .route(.settings), anchor: nil),                     // 24 settings
        .init(place: .route(.settings), anchor: nil),                     // 25 API
        .init(place: .tab(.chat), anchor: "chat-input"),                  // 26 ready
    ]
}

/// On-screen frames of the elements the tour can point at, in global space.
@MainActor
final class TourAnchors: ObservableObject {
    static let shared = TourAnchors()
    @Published var frames: [String: CGRect] = [:]
}

private struct TourFocusKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
    /// The anchor the tour is showing, so a scrolling page can bring it into view.
    var tourFocus: String? {
        get { self[TourFocusKey.self] }
        set { self[TourFocusKey.self] = newValue }
    }
}

extension View {
    /// Marks an element the tour can spotlight.
    func tourAnchor(_ id: String) -> some View {
        self.id("tour.\(id)").background {
            GeometryReader { geometry in
                let frame = geometry.frame(in: .global)
                Color.clear
                    .onAppear { TourAnchors.shared.frames[id] = frame }
                    .onChange(of: frame) { _, next in TourAnchors.shared.frames[id] = next }
                    .onDisappear { if TourAnchors.shared.frames[id] == frame { TourAnchors.shared.frames[id] = nil } }
            }
        }
    }
}

struct TourOverlay: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var progress: TourProgress
    @ObservedObject private var anchors = TourAnchors.shared
    @AppStorage("language") private var language = "en"
    @State private var asked = false
    private func words(_ key: String) -> String { Language.text(key, locale: language) }
    private func key(_ index: Int, _ part: String) -> String { "tour.stop\(String(format: "%02d", index + 1)).\(part)" }

    var body: some View {
        let step = progress.step
        let stop = TourStop.all[step]
        GeometryReader { geometry in
            let origin = geometry.frame(in: .global).origin
            let size = geometry.size
            // Only spotlight something actually on screen.
            let target = stop.anchor.flatMap { anchors.frames[$0] }
                .map { $0.offsetBy(dx: -origin.x, dy: -origin.y).insetBy(dx: -8, dy: -8) }
                .flatMap { $0.intersects(CGRect(origin: .zero, size: size)) ? $0 : nil }
            ZStack(alignment: .topLeading) {
                Spotlight(hole: target).fill(Color.black.opacity(stop.place == nil ? 0.78 : 0.62), style: FillStyle(eoFill: true))
                    .contentShape(Rectangle()).onTapGesture {}
                    .accessibilityHidden(true)
                if let target {
                    RoundedRectangle(cornerRadius: 16).strokeBorder(Brand.accent, lineWidth: 2)
                        .shadow(color: Brand.accent.opacity(0.6), radius: 10)
                        .frame(width: target.width, height: target.height).offset(x: target.minX, y: target.minY)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
                let area = cardArea(target: target, place: stop.place, size: size, insets: geometry.safeAreaInsets)
                // The card fits the space it is given and scrolls inside it, so
                // at the largest text sizes every control stays reachable.
                ViewThatFits(in: .vertical) {
                    card(step: step, stop: stop, width: min(size.width - 32, 440))
                    ScrollView { card(step: step, stop: stop, width: min(size.width - 32, 440)) }.scrollIndicators(.visible)
                }
                .frame(width: size.width, height: area.height, alignment: area.alignment)
                .offset(y: area.minY)
            }
            .animation(.spring(duration: 0.35), value: target)
            .animation(.spring(duration: 0.35), value: step)
        }
        .ignoresSafeArea()
        .onAppear { show(stop) }
    }

    /// Below the target if it sits in the top half, above it otherwise; a whole-
    /// screen stop keeps the card low so the screen it describes stays visible.
    private func cardArea(target: CGRect?, place: TourStop.Place?, size: CGSize, insets: EdgeInsets) -> (minY: CGFloat, height: CGFloat, alignment: Alignment) {
        let top = insets.top + 12, bottom = size.height - max(insets.bottom, 12) - 12
        let whole = (minY: top, height: bottom - top, alignment: place == nil ? Alignment.center : .bottom)
        guard let target else { return whole }
        let below = (minY: target.maxY + 14, height: bottom - target.maxY - 14, alignment: Alignment.top)
        let above = (minY: top, height: target.minY - 14 - top, alignment: Alignment.bottom)
        let preferred = target.midY < size.height / 2 ? below : above
        // Too little room beside the target: use the whole screen instead.
        return preferred.height >= 220 ? preferred : whole
    }

    private func card(step: Int, stop: TourStop, width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(Language.text("tour.stepOf", locale: language, vars: ["current": String(step + 1), "total": "26"]))
                    .font(.custom(Brand.pixel, size: 13, relativeTo: .caption)).foregroundStyle(Brand.accent)
                Spacer()
                Menu {
                    Picker(words("tour.topics"), selection: Binding(get: { step }, set: { go($0) })) {
                        ForEach(0..<26, id: \.self) { index in Text(words(key(index, "title"))).tag(index) }
                    }
                } label: { Label(words("tour.topics"), systemImage: "list.bullet").labelStyle(.iconOnly) }
                Menu {
                    Picker("Language", selection: $language) { ForEach(Language.options, id: \.0) { code, name in Text(name).tag(code) } }
                } label: { Image(systemName: "globe") }.accessibilityLabel("Language")
            }
            ProgressView(value: Double(step + 1), total: 26).tint(Brand.accent).accessibilityHidden(true)
            if step == 0 { Image("Brand").resizable().scaledToFit().frame(width: 56, height: 56).accessibilityHidden(true) }
            Text(words(key(step, "title"))).font(.title2.bold()).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
            Text(words(key(step, "copy"))).font(.callout).foregroundStyle(Color.white.opacity(0.78)).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button(words("tour.skip")) { finish() }.foregroundStyle(.secondary).accessibilityIdentifier("Skip tour")
                Spacer()
                if step > 0 { Button(words("tour.back")) { go(step - 1) }.buttonStyle(SecondaryButtonStyle()) }
                Button(words(step == 25 ? "tour.finish" : "tour.next")) { step == 25 ? finish() : go(step + 1) }.buttonStyle(PrimaryButtonStyle())
            }
            if progress.syncFailed { Button(words("tour.retrySync")) { Task { await progress.sync(store) } }.font(.caption) }
        }
        .padding(18).frame(width: width)
        .background(Brand.heroFill, in: RoundedRectangle(cornerRadius: 22))
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Brand.accent.opacity(0.3)))
        .shadow(color: .black.opacity(0.5), radius: 24, y: 8)
    }

    private func go(_ next: Int) {
        progress.move(next)
        show(TourStop.all[progress.step])
        // As on the web: the "Ask it why" stop leaves a first question in the
        // box, once, and never over something the reader typed.
        if progress.step == 3 && !asked { asked = true; store.chatDraft = "Explain my strategy and trading limits. Am I using paper or live trading?" }
    }
    private func show(_ stop: TourStop) {
        switch stop.place {
        case .tab(let tab): store.path = []; store.tab = tab
        case .route(let route): if store.path != [route] { store.path = [route] }
        case nil: break
        }
    }
    private func finish() { progress.finish(store) }
}

/// The dimmed layer with a rounded hole over the target.
private struct Spotlight: Shape {
    var hole: CGRect?
    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        if let hole { path.addRoundedRect(in: hole, cornerSize: CGSize(width: 16, height: 16)) }
        return path
    }
}
