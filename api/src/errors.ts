/**
 * Typed application errors.
 *
 * Every error surfaced to a client is an AppError with a stable machine-readable
 * `code` and a message safe for display. Anything else that reaches the error
 * handler is treated as a bug: it is logged in full and reported to the client
 * as an opaque 500, never as a stack trace.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'item_not_found'
  | 'sku_already_exists'
  | 'insufficient_stock'
  | 'photo_not_found'
  | 'unsupported_image_type'
  | 'photo_too_large'
  | 'valuation_not_configured'
  | 'valuation_upstream_failed'
  | 'valuation_unreadable'
  | 'valuation_timeout'
  | 'internal_error';

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly code = 'validation_failed';
  readonly statusCode = 400;
  readonly issues: readonly FieldIssue[];

  constructor(issues: readonly FieldIssue[]) {
    super('The request payload is invalid.');
    this.issues = issues;
  }
}

export class ItemNotFoundError extends AppError {
  readonly code = 'item_not_found';
  readonly statusCode = 404;

  constructor(id: string) {
    super(`No item exists with id "${id}".`);
  }
}

export class SkuAlreadyExistsError extends AppError {
  readonly code = 'sku_already_exists';
  readonly statusCode = 409;

  constructor(sku: string) {
    super(`An item with SKU "${sku}" already exists.`);
  }
}

export class PhotoNotFoundError extends AppError {
  readonly code = 'photo_not_found';
  readonly statusCode = 404;

  constructor(itemId: string) {
    super(`Item "${itemId}" has no photo.`);
  }
}

export class UnsupportedImageTypeError extends AppError {
  readonly code = 'unsupported_image_type';
  readonly statusCode = 415;

  constructor(accepted: readonly string[]) {
    super(
      `The uploaded bytes are not a supported image. Accepted: ${accepted.join(', ')}.`,
    );
  }
}

export class PhotoTooLargeError extends AppError {
  readonly code = 'photo_too_large';
  readonly statusCode = 413;
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(
      `The photo exceeds the maximum size of ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
    );
    this.maxBytes = maxBytes;
  }
}

/**
 * Valuation is an optional capability: the service runs without a Gemini key
 * and says so plainly on this one endpoint, rather than booting into a state
 * where the route exists but silently answers with nothing useful.
 */
export class ValuationNotConfiguredError extends AppError {
  readonly code = 'valuation_not_configured';
  readonly statusCode = 503;

  constructor() {
    super('Item valuation is not configured on this server.');
  }
}

/**
 * The upstream model API refused or failed. The upstream status is recorded for
 * operators; neither its response body nor the API key is ever carried in the
 * message, because this message is shown to a client.
 */
export class ValuationUpstreamError extends AppError {
  readonly code = 'valuation_upstream_failed';
  readonly statusCode = 502;
  readonly upstreamStatus: number | null;

  constructor(upstreamStatus: number | null) {
    super('The valuation service is unavailable. Please try again later.');
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * The upstream answered, but not with a valuation this service can stand
 * behind — malformed JSON, a missing field, a currency we did not ask for, or
 * a truncated or safety-blocked completion. Reported rather than repaired: a
 * guessed price is worse than no price.
 */
export class ValuationUnreadableError extends AppError {
  readonly code = 'valuation_unreadable';
  readonly statusCode = 502;
  /** Operator-facing detail. Logged, never sent to the client. */
  readonly detail: string;

  constructor(detail: string) {
    super('The valuation service returned no usable answer.');
    this.detail = detail;
  }
}

export class ValuationTimeoutError extends AppError {
  readonly code = 'valuation_timeout';
  readonly statusCode = 504;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The valuation service did not respond within ${timeoutMs} ms.`);
    this.timeoutMs = timeoutMs;
  }
}

export class InsufficientStockError extends AppError {
  readonly code = 'insufficient_stock';
  readonly statusCode = 422;
  readonly available: number;
  readonly requested: number;

  constructor(available: number, requested: number) {
    super(
      `Cannot remove ${requested} unit(s): only ${available} in stock.`,
    );
    this.available = available;
    this.requested = requested;
  }
}
