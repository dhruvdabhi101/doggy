import { useEffect, useState } from "react";
import { api, loadSession, saveSession, type Session } from "./lib/api";
import { navigate, useLocation } from "./lib/router";
import { isStandalone } from "./lib/platform";
import { Dashboard, TABS } from "./dashboard/Dashboard";
import { Landing } from "./pages/Landing";
import { AuthPage } from "./pages/Auth";
import { OAuthConsent } from "./pages/OAuthConsent";
import { Legal, legalPageFor } from "./pages/Legal";

const LEGACY_TAB: Record<string, string> = { today: "/app", ask: "/app/ask", memory: "/app/memory", devices: "/app/devices" };

export default function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const { path } = useLocation();
  const signIn = (s: Session) => { saveSession(s); setSession(s); };
  const signOut = () => { api.logout().catch(() => {}); saveSession(null); setSession(null); };

  const tab = TABS.find((t) => t.path === path);
  const isAuth = path === "/signin" || path === "/signup";

  useEffect(() => {
    const legacy = new URLSearchParams(location.search).get("tab");
    if (path === "/" && legacy && LEGACY_TAB[legacy]) navigate(LEGACY_TAB[legacy], true);
    else if (path === "/" && session && isStandalone()) navigate("/app", true);
    else if (tab && !session) navigate("/signin", true);
    else if (isAuth && session) navigate("/app", true);
  }, [path, session, tab, isAuth]);

  const legal = legalPageFor(path);
  if (legal) return <Legal page={legal} />;
  if (path === "/oauth/authorize") return <OAuthConsent session={session} onSignIn={signIn} onSignOut={signOut} />;
  if (isAuth && !session) return <AuthPage mode={path === "/signup" ? "signup" : "login"} onDone={signIn} />;
  if (tab && session) return <Dashboard session={session} tab={tab.key} onLogout={() => { signOut(); navigate("/"); }} />;
  return <Landing signedIn={!!session} />;
}
