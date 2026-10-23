import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { lockFile, startServer, type PennaServer } from "../src/server/http.ts";

let server: PennaServer;
let url: string;

before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penna-server-"));
  server = await startServer(root, 0);
  url = server.info.url;
});

after(() => server.close());

const exec = (headers: Record<string, string>, body = { code: "Print(1)" }) =>
  fetch(url + "/api/exec", { method: "POST", headers, body: JSON.stringify(body) });

test("exec requires the token", async () => {
  assert.equal((await exec({ "content-type": "application/json" })).status, 403);
  // What any website can send to localhost without a CORS preflight.
  assert.equal((await exec({ "content-type": "text/plain", origin: "https://evil.example" })).status, 403);
});

test("exec works with the token and JSON", async () => {
  const res = await exec({ "content-type": "application/json", authorization: `Bearer ${server.info.token}` });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

test("exec rejects cross-origin requests even with the token", async () => {
  const res = await exec({ "content-type": "application/json", authorization: `Bearer ${server.info.token}`, origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("a foreign Host header is rejected (DNS rebinding)", async () => {
  const http = await import("node:http");
  const status = await new Promise<number>((resolve) => {
    http.get({ host: "127.0.0.1", port: server.info.port, path: "/api/ping", headers: { host: `evil.example:${server.info.port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
  });
  assert.equal(status, 421);
});

test("dotfiles are never served", async () => {
  assert.equal((await fetch(url + "/files/.server.json")).status, 404);
});

test("the lock file is private to the user", { skip: process.platform === "win32" }, () => {
  const mode = fs.statSync(lockFile(server.info.root)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("cross-site WebSockets are refused", async () => {
  const outcome = await new Promise<string>((resolve) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", { origin: "https://evil.example" });
    ws.on("message", () => resolve("connected"));
    ws.on("error", () => resolve("refused"));
  });
  assert.equal(outcome, "refused");
});
