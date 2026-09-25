import XCTest
import UIKit
@testable import Merrymen

final class PackagingTests: XCTestCase {
    func testAllWebLanguagesShipNativeNavigationAndFinancialCopy() {
        for (locale, _) in Language.options {
            XCTAssertNotEqual(Language.ui("Home", locale: locale), locale == "en" ? "__invalid__" : "Home", locale)
            XCTAssertFalse(Language.text("mode.liveNote", locale: locale).isEmpty)
            XCTAssertFalse(Language.text("mode.ack", locale: locale).isEmpty)
        }
        XCTAssertEqual(Language.ui("Withdraw", locale: "es"), "Retirar")
        XCTAssertEqual(Language.text("settings.label.agentName", locale: "es"), Language.text("settings.label.agentName", locale: "en"), "Match the web's incomplete-namespace fallback")
    }
    func testAppActuallyShipsArtworkFontsAndWalletLibrary() throws {
        let bundle = Bundle(for: AppStore.self)
        for name in ["WalletRuntime", "WalletEngine", "FeedEngine", "WalletCryptography"] {
            let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "js"))
            XCTAssertGreaterThan(try Data(contentsOf: url).count, 100)
        }
        XCTAssertNotNil(UIImage(named: "Brand", in: bundle, compatibleWith: nil))
        XCTAssertNotNil(UIImage(named: "TabMark", in: bundle, compatibleWith: nil))
        XCTAssertNotNil(UIFont(name: "DMSans-9ptRegular", size: 16))
        XCTAssertNotNil(UIFont(name: "GeistPixel-Regular", size: 24))
    }
    func testSecureUpdatesPreserveValuesAndCanBeRemoved() throws {
        let service = "dev.merrymen.tests.\(UUID().uuidString)"
        defer { try? SecureStore.remove(service, "test") }
        try SecureStore.write(service, "test", Data("first".utf8))
        try SecureStore.write(service, "test", Data("replacement".utf8))
        XCTAssertEqual(try SecureStore.read(service, "test"), Data("replacement".utf8))
        try SecureStore.remove(service, "test")
        XCTAssertNil(try SecureStore.read(service, "test"))
    }
    func testRecoveryKeySignsOnlyInsideTheLocalCryptoContext() throws {
        let key = "0x" + String(repeating: "01", count: 32)
        let owner = try WalletCryptography.call("address", .object(["key": .string(key)]))
        XCTAssertEqual(owner, "0x1a642f0e3c3af545e7acbd38b07251b3990914f1")
        let signed = try WalletCryptography.call("signMessage", .object(["key": .string(key), "hex": .string("0x68656c6c6f")]))
        XCTAssertEqual(try WalletCryptography.call("recoverAddress", .object(["hex": .string("0x68656c6c6f"), "signature": .string(signed)])), owner)
        XCTAssertNotEqual(try WalletCryptography.call("recoverAddress", .object(["hex": .string("0x68656c6c6f21"), "signature": .string(signed)])), owner)
        XCTAssertThrowsError(try WalletCryptography.call("address", .object(["key": .string("0x" + String(repeating: "0", count: 64))])))
    }
    func testRecoveryBackupCannotSupplyRemoteCapabilitiesOrAnotherNetwork() throws {
        let owner = "0x" + String(repeating: "1", count: 40)
        let account = "0x" + String(repeating: "2", count: 40)
        let data = Data("{\"owner\":\"\(owner)\",\"smartAccount\":\"\(account)\",\"chainId\":4663,\"rpcUrl\":\"https://untrusted.invalid\",\"serialized\":\"untrusted\",\"grantTokens\":[]}".utf8)
        let imported = try RecoveryBackup.read(data)
        XCTAssertNil(imported["rpcUrl"].string); XCTAssertNil(imported["serialized"].string)
        XCTAssertEqual(imported["smartAccount"].text, account)
        XCTAssertThrowsError(try RecoveryBackup.read(Data(String(decoding: data, as: UTF8.self).replacingOccurrences(of: "4663", with: "1").utf8)))
    }
    @MainActor
    func testImportedKeyCannotBeUsedToCreateAPermission() async {
        do {
            _ = try await WalletHost().call("create", input: .object([:]), store: AppStore(), legacyKey: "0x" + String(repeating: "01", count: 32))
            XCTFail("A recovery-only key was accepted for a grant")
        } catch { XCTAssertTrue(error.localizedDescription.contains("only available for recovery")) }
    }
    @MainActor
    func testMalformedPresentationDoesNotPoisonLaterResponses() {
        let presentation = FeedPresentation()
        XCTAssertNil(presentation.markets(.object(["market": .object(["tokens": .number(7)])])))
        XCTAssertEqual(presentation.command(.object(["id": .string("go-paper")]))?["payload"]["liveTradingEnabled"], .bool(false))
    }
    func testLogoutInvalidatesEarlierMutationBeforeTransport() async throws {
        let api = API(); let binding = api.binding()
        XCTAssertTrue(api.matches(binding))
        try api.forget()
        XCTAssertFalse(api.matches(binding))
        do {
            _ = try await api.request("/api/orders", method: "POST", body: .object([:]), expectedSession: binding)
            XCTFail("A request from a signed-out session reached transport")
        } catch let error as APIError { XCTAssertEqual(error.status, 409) }
    }
}
