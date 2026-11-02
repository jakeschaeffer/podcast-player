import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, unwrap } from "../api/client";
import type { EpisodeListItem } from "../api/types";

type Page = { items: EpisodeListItem[]; next: string | null };
const cache = new Map<string, Page>();

/** Episodes newest first, for one feed or all, following the `next` cursor on demand. */
export function useEpisodes(feedId: string | null, limit = 30) {
  const key = feedId ?? "*";
  const [page, setPage] = useState<Page | undefined>(cache.get(key));
  const [loading, setLoading] = useState(!cache.has(key));
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const fetchPage = useCallback(async (after?: string): Promise<Page> => {
    return unwrap(api.GET("/v1/episodes", { params: { query: { limit, ...(feedId ? { feed_id: feedId } : {}), ...(after ? { after } : {}) } } }));
  }, [feedId, limit]);

  const reload = useCallback(async () => {
    const k = keyRef.current;
    setLoading(!cache.has(k));
    try {
      const p = await fetchPage();
      if (keyRef.current !== k) return;
      cache.set(k, p);
      setPage(p);
      setError(null);
    } catch (e) {
      if (keyRef.current === k) setError(describeError(e));
    } finally {
      if (keyRef.current === k) setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    const k = keyRef.current;
    const current = cache.get(k);
    if (!current?.next || more) return;
    setMore(true);
    try {
      const p = await fetchPage(current.next);
      if (keyRef.current !== k) return;
      const merged = { items: [...current.items, ...p.items], next: p.next };
      cache.set(k, merged);
      setPage(merged);
    } catch (e) {
      if (keyRef.current === k) setError(describeError(e));
    } finally {
      if (keyRef.current === k) setMore(false);
    }
  }, [fetchPage, more]);

  useEffect(() => {
    setPage(cache.get(key));
    setError(null);
    void reload();
  }, [key, reload]);

  return { items: page?.items ?? [], next: page?.next ?? null, loading, more, error, reload, loadMore };
}
