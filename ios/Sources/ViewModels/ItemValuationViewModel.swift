import Foundation

/// Owns one item's valuation request and its result.
///
/// Modelled as an explicit state rather than a pile of booleans, so the view
/// cannot render a contradiction such as "loading" alongside a stale price.
@MainActor
final class ItemValuationViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded(Valuation)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private let itemId: UUID
    private let service: InventoryService

    init(itemId: UUID, service: InventoryService) {
        self.itemId = itemId
        self.service = service
    }

    var isLoading: Bool { state == .loading }

    /// Runs only on an explicit tap: each call costs an upstream request, so
    /// this is never triggered from `onAppear`.
    func valuate() async {
        guard !isLoading else { return }

        state = .loading

        do {
            state = .loaded(try await service.valuate(id: itemId))
        } catch {
            state = .failed(
                (error as? LocalizedError)?.errorDescription
                    ?? "Couldn't estimate a value. Please try again."
            )
        }
    }

    func reset() {
        state = .idle
    }
}
