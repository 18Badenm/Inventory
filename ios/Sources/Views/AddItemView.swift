import SwiftUI

/// Add-item sheet. Local validation mirrors the API's rules so Save is only
/// enabled for input the server will accept; a duplicate SKU can only be
/// detected server-side and comes back as an alert.
struct AddItemView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel: AddItemViewModel

    private let onCreated: (Item) -> Void

    init(service: InventoryService, onCreated: @escaping (Item) -> Void) {
        _viewModel = StateObject(wrappedValue: AddItemViewModel(service: service))
        self.onCreated = onCreated
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("SKU", text: $viewModel.sku)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    TextField("Name", text: $viewModel.name)
                        .textInputAutocapitalization(.words)
                    TextField("Quantity", text: $viewModel.quantityText)
                        .keyboardType(.numberPad)
                } footer: {
                    Text("Letters, digits and dashes only. Stored as \(viewModel.normalisedSKU.isEmpty ? "—" : viewModel.normalisedSKU).")
                }
            }
            .navigationTitle("New item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if let created = await viewModel.save() {
                                onCreated(created)
                                dismiss()
                            }
                        }
                    }
                    .disabled(!viewModel.canSave)
                }
            }
            .overlay {
                if viewModel.isSaving {
                    ProgressView()
                }
            }
            .alert(
                "Couldn't save",
                isPresented: Binding(
                    get: { viewModel.errorMessage != nil },
                    set: { if !$0 { viewModel.errorMessage = nil } }
                ),
                presenting: viewModel.errorMessage
            ) { _ in
                Button("OK", role: .cancel) { viewModel.errorMessage = nil }
            } message: { message in
                Text(message)
            }
        }
    }
}
