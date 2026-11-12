// The Adyen model: payments, modifications and disputes as state machines
// whose future transitions live in the engine's timer queue.
//
// Sources for the behaviour modelled here: Adyen Checkout API (v71) and
// webhook docs. Every delay is in AdyenTimings so it can be calibrated
// against production webhook logs.

import { randomBytes } from "node:crypto";
import type { Engine } from "./engine.ts";
import type { Webhooks } from "./webhooks.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface AdyenTimings {
  captureMs: number;            // capture request -> CAPTURE
  refundMs: number;             // refund request -> REFUND
  refundFailAfterMs: number;    // REFUND -> REFUND_FAILED, when forced
  cancelMs: number;             // cancel request -> CANCELLATION
  authValidityMs: Record<string, number>; // per scheme; uncaptured -> EXPIRE
  sepaBusinessDays: number;     // PENDING -> AUTHORISATION
  settleBusinessDays: number;   // CAPTURE -> settled
  chargebackAfterSettleMs: number; // settled -> NOTIFICATION_OF_CHARGEBACK
  chargebackBookedMs: number;   // NOC -> CHARGEBACK (funds debited)
  defensePeriodMs: number;      // NOC -> defense window closes
  issuerDecisionMs: number;     // defended -> CHARGEBACK_REVERSED
  secondChargebackMs: number;   // CHARGEBACK_REVERSED -> SECOND_CHARGEBACK
}

export const DEFAULT_TIMINGS: AdyenTimings = {
  captureMs: 2 * MIN,
  refundMs: 30 * MIN,
  refundFailAfterMs: 3 * DAY,
  cancelMs: 1 * MIN,
  authValidityMs: { visa: 7 * DAY, mc: 30 * DAY, amex: 7 * DAY, default: 7 * DAY },
  sepaBusinessDays: 5,
  settleBusinessDays: 2,
  chargebackAfterSettleMs: 14 * DAY,
  chargebackBookedMs: 1 * DAY,
  defensePeriodMs: 7 * DAY,
  issuerDecisionMs: 10 * DAY,
  secondChargebackMs: 5 * DAY,
};

export class ApiError extends Error {
  status: number;
  errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

interface Payment {
  merchantAccount: string;
  merchantReference: string;
  amount: { currency: string; value: number };
  method: string;          // visa, mc, sepadirectdebit, ...
  holderName: string;
  captured: number;
  refunded: number;
  scenario: Scenario;
  dispute?: { reason: string; amount: number; defended: boolean; stage: string; defensePeriodEndsAt?: string };
}

/**
 * Test magic, the way Adyen's test environment does it: card holder names
 * steer outcomes, so existing fixtures keep working.
 *   "Chargeback:10.4 10000 EUR"  dispute after settlement (reason, amount)
 *   "... second"                 and a second chargeback after a win
 *   "... lose"                   the issuer upholds the chargeback
 *   "CAPTURE_FAILED"             captures fail
 *   "REFUND_FAILED"              refunds fail days after success
 *   "REFUSED"                    authorisation refused
 *   "SEPA_FAIL"                  bank debit fails at T+N business days
 */
interface Scenario {
  chargeback?: { reason: string; value?: number };
  second: boolean;
  lose: boolean;
  captureFails: boolean;
  refundFails: boolean;
  refused: boolean;
  sepaFails: boolean;
}

function parseScenario(holder: string): Scenario {
  const m = /Chargeback:(\S+)(?:\s+(\d+))?/i.exec(holder);
  return {
    chargeback: m ? { reason: m[1], value: m[2] ? Number(m[2]) : undefined } : undefined,
    second: /\bsecond\b/i.test(holder),
    lose: /\blose\b/i.test(holder),
    captureFails: /CAPTURE_FAILED/i.test(holder),
    refundFails: /REFUND_FAILED/i.test(holder),
    refused: /REFUSED/i.test(holder),
    sepaFails: /SEPA_FAIL/i.test(holder),
  };
}

/** Add business days (Mon-Fri) in UTC, keeping the time of day. */
export function addBusinessDays(unixMs: number, days: number): number {
  let t = unixMs;
  let left = days;
  while (left > 0) {
    t += DAY;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return t;
}

function psp(): string {
  // Adyen pspReferences are 16 characters; letters and digits in newer ones.
  return randomBytes(10).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "X").slice(0, 16);
}

export class Adyen {
  private e: Engine;
  private wh: Webhooks;
  t: AdyenTimings;

