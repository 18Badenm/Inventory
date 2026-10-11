import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import {
  ValuationTimeoutError,
  ValuationUnreadableError,
  ValuationUpstreamError,
} from '../src/errors.js';
import type { Item, Photo } from '../src/items/model.js';
import { GeminiValuator } from '../src/valuation/gemini.js';
import type { GeminiValuatorOptions, ItemValuator } from '../src/valuation/gemini.js';
import type { Valuation } from '../src/valuation/model.js';

/**
 * A recognisable stand-in for a credential. Several tests assert it never
 * appears anywhere a client can see, so it must be distinctive.
 */
const TEST_API_KEY = 'test-key-must-never-leak';

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('JFIF payload bytes'),
]);

const PHOTO: Photo = {
  itemId: '00000000-0000-4000-8000-000000000000',
  contentType: 'image/jpeg',
  byteSize: JPEG_BYTES.byteLength,
  updatedAt: '2026-10-11T00:00:00.000Z',
  bytes: JPEG_BYTES,
};

// ---------------------------------------------------------------------------
// Stub transport
// ---------------------------------------------------------------------------

interface Outcome {
  readonly status?: number;
  readonly body?: unknown;
  /** Raw body, for asserting behaviour on a non-JSON reply. */
  readonly raw?: string;
}

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/**
 * A `fetch` that replays scripted outcomes and records what was sent. The last
 * outcome repeats, so a retry test scripts only the responses it cares about.
 */
