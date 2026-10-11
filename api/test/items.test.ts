import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { MAX_PHOTO_BYTES } from '../src/items/image.js';
import type { Item, Page } from '../src/items/model.js';

let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = buildApp({ db, logLevel: 'silent' });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

/** Reads a row straight from storage, bypassing the API under test. */
interface StoredRow {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
}

function storedRow(id: string): StoredRow | undefined {
  return db
    .prepare<{ id: string }, StoredRow>(
      'SELECT sku, name, quantity FROM items WHERE id = @id',
    )
    .get({ id });
}

function countRows(): number {
  const row = db
    .prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM items')
    .get();
  return row?.total ?? 0;
}

async function createItem(payload: Record<string, unknown>): Promise<Item> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/items',
    payload,
  });
  assert.equal(response.statusCode, 201, `setup failed: ${response.body}`);
  return response.json<Item>();
}

describe('GET /health', () => {
  it('reports ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });
});

describe('POST /v1/items', () => {
  it('persists a normalised item and returns it with a location header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/items',
      payload: { sku: '  wd-40 ', name: '  Lubricant Spray  ', quantity: 12 },
    });
    const item = response.json<Item>();

    assert.equal(response.statusCode, 201);
    assert.equal(response.headers.location, `/v1/items/${item.id}`);
    assert.equal(item.sku, 'WD-40', 'SKU is trimmed and upper-cased');
    assert.equal(item.name, 'Lubricant Spray', 'name is trimmed');
    assert.equal(item.quantity, 12);
    assert.match(
      item.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(item.createdAt, item.updatedAt);
    assert.deepEqual(storedRow(item.id), {
      sku: 'WD-40',
      name: 'Lubricant Spray',
      quantity: 12,
    });
  });

  it('defaults quantity to zero when omitted', async () => {
    const item = await createItem({ sku: 'BOLT-1', name: 'Bolt' });

    assert.equal(item.quantity, 0);
    assert.equal(storedRow(item.id)?.quantity, 0);
  });

  it('rejects a duplicate SKU with 409 and leaves the original intact', async () => {
    const first = await createItem({ sku: 'DUP-1', name: 'First' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/items',
      payload: { sku: 'dup-1', name: 'Second' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'sku_already_exists');
    assert.equal(countRows(), 1, 'the duplicate was not inserted');
    assert.equal(storedRow(first.id)?.name, 'First');
  });

  it('rejects an invalid SKU with field-level issues and writes nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/items',
      payload: { sku: 'bad sku!', name: 'Thing' },
    });
    const body = response.json();

    assert.equal(response.statusCode, 400);
    assert.equal(body.error.code, 'validation_failed');
    assert.deepEqual(body.error.issues, [
      {
        path: 'sku',
        message: 'SKU may contain only letters, digits and dashes',
      },
    ]);
    assert.equal(countRows(), 0);
  });

  it('rejects a negative or fractional quantity', async () => {
    const negative = await app.inject({
      method: 'POST',
      url: '/v1/items',
      payload: { sku: 'NEG-1', name: 'Thing', quantity: -1 },
    });
    const fractional = await app.inject({
      method: 'POST',
      url: '/v1/items',
      payload: { sku: 'FRA-1', name: 'Thing', quantity: 1.5 },
    });

    assert.equal(negative.statusCode, 400);
    assert.equal(
      negative.json().error.issues[0].message,
      'Quantity must not be negative',
    );
    assert.equal(fractional.statusCode, 400);
    assert.equal(
      fractional.json().error.issues[0].message,
      'Quantity must be a whole number',
    );
    assert.equal(countRows(), 0);
  });

  it('rejects a malformed JSON body without leaking parser internals', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"sku": "X-1",',
    });
    const body = response.json();

    assert.equal(response.statusCode, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.message, 'The request could not be parsed.');
    assert.equal(body.error.stack, undefined);
  });
});

