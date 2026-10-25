// Viewer performance benchmark.
//
// Generates a project with a 20,000-node page plus a few smaller pages, starts the penna
// server in this process, opens the viewer in headless Chrome, and measures:
//   - initial load: main-thread time until the page goes quiet
//   - edits made through the executor: server time, WebSocket bytes, and main-thread
//     time in the viewer until it goes quiet again
//
// Usage: npm run build && node bench/run.ts [--out file.json] [--label name]

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { startServer, type PennaServer } from "../src/server/http.ts";
import type { PennaNode } from "../src/shared/types.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const OUT = opt("--out");
const LABEL = opt("--label") ?? "run";
const PROFILE = args.includes("--profile");
const TRACE = args.includes("--trace");
const LOADS = 3;
const EDITS = 5;

// ---------- Document generator ----------

const COMMON = [
  "flex", "flex-col", "flex-row", "items-center", "items-start", "justify-between", "justify-center",
  "gap-1", "gap-2", "gap-3", "gap-4", "gap-6", "gap-8", "p-2", "p-3", "p-4", "p-6", "p-8", "px-3", "px-4",
  "py-1", "py-2", "py-3", "rounded", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-full",
  "bg-white", "bg-zinc-50", "bg-zinc-100", "bg-zinc-900", "bg-indigo-500", "bg-emerald-50", "bg-rose-50",
  "text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-4xl", "font-medium",
  "font-semibold", "font-bold", "text-zinc-500", "text-zinc-600", "text-zinc-900", "text-white",
  "text-indigo-600", "border", "border-zinc-200", "shadow-sm", "shadow-md", "w-full", "grow", "shrink-0",
  "leading-tight", "leading-relaxed", "tracking-tight", "truncate", "grid", "grid-cols-2", "grid-cols-3",
  "size-4", "size-5", "size-6", "size-10", "opacity-80", "hover:bg-zinc-100", "dark:bg-zinc-800",
  "md:flex-row", "uppercase", "underline", "overflow-hidden", "relative", "absolute", "top-2", "right-2",
];
const ICONS = ["house", "search", "bell", "user", "settings", "star", "heart", "mail", "calendar", "chevron-right"];

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const classes = (n: number, uniq: number) => {
  const out = new Set<string>();
  while (out.size < n) out.add(pick(COMMON));
  // Arbitrary values, as agents write them. They make the class set large and varied.
  if (rand() < 0.3) out.add(`w-[${100 + (uniq % 400)}px]`);
  if (rand() < 0.2) out.add(`text-[#${((uniq * 2654435761) >>> 8).toString(16).padStart(6, "0").slice(0, 6)}]`);
  return [...out].join(" ");
};

/** A screen with exactly `count` nodes, including itself. */
function screen(prefix: string, idx: number, count: number, ref?: string): PennaNode {
  let n = 0;
  const id = () => `${prefix}-n${n++}`;
  const root: PennaNode = {
    id: id(),
    type: "frame",
    name: `Screen ${idx}`,
    x: (idx % 10) * 1600,
    y: Math.floor(idx / 10) * 1200,
    class: "flex flex-col gap-6 p-8 bg-white rounded-2xl",
    style: { width: 1440 },
    children: [],
  };
  // Cards of up to 25 nodes until the budget runs out.
  while (n < count) {
    const card: PennaNode = { id: id(), type: "frame", name: "Card", class: classes(4, n), children: [] };
    root.children!.push(card);
    const budget = Math.min(25, count - n);
    for (let i = 0; i < budget && n < count; i++) {
      const r = rand();
      const uniq = idx * 1000 + n;
      if (ref && i === 0 && rand() < 0.3) card.children!.push({ id: id(), type: "ref", ref, name: "Card instance" });
      else if (r < 0.6) card.children!.push({ id: id(), type: "text", text: `Label ${uniq}`, class: classes(3, uniq) });
      else if (r < 0.75) card.children!.push({ id: id(), type: "icon", icon: pick(ICONS), class: "size-5 text-zinc-500" });
      else card.children!.push({ id: id(), type: "frame", class: classes(5, uniq), style: { minHeight: 8 + (uniq % 40) } });
    }
  }
  return root;
}

