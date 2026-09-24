import XCTest
import UIKit
@testable import Merrymen

final class PackagingTests: XCTestCase {
    func testAppActuallyShipsArtworkFontsAndWalletLibrary() throws {
        let bundle = Bundle(for: AppStore.self)
        for name in ["WalletRuntime", "WalletEngine"] {
            let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "js"))
            XCTAssertGreaterThan(try Data(contentsOf: url).count, 100)
        }
        XCTAssertNotNil(UIImage(named: "Brand", in: bundle, compatibleWith: nil))
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
}
