import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { session, useSession } from "../auth/session";
import { navigate } from "../lib/router";
import { setTheme, useTheme, type Theme } from "../lib/theme";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** `open` takes the button that opened Settings, so that on a desktop the menu opens under it. */
const Ctx = createContext<{ open: (anchor?: HTMLElement) => void }>({ open: () => undefined });
export function useSettings() {
  return useContext(Ctx);
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = useCallback((from?: HTMLElement) => {
    setAnchor(from ?? null);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const sess = useSession();
  const theme = useTheme();

  async function logOut() {
    const id = sess?.deviceId;
    // Revoking the device makes the cookie useless; the server has no cookie-clearing route, so this is the logout.
    if (id) await api.DELETE("/v1/devices/{id}", { params: { path: { id } } }).catch(() => undefined);
    session.set(null);
    close();
  }

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {isOpen && (
        <Sheet onClose={close} label="Settings" anchor={anchor}>
          <div className="menu">
            <div className="menu__head">
              <div style={{ fontSize: 19, fontWeight: 600 }}>{sess?.deviceName ?? "This device"}</div>
              <div className="section__meta">Signed in on this browser</div>
            </div>
            <button
              onClick={() => {
                const i = THEMES.findIndex((t) => t.value === theme);
                setTheme(THEMES[(i + 1) % THEMES.length]!.value);
              }}
            >
              <span>Theme</span>
              <span className="menu__value">{THEMES.find((t) => t.value === theme)?.label}</span>
            </button>
            <button onClick={() => { close(); navigate("/prompts"); }}>
              <span>Prompts</span>
              <Icon name="chevronRight" size={22} />
            </button>
            <a href="/v1/export/snips.md" target="_blank" rel="noreferrer">
              <span>Export snips as Markdown</span>
              <Icon name="chevronRight" size={22} />
            </a>
            <button className="btn--danger" onClick={() => void logOut()}>
              <span>Log out and revoke this device</span>
            </button>
          </div>
        </Sheet>
      )}
    </Ctx.Provider>
  );
}
