import SwiftUI

@main
struct MerrymenApp: App {
    @StateObject private var store = AppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            NativeShell()
                .environmentObject(store)
                .font(.custom("DMSans-9ptRegular", size: 16, relativeTo: .body))
                .preferredColorScheme(.dark)
                .tint(Color(red: 0.65, green: 0.81, blue: 0.12))
                .onOpenURL { store.open($0) }
                .overlay {
                    if scenePhase != .active {
                        ZStack {
                            Color(red: 7/255, green: 8/255, blue: 6/255).ignoresSafeArea()
                            Image("Brand").resizable().scaledToFit().frame(width: 88, height: 88)
                        }
                        .accessibilityLabel("Merrymen")
                        .allowsHitTesting(false)
                    }
                }
        }
    }
}
