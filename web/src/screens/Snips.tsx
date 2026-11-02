import { useEffect, useState } from "react";
import { api, describeError, unwrap } from "../api/client";
import type { Snip, SnipPage } from "../api/types";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { copyText } from "../lib/clipboard";
import { useDesktop } from "../lib/layout";
import { navigate } from "../lib/router";
import { clock, relativeDay, spanLength } from "../lib/time";
import { useQuery } from "../lib/useQuery";
import { clipPlayer, usePlayingClip } from "../snips/clipPlayer";
import { TitleEdit } from "../snips/TitleEdit";
import { isPending } from "../snips/useSnip";

export function Snips() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [more, setMore] = useState<Snip[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  /** Desktop: the snip shown beside the list (the first one until another is chosen). */
  const [selected, setSelected] = useState<string | null>(null);
  const desktop = useDesktop();
  const toast = useToast();

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const page = useQuery<SnipPage>(`snips:${debounced}`, () => unwrap(api.GET("/v1/snips", { params: { query: { limit: 30, ...(debounced ? { q: debounced } : {}) } }, cache: "no-store" })));
  useEffect(() => {
    setMore([]);
  }, [debounced]);
  useEffect(() => {
    if (page.data && more.length === 0) setNext(page.data.next);
  }, [page.data, more.length]);

  const items = [...(page.data?.items ?? []), ...more];

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const p = await unwrap(api.GET("/v1/snips", { params: { query: { limit: 30, after: next, ...(debounced ? { q: debounced } : {}) } }, cache: "no-store" }));
      setMore((m) => [...m, ...p.items]);
      setNext(p.next);
    } catch (e) {
      toast(describeError(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function replace(updated: Snip) {
    page.mutate((prev) => (prev ? { ...prev, items: prev.items.map((s) => (s.id === updated.id ? updated : s)) } : { items: [updated], next: null }));
    setMore((m) => m.map((s) => (s.id === updated.id ? updated : s)));
  }
  function remove(id: string) {
    page.mutate((prev) => (prev ? { ...prev, items: prev.items.filter((s) => s.id !== id) } : { items: [], next: null }));
    setMore((m) => m.filter((s) => s.id !== id));
  }

  async function act(s: Snip, action: "revoke" | "restore" | "delete") {
    setOpenMenu(null);
    try {
      if (action === "delete") {
        if (!window.confirm("Delete this snip? Its public link stops working.")) return;
        const r = await api.DELETE("/v1/snips/{id}", { params: { path: { id: s.id } } });
        if (!r.response.ok) throw new Error(`HTTP ${r.response.status}`);
        remove(s.id);
        toast("Snip deleted");
      } else {
        const updated = await unwrap(action === "revoke" ? api.POST("/v1/snips/{id}/revoke", { params: { path: { id: s.id } } }) : api.POST("/v1/snips/{id}/restore", { params: { path: { id: s.id } } }));
        replace(updated);
        toast(action === "revoke" ? "Link revoked" : "Link restored");
      }
    } catch (e) {
      toast(describeError(e));
    }
  }

  const head = (
    <header className="page-head">
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div className="page-head__eyebrow">{page.data ? (items.length === 1 ? "1 snip" : `${items.length}${next ? "+" : ""} snips`) : ""}</div>
        <h1>Snips</h1>
      </div>
    </header>
  );
  const search = (
    <label className="search">
      <Icon name="search" size={22} />
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, summaries, excerpts" aria-label="Search snips" />
    </label>
  );
  const status = (
    <>
      {page.error && <p className="error">{page.error}</p>}
      {page.loading && items.length === 0 && <p className="empty">Loading…</p>}
      {!page.loading && items.length === 0 && !page.error && <p className="empty">{debounced ? "Nothing matches." : "No snips yet. Tap Snip in the player to capture a thought."}</p>}
    </>
  );
  const loadMoreButton = next && (
    <button className="btn btn--soft load-more" onClick={() => void loadMore()} disabled={loadingMore}>
      {loadingMore ? "Loading…" : "Load more"}
    </button>
  );

  // Desktop: the snips down the left, the chosen one in full beside them.
  if (desktop) {
    const current = items.find((s) => s.id === selected) ?? items[0];
    return (
      <div className="screen screen--with-mini screen--wide">
        {head}
        <div className="split">
          <section className="split__list" aria-label="Snips">
            {search}
            {status}
            <ul className="pick-list">
              {items.map((s) => (
                <li key={s.id}>
                  <button className="pick" aria-current={s.id === current?.id ? "true" : undefined} onClick={() => setSelected(s.id)}>
                    <span className="pick__body">
                      <span className="pick__title">{s.revision?.title ?? (isPending(s) ? "Choosing the moment…" : "Snip")}</span>
                      <span className="pick__meta">
                        {[s.show_title, relativeDay(s.created_at), s.revision ? spanLength(s.revision.end_ms - s.revision.start_ms) : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {loadMoreButton}
          </section>
          <div className="split__detail">
            {current && <SnipCard key={current.id} snip={current} menuOpen onMenu={() => undefined} onAct={(a) => void act(current, a)} onSaved={replace} allActions />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen--with-mini">
      {head}
      {search}
      <section className="section" aria-label="Snips">
        {status}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((s) => (
            <SnipCard key={s.id} snip={s} menuOpen={openMenu === s.id} onMenu={() => setOpenMenu((v) => (v === s.id ? null : s.id))} onAct={(a) => void act(s, a)} />
          ))}
        </div>
        {loadMoreButton}
      </section>
    </div>
  );
}

/**
 * `allActions` (desktop, where there is room): every action showing instead of behind the ⋯ button, and the title
 * edited in place by clicking it (`onSaved` gets the updated snip).
 */
function SnipCard({ snip, menuOpen, onMenu, onAct, onSaved, allActions = false }: { snip: Snip; menuOpen: boolean; onMenu: () => void; onAct: (a: "revoke" | "restore" | "delete") => void; onSaved?: (s: Snip) => void; allActions?: boolean }) {
  const toast = useToast();
  const playing = usePlayingClip();
  const rev = snip.revision;
  const revoked = snip.share_state === "revoked";
  const pending = isPending(snip);
  const failed = rev?.status === "failed";

  async function copy() {
    const how = await copyText(snip.share_url);
    if (how === "copied") toast("Link copied");
  }

  return (
    <article className="card" aria-label={rev?.title ?? "Snip"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="card__meta">
          <span>
            {snip.show_title ? `${snip.show_title} · ` : ""}
            {relativeDay(snip.created_at)}
          </span>
        </div>
        {allActions && rev && !pending && onSaved ? (
          <TitleEdit snip={snip} onSaved={onSaved} />
        ) : (
          <div className="card__title">{rev?.title ?? (pending ? "Choosing the moment…" : "Snip")}</div>
        )}
        <div className="card__meta" style={{ color: "var(--text-3)" }}>{snip.episode_title}</div>
      </div>
      {rev?.quote && <p style={{ fontSize: 18, lineHeight: 1.4, fontWeight: 600 }}>“{rev.quote}”</p>}
      {rev?.summary && <SummaryText summary={rev.summary} />}
      {!rev?.summary && rev?.excerpt && (
        <p style={allActions ? { fontSize: 18, lineHeight: 1.5, color: "var(--text-2)" } : { fontSize: 17, lineHeight: 1.45, color: "var(--text-2)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{rev.excerpt}</p>
      )}
      <div className="card__meta tnum">
        {rev && (
          <span>
            {clock(rev.start_ms)} – {clock(rev.end_ms)} ({spanLength(rev.end_ms - rev.start_ms)})
          </span>
        )}
        {revoked ? (
          <span className="state state--pending">
            <Icon name="eyeOff" size={16} /> Link revoked
          </span>
        ) : failed ? (
          <span className="state state--failed">
            <Icon name="alert" size={16} /> Failed
          </span>
        ) : pending ? (
          <span className="state state--pending">
            <Icon name="clock" size={16} /> Preparing
          </span>
        ) : (
          <span className="state state--ready">
            <Icon name="globe" size={16} /> Public
          </span>
        )}
      </div>
      <div className={`actions-row${allActions ? " actions-row--all" : ""}`}>
        <button className="btn btn--soft" disabled={!rev?.clip_url} onClick={() => rev?.clip_url && clipPlayer.toggle(rev.id, rev.clip_url)} aria-pressed={playing === rev?.id}>
          <Icon name={playing === rev?.id ? "stop" : snip.media_kind === "video" ? "video" : "play"} size={16} />
          {playing === rev?.id ? "Stop" : "Play"}
        </button>
        <button className="btn btn--soft" onClick={() => void copy()}>
          <Icon name="link" size={16} />
          Copy link
        </button>
        {!allActions && (
          <button className="btn btn--soft" onClick={onMenu} aria-expanded={menuOpen} aria-label="More actions">
            <Icon name="more" size={20} />
          </button>
        )}
      </div>
      {menuOpen && (
        <div className={`actions-row${allActions ? " actions-row--all" : ""}`} role="group" aria-label={allActions ? "Manage" : "More actions"}>
          <button className="btn btn--soft" disabled={pending || failed} onClick={() => navigate(`/snips/${snip.id}/edit`)}>
            <Icon name="edit" size={16} />
            Edit
          </button>
          {revoked ? (
            <button className="btn btn--soft" onClick={() => onAct("restore")}>
              <Icon name="eye" size={16} />
              Restore link
            </button>
          ) : (
            <button className="btn btn--soft" onClick={() => onAct("revoke")}>
              <Icon name="eyeOff" size={16} />
              Revoke link
            </button>
          )}
          <button className="btn btn--soft btn--danger" onClick={() => onAct("delete")}>
            <Icon name="trash" size={16} />
            Delete
          </button>
        </div>
      )}
    </article>
  );
}

/** A snip's summary: bullets, one per line, since snip-summary v3; a paragraph before that. */
function SummaryText({ summary }: { summary: string }) {
  const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
  const style = { fontSize: 17, lineHeight: 1.45, color: "var(--text-2)" } as const;
  if (lines.length < 2) return <p style={style}>{summary}</p>;
  return (
    <ul style={{ ...style, margin: 0, paddingLeft: "1.2em", display: "flex", flexDirection: "column", gap: 4 }}>
      {lines.map((l, i) => <li key={i}>{l}</li>)}
    </ul>
  );
}
