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
npm test          # 88 tests; no server, network or API key needed
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
| `POST`   | `/v1/items/:id/valuation` | identifies the item from its photo and prices it     |

`PATCH` **sets** a count; `adjust` **moves** it. The second is what the app's
`+`/`−` buttons use: it is applied under the write lock, so two concurrent
adjustments cannot read the same starting quantity and overwrite each other.

### Valuation

`POST /v1/items/:id/valuation` answers two questions about the item's stored
photo — what the product is, and what it is worth:

```jsonc
{ "name": "WD-40 Multi-Use Product Smart Straw 11 oz",
  "price": { "amount": 7.28, "currency": "USD" },
  "sources": [{ "uri": "https://...", "title": "A Listing" }] }
```

`price` is `null` when the product was identified but no price could be
established — an unbranded object, or a photo of a wall. That is a real
outcome, reported as one rather than filled in with a guess. `sources` is
populated only when grounding is on, and is always empty otherwise.

A `POST` rather than a `GET` because it is neither cacheable nor free: each
call spends an upstream request against a billed quota. **Nothing is
persisted** — the valuation reflects the market at the moment of the call, so
storing it would mean later serving a stale price as though it were current.

Requires `GEMINI_API_KEY`. Without it the service still boots and serves every
other route, and this endpoint reports `503 valuation_not_configured` instead
of pretending to work. See `api/.env.example` for the full set of knobs.

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
| 502    | `valuation_upstream_failed`, `valuation_unreadable` |
| 503    | `valuation_not_configured`                 |
| 504    | `valuation_timeout`                        |

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

**Photos: one per item, sniffed not trusted.** There are two ways in: the
camera button on the list screen, which creates an item from a capture, and
the photo section of an item's detail screen, which attaches to an existing
one. Either way a photo always belongs to the item it depicts. The image is
sent as a raw `image/*` body — one file, no fields, so multipart would buy
nothing — and the stored media type comes from the file's **magic bytes**, never
the client's `Content-Type` header. A payload claiming `image/jpeg` that is
really an SVG is rejected with `415`, which is what stops it being served back
later under an image label. Accepted: JPEG, PNG, HEIC, up to 10 MB.

**Valuation: Gemini, because nothing else returns a price.** No Google API
returns a market price for an arbitrary photographed product. Cloud Vision's
`WEB_DETECTION` returns `bestGuessLabels` and matching pages but no price;
Vision Product Search matches against a catalog you upload, with prices you
already supply; the Content API for Shopping manages your own merchant
listings. Gemini's `generateContent` is the one surface that answers both
halves from one photo, and with `tools: [{googleSearch: {}}]` it backs the
price with live listings and returns their URLs — which is what makes a
valuation auditable rather than a number with no provenance.

Search grounding is a **billed** feature. On a key without that quota every
grounded call fails with a hard 429 (not a rate limit — it never succeeds), so
`VALUATION_GROUNDING=off` trades the citations for an unsourced estimate and
switches on strict JSON mode, which grounding cannot use. Both paths are
parsed by the same Zod schema, so the contract does not depend on the mode.

A model's free-form text is not trusted. The reply must parse as one JSON
object with a non-empty name and either `null` or a positive amount in the
configured currency; anything else is a `valuation_unreadable` 502 rather than
a repaired or guessed price. A price quoted in another currency is rejected,
not converted at an invented rate. Grounding URIs are re-parsed and must be
`https:` before being echoed to a client, so a `javascript:` or `data:` URI
cannot reach the app as a "source". The photo itself is attacker-controlled
input, so the prompt states that text visible in it describes the product and
is never an instruction — and the output contract is what actually contains
the damage if a photo tries anyway.

`GEMINI_TIMEOUT_MS` bounds the **whole** call including the one retry, not each
attempt: a caller who asks to wait 20 seconds must not wait 41. Retries are
limited to one, on 429 and 503, which are the two transient upstream failures
this service actually sees.

Bytes live in a SQLite BLOB with `ON DELETE CASCADE`, so a photo dies with its
item: no orphaned files to reap and no client-supplied filename to sanitise.
The iOS client re-draws each capture to bake in EXIF orientation and scales it
to 2048 px before JPEG encoding — a full-resolution iPhone capture is several
times the size limit.

## Testing

```bash
cd api && npm test          # 88 tests
cd ios  && xcodebuild test -scheme InventoryApp \
            -destination 'platform=iOS Simulator,name=iPhone 15'
```

Backend tests assert persisted rows directly, bypassing the API under test, so
a handler that returns the right JSON without writing the right row fails.
