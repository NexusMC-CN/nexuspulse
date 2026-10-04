import {
  InvalidNotificationChannelError,
  InvalidNotificationPayloadError,
  InvalidSubscriptionInputError,
  isInvalidSubscriptionError,
} from "./errors.js";
import type {
  ChannelResult,
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
  NotificationServiceOptions,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  SubscriptionStore,
} from "./types.js";

function emptyChannelResult(skipped: boolean): ChannelResult {
  return { sent: 0, failed: 0, removed: 0, skipped, errors: [] };
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new InvalidSubscriptionInputError("A user id is required");
  }
}

export class NotificationService {
  private readonly store: SubscriptionStore;
  private readonly push: NotificationServiceOptions["push"];
  private readonly realtime: NotificationServiceOptions["realtime"];
  private readonly onInvalidSubscription: NonNullable<
    NotificationServiceOptions["onInvalidSubscription"]
  >;

  constructor(options: NotificationServiceOptions) {
    this.store = options.store;
    this.push = options.push;
    this.realtime = options.realtime;
    this.onInvalidSubscription =
      options.onInvalidSubscription ?? (() => undefined);
  }

  async subscribe(
    userId: string,
    subscription: PushSubscriptionInput,
  ): Promise<PushSubscriptionRecord> {
    assertUserId(userId);
    if (
      !subscription ||
      typeof subscription.endpoint !== "string" ||
      !subscription.endpoint.trim()
    ) {
      throw new InvalidSubscriptionInputError(
        "A user id and subscription endpoint are required",
      );
    }
    return this.store.upsert(userId, subscription);
  }

  async unsubscribe(userId: string, id: string): Promise<boolean> {
    assertUserId(userId);
    if (!id) return false;
    return Boolean(await this.store.removeForUser(userId, id));
  }

  async listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    assertUserId(userId);
    return this.store.listByUser(userId);
  }

  async send(
    userId: string,
    payload: NotificationPayload,
    channels: NotificationChannel[] = ["push", "websocket"],
  ): Promise<NotificationSendResult> {
    assertUserId(userId);
    if (
      !payload ||
      typeof payload.title !== "string" ||
      !payload.title.trim()
    ) {
      throw new InvalidNotificationPayloadError(
        "A notification title is required",
      );
    }
    if (
      channels.some((channel) => channel !== "push" && channel !== "websocket")
    ) {
      throw new InvalidNotificationChannelError(
        "Unsupported notification channel",
      );
    }
    const requestedChannels = [...new Set(channels)];
    const result: NotificationSendResult = {
      userId,
      requestedChannels,
      push: emptyChannelResult(
        !requestedChannels.includes("push") || !this.push,
      ),
      websocket: {
        sent: false,
        failed: false,
        skipped: !requestedChannels.includes("websocket") || !this.realtime,
      },
    };

    if (requestedChannels.includes("push") && this.push) {
      result.push = await this.sendPush(userId, payload);
    }
    if (requestedChannels.includes("websocket") && this.realtime) {
      try {
        await this.realtime.publish(userId, payload);
        result.websocket.sent = true;
      } catch (error) {
        result.websocket.failed = true;
        result.websocket.error = error;
      }
    }
    return result;
  }

  private async sendPush(
    userId: string,
    payload: NotificationPayload,
  ): Promise<ChannelResult> {
    const result = emptyChannelResult(false);
    const subscriptions = await this.store.listByUser(userId);
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await this.push?.send(subscription, payload);
          result.sent += 1;
        } catch (error) {
          result.failed += 1;
          result.errors.push(error);
          if (
            this.push?.isInvalidError?.(error) ??
            isInvalidSubscriptionError(error)
          ) {
            try {
              const removed = await this.store.removeForUser(
                userId,
                subscription.id,
              );
              if (removed !== false) result.removed += 1;
            } catch (cleanupError) {
              result.errors.push(cleanupError);
            }
            try {
              await this.onInvalidSubscription(subscription, error);
            } catch (callbackError) {
              result.errors.push(callbackError);
            }
          }
        }
      }),
    );
    return result;
  }
}
