import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
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

describe('unknown routes', () => {
  it('return a 404 in the standard error envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'route_not_found');
  });
});
