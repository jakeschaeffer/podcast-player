import { useSyncExternalStore } from "react";

// A history-based router small enough to read in one sitting. Routes are matched by pattern in App.tsx.
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
window.addEventListener("popstate", emit);

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function current(): string {
  return location.pathname + location.search;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  emit();
}

export function back(fallback: string): void {
  if (history.length > 1 && history.state !== "entry") history.back();
  else navigate(fallback, { replace: true });
}

export function useLocationPath(): string {
  return useSyncExternalStore(subscribe, current, current);
}

/** match("/library/:id", "/library/abc?x=1") → { id: "abc" } or null */
export function match(pattern: string, path: string): Record<string, string> | null {
  const [pathname] = path.split("?");
  const p = pattern.split("/");
  const s = (pathname ?? "").split("/");
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const a = p[i] ?? "";
    const b = s[i] ?? "";
    if (a.startsWith(":")) params[a.slice(1)] = decodeURIComponent(b);
    else if (a !== b) return null;
  }
  return params;
}

export function query(path: string): URLSearchParams {
  return new URLSearchParams(path.split("?")[1] ?? "");
}

/** Click handler for in-app links: left click without modifiers navigates with pushState. */
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute("href");
  if (!href || !href.startsWith("/")) return;
  e.preventDefault();
  navigate(href);
}
