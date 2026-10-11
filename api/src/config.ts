import { z } from 'zod';

/**
 * Process configuration, read once at startup.
 *
 * A malformed environment is a fatal misconfiguration, not something to paper
 * over with defaults that silently change behaviour, so parsing throws.
 */
const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_PATH: z.string().min(1).default('./inventory.db'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Valuation is optional: without a key the service still boots and the
  // endpoint returns a typed 503, which is explicit rather than a masked
  // degradation.
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  VALUATION_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO code')
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
