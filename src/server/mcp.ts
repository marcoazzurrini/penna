import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ExecClient } from "./client.ts";
import { pkgPath } from "./paths.ts";

export async function runMcp(root: string) {
  const guide = fs.readFileSync(pkgPath("AGENT.md"), "utf8");
  const client = new ExecClient(root);
  const { version } = JSON.parse(fs.readFileSync(pkgPath("package.json"), "utf8")) as { version: string };
  const server = new McpServer({ name: "penna", version });

  server.registerTool(
    "execute",
    {
      description: guide,
      inputSchema: {
        code: z.string().optional().describe("JavaScript snippet. Required unless editId is given."),
        file: z.string().optional().describe("Design file name in .penna/ without .json. Defaults to the file open in the viewer, else the first file, else \"design\". Created if missing."),
        editId: z.string().optional().describe("Id of a failed call to patch and re-run. Use with edits, without code."),
        edits: z
          .array(z.object({ find: z.string(), replace: z.string(), all: z.boolean().optional() }))
          .optional()
          .describe("Find/replace edits applied in order to the failed snippet."),
      },
    },
    async (args) => {
      const r = await client.exec(args);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: r.text }];
      for (const s of r.shots) {
        content.push({ type: "text", text: `Screenshot: ${s.name} (${s.id})` });
        content.push({ type: "image", data: s.png, mimeType: "image/png" });
      }
      return { content, isError: !r.ok };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await client.close();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
