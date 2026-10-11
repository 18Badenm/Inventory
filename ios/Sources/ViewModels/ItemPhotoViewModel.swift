import Foundation
import UIKit

/// Raised when a captured image cannot be turned into uploadable bytes. Kept
/// distinct from `APIError` because nothing was sent.
enum PhotoError: Error, LocalizedError, Equatable {
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .encodingFailed:
            return "That photo couldn't be prepared for upload. Try taking it again."
        }
    }
}

/// Owns one item's photo: fetching it for display, replacing it with a new
/// capture, and removing it.
///
/// Upload and delete return the *refreshed item* so the caller can propagate
/// the new `photoUpdatedAt` to the list without guessing at it — the server
/// decides when the photo changed, not the client.
@MainActor
final class ItemPhotoViewModel: ObservableObject {
    @Published private(set) var image: UIImage?
    @Published private(set) var isLoading = false
    @Published private(set) var isUploading = false
    @Published var errorMessage: String?
    /// Non-nil once access is resolved and a picker should be presented.
    @Published var captureSource: CaptureSource?
    /// True when access can only be restored from the Settings app.
    @Published var needsCameraSettings = false

    private let itemId: UUID
    private let service: InventoryService
    private let authorizer: CameraAuthorizing

    init(
        itemId: UUID,
        service: InventoryService,
        authorizer: CameraAuthorizing = SystemCameraAuthorizer()
    ) {
        self.itemId = itemId
        self.service = service
        self.authorizer = authorizer
    }

    /// Resolves camera access and decides what to present.
    ///
    /// Asking before presenting is the whole point: `UIImagePickerController`
    /// shows a black screen rather than an error when access is denied, so a
    /// user who once tapped "Don't Allow" would otherwise see a camera that
    /// silently does not work.
    func beginCapture() async {
        switch await authorizer.requestAccess() {
        case .granted:
            captureSource = .camera
        case .unavailable:
            // No camera hardware (the simulator); the library is the only way
            // to get an image, and the UI says as much.
            captureSource = .photoLibrary
        case .denied:
            needsCameraSettings = true
        }
    }

    var isBusy: Bool { isLoading || isUploading }

    /// Fetches the photo for display. Does nothing when the item has none, so
    /// the common case costs no request.
    func load(hasPhoto: Bool) async {
        guard hasPhoto, image == nil, !isLoading else { return }

        isLoading = true
        defer { isLoading = false }

        do {
            let data = try await service.photo(id: itemId)

            guard let decoded = UIImage(data: data) else {
                // The bytes arrived but are not a displayable image: report it
                // rather than silently showing an empty frame.
                errorMessage = PhotoError.encodingFailed.errorDescription
                return
            }

            image = decoded
        } catch {
            report(error)
        }
    }

    /// Encodes, uploads, and shows the new photo.
    ///
    /// - Returns: the refreshed item on success, `nil` on failure.
    func upload(_ captured: UIImage) async -> Item? {
        guard !isUploading else { return nil }

        guard let jpeg = captured.inventoryJPEGData() else {
            errorMessage = PhotoError.encodingFailed.errorDescription
            return nil
        }

        isUploading = true
        defer { isUploading = false }

        do {
            _ = try await service.uploadPhoto(id: itemId, jpeg: jpeg)
            // Show the encoded capture immediately; it is the same image the
            // server now holds, so there is nothing to re-download.
            image = UIImage(data: jpeg) ?? captured
            return try await service.item(id: itemId)
        } catch {
            report(error)
            return nil
        }
    }

    /// - Returns: the refreshed item on success, `nil` on failure.
    func delete() async -> Item? {
        guard !isUploading else { return nil }

        isUploading = true
        defer { isUploading = false }

        do {
            try await service.deletePhoto(id: itemId)
            image = nil
            return try await service.item(id: itemId)
        } catch {
            report(error)
            return nil
        }
    }

    private func report(_ error: Error) {
        errorMessage = (error as? LocalizedError)?.errorDescription
            ?? "Something went wrong. Please try again."
    }
}
