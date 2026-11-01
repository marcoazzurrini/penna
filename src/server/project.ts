import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Git facts about a project folder, read from files so they cost no process spawn.
// Every git worktree of a repo gets its own penna server, so agents and people need
// to tell them apart: by branch, and by a port that stays the same for each folder.

/** The nearest ancestor of `dir` (or `dir` itself) that holds `.git`, a folder or a worktree's file. */
export function gitRoot(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The git directory for a checkout: `.git` itself, or where a worktree's `.git` file points. */
function gitDir(top: string): string | null {
  const dotGit = path.join(top, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    return m ? path.resolve(top, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/** The checked-out branch, a short commit id when HEAD is detached, or null outside git. */
export function gitBranch(dir: string): string | null {
  const top = gitRoot(dir);
  const gd = top && gitDir(top);
  if (!gd) return null;
  try {
    const head = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : head.slice(0, 7);
  } catch {
    return null;
  }
}

/**
 * The repository's name: the main checkout's folder name. Worktree folders often have
 * generated names, so this reads through a worktree to the repo it belongs to.
 */
export function repoName(dir: string): string {
  const top = gitRoot(dir);
  const gd = top && gitDir(top);
  if (!top || !gd) return path.basename(path.resolve(dir));
  let common = gd;
  try {
    common = path.resolve(gd, fs.readFileSync(path.join(gd, "commondir"), "utf8").trim());
  } catch {}
  return path.basename(path.basename(common) === ".git" ? path.dirname(common) : top);
}

// Ports browsers refuse to open (Chromium and Firefox block lists) inside our range.
const BLOCKED = new Set([6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const FIRST = 6100;
const COUNT = 900;

export function portAllowed(port: number): boolean {
  return !BLOCKED.has(port);
}

/** A port derived from the folder path, so each checkout keeps the same URL across restarts. */
export function defaultPort(root: string): number {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {}
  const n = crypto.createHash("sha1").update(real).digest().readUInt32BE(0);
  let port = FIRST + (n % COUNT);
  while (!portAllowed(port)) port++;
  return port;
}

/** Paths of every worktree of the repo that holds `dir`, the main checkout first. */
export function worktrees(dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["worktree", "list", "--porcelain"], { cwd: dir, timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(
        out
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => l.slice(9)),
      );
    });
  });
}
