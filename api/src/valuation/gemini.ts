import {
  ValuationTimeoutError,
  ValuationUnreadableError,
  ValuationUpstreamError,
} from '../errors.js';
import type { Photo } from '../items/model.js';
import {
  modelReplySchema,
  sanitiseSources,
  type Source,
  type Valuation,
} from './model.js';

/**
 * Estimates what a photographed item is and what it is worth.
 *
 * A protocol rather than a concrete client, so routes depend on the capability
 * and tests can substitute a stub — the same seam the iOS layer uses.
 */
export interface ItemValuator {
  valuate(photo: Photo): Promise<Valuation>;
}

export interface GeminiValuatorOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly currency: string;
  /** Injected so the request can be asserted without network access. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Strips a ```json … ``` fence, which the model adds despite being asked not to. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

export class GeminiValuator implements ItemValuator {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #currency: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: GeminiValuatorOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs;
    this.#currency = options.currency;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async valuate(photo: Photo): Promise<Valuation> {
    const response = await this.#post(this.#buildRequestBody(photo));
    const payload = await this.#readJSON(response);

    return this.#toValuation(photo.itemId, payload);
  }

  #prompt(): string {
    return [
      'You are appraising a second-hand item from a photograph.',
      'Search the web for comparable recent sale listings before answering.',
      '',
      'Reply with JSON only, no prose and no code fences, in exactly this shape:',
      '{"name": string, "price": {"amount": number, "currency": "' +
        this.#currency +
        '"} | null, "sources": [{"uri": string, "title": string}]}',
      '',
      '- "name" is a short description of the item, at most 200 characters.',
      '- "price" is the realistic current resale value in ' +
        this.#currency +
        ', to at most two decimal places.',
      '- Use null for "price" when the photo does not show enough to value it.',
      '  A null price is correct and expected; never guess a number.',
      '- "sources" are the https URLs of listings you relied on.',
    ].join('\n');
  }

  #buildRequestBody(photo: Photo): string {
    return JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: this.#prompt() },
            {
              inline_data: {
                mime_type: photo.contentType,
                data: photo.bytes.toString('base64'),
              },
            },
          ],
        },
      ],
      // Grounding in real listings is the whole point: an ungrounded guess is
      // exactly what this must not produce.
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 },
    });
  }

  async #post(body: string): Promise<Response> {
    const url = `${ENDPOINT}/${encodeURIComponent(this.#model)}:generateContent`;

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Header rather than a query parameter, so the key cannot end up in
          // a proxy or server access log.
          'x-goog-api-key': this.#apiKey,
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      if (!response.ok) {
        throw new ValuationUpstreamError();
      }

      return response;
    } catch (error) {
      if (error instanceof ValuationUpstreamError) {
        throw error;
      }

      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new ValuationTimeoutError();
      }

      // The underlying message may name the host or echo the request; it is
      // logged by the caller, never surfaced.
      throw new ValuationUpstreamError();
    }
  }

  async #readJSON(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ValuationUnreadableError();
    }
  }

  #toValuation(itemId: string, payload: unknown): Valuation {
    const envelope = payload as {
      candidates?: {
        content?: { parts?: { text?: unknown }[] };
        finishReason?: unknown;
        groundingMetadata?: {
          groundingChunks?: { web?: { uri?: unknown; title?: unknown } }[];
        };
      }[];
      promptFeedback?: { blockReason?: unknown };
    };

    // A blocked prompt or a truncated answer is not a valuation; treating
    // either as one would mean reporting a partial reply as fact.
    if (envelope.promptFeedback?.blockReason !== undefined) {
      throw new ValuationUnreadableError();
    }

    const candidate = envelope.candidates?.[0];

    if (candidate === undefined || candidate.finishReason !== 'STOP') {
      throw new ValuationUnreadableError();
    }

    // Grounded replies arrive split across several text parts.
    const text = (candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');

    if (text.trim() === '') {
      throw new ValuationUnreadableError();
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(stripCodeFence(text));
    } catch {
      throw new ValuationUnreadableError();
    }

    const reply = modelReplySchema.safeParse(parsed);

    if (!reply.success) {
      throw new ValuationUnreadableError();
    }

    // A price in some other currency is not comparable with the rest of the
    // system, so it is rejected rather than silently relabelled.
    if (
      reply.data.price !== null &&
      reply.data.price.currency !== this.#currency
    ) {
      throw new ValuationUnreadableError();
    }

    return {
      itemId,
      name: reply.data.name,
      price: reply.data.price,
      sources: this.#sources(candidate.groundingMetadata, reply.data.sources),
      model: this.#model,
      valuedAt: this.#now().toISOString(),
    };
  }

  /**
   * Prefers the grounding metadata, which records what the service actually
   * retrieved, over URLs the model wrote into its own reply.
   */
  #sources(
    metadata: { groundingChunks?: { web?: { uri?: unknown; title?: unknown } }[] } | undefined,
    replySources: readonly { uri: string; title?: string | undefined }[] | undefined,
  ): Source[] {
    const grounded = (metadata?.groundingChunks ?? [])
      .map((chunk) => chunk.web)
      .filter(
        (web): web is { uri: string; title?: string } =>
          typeof web?.uri === 'string',
      )
      .map((web) => ({
        uri: web.uri,
        title: typeof web.title === 'string' ? web.title : null,
      }));

    if (grounded.length > 0) {
      return sanitiseSources(grounded);
    }

    return sanitiseSources(replySources ?? []);
  }
}
