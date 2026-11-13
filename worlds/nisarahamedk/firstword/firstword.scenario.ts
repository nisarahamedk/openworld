// FirstWord's people for 30 world days. Owners arrive over the month and climb the same ladder the stage tests use
// (tests/e2e/ladder.ts), through the product's own API and webhooks only: sign up, cell and carrier, the free carrier
// check with its proof call, a plan through Stripe Checkout, then calls from their clients. Some owners stall, pause,
// cancel or close their account, because that is what people do and where old-state bugs hide.
// Only type imports from the runner, so this file works from the product repo (.openworld/) too.
import type { World } from "../../../runner/src/host/world.ts";
import type { ClerkTwin } from "../../../runner/src/twins/clerk.ts";
import type { RetellTwin } from "../../../runner/src/twins/retell.ts";
import type { StripeTwin } from "../../../runner/src/twins/stripe.ts";

const US_CARRIERS = ["tmobile", "att", "verizon", "us_other"];
const CA_CARRIERS = ["freedom", "rogers", "bell", "telus"];

type Line = { status: string; number?: string | null; cellNumber?: string | null; shared?: boolean };

export default async function firstword(world: World) {
  const { MINUTE, HOUR, DAY } = world.units;
  const clerk = world.twin<ClerkTwin>("clerk");
  const retell = world.twin<RetellTwin>("retell");
  const stripe = world.twin<StripeTwin>("stripe");
  const checkNumber = world.vars.RETELL_CHECK_NUMBER as string;

  // Owners arrive: 6 on day 0, then about one a day.
  let n = 0;
  const arrive = () => {
    const i = ++n;
    world.spawn(`owner-${i}`, () => owner(i));
  };
  for (let i = 0; i < 6; i++) arrive();
  world.spawn("arrivals", async () => {
    const rng = world.rng.fork("arrivals");
    for (;;) {
      await world.sleep(rng.nextGap(1));
      if (world.over) return;
      arrive();
    }
  });

  async function owner(i: number) {
    const rng = world.rng.fork(`owner-${i}`);
    const actor = `owner-${i}`;
    const ca = rng.chance(0.4);
    const cell = ca ? `+1604555${String(1000 + i).padStart(4, "0")}` : `+1415555${String(1000 + i).padStart(4, "0")}`;
    const user = clerk.createUser(`owner${i}+world@example.com`, cell);
    const api = async <T>(method: string, path: string, json?: unknown): Promise<{ ok: boolean; status: number; body: T }> => {
      const res = await world.fetch(`/api/v1${path}`, { method, headers: await clerk.auth(user.id), ...(json === undefined ? {} : { json }), actor });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { ok: res.ok, status: res.status, body: body as T };
    };
    const line = async () => (await api<Line>("GET", "/line")).body;

    // Signs up and looks around.
    const viewer = await api<{ state: string }>("GET", "/viewer");
    world.note("owner_signed_up", { owner: i, state: viewer.body?.state });
    await api("GET", "/workspace");
    await api("GET", "/calls");
    if (viewer.body?.state === "waitlisted") return;

    // Some never go further.
    if (rng.chance(0.1)) return;
    await world.sleep(rng.int(5, 90) * MINUTE);

    // The free carrier check: cell and carrier, the shared trial number, then the proof call.
    await api("PUT", "/line/cell", { cellNumber: cell, carrier: rng.pick(ca ? CA_CARRIERS : US_CARRIERS) });
    const trial = await api<Line>("POST", "/line/trial");
    if (!trial.ok) {
      world.note("trial_refused", { owner: i, status: trial.status });
      return;
    }
    // About one in five leave forwarding on and never prove it; the sweep nudges them.
    if (rng.chance(0.2)) {
      world.note("owner_stalled_in_check", { owner: i });
      return;
    }
    await world.sleep(rng.int(2, 30) * MINUTE);
    const check = await api<{ id: string }>("POST", "/line/checks");
    if (!check.ok) {
      world.note("check_refused", { owner: i, status: check.status });
      return;
    }
    const trialNumber = (await line()).number;
    // The proof call comes back through the owner's forwarding to the shared trial number.
    if (trialNumber) await retell.inboundCall(trialNumber, checkNumber, { durationMs: 20_000 });
    // The check line's own outbound call ends: declined on the cell, so the carrier forwarded it.
    await retell.webhook("/api/retell/call-analyzed", {
      event: "call_ended",
      call: {
        call_id: `call_check_${check.body.id}`,
        agent_id: world.vars.RETELL_CHECK_AGENT_ID,
        call_type: "phone_call",
        metadata: { check_id: check.body.id, check_role: "outbound", user_id: user.id },
        disconnection_reason: "user_declined",
      },
    });

    // Some take a few days to decide.
    if (rng.chance(0.3)) await world.sleep(rng.int(1, 5) * DAY);
    if (world.over) return;
    const billing = await api<{ enabled: boolean }>("GET", "/billing");
    if (billing.body?.enabled) {
      const checkout = await api<{ url: string }>("POST", "/billing/checkout", { plan: rng.chance(0.5) ? "pro" : "starter" });
      if (!checkout.ok) {
        world.note("checkout_refused", { owner: i, status: checkout.status, body: checkout.body });
        return;
      }
      await world.sleep(rng.int(1, 8) * MINUTE);
      await stripe.pay(checkout.body.url);
    } else {
      await api("POST", "/line/live");
    }

    // Waits for the number (the reconciler buys it), the way the app polls.
    let own: Line | null = null;
    for (let tries = 0; tries < 12 && !world.over; tries++) {
      await world.sleep(10 * MINUTE);
      const l = await line();
      // Their own number arrives as "unproven"; the first call forwarded to it makes it live.
      if ((l.status === "live" || l.status === "unproven") && l.number && l.number !== trialNumber) {
        own = l;
        break;
      }
    }
    if (!own?.number) {
      world.note("never_went_live", { owner: i });
      return;
    }
    world.note("owner_live", { owner: i, number: own.number });

    // Life on a live line: clients call, the owner checks Today, marks calls done, sometimes pauses or leaves.
    const clients = Array.from({ length: rng.int(3, 12) }, (_, k) => `+1212555${String(rng.int(0, 9999)).padStart(4, "0")}${k % 10}`.slice(0, 12));
    const callsPerDay = rng.int(1, 6);
    const leavesOn = rng.chance(0.15) ? world.now() + rng.int(3, 20) * DAY : Infinity;
    const cancelsOn = rng.chance(0.2) ? world.now() + rng.int(2, 15) * DAY : Infinity;
    let cancelled = false;
    const pausesOn = rng.chance(0.15) ? world.now() + rng.int(1, 10) * DAY : Infinity;
    let paused = false;

    world.spawn(`${actor}-checks-today`, async () => {
      while (!world.over) {
        await world.sleep(rng.int(4, 14) * HOUR);
        const calls = await api<{ id: string; done?: boolean }[] | { calls: { id: string }[] }>("GET", "/calls");
        const list = Array.isArray(calls.body) ? calls.body : (calls.body?.calls ?? []);
        const first = list[0];
        if (first && rng.chance(0.5)) await api("PUT", `/calls/${first.id}/done`, { done: true });
        if (first && rng.chance(0.1)) await api("GET", `/calls/${first.id}`);
      }
    });

    while (!world.over) {
      await world.sleep(rng.nextGap(callsPerDay));
      if (world.over) return;
      const now = world.now();
      if (now >= leavesOn) {
        const closed = await api("DELETE", "/account");
        world.note("owner_closed_account", { owner: i, status: closed.status });
        return;
      }
      if (!cancelled && now >= cancelsOn && billing.body?.enabled) {
        const mine = [...stripe.subscriptions.values()].find((s) => s.status !== "canceled" && stripe.customers.get(s.customer)?.email === user.email);
        if (mine) await stripe.cancelAtPeriodEnd(mine.id);
        cancelled = true;
        world.note("owner_cancelled_plan", { owner: i });
      }
      if (!paused && now >= pausesOn) {
        await api("POST", "/line/pause", { paused: true });
        paused = true;
        world.spawn(`${actor}-unpause`, async () => {
          await world.sleep(rng.int(1, 4) * DAY);
          if (!world.over) await api("POST", "/line/pause", { paused: false });
          paused = false;
        });
      }
      const from = rng.chance(0.7) ? rng.pick(clients) : `+1917555${String(rng.int(0, 9999)).padStart(4, "0")}`;
      await retell.inboundCall(own.number, from, {
        durationMs: rng.int(20, 300) * 1000,
        callerName: rng.chance(0.5) ? rng.pick(["Chris Patel", "Dana Lee", "Sam Ortiz", "Alex Kim"]) : undefined,
        urgent: rng.chance(0.1),
        summary: rng.pick(["Wants to book a visit next week.", "Asked about prices.", "Calling back about the quote.", "Running late to the appointment."]),
      });
    }
  }
}
