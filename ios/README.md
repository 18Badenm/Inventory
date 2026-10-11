# Inventory (iOS)

SwiftUI client for the Inventory API. Requires macOS, Xcode 15+, iOS 17+.

## Layout

```
Sources/
  App/InventoryApp.swift           @main entry; resolves the base URL once
  Models/Item.swift                wire types
  Networking/APIError.swift        closed error set + user-facing text
  Networking/InventoryService.swift the protocol the UI depends on
  Networking/InventoryClient.swift  URLSession implementation (an actor)
  ViewModels/                      ItemListViewModel, AddItemViewModel
  Views/                           ItemListView, ItemDetailView, AddItemView
Tests/                             XCTest suites driving the view models
project.yml                        XcodeGen spec
```

## Build

```bash
brew install xcodegen
xcodegen generate
open InventoryApp.xcodeproj
```

The `.xcodeproj` is generated, not committed: a `.pbxproj` cannot be reviewed
or merged meaningfully.

**Without XcodeGen:** create a new Xcode *App* project named `InventoryApp`
(SwiftUI, iOS 17), delete its generated `ContentView.swift` and
`InventoryAppApp.swift`, drag `Sources/` in, add `Tests/` to a unit-test
target, and add `InventoryApiBaseUrl` = `http://localhost:3000` plus the
localhost ATS exception to Info.plist — `project.yml` has the exact values.

## Pointing at a different server

The base URL is a build setting read from Info.plist at runtime, so no code
changes:

```bash
xcodebuild -scheme InventoryApp INVENTORY_API_BASE_URL=https://api.example.com
```

A missing or malformed value shows a configuration screen rather than
defaulting to another host.

## Screens

- **List** — searchable, paged, pull-to-refresh; `+`/`−` adjust stock inline,
  swipe to delete. Zero-stock counts are shown in orange. The **camera button
  in the navigation bar** is the fastest path in: capture a photo and it
  creates an item (SKU `PHOTO-<timestamp>-<suffix>`, quantity 1) with the
  image already attached, at the top of the list. Rename it from the detail
  screen. If the upload fails the item is still created, so the capture is not
  silently lost.
- **Detail** — rename, set an absolute count, move stock by a chosen step, and
  take/retake/remove the item's photo.
- **Add** — SKU/name/quantity, validated locally against the same rules the
  API enforces, so Save is only enabled for input the server will accept. A
  duplicate SKU can only be caught server-side and arrives as an alert.

## Camera

`CameraPicker` wraps `UIImagePickerController`: the requirement is one still
photo, and the system picker brings the capture UI, the permission prompt and
the retake step with it.

**Permission is resolved before the picker is presented.**
`UIImagePickerController` does not refuse a camera the user has denied — it
presents a **black screen** — so `SystemCameraAuthorizer` checks
`AVCaptureDevice.authorizationStatus(for: .video)` first and the view model
decides what to show:

| Access | What happens |
| ------ | ------------ |
| `.notDetermined` | the system prompt is shown (iOS allows this once per install) |
| `.authorized` | the camera opens |
| `.denied` / `.restricted` | an alert with **Open Settings**, since only Settings can undo it |
| no camera hardware | falls back to the photo library |

**The simulator has no camera**, which is why the last row exists — otherwise
the button would be dead exactly where most testing happens, and the detail
screen says as much. `NSCameraUsageDescription` and
`NSPhotoLibraryUsageDescription` are set in `project.yml`.

`CameraAuthorizing` is a protocol, so `CameraPermissionGateTests` drives every
branch above with a stub — no device and no real prompt.

Captures are re-drawn (baking in EXIF orientation, so photos are never shown
rotated), scaled to 2048 px on the longest side, and JPEG-encoded at 0.8 before
upload — a full-resolution iPhone capture is several times the API's 10 MB cap.

## Tests

```bash
xcodebuild test -scheme InventoryApp \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

`StubInventoryService` records every call, so the suite asserts what the view
model *requested* (page offsets, deltas, normalised SKUs) rather than only
what it displayed.
