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

export interface ServiceWorkerOptions {
  url?: string;
  scope?: string;
  registration?: ServiceWorkerRegistration;
}

export interface PushOptions {
  applicationServerKey?: BufferSource | string;
  subscribeOptions?: PushSubscriptionOptionsInit;
}

export interface WebSocketReconnectOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  factor?: number;
}

export interface WebSocketOptions {
  url: string;
  protocols?: string | string[];
  reconnect?: boolean | WebSocketReconnectOptions;
  decodeMessage?: (message: unknown) => NotificationPayload | undefined | null;
}

export interface BadgeOptions {
  enabled?: boolean;
}

export interface ClickSecurityOptions {
  allowedOrigins?: string[];
}

export interface NexusPulseOptions {
  serviceWorker?: ServiceWorkerOptions;
  push?: PushOptions;
  webSocket?: WebSocketOptions;
  badge?: BadgeOptions;
  security?: ClickSecurityOptions;
  allowedOrigins?: string[];
}

export interface Capabilities {
  notifications: boolean;
  push: boolean;
  serviceWorker: boolean;
  webSocket: boolean;
  badging: boolean;
}

export type NexusPulseState =
  | "idle"
  | "initializing"
  | "ready"
  | "connecting"
  | "connected"
  | "stopped"
  | "error";

export interface NexusPulseEventMap {
  statechange: NexusPulseState;
  ready: void;
  permissionchange: NotificationPermission;
  subscriptionchange: PushSubscription | null;
  message: NotificationPayload;
  notification: NotificationPayload;
  connected: void;
  disconnected: void;
  error: Error;
}

export type NexusPulseEvents = NexusPulseEventMap;