function makeFetch(outcomes: readonly (Outcome | Error)[]): {
  readonly impl: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;

  const impl = (async (url: unknown, init: unknown) => {
    const request = (init ?? {}) as {
      headers?: Record<string, string>;
      body?: string;
    };

    calls.push({
      url: String(url),
      headers: request.headers ?? {},
      body: JSON.parse(request.body ?? '{}') as Record<string, unknown>,
    });

    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;

    if (outcome instanceof Error) {
      throw outcome;
    }

    return new Response(outcome.raw ?? JSON.stringify(outcome.body ?? {}), {
      status: outcome.status ?? 200,
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

/** Builds a minimal upstream success payload carrying `text` as the answer. */
function reply(
  text: string,
  extra: {
    readonly finishReason?: string;
    readonly groundingChunks?: readonly unknown[];
  } = {},
): Outcome {
  return {
    status: 200,
    body: {
      candidates: [
        {
          finishReason: extra.finishReason ?? 'STOP',
          content: { parts: [{ text }] },
          ...(extra.groundingChunks === undefined
            ? {}
            : { groundingMetadata: { groundingChunks: extra.groundingChunks } }),
        },
      ],
    },
  };
}

function build(
  outcomes: readonly (Outcome | Error)[],
  overrides: Partial<GeminiValuatorOptions> = {},
): { readonly valuator: GeminiValuator; readonly calls: Call[] } {
  const { impl, calls } = makeFetch(outcomes);

  const valuator = new GeminiValuator({
    apiKey: TEST_API_KEY,
    model: 'gemini-3.6-flash',
    timeoutMs: 20_000,
    currency: 'USD',
    grounding: false,
    fetchImpl: impl,
    // A retry must not cost real wall-clock in the suite.
    sleep: async () => {},
    ...overrides,
  });

  return { valuator, calls };
}

/** The image part of a recorded request. */
function inlineData(call: Call): { mimeType: string; data: string } {
  const contents = call.body.contents as readonly {
    parts: readonly { inlineData?: { mimeType: string; data: string } }[];
  }[];
  const part = contents[0].parts.find((candidate) => candidate.inlineData !== undefined);

  assert.ok(part?.inlineData !== undefined, 'request carries an inlineData part');

  return part.inlineData;
}

describe('GeminiValuator', () => {
  it('sends the photo and returns the identification and price', async () => {
    const { valuator, calls } = build([
      reply('{"name":"WD-40 Multi-Use Product 11 oz","price":{"amount":7.48,"currency":"USD"}}'),
    ]);

    const valuation = await valuator.valuate(PHOTO);

    assert.deepEqual(valuation, {
      name: 'WD-40 Multi-Use Product 11 oz',
      price: { amount: 7.48, currency: 'USD' },
      sources: [],
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      'posts to the configured model',
    );
    assert.equal(
      calls[0].headers['x-goog-api-key'],
      TEST_API_KEY,
      'key travels in a header',
    );
    assert.ok(
      !calls[0].url.includes(TEST_API_KEY),
      'key never appears in the URL, where it would reach access logs',
    );

    const image = inlineData(calls[0]);
    assert.equal(image.mimeType, 'image/jpeg', 'declares the stored media type');
    assert.equal(
      image.data,
      JPEG_BYTES.toString('base64'),
      'sends exactly the stored bytes, base64-encoded',
    );
  });

  it('asks for strict JSON and no search tool when grounding is off', async () => {
    const { valuator, calls } = build([reply('{"name":"Thing","price":null}')], {
      grounding: false,
    });

    await valuator.valuate(PHOTO);

    const config = calls[0].body.generationConfig as Record<string, unknown>;
    assert.equal(config.responseMimeType, 'application/json');
    assert.ok(config.responseJsonSchema !== undefined, 'declares a response schema');
    assert.equal(calls[0].body.tools, undefined, 'no search tool');
  });

  it('enables the search tool and drops strict JSON when grounding is on', async () => {
    const { valuator, calls } = build(
      [
        reply('{"name":"Thing","price":{"amount":5,"currency":"USD"}}', {
          groundingChunks: [
            { web: { uri: 'https://example.com/listing', title: 'A Listing' } },
          ],
        }),
      ],
      { grounding: true },
    );

    const valuation = await valuator.valuate(PHOTO);

    assert.deepEqual(calls[0].body.tools, [{ googleSearch: {} }]);

    const config = calls[0].body.generationConfig as Record<string, unknown>;
    assert.equal(
      config.responseJsonSchema,
      undefined,
      'strict JSON mode cannot be combined with the search tool',
    );
    assert.deepEqual(valuation.sources, [
      { uri: 'https://example.com/listing', title: 'A Listing' },
    ]);
  });

  it('reads a fenced JSON object', async () => {
    const { valuator } = build([
      reply('```json\n{"name":"Fenced","price":{"amount":1.5,"currency":"USD"}}\n```'),
    ]);

    assert.equal((await valuator.valuate(PHOTO)).name, 'Fenced');
  });

  it('reads a JSON object wrapped in prose', async () => {
    const { valuator } = build([
      reply(
        'Based on the listings I found:\n{"name":"Wrapped","price":{"amount":2,"currency":"USD"}}\nHope that helps.',
      ),
    ]);

    const valuation = await valuator.valuate(PHOTO);

    assert.equal(valuation.name, 'Wrapped');
    assert.deepEqual(valuation.price, { amount: 2, currency: 'USD' });
  });

  it('joins answer parts and ignores the reasoning parts', async () => {
    const { valuator } = build([
      {
        status: 200,
        body: {
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  { text: 'I should ignore the label.', thought: true },
                  { text: '{"name":"Split","price":', thoughtSignature: 'sig' },
                  { text: '{"amount":3.25,"currency":"USD"}}' },
                ],
              },
            },
          ],
        },
      },
    ]);

    const valuation = await valuator.valuate(PHOTO);

    assert.equal(valuation.name, 'Split', 'a thought part is not parsed as the answer');
    assert.deepEqual(valuation.price, { amount: 3.25, currency: 'USD' });
  });

  it('returns a null price when the model establishes none', async () => {
    const { valuator } = build([reply('{"name":"Unmarked grey box","price":null}')]);

    const valuation = await valuator.valuate(PHOTO);

    assert.equal(valuation.name, 'Unmarked grey box');
    assert.equal(valuation.price, null, 'no price is reported as null, not as zero');
  });

  it('rounds a price to minor units', async () => {
    const { valuator } = build([
      reply('{"name":"Rounded","price":{"amount":7.4800000000000004,"currency":"USD"}}'),
    ]);

    assert.equal((await valuator.valuate(PHOTO)).price?.amount, 7.48);
  });

  it('trims whitespace from the identification', async () => {
    const { valuator } = build([
      reply('{"name":"  Padded Name  ","price":null}'),
    ]);

    assert.equal((await valuator.valuate(PHOTO)).name, 'Padded Name');
  });

  describe('rejects an answer it cannot stand behind', () => {
    const unreadable: readonly (readonly [string, Outcome])[] = [
      ['a currency we did not ask for', reply('{"name":"X","price":{"amount":5,"currency":"EUR"}}')],
      ['a non-numeric amount', reply('{"name":"X","price":{"amount":"5","currency":"USD"}}')],
      ['a zero amount', reply('{"name":"X","price":{"amount":0,"currency":"USD"}}')],
      ['a negative amount', reply('{"name":"X","price":{"amount":-5,"currency":"USD"}}')],
      ['an implausible amount', reply('{"name":"X","price":{"amount":99999999,"currency":"USD"}}')],
      ['an empty name', reply('{"name":"","price":null}')],
      ['a missing name', reply('{"price":null}')],
      ['a missing price field', reply('{"name":"X"}')],
      ['prose with no JSON at all', reply('I am not able to identify this product.')],
      ['an empty answer', reply('')],
      ['a truncated completion', reply('{"name":"X","price":null}', { finishReason: 'MAX_TOKENS' })],
      ['a filtered completion', reply('{"name":"X","price":null}', { finishReason: 'SAFETY' })],
      ['no candidates', { status: 200, body: { candidates: [] } }],
      ['a blocked prompt', { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }],
      ['a non-JSON HTTP body', { status: 200, raw: 'not json at all' }],
    ];

    for (const [label, outcome] of unreadable) {
      it(`rejects ${label}`, async () => {
        const { valuator } = build([outcome]);

        await assert.rejects(
          () => valuator.valuate(PHOTO),
          (error: unknown) => {
            assert.ok(
              error instanceof ValuationUnreadableError,
              `expected ValuationUnreadableError, got ${String(error)}`,
            );
            assert.equal(error.code, 'valuation_unreadable');
            assert.ok(
              !error.message.includes(TEST_API_KEY),
              'the credential is not in the message',
            );
            return true;
          },
        );
      });
    }
  });

  it('retries once on a transient upstream status and then succeeds', async () => {
    const { valuator, calls } = build([
      { status: 503, body: { error: { status: 'UNAVAILABLE' } } },
      reply('{"name":"Recovered","price":{"amount":9.99,"currency":"USD"}}'),
    ]);

    const valuation = await valuator.valuate(PHOTO);

    assert.equal(valuation.name, 'Recovered');
    assert.equal(calls.length, 2, 'retried exactly once');
  });

  it('gives up after one retry and reports the upstream status', async () => {
    const { valuator, calls } = build([
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } },
    ]);

    await assert.rejects(
      () => valuator.valuate(PHOTO),
      (error: unknown) => {
        assert.ok(error instanceof ValuationUpstreamError);
        assert.equal(error.code, 'valuation_upstream_failed');
        assert.equal(error.statusCode, 502);
        assert.equal(error.upstreamStatus, 429, 'records the status for operators');
        return true;
      },
    );

    assert.equal(calls.length, 2, 'bounded: one attempt plus one retry');
  });

  it('bounds the whole operation by the timeout, not each attempt', async () => {
    // A clock that jumps 15s per reading: the first attempt consumes most of a
    // 20s budget, so there must not be a second full-length one.
    let clock = 0;
    const { valuator, calls } = build(
      [{ status: 503, body: {} }],
      {
        timeoutMs: 20_000,
        now: () => {
          clock += 15_000;
          return clock;
        },
      },
    );

    await assert.rejects(
      () => valuator.valuate(PHOTO),
      (error: unknown) => {
        assert.ok(
          error instanceof ValuationUpstreamError,
          'reports the upstream status rather than inventing a retry it has no budget for',
        );
        assert.equal(error.upstreamStatus, 503);
        return true;
      },
    );

    assert.equal(calls.length, 1, 'no retry once the budget is spent');
  });

  it('reports a timeout when the budget is gone before the first attempt', async () => {
    const { valuator, calls } = build([reply('{"name":"X","price":null}')], {
      timeoutMs: 1000,
      now: () => 10_000_000,
    });

    // now() returns a constant, so `deadline - now()` is negative immediately.
    const { valuator: expired, calls: expiredCalls } = build(
      [reply('{"name":"X","price":null}')],
      { timeoutMs: -1, now: () => 0 },
    );

    await assert.rejects(() => expired.valuate(PHOTO), ValuationTimeoutError);
    assert.equal(expiredCalls.length, 0, 'nothing is sent with no budget');

    // Sanity: the same stub succeeds when there is budget.
    assert.equal((await valuator.valuate(PHOTO)).name, 'X');
    assert.equal(calls.length, 1);
  });

  it('does not retry a non-transient upstream status', async () => {
    const { valuator, calls } = build([
      { status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } },
    ]);

    await assert.rejects(() => valuator.valuate(PHOTO), ValuationUpstreamError);
    assert.equal(calls.length, 1);
  });

  it('never echoes the upstream body, which can quote the request back', async () => {
    const { valuator } = build([
      {
        status: 400,
        body: { error: { message: `key ${TEST_API_KEY} rejected for model x` } },
      },
    ]);

    await assert.rejects(
      () => valuator.valuate(PHOTO),
      (error: unknown) => {
        assert.ok(error instanceof ValuationUpstreamError);
        assert.ok(
          !error.message.includes(TEST_API_KEY),
          'the credential is not echoed from the upstream body',
        );
        assert.ok(
          !error.message.includes('rejected for model'),
          'the upstream message is not forwarded',
        );
        return true;
      },
    );
  });

  it('reports a timeout distinctly from an upstream failure', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });
    const { valuator } = build([timeout], { timeoutMs: 1234 });

    await assert.rejects(
      () => valuator.valuate(PHOTO),
      (error: unknown) => {
        assert.ok(error instanceof ValuationTimeoutError);
        assert.equal(error.code, 'valuation_timeout');
        assert.equal(error.statusCode, 504);
        assert.equal(error.timeoutMs, 1234);
        return true;
      },
    );
  });

  it('reports a transport failure without a status', async () => {
    const { valuator } = build([new TypeError('fetch failed')]);

    await assert.rejects(
      () => valuator.valuate(PHOTO),
      (error: unknown) => {
        assert.ok(error instanceof ValuationUpstreamError);
        assert.equal(error.upstreamStatus, null);
        return true;
      },
    );
  });

  it('keeps only https sources, deduplicated and capped', async () => {
    const { valuator } = build(
      [
        reply('{"name":"Sourced","price":{"amount":5,"currency":"USD"}}', {
          groundingChunks: [
            { web: { uri: 'javascript:alert(1)', title: 'Hostile' } },
            { web: { uri: 'http://insecure.example.com/a', title: 'Plaintext' } },
            { web: { uri: 'not a url at all', title: 'Malformed' } },
            { web: { uri: 'https://a.example.com/1', title: 'First' } },
            { web: { uri: 'https://a.example.com/1', title: 'Duplicate' } },
            { web: { uri: 'https://b.example.com/2', title: '   ' } },
            { retrievedContext: { uri: 'https://c.example.com/3' } },
            { web: { uri: 'https://d.example.com/4', title: 'Third' } },
            { web: { uri: 'https://e.example.com/5', title: 'Fourth' } },
            { web: { uri: 'https://f.example.com/6', title: 'Fifth' } },
            { web: { uri: 'https://g.example.com/7', title: 'Beyond the cap' } },
          ],
        }),
      ],
      { grounding: true },
    );

    const { sources } = await valuator.valuate(PHOTO);

    assert.deepEqual(sources, [
      { uri: 'https://a.example.com/1', title: 'First' },
      { uri: 'https://b.example.com/2', title: null },
      { uri: 'https://d.example.com/4', title: 'Third' },
      { uri: 'https://e.example.com/5', title: 'Fourth' },
      { uri: 'https://f.example.com/6', title: 'Fifth' },
    ]);
  });

  it('asks for the configured currency', async () => {
    const { valuator, calls } = build(
      [reply('{"name":"X","price":{"amount":5,"currency":"GBP"}}')],
      { currency: 'GBP' },
    );

    const valuation = await valuator.valuate(PHOTO);

    assert.deepEqual(valuation.price, { amount: 5, currency: 'GBP' });

    const instruction = JSON.stringify(calls[0].body.systemInstruction);
    assert.ok(instruction.includes('GBP'), 'the currency is named in the instruction');
  });

  it('tells the model that text in the photo is not an instruction', async () => {
    const { valuator, calls } = build([reply('{"name":"X","price":null}')]);

    await valuator.valuate(PHOTO);

    const instruction = JSON.stringify(calls[0].body.systemInstruction);
    assert.ok(
      instruction.includes('never as instructions'),
      'the photo is untrusted input and the prompt says so',
    );
  });
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const VALUATION: Valuation = {
  name: 'WD-40 Multi-Use Product 11 oz',
  price: { amount: 7.48, currency: 'USD' },
  sources: [{ uri: 'https://example.com/listing', title: 'A Listing' }],
};

