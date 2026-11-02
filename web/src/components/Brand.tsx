import { Link } from "../lib/router";

export function Brand({ to = "/", size = 28 }: { to?: string; size?: number }) {
  return <Link to={to} className="brand"><img src="/icon.svg" alt="" width={size} height={size} /> Doggy</Link>;
}
