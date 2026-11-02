import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { PlayerEngine, type PlayerState } from "./engine";

const engine = new PlayerEngine();
const Ctx = createContext<PlayerEngine>(engine);

export function PlayerProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

export function useEngine(): PlayerEngine {
  return useContext(Ctx);
}

export function usePlayer(): PlayerState {
  const e = useContext(Ctx);
  return useSyncExternalStore(e.subscribe, e.getState, e.getState);
}
