import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

export type Theme = "system" | "dark" | "light";
const KEY = "pp.theme";
let theme: Theme = readJson<Theme>(KEY, "system");
const listeners = new Set<() => void>();

function apply() {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}
apply();

export function setTheme(t: Theme): void {
  theme = t;
  writeJson(KEY, t);
  apply();
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => theme,
    () => theme,
  );
}
