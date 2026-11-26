import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser } from "playwright-core";
import { WebSocket } from "ws";
import net from "node:net";
import { ExecClient } from "../src/server/client.ts";
import { Headless } from "../src/server/headless.ts";
import { indexDoc } from "../src/shared/tree.ts";
import { pkgPath } from "../src/server/paths.ts";
import { AlreadyRunning, lockFile, startServer, type PennaServer } from "../src/server/http.ts";

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

/** A server on a free port in a new folder. `port` 0 would hide the race the tests below are about. */
const newRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penna-server-")));

test("two starts at the same moment give one server", async () => {
  const root = newRoot();
  const results = await Promise.allSettled([startServer(root), startServer(root)]);
  const started = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  try {
    assert.equal(started.length, 1);
    assert.ok(refused[0] instanceof AlreadyRunning);
    assert.equal(refused[0].port, started[0].info.port);

    // A client that loses the race uses the winner's server.
    const client = new ExecClient(root);
    const r = await client.exec({ code: `Print("hi")` });
    assert.equal(r.info.pid, process.pid);
    assert.equal(r.info.port, started[0].info.port);
    await client.close();
  } finally {
    for (const s of started) await s.close();
  }
});

test("viewers are told about broken files", async () => {
  const root = newRoot();
  fs.mkdirSync(path.join(root, ".penna", "pages"), { recursive: true });
  fs.writeFileSync(path.join(root, ".penna", "pages", "home.json"), "<<<<<<< HEAD\n{}");
  const s = await startServer(root, 0);
  try {
    const msg = await new Promise<{ problems?: string[] }>((resolve) => {
      const ws = new WebSocket(s.info.url.replace("http", "ws") + "/ws");
      ws.on("message", (data) => {
        resolve(JSON.parse(String(data)));
        ws.close();
      });
    });
    assert.match(msg.problems![0], /pages\/home\.json is ignored: it has git conflict markers/);
  } finally {
    await s.close();
  }
});

test("an incomplete fonts answer is not cached by the browser", async () => {
  // "Not A Font" needs no request to Google, so the answer is complete even offline.
  const res = await fetch(url + "/fonts.css?f=" + encodeURIComponent("Not A Font"));
  assert.equal(res.headers.get("cache-control"), "max-age=3600");
});

// The tests below need Chrome. They are skipped where there is none.
let chrome: Browser | null = null;
before(async () => {
  // Chrome loads the built viewer. Build it when the tests run before `npm run build`.
  if (!fs.existsSync(pkgPath("dist", "client", "index.html"))) {
    const { build } = await import("vite");
    await build({ configFile: pkgPath("vite.config.ts"), logLevel: "silent" });
  }
  try {
    const { chromium } = await import("playwright-core");
    chrome = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
  } catch {}
});
after(() => chrome?.close());
const NO_CHROME = "Chrome is not installed";

test("Layout inside a snippet sees classes that are not saved yet", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await server.exec({
    code: `const id = Insert(page, {name: "Box", class: "w-[321px] h-[77px]"}); const l = await Layout(id); Print(l.width, l.height)`,
  });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^321 77/);
});

test("a screenshot renders components from other pages", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await server.exec({
    code: `Page("Kit"); Insert(page, {name: "Chip", component: true, style: {width: 120, height: 40, background: "#f00"}})
      Page("App"); home = Insert(page, {name: "Home", style: {width: 300, padding: 10}, children: [{ref: "Chip"}]})
      const l = await Layout(home); Print(JSON.stringify(l.nodes.map(n => n.slice(1)))); Check(home); Screenshot(home)`,
  });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /\["Chip",10,10,120,40\]/);
  assert.match(r.text, /no layout problems \(300×60\)/);
  assert.equal(r.shots.length, 1);
  assert.ok(r.shots[0].png.length > 100);
});

test("SVG from a design file cannot run script or restyle the viewer", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const page = await chrome!.newPage();
  try {
    await page.goto(url + "/?headless=1");
    await page.waitForFunction(() => "__penna" in window);
    const clean = (markup: string) => page.evaluate((m) => (window as unknown as { __penna: { sanitizeSvg(m: string): string | null } }).__penna.sanitizeSvg(m), markup);
    const svg = (inner: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;

    const out = (await clean(
      svg(
        `<script>alert(1)</script><style>* { display: none }</style><foreignObject><div>x</div></foreignObject>` +
          `<a href="javascript:alert(1)"><circle r="5" onclick="alert(1)"/></a>` +
          `<a xlink:href="JaVa\tScript:alert(1)"><rect/></a>` +
          `<image href="data:image/svg+xml;base64,AAAA"/><use href="#ok"/><a href="https://example.com"><path id="ok" d="M0 0"/></a>` +
          `<animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onload" to="x"/><animate attributeName="opacity" to="0"/>`,
        `onload="alert(1)"`,
      ),
    ))!;
    for (const bad of ["script", "<style", "foreignObject", "javascript", "onclick", "onload", "data:image/svg", 'attributeName="href"']) {
      assert.equal(out.toLowerCase().includes(bad.toLowerCase()), false, `${bad} survived: ${out}`);
    }
    for (const kept of ["<circle", "<rect", '<use href="#ok"', 'href="https://example.com"', 'attributeName="opacity"']) {
      assert.ok(out.includes(kept), `${kept} was removed: ${out}`);
    }
    assert.equal(await clean("<div>not svg</div>"), null);
    assert.equal(await clean("<svg><unclosed"), null);
  } finally {
    await page.close();
  }
});

test("a render that hangs is stopped, and the next one works", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  // A server that accepts connections and never answers.
  const silent = net.createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  let target = `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}`;
  const headless = new Headless(() => target);
  headless.timeout = 1500;
  const doc = server.store.get();
  const id = doc.pages[0].id;
  try {
    await assert.rejects(headless.layout(doc, indexDoc(doc), id), /Rendering took longer than 1\.5 s/);
    target = url;
    headless.timeout = 30_000;
    const report = await headless.layout(doc, indexDoc(doc), id);
    assert.ok(Array.isArray(report.problems));
  } finally {
    await headless.close();
    silent.close();
  }
});
