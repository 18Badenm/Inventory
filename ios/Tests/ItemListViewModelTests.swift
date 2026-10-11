import UIKit
import XCTest
@testable import InventoryApp

@MainActor
final class ItemListViewModelTests: XCTestCase {
    func testLoadPopulatesItemsAndTotal() async {
        let service = StubInventoryService(items: [
            .fixture(sku: "A-1", name: "Anvil"),
            .fixture(sku: "B-1", name: "Bolt"),
        ])
        let viewModel = ItemListViewModel(service: service, pageSize: 50)

        await viewModel.load()

        XCTAssertEqual(viewModel.items.map(\.sku), ["A-1", "B-1"])
        XCTAssertEqual(viewModel.total, 2)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertEqual(
            service.calls,
            [.list(limit: 50, offset: 0, search: nil)],
            "load must request the first page with no filter"
        )
    }

    func testLoadPassesTrimmedSearchTermAndSkipsBlankOne() async {
        let service = StubInventoryService(items: [.fixture(sku: "A-1", name: "Anvil")])
        let viewModel = ItemListViewModel(service: service, pageSize: 10)

        viewModel.searchText = "  anvil  "
        await viewModel.load()

        viewModel.searchText = "   "
        await viewModel.load()

        XCTAssertEqual(
            service.calls,
            [
                .list(limit: 10, offset: 0, search: "anvil"),
                .list(limit: 10, offset: 0, search: nil),
            ]
        )
    }

    func testLoadMoreAppendsNextPageWithoutDuplicating() async {
        let items = (1...5).map { Item.fixture(sku: "S-\($0)", name: "Item \($0)") }
        let service = StubInventoryService(items: items)
        let viewModel = ItemListViewModel(service: service, pageSize: 2)

        await viewModel.load()
        XCTAssertEqual(viewModel.items.count, 2)
        XCTAssertTrue(viewModel.hasMore)

        await viewModel.loadMore()
        XCTAssertEqual(viewModel.items.map(\.sku), ["S-1", "S-2", "S-3", "S-4"])

        await viewModel.loadMore()
        XCTAssertEqual(viewModel.items.count, 5)
        XCTAssertFalse(viewModel.hasMore)
        XCTAssertEqual(Set(viewModel.items.map(\.id)).count, 5, "no row appears twice")

        XCTAssertEqual(
            service.calls,
            [
                .list(limit: 2, offset: 0, search: nil),
                .list(limit: 2, offset: 2, search: nil),
                .list(limit: 2, offset: 4, search: nil),
            ],
            "each page is requested at the offset of what is already held"
        )
    }

    func testLoadMoreDoesNothingWhenEverythingIsLoaded() async {
        let service = StubInventoryService(items: [.fixture()])
        let viewModel = ItemListViewModel(service: service, pageSize: 50)

        await viewModel.load()
        await viewModel.loadMore()

        XCTAssertEqual(service.calls.count, 1, "no redundant request was issued")
    }

    func testAdjustReplacesTheRowWithTheServerCopy() async {
        let item = Item.fixture(sku: "ADJ-1", quantity: 5)
        let service = StubInventoryService(items: [item])
        let viewModel = ItemListViewModel(service: service, pageSize: 50)
        await viewModel.load()

        await viewModel.adjust(item: item, by: -2)

        XCTAssertEqual(viewModel.items.count, 1)
        XCTAssertEqual(viewModel.items[0].quantity, 3)
        XCTAssertEqual(viewModel.items[0].id, item.id)
        XCTAssertEqual(service.calls.last, .adjust(id: item.id, delta: -2))
        XCTAssertNil(viewModel.errorMessage)
    }

    func testRejectedAdjustmentSurfacesServerMessageAndLeavesQuantityUnchanged() async {
        let item = Item.fixture(sku: "ADJ-2", quantity: 2)
        let service = StubInventoryService(items: [item])
        let viewModel = ItemListViewModel(service: service, pageSize: 50)
        await viewModel.load()

        await viewModel.adjust(item: item, by: -5)

        XCTAssertEqual(
            viewModel.items[0].quantity,
            2,
            "a refused adjustment must not move the displayed count"
        )
        XCTAssertEqual(
            viewModel.errorMessage,
            "Cannot remove 5 unit(s): only 2 in stock."
        )
    }

    func testDeleteRemovesTheRowAndDecrementsTotal() async {
        let first = Item.fixture(sku: "D-1")
        let second = Item.fixture(sku: "D-2")
        let service = StubInventoryService(items: [first, second])
        let viewModel = ItemListViewModel(service: service, pageSize: 50)
        await viewModel.load()

        await viewModel.delete(item: first)

        XCTAssertEqual(viewModel.items.map(\.sku), ["D-2"])
        XCTAssertEqual(viewModel.total, 1)
        XCTAssertEqual(service.calls.last, .delete(first.id))
    }

