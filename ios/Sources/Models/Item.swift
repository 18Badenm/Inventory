import Foundation

/// An inventory item, mirroring the API's wire format exactly.
struct Item: Identifiable, Hashable, Sendable, Codable {
    let id: UUID
    let sku: String
    let name: String
    let quantity: Int
    let createdAt: Date
    let updatedAt: Date
    /// When the photo was last replaced, or `nil` when the item has none.
    /// Doubles as a cache key: a new value means the image must be re-fetched.
    let photoUpdatedAt: Date?

    var hasPhoto: Bool { photoUpdatedAt != nil }
}

/// Metadata the API returns after a photo upload.
struct PhotoMetadata: Decodable, Sendable, Equatable {
    let itemId: UUID
    let contentType: String
    let byteSize: Int
    let updatedAt: Date
}

/// A page of results. The API always reports the unpaginated `total`, which
/// the list view uses to decide whether another page exists.
struct Page<Element: Decodable & Sendable>: Decodable, Sendable {
    let items: [Element]
    let total: Int
    let limit: Int
    let offset: Int

    var hasMore: Bool { offset + items.count < total }
}

struct CreateItemRequest: Encodable, Sendable {
    let sku: String
    let name: String
    let quantity: Int
}

struct UpdateItemRequest: Encodable, Sendable {
    let name: String?
    let quantity: Int?
}

struct AdjustStockRequest: Encodable, Sendable {
    let delta: Int
}
