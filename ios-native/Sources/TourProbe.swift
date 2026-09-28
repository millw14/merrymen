import UIKit

/// TEMPORARY diagnostics for the iOS 18 "tab tap lost after Skip tour" CI
/// failure. Only active in DEBUG UI-test launches. Remove before merging.
@MainActor
enum TourProbe {
    static var enabled: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-ui-testing")
        #else
        return false
        #endif
    }
    /// Candidate fix under test: block taps with hit-testing only, no gesture.
    static var noTapGesture: Bool { enabled && ProcessInfo.processInfo.arguments.contains("-tour-no-tap-gesture") }

    static func log(_ message: String) {
        guard enabled else { return }
        print("[TourProbe] \(String(format: "%.3f", Date().timeIntervalSince1970)) \(message)")
    }

    static func sample(_ label: String, after delays: [Double]) {
        guard enabled else { return }
        for delay in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { report("\(label)+\(delay)s") }
        }
    }

    static func report(_ label: String) {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        log("\(label) windows=\(windows.map { "\(type(of: $0))(key:\($0.isKeyWindow) hidden:\($0.isHidden) level:\($0.windowLevel.rawValue))" })")
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        // Centre of the second of five tab items (Chat) on a phone.
        let point = CGPoint(x: window.bounds.width * 0.3, y: window.bounds.height - 58)
        let hit = window.hitTest(point, with: nil)
        var chain: [String] = [], ancestors: [String] = []
        var view = hit
        while let current = view {
            chain.append(String(describing: type(of: current)))
            for recognizer in current.gestureRecognizers ?? [] where recognizer.isEnabled {
                ancestors.append("\(type(of: recognizer))@\(type(of: current)) state:\(recognizer.state.rawValue) cancels:\(recognizer.cancelsTouchesInView) name:\(recognizer.name ?? "-")")
            }
            view = current.superview
        }
        log("\(label) point=\(point) hit=\(chain.prefix(5).joined(separator: " < ")) depth=\(chain.count)")
        log("\(label) ancestorRecognizers(\(ancestors.count)): \(ancestors.joined(separator: " | "))")
        var taps: [String] = []
        func walk(_ view: UIView) {
            for recognizer in view.gestureRecognizers ?? [] where recognizer.isEnabled && String(describing: type(of: recognizer)).contains("Tap") {
                taps.append("\(type(of: recognizer))@\(type(of: view)) frame:\(view.convert(view.bounds, to: window)) cancels:\(recognizer.cancelsTouchesInView)")
            }
            view.subviews.forEach(walk)
        }
        walk(window)
        log("\(label) tapRecognizersInWindow(\(taps.count)): \(taps.joined(separator: " | "))")
    }
}
