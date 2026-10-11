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
  swipe to delete. Zero-stock counts are shown in orange.
- **Detail** — rename, set an absolute count, or move stock by a chosen step.
- **Add** — SKU/name/quantity, validated locally against the same rules the
  API enforces, so Save is only enabled for input the server will accept. A
  duplicate SKU can only be caught server-side and arrives as an alert.

## Tests

```bash
xcodebuild test -scheme InventoryApp \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

`StubInventoryService` records every call, so the suite asserts what the view
model *requested* (page offsets, deltas, normalised SKUs) rather than only
what it displayed.
