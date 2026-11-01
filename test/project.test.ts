import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { listServers } from "../src/server/client.ts";
import { startServer, type PennaServer } from "../src/server/http.ts";
import { defaultPort, gitBranch, portAllowed, repoName } from "../src/server/project.ts";
import { findRoot } from "../src/server/store.ts";

// A repo named "app" with .penna/ at its root, plus two worktrees: one outside the repo,
// and one nested inside it (as Claude Code makes them) whose branch has no .penna/ yet.
let base: string;
let main: string;
let outside: string;
let nested: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penna-project-")));
  main = path.join(base, "app");
  fs.mkdirSync(path.join(main, ".penna"), { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  outside = path.join(base, "t3-c77eeaea");
  git(main, "worktree", "add", "-q", "-b", "feat/a", outside);
  fs.mkdirSync(path.join(outside, ".penna"));
  nested = path.join(main, ".claude", "worktrees", "b");
  git(main, "worktree", "add", "-q", "-b", "feat/b", nested);
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test("findRoot stops at the git root of a nested worktree", () => {
  fs.mkdirSync(path.join(nested, "src"), { recursive: true });
  assert.equal(findRoot(path.join(nested, "src")), nested);
  assert.equal(findRoot(path.join(main, ".claude")), main);
});

test("branch and repo name are read through a worktree", () => {
  assert.equal(gitBranch(main), "main");
  assert.equal(gitBranch(outside), "feat/a");
  assert.equal(repoName(outside), "app");
  assert.equal(repoName(nested), "app");
  assert.equal(gitBranch(os.tmpdir()), null);
});

test("each folder gets its own stable, browser-safe port", () => {
  assert.equal(defaultPort(main), defaultPort(main));
  assert.notEqual(defaultPort(main), defaultPort(outside));
  for (const p of [main, outside, nested]) {
    const port = defaultPort(p);
    assert.ok(port >= 6100 && port < 7000 && portAllowed(port), String(port));
  }
  assert.equal(portAllowed(6666), false);
});

test("listServers finds the server of each worktree", async () => {
  let server: PennaServer | null = null;
  try {
    server = await startServer(outside, 0);
    const list = await listServers(main);
    assert.deepEqual(
      list.map((w) => [w.root, w.branch, w.current, w.server?.url ?? null]).sort(),
      [
        [main, "main", true, null],
        [outside, "feat/a", false, server.info.url],
        [nested, "feat/b", false, null],
      ].sort(),
    );
    assert.equal(server.info.project, "app");
    const ping = (await (await fetch(server.info.url + "/api/ping")).json()) as { branch: string; project: string };
    assert.equal(ping.branch, "feat/a");
    // The viewer shows "app · feat/a", not the worktree's generated folder name.
    const ws = new WebSocket(server.info.url.replace("http", "ws") + "/ws");
    const first = await new Promise<{ project: string; branch?: string }>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
    ws.close();
    assert.deepEqual([first.project, first.branch], ["app", "feat/a"]);
  } finally {
    await server?.close();
  }
});