  constructor(engine: Engine, webhooks: Webhooks, timings: AdyenTimings = DEFAULT_TIMINGS) {
    this.e = engine;
    this.wh = webhooks;
    this.t = timings;
    const on = (k: string, f: (ref: string, payload: any) => void) => engine.on(k, (t) => f(t.ref, t.payload));
    on("auth.expire", (ref) => this.expire(ref));
    on("capture.done", (ref, p) => this.captureDone(ref, p));
    on("capture.auto", (ref) => this.capture(ref, {}));
    on("refund.done", (ref, p) => this.refundDone(ref, p));
    on("refund.fail", (ref, p) => this.notify(ref, "REFUND", false, p.amount, p.original, "Refund failed by issuer", "REFUND_FAILED"));
    on("cancel.done", (ref, p) => this.cancelDone(ref, p));
    on("sepa.settle", (ref) => this.sepaSettle(ref));
    on("settled", (ref) => this.settled(ref));
    on("dispute.notify", (ref) => this.disputeNotify(ref));
    on("dispute.book", (ref) => this.disputeBook(ref));
    on("dispute.window", (ref) => this.disputeWindow(ref));
    on("dispute.decide", (ref) => this.disputeDecide(ref));
    on("dispute.second", (ref) => this.disputeSecond(ref));
  }

  private businessMs(days: number): number {
    const nowUnix = this.e.clock.startUnixMs + this.e.now();
    return addBusinessDays(nowUnix, days) - this.e.clock.startUnixMs;
  }

  private load(ref: string): Payment & { state: string } {
    const p = this.e.get<Payment>(ref);
    if (!p) throw new ApiError(422, "167", `Original pspReference required / not found: ${ref}`);
    return p;
  }

  private save(ref: string, state: string, p: Payment): void {
    const { state: _s, ref: _r, created_ms: _c, ...data } = p as any;
    this.e.put(ref, "payment", state, data);
  }

  private transition(ref: string, from: string, to: string, p: Payment): void {
    this.save(ref, to, p);
    this.e.record(ref, "state", { from, to });
  }

  private notify(ref: string, code: string, success: boolean, amount: number, original: string | undefined,
                 reason = "", recordAs?: string, extra: Record<string, string> = {}): void {
    const p = this.load(original ?? ref);
    this.wh.emit(original ?? ref, {
      eventCode: recordAs ?? code,
      success: success ? "true" : "false",
      pspReference: ref,
      originalReference: original,
      merchantAccountCode: p.merchantAccount,
      merchantReference: p.merchantReference,
      amount: { currency: p.amount.currency, value: amount },
      paymentMethod: p.method,
      reason,
      additionalData: extra,
    });
  }

  // ---- POST /payments -----------------------------------------------------

  payments(req: any): any {
    const amount = req.amount;
    if (!amount?.currency || typeof amount.value !== "number") throw new ApiError(422, "100", "Required field 'amount' is not provided.");
    if (!req.merchantAccount) throw new ApiError(422, "905", "Required field 'merchantAccount' is not provided.");
    const pm = req.paymentMethod ?? {};
    const method: string = pm.type === "scheme" || !pm.type ? (pm.brand ?? "visa") : pm.type;
    const holder: string = pm.holderName ?? pm.ownerName ?? req.shopperName?.firstName ?? "";
    const ref = psp();
    const p: Payment = {
      merchantAccount: req.merchantAccount, merchantReference: req.reference ?? "", amount, method,
      holderName: holder, captured: 0, refunded: 0, scenario: parseScenario(holder),
    };
    this.save(ref, "received", p);
    this.e.record(ref, "api", { call: "POST /payments", amount, method });

    if (method === "sepadirectdebit" || method === "ach") {
      this.transition(ref, "received", "pending", p);
      this.notify(ref, "PENDING", true, amount.value, undefined);
      this.e.schedule(this.businessMs(this.t.sepaBusinessDays), "sepa.settle", ref);
      return { pspReference: ref, resultCode: "Received", merchantReference: p.merchantReference };
    }

    if (p.scenario.refused) {
      this.transition(ref, "received", "refused", p);
      this.notify(ref, "AUTHORISATION", false, amount.value, undefined, "Refused");
      return { pspReference: ref, resultCode: "Refused", refusalReason: "Refused", merchantReference: p.merchantReference };
    }

    this.transition(ref, "received", "authorised", p);
    this.notify(ref, "AUTHORISATION", true, amount.value, undefined, "", undefined, { authCode: "123456" });
    const validity = this.t.authValidityMs[method] ?? this.t.authValidityMs.default;
    this.e.schedule(this.e.now() + validity, "auth.expire", ref);
    if (typeof req.captureDelayHours === "number") {
      this.e.schedule(this.e.now() + req.captureDelayHours * HOUR, "capture.auto", ref);
    }
    return { pspReference: ref, resultCode: "Authorised", merchantReference: p.merchantReference, amount };
  }

  private expire(ref: string): void {
    const p = this.load(ref);
    if (p.state !== "authorised") return;
    this.e.cancel({ ref, kind: "capture.auto" });
    this.transition(ref, "authorised", "expired", p);
    this.notify(ref, "EXPIRE", true, p.amount.value, undefined, "Authorisation expired");
  }

