import type { Context, Next } from "hono";
import { db, now, uid } from "./db";

export type AuthUser = { id: string; email: string; name: string | null; tz: string };
export type AuthDevice = { id: string; name: string; kind: string };
export type AuthEnv = { Variables: { user: AuthUser; device: AuthDevice } };

const DEVICE_KINDS = new Set(["web", "mac-agent", "windows-agent", "ios", "android"]);

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

function issueDevice(userId: string, deviceName: string | undefined, deviceKind: string | undefined) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const kind = DEVICE_KINDS.has(deviceKind ?? "") ? deviceKind! : "web";
  const device = { id: uid(), name: (deviceName || kind).slice(0, 80), kind };
  db.query("INSERT INTO devices (id,user_id,name,kind,token_hash,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(device.id, userId, device.name, device.kind, sha256(token), now(), now());
  return { token, device };
}

type Creds = { email?: string; password?: string; name?: string; tz?: string; deviceName?: string; deviceKind?: string };

export async function signup(body: Creds) {
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@") || !body.password || body.password.length < 6)
    return { error: "Email and a password of at least 6 characters are required", status: 400 as const };
  if (db.query("SELECT 1 FROM users WHERE email = ?").get(email))
    return { error: "An account with this email already exists", status: 409 as const };
  const user = { id: uid(), email, name: body.name?.trim() || null, tz: body.tz || "UTC" };
  db.query("INSERT INTO users (id,email,name,pw_hash,tz,created_at) VALUES (?,?,?,?,?,?)")
    .run(user.id, email, user.name, await Bun.password.hash(body.password), user.tz, now());
  const { token, device } = issueDevice(user.id, body.deviceName, body.deviceKind);
  return { token, user: { id: user.id, email, name: user.name }, device };
}

export async function login(body: Creds) {
  const email = body.email?.trim().toLowerCase();
  const row = db.query("SELECT * FROM users WHERE email = ?").get(email ?? "") as
    | { id: string; email: string; name: string | null; pw_hash: string } | null;
  if (!row || !body.password || !(await Bun.password.verify(body.password, row.pw_hash)))
    return { error: "Invalid email or password", status: 401 as const };
  if (body.tz) db.query("UPDATE users SET tz = ? WHERE id = ?").run(body.tz, row.id);
  const { token, device } = issueDevice(row.id, body.deviceName, body.deviceKind);
  return { token, user: { id: row.id, email: row.email, name: row.name }, device };
}

export function userForToken(token: string): { user: AuthUser; device: AuthDevice } | null {
  const row = db.query(
    `SELECT u.id AS uid, u.email, u.name AS uname, u.tz, d.id AS did, d.name AS dname, d.kind
     FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`,
  ).get(sha256(token)) as any;
  if (!row) return null;
  db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), row.did);
  return {
    user: { id: row.uid, email: row.email, name: row.uname, tz: row.tz },
    device: { id: row.did, name: row.dname, kind: row.kind },
  };
}

export async function requireAuth(c: Context<AuthEnv>, next: Next) {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const auth = token ? userForToken(token) : null;
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", auth.user);
  c.set("device", auth.device);
  await next();
}
