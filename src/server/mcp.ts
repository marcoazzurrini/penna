import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ExecClient, listServers } from "./client.ts";
import { pkgPath } from "./paths.ts";
import { gitBranch, repoName } from "./project.ts";

export async function runMcp(root: string) {
  const skillDir = pkgPath("skill");
  const client = new ExecClient(root);
  const { version } = JSON.parse(fs.readFileSync(pkgPath("package.json"), "utf8")) as { version: string };
  const branch = gitBranch(root);
  const where = `${root}${branch ? ` (branch ${branch})` : ""}`;
  // Keep what loads into every session short; the full skill is one read_skill call away.
  const server = new McpServer(
    { name: "penna", version },
    {
      instructions:
        `penna is this project's design canvas. Designs live in .penna/ and render as HTML/CSS. For any UI design work, call read_skill once, then use execute. ` +
        `This session's canvas is ${where}. Each git worktree has its own canvas and viewer. ` +
        `Call status for the viewer URL; never guess the port.`,
    },
  );
  const viewerLine = (url: string) => {
    const b = gitBranch(root);
    return `Viewer: ${url}${b ? ` (${repoName(root)} · ${b})` : ""}`;
  };

  server.registerTool(
    "read_skill",
    {
      description:
        "Read the penna skill that teaches how to design on the penna canvas: the design model, the execute API, rules, and an example. Call once before your first execute in a session.\n\nUsage:\n1. read_skill(): returns the skill's SKILL.md\n2. read_skill({ path }): read a file referenced from SKILL.md",
      inputSchema: {
        path: z.string().optional().describe("Relative path of a file referenced from SKILL.md. Omit to read SKILL.md itself."),
      },
    },
    async ({ path: rel }) => {
      const file = path.resolve(skillDir, rel || "SKILL.md");
      if (!file.startsWith(skillDir + path.sep) || !file.endsWith(".md") || !fs.existsSync(file)) {
        return { content: [{ type: "text", text: `No skill file "${rel}".` }], isError: true };
      }
      return { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] };
    },
  );

  server.registerTool(
    "status",
    {
      description:
        "Show this project's viewer URL, folder, and git branch, and the penna viewers of the repo's other worktrees. Starts the viewer if it is not running. Use it to open or share the canvas; never guess the port.",
      inputSchema: {},
    },
    async () => {
      const { info, local } = await client.server();
      const lines = [
        viewerLine(info.url),
        `Root: ${root}`,
        `Server: pid ${info.pid}${local ? " (inside this MCP process; it stops when the session ends)" : ""}`,
      ];
      const others = (await listServers(root)).filter((w) => !w.current);
      if (others.length) {
        lines.push("Other worktrees:");
        for (const w of others) lines.push(`- ${w.branch ?? "(no branch)"}: ${w.server?.url ?? "not running"}  ${w.root}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "execute",
    {
      description:
        "Run a JavaScript snippet that reads and edits this project's penna design (.penna/). One call can build a whole screen and screenshot it. Each call is atomic. Call read_skill first for the API.",
      inputSchema: {
        code: z.string().optional().describe("JavaScript snippet. Required unless editId is given."),
        editId: z.string().optional().describe("Id of a failed call to patch and re-run. Use with edits, without code."),
        edits: z
          .array(z.object({ find: z.string(), replace: z.string(), all: z.boolean().optional() }))
          .optional()
          .describe("Find/replace edits applied in order to the failed snippet."),
      },
    },
    async (args) => {
      const r = await client.exec(args);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: `${r.text}\n\n${viewerLine(r.info.url)}` },
      ];
      for (const s of r.shots) {
        content.push({ type: "text", text: `Screenshot: ${s.name} (${s.id})` });
        content.push({ type: "image", data: s.png, mimeType: "image/png" });
      }
      return { content, isError: !r.ok };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Start the viewer now, so the first call is fast and status has a URL at once. Only
  // for projects that use penna: starting a server would create .penna/ anywhere else.
  if (fs.existsSync(path.join(root, ".penna"))) client.server().catch((err) => process.stderr.write(`penna: ${err?.message ?? err}\n`));
  const shutdown = async () => {
    await client.close();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
