import SwiftUI
import PhotosUI
import CoreImage.CIFilterBuiltins
import UIKit
import ImageIO

struct AccountScreen: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var tour: TourProgress
    @State private var signOut = false
    var body: some View {
        Page {
            if let error = store.sessionError { Text(error).foregroundStyle(.orange); Button("Retry session") { Task { await store.refreshSession() } } }
            if let owner = store.owner {
                Card(hero: true) {
                    HStack(spacing: 8) { Image(systemName: "checkmark.seal.fill").foregroundStyle(Brand.accent).accessibilityHidden(true); Text("Signed in").font(.headline) }
                    Text(owner).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }.tourAnchor("profile-top")
                Remote(path: "/api/grants") { status in
                    ResignNotice(status: status)
                    if status["exists"].bool == true {
                        Card {
                            HStack { Text("Your Merryman").font(.title2.bold()); Spacer(); Pill(text: status["mode"].string ?? "Unknown", tint: status["mode"].string == "paper" ? .orange : Brand.accent) }
                            if let blocker = status["liveBlocker"].string { Label(blocker.replacingOccurrences(of: "-", with: " "), systemImage: "exclamationmark.circle").foregroundStyle(.orange) }
                            HStack(spacing: 12) {
                                NavigationLink("Add funds", value: Route.deposit).buttonStyle(PrimaryButtonStyle(fill: true))
                                NavigationLink("Withdraw", value: Route.withdraw).buttonStyle(SecondaryButtonStyle(fill: true))
                            }
                            MenuRow(title: "Wallet & permissions", systemImage: "key.horizontal", route: .permissions)
                            MenuRow(title: "Trading limits", systemImage: "gauge.with.dots.needle.33percent", route: .limits)
                        }
                        DailyUsage(grant: status["grant"])
                        Remote(path: "/api/feed") { feed in
                            if let slug = feed["agent"]["slug"].string { MenuRow(title: "View public profile", systemImage: "person.crop.square", route: .agent(slug)); ProfileImages(slug: slug) }
                        }
                    } else {
                        Card(hero: true) { Text("Meet your next agent.").font(.title2.bold()); NavigationLink("Create agent", value: Route.create).buttonStyle(PrimaryButtonStyle(fill: true)) }
                        MenuRow(title: "Recover an existing account", systemImage: "arrow.counterclockwise", route: .withdraw)
                    }
                }
                Card {
                    MenuRow(title: "Settings", systemImage: "gearshape", route: .settings)
                    MenuRow(title: "Verify your X profile", systemImage: "checkmark.seal", route: .xProof)
                    MenuRow(title: "Connected AI apps", systemImage: "sparkles.rectangle.stack", route: .connectedApps)
                    MenuRow(title: "Telegram", systemImage: "paperplane", route: .telegram)
                    MenuRow(title: "The Merry Circle", systemImage: "circle.hexagongrid", route: .circle)
                }
            } else { SignInCard().tourAnchor("profile-top") }
            Card {
                if store.owner == nil { MenuRow(title: "Recover an existing account", systemImage: "arrow.counterclockwise", route: .withdraw) }
                MenuRow(title: "Replay tour", systemImage: "play.circle") { tour.begin(store, replay: true) }
            }
            LanguagePicker()
            if store.owner != nil { Button("Sign out", role: .destructive) { signOut = true }.buttonStyle(SecondaryButtonStyle(fill: true)) }
            Text("merrymen · native iOS preview").font(.custom(Brand.pixel, size: 12, relativeTo: .caption)).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        }.confirmationDialog("Sign out of Merrymen?", isPresented: $signOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await store.signOut() } }
        } message: { Text("Signing out does not stop an active agent. Use Wallet & permissions to stand it down.") }
    }
}

