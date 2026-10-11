import { z } from 'zod';

/** An inventory item as stored and as returned over the wire. */
export interface Item {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * A SKU is an operator-facing identifier printed on labels and scanned, so it
 * is deliberately narrow: upper-case alphanumerics and dashes. Input is
 * trimmed and upper-cased before validation so "  ab-1 " and "AB-1" are the
 * same SKU and cannot both be created.
 */
export const skuSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(1, 'SKU must not be empty')
      .max(64, 'SKU must be at most 64 characters')
      .regex(
        /^[A-Z0-9-]+$/,
        'SKU may contain only letters, digits and dashes',
      ),
  );

export const nameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'Name must not be empty')
      .max(200, 'Name must be at most 200 characters'),
  );

export const quantitySchema = z
  .number()
  .int('Quantity must be a whole number')
  .min(0, 'Quantity must not be negative')
  .max(1_000_000_000, 'Quantity is implausibly large');

export const createItemSchema = z.object({
  sku: skuSchema,
  name: nameSchema,
  quantity: quantitySchema.default(0),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;

/**
 * A patch must change something; an empty body is a client bug rather than a
 * silent no-op. `sku` is intentionally immutable — it is the identifier other
 * systems key on.
 */
export const updateItemSchema = z
  .object({
    name: nameSchema.optional(),
    quantity: quantitySchema.optional(),
  })
  .refine(
    (patch) => patch.name !== undefined || patch.quantity !== undefined,
    { message: 'Provide at least one of "name" or "quantity"' },
  );

export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const adjustStockSchema = z.object({
  delta: z
    .number()
    .int('Delta must be a whole number')
    .refine((value) => value !== 0, { message: 'Delta must not be zero' })
    .refine((value) => Math.abs(value) <= 1_000_000, {
      message: 'Delta must be between -1000000 and 1000000',
    }),
});

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const itemIdSchema = z.string().uuid('Item id must be a UUID');
