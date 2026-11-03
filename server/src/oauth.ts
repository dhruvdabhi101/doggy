import type { Context, Hono } from "hono";
import { issueDevice, requireAuth, sha256, type AuthEnv } from "./auth";
import { db, now, uid } from "./db";
import { rateLimit } from "./ratelimit";
import { track } from "./analytics";

/**
 * OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Cursor, ...).
 * A client discovers us from the 401 on /mcp, registers itself (RFC 7591), sends the user to
 * /oauth/authorize (a page in the web app), and swaps the code for a device token (PKCE S256 only).
 * Access tokens are ordinary device tokens, so they show up under Devices and can be revoked there.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`);
try { db.exec("ALTER TABLE oauth_clients ADD COLUMN used_at TEXT"); } catch (e) {
  if (!/duplicate column/i.test((e as Error).message)) throw e;
}

/** Registrations that never finished sign-in are dropped after a day. */
function pruneClients() {
  db.query("DELETE FROM oauth_clients WHERE used_at IS NULL AND created_at < ?").run(new Date(Date.now() - 86_400_000).toISOString());
}

const CODE_TTL_MS = 5 * 60_000;
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

export function publicOrigin(c: Context): string {
  if (process.env.DOGGY_PUBLIC_URL) return process.env.DOGGY_PUBLIC_URL.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(":", "");
  return `${proto}://${c.req.header("host") ?? url.host}`;
}

export const resourceMetadataUrl = (c: Context) => `${publicOrigin(c)}/.well-known/oauth-protected-resource/mcp`;

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || BAD_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return true;
}

type Client = { id: string; name: string; redirectUris: string[] };
function getClient(id: unknown): Client | null {
  if (typeof id !== "string") return null;
  const r = db.query("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?").get(id) as
    | { id: string; name: string; redirect_uris: string } | null;
  return r ? { id: r.id, name: r.name, redirectUris: JSON.parse(r.redirect_uris) } : null;
}

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status, { "cache-control": "no-store" });

export function mountOAuth(app: Hono<AuthEnv>) {
  const protectedResource = (c: Context) => c.json({
    resource: `${publicOrigin(c)}/mcp`,
    authorization_servers: [publicOrigin(c)],
    bearer_methods_supported: ["header"],
  });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const o = publicOrigin(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  app.post("/oauth/register", rateLimit("oauth-register", 20, 3600_000), async (c) => {
    const b = (await c.req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = Array.isArray(b?.redirect_uris) ? b!.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirect))
      return oauthError(c, "invalid_redirect_uri", "redirect_uris must be https, a loopback http URL, or an app scheme");
    const name = (typeof b?.client_name === "string" && b.client_name.trim() ? b.client_name.trim() : "MCP client").slice(0, 80);
    pruneClients();
    const id = uid();
    db.query("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)")
      .run(id, name, JSON.stringify(uris), now());
    return c.json({
      client_id: id, client_name: name, redirect_uris: uris,
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
    }, 201);
  });

  // Public: lets the consent page show which app is asking, and refuse unknown redirects before sign-in.
  app.get("/oauth/client", (c) => {
    const client = getClient(c.req.query("client_id"));
    const redirect = c.req.query("redirect_uri");
    if (!client || !redirect || !client.redirectUris.includes(redirect)) return c.json({ error: "Unknown app or redirect" }, 400);
    return c.json({ name: client.name, redirectHost: new URL(redirect).host || new URL(redirect).protocol });
  });

  // The signed-in user approved the app on the consent page. Returns where to send the browser.
  app.post("/oauth/approve", requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const client = getClient(b.client_id);
    const redirect = typeof b.redirect_uri === "string" ? b.redirect_uri : "";
    if (!client || !client.redirectUris.includes(redirect)) return c.json({ error: "Unknown app or redirect" }, 400);
    const back = new URL(redirect);
    if (typeof b.state === "string") back.searchParams.set("state", b.state.slice(0, 500));
    back.searchParams.set("iss", publicOrigin(c));
    if (b.approve !== true) {
      back.searchParams.set("error", "access_denied");
      return c.json({ redirect: back.toString() });
    }
    const challenge = typeof b.code_challenge === "string" ? b.code_challenge : "";
    if (b.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      back.searchParams.set("error", "invalid_request");
      back.searchParams.set("error_description", "PKCE with S256 is required");
      return c.json({ redirect: back.toString() });
    }
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    db.query("DELETE FROM oauth_codes WHERE expires_at < ?").run(Date.now());
    db.query("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES (?,?,?,?,?,?)")
      .run(sha256(code), client.id, c.get("user").id, redirect, challenge, Date.now() + CODE_TTL_MS);
    back.searchParams.set("code", code);
    track(c.get("user").id, c.get("device").kind, { event: "ai_connection_approved" });
    return c.json({ redirect: back.toString() });
  });

  app.post("/oauth/token", rateLimit("oauth-token", 60, 600_000), async (c) => {
    const type = c.req.header("content-type") ?? "";
    const raw = type.includes("application/json")
      ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
      : Object.fromEntries(Object.entries(await c.req.parseBody().catch(() => ({}))));
    const p = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
    if (p("grant_type") !== "authorization_code") return oauthError(c, "unsupported_grant_type", "Only authorization_code is supported");
    const row = db.query("DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *").get(sha256(p("code"))) as
      | { client_id: string; user_id: string; redirect_uri: string; challenge: string; expires_at: number } | null;
    if (!row || row.expires_at < Date.now()) return oauthError(c, "invalid_grant", "Code is invalid or expired");
    if (row.client_id !== p("client_id") || row.redirect_uri !== p("redirect_uri"))
      return oauthError(c, "invalid_grant", "client_id or redirect_uri does not match");
    const verifier = p("code_verifier");
    const expected = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || expected !== row.challenge)
      return oauthError(c, "invalid_grant", "PKCE verification failed");
    const client = getClient(row.client_id);
    db.query("UPDATE oauth_clients SET used_at = ? WHERE id = ?").run(now(), row.client_id);
    const { token } = issueDevice(row.user_id, client?.name ?? "MCP client", "mcp");
    return c.json({ access_token: token, token_type: "Bearer" }, 200, { "cache-control": "no-store" });
  });
}
