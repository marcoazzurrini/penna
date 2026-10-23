import { spawn } from "node:child_process";
import fs from "node:fs";
import type { ExecRequest } from "./execute.ts";
import { lockFile, startServer, toWire, type PennaServer, type ServerInfo, type WireResult } from "./http.ts";

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
    const body = (await res.json()) as { root: string };
    return body.root === root ? info : null;
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

/**
 * Routes exec calls to the project's server. Uses a running server when there is one,
 * otherwise starts one inside this process.
 */
export class ExecClient {
  private local: PennaServer | null = null;
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  async exec(req: ExecRequest): Promise<WireResult> {
    if (this.local) return toWire(await this.local.exec(req));
    const remote = await findServer(this.root);
    if (remote) {
      const res = await fetch(remote.url + "/api/exec", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${remote.token}` },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`penna server refused the call (${res.status}): ${await res.text()}`);
      return (await res.json()) as WireResult;
    }
    this.local = await startServer(this.root);
    process.stderr.write(`penna: viewer at ${this.local.info.url}\n`);
    return toWire(await this.local.exec(req));
  }

  async close() {
    await this.local?.close();
  }
}
