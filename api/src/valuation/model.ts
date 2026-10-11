import { z } from 'zod';

/** A price. Never an amount on its own — a number without a currency is not a price. */
export interface Price {
  readonly amount: number;
  readonly currency: string;
}

/** A listing the price was read from. Present only when grounding is enabled. */
export interface ValuationSource {
  readonly uri: string;
  readonly title: string | null;
}

/**
 * What the valuation endpoint returns: the two things asked of it — what the
 * product is, and what it is worth — plus the evidence behind the second.
 *
 * `price` is `null` when the product was identified but no price could be
 * established. That is a real outcome (an unbranded object, a photo of a wall)
 * and is reported as one, not substituted with a guess or an error.
 */
export interface Valuation {
  readonly name: string;
  readonly price: Price | null;
  readonly sources: readonly ValuationSource[];
}

/**
 * The contract the model's reply must satisfy.
 *
 * Deliberately strict. Everything downstream of this parse is trusted, and the
 * text being parsed is a language model's free-form output, so a reply that
 * does not conform is rejected rather than coerced into shape.
 */
export const modelReplySchema = z.object({
  name: z.string().trim().min(1).max(200),
  price: z
    .object({
      amount: z
        .number()
        .finite('Price amount must be a finite number')
        .positive('Price amount must be greater than zero')
        .max(10_000_000, 'Price amount is implausibly large'),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO-4217 code'),
    })
    .nullable(),
});

export type ModelReply = z.infer<typeof modelReplySchema>;

/**
 * Rounds to minor units. The model returns a decimal of arbitrary precision
 * (`7.4800000000000004`); money has two places, and normalising that is not
 * the same as repairing a malformed reply.
 */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100) / 100;
}
