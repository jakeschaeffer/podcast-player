import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../api/client";
import type { Snip } from "../api/types";

export const PENDING_STATUSES = new Set(["waiting", "selecting", "preparing"]);
export function isPending(snip: Snip | null | undefined): boolean {
  return !!snip && (!snip.revision || PENDING_STATUSES.has(snip.revision.status));
}

/**
 * Follow one snip: GET /v1/snips/{id} with If-None-Match every two seconds while its revision is being
 * prepared (the server answers 304 when nothing changed), then stop. `initial` paints at once.
 */
export function useSnip(id: string | null, initial?: Snip | null): { snip: Snip | null; error: string | null; refresh: () => Promise<Snip | null> } {
  const [snip, setSnip] = useState<Snip | null>(initial && initial.id === id ? initial : null);
  const [error, setError] = useState<string | null>(null);
  const etag = useRef<string | null>(null);
  const latest = useRef<Snip | null>(snip);

  const refresh = useCallback(async (): Promise<Snip | null> => {
    if (!id) return null;
    try {
      const r = await api.GET("/v1/snips/{id}", { params: { path: { id } }, headers: etag.current ? { "If-None-Match": etag.current } : {}, cache: "no-store" });
      if (r.response.status === 304) return latest.current;
      if (!r.response.ok || !r.data) throw new Error(`HTTP ${r.response.status}`);
      etag.current = r.response.headers.get("etag");
      latest.current = r.data;
      setSnip(r.data);
      setError(null);
      return r.data;
    } catch (e) {
      setError(describeError(e));
      return latest.current;
    }
  }, [id]);

  useEffect(() => {
    etag.current = null;
    const start = initial && initial.id === id ? initial : null;
    latest.current = start;
    setSnip(start);
    setError(null);
    if (!id) return;
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      const s = await refresh();
      if (stopped) return;
      if (s && !isPending(s)) return; // final: ready or failed
      timer = window.setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // `initial` only seeds the first paint; a change of id restarts polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, refresh]);

  return { snip, error, refresh };
}
