import { useSyncExternalStore } from "react";

/**
 * The wide layout: landscape with room for two columns (the iPhone Duo's inner screen held wide, or a phone on its
 * side). Vertical space is scarce and horizontal space abundant, so navigation moves to a left rail, the player and
 * editor split into a controls column and a full-height reading column, and the snip card docks over the reading
 * column instead of over the controls. The same query lives in styles.css.
 */
export const WIDE_QUERY = "(orientation: landscape) and (min-width: 640px)";

/**
 * Short landscape: the wide layout with too little height for large artwork (a phone on its side, more so with
 * Safari's bars or a page zoom). Mirrors the max-height: 470px tier in styles.css.
 */
export const SHORT_QUERY = `${WIDE_QUERY} and (max-height: 470px)`;

/**
 * The desktop layout: a laptop or monitor browser window, or an iPad full screen. The wide layout's rail stays on every
 * screen (the player and editor included), pages use the width with list and detail side by side, and sheets become
 * centred dialogs. Phones and the Duo's inner screen stay below it. Mirrors the desktop tier in styles.css.
 */
export const DESKTOP_QUERY = `${WIDE_QUERY} and (min-width: 1024px) and (min-height: 600px)`;

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

export function useWide(): boolean {
  return useMediaQuery(WIDE_QUERY);
}

export function useShortLandscape(): boolean {
  return useMediaQuery(SHORT_QUERY);
}

export function useDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
