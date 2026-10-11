import { z } from 'zod';

/** A single web source the model grounded its answer in. */
export interface Source {
  readonly uri: string;
  readonly title: string | null;
}

export interface Price {
  readonly amount: number;
  readonly currency: string;
}

/** What the API returns for a valuation request. */
export interface Valuation {
  readonly itemId: string;
  /** What the model thinks the photographed thing is. */
  readonly name: string;
  /**
   * `null` when no value could be determined. That is a documented outcome,
   * not a swallowed failure: a guessed price would be worse than no price.
   */
  readonly price: Price | null;
  readonly sources: readonly Source[];
  readonly model: string;
  readonly valuedAt: string;
}

/**
 * The shape the model is asked to reply in.
 *
 * Validated rather than trusted: a reply that does not conform is an error,
 * never a guessed price. `amount` must be finite, positive and at most two
 * decimal places; the currency must match the one configured for this server.
 */
export const modelReplySchema = z.object({
  name: z.string().trim().min(1).max(200),
  price: z
    .object({
      amount: z
        .number()
        .finite()
        .positive()
        .max(1_000_000_000)
        .refine(
          (value) => Number.isInteger(Math.round(value * 100)) &&
            Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
          { message: 'Amount must have at most two decimal places' },
        ),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .nullable(),
  sources: z
    .array(
      z.object({
        uri: z.string().min(1),
        title: z.string().trim().min(1).max(300).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export type ModelReply = z.infer<typeof modelReplySchema>;

export const MAX_SOURCES = 5;

/**
 * Keeps only `https:` sources, de-duplicated by URI and capped.
 *
 * Anything else — `http:`, `data:`, `javascript:` — is dropped rather than
 * passed to a client that may render it as a link.
 */
export function sanitiseSources(
  candidates: readonly { uri: string; title?: string | null | undefined }[],
): Source[] {
  const seen = new Set<string>();
  const kept: Source[] = [];

  for (const candidate of candidates) {
    if (kept.length >= MAX_SOURCES) {
      break;
    }

    let parsed: URL;

    try {
      parsed = new URL(candidate.uri);
    } catch {
      continue;
    }

    if (parsed.protocol !== 'https:' || seen.has(parsed.href)) {
      continue;
    }

    seen.add(parsed.href);
    kept.push({
      uri: parsed.href,
      title: candidate.title?.trim() ? candidate.title.trim() : null,
    });
  }

  return kept;
}
