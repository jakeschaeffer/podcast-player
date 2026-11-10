import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, describeError, unwrap } from "../api/client";
import type { EvalRun, EvalRunDetail, Prompt, PromptVersion, Score } from "../api/types";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { diffWords } from "../lib/diff";
import { useDesktop } from "../lib/layout";
import { back, navigate, onLinkClick } from "../lib/router";
import { relativeDay } from "../lib/time";
import { invalidate, useQuery } from "../lib/useQuery";

// Prompts, their versions, and eval scores (server/prompts/README.md). Deliberately bare: names, numbers, text.

function usePrompts() {
  return useQuery<Prompt[]>("prompts", () => unwrap(api.GET("/v1/prompts", { cache: "no-store" })));
}

function Head({ title, backTo, children }: { title: string; backTo?: string; children?: ReactNode }) {
  const desktop = useDesktop();
  return (
    <header className="page-head page-head--sub">
      {backTo && (
        <button className="icon-btn page-head__back" onClick={() => back(backTo)} aria-label="Back">
          <Icon name={desktop ? "chevronLeft" : "chevronDown"} size={27} strokeWidth={2.1} />
        </button>
      )}
      <h1>{title}</h1>
      {children && <div className="page-head__actions">{children}</div>}
    </header>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function ScoreText({ score }: { score: Score | null }) {
  if (!score) return <span className="score score--none">–</span>;
  return (
    <span className="score tnum">
      {pct(score.rate)}
      <small>±{Math.round(score.margin * 100)}</small>
    </span>
  );
}

/** "5 of 21 titles rewritten": what the owner changed of what a version, or the fixed rules, wrote in use. */
function editsText(rate: { snips: number; edited: number } | null | undefined, label: string | null): string | null {
  return rate && label ? `${rate.edited} of ${rate.snips} ${label}` : null;
}

/** A prompt's own line: its active version's count, or the fixed rules' when they do the work (Snip start while off). */
function promptEdits(p: Prompt): string | null {
  const rules = editsText(p.rules_edits, p.edits_label);
  return editsText(p.versions.find((v) => v.active)?.edits, p.edits_label) ?? (rules ? `Fixed rules: ${rules}` : null);
}

/** Under a prompt's versions, when the fixed rules choose spans: the count that belongs to no version. */
function RulesEdits({ p }: { p: Prompt }) {
  const rules = editsText(p.rules_edits, p.edits_label);
  if (!rules) return null;
  return <p className="list-note">{p.in_use ? "Where the fixed rules chose the start instead:" : "The fixed rules choose where a snip starts while this prompt is off."} {rules}.</p>;
}

function when(ms: number): string {
  return `${relativeDay(ms)} ${new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function runStatus(r: EvalRun): string {
  if (r.status === "done" && r.score) return `${r.score.passed} of ${r.score.n}`;
  if (r.status === "running") return r.progress && r.progress.total > 0 ? `${r.progress.done} of ${r.progress.total}` : "Running";
  if (r.status === "queued") return "Queued";
  return "Failed";
}

/** Reload every few seconds while a run is waiting or running. */
function usePollWhile(active: boolean, reload: () => Promise<void>) {
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(t);
  }, [active, reload]);
}

export function Prompts() {
  const prompts = usePrompts();
  const desktop = useDesktop();
  if (desktop) {
    return (
      <div className="screen screen--with-mini">
        <Head title="Prompts" />
        {prompts.error && <p className="error">{prompts.error}</p>}
        <table className="dtable">
          <thead>
            <tr>
              <th scope="col">Prompt</th>
              <th scope="col">Active version</th>
              <th scope="col">Status</th>
              <th scope="col">Versions</th>
              <th scope="col">Edited in use</th>
              <th scope="col" className="dtable__num">Eval score</th>
            </tr>
          </thead>
          <tbody>
            {(prompts.data ?? []).map((p) => (
              <tr key={p.name}>
                <td className="dtable__main">
                  <a href={`/prompts/${p.name}`} onClick={onLinkClick}>{p.label}</a>
                </td>
                <td>{p.active}</td>
                <td>{p.in_use ? <span className="state state--ready">In use</span> : <span className="state state--pending">Off</span>}</td>
                <td className="tnum">{p.versions.length}</td>
                <td className="tnum">{promptEdits(p) ?? <span className="score score--none">–</span>}</td>
                <td className="dtable__num">{p.eval ? <ScoreText score={p.versions.find((v) => v.active)?.score ?? null} /> : <span className="score score--none">No eval</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="screen screen--with-mini">
      <Head title="Prompts" />
      {prompts.error && <p className="error">{prompts.error}</p>}
      <ul className="list">
        {(prompts.data ?? []).map((p) => (
          <li key={p.name} className="list-item">
            <a className="list-item__link" href={`/prompts/${p.name}`} onClick={onLinkClick}>
              <div className="list-item__body">
                <div className="list-item__title">{p.label}</div>
                <div className="list-item__meta">
                  <span>{p.active}</span>
                  {!p.in_use && <span className="state state--pending">Off</span>}
                  {promptEdits(p) && <span className="tnum">{promptEdits(p)}</span>}
                </div>
              </div>
              {p.eval && <ScoreText score={p.versions.find((v) => v.active)?.score ?? null} />}
              <Icon name="chevronRight" size={22} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PromptDetail({ name }: { name: string }) {
  const prompts = usePrompts();
  const desktop = useDesktop();
  const p = prompts.data?.find((x) => x.name === name);
  if (desktop) return <PromptWorkspace name={name} version={p?.active ?? null} />;
  return (
    <div className="screen screen--with-mini">
      <Head title={p?.label ?? "Prompt"} backTo="/prompts" />
      {prompts.error && <p className="error">{prompts.error}</p>}
      {p && (
        <>
          <div className="btn-row">
            <a className="btn btn--soft" href={`/prompts/${name}/new`} onClick={onLinkClick}>
              <Icon name="edit" size={17} />
              New version
            </a>
          </div>
          <ul className="list">
            {p.versions.map((v) => (
              <li key={v.version} className="list-item">
                <a className="list-item__link" href={`/prompts/${name}/${v.version}`} onClick={onLinkClick}>
                  <div className="list-item__body">
                    <div className="list-item__title">{v.version}</div>
                    <div className="list-item__meta">
                      <span>{relativeDay(v.created_at)}</span>
                      {v.active && <span className="state state--accent">Active</span>}
                      {editsText(v.edits, p.edits_label) && <span className="tnum">{editsText(v.edits, p.edits_label)}</span>}
                    </div>
                  </div>
                  {p.eval && <ScoreText score={v.score} />}
                  <Icon name="chevronRight" size={22} />
                </a>
              </li>
            ))}
          </ul>
          <RulesEdits p={p} />
        </>
      )}
    </div>
  );
}

function Diff({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => diffWords(from, to), [from, to]);
  return (
    <pre className="prompt-text">
      {parts.map((part, i) => (part.kind === "same" ? <span key={i}>{part.text}</span> : part.kind === "add" ? <ins key={i} className="diff-add">{part.text}</ins> : <del key={i} className="diff-del">{part.text}</del>))}
    </pre>
  );
}

export function PromptVersionScreen({ name, version }: { name: string; version: string }) {
  const desktop = useDesktop();
  if (desktop) return <PromptWorkspace name={name} version={version} />;
  return (
    <div className="screen screen--with-mini">
      <VersionBody name={name} version={version} />
    </div>
  );
}

/**
 * Desktop: one prompt's versions down the left, the chosen version's text, actions and runs beside them. Choosing a
 * version replaces the address rather than stacking history, so Back leaves the prompt.
 */
function PromptWorkspace({ name, version }: { name: string; version: string | null }) {
  const prompts = usePrompts();
  const p = prompts.data?.find((x) => x.name === name);
  return (
    <div className="screen screen--with-mini screen--wide">
      <Head title={p?.label ?? "Prompt"} backTo="/prompts" />
      {prompts.error && <p className="error">{prompts.error}</p>}
      {p && (
        <div className="split">
          <nav className="split__list" aria-label="Versions">
            <ul className="pick-list">
              {p.versions.map((v) => (
                <li key={v.version}>
                  <a
                    className="pick"
                    href={`/prompts/${name}/${v.version}`}
                    aria-current={v.version === version ? "page" : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(`/prompts/${name}/${v.version}`, { replace: true });
                    }}
                  >
                    <span className="pick__body">
                      <span className="pick__title">{v.version}</span>
                      <span className="pick__meta">
                        <span>{relativeDay(v.created_at)}</span>
                        {v.active && <span className="state state--accent">Active</span>}
                        {editsText(v.edits, p.edits_label) && <span className="tnum">{editsText(v.edits, p.edits_label)}</span>}
                      </span>
                    </span>
                    {p.eval && <ScoreText score={v.score} />}
                  </a>
                </li>
              ))}
            </ul>
            <RulesEdits p={p} />
          </nav>
          <div className="split__detail">{version && <VersionBody key={version} name={name} version={version} inWorkspace />}</div>
        </div>
      )}
    </div>
  );
}

function VersionBody({ name, version, inWorkspace = false }: { name: string; version: string; inWorkspace?: boolean }) {
  const q = useQuery<PromptVersion>(`prompt:${name}:${version}`, () => unwrap(api.GET("/v1/prompts/{name}/versions/{version}", { params: { path: { name, version } }, cache: "no-store" })));
  const [view, setView] = useState<"text" | "changes">("text");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const v = q.data;
  const pending = !!v?.runs.some((r) => r.status === "queued" || r.status === "running");
  usePollWhile(pending, q.reload);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      invalidate("prompts");
      await q.reload();
    } catch (e) {
      toast(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const activate = () => {
    if (window.confirm(`Activate ${version}?`)) void act(() => unwrap(api.PUT("/v1/prompts/{name}/active", { params: { path: { name } }, body: { version } })));
  };
  const run = () => v?.eval && void act(() => unwrap(api.POST("/v1/evals/{eval}/runs", { params: { path: { eval: v.eval!.id } }, body: { version } })));

  return (
    <>
      {inWorkspace ? (
        <div className="split__head">
          <h2>{version}</h2>
          {v?.active && <span className="state state--accent">Active</span>}
        </div>
      ) : (
        <Head title={version} backTo={`/prompts/${name}`}>{v?.active && <span className="state state--accent">Active</span>}</Head>
      )}
      {q.error && <p className="error">{q.error}</p>}
      {v && (
        <>
          <div className="btn-row">
            {!v.active && (
              <button className="btn btn--accent" onClick={activate} disabled={busy}>
                Activate
              </button>
            )}
            {v.eval && (
              <button className="btn btn--soft" onClick={run} disabled={busy || pending}>
                <Icon name="play" size={16} />
                Run
              </button>
            )}
            <a className="btn btn--soft" href={`/prompts/${name}/new?from=${version}`} onClick={onLinkClick}>
              <Icon name="edit" size={17} />
              Edit
            </a>
          </div>
          {v.previous && (
            <div className="seg" role="tablist" aria-label="Text or changes">
              <button role="tab" aria-selected={view === "text"} aria-pressed={view === "text"} onClick={() => setView("text")}>Text</button>
              <button role="tab" aria-selected={view === "changes"} aria-pressed={view === "changes"} onClick={() => setView("changes")}>Changes</button>
            </div>
          )}
          {view === "changes" && v.previous ? <Diff from={v.previous.text} to={v.text} /> : <pre className="prompt-text">{v.text}</pre>}
          {v.eval && (
            <section className="section" aria-labelledby="runs-h">
              <h2 id="runs-h">Runs</h2>
              {v.runs.length === 0 && <p className="section__meta">None</p>}
              <ul className="list">
                {v.runs.map((r) => (
                  <li key={r.id} className="list-item">
                    <a className="list-item__link" href={`/evals/${r.eval}/runs/${r.id}`} onClick={onLinkClick}>
                      <div className="list-item__body">
                        <div className="list-item__title">{when(r.run_at)}</div>
                        <div className="list-item__meta">
                          <span className={r.status === "failed" ? "state state--failed" : undefined}>{runStatus(r)}</span>
                        </div>
                      </div>
                      <ScoreText score={r.score} />
                      <Icon name="chevronRight" size={22} />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}

export function PromptEditor({ name, from }: { name: string; from: string | null }) {
  const prompts = usePrompts();
  const base = from ?? prompts.data?.find((p) => p.name === name)?.active ?? null;
  const source = useQuery<PromptVersion>(base ? `prompt:${name}:${base}` : null, () => unwrap(api.GET("/v1/prompts/{name}/versions/{version}", { params: { path: { name, version: base! } }, cache: "no-store" })));
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (text === null && source.data) setText(source.data.text);
  }, [source.data, text]);

  async function save() {
    if (text === null) return;
    setSaving(true);
    try {
      const created = await unwrap(api.POST("/v1/prompts/{name}/versions", { params: { path: { name } }, body: { text } }));
      invalidate("prompts");
      navigate(`/prompts/${name}/${created.version}`, { replace: true });
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? e.message.replace(/^same text as/, "Same as") : describeError(e));
      setSaving(false);
    }
  }

  const unchanged = text !== null && source.data !== undefined && text.trim() === source.data.text.trim();
  return (
    <div className="screen screen--compose">
      <div className="editor__head">
        <button className="btn btn--ghost editor__cancel" onClick={() => back(`/prompts/${name}`)}>Cancel</button>
        <div className="editor__head-mid">
          <h1>New version</h1>
        </div>
        <button className="btn btn--ghost editor__save" onClick={() => void save()} disabled={text === null || unchanged || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {source.error && <p className="error">{source.error}</p>}
      <textarea className="textarea" value={text ?? ""} onChange={(e) => setText(e.target.value)} aria-label="Prompt text" spellCheck={false} disabled={text === null} />
    </div>
  );
}

export function EvalRunScreen({ evalId, runId }: { evalId: string; runId: string }) {
  const prompts = usePrompts();
  const q = useQuery<EvalRunDetail>(`run:${evalId}:${runId}`, () => unwrap(api.GET("/v1/evals/{eval}/runs/{run}", { params: { path: { eval: evalId, run: runId } }, cache: "no-store" })));
  const run = q.data?.run;
  usePollWhile(run?.status === "queued" || run?.status === "running", q.reload);
  const label = prompts.data?.find((p) => p.eval?.id === evalId)?.eval?.label ?? "Run";
  return (
    <div className="screen screen--with-mini">
      <Head title={label} backTo="/prompts" />
      {q.error && <p className="error">{q.error}</p>}
      {run && (
        <div className="run-score">
          <strong className="tnum">{run.score ? pct(run.score.rate) : "–"}</strong>
          {run.score && <span className="tnum">±{Math.round(run.score.margin * 100)}</span>}
          <span className="tnum">{runStatus(run)}</span>
          <span>{run.version}</span>
          <span>{when(run.run_at)}</span>
        </div>
      )}
      {run?.error && <p className="error">{run.error}</p>}
      {(q.data?.cases.length ?? 0) > 0 && (
        <div className="cases__head" aria-hidden="true">
          <span />
          <span>Expected</span>
          <span>Got</span>
          <span style={{ textAlign: "right" }}>Score</span>
        </div>
      )}
      <ul className="cases">
        {(q.data?.cases ?? []).map((c) => (
          <li key={c.id} className={`case${c.pass ? "" : " case--fail"}`}>
            <span className="case__mark" aria-label={c.pass ? "Pass" : "Fail"}>
              <Icon name={c.pass ? "check" : "close"} size={20} strokeWidth={2.4} />
            </span>
            <div className="case__body">
              <div className="case__expected">{c.expected}</div>
              <div className="case__actual">{c.actual}</div>
              {c.note && <div className="case__note">{c.note}</div>}
            </div>
            {c.score !== null && <span className="case__score tnum">{c.score}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
