import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { PlayerProvider, useEngine } from "./player/PlayerContext";
import { clipPlayer } from "./snips/clipPlayer";
import "./styles.css";

function Wire() {
  clipPlayer.attachEngine(useEngine());
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlayerProvider>
      <ToastProvider>
        <Wire />
        <App />
      </ToastProvider>
    </PlayerProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
