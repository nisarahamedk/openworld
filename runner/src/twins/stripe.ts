// Stripe stand-in: Checkout, subscriptions that live on world time (trials end, periods renew, cancellations land at
// period end), events the app can fetch back, and webhook delivery with Stripe-style retries.
import type { Twin, World } from "../host/world.ts";
import { DAY, HOUR } from "../host/world.ts";

type Session = {
  id: string;
  object: "checkout.session";
  mode: "subscription" | "payment";
  url: string;
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid" | "no_payment_required";
  customer: string | null;
  customer_email: string | null;
  client_reference_id: string | null;
  subscription: string | null;
  metadata: Record<string, string>;
  price: string | null;
  trialDays: number | null;
  subscriptionMetadata: Record<string, string>;
};
type Subscription = {
  id: string;
  object: "subscription";
  customer: string;
  status: "trialing" | "active" | "past_due" | "canceled";
  trial_end: number | null;
  cancel_at_period_end: boolean;
  ended_at: number | null;
  metadata: Record<string, string>;
  items: { object: "list"; data: [{ id: string; current_period_start: number; current_period_end: number; price: { id: string } }] };
};
type Event = { id: string; object: "event"; type: string; created: number; data: { object: Record<string, unknown> } };

const sec = (ms: number) => Math.floor(ms / 1000);
function addMonth(ms: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

export class StripeTwin implements Twin {
  readonly name = "stripe";
  readonly sessions = new Map<string, Session>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly customers = new Map<string, { id: string; email: string | null; deleted: boolean }>();
  readonly events = new Map<string, Event>();
  private n = 0;
  private started = false;

  private readonly world: World;
  private readonly webhookPath: string;
  constructor(world: World, webhookPath = "/api/stripe/webhook") {
    this.world = world;
    this.webhookPath = webhookPath;
  }

  private id(prefix: string) {
    return `${prefix}_world${(++this.n).toString(36)}${this.world.rng.int(1e6, 9e6).toString(36)}`;
  }

  /** Starts the subscription clock: trials ending, renewals, cancellations at period end. */
  private ensureClock() {
    if (this.started) return;
    this.started = true;
    this.world.every("stripe.clock", HOUR, async () => {
      for (const s of this.subscriptions.values()) await this.advance(s);
    });
  }

  private async advance(s: Subscription) {
    const now = Date.now();
    const item = s.items.data[0];
    if (s.status === "canceled") return;
    if (s.status === "trialing" && s.trial_end !== null && now >= s.trial_end * 1000) {
      s.status = "active";
      await this.emit("invoice.paid", { object: "invoice", subscription: s.id, customer: s.customer, amount_paid: 1, billing_reason: "subscription_cycle" });
      await this.emit("customer.subscription.updated", { ...s });
    }
    if (now >= item.current_period_end * 1000) {
      if (s.cancel_at_period_end) {
        s.status = "canceled";
        s.ended_at = item.current_period_end;
        await this.emit("customer.subscription.deleted", { ...s });
        return;
      }
      item.current_period_start = item.current_period_end;
      item.current_period_end = sec(addMonth(item.current_period_start * 1000));
      await this.emit("invoice.paid", { object: "invoice", subscription: s.id, customer: s.customer, amount_paid: 1, billing_reason: "subscription_cycle" });
      await this.emit("customer.subscription.updated", { ...s });
    }
  }

  private async emit(type: string, object: Record<string, unknown>) {
    const ev: Event = { id: this.id("evt"), object: "event", type, created: sec(Date.now()), data: { object } };
    this.events.set(ev.id, ev);
    this.world.spawn(`stripe.deliver.${ev.id}`, () => this.deliver(ev));
  }

  // Stripe retries failed deliveries with backoff for days; the world uses 1 h, 6 h, 24 h, 72 h.
  private async deliver(ev: Event) {
    for (const wait of [0, HOUR, 6 * HOUR, DAY, 3 * DAY]) {
      if (wait) await this.world.sleep(wait);
      if (this.world.over) return;
      const res = await this.world.fetch(this.webhookPath, { method: "POST", json: { id: ev.id, object: "event", type: ev.type }, headers: { "stripe-signature": `t=${sec(Date.now())},v1=world` }, actor: "stripe" });
      if (res.ok) return;
    }
    this.world.note("stripe.delivery_gave_up", { event: ev.id, type: ev.type });
  }

  /** The person finishes Checkout at `url` (with a card). */
  async pay(url: string): Promise<Session> {
    const id = url.split("/").pop() ?? "";
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no checkout session at ${url}`);
    if (s.status !== "open") return s;
    this.ensureClock();
    let customer = s.customer;
    if (!customer) {
      customer = this.id("cus");
      this.customers.set(customer, { id: customer, email: s.customer_email, deleted: false });
      s.customer = customer;
    }
    s.status = "complete";
    s.payment_status = "paid";
    if (s.mode === "subscription") {
      const now = Date.now();
      const trialEnd = s.trialDays ? now + s.trialDays * DAY : null;
      const periodEnd = trialEnd ?? addMonth(now);
      const sub: Subscription = {
        id: this.id("sub"),
        object: "subscription",
        customer,
        status: trialEnd ? "trialing" : "active",
        trial_end: trialEnd ? sec(trialEnd) : null,
        cancel_at_period_end: false,
        ended_at: null,
        metadata: s.subscriptionMetadata,
        items: { object: "list", data: [{ id: this.id("si"), current_period_start: sec(now), current_period_end: sec(periodEnd), price: { id: s.price ?? "price_unknown" } }] },
      };
      this.subscriptions.set(sub.id, sub);
      s.subscription = sub.id;
      await this.emit("customer.subscription.created", { ...sub });
    }
    await this.emit("checkout.session.completed", this.sessionJson(s));
    return s;
  }

  /** The person cancels in the billing portal: the plan runs to the end of the period. */
  async cancelAtPeriodEnd(subscriptionId: string) {
    const s = this.subscriptions.get(subscriptionId);
    if (!s || s.status === "canceled") return;
    s.cancel_at_period_end = true;
    await this.emit("customer.subscription.updated", { ...s });
  }

  subscriptionOf(customerEmailOrUser: string): Subscription | undefined {
    return [...this.subscriptions.values()].find((s) => s.metadata.user_id === customerEmailOrUser && s.status !== "canceled");
  }

  private sessionJson(s: Session) {
    const { price: _p, trialDays: _t, subscriptionMetadata: _m, ...rest } = s;
    return rest;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1/, "");
    const form = req.method === "POST" ? new URLSearchParams(await req.text()) : new URLSearchParams();
    const notFound = () => Response.json({ error: { code: "resource_missing", message: "No such object" } }, { status: 404 });
    if (path === "/checkout/sessions" && req.method === "POST") {
      const id = this.id("cs");
      const md = (prefix: string) => Object.fromEntries([...form.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length, -1), v]));
      const s: Session = {
        id,
        object: "checkout.session",
        mode: form.get("mode") === "payment" ? "payment" : "subscription",
        url: `https://checkout.stripe.world.test/c/${id}`,
        status: "open",
        payment_status: "unpaid",
        customer: form.get("customer"),
        customer_email: form.get("customer_email"),
        client_reference_id: form.get("client_reference_id"),
        subscription: null,
        metadata: md("metadata["),
        price: form.get("line_items[0][price]"),
        trialDays: form.get("subscription_data[trial_period_days]") ? Number(form.get("subscription_data[trial_period_days]")) : null,
        subscriptionMetadata: md("subscription_data[metadata]["),
      };
      this.sessions.set(id, s);
      return Response.json(this.sessionJson(s));
    }
    if (path === "/billing_portal/sessions" && req.method === "POST") {
      return Response.json({ id: this.id("bps"), object: "billing_portal.session", url: `https://billing.stripe.world.test/p/${form.get("customer")}` });
    }
    let m = /^\/events\/([^/]+)$/.exec(path);
    if (m) {
      const ev = this.events.get(m[1] as string);
      return ev ? Response.json(ev) : notFound();
    }
    m = /^\/subscriptions\/([^/]+)$/.exec(path);
    if (m) {
      const s = this.subscriptions.get(m[1] as string);
      if (!s) return notFound();
      if (req.method === "DELETE") {
        s.status = "canceled";
        s.ended_at = sec(Date.now());
        await this.emit("customer.subscription.deleted", { ...s });
      }
      return Response.json(s);
    }
    m = /^\/customers\/([^/]+)$/.exec(path);
    if (m) {
      const c = this.customers.get(m[1] as string);
      if (!c || c.deleted) return notFound();
      if (req.method === "DELETE") {
        c.deleted = true;
        for (const s of this.subscriptions.values()) {
          if (s.customer === c.id && s.status !== "canceled") {
            s.status = "canceled";
            s.ended_at = sec(Date.now());
            await this.emit("customer.subscription.deleted", { ...s });
          }
        }
        return Response.json({ id: c.id, object: "customer", deleted: true });
      }
      return Response.json({ id: c.id, object: "customer", email: c.email });
    }
    return Response.json({ error: { code: "world_not_modelled", message: `Stripe twin has no ${req.method} ${path}` } }, { status: 501 });
  }
}

export const stripe = (world: World) => new StripeTwin(world);
