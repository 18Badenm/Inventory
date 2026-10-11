import Foundation

/// Every failure the client can produce, as a closed set so callers can switch
/// exhaustively instead of inspecting strings.
enum APIError: Error, Equatable, Sendable {
    /// The configured base URL could not be combined with a path.
    case invalidURL(String)
    /// The request never completed — offline, DNS, timeout, TLS.
    case transport(message: String)
    /// A 4xx/5xx carrying the API's error envelope.
    case api(status: Int, code: String, message: String)
    /// A response whose body did not match the expected schema.
    case decoding(message: String)
    /// A status the endpoint is not documented to return.
    case unexpectedStatus(Int)
}

extension APIError: LocalizedError {
    /// Text shown directly to the user. Transport and decoding details are
    /// deliberately generic here — the specifics belong in logs, not in an
    /// alert — while the API's own messages are already user-safe.
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The app is misconfigured and cannot reach the server."
        case .transport:
            return "Can't reach the server. Check your connection and try again."
        case let .api(_, _, message):
            return message
        case .decoding:
            return "The server sent a response the app didn't understand."
        case let .unexpectedStatus(status):
            return "The server responded unexpectedly (status \(status))."
        }
    }

    /// True when retrying the same request might succeed.
    var isRetryable: Bool {
        switch self {
        case .transport:
            return true
        case let .api(status, _, _):
            return status >= 500
        case .unexpectedStatus(let status):
            return status >= 500
        case .invalidURL, .decoding:
            return false
        }
    }
}

/// The API's error envelope: `{"error": {"code": "...", "message": "..."}}`.
struct APIErrorEnvelope: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        let code: String
        let message: String
    }

    let error: Payload
}
