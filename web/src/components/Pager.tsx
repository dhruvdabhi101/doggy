import { Icon } from "./Icon";

export const PAGE_SIZE = 20;

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const go = (p: number) => { onPage(p); scrollTo({ top: 0, behavior: "smooth" }); };
  return (
    <nav className="pager" aria-label="Pages">
      <button className="pager-btn" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page"><Icon name="left" size={18} /></button>
      <span className="pager-label">Page <b>{page}</b> of {pages} <span className="muted">· {total}</span></span>
      <button className="pager-btn" onClick={() => go(page + 1)} disabled={page >= pages} aria-label="Next page"><Icon name="right" size={18} /></button>
    </nav>
  );
}
