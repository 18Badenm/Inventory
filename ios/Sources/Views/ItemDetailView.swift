import SwiftUI

/// Detail screen: rename, set an absolute count, or move stock by a chosen
/// amount. Every mutation round-trips and the server's copy wins.
struct ItemDetailView: View {
    @State private var item: Item
    @State private var name: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var adjustmentSize = 1

    @StateObject private var photo: ItemPhotoViewModel
    @State private var isCapturing = false

    private let service: InventoryService
    private let onChange: (Item) -> Void

    init(item: Item, service: InventoryService, onChange: @escaping (Item) -> Void) {
        _item = State(initialValue: item)
        _name = State(initialValue: item.name)
        _photo = StateObject(
            wrappedValue: ItemPhotoViewModel(itemId: item.id, service: service)
        )
        self.service = service
        self.onChange = onChange
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canRename: Bool {
        !isSaving && (1...200).contains(trimmedName.count) && trimmedName != item.name
    }

    var body: some View {
        Form {
            Section("Identity") {
                LabeledContent("SKU") {
                    Text(item.sku)
                        .font(.body.monospaced())
                }
                TextField("Name", text: $name)
                    .textInputAutocapitalization(.words)
                Button("Save name") {
                    Task { await rename() }
                }
                .disabled(!canRename)
            }

            Section("Stock") {
                LabeledContent("On hand") {
                    Text("\(item.quantity)")
                        .font(.title3.monospacedDigit())
                        .foregroundStyle(item.quantity == 0 ? .orange : .primary)
                }

                Stepper("Adjust by \(adjustmentSize)", value: $adjustmentSize, in: 1...100)

                HStack {
                    Button {
                        Task { await adjust(by: -adjustmentSize) }
                    } label: {
                        Label("Remove \(adjustmentSize)", systemImage: "minus")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(isSaving || item.quantity == 0)

                    Button {
                        Task { await adjust(by: adjustmentSize) }
                    } label: {
                        Label("Add \(adjustmentSize)", systemImage: "plus")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(isSaving)
                }
                .buttonStyle(.bordered)
            }

            Section("Photo") {
                photoSection
            }

            Section("History") {
                LabeledContent("Created", value: item.createdAt.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Updated", value: item.updatedAt.formatted(date: .abbreviated, time: .shortened))
            }
        }
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(isSaving)
        .overlay {
            if isSaving || photo.isUploading {
                ProgressView()
            }
        }
        .task { await photo.load(hasPhoto: item.hasPhoto) }
        .sheet(isPresented: $isCapturing) {
            CameraPicker { captured in
                Task {
                    if let updated = await photo.upload(captured) {
                        apply(updated)
                    }
                }
            }
        }
        // Funnelled into this screen's single alert so a photo failure and a
        // rename failure cannot fight over presentation.
        .onChange(of: photo.errorMessage) { _, message in
            if let message {
                errorMessage = message
                photo.errorMessage = nil
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            ),
            presenting: errorMessage
        ) { _ in
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: { message in
            Text(message)
        }
    }

    @ViewBuilder
    private var photoSection: some View {
        if let image = photo.image {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxHeight: 240)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Photo of \(item.name)")
        } else if photo.isLoading {
            HStack {
                Spacer()
                ProgressView()
                Spacer()
            }
        }

        Button {
            isCapturing = true
        } label: {
            Label(
                photo.image == nil ? "Take photo" : "Retake photo",
                systemImage: "camera"
            )
        }
        .disabled(photo.isBusy)

        if photo.image != nil {
            Button(role: .destructive) {
                Task {
                    if let updated = await photo.delete() {
                        apply(updated)
                    }
                }
            } label: {
                Label("Remove photo", systemImage: "trash")
            }
            .disabled(photo.isBusy)
        }

        if !CameraPicker.isCameraAvailable {
            Text("No camera on this device — the photo library is used instead.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func rename() async {
        isSaving = true
        defer { isSaving = false }

        do {
            let updated = try await service.updateItem(
                id: item.id,
                name: trimmedName,
                quantity: nil
            )
            apply(updated)
        } catch {
            // Put the field back to the server's truth so the UI never shows
            // a name that was not saved.
            name = item.name
            report(error)
        }
    }

    private func adjust(by delta: Int) async {
        isSaving = true
        defer { isSaving = false }

        do {
            let updated = try await service.adjustStock(id: item.id, delta: delta)
            apply(updated)
        } catch {
            report(error)
        }
    }

    private func apply(_ updated: Item) {
        item = updated
        name = updated.name
        onChange(updated)
    }

    private func report(_ error: Error) {
        errorMessage = (error as? LocalizedError)?.errorDescription
            ?? "Something went wrong. Please try again."
    }
}
