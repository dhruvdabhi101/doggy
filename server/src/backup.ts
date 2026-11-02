import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type TableCounts = { users: number; items: number; captures: number; notes: number; devices: number };

const TABLES = ["users", "items", "captures", "notes", "devices"] as const;

function countsOf(db: Database): TableCounts {
  const out = {} as TableCounts;
  for (const t of TABLES) out[t] = (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return out;
}

export function readCounts(path: string): TableCounts {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 8000");
  try { return countsOf(db); } finally { db.close(); }
}

/** Consistent copy. VACUUM INTO does not rewrite the source file. */
export function snapshotDatabase(src: string, dest: string): { integrity: string; counts: TableCounts } {
  mkdirSync(dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  rmSync(partial, { force: true });
  const db = new Database(src);
  db.exec("PRAGMA busy_timeout = 8000");
  try {
    db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  const check = new Database(partial, { readonly: true });
  let integrity = "";
  let counts: TableCounts;
  try {
    integrity = (check.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    counts = countsOf(check);
  } finally {
    check.close();
  }
  if (integrity !== "ok") {
    rmSync(partial, { force: true });
    throw new Error(`backup integrity_check ${integrity}`);
  }
  rmSync(dest, { force: true });
  renameSync(partial, dest);
  return { integrity, counts };
}

/** Users, items, and notes are not supposed to disappear across a deploy. Captures expire on their own. */
export function shrinkReport(before: TableCounts, after: TableCounts): string[] {
  const losses: string[] = [];
  for (const k of ["users", "items", "notes"] as const) {
    if (after[k] < before[k]) losses.push(`${k} ${before[k]} -> ${after[k]}`);
  }
  return losses;
}