  // ---- captures -----------------------------------------------------------

  capture(ref: string, req: any): any {
    const p = this.load(ref);
    const value = req.amount?.value ?? p.amount.value - p.captured;
    if (p.state !== "authorised") throw new ApiError(422, "167", `Payment is ${p.state}; cannot capture`);
    if (value > p.amount.value - p.captured) throw new ApiError(422, "137", "Invalid amount specified");
    const mod = psp();
    this.e.record(ref, "api", { call: "POST /captures", value, modification: mod });
    this.e.schedule(this.e.now() + this.t.captureMs, "capture.done", ref, { mod, value });
    return { pspReference: mod, paymentPspReference: ref, status: "received", amount: { currency: p.amount.currency, value } };
  }

  private captureDone(ref: string, { mod, value }: { mod: string; value: number }): void {
    const p = this.load(ref);
    if (p.state !== "authorised") return;
    if (p.scenario.captureFails) {
      this.notify(mod, "CAPTURE_FAILED", true, value, ref, "Capture failed");
      return;
    }
    p.captured += value;
    this.e.cancel({ ref, kind: "auth.expire" });
    this.e.cancel({ ref, kind: "capture.auto" });
    this.transition(ref, "authorised", "captured", p);
    this.notify(mod, "CAPTURE", true, value, ref);
    this.e.schedule(this.businessMs(this.t.settleBusinessDays), "settled", ref);
  }

  private settled(ref: string): void {
    const p = this.load(ref);
    if (p.state !== "captured" && p.state !== "refunded" && p.state !== "partially_refunded") return;
    this.e.record(ref, "settled");
    if (p.scenario.chargeback) this.e.schedule(this.e.now() + this.t.chargebackAfterSettleMs, "dispute.notify", ref);
  }

  // ---- refunds, cancels, reversals ---------------------------------------

  refund(ref: string, req: any): any {
    const p = this.load(ref);
    const value = req.amount?.value ?? p.captured - p.refunded;
    if (p.captured === 0) throw new ApiError(422, "167", "Payment not captured; use /cancels or /reversals");
    if (value <= 0 || value > p.captured - p.refunded) throw new ApiError(422, "137", "Invalid amount specified");
    const mod = psp();
    p.refunded += value; // reserved now so concurrent refunds cannot exceed the capture
    this.save(ref, p.state, p);
    this.e.record(ref, "api", { call: "POST /refunds", value, modification: mod });
    this.e.schedule(this.e.now() + this.t.refundMs, "refund.done", ref, { mod, value });
    return { pspReference: mod, paymentPspReference: ref, status: "received", amount: { currency: p.amount.currency, value } };
  }

  private refundDone(ref: string, { mod, value }: { mod: string; value: number }): void {
    const p = this.load(ref);
    const to = p.refunded >= p.captured ? "refunded" : "partially_refunded";
    if (p.state !== to) this.transition(ref, p.state, to, p);
    this.notify(mod, "REFUND", true, value, ref);
    if (p.scenario.refundFails) this.e.schedule(this.e.now() + this.t.refundFailAfterMs, "refund.fail", ref, { amount: value, original: ref });
  }

  cancel(ref: string, req: any, orRefund = false): any {
    const p = this.load(ref);
    const mod = psp();
    if (orRefund && p.captured > 0) {
      const r = this.refund(ref, { amount: { value: p.captured - p.refunded } });
      return { ...r, status: "received" };
    }
    if (p.state !== "authorised" && p.state !== "pending") throw new ApiError(422, "167", `Payment is ${p.state}; cannot cancel`);
    this.e.record(ref, "api", { call: orRefund ? "POST /reversals" : "POST /cancels", modification: mod });
    this.e.schedule(this.e.now() + this.t.cancelMs, "cancel.done", ref, { mod, orRefund });
    return { pspReference: mod, paymentPspReference: ref, status: "received" };
  }

  private cancelDone(ref: string, { mod, orRefund }: { mod: string; orRefund: boolean }): void {
    const p = this.load(ref);
    if (p.state !== "authorised" && p.state !== "pending") return;
    this.e.cancel({ ref, kind: "auth.expire" });
    this.e.cancel({ ref, kind: "capture.auto" });
    this.e.cancel({ ref, kind: "sepa.settle" });
    this.transition(ref, p.state, "cancelled", p);
    this.notify(mod, orRefund ? "CANCEL_OR_REFUND" : "CANCELLATION", true, p.amount.value, ref, "", undefined,
      orRefund ? { "modification.action": "cancel" } : {});
  }

  // ---- bank debits ----------------------------------------------------------

