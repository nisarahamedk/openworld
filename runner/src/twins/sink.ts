// A sink stand-in: accepts anything (email, analytics) and keeps it, so checks and scenarios can read what was sent.
import type { Twin, World } from "../host/world.ts";

export class SinkTwin implements Twin {
  readonly received: { t: number; method: string; path: string; body: string }[] = [];
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "GET" ? "" : await req.text();
    if (this.received.length < 5000) this.received.push({ t: Date.now(), method: req.method, path: url.pathname, body: body.slice(0, 2000) });
    return Response.json({ id: `sink_${this.received.length}`, ok: true });
  }
}

export const sink = (_world: World, o: { host: string }) => new SinkTwin(`sink:${o.host}`);
