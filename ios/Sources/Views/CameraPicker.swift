import SwiftUI
import UIKit

/// Presents the system camera and hands back a single still image.
///
/// `UIImagePickerController` rather than a custom `AVCaptureSession`: the
/// requirement is one photo, and the system picker brings the capture UI,
/// the permission prompt and the retake step with it.
///
/// The iOS **simulator has no camera**, so when capture is unavailable this
/// falls back to the photo library — otherwise the screen would be dead on a
/// simulator, which is where most of this gets exercised.
struct CameraPicker: UIViewControllerRepresentable {
    /// Called with the captured image; the picker dismisses itself first.
    let onCapture: (UIImage) -> Void

    @Environment(\.dismiss) private var dismiss

    static var isCameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = Self.isCameraAvailable ? .camera : .photoLibrary
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