function writeProject(root: string) {
  const dir = path.join(root, ".penna");
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const component: PennaNode = {
    id: "card", type: "frame", name: "Card", component: true, x: 0, y: 0,
    class: "flex flex-col gap-2 p-4 rounded-xl border border-zinc-200",
    children: [
      { id: "card-title", type: "text", name: "Title", text: "Component title", class: "text-lg font-semibold" },
      { id: "card-body", type: "text", name: "Body", text: "Component body", class: "text-sm text-zinc-500" },
    ],
  };
  const pages: [string, string, PennaNode[]][] = [
    ["main", "Main", Array.from({ length: 100 }, (_, i) => screen(`s${i}`, i, 200, "card"))],
    ["second", "Second", Array.from({ length: 10 }, (_, i) => screen(`b${i}`, i, 100))],
    ["third", "Third", Array.from({ length: 10 }, (_, i) => screen(`c${i}`, i, 100))],
    ["components", "Components", [component]],
  ];
  for (const [id, name, children] of pages) {
    fs.writeFileSync(path.join(dir, "pages", id + ".json"), JSON.stringify({ version: 2, name, children }, null, 1));
  }
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 2, pages: pages.map((p) => p[0]), variables: { accent: "#6366f1" } }, null, 1));
  let nodes = 0;
  const count = (n: PennaNode) => {
    nodes++;
    n.children?.forEach(count);
  };
  pages.forEach((p) => p[2].forEach(count));
  // Nodes for the edit scenarios: a text and a plain frame inside cards.
  const find = (top: PennaNode, type: string) => top.children!.flatMap((c) => c.children ?? []).find((n) => n.type === type)!.id;
  const main = pages[0][2][50], other = pages[1][2][3];
  return { nodes, mainNodes: 100 * 200, ids: { text: find(main, "text"), frame: find(main, "frame"), other: find(other, "text") } };
}

// ---------- Measuring ----------

interface Metrics {
  task: number;
  script: number;
  layout: number;
  style: number;
  heap: number;
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { task: m.TaskDuration, script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration, heap: m.JSHeapUsedSize };
}

/** Wait until the main thread has been quiet for `quietMs`. Returns ms until the last activity. */
async function settle(cdp: CDPSession, start: number, quietMs = 400): Promise<number> {
  let last = (await metrics(cdp)).task;
  let lastBusy = performance.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    const now = (await metrics(cdp)).task;
    if (now - last > 0.001) lastBusy = performance.now();
    last = now;
    if (performance.now() - lastBusy > quietMs) return lastBusy - start;
    if (performance.now() - start > 60_000) throw new Error("Viewer never settled.");
  }
}

