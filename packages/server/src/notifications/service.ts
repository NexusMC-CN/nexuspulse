import {
  InvalidNotificationChannelError,
  InvalidNotificationPayloadError,
  InvalidSubscriptionInputError,
} from "../core/errors.js";
import { PushDispatcher } from "../push/dispatch.js";
import {
  normalizePushSubscriptionInput,
  normalizeStoredPushSubscriptionRecord,
} from "../subscriptions/validation.js";
import type {
  ChannelResult,
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
  NotificationServiceOptions,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  SubscriptionValidationOptions,
  SubscriptionStore,
} from "../core/types.js";

export { normalizePushSubscriptionInput } from "../subscriptions/validation.js";

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
  private readonly push: PushDispatcher | undefined;
  private readonly subscriptionValidation: SubscriptionValidationOptions;
  private readonly realtime: NotificationServiceOptions["realtime"];
  private readonly onInvalidSubscription: NonNullable<
    NotificationServiceOptions["onInvalidSubscription"]
  >;

  constructor(options: NotificationServiceOptions) {
    this.store = options.store;
    this.push = options.push
      ? new PushDispatcher(options.push, options.pushDispatch)
      : undefined;
    this.subscriptionValidation = options.subscriptionValidation ?? {};
    this.realtime = options.realtime;
    this.onInvalidSubscription =
      options.onInvalidSubscription ?? (() => undefined);
  }

  async subscribe(
    userId: string,
    subscription: PushSubscriptionInput,
  ): Promise<PushSubscriptionRecord> {
    assertUserId(userId);
    const normalized = await normalizePushSubscriptionInput(
      subscription,
      this.subscriptionValidation,
    );
    return this.store.upsert(userId, normalized);
  }

  async unsubscribe(userId: string, id: string): Promise<boolean> {
    assertUserId(userId);
    if (!id) return false;
    return await this.store.removeForUser(userId, id);
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

    const deliveries: Promise<void>[] = [];
    if (requestedChannels.includes("push") && this.push) {
      deliveries.push(
        (async () => {
          try {
            result.push = await this.sendPush(userId, payload);
          } catch (error) {
            result.push.failed = 1;
            result.push.errors.push(error);
          }
        })(),
      );
    }
    const realtime = this.realtime;
    if (requestedChannels.includes("websocket") && realtime) {
      deliveries.push(
        (async () => {
          try {
            await realtime.publish(userId, payload);
            result.websocket.sent = true;
          } catch (error) {
            result.websocket.failed = true;
            result.websocket.error = error;
          }
        })(),
      );
    }
    await Promise.all(deliveries);
    return result;
  }

  private async sendPush(
    userId: string,
    payload: NotificationPayload,
  ): Promise<ChannelResult> {
    const result = emptyChannelResult(false);
    const subscriptions = await this.store.listByUser(userId);
    const push = this.push;
    if (!subscriptions.length || !push) return result;
    let cursor = 0;
    const workerCount = Math.min(subscriptions.length, push.concurrency);
    const deliver = async () => {
      while (true) {
        const index = cursor++;
        const subscription = subscriptions[index];
        if (!subscription) return;
        let safeSubscription: PushSubscriptionRecord;
        try {
          safeSubscription = await normalizeStoredPushSubscriptionRecord(
            subscription,
            userId,
            this.subscriptionValidation,
          );
        } catch (error) {
          result.failed += 1;
          result.errors.push(error);
          if (error instanceof InvalidSubscriptionInputError) {
            try {
              const removed = await this.store.removeForUser(
                userId,
                subscription.id,
              );
              if (removed) result.removed += 1;
            } catch (cleanupError) {
              result.errors.push(cleanupError);
            }
          }
          continue;
        }
        try {
          await push.deliver(safeSubscription, payload);
          result.sent += 1;
        } catch (error) {
          result.failed += 1;
          result.errors.push(error);
          if (push.isInvalidError(error)) {
            try {
              const removed = await this.store.removeForUser(
                userId,
                subscription.id,
              );
              if (removed) result.removed += 1;
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
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => deliver()));
    return result;
  }
}
