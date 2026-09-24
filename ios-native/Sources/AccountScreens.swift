import SwiftUI
import PhotosUI
import CoreImage.CIFilterBuiltins
import UIKit
import ImageIO

struct AccountScreen: View {
    @EnvironmentObject var store: AppStore
    @State private var signOut = false
    var body: some View {
        Page {
            LanguagePicker()
            if let error = store.sessionError { Text(error).foregroundStyle(.orange); Button("Retry session") { Task { await store.refreshSession() } } }
            if let owner = store.owner {
                Card { Text("Signed in").font(.headline); Text(owner).font(.caption.monospaced()).textSelection(.enabled) }
                Remote(path: "/api/grants") { status in
                    if status["exists"].bool == true {
                        Card {
                            Text("Your Merryman").font(.title2.bold())
                            Metric(label: "Mode", value: status["mode"].string ?? "Unknown")
                            if let blocker = status["liveBlocker"].string { Label(blocker.replacingOccurrences(of: "-", with: " "), systemImage: "exclamationmark.circle") }
                            NavigationLink("Wallet & permissions", value: Route.permissions)
                            HStack { NavigationLink("Add funds", value: Route.deposit); Spacer(); NavigationLink("Withdraw", value: Route.withdraw) }
                            NavigationLink("Trading limits", value: Route.limits)
                        }
                        Remote(path: "/api/feed") { feed in
                            if let slug = feed["agent"]["slug"].string { NavigationLink("View public profile", value: Route.agent(slug)); ProfileImages(slug: slug) }
                        }
                    } else {
                        Card { Text("Meet your next agent.").font(.title2.bold()); NavigationLink("Create agent", value: Route.create) }
                        NavigationLink("Recover an existing account", value: Route.withdraw)
                    }
                }
                NavigationLink("Settings", value: Route.settings)
                NavigationLink("Verify your X profile", value: Route.xProof)
                NavigationLink("Telegram", value: Route.telegram)
                NavigationLink("The Merry Circle", value: Route.circle)
                Button("Sign out", role: .destructive) { signOut = true }
            } else { SignInCard() }
            NavigationLink("Site access", value: Route.siteAccess)
            NavigationLink("Replay tour", value: Route.tour)
            Text("merrymen · native iOS preview").font(.caption).foregroundStyle(.secondary)
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
                            NavigationLink("Edit signed limits", value: Route.limits)
                            NavigationLink("Add funds", value: Route.deposit)
                            NavigationLink("Withdraw", value: Route.withdraw)
                        }
                        Button("Stand down agent", role: .destructive) { stop = true }.disabled(busy)
                        Text("Stand-down removes the service's active grant. It does not withdraw assets or invalidate the existing permission on-chain.").font(.caption).foregroundStyle(.secondary)
                    } else { Text("No active trading permission."); NavigationLink("Create agent", value: Route.create) }
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
    }
}
