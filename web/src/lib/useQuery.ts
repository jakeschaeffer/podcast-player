import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../api/client";

// Tiny read cache: a screen you come back to paints its last data at once and refreshes in the background.
const cache = new Map<string, unknown>();

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace the cached value locally (after a mutation) without refetching. */
  mutate: (next: T | ((prev: T | undefined) => T)) => void;
}

export function useQuery<T>(key: string | null, fetcher: () => Promise<T>): Query<T> {
  const cached = key ? (cache.get(key) as T | undefined) : undefined;
  const [data, setData] = useState<T | undefined>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(key !== null && cached === undefined);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;

  const reload = useCallback(async () => {
    const k = keyRef.current;
    if (k === null) return;
    setLoading(cache.get(k) === undefined);
    try {
      const next = await fetcherRef.current();
      if (keyRef.current !== k) return;
      cache.set(k, next);
      setData(next);
      setError(null);
    } catch (e) {
      if (keyRef.current !== k) return;
      setError(describeError(e));
    } finally {
      if (keyRef.current === k) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (key === null) {
      setData(undefined);
      setLoading(false);
      return;
    }
    const c = cache.get(key) as T | undefined;
    setData(c);
    setError(null);
    void reload();
  }, [key, reload]);

  const mutate = useCallback((next: T | ((prev: T | undefined) => T)) => {
    setData((prev) => {
      const value = typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
      if (keyRef.current) cache.set(keyRef.current, value);
      return value;
    });
  }, []);

  return { data, error, loading, reload, mutate };
}

export function invalidate(prefix: string): void {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}
