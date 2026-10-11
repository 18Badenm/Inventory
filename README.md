# Inventory

A stock-tracking app in two parts:

| Path  | What it is                                                     |
| ----- | -------------------------------------------------------------- |
| `api/` | **Inventory API** — Fastify + TypeScript REST service on SQLite |
| `ios/` | **Inventory** — SwiftUI iOS client                              |

## Quick start

```bash
# 1. Backend
cd api
npm install
npm test          # 28 integration tests, no server or network needed
npm run dev       # http://localhost:3000

# 2. iOS app (needs macOS + Xcode)
cd ios
brew install xcodegen
xcodegen generate
open InventoryApp.xcodeproj   # ⌘R on an iOS 17+ simulator
```

The simulator reaches a backend on the host at `http://localhost:3000`, which
is the app's default and the one plaintext-HTTP exception in its ATS config.

## The data model

One entity. An item has an immutable `sku` (the identifier other systems key
on), a `name`, and a non-negative `quantity`.

```jsonc
{
  "id": "a8905685-55a2-4cd2-b017-c8e7e5d4f6f5",
  "sku": "WD-40",
  "name": "Lubricant Spray",
  "quantity": 3,
  "createdAt": "2026-10-11T20:29:29.691Z",
  "updatedAt": "2026-10-11T20:29:29.732Z"
}
```

## API

| Method   | Path                    | Notes                                                 |
| -------- | ----------------------- | ----------------------------------------------------- |
| `GET`    | `/health`               | `{"status":"ok"}`                                     |
| `GET`    | `/v1/items`             | `?limit=1..100&offset=0&search=` — newest first        |
| `POST`   | `/v1/items`             | `{sku, name, quantity?}` → `201` + `Location`          |
| `GET`    | `/v1/items/:id`         |                                                        |
| `PATCH`  | `/v1/items/:id`         | `{name?, quantity?}` — absolute set; SKU is immutable  |
| `POST`   | `/v1/items/:id/adjust`  | `{delta}` — atomic relative stock movement             |
| `DELETE` | `/v1/items/:id`         | `204` — cascades to the photo                          |
| `PUT`    | `/v1/items/:id/photo`   | raw image body → metadata; replaces any existing photo |
| `GET`    | `/v1/items/:id/photo`   | the image bytes, with `ETag`/`304` revalidation        |
| `DELETE` | `/v1/items/:id/photo`   | `204`                                                  |

`PATCH` **sets** a count; `adjust` **moves** it. The second is what the app's
`+`/`−` buttons use: it is applied under the write lock, so two concurrent
adjustments cannot read the same starting quantity and overwrite each other.

### Errors

Every non-2xx response has one shape, so a client codes against one contract:

```jsonc
{ "error": { "code": "insufficient_stock",
             "message": "Cannot remove 99 unit(s): only 3 in stock." } }
```

`validation_failed` additionally carries `issues: [{path, message}]`.

| Status | Code                                      |
| ------ | ----------------------------------------- |
| 400    | `validation_failed`, `bad_request`         |
| 404    | `item_not_found`, `route_not_found`, `photo_not_found` |
| 409    | `sku_already_exists`                       |
| 413    | `photo_too_large`                          |
| 415    | `unsupported_image_type`                   |
| 422    | `insufficient_stock`                       |
| 500    | `internal_error`                           |

Taking stock below zero is **rejected, not clamped** — a clamped count
silently loses the discrepancy an operator needs to see. Unexpected errors are
logged in full server-side and returned as an opaque `internal_error`; stack
traces never cross the wire.

## Design notes

**SQLite, not Postgres.** For a single-table service it means no database
server to run and tests that exercise real SQL instead of mocks. All
persistence lives in `api/src/items/repository.ts`; swapping engines means
reimplementing that one class against the same methods.

**Validation at one boundary.** Zod schemas in `api/src/items/model.ts` parse
every request; nothing downstream sees unparsed input. SKUs are trimmed and
upper-cased before validation, so `" wd-40 "` and `WD-40` cannot both exist.
`CHECK` constraints in the schema are the backstop if something bypasses HTTP.

**No auth, by choice.** As agreed, the endpoints are open — fine for localhost
and a simulator, not for public exposure. Adding a key is one `onRequest` hook
and a header in `InventoryClient`.

**The iOS app depends on a protocol, not a client.** View models take
`InventoryService`, so the test suite drives them against an in-memory stub
with no network and no running backend.

**No optimistic UI for stock.** An adjustment the server would refuse must not
briefly display a wrong count, so the server's copy of the row always wins.

**Photos: one per item, sniffed not trusted.** The camera lives on an item's
detail screen, so a photo always belongs to the item it depicts. The image is
sent as a raw `image/*` body — one file, no fields, so multipart would buy
nothing — and the stored media type comes from the file's **magic bytes**, never
the client's `Content-Type` header. A payload claiming `image/jpeg` that is
really an SVG is rejected with `415`, which is what stops it being served back
later under an image label. Accepted: JPEG, PNG, HEIC, up to 10 MB.

Bytes live in a SQLite BLOB with `ON DELETE CASCADE`, so a photo dies with its
item: no orphaned files to reap and no client-supplied filename to sanitise.
The iOS client re-draws each capture to bake in EXIF orientation and scales it
to 2048 px before JPEG encoding — a full-resolution iPhone capture is several
times the size limit.

## Testing

```bash
cd api && npm test          # 44 tests
cd ios  && xcodebuild test -scheme InventoryApp \
            -destination 'platform=iOS Simulator,name=iPhone 15'
```

Backend tests assert persisted rows directly, bypassing the API under test, so
a handler that returns the right JSON without writing the right row fails.
