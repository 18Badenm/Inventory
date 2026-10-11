import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Database } from './db.js';
import {
  AppError,
  PhotoTooLargeError,
  UnsupportedImageTypeError,
  ValidationError,
} from './errors.js';
import { MAX_PHOTO_BYTES, SUPPORTED_IMAGE_TYPES } from './items/image.js';
import { ItemRepository } from './items/repository.js';
import type { ItemValuator } from './valuation/gemini.js';
import { registerItemRoutes } from './items/routes.js';

export interface AppOptions {
  readonly db: Database;
  readonly logLevel: Config['LOG_LEVEL'];
  /** `null` when no API key is configured; the route then returns 503. */
  readonly valuator?: ItemValuator | null;
}

/**
 * Wire-format error envelope. Every non-2xx response has this shape, so a
 * client has exactly one error contract to code against.
 */
interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly { readonly path: string; readonly message: string }[];
  };
}

/**
 * Reads a 4xx status off an error Fastify itself raised (bad JSON, wrong
 * content type, body too large). Returns undefined for anything else, which
 * is then treated as a server-side bug.
 */
function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { statusCode } = error as { statusCode?: unknown };

  return typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
    ? statusCode
    : undefined;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel },
    // Trust the length Fastify computed; reject anything larger than a
    // plausible item payload rather than buffering it.
    bodyLimit: 64 * 1024,
  });

  // Photos arrive as raw image bodies. Registered with their own, much higher
  // bodyLimit so the small global limit still applies to every JSON endpoint.
  app.addContentTypeParser(
    [...SUPPORTED_IMAGE_TYPES],
    { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const repository = new ItemRepository(options.db);

  app.get('/health', (_request, reply) =>
    reply.code(200).send({ status: 'ok' }),
  );

  registerItemRoutes(app, repository, options.valuator ?? null);

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: {
        code: 'route_not_found',
        message: `No route for ${request.method} ${request.url}.`,
      },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) {
      request.log.info({ issues: error.issues }, 'request rejected');
      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          issues: error.issues,
        },
      };
      return reply.code(error.statusCode).send(body);
    }

    if (error instanceof AppError) {
      request.log.info({ code: error.code }, error.message);
      const body: ErrorBody = {
        error: { code: error.code, message: error.message },
      };
      return reply.code(error.statusCode).send(body);
    }

    // Fastify rejects an oversized or wrongly-typed payload before any handler
    // runs, so translate those two into the same typed errors a handler would
    // have raised rather than reporting them as a generic bad request.
    const fastifyCode = (error as { code?: unknown }).code;

    if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      request.log.info('photo rejected: too large');
      const tooLarge = new PhotoTooLargeError(MAX_PHOTO_BYTES);
      const body: ErrorBody = {
        error: { code: tooLarge.code, message: tooLarge.message },
      };
      return reply.code(tooLarge.statusCode).send(body);
    }

    if (fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      request.log.info('photo rejected: unsupported media type');
      const unsupported = new UnsupportedImageTypeError(SUPPORTED_IMAGE_TYPES);
      const body: ErrorBody = {
        error: { code: unsupported.code, message: unsupported.message },
      };
      return reply.code(unsupported.statusCode).send(body);
    }

    // A malformed body or unsupported content type is the client's mistake;
    // Fastify already classified it, so pass the status through with a code of
    // ours and without echoing the driver's message.
    const clientStatus = clientErrorStatus(error);

    if (clientStatus !== undefined) {
      request.log.info({ err: error }, 'malformed request');
      const body: ErrorBody = {
        error: {
          code: 'bad_request',
          message: 'The request could not be parsed.',
        },
      };
      return reply.code(clientStatus).send(body);
    }

    // Anything else is a bug. Log it in full for operators; tell the client
    // nothing beyond the fact that it failed.
    request.log.error({ err: error }, 'unhandled error');
    const body: ErrorBody = {
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      },
    };
    return reply.code(500).send(body);
  });

  return app;
}
