import { useState } from "react";
import { api, type Item } from "../lib/api";

type Turn = { q: string; a: string; sources: Item[] };
const EXAMPLES = ["What did I promise to do this week?", "What am I forgetting?", "What's overdue?"];

export function Ask() {
  const [q, setQ] = useState(""); const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<Turn[]>([]);
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true); setQ("");
    try { const r = await api.ask(question); setThread((t) => [...t, { q: question, a: r.answer, sources: r.sources }]); }
    catch (e) { setThread((t) => [...t, { q: question, a: (e as Error).message, sources: [] }]); }
    finally { setBusy(false); }
  };
  return (
    <section className="ask">
      {!thread.length && (
        <div className="ask-intro">
          <h2 className="ask-title">Ask your memory</h2>
          <div className="examples">{EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => ask(e)}>{e}</button>)}</div>
        </div>
      )}
      {thread.map((t, i) => (
        <div key={i} className="qa">
          <div className="q">{t.q}</div>
          <div className="a">{t.a}</div>
          {!!t.sources.length && (
            <details><summary className="muted small">Related ({t.sources.length})</summary>
              <ul className="sources">{t.sources.map((s) => <li key={s.id}>{s.title} <span className="muted small">{s.type}</span></li>)}</ul>
            </details>
          )}
        </div>
      ))}
      {busy && <div className="qa"><div className="a thinking" aria-busy="true">Thinking…</div></div>}
      <form className="askbar" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={1000} placeholder="What did I say I'd do for Raj?" aria-label="Question" />
        <button className="primary" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </section>
  );
}