/** Records what the route handed it, so the route's own job can be asserted. */
class StubValuator implements ItemValuator {
  readonly received: Photo[] = [];

  constructor(private readonly outcome: Valuation | Error = VALUATION) {}

  async valuate(photo: Photo): Promise<Valuation> {
    this.received.push(photo);

    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    return this.outcome;
  }
}

let db: Database;
let app: FastifyInstance;
let valuator: StubValuator;

/** Boots the app with the given valuator wiring. */
async function start(wired: ItemValuator | null): Promise<void> {
  app = buildApp({ db, logLevel: 'silent', valuator: wired });
  await app.ready();
}

async function createItem(sku: string): Promise<Item> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/items',
    payload: { sku, name: 'Lubricant Spray', quantity: 1 },
  });
  assert.equal(response.statusCode, 201, `setup failed: ${response.body}`);
  return response.json<Item>();
}

async function attachPhoto(id: string): Promise<void> {
  const response = await app.inject({
    method: 'PUT',
    url: `/v1/items/${id}/photo`,
    headers: { 'content-type': 'image/jpeg' },
    payload: JPEG_BYTES,
  });
  assert.equal(response.statusCode, 200, `setup failed: ${response.body}`);
}

describe('POST /v1/items/:id/valuation', () => {
  // Scoped to this suite: the valuator tests above drive the class directly and
  // boot no app for a hook to tear down.
  beforeEach(() => {
    db = openDatabase(':memory:');
    valuator = new StubValuator();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('values the item from its stored photo', async () => {
    await start(valuator);
    const item = await createItem('WD-40');
    await attachPhoto(item.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), VALUATION);

    assert.equal(valuator.received.length, 1, 'the upstream was called once');
    assert.ok(
      JPEG_BYTES.equals(valuator.received[0].bytes),
      'it was given the bytes actually stored for this item',
    );
    assert.equal(valuator.received[0].contentType, 'image/jpeg');
    assert.equal(valuator.received[0].itemId, item.id);
  });

  it('persists nothing', async () => {
    await start(valuator);
    const item = await createItem('WD-40');
    await attachPhoto(item.id);

    const before = await app.inject({ method: 'GET', url: `/v1/items/${item.id}` });
    await app.inject({ method: 'POST', url: `/v1/items/${item.id}/valuation` });
    const after = await app.inject({ method: 'GET', url: `/v1/items/${item.id}` });

    assert.deepEqual(
      after.json<Item>(),
      before.json<Item>(),
      'a valuation leaves the item row untouched',
    );
  });

  it('reports 404 when the item has no photo', async () => {
    await start(valuator);
    const item = await createItem('NO-PHOTO');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'photo_not_found');
    assert.equal(valuator.received.length, 0, 'nothing is sent upstream');
  });

  it('reports 404 for an unknown item', async () => {
    await start(valuator);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/items/11111111-1111-4111-8111-111111111111/valuation',
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'item_not_found');
    assert.equal(valuator.received.length, 0);
  });

  it('rejects a malformed id before touching the upstream', async () => {
    await start(valuator);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/items/not-a-uuid/valuation',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_failed');
    assert.equal(valuator.received.length, 0);
  });

  it('reports that valuation is unconfigured rather than failing opaquely', async () => {
    await start(null);
    const item = await createItem('WD-40');
    await attachPhoto(item.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'valuation_not_configured');
  });

  it('maps an upstream failure to 502 without leaking diagnostics', async () => {
    await start(new StubValuator(new ValuationUpstreamError(429)));
    const item = await createItem('WD-40');
    await attachPhoto(item.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      error: {
        code: 'valuation_upstream_failed',
        message: 'The valuation service is unavailable. Please try again later.',
      },
    });
    assert.ok(!response.body.includes('429'), 'the upstream status stays in the logs');
  });

  it('maps an unreadable answer to 502 and keeps the detail out of the body', async () => {
    await start(
      new StubValuator(new ValuationUnreadableError('expected a price in USD, got EUR')),
    );
    const item = await createItem('WD-40');
    await attachPhoto(item.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'valuation_unreadable');
    assert.ok(!response.body.includes('EUR'), 'the operator detail is not sent to clients');
  });

  it('maps a timeout to 504', async () => {
    await start(new StubValuator(new ValuationTimeoutError(20_000)));
    const item = await createItem('WD-40');
    await attachPhoto(item.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/items/${item.id}/valuation`,
    });

    assert.equal(response.statusCode, 504);
    assert.equal(response.json().error.code, 'valuation_timeout');
  });
});
