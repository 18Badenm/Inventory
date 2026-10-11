import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z, ZodError, ZodTypeAny } from 'zod';
import {
  PhotoTooLargeError,
  UnsupportedImageTypeError,
  ValidationError,
} from '../errors.js';
import {
  detectImageType,
  MAX_PHOTO_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from './image.js';
import type { ItemRepository } from './repository.js';
import {
  adjustStockSchema,
  createItemSchema,
  itemIdSchema,
  listQuerySchema,
  updateItemSchema,
} from './model.js';

function toValidationError(error: ZodError): ValidationError {
  return new ValidationError(
    error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  );
}

/**
 * Single validation boundary: nothing downstream of here sees unparsed input,
 * and a failure is always a typed ValidationError rather than a raw ZodError
 * leaking its internal shape to the client.
 */
function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw toValidationError(result.error);
  }

  return result.data;
}

interface IdParams {
  readonly id: string;
}

export function registerItemRoutes(
  app: FastifyInstance,
  repository: ItemRepository,
): void {
  app.get(
    '/v1/items',
    (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
      const query = parse(listQuerySchema, request.query);
      return reply.code(200).send(repository.list(query));
    },
  );

  app.post(
    '/v1/items',
    (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
      const input = parse(createItemSchema, request.body);
      const item = repository.create(input);
      return reply.code(201).header('location', `/v1/items/${item.id}`).send(item);
    },
  );

  app.get(
    '/v1/items/:id',
    (
      request: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): FastifyReply => {
      const id = parse(itemIdSchema, request.params.id);
      return reply.code(200).send(repository.getById(id));
    },
  );

  app.patch(
    '/v1/items/:id',
    (
      request: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): FastifyReply => {
      const id = parse(itemIdSchema, request.params.id);
      const patch = parse(updateItemSchema, request.body);
      return reply.code(200).send(repository.update(id, patch));
    },
  );

  app.post(
    '/v1/items/:id/adjust',
    (
      request: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): FastifyReply => {
      const id = parse(itemIdSchema, request.params.id);
      const input = parse(adjustStockSchema, request.body);
      return reply.code(200).send(repository.adjustStock(id, input));
    },
  );

  /**
   * The photo is sent as a raw image body rather than multipart: there is
   * exactly one file and no accompanying fields, so multipart would add a
   * dependency and a parser for no gain.
   */
  app.put(
    '/v1/items/:id/photo',
    (
      request: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): FastifyReply => {
      const id = parse(itemIdSchema, request.params.id);
      const body = request.body;

      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new ValidationError([
          { path: '(body)', message: 'Expected a non-empty image body' },
        ]);
      }

      if (body.byteLength > MAX_PHOTO_BYTES) {
        throw new PhotoTooLargeError(MAX_PHOTO_BYTES);
      }

      // The declared Content-Type is advisory; the stored type comes from the
      // bytes, so a mislabelled payload cannot be served back under a type it
      // is not.
      const contentType = detectImageType(body);

      if (contentType === null) {
        throw new UnsupportedImageTypeError(SUPPORTED_IMAGE_TYPES);
      }

      const photo = repository.setPhoto(id, body, contentType);

      return reply.code(200).send(photo);
    },
  );

  app.get(
    '/v1/items/:id/photo',
    (
      request: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): FastifyReply => {
      const id = parse(itemIdSchema, request.params.id);
      const photo = repository.getPhoto(id);

      // Strong validator: the bytes change only when updatedAt does.
      const etag = `"${photo.updatedAt}-${photo.byteSize}"`;

      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      return reply
        .code(200)
        .header('content-type', photo.contentType)
        .header('content-length', String(photo.byteSize))
        .header('etag', etag)
        .header('cache-control', 'private, must-revalidate')
        .send(photo.bytes);
    },
  );

  app.delete(
    '/v1/items/:id/photo',
    (
      request: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): FastifyReply => {
      const id = parse(itemIdSchema, request.params.id);
      repository.deletePhoto(id);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/v1/items/:id',
    (
      request: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): FastifyReply => {
      const id = parse(itemIdSchema, request.params.id);
      repository.delete(id);
      return reply.code(204).send();
    },
  );
}
