import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import {
  InsufficientStockError,
  ItemNotFoundError,
  SkuAlreadyExistsError,
} from '../errors.js';
import type {
  AdjustStockInput,
  CreateItemInput,
  Item,
  ListQuery,
  Page,
  UpdateItemInput,
} from './model.js';

/** Shape of a row as SQLite returns it, before mapping to the domain type. */
interface ItemRow {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    quantity: row.quantity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Narrowed by extended result code rather than by error class, so the check
 * does not depend on how the driver exports its error type.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * All persistence for items. Every statement is prepared with bound
 * parameters; no SQL is ever assembled from request data.
 *
 * This is the only module that knows the storage engine. Swapping SQLite for
 * Postgres means reimplementing this class against the same public methods.
 */
export class ItemRepository {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  list(query: ListQuery): Page<Item> {
    const { limit, offset, search } = query;

    // LIKE with an escaped pattern: the wildcards are ours, the needle is bound.
    const pattern =
      search === undefined || search === ''
        ? null
        : `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

    const where =
      pattern === null
        ? ''
        : `WHERE sku LIKE @pattern ESCAPE '\\' OR name LIKE @pattern ESCAPE '\\'`;

    const rows = this.#db
      .prepare<
        { pattern: string | null; limit: number; offset: number },
        ItemRow
      >(
        `SELECT id, sku, name, quantity, created_at, updated_at
           FROM items
           ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ pattern, limit, offset });

    const counted = this.#db
      .prepare<{ pattern: string | null }, { total: number }>(
        `SELECT COUNT(*) AS total FROM items ${where}`,
      )
      .get({ pattern });

    return {
      items: rows.map(toItem),
      total: counted?.total ?? 0,
      limit,
      offset,
    };
  }

  /** @throws {ItemNotFoundError} */
  getById(id: string): Item {
    const row = this.#findById(id);

    if (row === undefined) {
      throw new ItemNotFoundError(id);
    }

    return toItem(row);
  }

  /** @throws {SkuAlreadyExistsError} */
  create(input: CreateItemInput): Item {
    const timestamp = this.#now();
    const row: ItemRow = {
      id: randomUUID(),
      sku: input.sku,
      name: input.name,
      quantity: input.quantity,
      created_at: timestamp,
      updated_at: timestamp,
    };

    try {
      this.#db
        .prepare<ItemRow>(
          `INSERT INTO items (id, sku, name, quantity, created_at, updated_at)
           VALUES (@id, @sku, @name, @quantity, @created_at, @updated_at)`,
        )
        .run(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SkuAlreadyExistsError(input.sku);
      }
      throw error;
    }

    return toItem(row);
  }

  /** @throws {ItemNotFoundError} */
  update(id: string, patch: UpdateItemInput): Item {
    const apply = this.#db.transaction((): Item => {
      const existing = this.#findById(id);

      if (existing === undefined) {
        throw new ItemNotFoundError(id);
      }

      const next: ItemRow = {
        ...existing,
        name: patch.name ?? existing.name,
        quantity: patch.quantity ?? existing.quantity,
        updated_at: this.#now(),
      };

      this.#db
        .prepare<{
          id: string;
          name: string;
          quantity: number;
          updated_at: string;
        }>(
          `UPDATE items
              SET name = @name, quantity = @quantity, updated_at = @updated_at
            WHERE id = @id`,
        )
        .run({
          id,
          name: next.name,
          quantity: next.quantity,
          updated_at: next.updated_at,
        });

      return toItem(next);
    });

    return apply.immediate();
  }

  /**
   * Applies a relative stock movement under the write lock, so two concurrent
   * adjustments cannot both read the same starting quantity and overwrite each
   * other. Taking stock below zero is rejected rather than clamped — a
   * clamped count silently loses the discrepancy an operator needs to see.
   *
   * @throws {ItemNotFoundError}
   * @throws {InsufficientStockError}
   */
  adjustStock(id: string, input: AdjustStockInput): Item {
    const apply = this.#db.transaction((): Item => {
      const existing = this.#findById(id);

      if (existing === undefined) {
        throw new ItemNotFoundError(id);
      }

      const quantity = existing.quantity + input.delta;

      if (quantity < 0) {
        throw new InsufficientStockError(existing.quantity, -input.delta);
      }

      const updatedAt = this.#now();

      this.#db
        .prepare<{ id: string; quantity: number; updated_at: string }>(
          `UPDATE items
              SET quantity = @quantity, updated_at = @updated_at
            WHERE id = @id`,
        )
        .run({ id, quantity, updated_at: updatedAt });

      return toItem({ ...existing, quantity, updated_at: updatedAt });
    });

    return apply.immediate();
  }

  /** @throws {ItemNotFoundError} */
  delete(id: string): void {
    const result = this.#db
      .prepare<{ id: string }>('DELETE FROM items WHERE id = @id')
      .run({ id });

    if (result.changes === 0) {
      throw new ItemNotFoundError(id);
    }
  }

  #findById(id: string): ItemRow | undefined {
    return this.#db
      .prepare<{ id: string }, ItemRow>(
        `SELECT id, sku, name, quantity, created_at, updated_at
           FROM items
          WHERE id = @id`,
      )
      .get({ id });
  }
}