    func testFailedLoadKeepsExistingItemsOnScreen() async {
        let service = StubInventoryService(items: [.fixture(sku: "KEEP-1")])
        let viewModel = ItemListViewModel(service: service, pageSize: 50)
        await viewModel.load()

        service.setFailure(.transport(message: "offline"))
        await viewModel.load()

        XCTAssertEqual(
            viewModel.items.map(\.sku),
            ["KEEP-1"],
            "a failed refresh must not blank the list"
        )
        XCTAssertEqual(
            viewModel.errorMessage,
            "Can't reach the server. Check your connection and try again."
        )
    }

    func testInsertPutsNewItemAtTheHeadAndBumpsTotal() async {
        let service = StubInventoryService(items: [.fixture(sku: "OLD-1")])
        let viewModel = ItemListViewModel(service: service, pageSize: 50)
        await viewModel.load()

        viewModel.insert(.fixture(sku: "NEW-1"))

        XCTAssertEqual(viewModel.items.map(\.sku), ["NEW-1", "OLD-1"])
        XCTAssertEqual(viewModel.total, 2)
    }
}

@MainActor
final class AddItemViewModelTests: XCTestCase {
    func testSaveSendsNormalisedValues() async {
        let service = StubInventoryService()
        let viewModel = AddItemViewModel(service: service)
        viewModel.sku = "  wd-40 "
        viewModel.name = "  Lubricant  "
        viewModel.quantityText = "7"

        XCTAssertTrue(viewModel.canSave)
        let created = await viewModel.save()

        XCTAssertEqual(created?.sku, "WD-40")
        XCTAssertEqual(
            service.calls,
            [.create(sku: "WD-40", name: "Lubricant", quantity: 7)]
        )
    }

    func testValidationBlocksSaveAndIssuesNoRequest() async {
        let service = StubInventoryService()
        let viewModel = AddItemViewModel(service: service)

        viewModel.sku = "bad sku!"
        viewModel.name = "Thing"
        XCTAssertFalse(viewModel.skuIsValid)
        XCTAssertFalse(viewModel.canSave)

        viewModel.sku = "OK-1"
        viewModel.name = "   "
        XCTAssertFalse(viewModel.nameIsValid)
        XCTAssertFalse(viewModel.canSave)

        viewModel.name = "Thing"
        viewModel.quantityText = "-3"
        XCTAssertNil(viewModel.quantity)
        XCTAssertFalse(viewModel.canSave)

        viewModel.quantityText = "2.5"
        XCTAssertNil(viewModel.quantity)
        XCTAssertFalse(viewModel.canSave)

        viewModel.quantityText = "4"
        XCTAssertTrue(viewModel.canSave)

        XCTAssertTrue(service.calls.isEmpty, "invalid input never reached the network")
    }

    func testDuplicateSKUReportsTheServerMessage() async {
        let service = StubInventoryService()
        service.setFailure(
            .api(
                status: 409,
                code: "sku_already_exists",
                message: "An item with SKU \"DUP-1\" already exists."
            )
        )
        let viewModel = AddItemViewModel(service: service)
        viewModel.sku = "DUP-1"
        viewModel.name = "Second"

        let created = await viewModel.save()

        XCTAssertNil(created)
        XCTAssertEqual(
            viewModel.errorMessage,
            "An item with SKU \"DUP-1\" already exists."
        )
        XCTAssertFalse(viewModel.isSaving)
    }
}

final class APIErrorTests: XCTestCase {
    func testOnlyServerFailuresAndTransportErrorsAreRetryable() {
        XCTAssertTrue(APIError.transport(message: "x").isRetryable)
        XCTAssertTrue(APIError.api(status: 503, code: "x", message: "x").isRetryable)
        XCTAssertFalse(APIError.api(status: 409, code: "x", message: "x").isRetryable)
        XCTAssertFalse(APIError.decoding(message: "x").isRetryable)
        XCTAssertFalse(APIError.invalidURL("x").isRetryable)
    }

    func testTransportAndDecodingDetailsAreNotShownToTheUser() {
        let transport = APIError.transport(message: "NSURLErrorDomain -1009 at 10.0.0.1")
        let decoding = APIError.decoding(message: "keyNotFound(CodingKeys(stringValue: \"sku\"))")

        XCTAssertEqual(
            transport.errorDescription,
            "Can't reach the server. Check your connection and try again."
        )
        XCTAssertEqual(
            decoding.errorDescription,
            "The server sent a response the app didn't understand."
        )
    }
}

