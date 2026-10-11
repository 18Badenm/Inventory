import Foundation

/// Resolves the API base URL from the build-time Info.plist value.
enum APIConfiguration {
    static let infoPlistKey = "InventoryApiBaseUrl"

    /// - Throws: `APIError.invalidURL` when the key is missing or unparseable,
    ///   which is a packaging fault and must fail loudly rather than silently
    ///   defaulting to some other host.
    static func baseURL(from bundle: Bundle = .main) throws -> URL {
        guard let raw = bundle.object(forInfoDictionaryKey: infoPlistKey) as? String,
              !raw.isEmpty
        else {
            throw APIError.invalidURL("Info.plist is missing \(infoPlistKey)")
        }

        guard let url = URL(string: raw) else {
            throw APIError.invalidURL(raw)
        }

        return url
    }
}

/// Stands in for the body type of a request that has no body.
private struct NoBody: Encodable, Sendable {}

/// HTTP client for the Inventory API.
///
/// An actor because it owns the shared `JSONEncoder`/`JSONDecoder`, which are
/// reference types and not safe to use concurrently.
actor InventoryClient: InventoryService {
    private let baseURL: URL
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        self.encoder = JSONEncoder()

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)

            guard let date = Self.parseTimestamp(text) else {
                throw DecodingError.dataCorrupted(
                    .init(
                        codingPath: decoder.codingPath,
                        debugDescription: "Not an ISO-8601 timestamp: \(text)"
                    )
                )
            }

            return date
        }
        self.decoder = decoder
    }

    /// The API emits ISO-8601 with fractional seconds (`Date#toISOString`), but
    /// accepting the form without them costs one extra parse and avoids a hard
    /// failure if that ever changes.
    private static func parseTimestamp(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        if let date = withFraction.date(from: text) {
            return date
        }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]

        return plain.date(from: text)
    }

    // MARK: - InventoryService

    func listItems(
        limit: Int = 50,
        offset: Int = 0,
        search: String? = nil
    ) async throws -> Page<Item> {
        var query = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]

        if let search, !search.isEmpty {
            query.append(URLQueryItem(name: "search", value: search))
        }

        return try await send(
            method: "GET",
            path: "/v1/items",
            query: query,
            body: Optional<NoBody>.none,
            expecting: Page<Item>.self
        )
    }

    func item(id: UUID) async throws -> Item {
        try await send(
            method: "GET",
            path: "/v1/items/\(id.apiIdentifier)",
            body: Optional<NoBody>.none,
            expecting: Item.self
        )
    }

    func createItem(sku: String, name: String, quantity: Int) async throws -> Item {
        try await send(
            method: "POST",
            path: "/v1/items",
            body: CreateItemRequest(sku: sku, name: name, quantity: quantity),
            expecting: Item.self
        )
    }

    func updateItem(id: UUID, name: String?, quantity: Int?) async throws -> Item {
        try await send(
            method: "PATCH",
            path: "/v1/items/\(id.apiIdentifier)",
            body: UpdateItemRequest(name: name, quantity: quantity),
            expecting: Item.self
        )
    }

    func adjustStock(id: UUID, delta: Int) async throws -> Item {
        try await send(
            method: "POST",
            path: "/v1/items/\(id.apiIdentifier)/adjust",
            body: AdjustStockRequest(delta: delta),
            expecting: Item.self
        )
    }

    func deleteItem(id: UUID) async throws {
        _ = try await perform(
            method: "DELETE",
            path: "/v1/items/\(id.apiIdentifier)",
            query: [],
            body: Optional<NoBody>.none
        )
    }

    func uploadPhoto(id: UUID, jpeg: Data) async throws -> PhotoMetadata {
        let data = try await performRaw(
            method: "PUT",
            path: "/v1/items/\(id.apiIdentifier)/photo",
            contentType: "image/jpeg",
            payload: jpeg
        )

        do {
            return try decoder.decode(PhotoMetadata.self, from: data)
        } catch {
            throw APIError.decoding(message: String(describing: error))
        }
    }

    func photo(id: UUID) async throws -> Data {
        // Returned verbatim: these are image bytes, not JSON, so nothing is
        // decoded.
        try await perform(
            method: "GET",
            path: "/v1/items/\(id.apiIdentifier)/photo",
            query: [],
            body: Optional<NoBody>.none
        )
    }

    func deletePhoto(id: UUID) async throws {
        _ = try await perform(
            method: "DELETE",
            path: "/v1/items/\(id.apiIdentifier)/photo",
            query: [],
            body: Optional<NoBody>.none
        )
    }

    // MARK: - Transport

    private func send<Body: Encodable, Response: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Body?,
        expecting: Response.Type
    ) async throws -> Response {
        let data = try await perform(method: method, path: path, query: query, body: body)

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(message: String(describing: error))
        }
    }

    /// Builds, sends, and validates one JSON request. Returns the raw body so
    /// a 204 caller can ignore it.
    private func perform<Body: Encodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?
    ) async throws -> Data {
        var request = try makeRequest(method: method, path: path, query: query)

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
                request.httpBody = try encoder.encode(body)
            } catch {
                // An un-encodable request body is a programming error here,
                // not a runtime condition to retry.
                throw APIError.decoding(message: String(describing: error))
            }
        }

        return try await execute(request)
    }

    /// Sends a raw payload (an image) under its own media type. The API takes
    /// the photo as a plain image body, not multipart, so there is no boundary
    /// framing to build here.
    private func performRaw(
        method: String,
        path: String,
        contentType: String,
        payload: Data
    ) async throws -> Data {
        var request = try makeRequest(method: method, path: path, query: [])
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = payload

        return try await execute(request)
    }

    private func makeRequest(
        method: String,
        path: String,
        query: [URLQueryItem]
    ) throws -> URLRequest {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.invalidURL(baseURL.absoluteString + path)
        }

        if !query.isEmpty {
            components.queryItems = query
        }

        guard let url = components.url else {
            throw APIError.invalidURL(baseURL.absoluteString + path)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        return request
    }

    /// Sends a prepared request and maps the outcome onto `APIError`.
    private func execute(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(message: String(describing: error))
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(message: "Response was not HTTP")
        }

        switch http.statusCode {
        case 200...299:
            return data
        case 400...599:
            // The API's envelope is the contract; if the body is not one, the
            // status is still reported rather than swallowed.
            guard let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) else {
                throw APIError.unexpectedStatus(http.statusCode)
            }

            throw APIError.api(
                status: http.statusCode,
                code: envelope.error.code,
                message: envelope.error.message
            )
        default:
            throw APIError.unexpectedStatus(http.statusCode)
        }
    }
}

private extension UUID {
    /// The API emits and expects lower-case UUIDs; `UUID.uuidString` is
    /// upper-case.
    var apiIdentifier: String { uuidString.lowercased() }
}
