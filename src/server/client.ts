import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExecRequest } from "./execute.ts";
import { lockFile, startServer, toWire, type PennaServer, type ServerInfo, type WireResult } from "./http.ts";
import { gitBranch, gitRoot, worktrees } from "./project.ts";

/** The running server for this project, if any. */
export async function findServer(root: string): Promise<ServerInfo | null> {
  let info: ServerInfo;
  try {
    info = JSON.parse(fs.readFileSync(lockFile(root), "utf8"));
  } catch {
    return null;
  }
  try {
    const res = await fetch(info.url + "/api/ping", { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { root: string; branch?: string | null };
    // The branch can change while the server runs, so prefer the live answer.
    return body.root === root ? { ...info, branch: body.branch ?? info.branch ?? null } : null;
  } catch {
    return null;
  }
}

/** Start `penna dev` as a detached background process and wait until it answers. */
export async function spawnServer(root: string): Promise<ServerInfo> {
  // argv[1] is the penna CLI script, whether it runs from src/ or dist/.
  const child = spawn(process.execPath, [process.argv[1], "dev", "--quiet"], { cwd: root, detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = await findServer(root);
    if (info) return info;
  }
  throw new Error("The penna server did not start.");
}

export interface WorktreeServer {
  /** Project root in that worktree. */
  root: string;
  branch: string | null;
  /** The worktree that `root` passed to `listServers` is in. */
  current: boolean;
  server: ServerInfo | null;
}

/**
 * The penna project in every git worktree of the repo, and its server when one runs.
 * When `.penna/` sits in a subfolder of the repo, the same subfolder is used in each worktree.
 */
export async function listServers(root: string): Promise<WorktreeServer[]> {
  const top = gitRoot(root);
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const here = real(root);
  const rel = top ? path.relative(top, root) : "";
  const trees = top ? await worktrees(top) : [];
  const roots = trees.length ? trees.map((t) => path.join(t, rel)) : [root];
  return Promise.all(
    roots.map(async (r) => ({ root: r, branch: gitBranch(r), current: real(r) === here, server: await findServer(r) })),
  );
}

/**
 * Routes exec calls to the project's server. Uses a running server when there is one,
 * otherwise starts one inside this process.
 */
export class ExecClient {
  private local: PennaServer | null = null;
  private starting: Promise<PennaServer> | null = null;
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The project's server: a running one, else one started in this process. */
  async server(): Promise<{ info: ServerInfo; local: PennaServer | null }> {
    if (this.local) return { info: this.local.info, local: this.local };
    const remote = await findServer(this.root);
    if (remote) return { info: remote, local: null };
    // Calls that arrive while the server starts share one start.
    this.starting ??= startServer(this.root)
      .then((s) => {
        this.local = s;
        process.stderr.write(`penna: viewer at ${s.info.url}\n`);
        return s;
      })
      .finally(() => {
        this.starting = null;
      });
    const local = await this.starting;
    return { info: local.info, local };
  }

  async exec(req: ExecRequest): Promise<WireResult & { info: ServerInfo }> {
    const { info, local } = await this.server();
    if (local) return { ...toWire(await local.exec(req)), info };
    const res = await fetch(info.url + "/api/exec", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`penna server refused the call (${res.status}): ${await res.text()}`);
    return { ...((await res.json()) as WireResult), info };
  }

  async close() {
    await this.local?.close();
  }
}
