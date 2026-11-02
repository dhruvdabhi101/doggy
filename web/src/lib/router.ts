import { useEffect, useState, type AnchorHTMLAttributes, createElement } from "react";

const EVENT = "doggy:navigate";

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new Event(EVENT));
  if (!replace) scrollTo(0, 0);
}

export function useLocation() {
  const read = () => ({ path: location.pathname.replace(/\/+$/, "") || "/", search: location.search });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    addEventListener("popstate", on);
    addEventListener(EVENT, on);
    return () => { removeEventListener("popstate", on); removeEventListener(EVENT, on); };
  }, []);
  return loc;
}

export function Link({ to, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return createElement("a", {
    ...rest, href: to,
    onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
      rest.onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    },
  });
}
