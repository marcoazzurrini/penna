import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Executor, type ExecRequest, type ExecResult } from "./execute.ts";
import { fontsCss } from "./fonts.ts";
import { Headless } from "./headless.ts";
import { pkgPath, resolveDep } from "./paths.ts";
import { Store } from "./store.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

export interface ServerInfo {
  port: number;
  pid: number;
  url: string;
  root: string;
  /** Secret required by /api/exec. Only readable by the local user, via the lock file. */
  token: string;
}

const MAX_BODY = 32 * 1024 * 1024;

export interface PennaServer {
  info: ServerInfo;
  store: Store;
  exec(req: ExecRequest): Promise<ExecResult>;
  close(): Promise<void>;
}

/** JSON-safe form of an exec result, used over HTTP. */
export interface WireResult extends Omit<ExecResult, "shots"> {
  shots: { id: string; name: string; png: string }[];
}

export function toWire(r: ExecResult): WireResult {
  return { ...r, shots: r.shots.map((s) => ({ id: s.id, name: s.name, png: s.png.toString("base64") })) };
}

export function lockFile(root: string) {
  return path.join(root, ".penna", ".server.json");
}

export async function startServer(root: string, preferredPort = 6060): Promise<PennaServer> {
  const store = new Store(root);
  store.ensureDir();
  store.watch();

  const clientDir = pkgPath("dist", "client");
  const iconDir = path.join(resolveDep("lucide-static"), "icons");
  const tailwindFile = path.join(resolveDep("@tailwindcss/browser"), "dist", "index.global.js");

  let url = "";
  const headless = new Headless(() => url);
  const executor = new Executor(store, headless, iconDir, () => url);

  const clients = new Set<WebSocket>();
  const project = path.basename(root);
  let focus: string | null = null;
  const docMsg = (): Record<string, unknown> => ({ t: "doc", project, rev: store.rev, doc: store.get() });

  store.on("change", () => {
    const msg = docMsg();
    if (focus) msg.focus = focus;
    focus = null;
    const text = JSON.stringify(msg);
    for (const ws of clients) ws.send(text);
  });

  const exec = (req: ExecRequest) => executor.run(req);
  const token = crypto.randomBytes(32).toString("base64url");
  let port = 0;

  // Browsers let any website send requests to localhost. Reject requests whose Host is
  // not ours (DNS rebinding) and cross-site WebSockets. /api/exec also needs the token.
  const hostOk = (req: http.IncomingMessage) => {
    const host = (req.headers.host ?? "").toLowerCase();
    return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`;
  };
  const originOk = (req: http.IncomingMessage) => {
    const origin = req.headers.origin;
    return !origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}` || origin === `http://[::1]:${port}`;
  };
  const tokenOk = (req: http.IncomingMessage) => {
    const given = Buffer.from(String(req.headers.authorization ?? ""));
    const want = Buffer.from(`Bearer ${token}`);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };
  executor.onCommit = (page) => {
    focus = page;
  };

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String((err as Error)?.message ?? err));
    }
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!hostOk(req)) return deny(res, 421, "Unknown host.");
    const u = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(u.pathname);

    if (p === "/api/ping") return json(res, { ok: true, root, pid: process.pid });
    if (p === "/api/exec") {
      if (req.method !== "POST") return deny(res, 405, "Use POST.");
      if (!originOk(req) || !tokenOk(req)) return deny(res, 403, "Missing or wrong token.");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return deny(res, 415, "Send application/json.");
      const body = JSON.parse(await readBody(req)) as ExecRequest;
      return json(res, toWire(await exec(body)));
    }
    if (p === "/fonts.css") {
      const families = (u.searchParams.get("f") ?? "").split("|").filter(Boolean);
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "max-age=3600" });
      return res.end(await fontsCss(families));
    }
    if (p === "/vendor/tailwind.js") return sendFile(res, tailwindFile, "max-age=86400");
    if (p.startsWith("/icon/")) {
      const name = path.basename(p.slice(6), ".svg");
      return sendFile(res, path.join(iconDir, name + ".svg"), "max-age=86400");
    }
    if (p.startsWith("/files/")) {
      // Never serve dotfiles such as .server.json, which holds the exec token.
      if (p.split("/").some((seg) => seg.startsWith("."))) return deny(res, 404, "Not found");
      return sendFile(res, safeJoin(store.dir, p.slice(7)));
    }
    const file = safeJoin(clientDir, p === "/" ? "index.html" : p.slice(1));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);
    return sendFile(res, path.join(clientDir, "index.html"));
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws" || !hostOk(req) || !originOk(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    ws.send(JSON.stringify(docMsg()));
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (data) => {
      let msg: { t: string; page?: string; ids?: string[]; sizes?: Record<string, [number, number]> };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.t === "view" && typeof msg.page === "string") store.viewing = msg.page;
      else if (msg.t === "select") store.selection = { page: String(msg.page ?? ""), ids: Array.isArray(msg.ids) ? msg.ids.map(String) : [] };
      else if (msg.t === "sizes") for (const [id, s] of Object.entries(msg.sizes ?? {})) store.sizes.set(id, s);
      else if (msg.t === "undo") store.undo();
      else if (msg.t === "redo") store.redo();
    });
  });

  port = await listen(server, preferredPort);
  url = `http://localhost:${port}`;
  const info: ServerInfo = { port, pid: process.pid, url, root, token };
  fs.rmSync(lockFile(root), { force: true });
  fs.writeFileSync(lockFile(root), JSON.stringify(info), { mode: 0o600 });

  const close = async () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockFile(root), "utf8")) as ServerInfo;
      if (current.pid === process.pid) fs.unlinkSync(lockFile(root));
    } catch {}
    store.unwatch();
    await headless.close();
    for (const ws of clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { info, store, exec, close };
}

function listen(server: http.Server, port: number, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE" && tries > 1) resolve(listen(server, port + 1, tries - 1));
      else reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as { port: number }).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function safeJoin(base: string, rel: string): string {
  const full = path.resolve(base, rel);
  return full.startsWith(path.resolve(base) + path.sep) ? full : "";
}

function sendFile(res: http.ServerResponse, file: string, cache = "no-cache") {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": cache });
  fs.createReadStream(file).pipe(res);
}

function deny(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(message);
}

function json(res: http.ServerResponse, data: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) {
        reject(new Error("Request too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
