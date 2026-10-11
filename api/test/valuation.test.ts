import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import type { Item } from '../src/items/model.js';
import { GeminiValuator, stripCodeFence } from '../src/valuation/gemini.js';
import { sanitiseSources } from '../src/valuation/model.js';

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('payload'),
]);

const API_KEY = 'test-key-never-logged';

let db: Database;

interface Captured {
  url: string;
  init: RequestInit;
}

/** Records the outgoing request and replies with whatever the test supplies. */
function stubFetch(
  reply: () => Promise<Response> | Response,
  captured: Captured[] = [],
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A well-formed Gemini reply, with overridable parts. */
function geminiReply(options: {
  text?: string;
  parts?: { text: string }[];
  finishReason?: string;
  groundingUris?: string[];
  blockReason?: string;
}): unknown {
  const body: Record<string, unknown> = {};

  if (options.blockReason !== undefined) {
    body.promptFeedback = { blockReason: options.blockReason };
    return body;
  }

  body.candidates = [
    {
      finishReason: options.finishReason ?? 'STOP',
      content: {
        parts: options.parts ?? [{ text: options.text ?? '' }],
      },
      groundingMetadata:
        options.groundingUris === undefined
          ? undefined
          : {
              groundingChunks: options.groundingUris.map((uri) => ({
                web: { uri, title: 'Listing' },
              })),
            },
    },
  ];

  return body;
}

function valuator(
  reply: () => Promise<Response> | Response,
  captured: Captured[] = [],
): GeminiValuator {
  return new GeminiValuator({
    apiKey: API_KEY,
    model: 'gemini-2.5-flash',
    timeoutMs: 5000,
    currency: 'USD',
    fetchImpl: stubFetch(reply, captured),
    now: () => new Date('2026-10-11T12:00:00.000Z'),
  });
}

const PHOTO = {
  itemId: '3f1870a4-3b1f-4a1e-9a4f-6b0f0d4a1c77',
  contentType: 'image/jpeg',
  byteSize: JPEG_BYTES.byteLength,
  bytes: JPEG_BYTES,
  updatedAt: '2026-10-11T11:00:00.000Z',
};

describe('GeminiValuator request', () => {
  it('sends the stored bytes and MIME type, keyed by header, with search grounding', async () => {
    const captured: Captured[] = [];
    const subject = valuator(
      () =>
        jsonResponse(
          geminiReply({
            text: '{"name":"Drill","price":{"amount":45.5,"currency":"USD"}}',
          }),
        ),
      captured,
    );

    await subject.valuate(PHOTO);

    assert.equal(captured.length, 1);
    const [call] = captured;
    assert.ok(call !== undefined);
    assert.match(call.url, /models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(call.init.method, 'POST');

    const headers = call.init.headers as Record<string, string>;
    assert.equal(
      headers['x-goog-api-key'],
      API_KEY,
      'the key travels in a header, not the query string',
    );

    const body = JSON.parse(String(call.init.body));
    const inline = body.contents[0].parts[1].inline_data;
    assert.equal(inline.mime_type, 'image/jpeg');
    assert.equal(
      inline.data,
      JPEG_BYTES.toString('base64'),
      'the exact stored bytes are sent, base64-encoded',
    );
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    assert.equal(body.generationConfig.temperature, 0);
  });
});

describe('GeminiValuator reply handling', () => {
  it('parses a plain JSON reply', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          text: '{"name":"Cordless Drill","price":{"amount":45.5,"currency":"USD"}}',
        }),
      ),
    );

    const result = await subject.valuate(PHOTO);

    assert.equal(result.itemId, PHOTO.itemId);
    assert.equal(result.name, 'Cordless Drill');
    assert.deepEqual(result.price, { amount: 45.5, currency: 'USD' });
    assert.equal(result.model, 'gemini-2.5-flash');
    assert.equal(result.valuedAt, '2026-10-11T12:00:00.000Z');
  });

  it('parses a reply wrapped in a code fence', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          text: '```json\n{"name":"Lamp","price":null}\n```',
        }),
      ),
    );

    const result = await subject.valuate(PHOTO);

    assert.equal(result.name, 'Lamp');
    assert.equal(result.price, null);
  });

  it('joins text split across multiple parts', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          parts: [
            { text: '{"name":"Split ' },
            { text: 'Answer","price":' },
            { text: 'null}' },
          ],
        }),
      ),
    );

    const result = await subject.valuate(PHOTO);

    assert.equal(result.name, 'Split Answer');
  });

  it('treats a null price as a real answer, not a failure', async () => {
    const subject = valuator(() =>
      jsonResponse(geminiReply({ text: '{"name":"Unidentifiable","price":null}' })),
    );

    const result = await subject.valuate(PHOTO);

    assert.equal(result.price, null);
    assert.equal(result.name, 'Unidentifiable');
  });

  it('rejects a price in the wrong currency rather than relabelling it', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          text: '{"name":"Drill","price":{"amount":45.5,"currency":"EUR"}}',
        }),
      ),
    );

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => error.name === 'ValuationUnreadableError',
    );
  });

  it('rejects a price with more than two decimal places', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          text: '{"name":"Drill","price":{"amount":45.555,"currency":"USD"}}',
        }),
      ),
    );

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => error.name === 'ValuationUnreadableError',
    );
  });

  it('rejects a negative price', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          text: '{"name":"Drill","price":{"amount":-5,"currency":"USD"}}',
        }),
      ),
    );

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => error.name === 'ValuationUnreadableError',
    );
  });

  it('rejects prose that is not JSON', async () => {
    const subject = valuator(() =>
      jsonResponse(geminiReply({ text: 'It looks like a drill, maybe $40?' })),
    );

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => error.name === 'ValuationUnreadableError',
    );
  });

  it('rejects a truncated answer', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          text: '{"name":"Drill","price":null}',
          finishReason: 'MAX_TOKENS',
        }),
      ),
    );

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => error.name === 'ValuationUnreadableError',
    );
  });

  it('rejects a blocked prompt', async () => {
    const subject = valuator(() => jsonResponse(geminiReply({ blockReason: 'SAFETY' })));

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => error.name === 'ValuationUnreadableError',
    );
  });

  it('maps an upstream 429 and 500 to an upstream failure', async () => {
    for (const status of [429, 500]) {
      const subject = valuator(() => jsonResponse({ error: 'nope' }, status));

      await assert.rejects(
        () => subject.valuate(PHOTO),
        (error: Error) => error.name === 'ValuationUpstreamError',
      );
    }
  });

  it('maps a timeout to a timeout error', async () => {
    const subject = valuator(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => error.name === 'ValuationTimeoutError',
    );
  });

  it('never puts the API key or the upstream body in the error', async () => {
    const subject = valuator(() =>
      jsonResponse({ error: { message: `bad key ${API_KEY}` } }, 403),
    );

    await assert.rejects(
      () => subject.valuate(PHOTO),
      (error: Error) => {
        assert.ok(
          !error.message.includes(API_KEY),
          'the key must never reach a thrown message',
        );
        assert.ok(!error.message.includes('bad key'));
        return true;
      },
    );
  });

  it('takes sources from grounding metadata and drops non-https', async () => {
    const subject = valuator(() =>
      jsonResponse(
        geminiReply({
          text: '{"name":"Drill","price":null}',
          groundingUris: [
            'https://example.com/a',
            'http://insecure.example.com/b',
            'https://example.com/a',
            'javascript:alert(1)',
            'https://example.com/c',
          ],
        }),
      ),
    );

    const result = await subject.valuate(PHOTO);

    assert.deepEqual(
      result.sources.map((source) => source.uri),
      ['https://example.com/a', 'https://example.com/c'],
      'http, duplicates and javascript: are all dropped',
    );
  });
});

