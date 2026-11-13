// Generic data checks: they read only the schema, so every product gets them without writing a rule.
//   duplicates: rows identical in every column except keys and timestamps
//   orphans:    child rows whose parent is gone (declared foreign keys, plus `<thing>_id` → `<thing>s.id` by name)
import type { DataObs } from "../contract.ts";
import type { HostedApp } from "./world.ts";

const INTERNAL = /^(sqlite_|_cf_|d1_|__)/;
const KEYLIKE = /(^id$|^at$|_at$|^created|^updated|_time$|^time$|timestamp|_ts$)/i;
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

type Column = { name: string; pk: number; type: string };

export async function inspectData(
  app: HostedApp,
  opts: { duplicatesIgnore: string[]; duplicatesIgnoreColumns: string[] },
): Promise<DataObs> {
  const out: DataObs = { tables: [], duplicates: [], orphans: [] };
  for (const db of app.databases()) {
    const tables = (await app.sql(db, "SELECT name FROM sqlite_master WHERE type = 'table'"))
      .map((r) => String(r.name))
      .filter((n) => !INTERNAL.test(n));
    const columns = new Map<string, Column[]>();
    for (const t of tables) columns.set(t, (await app.sql(db, `PRAGMA table_info(${q(t)})`)) as unknown as Column[]);
    const label = (t: string) => (app.databases().length > 1 ? `${db}.${t}` : t);

    for (const t of tables) {
      const [{ n }] = (await app.sql(db, `SELECT count(*) AS n FROM ${q(t)}`)) as [{ n: number }];
      out.tables.push({ name: label(t), rows: n });
      if (n < 2 || opts.duplicatesIgnore.includes(t)) continue;
      const cols = (columns.get(t) ?? []).filter((c) => c.pk === 0 && !KEYLIKE.test(c.name) && !opts.duplicatesIgnoreColumns.includes(c.name));
      if (cols.length < 2) continue;
      const list = cols.map((c) => q(c.name)).join(", ");
      const dupes = await app.sql(db, `SELECT ${list}, count(*) AS _n FROM ${q(t)} GROUP BY ${list} HAVING count(*) > 1 ORDER BY _n DESC`);
      if (dupes.length) {
        out.duplicates.push({
          table: label(t),
          groups: dupes.length,
          extraRows: dupes.reduce((s, r) => s + Number(r._n) - 1, 0),
          sample: dupes.slice(0, 3),
        });
      }
    }

    // Parent tables by name, for `<thing>_id` columns with no declared foreign key.
    const byName = new Map<string, string>();
    for (const t of tables) {
      if (!(columns.get(t) ?? []).some((c) => c.name === "id")) continue;
      byName.set(t, t);
      byName.set(t.replace(/s$/, ""), t);
      byName.set(t.replace(/ies$/, "y"), t);
    }
    for (const t of tables) {
      const declared = (await app.sql(db, `PRAGMA foreign_key_list(${q(t)})`)) as { table: string; from: string; to: string | null }[];
      const relations = declared.map((f) => ({ column: f.from, parent: f.table, key: f.to ?? "id" }));
      for (const c of columns.get(t) ?? []) {
        const m = /^(.+)_id$/.exec(c.name);
        if (!m || relations.some((r) => r.column === c.name)) continue;
        const parent = byName.get(m[1] as string);
        if (parent && parent !== t) relations.push({ column: c.name, parent, key: "id" });
      }
      for (const r of relations) {
        const sql = `SELECT ${q(r.column)} AS missing, count(*) AS n FROM ${q(t)} c WHERE c.${q(r.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(r.parent)} p WHERE p.${q(r.key)} = c.${q(r.column)}) GROUP BY 1 ORDER BY 2 DESC`;
        let rows: Record<string, unknown>[];
        try {
          rows = await app.sql(db, sql);
        } catch {
          continue;
        }
        const count = rows.reduce((s, x) => s + Number(x.n), 0);
        if (count) out.orphans.push({ table: label(t), column: r.column, parent: label(r.parent), rows: count, sample: rows.slice(0, 3) });
      }
    }
  }
  return out;
}
