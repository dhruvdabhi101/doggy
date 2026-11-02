export function Empty({ title, body }: { title: string; body?: string }) {
  return <div className="empty"><h3>{title}</h3>{body && <p className="muted">{body}</p>}</div>;
}