const diff = (a: Metrics, b: Metrics) => ({
  mainThreadMs: (b.task - a.task) * 1000,
  scriptMs: (b.script - a.script) * 1000,
  layoutMs: (b.layout - a.layout) * 1000,
  styleMs: (b.style - a.style) * 1000,
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const summarize = (runs: Record<string, number>[]) => {
  const out: Record<string, number> = {};
  for (const k of Object.keys(runs[0])) out[k] = Math.round(median(runs.map((r) => r[k])) * 10) / 10;
  return out;
};

/** Hash of computed styles for the first screens, to check that rendering did not change. */
async function styleHash(page: Page): Promise<string> {
  const data = await page.evaluate(() => {
    const props = ["display", "width", "height", "padding", "margin", "color", "background-color", "font-size", "font-weight", "line-height", "border-radius", "gap", "flex-direction", "border-top-width", "box-shadow", "opacity"];
    const out: string[] = [];
    const tops = [...document.querySelectorAll<HTMLElement>(".pn-top")].slice(0, 3);
    for (const top of tops) {
      for (const el of top.querySelectorAll<HTMLElement>("[data-id]")) {
        const cs = getComputedStyle(el);
        out.push(el.dataset.id + ":" + props.map((p) => cs.getPropertyValue(p)).join("|"));
      }
    }
    return out.join("\n");
  });
  return crypto.createHash("sha1").update(data).digest("hex").slice(0, 12);
}

async function openViewer(browser: import("playwright-core").Browser, url: string, profile = false) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (PROFILE && profile) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    await cdp.send("Profiler.start");
  }
  await cdp.send("Network.enable");
  let wsBytes = 0;
  cdp.on("Network.webSocketFrameReceived", (e) => (wsBytes += e.response.payloadData.length));
  await browser.startTracing(page, { categories: ["toplevel", "cc", "devtools.timeline", "disabled-by-default-devtools.timeline"] });
  const before = await metrics(cdp);
  const start = performance.now();
  await page.goto(url + "/");
  await page.waitForFunction(() => document.querySelectorAll(".pn-top").length >= 100, null, { timeout: 60_000 });
  await settle(cdp, start);
  const after = await metrics(cdp);
  const trace = JSON.parse(String(await browser.stopTracing()));
  if (opt("--trace-out") && profile) fs.writeFileSync(opt("--trace-out")!, JSON.stringify(trace));
  if (TRACE && profile) console.log("\nTrace: load\n" + traceSummary(trace).join("\n"));
  if (PROFILE && profile) {
    const { profile } = await cdp.send("Profiler.stop");
    console.log("\nProfile: load\n" + topFunctions(profile as never).join("\n"));
  }
  const tasks = loadTasks(trace);
  return {
    page,
    cdp,
    wsBytes: () => wsBytes,
    load: { ...tasks, ...diff(before, after), heapMB: after.heap / 1e6, wsKB: wsBytes / 1024 },
  };
}

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string };
}

function mainThread(trace: { traceEvents: TraceEvent[] }) {
  const main = trace.traceEvents.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  if (!main) throw new Error("No renderer main thread in trace.");
  return trace.traceEvents
    .filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === "X" && e.dur)
    .sort((a, b) => a.ts - b.ts) as (TraceEvent & { dur: number })[];
}

/**
 * Main-thread time during load, from a trace. Chrome tears down the initial blank
 * document's compositor about a second after navigating; that is not penna's work, so
 * it is reported separately.
 */
function loadTasks(trace: { traceEvents: TraceEvent[] }) {
  const events = mainThread(trace);
  const tasks: { e: TraceEvent & { dur: number }; teardown: boolean }[] = [];
  let end = 0;
  for (const e of events) {
    if (e.ts >= end && e.name === "ThreadControllerImpl::RunTask") {
      tasks.push({ e, teardown: false });
      end = e.ts + e.dur;
    } else if (e.ts < end && e.name === "LayerTreeHost::~LayerTreeHost") tasks[tasks.length - 1].teardown = true;
  }
  const app = tasks.filter((t) => !t.teardown);
  const first = tasks[0]?.e.ts ?? 0;
  const last = app.filter((t) => t.e.dur > 5000).at(-1)?.e;
  return {
    renderedMs: last ? (last.ts + last.dur - first) / 1000 : 0,
    appMainThreadMs: app.reduce((s, t) => s + t.e.dur, 0) / 1000,
    teardownMs: tasks.filter((t) => t.teardown).reduce((s, t) => s + t.e.dur, 0) / 1000,
  };
}

