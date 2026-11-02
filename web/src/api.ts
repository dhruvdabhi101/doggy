export type ItemType = "task" | "commitment" | "memory" | "decision" | "event";
export type Item = {
  id: string; type: ItemType; title: string; details: string | null; owner: string | null;
  counterparty: string | null; dueAt: string | null; status: "open" | "done" | "dismissed";
  evidence: string | null; sourceKind: "capture" | "voice" | "text"; sourceApp: string | null;
  sourceWindow: string | null; sourceId: string | null; confidence: number;
  createdAt: string; updatedAt: string; seq: number;
};
export type Device = { id: string; name: string; kind: string; lastSeenAt: string | null; createdAt: string };
export type Session = { token: string; user: { id: string; email: string; name: string | null } };
export type CaptureHit = { id: number; app: string; window: string; text: string; capturedAt: string };

const KEY = "doggy.session";
export function loadSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
}
export function saveSession(s: Session | null) {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* private mode */ }
}

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = init.token ?? loadSession()?.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body as T;
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  return `${os} browser`;
};
const deviceKind = () => (/iPhone|iPad/.test(navigator.userAgent) ? "ios" : /Android/.test(navigator.userAgent) ? "android" : "web");

export const api = {
  auth: (mode: "login" | "signup", email: string, password: string, name?: string) =>
    call<Session>(`/api/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify({ email, password, name, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, deviceName: deviceName(), deviceKind: deviceKind() }),
    }),
  health: () => call<{ ok: boolean; llm: string }>("/api/health"),
  changes: (since: number) => call<{ items: Item[]; cursor: number }>(`/api/changes?since=${since}`),
  note: (text: string, source: "voice" | "text") =>
    call<{ items: Item[]; warning?: string }>("/api/notes", { method: "POST", body: JSON.stringify({ text, source }) }),
  patch: (id: string, patch: Partial<Pick<Item, "status" | "title" | "dueAt">>) =>
    call<{ item: Item }>(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  search: (q: string) => call<{ items: Item[]; captures: CaptureHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  ask: (question: string) => call<{ answer: string; sources: Item[] }>("/api/ask", { method: "POST", body: JSON.stringify({ question }) }),
  devices: () => call<{ devices: Device[] }>("/api/devices"),
  removeDevice: (id: string) => call(`/api/devices/${id}`, { method: "DELETE" }),
  downloads: () => call<{ mac?: string; windows?: string }>("/api/downloads"),
};
