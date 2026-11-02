import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, loadSession, saveSession, type CaptureHit, type Device, type Item, type Session } from "./api";
import { useSpeech } from "./speech";

type Tab = "today" | "ask" | "memory" | "devices";

export default function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  if (!session) return <Auth onDone={(s) => { saveSession(s); setSession(s); }} />;
  return <Main session={session} onLogout={() => { saveSession(null); setSession(null); }} />;
}

// ---------------- auth ----------------
function Auth({ onDone }: { onDone: (s: Session) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onDone(await api.auth(mode, email, password, name || undefined)); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand"><img src="/icon.svg" alt="" width={36} height={36} /> Doggy</div>
        <p className="muted">Remembers what you promised, what you were asked, and what you said — across all your devices.</p>
        {mode === "signup" && <input placeholder="Your name (so I know who “me” is)" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
          autoComplete={mode === "login" ? "current-password" : "new-password"} />
        {err && <div className="error">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}</button>
        <button type="button" className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

// ---------------- data: incremental sync ----------------
function useItems(onUnauthorized: () => void) {
  const [items, setItems] = useState<Map<string, Item>>(new Map());
  const cursor = useRef(0);
  const sync = useCallback(async () => {
    try {
      let more = true;
      while (more) {
        const r = await api.changes(cursor.current);
        if (r.items.length) setItems((m) => { const n = new Map(m); r.items.forEach((i) => n.set(i.id, i)); return n; });
        more = r.items.length >= 1000; cursor.current = r.cursor;
      }
    } catch (e) { if (e instanceof ApiError && e.status === 401) onUnauthorized(); }
  }, [onUnauthorized]);
  useEffect(() => {
    sync();
    const t = setInterval(sync, 10_000);
    const vis = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [sync]);
  const upsert = (list: Item[]) => setItems((m) => { const n = new Map(m); list.forEach((i) => n.set(i.id, i)); return n; });
  return { items: [...items.values()], upsert, sync };
}

// ---------------- main shell ----------------
function Main({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("today");
  const { items, upsert } = useItems(onLogout);
  const [toast, setToast] = useState<string | null>(null);
  const [llm, setLlm] = useState<string>("");
  useEffect(() => { api.health().then((h) => setLlm(h.llm)).catch(() => {}); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const setStatus = async (it: Item, status: Item["status"]) => {
    upsert([{ ...it, status }]);
    try { upsert([(await api.patch(it.id, { status })).item]); } catch (e) { setToast((e as Error).message); }
  };

  const tabs: [Tab, string][] = [["today", "Open loops"], ["ask", "Ask"], ["memory", "Memory"], ["devices", "Devices"]];
  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><img src="/icon.svg" alt="" width={28} height={28} /> Doggy</div>
        <nav className="tabs desktop-only">
          {tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
        </nav>
        <button className="link small" onClick={onLogout} title={session.user.email}>Sign out</button>
      </header>
      <main>
        {tab === "today" && <Today items={items} onStatus={setStatus} />}
        {tab === "ask" && <Ask />}
        {tab === "memory" && <Memory items={items} onStatus={setStatus} />}
        {tab === "devices" && <Devices llm={llm} />}
      </main>
      <Composer onSaved={(list, warn) => { upsert(list); setToast(warn ?? (list.length ? `Saved: ${list.map((i) => i.title).join(" · ")}` : "Saved to memory")); }}
        onError={(m) => setToast(m)} />
      <nav className="bottom mobile-only">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </nav>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

// ---------------- composer (text + voice) ----------------
function Composer({ onSaved, onError }: { onSaved: (items: Item[], warning?: string) => void; onError: (m: string) => void }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const save = async (t: string, source: "voice" | "text") => {
    if (!t.trim()) return;
    setBusy(true);
    try { const r = await api.note(t.trim(), source); onSaved(r.items, r.warning); if (source === "text") setText(""); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  const speech = useSpeech((t) => save(t, "voice"));
  useEffect(() => { if (speech.error) onError(speech.error); }, [speech.error]); // eslint-disable-line

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); save(text, "text"); }}>
      {speech.listening ? (
        <div className="live" aria-live="polite">{speech.transcript || "Listening… just talk normally"}</div>
      ) : (
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Remember… (e.g. “send Raj the deck by Friday”)" disabled={busy} />
      )}
      {speech.listening ? (
        <>
          <button type="button" className="ghost" onClick={speech.cancel}>Cancel</button>
          <button type="button" className="mic on" onClick={speech.stop} aria-label="Stop and save">■</button>
        </>
      ) : (
        <>
          {text.trim() && <button className="primary" disabled={busy}>{busy ? "…" : "Save"}</button>}
          <button type="button" className="mic" onClick={speech.start} disabled={busy} aria-label="Speak a note">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" /></svg>
          </button>
        </>
      )}
    </form>
  );
}

// ---------------- open loops ----------------
const LOOP_TYPES = new Set(["task", "commitment", "event"]);
function bucket(i: Item): string {
  if (!i.dueAt) return "No date";
  const d = new Date(i.dueAt); const n = new Date();
  const sod = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (d.getTime() < n.getTime()) return "Overdue";
  if (d.getTime() < sod + 86_400_000) return "Today";
  if (d.getTime() < sod + 7 * 86_400_000) return "This week";
  return "Later";
}
const ORDER = ["Overdue", "Today", "This week", "Later", "No date"];

function Today({ items, onStatus }: { items: Item[]; onStatus: (i: Item, s: Item["status"]) => void }) {
  const open = items.filter((i) => i.status === "open" && LOOP_TYPES.has(i.type));
  const groups = useMemo(() => {
    const g = new Map<string, Item[]>();
    for (const i of open) { const b = bucket(i); g.set(b, [...(g.get(b) ?? []), i]); }
    for (const l of g.values()) l.sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") || b.createdAt.localeCompare(a.createdAt));
    return ORDER.filter((k) => g.has(k)).map((k) => [k, g.get(k)!] as const);
  }, [open]);
  if (!open.length) return <Empty title="Nothing open" body="Speak or type something to remember, or connect a desktop agent so Doggy can pick up tasks from your chats and email." />;
  return (
    <section>
      {groups.map(([k, list]) => (
        <div key={k} className="group">
          <h2 className={k === "Overdue" ? "danger" : ""}>{k} <span className="count">{list.length}</span></h2>
          {list.map((i) => <ItemRow key={i.id} item={i} onStatus={onStatus} />)}
        </div>
      ))}
    </section>
  );
}

const fmtDate = (s: string) => {
  const d = new Date(s);
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const SOURCE_LABEL = { capture: "seen on screen", voice: "you said", text: "you wrote" } as const;

function ItemRow({ item, onStatus }: { item: Item; onStatus: (i: Item, s: Item["status"]) => void }) {
  const [open, setOpen] = useState(false);
  const done = item.status !== "open";
  return (
    <div className={`item ${done ? "done" : ""}`}>
      <button className={`check ${item.status === "done" ? "on" : ""}`} aria-label={done ? "Reopen" : "Mark done"}
        onClick={() => onStatus(item, done ? "open" : "done")}>{item.status === "done" ? "✓" : ""}</button>
      <div className="body" onClick={() => setOpen(!open)}>
        <div className="title">{item.title}</div>
        <div className="meta">
          <span className={`tag ${item.type}`}>{item.type}</span>
          {item.dueAt && <span>{fmtDate(item.dueAt)}</span>}
          {item.counterparty && <span>with {item.counterparty}</span>}
          {item.owner && item.owner !== "me" && <span>owner {item.owner}</span>}
          <span className="src">{item.sourceApp ? `${item.sourceApp}` : SOURCE_LABEL[item.sourceKind]}</span>
        </div>
        {open && (
          <div className="detail">
            {item.details && <p>{item.details}</p>}
            {item.evidence && <blockquote>“{item.evidence}”</blockquote>}
            <p className="muted small">{SOURCE_LABEL[item.sourceKind]}{item.sourceWindow ? ` · ${item.sourceWindow}` : ""} · {fmtDate(item.createdAt)} · confidence {Math.round(item.confidence * 100)}%</p>
            {!done && <button className="link small" onClick={(e) => { e.stopPropagation(); onStatus(item, "dismissed"); }}>Not a real task — dismiss</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- ask ----------------
function Ask() {
  const [q, setQ] = useState(""); const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<{ q: string; a: string; sources: Item[] }[]>([]);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true); setQ("");
    try { const r = await api.ask(question); setThread((t) => [...t, { q: question, a: r.answer, sources: r.sources }]); }
    catch (e) { setThread((t) => [...t, { q: question, a: (e as Error).message, sources: [] }]); }
    finally { setBusy(false); }
  };
  const examples = ["What did I promise to do this week?", "What am I forgetting?", "What did Raj ask me for?"];
  return (
    <section className="ask">
      {!thread.length && (
        <div className="examples">{examples.map((e) => <button key={e} className="chip" onClick={() => ask(e)}>{e}</button>)}</div>
      )}
      {thread.map((t, i) => (
        <div key={i} className="qa">
          <div className="q">{t.q}</div>
          <div className="a">{t.a}</div>
          {!!t.sources.length && (
            <details><summary className="muted small">{t.sources.length} sources</summary>
              <ol className="sources">{t.sources.map((s) => <li key={s.id}>{s.title} <span className="muted small">({s.type}{s.sourceApp ? `, ${s.sourceApp}` : ""})</span></li>)}</ol>
            </details>
          )}
        </div>
      ))}
      <form className="askbar" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about anything you've seen, said or promised…" />
        <button className="primary" disabled={busy || !q.trim()}>{busy ? "…" : "Ask"}</button>
      </form>
    </section>
  );
}

// ---------------- memory (search + timeline) ----------------
function Memory({ items, onStatus }: { items: Item[]; onStatus: (i: Item, s: Item["status"]) => void }) {
  const [q, setQ] = useState(""); const [hits, setHits] = useState<{ items: Item[]; captures: CaptureHit[] } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = setTimeout(() => api.search(q).then(setHits).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = (hits?.items ?? [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    .filter((i) => i.status !== "dismissed" && (filter === "all" || i.type === filter));
  return (
    <section>
      <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything…" />
      <div className="filters">
        {["all", "task", "commitment", "event", "decision", "memory"].map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      {list.map((i) => <ItemRow key={i.id} item={i} onStatus={onStatus} />)}
      {!list.length && !hits?.captures.length && <Empty title={q ? "No matches" : "No memories yet"} body="Things you say, type, or that the desktop agent sees will show up here." />}
      {!!hits?.captures.length && (
        <div className="group"><h2>On your screen</h2>
          {hits.captures.map((c) => (
            <div key={c.id} className="capture"><div className="meta"><span className="src">{c.app}</span><span>{c.window}</span><span>{fmtDate(c.capturedAt)}</span></div><div>{c.text}</div></div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------- devices ----------------
function Devices({ llm }: { llm: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const load = () => api.devices().then((r) => setDevices(r.devices)).catch(() => {});
  useEffect(() => { load(); }, []);
  const origin = location.origin;
  return (
    <section className="devices">
      <div className="group"><h2>Signed-in devices</h2>
        <p className="muted small">Every device signed into this account sees the same memory. Sign in on your phone with the same email to sync.</p>
        {devices.map((d) => (
          <div key={d.id} className="device">
            <div><div className="title">{d.name}</div><div className="meta"><span className="tag">{d.kind}</span><span>last seen {d.lastSeenAt ? fmtDate(d.lastSeenAt) : "never"}</span></div></div>
            <button className="link small" onClick={async () => { await api.removeDevice(d.id); load(); }}>Remove</button>
          </div>
        ))}
      </div>
      <div className="group"><h2>Capture from your computer</h2>
        <p className="muted small">Mac: build <code>agents/mac</code>, grant Accessibility, then:</p>
        <pre>doggy-agent login --server {origin} --email you@example.com --password •••{"\n"}doggy-agent run</pre>
        <p className="muted small">Windows: same commands with <code>agents/windows</code> (doggy-agent.exe).</p>
      </div>
      <div className="group"><h2>Use with Claude / ChatGPT (MCP)</h2>
        <p className="muted small">Endpoint <code>{origin}/mcp</code> with header <code>Authorization: Bearer &lt;device token&gt;</code>. Tools: search_memory, list_open_loops, remember.</p>
      </div>
      <p className="muted small">Extraction engine: {llm || "…"}</p>
    </section>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="empty"><h3>{title}</h3><p className="muted">{body}</p></div>;
}