describe('source sanitising', () => {
  it('caps the list at five', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      uri: `https://example.com/${index}`,
    }));

    assert.equal(sanitiseSources(many).length, 5);
  });

  it('strips fences with and without a language tag', () => {
    assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
  });
});

describe('POST /v1/items/:id/valuation', () => {
  let app: FastifyInstance;

  async function createItemWithPhoto(): Promise<Item> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      payload: { sku: 'VAL-1', name: 'Thing' },
    });
    const item = created.json<Item>();

    await app.inject({
      method: 'PUT',
      url: `/v1/items/${item.id}/photo`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });

    return item;
  }

  afterEach(async () => {
    await app.close();
    db.close();
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('returns a valuation for an item with a photo', async () => {
    app = buildApp({
      db,
      logLevel: 'silent',
      valuator: valuator(() =>
        jsonResponse(
          geminiReply({
            text: '{"name":"Cordless Drill","price":{"amount":45.5,"currency":"USD"}}',
            groundingUris: ['https://example.com/listing'],
          }),
        ),
      ),
    });
    await app.ready();
    const item = await createItemWithPhoto();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.itemId, item.id);
    assert.equal(body.name, 'Cordless Drill');
    assert.deepEqual(body.price, { amount: 45.5, currency: 'USD' });
    assert.deepEqual(body.sources, [
      { uri: 'https://example.com/listing', title: 'Listing' },
    ]);
  });

  it('returns 503 when no key is configured', async () => {
    app = buildApp({ db, logLevel: 'silent', valuator: null });
    await app.ready();
    const item = await createItemWithPhoto();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'valuation_not_configured');
  });

  it('returns 404 for an item with no photo, without calling upstream', async () => {
    const captured: Captured[] = [];
    app = buildApp({
      db,
      logLevel: 'silent',
      valuator: valuator(() => jsonResponse(geminiReply({ text: '{}' })), captured),
    });
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      payload: { sku: 'VAL-2', name: 'No photo' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${created.json<Item>().id}/valuation`,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'photo_not_found');
    assert.equal(captured.length, 0, 'no paid upstream call for a missing photo');
  });

  it('returns 404 for an unknown item', async () => {
    app = buildApp({
      db,
      logLevel: 'silent',
      valuator: valuator(() => jsonResponse(geminiReply({ text: '{}' }))),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/items/3f1870a4-3b1f-4a1e-9a4f-6b0f0d4a1c77/valuation',
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'item_not_found');
  });

  it('returns 400 for an id that is not a UUID', async () => {
    app = buildApp({
      db,
      logLevel: 'silent',
      valuator: valuator(() => jsonResponse(geminiReply({ text: '{}' }))),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/items/not-a-uuid/valuation',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_failed');
  });

  it('surfaces an upstream failure as 502 without leaking the key', async () => {
    app = buildApp({
      db,
      logLevel: 'silent',
      valuator: valuator(() => jsonResponse({ error: API_KEY }, 500)),
    });
    await app.ready();
    const item = await createItemWithPhoto();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'valuation_upstream_failed');
    assert.ok(
      !response.body.includes(API_KEY),
      'the key must never reach a response body',
    );
  });
});
