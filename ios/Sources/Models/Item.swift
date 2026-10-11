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

/// A money amount in the server's configured currency.
struct Price: Decodable, Sendable, Equatable {
    let amount: Double
    let currency: String

    /// Localised for display, e.g. "$45.50".
    var formatted: String {
        amount.formatted(.currency(code: currency))
    }
}

/// A listing the estimate was grounded in.
struct ValuationSource: Decodable, Sendable, Equatable, Identifiable {
    let uri: URL
    let title: String?

    var id: URL { uri }
    var displayTitle: String { title ?? uri.host() ?? uri.absoluteString }
}

/// What the server thinks a photographed item is, and what it is worth.
struct Valuation: Decodable, Sendable, Equatable {
    let itemId: UUID
    let name: String
    /// `nil` when no value could be determined — a real answer, not a failure.
    let price: Price?
    let sources: [ValuationSource]
    let model: String
    let valuedAt: Date
}
