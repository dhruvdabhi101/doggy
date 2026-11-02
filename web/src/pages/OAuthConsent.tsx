import { useEffect, useState } from "react";
import { api, type Session } from "../lib/api";
import { Brand } from "../components/Brand";
import { Icon } from "../components/Icon";
import { AuthForm } from "./Auth";

const PASS = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"] as const;

/** /oauth/authorize: an AI app (Claude, ChatGPT, ...) asks to use this account over MCP. */
export function OAuthConsent({ session, onSignIn, onSignOut }: { session: Session | null; onSignIn: (s: Session) => void; onSignOut: () => void }) {
  const qs = new URLSearchParams(location.search);
  const params = Object.fromEntries(PASS.map((k) => [k, qs.get(k) ?? ""])) as Record<(typeof PASS)[number], string>;
  const [client, setClient] = useState<{ name: string; redirectHost: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (qs.get("response_type") !== "code" || !params.client_id || !params.redirect_uri) { setError("This sign-in link is incomplete."); return; }
    api.oauthClient(params.client_id, params.redirect_uri).then(setClient).catch(() => setError("This app isn't registered, or its link is invalid."));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (approve: boolean) => {
    setBusy(true);
    try { location.assign((await api.oauthApprove(params, approve)).redirect); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  if (error) return <div className="auth"><div className="card auth-card"><Brand size={32} /><h1 className="auth-title">Can't connect</h1><p className="muted">{error}</p></div></div>;
  if (!client) return <div className="auth"><div className="card auth-card skeleton" aria-busy="true" /></div>;
  if (!session) return <div className="auth"><AuthForm onDone={onSignIn} title={`Sign in to connect ${client.name}`} /></div>;

  return (
    <div className="auth">
      <div className="card auth-card consent">
        <Brand size={32} />
        <h1 className="auth-title"><b>{client.name}</b> wants to use your Doggy memory</h1>
        <ul className="perms">
          <li><Icon name="search" size={18} /> Search your memories and screen history</li>
          <li><Icon name="loops" size={18} /> See your open tasks and commitments</li>
          <li><Icon name="memory" size={18} /> Save new notes</li>
        </ul>
        <p className="muted small">Signed in as <b>{session.user.email}</b> · <button className="link small" onClick={onSignOut}>Not you?</button></p>
        <p className="muted small">You'll return to <b>{client.redirectHost}</b>. Disconnect any time under Connect AI.</p>
        <div className="consent-actions">
          <button className="secondary" onClick={() => decide(false)} disabled={busy}>Cancel</button>
          <button className="primary" onClick={() => decide(true)} disabled={busy}>{busy ? "…" : "Allow"}</button>
        </div>
      </div>
    </div>
  );
}
