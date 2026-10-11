import UIKit
import XCTest
@testable import InventoryApp

@MainActor
final class ItemPhotoViewModelTests: XCTestCase {
    /// A real 4x4 image, so encoding and decoding exercise actual image code
    /// rather than a hand-rolled byte blob.
    private func sampleImage(
        size: CGSize = CGSize(width: 4, height: 4),
        color: UIColor = .systemTeal
    ) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { context in
            color.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }

    func testLoadSkipsTheRequestWhenTheItemHasNoPhoto() async {
        let item = Item.fixture(photoUpdatedAt: nil)
        let service = StubInventoryService(items: [item])
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)

        await viewModel.load(hasPhoto: item.hasPhoto)

        XCTAssertNil(viewModel.image)
        XCTAssertTrue(service.calls.isEmpty, "no photo means no request")
    }

    func testLoadFetchesAndDecodesTheStoredPhoto() async {
        let item = Item.fixture(photoUpdatedAt: Date(timeIntervalSince1970: 120))
        let service = StubInventoryService(items: [item])
        let jpeg = sampleImage().jpegData(compressionQuality: 1)
        XCTAssertNotNil(jpeg)
        service.seedPhoto(jpeg ?? Data(), for: item.id)
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)

        await viewModel.load(hasPhoto: item.hasPhoto)

        XCTAssertNotNil(viewModel.image, "the fetched bytes were decoded")
        XCTAssertEqual(service.calls, [.photo(item.id)])
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)
    }

    func testLoadDoesNotRefetchAnAlreadyLoadedPhoto() async {
        let item = Item.fixture(photoUpdatedAt: Date(timeIntervalSince1970: 120))
        let service = StubInventoryService(items: [item])
        service.seedPhoto(sampleImage().jpegData(compressionQuality: 1) ?? Data(), for: item.id)
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)

        await viewModel.load(hasPhoto: true)
        await viewModel.load(hasPhoto: true)

        XCTAssertEqual(service.calls.count, 1, "the second call was a no-op")
    }

    func testUploadSendsJPEGBytesAndReturnsTheRefreshedItem() async {
        let item = Item.fixture(photoUpdatedAt: nil)
        let service = StubInventoryService(items: [item])
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)

        let refreshed = await viewModel.upload(sampleImage())

        XCTAssertNotNil(viewModel.image, "the new photo is shown immediately")
        XCTAssertEqual(
            refreshed?.photoUpdatedAt,
            Date(timeIntervalSince1970: 120),
            "the item comes back carrying the server's photo timestamp"
        )
        XCTAssertEqual(refreshed?.hasPhoto, true)

        // The bytes actually reached the service, and they are a real JPEG.
        let stored = service.storedPhoto(for: item.id)
        XCTAssertNotNil(stored)
        XCTAssertEqual(
            Array((stored ?? Data()).prefix(3)),
            [0xFF, 0xD8, 0xFF],
            "the upload carries JPEG magic bytes, which is what the API sniffs for"
        )

        guard case let .uploadPhoto(id, byteCount) = service.calls.first else {
            return XCTFail("expected an uploadPhoto call, got \(service.calls)")
        }
        XCTAssertEqual(id, item.id)
        XCTAssertGreaterThan(byteCount, 0)
    }

    func testUploadDownscalesALargeCapture() async {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item])
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)

        // Larger on its longest side than the 2048 px cap.
        let large = sampleImage(size: CGSize(width: 4000, height: 3000))
        _ = await viewModel.upload(large)

        let stored = service.storedPhoto(for: item.id)
        XCTAssertNotNil(stored)
        let decoded = UIImage(data: stored ?? Data())
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.size.width, 2048, "scaled to the cap")
        XCTAssertEqual(decoded?.size.height, 1536, "aspect ratio preserved")
    }

    func testUploadReportsAServerRejectionAndKeepsNoImage() async {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item])
        service.setFailure(
            .api(
                status: 413,
                code: "photo_too_large",
                message: "The photo exceeds the maximum size of 10 MB."
            )
        )
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)

        let refreshed = await viewModel.upload(sampleImage())

        XCTAssertNil(refreshed)
        XCTAssertNil(viewModel.image, "a refused upload must not look like it worked")
        XCTAssertEqual(
            viewModel.errorMessage,
            "The photo exceeds the maximum size of 10 MB."
        )
        XCTAssertFalse(viewModel.isUploading)
    }

    func testDeleteClearsTheImageAndReturnsTheRefreshedItem() async {
        let item = Item.fixture(photoUpdatedAt: Date(timeIntervalSince1970: 120))
        let service = StubInventoryService(items: [item])
        service.seedPhoto(sampleImage().jpegData(compressionQuality: 1) ?? Data(), for: item.id)
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)
        await viewModel.load(hasPhoto: true)
        XCTAssertNotNil(viewModel.image)

        let refreshed = await viewModel.delete()

        XCTAssertNil(viewModel.image)
        XCTAssertEqual(refreshed?.photoUpdatedAt, nil)
        XCTAssertEqual(refreshed?.hasPhoto, false)
        XCTAssertNil(service.storedPhoto(for: item.id))
        XCTAssertEqual(
            service.calls,
            [.photo(item.id), .deletePhoto(item.id), .get(item.id)],
            "the photo is fetched, deleted, then the item re-read for its new state"
        )
    }

    func testLoadReportsATransportFailure() async {
        let item = Item.fixture(photoUpdatedAt: Date(timeIntervalSince1970: 120))
        let service = StubInventoryService(items: [item], failure: .transport(message: "offline"))
        let viewModel = ItemPhotoViewModel(itemId: item.id, service: service)

        await viewModel.load(hasPhoto: true)

        XCTAssertNil(viewModel.image)
        XCTAssertEqual(
            viewModel.errorMessage,
            "Can't reach the server. Check your connection and try again."
        )
    }
}

final class ImageEncodingTests: XCTestCase {
    func testEncodingProducesJPEGBytes() {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
        }

        let data = image.inventoryJPEGData()

        XCTAssertNotNil(data)
        XCTAssertEqual(Array((data ?? Data()).prefix(3)), [0xFF, 0xD8, 0xFF])
    }

    func testASmallImageIsNotUpscaled() {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 50)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 100, height: 50))
        }

        let data = image.inventoryJPEGData()
        let decoded = UIImage(data: data ?? Data())

        XCTAssertEqual(decoded?.size.width, 100)
        XCTAssertEqual(decoded?.size.height, 50)
    }
}