struct ProfileImages: View {
    @EnvironmentObject var store: AppStore
    let slug: String
    @State private var item: PhotosPickerItem?
    @State private var kind = "avatar"
    @State private var busy = false
    var body: some View {
        Card {
            Text("Profile images").font(.headline)
            Picker("Image", selection: $kind) { Text("Avatar").tag("avatar"); Text("Banner").tag("banner") }.pickerStyle(.segmented)
            AsyncImage(url: URL(string: "https://app.merrymen.dev/api/agent-image/\(escaped(slug))/\(kind)?v=\(store.imageRevision.uuidString)")) { image in image.resizable().scaledToFit().frame(maxHeight: 140) } placeholder: { Image(systemName: "photo").font(.largeTitle).foregroundStyle(.secondary) }
            PhotosPicker(selection: $item, matching: .images) { Label("Choose photo", systemImage: "photo") }.disabled(busy)
            if busy { ProgressView("Uploading…") }
            Button("Remove \(kind)", role: .destructive) {
                busy = true; let target = kind; let owner = store.owner
                Task { defer { busy = false }; do {
                    _ = try await store.perform("/api/agent-image/me/\(target)", method: "DELETE", body: .object([:]), expectedOwner: owner)
                    store.imageRevision = UUID(); store.notice = "\(target.capitalized) removed."
                } catch { store.notice = error.localizedDescription } }
            }.disabled(busy)
        }.onChange(of: item) { _, photo in
            guard let photo else { return }; busy = true; let target = kind; let owner = store.owner
            Task { defer { busy = false; item = nil }; do {
                guard let data = try await photo.loadTransferable(type: Data.self), data.count <= 10 * 1024 * 1024,
                      let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: target == "avatar" ? 1600 : 3200] as CFDictionary),
                      let jpeg = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.85), jpeg.count <= (target == "avatar" ? 5 : 8) * 1024 * 1024 else {
                    throw APIError(status: 0, message: "Choose a supported image smaller than 10 MB.")
                }
                let session = store.api.binding()
                try await store.verifyOwner(owner)
                _ = try await store.api.bytes("/api/agent-image/me/\(target)", method: "PUT", data: jpeg, contentType: "image/jpeg", expectedSession: session)
                guard owner == store.owner else { return }
                store.imageRevision = UUID(); store.notice = "\(target.capitalized) updated."
            } catch { store.notice = error.localizedDescription } }
        }
    }
}

