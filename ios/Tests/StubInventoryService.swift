import Foundation
@testable import InventoryApp

/// In-memory stand-in for the API. Records every call so tests can assert on
/// what the view model actually asked for, not merely on what it ended up
/// displaying.
final class StubInventoryService: InventoryService, @unchecked Sendable {
    enum Call: Equatable {
        case list(limit: Int, offset: Int, search: String?)
        case get(UUID)
        case create(sku: String, name: String, quantity: Int)
        case update(id: UUID, name: String?, quantity: Int?)
        case adjust(id: UUID, delta: Int)
        case delete(UUID)
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    private var _items: [Item]
    private var _failure: APIError?

    init(items: [Item] = [], failure: APIError? = nil) {
        _items = items
        _failure = failure
    }

    var calls: [Call] {
        lock.withLock { _calls }
    }

    func setFailure(_ failure: APIError?) {
        lock.withLock { _failure = failure }
    }

    private func record(_ call: Call) throws {
        try lock.withLock {
            _calls.append(call)
            if let _failure {
                throw _failure
            }
        }
    }

    func listItems(limit: Int, offset: Int, search: String?) async throws -> Page<Item> {
        try record(.list(limit: limit, offset: offset, search: search))

        return lock.withLock {
            let matching = _items.filter { item in
                guard let search, !search.isEmpty else { return true }
                return item.sku.localizedCaseInsensitiveContains(search)
                    || item.name.localizedCaseInsensitiveContains(search)
            }
            let window = matching.dropFirst(offset).prefix(limit)

            return Page(
                items: Array(window),
                total: matching.count,
                limit: limit,
                offset: offset
            )
        }
    }

    func item(id: UUID) async throws -> Item {
        try record(.get(id))

        return try lock.withLock {
            guard let item = _items.first(where: { $0.id == id }) else {
                throw APIError.api(status: 404, code: "item_not_found", message: "Not found")
            }
            return item
        }
    }

    func createItem(sku: String, name: String, quantity: Int) async throws -> Item {
        try record(.create(sku: sku, name: name, quantity: quantity))

        return lock.withLock {
            let item = Item(
                id: UUID(),
                sku: sku,
                name: name,
                quantity: quantity,
                createdAt: Date(timeIntervalSince1970: 0),
                updatedAt: Date(timeIntervalSince1970: 0)
            )
            _items.insert(item, at: 0)
            return item
        }
    }

    func updateItem(id: UUID, name: String?, quantity: Int?) async throws -> Item {
        try record(.update(id: id, name: name, quantity: quantity))

        return try lock.withLock {
            guard let index = _items.firstIndex(where: { $0.id == id }) else {
                throw APIError.api(status: 404, code: "item_not_found", message: "Not found")
            }
            let existing = _items[index]
            let updated = Item(
                id: existing.id,
                sku: existing.sku,
                name: name ?? existing.name,
                quantity: quantity ?? existing.quantity,
                createdAt: existing.createdAt,
                updatedAt: Date(timeIntervalSince1970: 60)
            )
            _items[index] = updated
            return updated
        }
    }

    func adjustStock(id: UUID, delta: Int) async throws -> Item {
        try record(.adjust(id: id, delta: delta))

        return try lock.withLock {
            guard let index = _items.firstIndex(where: { $0.id == id }) else {
                throw APIError.api(status: 404, code: "item_not_found", message: "Not found")
            }
            let existing = _items[index]
            let quantity = existing.quantity + delta

            guard quantity >= 0 else {
                throw APIError.api(
                    status: 422,
                    code: "insufficient_stock",
                    message: "Cannot remove \(-delta) unit(s): only \(existing.quantity) in stock."
                )
            }

            let updated = Item(
                id: existing.id,
                sku: existing.sku,
                name: existing.name,
                quantity: quantity,
                createdAt: existing.createdAt,
                updatedAt: Date(timeIntervalSince1970: 60)
            )
            _items[index] = updated
            return updated
        }
    }

    func deleteItem(id: UUID) async throws {
        try record(.delete(id))

        try lock.withLock {
            guard let index = _items.firstIndex(where: { $0.id == id }) else {
                throw APIError.api(status: 404, code: "item_not_found", message: "Not found")
            }
            _items.remove(at: index)
        }
    }
}

extension Item {
    /// Fixture helper — fixed timestamps keep assertions deterministic.
    static func fixture(
        id: UUID = UUID(),
        sku: String = "SKU-1",
        name: String = "Widget",
        quantity: Int = 5
    ) -> Item {
        Item(
            id: id,
            sku: sku,
            name: name,
            quantity: quantity,
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0)
        )
    }
}
