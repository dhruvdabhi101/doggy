import { useCallback, useEffect, useState } from "react";
import { api, type Item, type ItemPatch, type Session } from "../lib/api";
import { Link } from "../lib/router";
import { useItems } from "../hooks/useItems";
import { Brand } from "../components/Brand";
import { Composer } from "../components/Composer";
import { Icon, type IconName } from "../components/Icon";
import { InstallHint } from "../components/InstallHint";
import { Ask } from "./Ask";
import { Connect } from "./Connect";
import { Devices } from "./Devices";
import { Memory } from "./Memory";
import { OpenLoops } from "./OpenLoops";

export const TABS = [
  { key: "loops", path: "/app", label: "Open loops", short: "Loops", icon: "loops" },
  { key: "ask", path: "/app/ask", label: "Ask", short: "Ask", icon: "ask" },
  { key: "memory", path: "/app/memory", label: "Memory", short: "Memory", icon: "memory" },
  { key: "connect", path: "/app/connect", label: "Connect AI", short: "Connect", icon: "connect" },
  { key: "devices", path: "/app/devices", label: "Devices", short: "Devices", icon: "devices" },
] as const satisfies readonly { key: string; path: string; label: string; short: string; icon: IconName }[];
export type TabKey = (typeof TABS)[number]["key"];

export function Dashboard({ session, tab, onLogout }: { session: Session; tab: TabKey; onLogout: () => void }) {
  const { items, loaded, total, upsert, begin, end } = useItems(onLogout);
  const [toast, setToast] = useState<string | null>(null);
  const [saved, setSaved] = useState(0);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  // Optimistic; the server's copy wins once it answers.
  const update = useCallback(async (it: Item, patch: ItemPatch): Promise<boolean> => {
    begin(it.id);
    upsert([{ ...it, ...patch }]);
    try { upsert([(await api.patch(it.id, patch)).item]); return true; }
    catch (e) { upsert([it]); setToast((e as Error).message); return false; }
    finally { end(it.id); }
  }, [begin, end, upsert]);

  const showComposer = tab === "loops" || tab === "memory";
  return (
    <div className={`shell ${showComposer ? "has-composer" : ""}`}>
      <header className="top">
        <Brand to="/app" />
        <nav className="tabs desktop-only" aria-label="Sections">
          {TABS.map((t) => (
            <Link key={t.key} to={t.path} className={tab === t.key ? "on" : ""} aria-current={tab === t.key ? "page" : undefined}>
              <Icon name={t.icon} size={17} />{t.label}
            </Link>
          ))}
        </nav>
        <div className="top-actions">
          <button className="icon-btn" title="Download your items" aria-label="Download your items" onClick={() => api.exportItems().catch((e) => setToast((e as Error).message))}><Icon name="download" size={19} /></button>
          <button className="icon-btn" onClick={onLogout} title={`Sign out ${session.user.email}`} aria-label="Sign out"><Icon name="out" size={19} /></button>
        </div>
      </header>
      <main>
        <InstallHint />
        {tab === "loops" && <OpenLoops items={items} loaded={loaded} total={total} onUpdate={update} />}
        {tab === "ask" && <Ask />}
        {tab === "memory" && <Memory saved={saved} onUpdate={update} />}
        {tab === "connect" && <Connect />}
        {tab === "devices" && <Devices currentEmail={session.user.email} />}
      </main>
      {showComposer && (
        <Composer
          onSaved={(list, warn) => { upsert(list); setSaved((n) => n + 1); setToast(warn ?? (list.length ? `Saved: ${list.map((i) => i.title).join(" · ")}` : "Saved")); }}
          onError={setToast}
        />
      )}
      <nav className="bottom mobile-only" aria-label="Sections">
        {TABS.map((t) => (
          <Link key={t.key} to={t.path} className={tab === t.key ? "on" : ""} aria-current={tab === t.key ? "page" : undefined}>
            <Icon name={t.icon} size={22} /><span>{t.short}</span>
          </Link>
        ))}
      </nav>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