describe('GET /v1/items/:id', () => {
  it('returns the stored item', async () => {
    const created = await createItem({ sku: 'GET-1', name: 'Widget', quantity: 3 });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/items/${created.id}`,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<Item>(), created);
  });

  it('returns 404 for an unknown id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/items/3f1870a4-3b1f-4a1e-9a4f-6b0f0d4a1c77',
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'item_not_found');
  });

  it('returns 400 for an id that is not a UUID', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/items/42' });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_failed');
  });
});

describe('PATCH /v1/items/:id', () => {
  it('applies a partial update and touches updatedAt only', async () => {
    const created = await createItem({ sku: 'PAT-1', name: 'Old', quantity: 5 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${created.id}`,
      payload: { name: 'New' },
    });
    const updated = response.json<Item>();

    assert.equal(response.statusCode, 200);
    assert.equal(updated.name, 'New');
    assert.equal(updated.quantity, 5, 'omitted field is left alone');
    assert.equal(updated.sku, 'PAT-1');
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(storedRow(created.id), {
      sku: 'PAT-1',
      name: 'New',
      quantity: 5,
    });
  });

  it('sets quantity absolutely', async () => {
    const created = await createItem({ sku: 'PAT-2', name: 'Thing', quantity: 5 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${created.id}`,
      payload: { quantity: 0 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json<Item>().quantity, 0);
    assert.equal(storedRow(created.id)?.quantity, 0);
  });

  it('rejects an empty patch and changes nothing', async () => {
    const created = await createItem({ sku: 'PAT-3', name: 'Thing', quantity: 5 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${created.id}`,
      payload: {},
    });

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.json().error.issues[0].message,
      'Provide at least one of "name" or "quantity"',
    );
    assert.deepEqual(storedRow(created.id), {
      sku: 'PAT-3',
      name: 'Thing',
      quantity: 5,
    });
  });

  it('ignores an attempt to change the SKU', async () => {
    const created = await createItem({ sku: 'PAT-4', name: 'Thing' });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${created.id}`,
      payload: { name: 'Renamed', sku: 'HIJACK-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json<Item>().sku, 'PAT-4');
    assert.equal(storedRow(created.id)?.sku, 'PAT-4');
  });

  it('returns 404 for an unknown id', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/items/3f1870a4-3b1f-4a1e-9a4f-6b0f0d4a1c77',
      payload: { name: 'Ghost' },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'item_not_found');
  });
});

describe('POST /v1/items/:id/adjust', () => {
  it('adds stock', async () => {
    const created = await createItem({ sku: 'ADJ-1', name: 'Thing', quantity: 4 });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${created.id}/adjust`,
      payload: { delta: 6 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json<Item>().quantity, 10);
    assert.equal(storedRow(created.id)?.quantity, 10);
  });

  it('removes stock down to exactly zero', async () => {
    const created = await createItem({ sku: 'ADJ-2', name: 'Thing', quantity: 3 });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${created.id}/adjust`,
      payload: { delta: -3 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json<Item>().quantity, 0);
    assert.equal(storedRow(created.id)?.quantity, 0);
  });

  it('refuses to go below zero, reporting what is available, and does not write', async () => {
    const created = await createItem({ sku: 'ADJ-3', name: 'Thing', quantity: 2 });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${created.id}/adjust`,
      payload: { delta: -5 },
    });
    const body = response.json();

    assert.equal(response.statusCode, 422);
    assert.equal(body.error.code, 'insufficient_stock');
    assert.equal(
      body.error.message,
      'Cannot remove 5 unit(s): only 2 in stock.',
    );
    assert.equal(
      storedRow(created.id)?.quantity,
      2,
      'the rejected adjustment left the quantity untouched',
    );
  });

  it('rejects a zero delta', async () => {
    const created = await createItem({ sku: 'ADJ-4', name: 'Thing', quantity: 2 });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${created.id}/adjust`,
      payload: { delta: 0 },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.json().error.issues[0].message,
      'Delta must not be zero',
    );
    assert.equal(storedRow(created.id)?.quantity, 2);
  });

  it('applies sequential adjustments cumulatively', async () => {
    const created = await createItem({ sku: 'ADJ-5', name: 'Thing', quantity: 0 });

    for (const delta of [5, -2, 7, -1]) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/items/${created.id}/adjust`,
        payload: { delta },
      });
      assert.equal(response.statusCode, 200);
    }

    assert.equal(storedRow(created.id)?.quantity, 9);
  });
});

