import type { Context, Next } from "hono";
import { getConnInfo } from "hono/bun";

/** Fixed-window, in-memory. Enough for one server process. */
const buckets = new Map<string, { n: number; reset: number }>();
const MAX_BUCKETS = 50_000;

export function clientIp(c: Context): string {
  let peer = "unknown";
  try { peer = getConnInfo(c).remote.address ?? "unknown"; } catch { /* not running under Bun.serve */ }
  // Only a local reverse proxy (Caddy) may name the client. Its own entry is the last one, whether it appends or replaces.
  const fromProxy = /^(127\.|::1$|::ffff:127\.)/.test(peer);
  const xff = fromProxy ? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;
  return (xff || peer).slice(0, 64);
}

/** Per client IP by default; pass `keyOf` to limit per user or device instead. */
export function rateLimit(name: string, max: number, windowMs: number, keyOf: (c: Context<any>) => string = clientIp) {
  return async (c: Context<any>, next: Next) => {
    const key = `${name}:${keyOf(c)}`;
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= t) {
      if (buckets.size >= MAX_BUCKETS) sweep(t, true);
      b = { n: 0, reset: t + windowMs };
      buckets.set(key, b);
    }
    if (++b.n > max) {
      c.header("retry-after", String(Math.ceil((b.reset - t) / 1000)));
      return c.json({ error: "Too many requests. Try again later." }, 429);
    }
    await next();
  };
}

function sweep(t: number, force = false) {
  for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
  // Still full: drop the oldest tenth (Map iterates in insertion order).
  if (force && buckets.size >= MAX_BUCKETS) {
    let drop = Math.ceil(MAX_BUCKETS / 10);
    for (const k of buckets.keys()) { if (drop-- <= 0) break; buckets.delete(k); }
  }
}

setInterval(() => sweep(Date.now()), 60_000).unref?.();
