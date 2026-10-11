import Foundation

/// Drives the item list: loading, searching, paging, stock adjustment and
/// deletion. Holds no `URLSession` knowledge — only an `InventoryService`.
@MainActor
final class ItemListViewModel: ObservableObject {
    @Published private(set) var items: [Item] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var total = 0
    @Published var searchText = ""
    /// Non-nil when the last operation failed; presented as an alert.
    @Published var errorMessage: String?

    private let service: InventoryService
    private let pageSize: Int

    init(service: InventoryService, pageSize: Int = 50) {
        self.service = service
        self.pageSize = pageSize
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

    private var normalisedSearch: String? {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func report(_ error: Error) {
        errorMessage = (error as? LocalizedError)?.errorDescription
            ?? "Something went wrong. Please try again."
    }
}
