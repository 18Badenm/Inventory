import Foundation
import UIKit

/// Drives the item list: loading, searching, paging, stock adjustment,
/// deletion, and capturing a new item straight from the camera. Holds no
/// `URLSession` knowledge — only an `InventoryService`.
@MainActor
final class ItemListViewModel: ObservableObject {
    @Published private(set) var items: [Item] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var total = 0
    @Published var searchText = ""
    /// Non-nil when the last operation failed; presented as an alert.
    @Published var errorMessage: String?
    /// Non-nil once camera access is resolved and a picker should be shown.
    @Published var captureSource: CaptureSource?
    /// True when camera access can only be restored from the Settings app.
    @Published var needsCameraSettings = false
    /// True while a captured photo is being turned into an item.
    @Published private(set) var isCapturing = false

    private let service: InventoryService
    private let pageSize: Int
    private let authorizer: CameraAuthorizing
    private let clock: () -> Date

    init(
        service: InventoryService,
        pageSize: Int = 50,
        authorizer: CameraAuthorizing = SystemCameraAuthorizer(),
        clock: @escaping () -> Date = Date.init
    ) {
        self.service = service
        self.pageSize = pageSize
        self.authorizer = authorizer
        self.clock = clock
    }

    var hasMore: Bool { items.count < total }

    /// Replaces the list with the first page. Safe to call repeatedly; a
    /// failure leaves the previously loaded items on screen rather than
    /// blanking the view.
    func load() async {
        guard !isLoading else { return }

        isLoading = true
        defer { isLoading = false }

        do {
            let page = try await service.listItems(
                limit: pageSize,
                offset: 0,
                search: normalisedSearch
            )
            items = page.items
            total = page.total
        } catch {
            report(error)
        }
    }

    /// Appends the next page. Does nothing when a load is already in flight or
    /// every item is already on screen.
    func loadMore() async {
        guard !isLoading, !isLoadingMore, hasMore else { return }

        isLoadingMore = true
        defer { isLoadingMore = false }

        do {
            let page = try await service.listItems(
                limit: pageSize,
                offset: items.count,
                search: normalisedSearch
            )
            // Guard against a concurrent reload having already replaced the
            // list: only append ids that are not present.
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            total = page.total
        } catch {
            report(error)
        }
    }

    /// Applies a relative stock change and replaces the affected row with the
    /// server's authoritative copy. No optimistic update: an adjustment the
    /// server rejects (overselling) must not briefly show a wrong count.
    func adjust(item: Item, by delta: Int) async {
        do {
            let updated = try await service.adjustStock(id: item.id, delta: delta)
            replace(updated)
        } catch {
            report(error)
        }
    }

    func delete(item: Item) async {
        do {
            try await service.deleteItem(id: item.id)
            items.removeAll { $0.id == item.id }
            total = max(0, total - 1)
        } catch {
            report(error)
        }
    }

    /// Inserts a newly created item at the head, matching the API's
    /// newest-first ordering, so the list does not need a round trip.
    func insert(_ item: Item) {
        items.insert(item, at: 0)
        total += 1
    }

    func replace(_ item: Item) {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index] = item
    }

    /// Resolves camera access, then opens the camera (or the library when
    /// there is no camera, as on the simulator).
    func beginCapture() async {
        switch await authorizer.requestAccess() {
        case .granted:
            captureSource = .camera
        case .unavailable:
            captureSource = .photoLibrary
        case .denied:
            needsCameraSettings = true
        }
    }

    /// Turns a captured photo into a new item: creates the record, uploads the
    /// image, and puts the result at the top of the list.
    ///
    /// The item is created first because a photo cannot exist without one to
    /// attach to. If the upload then fails, the item is still there with the
    /// failure reported, rather than the photo being silently dropped — the
    /// user can retake from the item's detail screen.
    func createFromPhoto(_ captured: UIImage) async {
        guard !isCapturing else { return }

        guard let jpeg = captured.inventoryJPEGData() else {
            errorMessage = PhotoError.encodingFailed.errorDescription
            return
        }

        isCapturing = true
        defer { isCapturing = false }

        let stamp = clock()

        do {
            let created = try await service.createItem(
                sku: Self.generatedSKU(at: stamp),
                name: Self.generatedName(at: stamp),
                quantity: 1
            )

            do {
                _ = try await service.uploadPhoto(id: created.id, jpeg: jpeg)
            } catch {
                // The item exists; only the image failed. Show it either way so
                // the work is not lost, and say what went wrong.
                insert(created)
                report(error)
                return
            }

            insert(try await service.item(id: created.id))
        } catch {
            report(error)
        }
    }

    /// A SKU for a photo-first item: uppercase letters, digits and dashes
    /// only, as the API requires. The random suffix keeps two captures in the
    /// same second from colliding on the unique SKU.
    static func generatedSKU(at date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"

        let suffix = String(UUID().uuidString.prefix(4)).uppercased()

        return "PHOTO-\(formatter.string(from: date))-\(suffix)"
    }

    static func generatedName(at date: Date) -> String {
        "Photo \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    private var normalisedSearch: String? {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func report(_ error: Error) {
        errorMessage = (error as? LocalizedError)?.errorDescription
            ?? "Something went wrong. Please try again."
    }
}
