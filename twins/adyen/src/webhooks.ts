// Adyen-style webhook delivery: signed notificationItems, "[accepted]" or it
// counts as a failure, at-least-once, retried on Adyen's schedule in world
// time, with optional chaos (duplicates, reordering, delay).

import { createHmac } from "node:crypto";
import type { Engine, Timer } from "./engine.ts";

export interface NotificationItem {
  additionalData: Record<string, string>;
  amount: { currency: string; value: number };
  eventCode: string;
  eventDate: string;
  merchantAccountCode: string;
  merchantReference: string;
  originalReference?: string;
  paymentMethod?: string;
  pspReference: string;
  reason: string;
  success: "true" | "false";
}

export interface WebhookConfig {
  url: string | null;
  hmacKeyHex: string;
  /** Chaos, each a probability from 0 to 1. */
  duplicate: number;
  reorderMaxMs: number;
  failFirst: number;
}

// Adyen: three immediate retries, then a queue that backs off and keeps
// trying for up to 30 days.
const RETRY_AFTER_MS = [0, 0, 0, 2, 5, 10, 15, 30, 60, 120, 240, 480].map((m) => m * 60_000);
const RETRY_FOREVER_MS = 8 * 3600_000;
const GIVE_UP_AFTER_MS = 30 * 86400_000;

/** Adyen's HMAC: fixed fields joined by ':' then HMAC-SHA256 with the hex key, base64. */
export function sign(item: NotificationItem, keyHex: string): string {
  const fields = [
    item.pspReference, item.originalReference ?? "", item.merchantAccountCode, item.merchantReference,
    String(item.amount.value), item.amount.currency, item.eventCode, item.success,
  ];
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(fields.join(":")).digest("base64");
}

export function verify(item: NotificationItem, keyHex: string): boolean {
  return item.additionalData?.hmacSignature === sign(item, keyHex);
}

export class Webhooks {
  private engine: Engine;
  cfg: WebhookConfig;
  private rand: () => number;

  constructor(engine: Engine, cfg: WebhookConfig, rand: () => number = Math.random) {
    this.engine = engine;
    this.cfg = cfg;
    this.rand = rand;
    engine.on("deliver", (t, now) => this.deliver(t, now));
  }

  /** Queue a notification. It is delivered at world time `now` (plus chaos). */
  emit(ref: string, item: Omit<NotificationItem, "eventDate" | "additionalData"> & { additionalData?: Record<string, string> }): void {
    const e = this.engine;
    const full: NotificationItem = { ...item, eventDate: e.iso(), additionalData: { ...(item.additionalData ?? {}) } };
    full.additionalData.hmacSignature = sign(full, this.cfg.hmacKeyHex);
    e.record(ref, "webhook.emitted", { eventCode: full.eventCode, success: full.success, pspReference: full.pspReference });
    const delay = this.cfg.reorderMaxMs > 0 ? Math.floor(this.rand() * this.cfg.reorderMaxMs) : 0;
    e.schedule(e.now() + delay, "deliver", ref, { item: full, attempt: 0, firstMs: e.now() });
    if (this.rand() < this.cfg.duplicate) {
      e.schedule(e.now() + delay + Math.floor(this.rand() * 60_000), "deliver", ref, { item: full, attempt: 0, firstMs: e.now(), duplicate: true });
    }
  }

  private async deliver(t: Timer, now: number): Promise<void> {
    const e = this.engine;
    const { item, attempt, firstMs, duplicate } = t.payload as { item: NotificationItem; attempt: number; firstMs: number; duplicate?: boolean };
    const body = JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: item }] });
    let ok = false;
    let status = 0;
    let response = "";
    if (!this.cfg.url) {
      response = "no webhook url configured";
    } else if (attempt === 0 && this.rand() < this.cfg.failFirst) {
      response = "chaos: simulated delivery failure";
    } else {
      try {
        const res = await fetch(this.cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        response = (await res.text()).slice(0, 200);
        ok = res.ok && response.includes("[accepted]");
      } catch (err: any) {
        response = String(err?.cause?.code ?? err?.message ?? err);
      }
    }
    e.record(t.ref, "webhook.attempt", { eventCode: item.eventCode, attempt, ok, status, response, duplicate: !!duplicate });
    if (ok) return;
    const after = attempt < RETRY_AFTER_MS.length ? RETRY_AFTER_MS[attempt] : RETRY_FOREVER_MS;
    if (e.now() + after - firstMs > GIVE_UP_AFTER_MS) {
      e.record(t.ref, "webhook.gave_up", { eventCode: item.eventCode, attempts: attempt + 1 });
      return;
    }
    e.schedule(e.now() + after, "deliver", t.ref, { item, attempt: attempt + 1, firstMs, duplicate });
  }
}
