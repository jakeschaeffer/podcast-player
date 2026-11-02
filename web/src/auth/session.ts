import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "../lib/storage";

/** What the client remembers about its login. The device token itself lives only in the HttpOnly cookie. */
export interface Session {
  deviceId: string;
  deviceName: string;
  since: number;
}

const KEY = "pp.session";
let current: Session | null = readJson<Session | null>(KEY, null);
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const session = {
  get: (): Session | null => current,
  set(s: Session | null) {
    current = s;
    writeJson(KEY, s);
    emit();
  },
  /** Called on any 401 from an owner route: the cookie is gone or the device was revoked. */
  expire() {
    if (current) this.set(null);
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useSession(): Session | null {
  return useSyncExternalStore(session.subscribe, session.get, session.get);
}
