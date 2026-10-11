import SwiftUI
import UIKit

/// The root screen: searchable, pull-to-refresh list of stock with inline
/// increment/decrement and swipe-to-delete.
struct ItemListView: View {
    private let service: InventoryService
    @StateObject private var viewModel: ItemListViewModel
    @State private var isAddingItem = false

    init(service: InventoryService) {
        self.service = service
        _viewModel = StateObject(wrappedValue: ItemListViewModel(service: service))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Inventory")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await viewModel.beginCapture() }
                        } label: {
                            Label("Take photo", systemImage: "camera")
                        }
                        .disabled(viewModel.isCapturing)
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            isAddingItem = true
                        } label: {
                            Label("Add item", systemImage: "plus")
                        }
                    }
                }
                .searchable(text: $viewModel.searchText, prompt: "Search SKU or name")
                .onSubmit(of: .search) {
                    Task { await viewModel.load() }
                }
                .refreshable { await viewModel.load() }
                .task { await viewModel.load() }
                .sheet(item: $viewModel.captureSource) { source in
                    CameraPicker(source: source) { captured in
                        Task { await viewModel.createFromPhoto(captured) }
                    }
                }
                .alert("Camera access needed", isPresented: $viewModel.needsCameraSettings) {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    Button("Not now", role: .cancel) {}
                } message: {
                    Text(
                        "Allow camera access for Inventory to photograph items. "
                            + "You can change it under Settings › Inventory › Camera."
                    )
                }
                .overlay {
                    if viewModel.isCapturing {
                        ProgressView("Uploading photo…")
                            .padding()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                .sheet(isPresented: $isAddingItem) {
                    AddItemView(service: service) { created in
                        viewModel.insert(created)
                    }
                }
                .alert(
                    "Something went wrong",
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

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.items.isEmpty {
            ProgressView("Loading inventory…")
        } else if viewModel.items.isEmpty {
            emptyState
        } else {
            list
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "shippingbox")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(viewModel.searchText.isEmpty ? "No items yet" : "No matches")
                .font(.headline)
            Text(
                viewModel.searchText.isEmpty
                    ? "Tap the camera to photograph an item, or + to type one in."
                    : "Try a different SKU or name."
            )
            .foregroundStyle(.secondary)
        }
        .padding()
    }

    private var list: some View {
        List {
            Section {
                ForEach(viewModel.items) { item in
                    NavigationLink {
                        ItemDetailView(item: item, service: service) { updated in
                            viewModel.replace(updated)
                        }
                    } label: {
                        ItemRow(item: item) { delta in
                            Task { await viewModel.adjust(item: item, by: delta) }
                        }
                    }
                }
                .onDelete { offsets in
                    let doomed = offsets.compactMap { index in
                        viewModel.items.indices.contains(index) ? viewModel.items[index] : nil
                    }
                    Task {
                        for item in doomed {
                            await viewModel.delete(item: item)
                        }
                    }
                }
            } footer: {
                Text("\(viewModel.items.count) of \(viewModel.total) item(s)")
            }

            if viewModel.hasMore {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .task { await viewModel.loadMore() }
            }
        }
        .listStyle(.insetGrouped)
    }
}

/// One row: identity on the left, stock count and the two adjust buttons on
/// the right.
struct ItemRow: View {
    let item: Item
    let onAdjust: (Int) -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .font(.body)
                HStack(spacing: 4) {
                    Text(item.sku)
                        .font(.caption.monospaced())
                    if item.hasPhoto {
                        Image(systemName: "camera.fill")
                            .font(.caption2)
                            .accessibilityLabel("Has a photo")
                    }
                }
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Text("\(item.quantity)")
                .font(.headline.monospacedDigit())
                .frame(minWidth: 36, alignment: .trailing)
                .foregroundStyle(item.quantity == 0 ? .orange : .primary)

            // `buttonStyle(.borderless)` keeps these tappable inside a
            // NavigationLink row instead of the whole row swallowing the tap.
            HStack(spacing: 4) {
                Button {
                    onAdjust(-1)
                } label: {
                    Image(systemName: "minus.circle")
                }
                .disabled(item.quantity == 0)
                .accessibilityLabel("Remove one \(item.name)")

                Button {
                    onAdjust(1)
                } label: {
                    Image(systemName: "plus.circle")
                }
                .accessibilityLabel("Add one \(item.name)")
            }
            .buttonStyle(.borderless)
            .font(.title3)
        }
        .padding(.vertical, 2)
    }
}
