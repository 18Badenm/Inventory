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
  | 'valuation_not_configured'
  | 'valuation_upstream_failed'
  | 'valuation_unreadable'
  | 'valuation_timeout'
  | 'unsupported_image_type'
  | 'photo_too_large'
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

/**
 * Valuation failures.
 *
 * None of these carry the upstream response body, the outgoing request, or
 * the API key: an error surfaced to a client must not become a channel for
 * leaking credentials or third-party payloads.
 */
export class ValuationNotConfiguredError extends AppError {
  readonly code = 'valuation_not_configured';
  readonly statusCode = 503;

  constructor() {
    super('Valuation is not configured on this server.');
  }
}

export class ValuationUpstreamError extends AppError {
  readonly code = 'valuation_upstream_failed';
  readonly statusCode = 502;

  constructor() {
    super('The valuation service could not be reached.');
  }
}

export class ValuationUnreadableError extends AppError {
  readonly code = 'valuation_unreadable';
  readonly statusCode = 502;

  constructor() {
    super('The valuation service returned something unusable.');
  }
}

export class ValuationTimeoutError extends AppError {
  readonly code = 'valuation_timeout';
  readonly statusCode = 504;

  constructor() {
    super('The valuation service took too long to respond.');
  }
}
