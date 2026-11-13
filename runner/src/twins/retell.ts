// Retell stand-in: phone numbers, outbound and web calls, and the webhooks Retell sends for a call (call_inbound,
// then call_analyzed), signed with the world's API key the way retell-sdk's verify() checks them
// (x-retell-signature: v=<ms>,d=hex(HMAC-SHA256(key, body + ms))). Timestamps are world time.
import type { Twin, World } from "../host/world.ts";

type Call = { call_id: string; call_type: "web_call" | "phone_call"; agent_id: string; from_number?: string; to_number?: string; metadata?: Record<string, unknown> };

export type CallOutcome = {
  transcript?: { role: string; content: string }[];
  summary?: string;
  callerName?: string;
  callerKind?: string;
  urgent?: boolean;
  nextStep?: string;
  durationMs?: number;
};

async function sign(body: string, key: string, at = Date.now()): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body + at));
  return `v=${at},d=${Buffer.from(sig).toString("hex")}`;
}

export class RetellTwin implements Twin {
  readonly name = "retell";
  readonly numbers = new Map<string, { phone_number: string; nickname?: string; inbound_webhook_url?: string; area_code?: number }>();
  readonly calls = new Map<string, Call>();
  private n = 0;

  private readonly world: World;
  private readonly apiKeyVar: string;
  constructor(world: World, apiKeyVar = "RETELL_API_KEY") {
    this.world = world;
    this.apiKeyVar = apiKeyVar;
  }

  private key(): string {
    const k = this.world.vars[this.apiKeyVar];
    if (!k) throw new Error(`world vars need ${this.apiKeyVar} for the Retell twin to sign webhooks`);
    return k;
  }

  private id(prefix: string) {
    // Retell's ids are 32 hex characters after the prefix.
    let hex = (++this.n).toString(16);
    while (hex.length < 32) hex += this.world.rng.int(0, 15).toString(16);
    return `${prefix}_${hex}`;
  }

  /** Posts a signed Retell webhook to the app; returns its JSON answer. */
  async webhook(path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const body = JSON.stringify(payload);
    const res = await this.world.fetch(path, { method: "POST", body, headers: { "content-type": "application/json", "x-retell-signature": await sign(body, this.key()) }, actor: "retell" });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed };
  }

  /**
   * A phone call from `from` to `to`: Retell asks the app who is calling (call_inbound); if the app takes it, the
   * call runs for a while and Retell sends its analysis (call_analyzed). Returns whether the app took the call.
   */
  async inboundCall(to: string, from: string, outcome: CallOutcome = {}): Promise<{ taken: boolean; callId: string }> {
    const callId = this.id("call");
    const inbound = await this.webhook("/api/retell/inbound", { event: "call_inbound", call_inbound: { call_id: callId, from_number: from, to_number: to, agent_id: "agent_world" } });
    const answer = (inbound.body.call_inbound ?? {}) as { reject?: boolean; override_agent_id?: string; metadata?: Record<string, unknown> };
    if (inbound.status !== 200 || answer.reject || !answer.metadata) return { taken: false, callId };
    const started = Date.now();
    await this.world.sleep(outcome.durationMs ?? 90_000);
    await this.analyzed({ call_id: callId, call_type: "phone_call", agent_id: answer.override_agent_id ?? "agent_world", from_number: from, to_number: to, metadata: answer.metadata }, started, outcome);
    return { taken: true, callId };
  }

  /** Retell's end-of-call analysis for a call the app knows about. */
  async analyzed(call: Call, startedAt: number, outcome: CallOutcome = {}): Promise<number> {
    const transcript = outcome.transcript ?? [
      { role: "agent", content: "Hi, you've reached the assistant. How can I help?" },
      { role: "user", content: "Hi, I wanted to ask about an appointment next week." },
    ];
    const res = await this.webhook("/api/retell/call-analyzed", {
      event: "call_analyzed",
      call: {
        ...call,
        start_timestamp: startedAt,
        end_timestamp: Date.now(),
        disconnection_reason: "user_hangup",
        recording_url: `https://retell.world.test/recordings/${call.call_id}.wav`,
        transcript: transcript.map((t) => `${t.role}: ${t.content}`).join("\n"),
        transcript_object: transcript,
        call_analysis: {
          call_summary: outcome.summary ?? "Caller asked about an appointment next week.",
          custom_analysis_data: {
            ...(outcome.callerName ? { caller_name: outcome.callerName } : {}),
            ...(outcome.callerKind ? { caller_kind: outcome.callerKind } : {}),
            urgent: outcome.urgent ?? false,
            ...(outcome.nextStep ? { next_step: outcome.nextStep } : {}),
          },
        },
      },
    });
    return res.status;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.headers.get("authorization") !== `Bearer ${this.key()}`) return Response.json({ error_message: "Invalid API key" }, { status: 401 });
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    if (path === "/list-phone-numbers") return Response.json([...this.numbers.values()]);
    if (path === "/create-phone-number") {
      const area = typeof body.area_code === "number" ? body.area_code : this.world.rng.int(201, 989);
      const number = `+1${area}555${String(this.world.rng.int(0, 9999)).padStart(4, "0")}`;
      const rec = { phone_number: number, nickname: body.nickname as string | undefined, inbound_webhook_url: body.inbound_webhook_url as string | undefined, area_code: area };
      this.numbers.set(number, rec);
      this.world.note("retell.number_bought", { number });
      return Response.json(rec, { status: 201 });
    }
    const del = /^\/delete-phone-number\/(.+)$/.exec(path);
    if (del && req.method === "DELETE") {
      const n = decodeURIComponent(del[1] as string);
      if (!this.numbers.delete(n)) return Response.json({ error_message: "Not found" }, { status: 404 });
      this.world.note("retell.number_released", { number: n });
      return new Response(null, { status: 204 });
    }
    if (path === "/v2/create-phone-call" || path === "/v2/create-web-call") {
      const call: Call = {
        call_id: this.id("call"),
        call_type: path.endsWith("web-call") ? "web_call" : "phone_call",
        agent_id: String(body.agent_id ?? body.override_agent_id ?? "agent_world"),
        ...(typeof body.from_number === "string" ? { from_number: body.from_number } : {}),
        ...(typeof body.to_number === "string" ? { to_number: body.to_number } : {}),
        metadata: (body.metadata ?? {}) as Record<string, unknown>,
      };
      this.calls.set(call.call_id, call);
      return Response.json({ ...call, call_status: "registered", access_token: `world_${call.call_id}` }, { status: 201 });
    }
    const delCall = /^\/v2\/delete-call\/(.+)$/.exec(path);
    if (delCall && req.method === "DELETE") {
      // Retell keeps calls it placed or answered; the world knows every call id it handed out.
      this.calls.delete(decodeURIComponent(delCall[1] as string));
      return new Response(null, { status: 204 });
    }
    const get = /^\/v2\/get-call\/(.+)$/.exec(path);
    if (get) {
      const call = this.calls.get(decodeURIComponent(get[1] as string));
      return call ? Response.json({ ...call, call_status: "ended" }) : Response.json({ error_message: "Not found" }, { status: 404 });
    }
    return Response.json({ error_message: `Retell twin has no ${req.method} ${path}` }, { status: 501 });
  }
}

export const retell = (world: World) => new RetellTwin(world);
