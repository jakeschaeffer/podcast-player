import { execFile } from "node:child_process";
import { dirname, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Commit exactly these files in the repository that holds them, leaving anything else staged or changed as it is.
 * Returns false, and logs why, when they are not in a git repository (tests use temporary folders) or the commit
 * fails (a merge in progress, say); the files stay written either way.
 *
 * With `push`, the commit is then pushed to the same branch on origin in the background, so the production
 * checkout's prompt commits reach GitHub at once. A rejected push (origin has moved on) is only logged:
 * deploy/deploy.sh rebases and pushes whatever is left on the next deploy.
 */
export async function commitFiles(
  paths: string[],
  message: string,
  log: (msg: string, extra?: Record<string, unknown>) => void,
  opts: { push?: boolean } = {},
): Promise<boolean> {
  if (paths.length === 0) return false;
  try {
    const { stdout } = await exec("git", ["-C", dirname(paths[0]!), "rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    const rel = paths.map((p) => relative(root, p));
    await exec("git", ["-C", root, "add", "--", ...rel]);
    await exec("git", ["-C", root, "commit", "-q", "-m", message, "--", ...rel]);
    if (opts.push) pushInBackground(root, message, log);
    return true;
  } catch (err) {
    log("git commit skipped", { message, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return false;
  }
}

function pushInBackground(root: string, message: string, log: (msg: string, extra?: Record<string, unknown>) => void): void {
  exec("git", ["-C", root, "push", "-q", "origin", "HEAD"], { timeout: 60_000 }).then(
    () => log("git push done", { message }),
    (err) => log("git push failed", { message, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }),
  );
}