/** Self time per trace event name on the renderer main thread. */
function traceSummary(trace: { traceEvents: TraceEvent[] }, n = 12) {
  const own = mainThread(trace).filter((e) => !e.name.includes("::") && !e.name.startsWith("V8."));
  const self = new Map<string, number>();
  const stack: { e: (typeof own)[number]; child: number }[] = [];
  const close = (until: number) => {
    while (stack.length && stack[stack.length - 1].e.ts + stack[stack.length - 1].e.dur <= until) {
      const top = stack.pop()!;
      self.set(top.e.name, (self.get(top.e.name) ?? 0) + (top.e.dur - top.child) / 1000);
      if (stack.length) stack[stack.length - 1].child += top.e.dur;
    }
  };
  for (const e of own) {
    close(e.ts);
    stack.push({ e, child: 0 });
  }
  close(Infinity);
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${ms.toFixed(1).padStart(7)} ms  ${k}`);
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

/** Self time per function from a CPU profile, largest first. */
function topFunctions(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }, n = 12) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const f = byId.get(id)!.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
  });
  return [...self].filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)")).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, ms]) => `${ms.toFixed(1).padStart(7)} ms  ${k}`);
}

async function profiled<T>(v: Awaited<ReturnType<typeof openViewer>>, name: string, job: () => Promise<T>): Promise<T> {
  if (!PROFILE) return job();
  await v.cdp.send("Profiler.enable");
  await v.cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await v.cdp.send("Profiler.start");
  const out = await job();
  const { profile } = await v.cdp.send("Profiler.stop");
  console.log(`\nProfile: ${name}\n` + topFunctions(profile as never).join("\n"));
  return out;
}

async function edit(server: PennaServer, v: Awaited<ReturnType<typeof openViewer>>, code: string, check: string) {
  const bytes0 = v.wsBytes();
  const before = await metrics(v.cdp);
  const start = performance.now();
  const r = await server.exec({ code });
  const serverMs = performance.now() - start;
  if (!r.ok) throw new Error(r.text);
  const settledMs = await settle(v.cdp, start);
  const after = await metrics(v.cdp);
  const ok = await v.page.evaluate(check);
  if (!ok) throw new Error(`Edit not visible in the viewer: ${check}`);
  return { serverMs, settledMs, ...diff(before, after), wsKB: (v.wsBytes() - bytes0) / 1024 };
}

// ---------- Main ----------

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penna-bench-"));
  const { nodes, mainNodes, ids } = writeProject(root);
  console.log(`Project: ${nodes} nodes (${mainNodes} on the viewed page) in ${root}`);

  const server = await startServer(root, 0);
  // A fresh browser per load: closing a page tears down its compositor on a renderer
  // thread the next page may share, which would land inside the next measurement.
  let browser: import("playwright-core").Browser | null = null;
  try {
    const loads = [];
    let viewer: Awaited<ReturnType<typeof openViewer>> | null = null;
    for (let i = 0; i < LOADS; i++) {
      await browser?.close();
      browser = await chromium.launch({ channel: "chrome", headless: true });
      viewer = await openViewer(browser, server.info.url, i === LOADS - 1);
      loads.push(viewer.load);
      console.log(`load ${i + 1}: ${Math.round(viewer.load.appMainThreadMs)} ms main thread, rendered at ${Math.round(viewer.load.renderedMs)} ms`);
    }
    const v = viewer!;
    const hash = await styleHash(v.page);

    const scenarios: Record<string, (i: number) => [string, string]> = {
      "text on viewed page": (i) => [
        `Update("${ids.text}", {text: "Edited ${i}"})`,
        `document.querySelector('[data-id="${ids.text}"]')?.textContent === "Edited ${i}"`,
      ],
      "new class on viewed page": (i) => [
        `Update("${ids.frame}", {class: "block w-[${1777 + i}px]"})`,
        `document.querySelector('[data-id="${ids.frame}"]')?.getBoundingClientRect().width > 0 && getComputedStyle(document.querySelector('[data-id="${ids.frame}"]')).width === "${1777 + i}px"`,
      ],
      "text on another page": (i) => [`Update("${ids.other}", {text: "Other ${i}"})`, `true`],
      "component used on viewed page": (i) => [
        `Update("card-title", {text: "Component ${i}"})`,
        `[...document.querySelectorAll('[data-ref="card"]')].some((el) => el.textContent.includes("Component ${i}"))`,
      ],
    };
    const edits: Record<string, Record<string, number>> = {};
    for (const [name, make] of Object.entries(scenarios)) {
      const runs = [];
      for (let i = 0; i < EDITS; i++) runs.push(await (i === 0 ? profiled(v, name, () => edit(server, v, ...make(i))) : edit(server, v, ...make(i))));
      edits[name] = summarize(runs);
      console.log(`${name}: ${edits[name].mainThreadMs} ms main thread, ${edits[name].serverMs} ms server, ${edits[name].wsKB} KB`);
    }

    const result = { label: LABEL, nodes, mainNodes, styleHash: hash, load: summarize(loads), edits };
    console.log(JSON.stringify(result, null, 2));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  } finally {
    await browser?.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
