import type { NotificationPayload } from "nexuspulse/protocol";

export type {
  NotificationAction,
  NotificationPayload,
} from "nexuspulse/protocol";

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}

export interface PushSubscriptionRecord extends PushSubscriptionInput {
  id: string;
  userId: string;
}

export interface SubscriptionStore {
  /** Implementations should treat the endpoint as the user's subscription identity. */
  upsert(
    userId: string,
    subscription: PushSubscriptionInput,
  ): Promise<PushSubscriptionRecord>;
  /** Removing an unknown id should be idempotent and return false. */
  removeForUser(userId: string, id: string): Promise<boolean>;
  listByUser(userId: string): Promise<PushSubscriptionRecord[]>;
}

export interface SubscriptionValidationOptions {
  /** Exact endpoint origins accepted by the host. */
  allowedEndpointOrigins?: readonly string[];
  /** Host-owned endpoint policy, including DNS/IP egress checks. */
  validateEndpoint?: (endpoint: URL) => boolean | Promise<boolean>;
}

export type NotificationChannel = "push" | "websocket";

export interface PushTransport {
  send(
    subscription: PushSubscriptionRecord,
    payload: NotificationPayload,
    signal?: AbortSignal,
  ): Promise<void>;
  isInvalidError?(error: unknown): boolean;
}

export interface RealtimeTransport {
  publish(userId: string, payload: NotificationPayload): Promise<void>;
}

export interface PushDispatchOptions {
  /** Maximum number of subscriptions delivered at once. Defaults to 8. */
  concurrency?: number;
  /** Per-attempt timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Number of retries after the initial attempt. Defaults to 2. */
  retries?: number;
  /** Delay before the first retry. Defaults to 100 milliseconds. */
  retryDelayMs?: number;
  /** Exponential retry delay multiplier. Defaults to 2. */
  retryBackoffFactor?: number;
  /** Upper bound for an exponential retry delay. Defaults to 2 seconds. */
  maxRetryDelayMs?: number;
  /** Override retry classification. Invalid subscriptions are never retried by default. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface NotificationServiceOptions {
  store: SubscriptionStore;
  push?: PushTransport;
  pushDispatch?: PushDispatchOptions;
  subscriptionValidation?: SubscriptionValidationOptions;
  realtime?: RealtimeTransport;
  onInvalidSubscription?: (
    subscription: PushSubscriptionRecord,
    error: unknown,
  ) => Promise<void> | void;
}

export interface ChannelResult {
  sent: number;
  failed: number;
  removed: number;
  skipped: boolean;
  errors: unknown[];
}

export interface NotificationSendResult {
  userId: string;
  requestedChannels: NotificationChannel[];
  push: ChannelResult;
  websocket: {
    sent: boolean;
    failed: boolean;
    skipped: boolean;
    error?: unknown;
  };
}

export interface FastifyRequestLike {
  body?: unknown;
  params?: unknown;
  user?: unknown;
  [key: string]: unknown;
}

export interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike;
  send(payload?: unknown): unknown;
}

export type FastifyRouteHandler = (
  request: FastifyRequestLike,
  reply: FastifyReplyLike,
) => unknown | Promise<unknown>;

export type FastifyWebSocketHandler = (
  socket: unknown,
  request: FastifyRequestLike,
) => unknown | Promise<unknown>;

export interface FastifyInstanceLike {
  post(path: string, handler: FastifyRouteHandler): unknown;
  delete(path: string, handler: FastifyRouteHandler): unknown;
  get?(
    path: string,
    options: { websocket: true },
    handler: FastifyWebSocketHandler,
  ): unknown;
  decorate?(name: string, value: unknown): unknown;
}

export interface FastifyPluginOptions {
  service: import("./service.js").NotificationService;
  prefix?: string;
  resolveUserId: (
    request: FastifyRequestLike,
  ) => string | null | undefined | Promise<string | null | undefined>;
  websocket?: {
    path?: string;
    onWebSocket: (
      socket: unknown,
      request: FastifyRequestLike,
      userId: string,
      service: import("./service.js").NotificationService,
    ) => unknown | Promise<unknown>;
  };
}
