import type { Processing } from "../api/types";
import { Icon } from "./Icon";

/** One word about an episode's readiness: Transcript (ready), Preparing, Failed, or nothing for untouched episodes. */
export function ProcessingState({ processing }: { processing: Processing }) {
  const steps = [processing.audio, processing.transcript];
  if (processing.transcript === "ready") {
    return (
      <span className="state state--ready">
        <Icon name="check" size={16} strokeWidth={2.2} />
        Transcript
      </span>
    );
  }
  if (steps.includes("failed")) {
    return (
      <span className="state state--failed">
        <Icon name="alert" size={16} strokeWidth={2.2} />
        Failed
      </span>
    );
  }
  if (steps.some((s) => s === "queued" || s === "running" || s === "deferred") || processing.text === "running") {
    return (
      <span className="state state--pending">
        <Icon name="clock" size={16} strokeWidth={2.2} />
        {processing.audio === "ready" ? "Preparing transcript" : "Preparing"}
      </span>
    );
  }
  return null;
}
