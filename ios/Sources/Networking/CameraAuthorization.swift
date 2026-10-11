import AVFoundation
import UIKit

/// The outcome of asking for camera access.
enum CameraAccess: Equatable, Sendable {
    /// Capture may proceed.
    case granted
    /// The user refused, or a policy (Screen Time restrictions) forbids it.
    /// Only the Settings app can change this — asking again does nothing,
    /// because iOS shows its prompt once per install.
    case denied
    /// There is no camera to use, as on the simulator.
    case unavailable
}

@MainActor
protocol CameraAuthorizing {
    /// Resolves the current state, surfacing the system prompt if the user has
    /// not been asked yet.
    func requestAccess() async -> CameraAccess
}

/// The real implementation, backed by `AVCaptureDevice`.
///
/// Checking this before presenting the picker is what keeps a
/// permission-denied device from showing a black capture screen instead of a
/// camera — `UIImagePickerController` does not refuse, it just shows nothing.
@MainActor
struct SystemCameraAuthorizer: CameraAuthorizing {
    func requestAccess() async -> CameraAccess {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            return .unavailable
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return .granted
        case .notDetermined:
            // The one chance to show the system prompt.
            return await AVCaptureDevice.requestAccess(for: .video) ? .granted : .denied
        case .denied, .restricted:
            return .denied
        @unknown default:
            // A state this build does not know about is treated as no access
            // rather than optimistically presenting a camera that may not work.
            return .denied
        }
    }
}
