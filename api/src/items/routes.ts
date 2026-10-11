import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z, ZodError, ZodTypeAny } from 'zod';
import { ValidationError } from '../errors.js';
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
