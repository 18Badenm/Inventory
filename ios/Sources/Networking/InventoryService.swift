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
}
