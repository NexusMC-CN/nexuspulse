import { InvalidSubscriptionInputError, MissingUserError } from "./errors.js";
import fp from "fastify-plugin";
import type {
  FastifyInstanceLike,
  FastifyPluginOptions,
  FastifyRequestLike,
  PushSubscriptionInput,
} from "./types.js";

function routePath(prefix: string, suffix: string): string {
  const normalized =
    prefix === "/" ? "" : `/${prefix.replace(/^\/+|\/+$/g, "")}`;
  const normalizedSuffix = `/${suffix.replace(/^\/+/, "")}`;
  return `${normalized}${normalizedSuffix}` || "/";
}

function bodySubscription(body: unknown): PushSubscriptionInput {
  const candidate =
    body && typeof body === "object" && "subscription" in body
      ? (body as { subscription?: unknown }).subscription
      : body;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as { endpoint?: unknown }).endpoint !== "string" ||
    !(candidate as { endpoint: string }).endpoint
  ) {
    throw new InvalidSubscriptionInputError(
      "Body must contain a push subscription endpoint",
    );
  }
  return candidate as PushSubscriptionInput;
}

function parameterId(request: FastifyRequestLike): string | undefined {
  const params = request.params;
  if (!params || typeof params !== "object") return undefined;
  const id = (params as { id?: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

export function createNexusPulseFastifyPlugin(options: FastifyPluginOptions) {
  const prefix = options.prefix ?? "/nexuspulse";
  const resolveUserId = options.resolveUserId;

  const registerNexusPulseFastify = async function registerNexusPulseFastify(
    fastify: FastifyInstanceLike,
  ): Promise<void> {
    fastify.decorate?.("nexusPulse", options.service);
    fastify.post(
      routePath(prefix, "/subscriptions"),
      async (request, reply) => {
        const userId = await resolveUserId(request);
        if (!userId)
          return reply.code(401).send({ error: new MissingUserError().name });
        try {
          const subscription = await options.service.subscribe(
            userId,
            bodySubscription(request.body),
          );
          return reply.code(201).send(subscription);
        } catch (error) {
          if (error instanceof InvalidSubscriptionInputError) {
            return reply
              .code(400)
              .send({ error: error.name, message: error.message });
          }
          throw error;
        }
      },
    );
    fastify.delete(
      routePath(prefix, "/subscriptions/:id"),
      async (request, reply) => {
        const userId = await resolveUserId(request);
        if (!userId)
          return reply.code(401).send({ error: new MissingUserError().name });
        const id = parameterId(request);
        if (!id)
          return reply.code(400).send({ error: "InvalidSubscriptionId" });
        const removed = await options.service.unsubscribe(userId, id);
        if (!removed)
          return reply.code(404).send({ error: "SubscriptionNotFound" });
        return reply.code(204).send();
      },
    );
    if (options.websocket) {
      if (!fastify.get) {
        throw new Error(
          "WebSocket support requires a Fastify WebSocket integration",
        );
      }
      fastify.get(
        routePath(prefix, options.websocket.path ?? "/websocket"),
        { websocket: true },
        async (socket, request) => {
          const userId = await resolveUserId(request);
          if (!userId) {
            if (
              socket &&
              typeof socket === "object" &&
              "close" in socket &&
              typeof (socket as { close?: unknown }).close === "function"
            ) {
              (
                socket as { close: (code: number, reason: string) => void }
              ).close(1008, "Unauthorized");
            }
            return;
          }
          return options.websocket?.onWebSocket(
            socket,
            request,
            userId,
            options.service,
          );
        },
      );
    }
  };

  return registerNexusPulseFastify;
}

/**
 * Fastify is intentionally loaded only from this optional adapter entrypoint.
 * The host remains responsible for authentication, CSRF protection, rate
 * limiting, request body limits, and the application's error envelope.
 */
export const nexusPulseFastify = fp(
  async (fastify, options: FastifyPluginOptions) => {
    await createNexusPulseFastifyPlugin(options)(
      fastify as unknown as FastifyInstanceLike,
    );
  },
  { name: "nexuspulse-server" },
);

export type NexusPulseFastifyPlugin = ReturnType<
  typeof createNexusPulseFastifyPlugin
>;

export default nexusPulseFastify;
