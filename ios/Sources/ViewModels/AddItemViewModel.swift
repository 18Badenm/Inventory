import Foundation

/// Backs the add-item sheet. Mirrors the API's validation rules locally so the
/// Save button is disabled before a round trip, while still surfacing the
/// server's verdict (such as a duplicate SKU) as the authority.
@MainActor
final class AddItemViewModel: ObservableObject {
    @Published var sku = ""
    @Published var name = ""
    @Published var quantityText = "0"
    @Published private(set) var isSaving = false
    @Published var errorMessage: String?

    private let service: InventoryService

    init(service: InventoryService) {
        self.service = service
    }

    /// Normalised exactly as the API normalises it, so what the field shows is
    /// what gets stored.
    var normalisedSKU: String {
        sku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    var normalisedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `nil` when the text is not a non-negative whole number.
    var quantity: Int? {
        let trimmed = quantityText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let value = Int(trimmed), value >= 0 else { return nil }

        return value
    }

    var skuIsValid: Bool {
        let candidate = normalisedSKU

        guard (1...64).contains(candidate.count) else { return false }

        return candidate.allSatisfy { character in
            character.isASCII && (character.isNumber || ("A"..."Z").contains(character) || character == "-")
        }
    }

    var nameIsValid: Bool { (1...200).contains(normalisedName.count) }

    var canSave: Bool { skuIsValid && nameIsValid && quantity != nil && !isSaving }

    /// - Returns: the created item on success, `nil` on failure, with
    ///   `errorMessage` set.
    func save() async -> Item? {
        guard let quantity, canSave else { return nil }

        isSaving = true
        defer { isSaving = false }

        do {
            return try await service.createItem(
                sku: normalisedSKU,
                name: normalisedName,
                quantity: quantity
            )
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "Couldn't save the item. Please try again."
            return nil
        }
    }
}