describe('DELETE /v1/items/:id', () => {
  it('removes the row and returns 204', async () => {
    const created = await createItem({ sku: 'DEL-1', name: 'Thing' });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/items/${created.id}`,
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');
    assert.equal(storedRow(created.id), undefined);
    assert.equal(countRows(), 0);
  });

  it('returns 404 when deleting twice', async () => {
    const created = await createItem({ sku: 'DEL-2', name: 'Thing' });

    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/items/${created.id}`,
    });
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/items/${created.id}`,
    });

    assert.equal(first.statusCode, 204);
    assert.equal(second.statusCode, 404);
    assert.equal(second.json().error.code, 'item_not_found');
  });
});

describe('GET /v1/items', () => {
  it('returns an empty page when there is nothing stored', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/items' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<Page<Item>>(), {
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it('paginates newest first and reports the unpaginated total', async () => {
    for (const sku of ['L-1', 'L-2', 'L-3']) {
      await createItem({ sku, name: `Item ${sku}` });
    }

    const response = await app.inject({
      method: 'GET',
      url: '/v1/items?limit=2&offset=0',
    });
    const page = response.json<Page<Item>>();

    assert.equal(response.statusCode, 200);
    assert.equal(page.total, 3, 'total counts every row, not just this page');
    assert.equal(page.limit, 2);
    assert.equal(page.items.length, 2);

    const second = await app.inject({
      method: 'GET',
      url: '/v1/items?limit=2&offset=2',
    });
    const secondPage = second.json<Page<Item>>();

    assert.equal(secondPage.items.length, 1);

    const seen = [...page.items, ...secondPage.items].map((item) => item.sku);
    assert.equal(new Set(seen).size, 3, 'pages do not overlap');
  });

  it('filters by SKU or name fragment, case-insensitively', async () => {
    await createItem({ sku: 'HAM-1', name: 'Hammer' });
    await createItem({ sku: 'SCR-1', name: 'Screwdriver' });

    const byName = await app.inject({
      method: 'GET',
      url: '/v1/items?search=hammer',
    });
    const bySku = await app.inject({
      method: 'GET',
      url: '/v1/items?search=SCR',
    });

    assert.deepEqual(
      byName.json<Page<Item>>().items.map((item) => item.sku),
      ['HAM-1'],
    );
    assert.deepEqual(
      bySku.json<Page<Item>>().items.map((item) => item.sku),
      ['SCR-1'],
    );
  });

  it('treats LIKE wildcards in the search term as literal characters', async () => {
    await createItem({ sku: 'PCT-1', name: 'Hammer' });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/items?search=%25',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json<Page<Item>>().items,
      [],
      'a bare % must not match every row',
    );
  });

  it('rejects an out-of-range limit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/items?limit=5000',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_failed');
  });
});

/** Smallest byte sequences that carry each format's magic number. */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('JFIF payload bytes'),
]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR payload bytes'),
]);
/** An ISO-BMFF `ftyp` box with the `heic` brand, as an iPhone camera emits. */
const HEIC_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic'),
  Buffer.from('mif1heic payload'),
]);

function storedPhoto(
  itemId: string,
): { content_type: string; byte_size: number; bytes: Buffer } | undefined {
  return db
    .prepare<
      { id: string },
      { content_type: string; byte_size: number; bytes: Buffer }
    >(
      'SELECT content_type, byte_size, bytes FROM item_photos WHERE item_id = @id',
    )
    .get({ id: itemId });
}

describe('PUT /v1/items/:id/photo', () => {
  it('stores the bytes and reports the photo on the item', async () => {
    const item = await createItem({ sku: 'PH-1', name: 'Thing' });
    assert.equal(item.photoUpdatedAt, null, 'a new item has no photo');

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });
    const metadata = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(metadata.itemId, item.id);
    assert.equal(metadata.contentType, 'image/jpeg');
    assert.equal(metadata.byteSize, JPEG_BYTES.byteLength);

    const stored = storedPhoto(item.id);
    assert.equal(stored?.content_type, 'image/jpeg');
    assert.equal(stored?.byte_size, JPEG_BYTES.byteLength);
    assert.ok(
      stored !== undefined && JPEG_BYTES.equals(stored.bytes),
      'the stored blob is byte-for-byte what was uploaded',
    );

    // The item now advertises the photo, so no extra request is needed to
    // discover it.
    const refetched = await app.inject({
      method: 'GET',
      url: `/v1/items/${item.id}`,
    });
    assert.equal(refetched.json<Item>().photoUpdatedAt, metadata.updatedAt);
  });

  it('accepts PNG and HEIC', async () => {
    const png = await createItem({ sku: 'PH-PNG', name: 'Png' });
    const heic = await createItem({ sku: 'PH-HEIC', name: 'Heic' });

    const pngResponse = await app.inject({
      method: 'PUT',
      url: `/v1/items/${png.id}/photo`,
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    const heicResponse = await app.inject({
      method: 'PUT',
      url: `/v1/items/${heic.id}/photo`,
      headers: { 'content-type': 'image/heic' },
      payload: HEIC_BYTES,
    });

    assert.equal(pngResponse.statusCode, 200);
    assert.equal(pngResponse.json().contentType, 'image/png');
    assert.equal(heicResponse.statusCode, 200);
    assert.equal(heicResponse.json().contentType, 'image/heic');
  });

  it('replaces an existing photo instead of adding a second', async () => {
    const item = await createItem({ sku: 'PH-2', name: 'Thing' });

    await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });
    const second = await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });

    assert.equal(second.statusCode, 200);

    const count = db
      .prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM item_photos')
      .get();
    assert.equal(count?.total, 1, 'one photo per item');

    const stored = storedPhoto(item.id);
    assert.equal(stored?.content_type, 'image/png');
    assert.ok(
      stored !== undefined && PNG_BYTES.equals(stored.bytes),
      'the newer bytes won',
    );
  });

  it('derives the type from the bytes, not the declared Content-Type', async () => {
    const item = await createItem({ sku: 'PH-3', name: 'Thing' });

    // Claims JPEG, is actually a PNG.
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: PNG_BYTES,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().contentType,
      'image/png',
      'the sniffed type is stored, so the bytes cannot be served under a false label',
    );
    assert.equal(storedPhoto(item.id)?.content_type, 'image/png');
  });

  it('rejects a non-image payload with 415 and stores nothing', async () => {
    const item = await createItem({ sku: 'PH-4', name: 'Thing' });

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from('<svg onload="alert(1)"></svg>'),
    });

    assert.equal(response.statusCode, 415);
    assert.equal(response.json().error.code, 'unsupported_image_type');
    assert.equal(storedPhoto(item.id), undefined);
  });

  it('rejects an unsupported media type with 415', async () => {
    const item = await createItem({ sku: 'PH-5', name: 'Thing' });

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/gif' },
      payload: Buffer.from('GIF89a'),
    });

    assert.equal(response.statusCode, 415);
    assert.equal(response.json().error.code, 'unsupported_image_type');
    assert.equal(storedPhoto(item.id), undefined);
  });

  it('rejects an empty body', async () => {
    const item = await createItem({ sku: 'PH-6', name: 'Thing' });

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.alloc(0),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_failed');
    assert.equal(storedPhoto(item.id), undefined);
  });

  it('rejects a photo over the size limit with 413', async () => {
    const item = await createItem({ sku: 'PH-7', name: 'Thing' });
    const oversized = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(MAX_PHOTO_BYTES, 0x41),
    ]);

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: oversized,
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, 'photo_too_large');
    assert.equal(storedPhoto(item.id), undefined);
  });

  it('returns 404 for an unknown item', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/items/3f1870a4-3b1f-4a1e-9a4f-6b0f0d4a1c77/photo',
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'item_not_found');
  });
});

describe('GET /v1/items/:id/photo', () => {
  it('serves the exact bytes with the sniffed content type', async () => {
    const item = await createItem({ sku: 'PG-1', name: 'Thing' });
    await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/items/${item.id}/photo`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.ok(
      JPEG_BYTES.equals(response.rawPayload),
      'the response body is byte-for-byte the uploaded image',
    );
  });

  it('revalidates with an ETag and answers 304 when unchanged', async () => {
    const item = await createItem({ sku: 'PG-2', name: 'Thing' });
    await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });

    const first = await app.inject({
      method: 'GET',
      url: `/v1/items/${item.id}/photo`,
    });
    const etag = first.headers.etag;
    assert.ok(typeof etag === 'string' && etag.length > 0);

    const second = await app.inject({
      method: 'GET',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'if-none-match': etag },
    });

    assert.equal(second.statusCode, 304);
    assert.equal(second.rawPayload.byteLength, 0, 'a 304 carries no body');
  });

  it('returns 404 when the item has no photo', async () => {
    const item = await createItem({ sku: 'PG-3', name: 'Thing' });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/items/${item.id}/photo`,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'photo_not_found');
  });

  it('distinguishes a missing item from a missing photo', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/items/3f1870a4-3b1f-4a1e-9a4f-6b0f0d4a1c77/photo',
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'item_not_found');
  });
});

describe('DELETE /v1/items/:id/photo', () => {
  it('removes the photo but keeps the item', async () => {
    const item = await createItem({ sku: 'PD-1', name: 'Thing', quantity: 4 });
    await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/items/${item.id}/photo`,
    });

    assert.equal(response.statusCode, 204);
    assert.equal(storedPhoto(item.id), undefined);
    assert.equal(storedRow(item.id)?.quantity, 4, 'the item survived');

    const refetched = await app.inject({
      method: 'GET',
      url: `/v1/items/${item.id}`,
    });
    assert.equal(refetched.json<Item>().photoUpdatedAt, null);
  });

  it('returns 404 when there is no photo to delete', async () => {
    const item = await createItem({ sku: 'PD-2', name: 'Thing' });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/items/${item.id}/photo`,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'photo_not_found');
  });
});

describe('deleting an item', () => {
  it('cascades to its photo, leaving no orphaned blob', async () => {
    const item = await createItem({ sku: 'CA-1', name: 'Thing' });
    await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });
    assert.notEqual(storedPhoto(item.id), undefined);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/items/${item.id}`,
    });

    assert.equal(response.statusCode, 204);
    assert.equal(
      storedPhoto(item.id),
      undefined,
      'ON DELETE CASCADE removed the blob with its row',
    );
  });
});

describe('unknown routes', () => {
  it('return a 404 in the standard error envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'route_not_found');
  });
});