@MainActor
final class ListCaptureTests: XCTestCase {
    private func sampleImage(
        size: CGSize = CGSize(width: 8, height: 8)
    ) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemIndigo.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }

    private let fixedDate = Date(timeIntervalSince1970: 1_760_000_000)

    func testGeneratedSKUMatchesWhatTheAPIAccepts() {
        let sku = ItemListViewModel.generatedSKU(at: fixedDate)

        XCTAssertTrue(sku.hasPrefix("PHOTO-"))
        XCTAssertLessThanOrEqual(sku.count, 64)
        XCTAssertTrue(
            sku.allSatisfy { $0.isASCII && ($0.isNumber || ("A"..."Z").contains($0) || $0 == "-") },
            "the API rejects anything but A-Z, 0-9 and dashes; got \(sku)"
        )
    }

    func testTwoCapturesInTheSameSecondGetDistinctSKUs() {
        let first = ItemListViewModel.generatedSKU(at: fixedDate)
        let second = ItemListViewModel.generatedSKU(at: fixedDate)

        XCTAssertNotEqual(
            first,
            second,
            "the SKU is unique server-side, so identical timestamps must not collide"
        )
    }

    func testCaptureCreatesAnItemUploadsThePhotoAndShowsItFirst() async {
        let existing = Item.fixture(sku: "OLD-1")
        let service = StubInventoryService(items: [existing])
        let viewModel = ItemListViewModel(
            service: service,
            authorizer: StubCameraAuthorizer(.granted),
            clock: { self.fixedDate }
        )
        await viewModel.load()

        await viewModel.createFromPhoto(sampleImage())

        XCTAssertEqual(viewModel.items.count, 2)
        XCTAssertTrue(
            viewModel.items[0].sku.hasPrefix("PHOTO-"),
            "the new capture is at the top of the list"
        )
        XCTAssertEqual(
            viewModel.items[0].hasPhoto,
            true,
            "the row reflects that the photo was stored"
        )
        XCTAssertEqual(viewModel.items[1].sku, "OLD-1")
        XCTAssertEqual(viewModel.total, 2)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isCapturing)

        // The photo actually reached the service, as real JPEG bytes.
        let newId = viewModel.items[0].id
        let stored = service.storedPhoto(for: newId)
        XCTAssertNotNil(stored)
        XCTAssertEqual(Array((stored ?? Data()).prefix(3)), [0xFF, 0xD8, 0xFF])

        // Create, then upload, then re-read for the photo timestamp.
        let kinds = service.calls.map { call -> String in
            switch call {
            case .list: return "list"
            case .create: return "create"
            case .uploadPhoto: return "upload"
            case .get: return "get"
            default: return "other"
            }
        }
        XCTAssertEqual(kinds, ["list", "create", "upload", "get"])
    }

    func testCaptureKeepsTheItemWhenOnlyTheUploadFails() async {
        let service = FailUploadStub()
        let viewModel = ItemListViewModel(
            service: service,
            authorizer: StubCameraAuthorizer(.granted),
            clock: { self.fixedDate }
        )

        await viewModel.createFromPhoto(sampleImage())

        XCTAssertEqual(
            viewModel.items.count,
            1,
            "the created item is kept so the work is not silently lost"
        )
        XCTAssertEqual(viewModel.items[0].hasPhoto, false)
        XCTAssertEqual(
            viewModel.errorMessage,
            "The photo exceeds the maximum size of 10 MB.",
            "the upload failure is reported rather than swallowed"
        )
    }

    func testDeniedCameraOpensNoPickerAndCreatesNothing() async {
        let service = StubInventoryService()
        let viewModel = ItemListViewModel(
            service: service,
            authorizer: StubCameraAuthorizer(.denied)
        )

        await viewModel.beginCapture()

        XCTAssertNil(viewModel.captureSource)
        XCTAssertTrue(viewModel.needsCameraSettings)
        XCTAssertTrue(service.calls.isEmpty)
    }

    func testMissingCameraFallsBackToTheLibrary() async {
        let viewModel = ItemListViewModel(
            service: StubInventoryService(),
            authorizer: StubCameraAuthorizer(.unavailable)
        )

        await viewModel.beginCapture()

        XCTAssertEqual(viewModel.captureSource, .photoLibrary)
        XCTAssertFalse(viewModel.needsCameraSettings)
    }
}

/// Creates items successfully but always refuses the photo, to prove the item
/// survives an upload failure.
final class FailUploadStub: InventoryService, @unchecked Sendable {
    private let inner = StubInventoryService()

    func listItems(limit: Int, offset: Int, search: String?) async throws -> Page<Item> {
        try await inner.listItems(limit: limit, offset: offset, search: search)
    }

    func item(id: UUID) async throws -> Item {
        try await inner.item(id: id)
    }

    func createItem(sku: String, name: String, quantity: Int) async throws -> Item {
        try await inner.createItem(sku: sku, name: name, quantity: quantity)
    }

    func updateItem(id: UUID, name: String?, quantity: Int?) async throws -> Item {
        try await inner.updateItem(id: id, name: name, quantity: quantity)
    }

    func adjustStock(id: UUID, delta: Int) async throws -> Item {
        try await inner.adjustStock(id: id, delta: delta)
    }

    func deleteItem(id: UUID) async throws {
        try await inner.deleteItem(id: id)
    }

    func uploadPhoto(id: UUID, jpeg: Data) async throws -> PhotoMetadata {
        throw APIError.api(
            status: 413,
            code: "photo_too_large",
            message: "The photo exceeds the maximum size of 10 MB."
        )
    }

    func photo(id: UUID) async throws -> Data {
        try await inner.photo(id: id)
    }

    func deletePhoto(id: UUID) async throws {
        try await inner.deletePhoto(id: id)
    }

    func valuate(id: UUID) async throws -> Valuation {
        try await inner.valuate(id: id)
    }
}
