import Foundation

/// The API surface the UI depends on.
///
/// View models are written against this protocol, never against the concrete
/// client, so they can be unit-tested against a stub with no network and no
/// running server.
protocol InventoryService: Sendable {
    func listItems(limit: Int, offset: Int, search: String?) async throws -> Page<Item>
    func item(id: UUID) async throws -> Item
    func createItem(sku: String, name: String, quantity: Int) async throws -> Item
    func updateItem(id: UUID, name: String?, quantity: Int?) async throws -> Item
    func adjustStock(id: UUID, delta: Int) async throws -> Item
    func deleteItem(id: UUID) async throws

    /// Uploads (or replaces) the item's photo.
    ///
    /// - Parameter jpeg: JPEG-encoded bytes. The API sniffs the format from the
    ///   bytes, so a mislabelled payload is rejected rather than trusted.
    func uploadPhoto(id: UUID, jpeg: Data) async throws -> PhotoMetadata

    /// Fetches the item's photo bytes, or throws `.api(status: 404, ...)` when
    /// it has none.
    func photo(id: UUID) async throws -> Data

    func deletePhoto(id: UUID) async throws

    /// Estimates what the item's photo shows and what it is worth.
    ///
    /// Calls a paid upstream service, so it is only ever triggered by an
    /// explicit tap — never on appear.
    func valuate(id: UUID) async throws -> Valuation
}
