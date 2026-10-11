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
