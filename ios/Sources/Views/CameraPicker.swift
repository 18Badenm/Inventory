import SwiftUI
import UIKit

/// Where a capture comes from. Chosen by the view model *after* camera access
/// is resolved, so the picker is never presented into a denied camera.
enum CaptureSource: String, Identifiable, Sendable {
    case camera
    case photoLibrary

    var id: String { rawValue }

    var pickerSourceType: UIImagePickerController.SourceType {
        switch self {
        case .camera: return .camera
        case .photoLibrary: return .photoLibrary
        }
    }
}

/// Presents the system camera (or the library) and hands back one still image.
///
/// `UIImagePickerController` rather than a custom `AVCaptureSession`: the
/// requirement is one photo, and the system picker brings the capture UI and
/// the retake step with it.
///
/// It does **not** decide whether the camera is usable — permission is
/// resolved before this is presented, because the picker does not refuse a
/// denied camera, it just shows a black screen.
struct CameraPicker: UIViewControllerRepresentable {
    /// Where to capture from.
    let source: CaptureSource
    /// Called with the captured image; the picker dismisses itself first.
    let onCapture: (UIImage) -> Void

    @Environment(\.dismiss) private var dismiss

    static var isCameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = source.pickerSourceType
        controller.allowsEditing = false
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: UIImagePickerController, context _: Context) {
        // Nothing to update: the picker is configured once at creation.
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onFinish: { dismiss() })
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate,
        UINavigationControllerDelegate {
        private let onCapture: (UIImage) -> Void
        private let onFinish: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onFinish: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onFinish = onFinish
        }

        func imagePickerController(
            _: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            // `.originalImage` is documented to be present for a still capture;
            // if it is somehow absent, dismiss without reporting a photo
            // rather than force-unwrapping.
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            }

            onFinish()
        }

        func imagePickerControllerDidCancel(_: UIImagePickerController) {
            onFinish()
        }
    }
}

extension UIImage {
    /// Encodes the image for upload: re-drawn to bake in the EXIF orientation
    /// (so it is not displayed rotated), scaled down to `maxDimension` on its
    /// longest side, and JPEG-compressed.
    ///
    /// A full-resolution iPhone capture is several times the API's 10 MB limit
    /// and far more detail than an inventory thumbnail needs, so downscaling
    /// here is what keeps the upload inside the limit.
    ///
    /// - Returns: JPEG bytes, or `nil` if encoding fails.
    func inventoryJPEGData(
        maxDimension: CGFloat = 2048,
        compressionQuality: CGFloat = 0.8
    ) -> Data? {
        let longestSide = max(size.width, size.height)

        guard longestSide > 0 else { return nil }

        let scale = min(1, maxDimension / longestSide)
        let target = CGSize(width: size.width * scale, height: size.height * scale)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true

        let redrawn = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }

        return redrawn.jpegData(compressionQuality: compressionQuality)
    }
}
