import { useState } from "react";
import { api, type Session } from "../lib/api";
import { Brand } from "../components/Brand";
import { Link } from "../lib/router";

export function AuthForm({ initialMode = "login", onDone, title }: { initialMode?: "login" | "signup"; onDone: (s: Session) => void; title?: string }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onDone(await api.auth(mode, email, password, name || undefined)); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="card auth-card" onSubmit={submit}>
      <Brand size={32} />
      <h1 className="auth-title">{title ?? (mode === "signup" ? "Create your account" : "Welcome back")}</h1>
      {mode === "signup" && <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" aria-label="Name" />}
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" aria-label="Email" />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required
        minLength={mode === "signup" ? 8 : 1} aria-label="Password" autoComplete={mode === "login" ? "current-password" : "new-password"} />
      {err && <div className="error" role="alert">{err}</div>}
      <button className="primary" disabled={busy}>{busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}</button>
      <button type="button" className="link" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(null); }}>
        {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
      <p className="muted small legal-links"><Link to="/privacy">Privacy</Link> · <Link to="/retention">Data retention</Link></p>
    </form>
  );
}

export function AuthPage({ mode, onDone }: { mode: "login" | "signup"; onDone: (s: Session) => void }) {
  return <div className="auth"><AuthForm key={mode} initialMode={mode} onDone={onDone} /></div>;
}
