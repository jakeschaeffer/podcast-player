import { useEffect } from "react";
import { useSession } from "./auth/session";
import { BottomNav } from "./components/BottomNav";
import { MiniPlayer } from "./components/MiniPlayer";
import { SettingsProvider } from "./components/SettingsSheet";
import { useDesktop } from "./lib/layout";
import { match, navigate, query, useLocationPath } from "./lib/router";
import { invalidate } from "./lib/useQuery";
import { useEngine } from "./player/PlayerContext";
import { flushPlayback } from "./player/reporter";
import { nextAfter, QUEUE_KEY } from "./player/queue";
import { AddShow } from "./screens/AddShow";
import { FeedEpisodes } from "./screens/FeedEpisodes";
import { Library } from "./screens/Library";
import { Login } from "./screens/Login";
import { Player } from "./screens/Player";
import { EvalRunScreen, PromptDetail, PromptEditor, PromptVersionScreen, Prompts } from "./screens/Prompts";
import { SnipEditor } from "./screens/SnipEditor";
import { Snips } from "./screens/Snips";
import { Today } from "./screens/Today";
import { snipOutbox } from "./snips/outbox";

export function App() {
  const sess = useSession();
  const path = useLocationPath();
  const engine = useEngine();
  const desktop = useDesktop();

  // When an episode ends, the first up next starts; a player showing the one that ended moves on to it.
  useEffect(() => {
    engine.onEnded = (finishedId) => {
      void nextAfter(finishedId).then((next) => {
        if (!next || engine.getState().episodeId !== finishedId) return;
        void engine.open(next.id, { autoplay: true });
        invalidate(QUEUE_KEY);
        if (window.location.pathname === `/episodes/${finishedId}`) navigate(`/episodes/${next.id}`, { replace: true });
      }).catch(() => undefined);
    };
    return () => { engine.onEnded = null; };
  }, [engine]);

  useEffect(() => {
    if (!sess) return;
    void snipOutbox.flush();
    void flushPlayback();
    // After iOS reloads a discarded page, come back to the episode this device was playing, paused, ready to resume.
    engine.restoreLast();
  }, [sess, engine]);

  if (!sess) return <Login />;

  let screen: React.ReactNode;
  let fullScreen = false;
  let playerOpen = false;
  let m: Record<string, string> | null;
  if ((m = match("/episodes/:id", path))) {
    screen = <Player episodeId={m.id!} />;
    fullScreen = true;
    playerOpen = true;
  } else if ((m = match("/snips/:id/edit", path))) {
    screen = <SnipEditor snipId={m.id!} />;
    fullScreen = true;
  } else if ((m = match("/prompts/:name/new", path))) {
    screen = <PromptEditor name={m.name!} from={query(path).get("from")} />;
    fullScreen = true;
  } else if (match("/snips", path)) screen = <Snips />;
  else if ((m = match("/prompts/:name/:version", path))) screen = <PromptVersionScreen name={m.name!} version={m.version!} />;
  else if ((m = match("/prompts/:name", path))) screen = <PromptDetail name={m.name!} />;
  else if (match("/prompts", path)) screen = <Prompts />;
  else if ((m = match("/evals/:eval/runs/:run", path))) screen = <EvalRunScreen evalId={m.eval!} runId={m.run!} />;
  else if (match("/library/add", path)) screen = <AddShow />; // before /library/:id, which would match "add"
  else if ((m = match("/library/:id", path))) screen = <FeedEpisodes feedId={m.id!} />;
  else if (match("/library", path)) screen = <Library />;
  else screen = <Today />;

  // On a phone the player, editor and prompt editor take the whole screen; on a desktop the rail stays beside them.
  const rail = !fullScreen || desktop;
  return (
    <SettingsProvider>
      <div className={`app${fullScreen ? " app--full" : ""}${rail ? " app--rail" : ""}`}>
        {screen}
        {rail && (
          <div className="bottom">
            {!playerOpen && <MiniPlayer />}
            <BottomNav path={path} />
          </div>
        )}
      </div>
    </SettingsProvider>
  );
}
