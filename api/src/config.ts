import { z } from 'zod';

/**
 * Process configuration, read once at startup.
 *
 * A malformed environment is a fatal misconfiguration, not something to paper
 * over with defaults that silently change behaviour, so parsing throws.
 */
/**
 * Treats an unset variable and an empty one as the same thing, so a
 * `GEMINI_API_KEY=` left in a .env file reads as "not configured" rather than
 * failing the whole boot over a zero-length string.
 */
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_PATH: z.string().min(1).default('./inventory.db'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /**
   * Gemini credentials for item valuation. Optional: without a key the service
   * boots and serves every other route, and the valuation endpoint reports
   * `valuation_not_configured` rather than pretending to work.
   */
  GEMINI_API_KEY: optionalSecret,
  /**
   * Model IDs are retired on Google's schedule, not ours — `gemini-2.5-flash`
   * is still listed by the models endpoint but already refuses new callers —
   * so this is configuration rather than a constant edited at release time.
   */
  GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),

  /**
   * Google Search grounding backs a price with live listings and returns their
   * URLs, which is what makes a valuation auditable. It is a billed feature:
   * on a key without that quota every grounded call fails with a hard 429, so
   * it can be switched off in exchange for an unsourced estimate.
   */
  VALUATION_GROUNDING: z.enum(['on', 'off']).default('on'),
  /** ISO-4217. A price with no currency is not a price. */
  VALUATION_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO-4217 code')
    .default('USD'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  return result.data;
}