struct DepositScreen: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else {
                Remote(path: "/api/grants") { status in
                    if status["exists"].bool == true, status["grant"]["chainId"].number == 4663, let address = status["grant"]["smartAccount"].string {
                        Card {
                            Text("Add funds").font(.largeTitle.bold())
                            Text("Send USDG to this agent account on Robinhood Chain. Confirm the network in your sending wallet.")
                            if let qr = qrImage(address) { Image(uiImage: qr).interpolation(.none).resizable().scaledToFit().frame(maxWidth: 230).padding(12).background(.white).accessibilityLabel("Agent account QR code") }
                            Text(address).font(.callout.monospaced()).textSelection(.enabled)
                            HStack { Button("Copy address") { UIPasteboard.general.string = address }; ShareLink(item: address) }
                            Metric(label: "USDG balance", value: rawUnits(status["balances"]["cashUsdg"].string, decimals: 6))
                            Metric(label: "Gas sponsorship", value: status["gasSponsored"].bool.map { $0 ? "Trading gas covered" : "Not covered" } ?? "Unknown")
                        }
                    } else if status["exists"].bool == true { Text("This account uses another network. Its deposit address is not supported by this native build.").foregroundStyle(.orange) }
                    else { Text("Create your agent before sending funds."); NavigationLink("Create agent", value: Route.create) }
                }
            }
        }.navigationTitle("Add funds")
    }
    private func qrImage(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(text.utf8)
        guard let output = filter.outputImage, let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

func rawUnits(_ raw: String?, decimals: Int) -> String {
    guard let raw, let value = Decimal(string: raw, locale: Locale(identifier: "en_US_POSIX")) else { return "—" }
    var divisor = Decimal(1); for _ in 0..<decimals { divisor *= 10 }
    return NSDecimalNumber(decimal: value / divisor).stringValue
}

struct PermissionsScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var stop = false
    @State private var resetPaper = false
    @State private var busy = false
    @State private var revision = 0
    var body: some View {
        Page {
            if store.owner == nil { SignInCard() } else {
                Remote(path: "/api/grants") { status in
                    if status["exists"].bool == true {
                        Card {
                            Text(status["mode"].string?.capitalized ?? "Mode unknown").font(.title2.bold())
                            Text(status["grant"]["smartAccount"].text).font(.caption.monospaced()).textSelection(.enabled)
                            Metric(label: "Per trade", value: usd(status["grant"]["caps"]["perTradeUsdg"].number))
                            Metric(label: "Per day", value: usd(status["grant"]["caps"]["dailyUsdg"].number))
                            Metric(label: "Max drawdown", value: status["grant"]["caps"]["maxDrawdownPct"].text + "%")
                            Metric(label: "Operations per day", value: status["grant"]["caps"]["maxOpsPerDay"].text)
                            Metric(label: "USDG", value: rawUnits(status["balances"]["cashUsdg"].string, decimals: 6))
                            Metric(label: "ETH for gas", value: rawUnits(status["balances"]["ethWei"].string, decimals: 18))
                            if let heartbeat = status["workerAliveAt"].number { HStack { Text("Last heartbeat"); Text(Date(timeIntervalSince1970: heartbeat), style: .relative) }.font(.caption).foregroundStyle(.secondary) }
                            if let blocker = status["liveBlocker"].string { Text("Live trading: " + blocker.replacingOccurrences(of: "-", with: " ")).font(.caption).foregroundStyle(.orange) }
                            NavigationLink("Edit signed limits", value: Route.limits)
                            NavigationLink("Add funds", value: Route.deposit)
                            NavigationLink("Withdraw", value: Route.withdraw)
                        }
                        if status["mode"].string == "paper" {
                            Button("Restart paper book") { resetPaper = true }.buttonStyle(SecondaryButtonStyle(fill: true)).disabled(busy)
                            Text("Paper cash goes back to the starting stake and simulated positions are cleared. Earlier paper trades stay on file but no longer count.").font(.caption).foregroundStyle(.secondary)
                        }
                        Button("Stand down agent", role: .destructive) { stop = true }.disabled(busy)
                        Text("Stand-down removes the service's active grant. It does not withdraw assets or invalidate the existing permission on-chain.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        InactiveWalletPanel(status: status) { revision += 1 }
                        Text("No active trading permission."); NavigationLink("Create agent", value: Route.create)
                    }
                }.id(revision)
            }
        }.navigationTitle("Wallet & permissions")
        .confirmationDialog("Stand down your agent?", isPresented: $stop, titleVisibility: .visible) {
            Button("Stand down", role: .destructive) {
                guard !busy else { return }; busy = true; let owner = store.owner
                Task { defer { busy = false }; do {
                    _ = try await store.perform("/api/grants", method: "DELETE", body: .object([:]), expectedOwner: owner)
                    revision += 1; store.notice = "Stand-down request accepted. Existing assets remain in the smart account."
                } catch { store.notice = error.localizedDescription } }
            }
        } message: { Text("The agent will stop managing positions. This does not sell them or revoke permissions on-chain.") }
        // The worker refuses this on the live rail, so it can only ever touch
        // the paper book; the button is also shown only for paper agents.
        .confirmationDialog("Restart the paper book?", isPresented: $resetPaper, titleVisibility: .visible) {
            Button("Restart paper book", role: .destructive) {
                guard !busy else { return }; busy = true; let owner = store.owner
                Task { defer { busy = false }; do {
                    _ = try await store.perform("/api/paper-reset", body: .object([:]), expectedOwner: owner)
                    revision += 1; store.notice = "Paper reset queued. Your agent applies it on its next cycle."
                } catch { store.notice = error.localizedDescription } }
            }
        } message: { Text("Cash returns to the starting stake and simulated positions are cleared. If your agent is trading real money, nothing is changed.") }
    }
}
