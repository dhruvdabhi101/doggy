import { useEffect, useState } from "react";
import { api, type Item } from "../lib/api";
import { useSpeech } from "../lib/speech";
import { Icon } from "./Icon";

export function Composer({ onSaved, onError }: { onSaved: (items: Item[], warning?: string) => void; onError: (m: string) => void }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const save = async (t: string, source: "voice" | "text") => {
    if (!t.trim()) return;
    setBusy(true);
    try { const r = await api.note(t.trim(), source); onSaved(r.items, r.warning); if (source === "text") setText(""); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  const speech = useSpeech((t) => save(t, "voice"));
  useEffect(() => { if (speech.error) onError(speech.error); }, [speech.error]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); save(text, "text"); }}>
      {speech.listening
        ? <div className="live" aria-live="polite">{speech.transcript || "Listening…"}</div>
        : <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Remember… “send Raj the deck by Friday”" disabled={busy} aria-label="New note" />}
      {speech.listening ? (
        <>
          <button type="button" className="ghost" onClick={speech.cancel}>Cancel</button>
          <button type="button" className="mic on" onClick={speech.stop} aria-label="Stop and save"><Icon name="stop" size={18} /></button>
        </>
      ) : (
        <>
          {text.trim() && <button className="primary" disabled={busy}>{busy ? "…" : "Save"}</button>}
          <button type="button" className="mic" onClick={speech.start} disabled={busy} aria-label="Speak a note"><Icon name="mic" size={22} /></button>
        </>
      )}
    </form>
  );
}
