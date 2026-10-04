export interface NotificationAction {
  action: string;
  title: string;
  icon?: string;
}

export interface NotificationPayload {
  title: string;
  id?: string;
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
  actions?: NotificationAction[];
  timestamp?: number;
  requireInteraction?: boolean;
  silent?: boolean;
  url?: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
  [key: string]: unknown;
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
  removeForUser(userId: string, id: string): Promise<boolean | void>;
  listByUser(userId: string): Promise<PushSubscriptionRecord[]>;
}

export type NotificationChannel = "push" | "websocket";

export interface PushTransport {
  send(
    subscription: PushSubscriptionRecord,
    payload: NotificationPayload,
  ): Promise<void>;
  isInvalidError?(error: unknown): boolean;
}

export interface RealtimeTransport {
  publish(userId: string, payload: NotificationPayload): Promise<void>;
}

export interface NotificationServiceOptions {
  store: SubscriptionStore;
  push?: PushTransport;
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
