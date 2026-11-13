// Append-only observation files the host writes inside the sandbox and the runner reads afterwards.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Observations {
  private readonly buffers = new Map<string, string[]>();
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  add(kind: "requests" | "logs" | "egress" | "crons" | "invariants" | "timeline", row: object): void {
    let b = this.buffers.get(kind);
    if (!b) this.buffers.set(kind, (b = []));
    b.push(JSON.stringify(row));
    if (b.length >= 500) this.flush(kind);
  }

  flush(kind?: string): void {
    for (const [k, rows] of this.buffers) {
      if (kind && k !== kind) continue;
      if (rows.length) appendFileSync(join(this.dir, `${k}.jsonl`), rows.join("\n") + "\n");
      rows.length = 0;
    }
  }

  write(name: string, value: unknown): void {
    this.flush();
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2));
  }
}

// A log line's signature: the same mistake with different ids, numbers and times reads the same.
export function signature(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
    .replace(/\b[a-z]{2,8}_[A-Za-z0-9]{6,}\b/g, "<id>")
    .replace(/\+?\d[\d\s-]{5,}\d/g, "<num>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/"(event_id|user_id|id|request_id|requestId|call_id)":"[^"]*"/g, '"$1":"<id>"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// Is this log line an error? console.error/exceptions, or a structured line that says it failed.
export function isErrorLog(level: string, text: string): boolean {
  if (level === "error") return true;
  if (/^(Uncaught|Unhandled|TypeError|ReferenceError|RangeError|SyntaxError)\b/.test(text)) return true;
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      if (o.level === "error" || o.level === "fatal") return true;
      if (typeof o.status === "string" && /(^|_)(failed|error|crashed)$/.test(o.status)) return true;
    } catch {
      /* not JSON */
    }
  }
  return false;
}

// "/api/v1/calls/call_8xk2…/done" → "/api/v1/calls/:id/done", so a route's requests group together.
export function routeOf(path: string): string {
  const [p] = path.split("?");
  return (p ?? "/")
    .split("/")
    .map((s) => (/^(\d+|[0-9a-f-]{16,}|[A-Za-z]{2,8}_[A-Za-z0-9]{6,}|\+?\d{6,}|user_[A-Za-z0-9]+|[A-Za-z0-9_-]{20,})$/i.test(s) ? ":id" : s))
    .join("/");
}
