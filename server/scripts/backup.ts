import { readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCounts, shrinkReport, snapshotDatabase, type TableCounts } from "../src/backup";

function pruneDaily(dir: string) {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  const daily = names.filter((n) => /^daily-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort();
  for (const n of daily.slice(0, Math.max(0, daily.length - 14))) {
    rmSync(join(dir, n), { force: true });
    rmSync(join(dir, `${n}.json`), { force: true });
  }
}

if (process.argv[2] === "--expect") {
  const live = process.argv[3];
  const meta = process.argv[4];
  if (!live || !meta) {
    console.error("usage: backup.ts --expect <live.db> <snapshot.json>");
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(meta, "utf8")) as TableCounts;
  const after = readCounts(live);
  const losses = shrinkReport(before, after);
  if (losses.length) {
    console.error(losses.join("\n"));
    process.exit(1);
  }
  console.log(JSON.stringify(after));
  process.exit(0);
}

const src = process.argv[2];
if (!src) {
  console.error("usage: backup.ts <source.db> [dest.db]");
  process.exit(2);
}
const dest = process.argv[3] ?? join(dirname(src), "backups", `daily-${new Date().toISOString().slice(0, 10)}.db`);
const result = snapshotDatabase(src, dest);
writeFileSync(`${dest}.json`, JSON.stringify(result.counts));
pruneDaily(dirname(dest));
console.log(JSON.stringify({ path: dest, integrity: result.integrity, counts: result.counts }));
