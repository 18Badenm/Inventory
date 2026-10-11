import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import {
  InsufficientStockError,
  ItemNotFoundError,
  PhotoNotFoundError,
  SkuAlreadyExistsError,
} from '../errors.js';
import type { SupportedImageType } from './image.js';
import type {
  AdjustStockInput,
  CreateItemInput,
  Item,
  ListQuery,
  Page,
  Photo,
  PhotoMetadata,
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
  readonly photo_updated_at: string | null;
}

/**
 * Shared projection. Every read of an item reports whether it has a photo, so
 * the client never needs a second request to find out.
 */
const ITEM_COLUMNS = `i.id, i.sku, i.name, i.quantity, i.created_at, i.updated_at,
         p.updated_at AS photo_updated_at`;

const ITEM_SOURCE = `items i LEFT JOIN item_photos p ON p.item_id = i.id`;

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    quantity: row.quantity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    photoUpdatedAt: row.photo_updated_at,
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
        : `WHERE i.sku LIKE @pattern ESCAPE '\\' OR i.name LIKE @pattern ESCAPE '\\'`;

    const rows = this.#db
      .prepare<
        { pattern: string | null; limit: number; offset: number },
        ItemRow
      >(
        `SELECT ${ITEM_COLUMNS}
           FROM ${ITEM_SOURCE}
           ${where}
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ pattern, limit, offset });

    const counted = this.#db
      .prepare<{ pattern: string | null }, { total: number }>(
        `SELECT COUNT(*) AS total FROM items i ${where}`,
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
      // A new item has no photo yet; the column is only ever set by setPhoto.
      photo_updated_at: null,
    };

    try {
      this.#db
        .prepare<{
          id: string;
          sku: string;
          name: string;
          quantity: number;
          created_at: string;
          updated_at: string;
        }>(
          `INSERT INTO items (id, sku, name, quantity, created_at, updated_at)
           VALUES (@id, @sku, @name, @quantity, @created_at, @updated_at)`,
        )
        // Bound explicitly rather than spreading the row: the driver rejects
        // named parameters the statement does not use.
        .run({
          id: row.id,
          sku: row.sku,
          name: row.name,
          quantity: row.quantity,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
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

  /**
   * Stores or replaces the item's photo and returns its metadata. The item's
   * own `updated_at` is deliberately left alone: attaching a photo does not
   * change the stock record.
   *
   * @throws {ItemNotFoundError}
   */
  setPhoto(
    itemId: string,
    bytes: Buffer,
    contentType: SupportedImageType,
  ): PhotoMetadata {
    const apply = this.#db.transaction((): PhotoMetadata => {
      if (this.#findById(itemId) === undefined) {
        throw new ItemNotFoundError(itemId);
      }

      const timestamp = this.#now();

      // The upsert keeps created_at from the first upload so it records when
      // the item first got a photo, not when it was last replaced.
      this.#db
        .prepare<{
          item_id: string;
          content_type: string;
          byte_size: number;
          bytes: Buffer;
          created_at: string;
          updated_at: string;
        }>(
          `INSERT INTO item_photos
             (item_id, content_type, byte_size, bytes, created_at, updated_at)
           VALUES
             (@item_id, @content_type, @byte_size, @bytes, @created_at, @updated_at)
           ON CONFLICT (item_id) DO UPDATE SET
             content_type = excluded.content_type,
             byte_size    = excluded.byte_size,
             bytes        = excluded.bytes,
             updated_at   = excluded.updated_at`,
        )
        .run({
          item_id: itemId,
          content_type: contentType,
          byte_size: bytes.byteLength,
          bytes,
          created_at: timestamp,
          updated_at: timestamp,
        });

      return {
        itemId,
        contentType,
        byteSize: bytes.byteLength,
        updatedAt: timestamp,
      };
    });

    return apply.immediate();
  }

  /**
   * @throws {ItemNotFoundError} when the item itself does not exist.
   * @throws {PhotoNotFoundError} when the item exists but has no photo.
   */
  getPhoto(itemId: string): Photo {
    if (this.#findById(itemId) === undefined) {
      throw new ItemNotFoundError(itemId);
    }

    const row = this.#db
      .prepare<
        { item_id: string },
        {
          content_type: string;
          byte_size: number;
          bytes: Buffer;
          updated_at: string;
        }
      >(
        `SELECT content_type, byte_size, bytes, updated_at
           FROM item_photos
          WHERE item_id = @item_id`,
      )
      .get({ item_id: itemId });

    if (row === undefined) {
      throw new PhotoNotFoundError(itemId);
    }

    return {
      itemId,
      contentType: row.content_type,
      byteSize: row.byte_size,
      bytes: row.bytes,
      updatedAt: row.updated_at,
    };
  }

  /**
   * @throws {ItemNotFoundError}
   * @throws {PhotoNotFoundError}
   */
  deletePhoto(itemId: string): void {
    const apply = this.#db.transaction((): void => {
      if (this.#findById(itemId) === undefined) {
        throw new ItemNotFoundError(itemId);
      }

      const result = this.#db
        .prepare<{ item_id: string }>(
          'DELETE FROM item_photos WHERE item_id = @item_id',
        )
        .run({ item_id: itemId });

      if (result.changes === 0) {
        throw new PhotoNotFoundError(itemId);
      }
    });

    apply.immediate();
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
        `SELECT ${ITEM_COLUMNS}
           FROM ${ITEM_SOURCE}
          WHERE i.id = @id`,
      )
      .get({ id });
  }
}