  private sepaSettle(ref: string): void {
    const p = this.load(ref);
    if (p.state !== "pending") return;
    if (p.scenario.sepaFails) {
      this.transition(ref, "pending", "refused", p);
      this.notify(ref, "AUTHORISATION", false, p.amount.value, undefined, "AM04: insufficient funds");
      return;
    }
    p.captured = p.amount.value;
    this.transition(ref, "pending", "captured", p);
    this.notify(ref, "AUTHORISATION", true, p.amount.value, undefined);
    this.e.schedule(this.e.now() + DAY, "settled", ref);
  }

  // ---- disputes -----------------------------------------------------------

  private disputeNotify(ref: string): void {
    const p = this.load(ref);
    const cb = p.scenario.chargeback!;
    const ends = this.e.now() + this.t.defensePeriodMs;
    p.dispute = { reason: cb.reason, amount: cb.value ?? p.captured, defended: false, stage: "notified", defensePeriodEndsAt: this.e.iso(ends) };
    this.save(ref, p.state, p);
    this.notify(ref, "NOTIFICATION_OF_CHARGEBACK", true, p.dispute.amount, ref, `Reason ${cb.reason}`, undefined, {
      chargebackReasonCode: cb.reason, defensePeriodEndsAt: p.dispute.defensePeriodEndsAt!, disputeStatus: "Undefended",
    });
    this.e.schedule(this.e.now() + this.t.chargebackBookedMs, "dispute.book", ref);
    this.e.schedule(ends, "dispute.window", ref);
  }

  private disputeBook(ref: string): void {
    const p = this.load(ref);
    p.dispute!.stage = "chargeback";
    this.transition(ref, p.state, "chargeback", p);
    this.notify(ref, "CHARGEBACK", true, p.dispute!.amount, ref, `Reason ${p.dispute!.reason}`, undefined, {
      chargebackReasonCode: p.dispute!.reason, disputeStatus: p.dispute!.defended ? "Pending" : "Undefended",
    });
  }

  private disputeWindow(ref: string): void {
    const p = this.load(ref);
    if (p.dispute!.defended) return;
    p.dispute!.stage = "lost";
    this.transition(ref, p.state, "chargeback_lost", p);
    this.notify(ref, "DISPUTE_DEFENSE_PERIOD_ENDED", true, p.dispute!.amount, ref, "Defense period ended", undefined, { disputeStatus: "Lost" });
  }

  defend(ref: string): any {
    const p = this.load(ref);
    if (!p.dispute || p.dispute.stage === "lost" || p.dispute.defended) throw new ApiError(422, "000", "Dispute is not defendable");
    p.dispute.defended = true;
    this.save(ref, p.state, p);
    this.e.record(ref, "api", { call: "POST /defendDispute" });
    this.e.cancel({ ref, kind: "dispute.window" });
    this.e.schedule(this.e.now() + this.t.issuerDecisionMs, "dispute.decide", ref);
    return { disputeServiceResult: { success: true } };
  }

  accept(ref: string): any {
    const p = this.load(ref);
    if (!p.dispute || p.dispute.stage === "lost") throw new ApiError(422, "000", "Dispute is not acceptable");
    this.e.record(ref, "api", { call: "POST /acceptDispute" });
    this.e.cancel({ ref, kind: "dispute.window" });
    this.e.cancel({ ref, kind: "dispute.decide" });
    p.dispute.stage = "accepted";
    this.transition(ref, p.state, "chargeback_accepted", p);
    return { disputeServiceResult: { success: true } };
  }

  private disputeDecide(ref: string): void {
    const p = this.load(ref);
    if (p.scenario.lose) {
      p.dispute!.stage = "lost";
      this.transition(ref, p.state, "chargeback_lost", p);
      return;
    }
    p.dispute!.stage = "won";
    this.transition(ref, p.state, "chargeback_reversed", p);
    this.notify(ref, "CHARGEBACK_REVERSED", true, p.dispute!.amount, ref, "Defense accepted", undefined, { disputeStatus: "Won" });
    if (p.scenario.second) this.e.schedule(this.e.now() + this.t.secondChargebackMs, "dispute.second", ref);
  }

  private disputeSecond(ref: string): void {
    const p = this.load(ref);
    p.dispute!.stage = "second_chargeback";
    this.transition(ref, p.state, "second_chargeback", p);
    this.notify(ref, "SECOND_CHARGEBACK", true, p.dispute!.amount, ref, `Reason ${p.dispute!.reason}`, undefined, { disputeStatus: "Lost" });
  }

  // ---- control: force a future transition now --------------------------

  force(ref: string, kind: string): number {
    const timers = this.e.pending().filter((t) => t.ref === ref && (t.kind === kind || kind === "next"));
    if (!timers.length) throw new ApiError(404, "000", `nothing scheduled for ${ref} matching ${kind}`);
    const t = timers[0];
    this.e.db.prepare("update timers set due_ms = ? where id = ?").run(this.e.now(), t.id);
    this.e.onChange();
    return t.id;
  }
}
