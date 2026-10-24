#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ExecClient, findServer, spawnServer } from "./server/client.ts";
import { startServer } from "./server/http.ts";
import { runMcp } from "./server/mcp.ts";
import { pkgPath } from "./server/paths.ts";
import { findRoot, Store } from "./server/store.ts";

const HELP = `penna: an agent-first design canvas that lives in your repo.

Usage:
  penna [dev] [--port N] [--open]   Start the viewer for this project
  penna mcp                          Run the MCP server (stdio) for agents
  penna exec [-f FILE] [CODE | -]    Run a snippet (reads stdin when CODE is - or missing)
  penna init                         Create .penna/ and print agent setup
  penna skill                        Print the agent skill (SKILL.md)
`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith("-") ? args.shift()! : "dev";
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, v && !v.startsWith("-") ? 2 : 1);
    return v && !v.startsWith("-") ? v : "";
  };
  const root = findRoot(process.cwd());

  switch (cmd) {
    case "dev": {
      const port = Number(flag("--port") ?? 6060);
      const open = flag("--open") !== undefined;
      const quiet = flag("--quiet") !== undefined;
      const existing = await findServer(root);
      if (existing) {
        console.log(`penna is already running for this project: ${existing.url}`);
        if (open) openBrowser(existing.url);
        return;
      }
      const server = await startServer(root, port);
      if (!quiet) {
        console.log(`penna  ${server.info.url}`);
        console.log(`       ${path.relative(process.cwd(), server.store.dir) || ".penna"}/ · ${server.store.list().length} file(s)`);
      }
      if (open) openBrowser(server.info.url);
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "mcp":
      return runMcp(root);
    case "exec": {
      const file = flag("-f") ?? flag("--file");
      let code = args.join(" ");
      if (!code || code === "-") code = fs.readFileSync(0, "utf8");
      if (!(await findServer(root))) await spawnServer(root);
      const client = new ExecClient(root);
      const r = await client.exec({ code, file });
      console.log(r.text);
      if (r.shots.length) {
        const dir = path.join(root, ".penna", ".shots");
        fs.mkdirSync(dir, { recursive: true });
        for (const s of r.shots) {
          const out = path.join(dir, `${s.id}-${Date.now()}.png`);
          fs.writeFileSync(out, Buffer.from(s.png, "base64"));
          console.log(`Screenshot ${s.name}: ${out}`);
        }
      }
      process.exit(r.ok ? 0 : 1);
    }
    case "init": {
      new Store(root).ensureDir();
      console.log(`Created ${path.join(root, ".penna")}/

Add penna to Claude Code:
  claude mcp add penna -- npx -y @marcoazzurrini/penna mcp

Or any MCP client: command "npx", args ["-y", "@marcoazzurrini/penna", "mcp"], run from this project.
Then run "npx @marcoazzurrini/penna" to open the viewer.`);
      return;
    }
    case "skill":
    case "guide":
      process.stdout.write(fs.readFileSync(pkgPath("skill", "SKILL.md"), "utf8"));
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exit(1);
  }
}

function openBrowser(url: string) {
  const bin = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(bin, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
