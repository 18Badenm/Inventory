import SwiftUI

@main
struct InventoryApp: App {
    /// Resolved once at launch and shared by every screen. A missing or
    /// malformed base URL is a packaging fault, so it is surfaced as a
    /// dedicated screen rather than crashing or quietly falling back to some
    /// other host.
    private let service: Result<InventoryService, Error>

    init() {
        service = Result {
            InventoryClient(baseURL: try APIConfiguration.baseURL())
        }
    }

    var body: some Scene {
        WindowGroup {
            switch service {
            case let .success(service):
                ItemListView(service: service)
            case let .failure(error):
                ConfigurationErrorView(message: String(describing: error))
            }
        }
    }
}

/// Shown when the app cannot determine which server to talk to.
struct ConfigurationErrorView: View {
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.orange)
            Text("Configuration error")
                .font(.headline)
            Text("The app has no valid API base URL and cannot start.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Text(message)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
